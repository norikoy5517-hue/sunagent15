/**
 * Resilience Module - Timeout, Retry, and Circuit Breaker Integration
 *
 * Provides fault-tolerant execution for internal MCP calls
 */

import {
  CircuitBreakerConfig,
  DEFAULT_CIRCUIT_CONFIG,
  isCallAllowed,
  recordSuccess,
  recordFailure,
} from './circuit-breaker';
import { recordEvent, startTimer } from '../observability';

/**
 * Timeout configuration
 */
export interface TimeoutConfig {
  spawnMs: number;
  toolCallMs: number;
}

/**
 * Retry configuration
 */
export interface RetryConfig {
  maxAttempts: number;
  backoffMs: number;
  jitter: boolean;
}

/**
 * Full resilience configuration
 */
export interface ResilienceConfig {
  timeout: TimeoutConfig;
  retry: RetryConfig;
  circuit: CircuitBreakerConfig;
}

export const DEFAULT_RESILIENCE_CONFIG: ResilienceConfig = {
  timeout: {
    spawnMs: 5000,
    toolCallMs: 15000,
  },
  retry: {
    maxAttempts: 5,
    backoffMs: 500,
    jitter: true,
  },
  circuit: DEFAULT_CIRCUIT_CONFIG,
};

/**
 * エラークラス分類 — リトライ戦略を決定する
 * - transient:   ネットワーク/タイムアウト → 指数バックオフでリトライ
 * - rate_limit:  429 → 長めのバックオフ後にリトライ
 * - logic_error: 意味的失敗 (400/422) → 別プロンプト戦略でリトライ
 * - fatal:       権限/認証 (401/403) → リトライしない
 */
export type ErrorClass = 'transient' | 'rate_limit' | 'logic_error' | 'fatal';

export function classifyError(error: Error): ErrorClass {
  const msg = error.message.toLowerCase();

  // Fatal: 認証・権限エラー
  if (msg.includes('401') || msg.includes('403') ||
      msg.includes('unauthorized') || msg.includes('forbidden')) {
    return 'fatal';
  }

  // Rate limit: 429
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
    return 'rate_limit';
  }

  // Logic error: 400/422 — 意味的に不正なリクエスト
  if (msg.includes('400') || msg.includes('422') ||
      msg.includes('bad request') || msg.includes('unprocessable')) {
    return 'logic_error';
  }

  // それ以外は transient (ネットワーク/タイムアウト)
  return 'transient';
}

/**
 * エラークラス別のバックオフ係数
 */
const ERROR_CLASS_BACKOFF_MULTIPLIER: Record<ErrorClass, number> = {
  transient:   1.0,
  rate_limit:  4.0,  // レートリミットは長めに待つ
  logic_error: 2.0,
  fatal:       0,    // リトライしない
};

/**
 * Error class for resilience failures
 */
export class ResilienceError extends Error {
  constructor(
    message: string,
    public readonly type: 'timeout' | 'circuit_open' | 'max_retries' | 'execution',
    public readonly mcpName: string,
    public readonly attempts: number = 0,
    public readonly errorClass: ErrorClass = 'transient'
  ) {
    super(message);
    this.name = 'ResilienceError';
  }
}

/**
 * Calculate delay with optional jitter
 */
function calculateDelay(baseMs: number, attempt: number, jitter: boolean): number {
  // Exponential backoff
  const delay = baseMs * Math.pow(2, attempt);

  if (jitter) {
    // Add random jitter (0-50% of delay)
    return delay + Math.random() * delay * 0.5;
  }

  return delay;
}

/**
 * Execute a function with timeout.
 * The timer is cleared as soon as fn settles so it does not linger for the
 * full timeout (which kept processes alive and piled up timers per call).
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label: string = 'operation'
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute a function with retry logic (エラー分類対応版)
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
  mcpName: string
): Promise<T> {
  let lastError: Error | undefined;
  let lastErrorClass: ErrorClass = 'transient';

  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      lastErrorClass = classifyError(lastError);

      // fatal エラーは即座に諦める
      if (lastErrorClass === 'fatal') {
        throw new ResilienceError(
          `Fatal error (no retry): ${lastError.message}`,
          'execution',
          mcpName,
          attempt + 1,
          'fatal'
        );
      }

      if (attempt < config.maxAttempts - 1) {
        const multiplier = ERROR_CLASS_BACKOFF_MULTIPLIER[lastErrorClass];
        const baseDelay = calculateDelay(config.backoffMs * multiplier, attempt, config.jitter);
        await new Promise((resolve) => setTimeout(resolve, baseDelay));

        recordEvent('internal_mcp_tool_call', mcpName, 'ok', {
          metadata: { retry: true, attempt: attempt + 1, errorClass: lastErrorClass },
        });
      }
    }
  }

  throw new ResilienceError(
    `Max retries (${config.maxAttempts}) exceeded: ${lastError?.message}`,
    'max_retries',
    mcpName,
    config.maxAttempts,
    lastErrorClass
  );
}

/**
 * Execute an internal MCP call with full resilience (timeout, retry, circuit breaker)
 */
export async function executeWithResilience<T>(
  mcpName: string,
  runId: string,
  fn: () => Promise<T>,
  config: ResilienceConfig = DEFAULT_RESILIENCE_CONFIG
): Promise<T> {
  const endTimer = startTimer('internal_mcp_tool_call', runId, { mcpName });

  // Check circuit breaker first
  if (!isCallAllowed(mcpName, config.circuit)) {
    endTimer('fail', { errorType: 'circuit_open' });
    throw new ResilienceError(
      `Circuit breaker is open for ${mcpName}`,
      'circuit_open',
      mcpName
    );
  }

  try {
    // Execute with timeout and retry
    const result = await withRetry(
      () => withTimeout(fn, config.timeout.toolCallMs, `${mcpName} call`),
      config.retry,
      mcpName
    );

    // Record success
    recordSuccess(mcpName, config.circuit);
    endTimer('ok');

    return result;
  } catch (error) {
    // Record failure
    recordFailure(mcpName, config.circuit);

    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorType = error instanceof ResilienceError ? error.type : 'execution';

    endTimer('fail', { errorType, errorMessage });

    if (error instanceof ResilienceError) {
      throw error;
    }

    throw new ResilienceError(errorMessage, errorType, mcpName);
  }
}

/**
 * Get resilience config for a specific MCP (can be overridden in internal-mcps.json)
 */
export function getResilienceConfig(
  mcpConfig: { resilience?: Partial<ResilienceConfig> } | undefined
): ResilienceConfig {
  if (!mcpConfig?.resilience) {
    return DEFAULT_RESILIENCE_CONFIG;
  }

  return {
    timeout: {
      ...DEFAULT_RESILIENCE_CONFIG.timeout,
      ...mcpConfig.resilience.timeout,
    },
    retry: {
      ...DEFAULT_RESILIENCE_CONFIG.retry,
      ...mcpConfig.resilience.retry,
    },
    circuit: {
      ...DEFAULT_RESILIENCE_CONFIG.circuit,
      ...mcpConfig.resilience.circuit,
    },
  };
}
