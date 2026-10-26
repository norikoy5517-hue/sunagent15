/**
 * Reflexion — Phase 6: Multi-Round Self-Correction
 *
 * 複数ラウンドの出力を受け取り、スコア推移を分析して収束を判定。
 * 各ラウンドで verification-layer + CoVe を適用し、
 * 最良ラウンドを選択して返す。
 *
 * フロー:
 *   Round 1 output → verify → failed → correction prompt
 *   Round 2 output → verify → improved? → continue or stop
 *   ...
 *   → ReflexionResult (bestRound, convergence, history)
 *
 * 参考: Shinn et al. NeurIPS 2025 (プログラミングタスク成功率32%向上)
 */

import { validateOutput, ValidationResult } from './output-validator';
import { runCoVe, CoVeResult } from './cove';
import { recordEvent } from '../observability';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface RoundRecord {
  round: number;
  output: string;
  validation: ValidationResult;
  cove: CoVeResult;
  /** 総合スコア 0.0(worst)–1.0(best) */
  compositeScore: number;
  /** このラウンドの改善量 (前ラウンドとの差分, 初回は0) */
  improvement: number;
  correctionPrompt?: string;
}

export interface ReflexionResult {
  /** 収束して合格 = true */
  converged: boolean;
  /** 選択された最良ラウンドのインデックス (0-based) */
  bestRoundIndex: number;
  bestRound: RoundRecord;
  rounds: RoundRecord[];
  /** 収束しなかった場合の継続用修正プロンプト */
  nextCorrectionPrompt?: string;
  totalRounds: number;
}

export interface ReflexionOptions {
  /** 最大ラウンド数 (デフォルト: 3) */
  maxRounds?: number;
  /** 合格と判定する最小スコア 0.0–1.0 (デフォルト: 0.7) */
  convergenceThreshold?: number;
  /** スコア改善が見込めないと判定する最小改善量 (デフォルト: 0.05) */
  minImprovement?: number;
  /** 不確実性スコア閾値 (verifyThreshold に渡す) */
  retryThreshold?: number;
  contextId?: string;
}

// ──────────────────────────────────────────────
// Scoring
// ──────────────────────────────────────────────

/**
 * 複合スコアを計算する (高いほど良い)
 *
 * = (1 - uncertaintyScore) * 0.5
 * + (1 - contradictionRate) * 0.3
 * + consistencyBonus * 0.2
 */
function computeCompositeScore(
  validation: ValidationResult,
  cove: CoVeResult
): number {
  const uncertaintyPenalty = validation.uncertaintyScore;
  const contradictionPenalty = cove.contradictionRate;
  const consistencyBonus = validation.consistencyViolations.length === 0 ? 1.0 : 0.5;

  return (
    (1 - uncertaintyPenalty) * 0.5 +
    (1 - contradictionPenalty) * 0.3 +
    consistencyBonus * 0.2
  );
}

// ──────────────────────────────────────────────
// Correction Prompt
// ──────────────────────────────────────────────

// BUG-004修正: maxRounds を追加して「X / Y 回目」を正しく表示
function buildReflexionPrompt(record: RoundRecord, maxRounds = 3): string {
  const lines: string[] = [
    `## ラウンド ${record.round} のフィードバック`,
    `スコア: ${(record.compositeScore * 100).toFixed(0)}% (目標: 70%以上)`,
    '',
  ];

  if (record.validation.severity !== 'pass') {
    lines.push('### 不確実な表現の問題:');
    record.validation.uncertaintyFlags.forEach(f =>
      lines.push(`- "${f.phrase}" (${f.severity})`)
    );
    lines.push('');
  }

  if (record.validation.consistencyViolations.length > 0) {
    lines.push('### 一貫性の問題:');
    record.validation.consistencyViolations.forEach(v =>
      lines.push(`- ${v.claim} ↔ ${v.contradiction}`)
    );
    lines.push('');
  }

  if (record.cove.contradictions.length > 0) {
    lines.push('### Chain-of-Verification で検出された矛盾:');
    record.cove.contradictions.forEach(c =>
      lines.push(`- ${c.question}`)
    );
    lines.push('');
  }

  lines.push(
    '上記の問題点をすべて修正して、より正確・一貫した回答を生成してください。',
    `（ラウンド ${record.round + 1} / ${maxRounds} 回目の修正）`
  );

  return lines.join('\n');
}

// ──────────────────────────────────────────────
// Main API — stateless (バッチ分析)
// ──────────────────────────────────────────────

/**
 * 複数ラウンドの出力を一括分析してReflexion結果を返す。
 *
 * @param outputs  各ラウンドの出力テキスト (古い順)
 * @param options  Reflexion オプション
 */
export function analyzeReflexionRounds(
  outputs: string[],
  options: ReflexionOptions = {}
): ReflexionResult {
  const {
    maxRounds = 3,
    convergenceThreshold = 0.7,
    minImprovement = 0.05,
    retryThreshold = 0.3,
    contextId = 'reflexion',
  } = options;

  if (outputs.length === 0) {
    throw new Error('outputs must contain at least one round');
  }

  const rounds: RoundRecord[] = [];
  let prevScore = 0;

  for (let i = 0; i < Math.min(outputs.length, maxRounds); i++) {
    const output = outputs[i];

    const validation = validateOutput(output, {
      retryThreshold,
      previousOutputs: outputs.slice(0, i),
    });

    const cove = runCoVe(output, { maxQuestions: 5, contextId });

    const compositeScore = computeCompositeScore(validation, cove);
    const improvement = i === 0 ? 0 : compositeScore - prevScore;

    const record: RoundRecord = {
      round: i + 1,
      output,
      validation,
      cove,
      compositeScore,
      improvement,
    };

    // 修正プロンプト (未収束の場合)
    if (compositeScore < convergenceThreshold) {
      record.correctionPrompt = buildReflexionPrompt(record, maxRounds);
    }

    rounds.push(record);
    prevScore = compositeScore;

    // 早期終了: スコアが目標を達成
    if (compositeScore >= convergenceThreshold) break;

    // 早期終了: 改善が止まった (2ラウンド以上の場合)
    if (i >= 2 && improvement < minImprovement) break;
  }

  // 最良ラウンドを選択
  const bestRoundIndex = rounds.reduce(
    (bestIdx, r, idx) =>
      r.compositeScore > rounds[bestIdx].compositeScore ? idx : bestIdx,
    0
  );
  const bestRound = rounds[bestRoundIndex];
  const converged = bestRound.compositeScore >= convergenceThreshold;

  recordEvent('memory_search', contextId, converged ? 'ok' : 'fail', {
    metadata: {
      totalRounds: rounds.length,
      finalScore: bestRound.compositeScore,
      converged,
    },
  });

  return {
    converged,
    bestRoundIndex,
    bestRound,
    rounds,
    nextCorrectionPrompt: converged ? undefined : buildReflexionPrompt(bestRound, maxRounds),
    totalRounds: rounds.length,
  };
}

// ──────────────────────────────────────────────
// Incremental API — 1ラウンドずつ送信
// ──────────────────────────────────────────────

/** インクリメンタル用の軽量版: 1出力を評価して続行すべきか返す */
export function evaluateRound(
  output: string,
  roundNumber: number,
  previousOutputs: string[] = [],
  options: ReflexionOptions = {}
): {
  record: RoundRecord;
  shouldContinue: boolean;
  reason: string;
} {
  const {
    convergenceThreshold = 0.7,
    maxRounds = 3,
    retryThreshold = 0.3,
    contextId = 'reflexion',
  } = options;

  const validation = validateOutput(output, {
    retryThreshold,
    previousOutputs,
  });
  const cove = runCoVe(output, { maxQuestions: 5, contextId });
  const compositeScore = computeCompositeScore(validation, cove);
  const prevScore = previousOutputs.length > 0
    ? computeCompositeScore(
        validateOutput(previousOutputs[previousOutputs.length - 1], { retryThreshold }),
        runCoVe(previousOutputs[previousOutputs.length - 1], { contextId })
      )
    : 0;

  const record: RoundRecord = {
    round: roundNumber,
    output,
    validation,
    cove,
    compositeScore,
    improvement: roundNumber === 1 ? 0 : compositeScore - prevScore,
  };

  if (compositeScore < convergenceThreshold) {
    record.correctionPrompt = buildReflexionPrompt(record, maxRounds);
  }

  const converged = compositeScore >= convergenceThreshold;
  const maxReached = roundNumber >= maxRounds;

  let shouldContinue = false;
  let reason: string;

  if (converged) {
    reason = `✅ 収束 (スコア: ${(compositeScore * 100).toFixed(0)}% ≥ ${(convergenceThreshold * 100).toFixed(0)}%)`;
  } else if (maxReached) {
    reason = `⛔ 最大ラウンド数に到達 (${maxRounds})。最良の出力を使用してください。`;
  } else {
    shouldContinue = true;
    reason = `🔄 継続 (スコア: ${(compositeScore * 100).toFixed(0)}%, 改善: ${record.improvement >= 0 ? '+' : ''}${(record.improvement * 100).toFixed(0)}%)`;
  }

  return { record, shouldContinue, reason };
}
