/**
 * Performance Service for TAISUN v2
 *
 * Core service for performance optimization, caching, model selection, and metrics.
 */

import * as fs from 'fs';
import * as yaml from 'yaml';
import {
  CacheEntry,
  CacheConfig,
  ModelType,
  TaskComplexity,
  ModelSelectionCriteria,
  ModelRecommendation,
  PerformanceMetrics,
  RateLimitStatus,
  PerformanceConfig,
  OptimizationRecommendation,
} from './types';

/**
 * Default performance configuration
 */
const DEFAULT_CONFIG: PerformanceConfig = {
  cache: {
    maxSize: 1000,
    defaultTTLMs: 300000, // 5 minutes
    cleanupIntervalMs: 60000, // 1 minute
    enabled: true,
  },
  rateLimit: {
    requestsPerMinute: 60,
    tokensPerMinute: 100000,
    concurrentRequests: 5,
    burstAllowance: 10,
  },
  parallelExecution: {
    maxParallelAgents: 5,
    maxParallelTasks: 10,
    queueTimeout: 300000, // 5 minutes
  },
  modelSelection: {
    defaultModel: 'sonnet',
    preferHaikuFor: [
      'simple-query',
      'list-files',
      'format-code',
      'generate-comment',
      'simple-refactor',
      'documentation-lookup',
      'syntax-check',
    ],
    preferOpusFor: [
      'architecture-design',
      'complex-analysis',
      'security-audit',
      'multi-step-reasoning',
      'novel-algorithm',
    ],
    complexityThresholds: {
      trivial: 100,
      simple: 500,
      moderate: 2000,
      complex: 5000,
    },
  },
  monitoring: {
    enabled: true,
    sampleRatePercent: 100,
    metricsRetentionDays: 30,
  },
};

/**
 * LRU Cache implementation with TTL
 */
class LRUCache<T> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private config: CacheConfig;
  private stats = { hits: 0, misses: 0, evictions: 0 };

  constructor(config: CacheConfig) {
    this.config = config;

    // Start cleanup interval (unref: background housekeeping must not keep the process alive)
    if (config.enabled && config.cleanupIntervalMs > 0) {
      setInterval(() => this.cleanup(), config.cleanupIntervalMs).unref();
    }
  }

  get(key: string): T | undefined {
    if (!this.config.enabled) {
      this.stats.misses++;
      return undefined;
    }

    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.misses++;
      return undefined;
    }

    // Update access stats
    entry.hitCount++;
    entry.lastAccessed = Date.now();

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);

    this.stats.hits++;
    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    if (!this.config.enabled) return;

    // Evict if at capacity
    if (this.cache.size >= this.config.maxSize) {
      this.evictOldest();
    }

    const now = Date.now();
    const entry: CacheEntry<T> = {
      value,
      createdAt: now,
      expiresAt: now + (ttlMs || this.config.defaultTTLMs),
      hitCount: 0,
      lastAccessed: now,
    };

    this.cache.set(key, entry);
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  private evictOldest(): void {
    const oldestKey = this.cache.keys().next().value;
    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.stats.evictions++;
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  getStats() {
    return {
      ...this.stats,
      size: this.cache.size,
      hitRate: this.stats.hits + this.stats.misses > 0
        ? this.stats.hits / (this.stats.hits + this.stats.misses)
        : 0,
    };
  }
}

/**
 * Performance Service class
 */
export class PerformanceService {
  private config: PerformanceConfig;
  private agentSelectionCache: LRUCache<string[]>;
  private resultCache: LRUCache<unknown>;
  private metricsHistory: PerformanceMetrics[] = [];
  private requestTimestamps: number[] = [];
  private tokenCounts: number[] = [];
  private latencies: number[] = [];
  private currentConcurrent = 0;

  constructor(configPath?: string) {
    this.config = this.loadConfig(configPath);
    this.agentSelectionCache = new LRUCache<string[]>(this.config.cache);
    this.resultCache = new LRUCache<unknown>(this.config.cache);
  }

  /**
   * Load performance configuration
   */
  private loadConfig(configPath?: string): PerformanceConfig {
    const defaultPath = '.claude/performance.yaml';
    const filePath = configPath || defaultPath;

    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const rawConfig = yaml.parse(content);
        return this.mergeConfig(rawConfig);
      } catch {
        return DEFAULT_CONFIG;
      }
    }

    return DEFAULT_CONFIG;
  }

  /**
   * Merge user config with defaults
   */
  private mergeConfig(rawConfig: Partial<PerformanceConfig>): PerformanceConfig {
    return {
      cache: { ...DEFAULT_CONFIG.cache, ...rawConfig.cache },
      rateLimit: { ...DEFAULT_CONFIG.rateLimit, ...rawConfig.rateLimit },
      parallelExecution: { ...DEFAULT_CONFIG.parallelExecution, ...rawConfig.parallelExecution },
      modelSelection: { ...DEFAULT_CONFIG.modelSelection, ...rawConfig.modelSelection },
      monitoring: { ...DEFAULT_CONFIG.monitoring, ...rawConfig.monitoring },
    };
  }

  /**
   * Get cached agent selection
   */
  getCachedAgentSelection(keywords: string[]): string[] | undefined {
    const cacheKey = this.generateCacheKey('agent-selection', keywords);
    return this.agentSelectionCache.get(cacheKey);
  }

  /**
   * Cache agent selection result
   */
  cacheAgentSelection(keywords: string[], agents: string[]): void {
    const cacheKey = this.generateCacheKey('agent-selection', keywords);
    this.agentSelectionCache.set(cacheKey, agents);
  }

  /**
   * Get cached result
   */
  getCachedResult<T>(key: string): T | undefined {
    return this.resultCache.get(key) as T | undefined;
  }

  /**
   * Cache result
   */
  cacheResult<T>(key: string, value: T, ttlMs?: number): void {
    this.resultCache.set(key, value, ttlMs);
  }

  /**
   * Generate cache key
   */
  private generateCacheKey(prefix: string, parts: string[]): string {
    return `${prefix}:${parts.sort().join(':')}`;
  }

  /**
   * Recommend optimal model for task
   */
  recommendModel(criteria: ModelSelectionCriteria): ModelRecommendation {
    const { taskComplexity, estimatedTokens, requiresReasoning, isCodeGeneration, timeConstraint } = criteria;

    // Check for haiku-preferred tasks
    const taskType = this.inferTaskType(criteria);
    if (this.config.modelSelection.preferHaikuFor.includes(taskType)) {
      return {
        model: 'haiku',
        confidence: 0.9,
        rationale: `Task type '${taskType}' is optimized for haiku model`,
        estimatedCost: this.estimateCost('haiku', estimatedTokens),
        estimatedLatencyMs: this.estimateLatency('haiku', estimatedTokens),
      };
    }

    // Check for opus-preferred tasks (but respect time constraints)
    if (this.config.modelSelection.preferOpusFor.includes(taskType)) {
      // Downgrade to sonnet if urgent
      if (timeConstraint === 'urgent') {
        return {
          model: 'sonnet',
          confidence: 0.75,
          rationale: 'Downgraded from opus due to time constraint',
          estimatedCost: this.estimateCost('sonnet', estimatedTokens),
          estimatedLatencyMs: this.estimateLatency('sonnet', estimatedTokens),
        };
      }
      return {
        model: 'opus',
        confidence: 0.85,
        rationale: `Task type '${taskType}' requires opus model capabilities`,
        estimatedCost: this.estimateCost('opus', estimatedTokens),
        estimatedLatencyMs: this.estimateLatency('opus', estimatedTokens),
      };
    }

    // Determine by complexity
    let model: ModelType = 'sonnet';
    let rationale = 'Default model for balanced performance';

    if (taskComplexity === 'trivial' || taskComplexity === 'simple') {
      if (!requiresReasoning && !isCodeGeneration) {
        model = 'haiku';
        rationale = 'Simple task with low complexity';
      }
    } else if (taskComplexity === 'expert' || (taskComplexity === 'complex' && requiresReasoning)) {
      model = 'opus';
      rationale = 'Complex task requiring advanced reasoning';
    }

    // Adjust for time constraints (apply after all other logic)
    if (timeConstraint === 'urgent' && model === 'opus') {
      return {
        model: 'sonnet',
        confidence: 0.75,
        rationale: 'Downgraded from opus due to time constraint',
        estimatedCost: this.estimateCost('sonnet', estimatedTokens),
        estimatedLatencyMs: this.estimateLatency('sonnet', estimatedTokens),
      };
    }

    return {
      model,
      confidence: 0.8,
      rationale,
      estimatedCost: this.estimateCost(model, estimatedTokens),
      estimatedLatencyMs: this.estimateLatency(model, estimatedTokens),
    };
  }

  /**
   * Infer task type from criteria
   */
  private inferTaskType(criteria: ModelSelectionCriteria): string {
    if (criteria.taskComplexity === 'trivial') {
      return 'simple-query';
    }
    if (criteria.isCodeGeneration && criteria.taskComplexity === 'simple') {
      return 'format-code';
    }
    if (criteria.requiresReasoning && criteria.taskComplexity === 'expert') {
      return 'complex-analysis';
    }
    return 'general';
  }

  /**
   * Estimate cost for model and tokens
   */
  private estimateCost(model: ModelType, tokens: number): number {
    // Cost per 1M tokens (rough estimates)
    const costs: Partial<Record<ModelType, { input: number; output: number }>> = {
      opus: { input: 15, output: 75 },
      'claude-opus': { input: 5, output: 25 },
      sonnet: { input: 3, output: 15 },
      'claude-sonnet': { input: 3, output: 15 },
      haiku: { input: 0.25, output: 1.25 },
      'claude-haiku': { input: 1, output: 5 },
      'ollama-qwen3-coder': { input: 0, output: 0 },
      'ollama-glm4': { input: 0, output: 0 },
      'openrouter-free': { input: 0, output: 0 },
      'gpt53-codex': { input: 1.25, output: 10 },
    };

    const { input, output } = costs[model] ?? { input: 0, output: 0 };
    const avgOutputRatio = 0.3; // Assume output is 30% of input
    const inputTokens = tokens;
    const outputTokens = tokens * avgOutputRatio;

    return (inputTokens * input + outputTokens * output) / 1000000;
  }

  /**
   * Estimate latency for model and tokens
   */
  private estimateLatency(model: ModelType, tokens: number): number {
    // Base latency + tokens/s (rough estimates)
    const specs: Partial<Record<ModelType, { baseMs: number; tokensPerSecond: number }>> = {
      opus: { baseMs: 2000, tokensPerSecond: 50 },
      'claude-opus': { baseMs: 2000, tokensPerSecond: 50 },
      sonnet: { baseMs: 500, tokensPerSecond: 100 },
      'claude-sonnet': { baseMs: 500, tokensPerSecond: 100 },
      haiku: { baseMs: 200, tokensPerSecond: 200 },
      'claude-haiku': { baseMs: 200, tokensPerSecond: 200 },
      'ollama-qwen3-coder': { baseMs: 1000, tokensPerSecond: 30 },
      'ollama-glm4': { baseMs: 1000, tokensPerSecond: 30 },
      'openrouter-free': { baseMs: 1500, tokensPerSecond: 80 },
      'gpt53-codex': { baseMs: 800, tokensPerSecond: 120 },
    };

    const { baseMs, tokensPerSecond } = specs[model] ?? { baseMs: 1000, tokensPerSecond: 50 };
    return baseMs + (tokens / tokensPerSecond) * 1000;
  }

  /**
   * Check rate limit status
   */
  checkRateLimit(): RateLimitStatus {
    const now = Date.now();
    const windowMs = 60000; // 1 minute window

    // Clean old timestamps
    this.requestTimestamps = this.requestTimestamps.filter((ts) => now - ts < windowMs);
    this.tokenCounts = this.tokenCounts.slice(-100); // Keep last 100 for averaging

    const requestsInWindow = this.requestTimestamps.length;
    const tokensInWindow = this.tokenCounts.reduce((a, b) => a + b, 0);

    const requestsRemaining = Math.max(0, this.config.rateLimit.requestsPerMinute - requestsInWindow);
    const tokensRemaining = Math.max(0, this.config.rateLimit.tokensPerMinute - tokensInWindow);

    const isLimited =
      requestsRemaining === 0 ||
      tokensRemaining === 0 ||
      this.currentConcurrent >= this.config.rateLimit.concurrentRequests;

    let waitTimeMs = 0;
    if (isLimited && this.requestTimestamps.length > 0) {
      const oldestTimestamp = Math.min(...this.requestTimestamps);
      waitTimeMs = Math.max(0, windowMs - (now - oldestTimestamp));
    }

    return {
      requestsRemaining,
      tokensRemaining,
      resetAtMs: now + windowMs,
      isLimited,
      waitTimeMs,
    };
  }

  /**
   * Record API request
   */
  recordRequest(tokens: number, latencyMs: number): void {
    this.requestTimestamps.push(Date.now());
    this.tokenCounts.push(tokens);
    this.latencies.push(latencyMs);

    // Keep only recent data
    if (this.latencies.length > 1000) {
      this.latencies = this.latencies.slice(-1000);
    }
  }

  /**
   * Acquire concurrent slot
   */
  acquireConcurrentSlot(): boolean {
    if (this.currentConcurrent >= this.config.rateLimit.concurrentRequests) {
      return false;
    }
    this.currentConcurrent++;
    return true;
  }

  /**
   * Release concurrent slot
   */
  releaseConcurrentSlot(): void {
    this.currentConcurrent = Math.max(0, this.currentConcurrent - 1);
  }

  /**
   * Get current performance metrics
   */
  getMetrics(): PerformanceMetrics {
    const cacheStats = this.agentSelectionCache.getStats();
    const resultCacheStats = this.resultCache.getStats();

    const sortedLatencies = [...this.latencies].sort((a, b) => a - b);
    const p95Index = Math.floor(sortedLatencies.length * 0.95);
    const p99Index = Math.floor(sortedLatencies.length * 0.99);

    const memoryUsage = process.memoryUsage();

    return {
      timestamp: new Date().toISOString(),
      apiCalls: {
        total: this.requestTimestamps.length,
        successful: this.requestTimestamps.length, // Simplified
        failed: 0,
        avgLatencyMs: this.latencies.length > 0
          ? this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length
          : 0,
        p95LatencyMs: sortedLatencies[p95Index] || 0,
        p99LatencyMs: sortedLatencies[p99Index] || 0,
      },
      tokens: {
        inputTotal: this.tokenCounts.reduce((a, b) => a + b, 0),
        outputTotal: 0, // Would need separate tracking
        avgPerRequest: this.tokenCounts.length > 0
          ? this.tokenCounts.reduce((a, b) => a + b, 0) / this.tokenCounts.length
          : 0,
      },
      cache: {
        hits: cacheStats.hits + resultCacheStats.hits,
        misses: cacheStats.misses + resultCacheStats.misses,
        hitRate: (cacheStats.hitRate + resultCacheStats.hitRate) / 2,
        size: cacheStats.size + resultCacheStats.size,
        evictions: cacheStats.evictions + resultCacheStats.evictions,
      },
      agents: {
        totalExecutions: 0, // Would integrate with MemoryService
        parallelExecutions: 0,
        avgExecutionTimeMs: 0,
        queueDepth: this.currentConcurrent,
      },
      memory: {
        heapUsedMB: memoryUsage.heapUsed / 1024 / 1024,
        heapTotalMB: memoryUsage.heapTotal / 1024 / 1024,
        externalMB: memoryUsage.external / 1024 / 1024,
        rssMemoryMB: memoryUsage.rss / 1024 / 1024,
      },
    };
  }

  /**
   * Determine task complexity
   */
  classifyComplexity(
    description: string,
    estimatedTokens: number
  ): TaskComplexity {
    const thresholds = this.config.modelSelection.complexityThresholds;

    // Keyword-based complexity indicators
    const complexKeywords = ['architecture', 'design', 'security', 'audit', 'migrate', 'refactor'];

    const descLower = description.toLowerCase();
    const hasComplexKeywords = complexKeywords.some((k) => descLower.includes(k));

    // Token-based classification with keyword adjustment
    // Very high tokens = expert
    if (estimatedTokens >= thresholds.complex) {
      return 'expert';
    }

    // High tokens = complex, or expert if has complex keywords
    if (estimatedTokens >= thresholds.moderate) {
      return hasComplexKeywords ? 'expert' : 'complex';
    }

    // Medium tokens = moderate
    if (estimatedTokens >= thresholds.simple) {
      return 'moderate';
    }

    // Low tokens = simple
    if (estimatedTokens >= thresholds.trivial) {
      return 'simple';
    }

    // Very low tokens = trivial
    return 'trivial';
  }

  /**
   * Generate optimization recommendations
   */
  getRecommendations(): OptimizationRecommendation[] {
    const metrics = this.getMetrics();
    const recommendations: OptimizationRecommendation[] = [];

    // Cache optimization
    if (metrics.cache.hitRate < 0.5) {
      recommendations.push({
        id: 'cache-001',
        priority: 'high',
        category: 'cache',
        title: 'Low cache hit rate',
        description: `Cache hit rate is ${(metrics.cache.hitRate * 100).toFixed(1)}%, below optimal 70%`,
        estimatedImpact: '20-30% reduction in API calls',
        implementation: 'Increase cache TTL or review cache key generation',
        effort: 'low',
      });
    }

    // Memory optimization
    if (metrics.memory.heapUsedMB > 500) {
      recommendations.push({
        id: 'memory-001',
        priority: 'medium',
        category: 'memory',
        title: 'High memory usage',
        description: `Heap usage is ${metrics.memory.heapUsedMB.toFixed(0)}MB`,
        estimatedImpact: 'Improved stability and reduced GC pauses',
        implementation: 'Reduce cache size or implement memory limits',
        effort: 'medium',
      });
    }

    // Latency optimization
    if (metrics.apiCalls.avgLatencyMs > 5000) {
      recommendations.push({
        id: 'latency-001',
        priority: 'high',
        category: 'api',
        title: 'High average latency',
        description: `Average latency is ${metrics.apiCalls.avgLatencyMs.toFixed(0)}ms`,
        estimatedImpact: '30-50% faster response times',
        implementation: 'Consider using haiku for simple tasks',
        effort: 'low',
      });
    }

    // Model optimization
    if (metrics.tokens.avgPerRequest > 3000) {
      recommendations.push({
        id: 'model-001',
        priority: 'medium',
        category: 'model',
        title: 'High token usage per request',
        description: `Average ${metrics.tokens.avgPerRequest.toFixed(0)} tokens per request`,
        estimatedImpact: '20-40% cost reduction',
        implementation: 'Use context compression and prompt optimization',
        effort: 'medium',
      });
    }

    return recommendations.sort((a, b) => {
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  /**
   * Generate performance report
   */
  generateReport(): string {
    const metrics = this.getMetrics();
    const recommendations = this.getRecommendations();

    const lines: string[] = [];

    lines.push('═══════════════════════════════════════════════════════════════');
    lines.push('              TAISUN v2 Performance Report                      ');
    lines.push('═══════════════════════════════════════════════════════════════');
    lines.push('');

    // API Metrics
    lines.push('┌─────────────────────────────────────────────────────────────┐');
    lines.push('│  API Performance                                            │');
    lines.push('├─────────────────────────────────────────────────────────────┤');
    lines.push(`│  Total Requests:     ${String(metrics.apiCalls.total).padStart(8)}                          │`);
    lines.push(`│  Avg Latency:        ${metrics.apiCalls.avgLatencyMs.toFixed(0).padStart(8)}ms                        │`);
    lines.push(`│  P95 Latency:        ${metrics.apiCalls.p95LatencyMs.toFixed(0).padStart(8)}ms                        │`);
    lines.push(`│  P99 Latency:        ${metrics.apiCalls.p99LatencyMs.toFixed(0).padStart(8)}ms                        │`);
    lines.push('└─────────────────────────────────────────────────────────────┘');
    lines.push('');

    // Cache Metrics
    lines.push('┌─────────────────────────────────────────────────────────────┐');
    lines.push('│  Cache Performance                                          │');
    lines.push('├─────────────────────────────────────────────────────────────┤');
    lines.push(`│  Hit Rate:           ${(metrics.cache.hitRate * 100).toFixed(1).padStart(8)}%                        │`);
    lines.push(`│  Hits:               ${String(metrics.cache.hits).padStart(8)}                          │`);
    lines.push(`│  Misses:             ${String(metrics.cache.misses).padStart(8)}                          │`);
    lines.push(`│  Size:               ${String(metrics.cache.size).padStart(8)}                          │`);
    lines.push('└─────────────────────────────────────────────────────────────┘');
    lines.push('');

    // Memory Metrics
    lines.push('┌─────────────────────────────────────────────────────────────┐');
    lines.push('│  Memory Usage                                               │');
    lines.push('├─────────────────────────────────────────────────────────────┤');
    lines.push(`│  Heap Used:          ${metrics.memory.heapUsedMB.toFixed(1).padStart(8)}MB                       │`);
    lines.push(`│  Heap Total:         ${metrics.memory.heapTotalMB.toFixed(1).padStart(8)}MB                       │`);
    lines.push(`│  RSS Memory:         ${metrics.memory.rssMemoryMB.toFixed(1).padStart(8)}MB                       │`);
    lines.push('└─────────────────────────────────────────────────────────────┘');
    lines.push('');

    // Recommendations
    if (recommendations.length > 0) {
      lines.push('┌─────────────────────────────────────────────────────────────┐');
      lines.push('│  Optimization Recommendations                               │');
      lines.push('├─────────────────────────────────────────────────────────────┤');
      for (const rec of recommendations.slice(0, 5)) {
        const priority = `[${rec.priority.toUpperCase()}]`.padEnd(10);
        lines.push(`│  ${priority} ${rec.title.substring(0, 45).padEnd(45)} │`);
      }
      lines.push('└─────────────────────────────────────────────────────────────┘');
    }

    lines.push('');
    lines.push(`Report generated: ${metrics.timestamp}`);

    return lines.join('\n');
  }

  /**
   * Clear all caches
   */
  clearCaches(): void {
    this.agentSelectionCache.clear();
    this.resultCache.clear();
  }

  /**
   * Get configuration
   */
  getConfig(): PerformanceConfig {
    return { ...this.config };
  }

  /**
   * Get max parallel agents
   */
  getMaxParallelAgents(): number {
    return this.config.parallelExecution.maxParallelAgents;
  }
}

/**
 * Export singleton instance
 */
export const performanceService = new PerformanceService();
