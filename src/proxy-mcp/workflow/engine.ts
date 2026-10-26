/**
 * Workflow Engine
 * Core state machine logic for workflow execution
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { loadState, saveState, clearState } from './store';
import { getWorkflow } from './registry';
import type {
  WorkflowState,
  WorkflowPhase,
  ValidationResult,
  CanRunSkillResult,
  PhaseTransitionResult,
  Condition,
  ParallelNext,
  ParallelExecutionState,
  RollbackHistory,
  PhaseSnapshot,
} from './types';

/**
 * Start a new workflow
 */
export function startWorkflow(
  workflowId: string,
  strict: boolean = false,
  metadata?: Record<string, unknown>
): WorkflowState {
  // Load workflow definition to validate it exists
  const workflow = getWorkflow(workflowId);

  // Clear existing state if any
  clearState();

  // Create new state
  const state: WorkflowState = {
    workflowId,
    currentPhase: workflow.phases[0].id,
    completedPhases: [],
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    strict,
    metadata: metadata || {},
  };

  saveState(state);
  return state;
}

/**
 * Get current workflow status
 */
export function getStatus(): {
  active: boolean;
  state: WorkflowState | null;
  currentPhase: WorkflowPhase | null;
  nextPhase: WorkflowPhase | null;
  progress: string;
} {
  const state = loadState();

  if (!state) {
    return {
      active: false,
      state: null,
      currentPhase: null,
      nextPhase: null,
      progress: '0/0 (No active workflow)',
    };
  }

  const workflow = getWorkflow(state.workflowId);
  const currentPhase = workflow.phases.find((p) => p.id === state.currentPhase);
  const nextPhaseId = currentPhase?.nextPhase;
  const nextPhase = nextPhaseId
    ? (workflow.phases.find((p) => p.id === nextPhaseId) ?? null)
    : null;

  const progress = `${state.completedPhases.length + 1}/${workflow.phases.length}`;

  return {
    active: true,
    state,
    currentPhase: currentPhase || null,
    nextPhase,
    progress,
  };
}

/**
 * Check if workflow is active
 */
export function hasState(): boolean {
  return loadState() !== null;
}

/**
 * Check if workflow is in strict mode (Phase 2)
 */
export function isStrictMode(): boolean {
  const state = loadState();
  return state?.strict ?? false;
}

/**
 * Check if a skill can run in the current phase
 * Phase 1 (strict=false): advisory only, warnings
 * Phase 2 (strict=true): enforcement, blocking
 */
export function canRunSkill(skillName: string): CanRunSkillResult {
  const state = loadState();

  if (!state) {
    return { ok: true };
  }

  // Try to get workflow, but handle case where workflow is not found
  // (e.g., during testing or when workflow was created in a different context)
  let workflow;
  try {
    workflow = getWorkflow(state.workflowId);
  } catch {
    // Workflow not found - allow skill execution (no restrictions to enforce)
    return { ok: true };
  }

  const currentPhase = workflow.phases.find((p) => p.id === state.currentPhase);

  if (!currentPhase) {
    return { ok: true };
  }

  // No skill restrictions defined
  if (!currentPhase.allowedSkills || currentPhase.allowedSkills.length === 0) {
    return { ok: true };
  }

  const allowed = currentPhase.allowedSkills.includes(skillName);

  if (!allowed) {
    const strict = isStrictMode();

    return {
      ok: !strict, // Phase 2 (strict): block, Phase 1: allow
      reason: strict
        ? `🔒 strict mode: スキル '${skillName}' は Phase ${currentPhase.id} (${currentPhase.name}) で許可されていません。`
        : `⚠️  推奨: スキル '${skillName}' は Phase ${currentPhase.id} では推奨されていません。`,
      suggestedNext: `許可されているスキル: ${currentPhase.allowedSkills.join(', ')}`,
    };
  }

  return { ok: true };
}

/**
 * Validate current phase completion
 */
export function validatePhase(): ValidationResult {
  const state = loadState();

  if (!state) {
    return {
      passed: false,
      errors: ['No active workflow'],
      warnings: [],
    };
  }

  const workflow = getWorkflow(state.workflowId);
  const currentPhase = workflow.phases.find((p) => p.id === state.currentPhase);

  if (!currentPhase) {
    return {
      passed: false,
      errors: [`Phase ${state.currentPhase} not found in workflow definition`],
      warnings: [],
    };
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  // Check required artifacts
  if (currentPhase.requiredArtifacts) {
    for (const artifact of currentPhase.requiredArtifacts) {
      if (!fs.existsSync(artifact)) {
        errors.push(`必須成果物が見つかりません: ${artifact}`);
      }
    }
  }

  // Run validations
  if (currentPhase.validations) {
    for (const validation of currentPhase.validations) {
      try {
        if (validation.type === 'file_exists' && validation.target) {
          if (!fs.existsSync(validation.target)) {
            errors.push(validation.errorMessage);
          }
        } else if (validation.type === 'command' && validation.command) {
          // TRUST BOUNDARY: validation.command comes from local workflow JSON files only.
          // If workflow definitions become user-uploadable, this must be sandboxed.
          try {
            const result = spawnSync('sh', ['-c', validation.command], { stdio: 'pipe', timeout: 10000 });
            if (result.status !== 0) {
              errors.push(validation.errorMessage);
            }
          } catch {
            errors.push(validation.errorMessage);
          }
        }
      } catch (error) {
        const err = error as Error;
        errors.push(`検証エラー: ${err.message}`);
      }
    }
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
  };
}

// ========================================
// Phase 3: Conditional Branching
// ========================================

/**
 * 条件を評価して結果の値を返す
 * @param condition 評価する条件
 * @returns 条件の評価結果（マッチした値、またはnull）
 */
function evaluateCondition(condition: Condition): string | null {
  try {
    switch (condition.type) {
      case 'file_content': {
        // ファイル内容で判定
        if (!fs.existsSync(condition.source)) {
          return null;
        }
        const content = fs.readFileSync(condition.source, 'utf-8').trim();

        // パターンマッチング
        if (condition.pattern) {
          const regex = new RegExp(condition.pattern);
          const match = content.match(regex);
          if (match) {
            return match[0]; // マッチした値を返す
          }
          return null;
        }

        // 期待値チェック
        if (condition.expectedValue) {
          return content === condition.expectedValue ? content : null;
        }

        // パターンも期待値もない場合は、ファイル内容をそのまま返す
        return content;
      }

      case 'file_exists': {
        // ファイル存在で判定
        return fs.existsSync(condition.source) ? 'true' : 'false';
      }

      case 'command_output': {
        // コマンド出力で判定
        // TRUST BOUNDARY: condition.source comes from local workflow JSON files only.
        try {
          const result = spawnSync('sh', ['-c', condition.source], {
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: 5000, // 5秒タイムアウト
          });
          const output = (result.stdout || '').trim();

          // パターンマッチング
          if (condition.pattern) {
            const regex = new RegExp(condition.pattern);
            const match = output.match(regex);
            if (match) {
              return match[0];
            }
            return null;
          }

          return output;
        } catch (_error) {
          // コマンドエラーはnullを返す
          return null;
        }
      }

      case 'metadata_value': {
        // メタデータの値で判定
        const state = loadState();
        if (!state?.metadata) {
          return null;
        }

        const value = state.metadata[condition.source];
        if (value === undefined || value === null) {
          return null;
        }

        const stringValue = String(value);

        // パターンマッチング
        if (condition.pattern) {
          const regex = new RegExp(condition.pattern);
          const match = stringValue.match(regex);
          if (match) {
            return match[0];
          }
          return null;
        }

        return stringValue;
      }

      default:
        return null;
    }
  } catch (error) {
    // エラー時はnullを返す（安全側に倒す）
    console.error(`条件評価エラー: ${(error as Error).message}`);
    return null;
  }
}

/**
 * 次のフェーズを決定（条件分岐対応版）
 * @param currentPhase 現在のフェーズ
 * @returns 次のフェーズID、または null（最終フェーズ）
 * @throws {Error} 条件分岐の評価に失敗した場合
 */
function determineNextPhase(currentPhase: WorkflowPhase): string | null {
  // 1. 条件分岐がある場合
  if (currentPhase.conditionalNext) {
    const condNext = currentPhase.conditionalNext;
    const value = evaluateCondition(condNext.condition);

    // 条件値に対応する分岐先を探す
    if (value && condNext.branches[value]) {
      // 分岐履歴を記録
      const state = loadState();
      if (state) {
        if (!state.branchHistory) {
          state.branchHistory = [];
        }
        state.branchHistory.push(
          `${currentPhase.id} -> ${condNext.branches[value]} (${value})`
        );
        saveState(state);
      }

      return condNext.branches[value];
    }

    // デフォルト遷移
    if (condNext.defaultNext) {
      return condNext.defaultNext;
    }

    // どの分岐にもマッチせず、デフォルトもない場合はエラー
    throw new Error(
      `条件分岐の評価に失敗しました。\n` +
        `条件値: "${value ?? '(null)'}"\n` +
        `利用可能な分岐: ${Object.keys(condNext.branches).join(', ')}\n` +
        `デフォルト遷移: ${condNext.defaultNext ?? '(なし)'}`
    );
  }

  // 2. 並列実行がある場合（Phase 3）
  if (currentPhase.parallelNext) {
    // 並列実行の開始は特別な処理が必要
    // ここでは最初の並列フェーズIDを返す（実際の並列実行はtransitionで処理）
    return currentPhase.parallelNext.phases[0] ?? null;
  }

  // 3. 通常遷移
  return currentPhase.nextPhase ?? null;
}

// ========================================
// Phase 3: Parallel Execution
// ========================================

/**
 * 並列実行を開始
 * @param parallelNext 並列実行定義
 * @returns 並列実行状態
 */
function startParallelExecution(
  parallelNext: ParallelNext
): ParallelExecutionState {
  const state = loadState();
  if (!state) {
    throw new Error('No active workflow');
  }

  const parallelState: ParallelExecutionState = {
    parallelGroupId: `parallel_${Date.now()}`,
    startedPhases: [...parallelNext.phases],
    completedPhases: [],
    waitStrategy: parallelNext.waitStrategy,
    startedAt: new Date().toISOString(),
  };

  // 状態に追加
  if (!state.parallelExecutions) {
    state.parallelExecutions = [];
  }
  state.parallelExecutions.push(parallelState);

  saveState(state);

  return parallelState;
}

/**
 * 並列フェーズの完了を記録
 * @param phaseId 完了したフェーズID
 */
function completeParallelPhase(phaseId: string): void {
  const state = loadState();
  if (!state || !state.parallelExecutions) {
    return;
  }

  // アクティブな並列実行を見つける
  const activeParallel = state.parallelExecutions.find(
    (p) => p.startedPhases.includes(phaseId) && !p.completedAt
  );

  if (!activeParallel) {
    return;
  }

  // 完了マーク
  if (!activeParallel.completedPhases.includes(phaseId)) {
    activeParallel.completedPhases.push(phaseId);
  }

  // 完了条件チェック
  const shouldComplete =
    activeParallel.waitStrategy === 'all'
      ? activeParallel.completedPhases.length ===
        activeParallel.startedPhases.length
      : activeParallel.completedPhases.length > 0;

  if (shouldComplete) {
    activeParallel.completedAt = new Date().toISOString();
  }

  saveState(state);
}

/**
 * 並列実行が完了しているか確認
 * @returns 完了している場合true
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function isParallelExecutionComplete(): boolean {
  const state = loadState();
  if (!state || !state.parallelExecutions) {
    return true; // 並列実行なし = 完了扱い
  }

  const activeParallel = state.parallelExecutions.find((p) => !p.completedAt);
  return !activeParallel;
}

/**
 * 現在のフェーズが並列実行グループの一部か確認
 * @param phaseId チェックするフェーズID
 * @returns 並列実行グループの一部の場合、そのグループ情報
 */
function getParallelExecutionForPhase(
  phaseId: string
): ParallelExecutionState | null {
  const state = loadState();
  if (!state || !state.parallelExecutions) {
    return null;
  }

  return (
    state.parallelExecutions.find(
      (p) => p.startedPhases.includes(phaseId) && !p.completedAt
    ) ?? null
  );
}

/**
 * Transition to next phase
 */
export function transitionToNextPhase(): PhaseTransitionResult {
  const state = loadState();

  if (!state) {
    return {
      success: false,
      errors: ['No active workflow'],
      message: 'ワークフローが開始されていません',
    };
  }

  const workflow = getWorkflow(state.workflowId);
  const currentPhase = workflow.phases.find((p) => p.id === state.currentPhase);

  if (!currentPhase) {
    return {
      success: false,
      errors: [`Phase ${state.currentPhase} not found`],
      message: 'フェーズが見つかりません',
    };
  }

  // Validate current phase
  const validation = validatePhase();
  if (!validation.passed) {
    return {
      success: false,
      errors: validation.errors,
      message: `Phase ${currentPhase.id} の完了条件を満たしていません`,
    };
  }

  // Phase 3: 並列実行グループの一部か確認
  const parallelGroup = getParallelExecutionForPhase(state.currentPhase);

  if (parallelGroup) {
    // 並列実行中のフェーズを完了としてマーク（内部でsaveState()を呼ぶ）
    completeParallelPhase(state.currentPhase);

    // 状態を再読み込み
    const updatedState = loadState();
    if (!updatedState) {
      return {
        success: false,
        errors: ['Failed to reload state after completing parallel phase'],
        message: '並列フェーズ完了後の状態読み込みに失敗しました',
      };
    }

    // 並列グループ全体が完了したか確認
    const updatedGroup = getParallelExecutionForPhase(updatedState.currentPhase);

    if (updatedGroup && updatedGroup.completedAt) {
      // 並列グループ完了：次の共通フェーズに遷移
      const nextPhaseId = currentPhase.nextPhase;

      if (!nextPhaseId) {
        // 次フェーズなし＝最終並列グループの完了。正常完了として扱う
        updatedState.completedPhases.push(updatedState.currentPhase);
        updatedState.lastUpdatedAt = new Date().toISOString();
        saveState(updatedState);

        return {
          success: true,
          errors: [],
          message: `✅ 並列実行完了。Phase ${currentPhase.id} は最終フェーズです。/workflow-verify で完了を確認してください。`,
        };
      }

      updatedState.completedPhases.push(updatedState.currentPhase);
      updatedState.currentPhase = nextPhaseId;
      updatedState.lastUpdatedAt = new Date().toISOString();
      saveState(updatedState);

      return {
        success: true,
        newPhase: nextPhaseId,
        errors: [],
        message: `✅ 並列実行完了。Phase ${nextPhaseId} に進みました`,
      };
    } else {
      // まだ他の並列フェーズが未完了
      // 次の未完了並列フェーズに遷移
      const nextParallelPhase = updatedGroup?.startedPhases.find(
        (phaseId) =>
          updatedGroup &&
          !updatedGroup.completedPhases.includes(phaseId) &&
          phaseId !== updatedState.currentPhase
      );

      if (nextParallelPhase && updatedGroup) {
        updatedState.completedPhases.push(updatedState.currentPhase);
        updatedState.currentPhase = nextParallelPhase;
        updatedState.lastUpdatedAt = new Date().toISOString();
        saveState(updatedState);

        return {
          success: true,
          newPhase: nextParallelPhase,
          errors: [],
          message: `✅ 次の並列フェーズ ${nextParallelPhase} に進みました（残り: ${
            updatedGroup.startedPhases.length -
            updatedGroup.completedPhases.length
          }）`,
        };
      } else {
        // 自分以外の並列フェーズが全て完了（waitStrategy='any'の場合）
        const nextPhaseId = currentPhase.nextPhase;

        if (!nextPhaseId) {
          // 次フェーズなし＝最終並列グループの完了。正常完了として扱う
          updatedState.completedPhases.push(updatedState.currentPhase);
          updatedState.lastUpdatedAt = new Date().toISOString();
          saveState(updatedState);

          return {
            success: true,
            errors: [],
            message: `✅ 並列実行完了。Phase ${currentPhase.id} は最終フェーズです。/workflow-verify で完了を確認してください。`,
          };
        }

        updatedState.completedPhases.push(updatedState.currentPhase);
        updatedState.currentPhase = nextPhaseId;
        updatedState.lastUpdatedAt = new Date().toISOString();
        saveState(updatedState);

        return {
          success: true,
          newPhase: nextPhaseId,
          errors: [],
          message: `✅ 並列実行完了。Phase ${nextPhaseId} に進みました`,
        };
      }
    }
  }

  // Phase 3: 並列実行の開始
  if (currentPhase.parallelNext) {
    // 並列実行グループを作成（内部でsaveState()を呼ぶ）
    const parallelState = startParallelExecution(currentPhase.parallelNext);

    // 最初の並列フェーズに遷移（状態を再読み込み）
    const updatedState = loadState();
    if (!updatedState) {
      return {
        success: false,
        errors: ['Failed to reload state after parallel execution start'],
        message: '並列実行開始後の状態読み込みに失敗しました',
      };
    }

    const firstParallelPhase = parallelState.startedPhases[0];

    updatedState.completedPhases.push(updatedState.currentPhase);
    updatedState.currentPhase = firstParallelPhase;
    updatedState.lastUpdatedAt = new Date().toISOString();
    saveState(updatedState);

    return {
      success: true,
      newPhase: firstParallelPhase,
      errors: [],
      message: `✅ 並列実行開始。Phase ${firstParallelPhase} に進みました（並列: ${parallelState.startedPhases.length}個）`,
    };
  }

  // 通常の遷移（Phase 1-2, Phase 3条件分岐）
  let nextPhaseId: string | null;
  try {
    nextPhaseId = determineNextPhase(currentPhase);
  } catch (error) {
    return {
      success: false,
      errors: [(error as Error).message],
      message: `次のフェーズの決定に失敗しました`,
    };
  }

  // Check if this is the final phase
  if (!nextPhaseId) {
    return {
      success: false,
      errors: [],
      message: `Phase ${currentPhase.id} は最終フェーズです。/workflow-verify で完了を確認してください。`,
    };
  }

  // Move to next phase
  state.completedPhases.push(state.currentPhase);
  state.currentPhase = nextPhaseId;
  state.lastUpdatedAt = new Date().toISOString();
  saveState(state);

  return {
    success: true,
    newPhase: nextPhaseId,
    errors: [],
    message: `✅ Phase ${nextPhaseId} に進みました`,
  };
}

/**
 * Verify workflow completion
 */
export function verifyCompletion(): ValidationResult {
  const state = loadState();

  if (!state) {
    return {
      passed: false,
      errors: ['No active workflow'],
      warnings: [],
    };
  }

  const workflow = getWorkflow(state.workflowId);
  const currentPhase = workflow.phases.find((p) => p.id === state.currentPhase);

  if (!currentPhase) {
    return {
      passed: false,
      errors: ['Current phase not found'],
      warnings: [],
    };
  }

  // Check if current phase is the final phase
  if (currentPhase.nextPhase !== null) {
    const remaining = workflow.phases.filter(
      (p) => !state.completedPhases.includes(p.id) && p.id !== state.currentPhase
    );

    return {
      passed: false,
      errors: [
        `ワークフローは完了していません。残りフェーズ: ${remaining.map((p) => p.id).join(', ')}`,
      ],
      warnings: [],
    };
  }

  // Validate final phase
  const validation = validatePhase();

  if (!validation.passed) {
    return {
      passed: false,
      errors: [`最終フェーズの完了条件を満たしていません`, ...validation.errors],
      warnings: validation.warnings,
    };
  }

  return {
    passed: true,
    errors: [],
    warnings: [],
  };
}

// ============================================================
// Phase 3: Rollback Functions
// ============================================================

/**
 * フェーズスナップショットを作成
 * Phase 3: Create phase snapshot for rollback
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function createSnapshot(phaseId: string): PhaseSnapshot {
  const state = loadState();
  const workflow = getWorkflow(state!.workflowId);
  const phase = workflow.phases.find((p) => p.id === phaseId);

  if (!phase) {
    throw new Error(`Phase ${phaseId} not found`);
  }

  const artifacts: Record<string, string> = {};

  // 成果物のバックアップ
  if (phase.requiredArtifacts) {
    for (const artifact of phase.requiredArtifacts) {
      if (fs.existsSync(artifact)) {
        artifacts[artifact] = fs.readFileSync(artifact, 'utf-8');
      }
    }
  }

  return {
    phaseId,
    artifacts,
    metadata: { ...state!.metadata },
    timestamp: new Date().toISOString(),
  };
}

/**
 * 指定フェーズにロールバック
 * Phase 3: Rollback to specified phase
 */
export function rollbackToPhase(
  targetPhaseId: string,
  reason?: string
): RollbackHistory {
  const state = loadState();

  if (!state) {
    throw new Error('No active workflow');
  }

  const workflow = getWorkflow(state.workflowId);

  // ターゲットフェーズが存在するか確認
  const targetPhase = workflow.phases.find((p) => p.id === targetPhaseId);
  if (!targetPhase) {
    throw new Error(`Phase ${targetPhaseId} not found in workflow`);
  }

  // ロールバック可能か確認
  const currentPhase = workflow.phases.find((p) => p.id === state.currentPhase);
  if (
    currentPhase?.allowRollbackTo &&
    !currentPhase.allowRollbackTo.includes(targetPhaseId)
  ) {
    throw new Error(
      `Rollback to ${targetPhaseId} is not allowed from ${state.currentPhase}`
    );
  }

  // 削除対象の成果物を収集
  const targetIndex = workflow.phases.findIndex((p) => p.id === targetPhaseId);
  const currentIndex = workflow.phases.findIndex(
    (p) => p.id === state.currentPhase
  );

  // 同一パスが複数フェーズの requiredArtifacts に重複し得るため Set で一意化する
  // （重複のまま削除ループに渡すと 2 回目の unlink が ENOENT で中断してしまう）
  const artifactsToDeleteSet = new Set<string>();
  for (let i = targetIndex + 1; i <= currentIndex; i++) {
    const phase = workflow.phases[i];
    if (phase.requiredArtifacts) {
      for (const artifact of phase.requiredArtifacts) {
        if (fs.existsSync(artifact)) {
          artifactsToDeleteSet.add(artifact);
        }
      }
    }
  }
  const artifactsToDelete = Array.from(artifactsToDeleteSet);

  // 削除前に全成果物の削除可否を検証する（state 更新前・ファイル削除前）。
  // 1件でも削除不能なら何も消さずに中断し、state も成果物も変化させない。
  const undeletable: string[] = [];
  const directoryArtifacts: string[] = [];
  for (const artifact of artifactsToDelete) {
    try {
      // ディレクトリ成果物は unlink できず EISDIR になる（video_generation_v1 の
      // assets/images/ 等）。誤設定パスの再帰削除は危険なため自動削除しない
      if (fs.lstatSync(artifact).isDirectory()) {
        directoryArtifacts.push(artifact);
        continue;
      }
      // unlink には親ディレクトリへの書き込み権限と探索（実行）権限が必要
      fs.accessSync(
        path.dirname(artifact),
        fs.constants.W_OK | fs.constants.X_OK
      );
    } catch {
      undeletable.push(artifact);
    }
  }
  if (directoryArtifacts.length > 0) {
    throw new Error(
      `Rollback aborted: directory artifacts cannot be deleted automatically:\n` +
        directoryArtifacts.map((a) => `  - ${a}`).join('\n') +
        `\n\nロールバックを中断しました（state・成果物とも変更されていません）。\n` +
        `上記の成果物はディレクトリのため、安全のため自動削除しません。\n` +
        `手動対応手順:\n` +
        `  1. 内容を確認し、不要であれば手動で削除する（rm -r <ディレクトリ>）\n` +
        `  2. もう一度ロールバックを実行する`
    );
  }
  if (undeletable.length > 0) {
    throw new Error(
      `Rollback aborted: cannot delete artifacts (permission denied):\n` +
        undeletable.map((a) => `  - ${a}`).join('\n') +
        `\n\nロールバックを中断しました（state・成果物とも変更されていません）。\n` +
        `上記ファイルの親ディレクトリに書き込み・探索権限がないため削除できません。\n` +
        `手動対応手順:\n` +
        `  1. chmod u+wx <親ディレクトリ> で権限を付与する（または所有者を確認: ls -ld）\n` +
        `  2. もう一度ロールバックを実行する\n` +
        `  3. 権限を変更できない場合は、上記ファイルを手動で削除してから再実行する`
    );
  }

  // 検証済みの成果物を削除（途中失敗時は state を変更せずに中断し、進捗を報告）
  const deletedArtifacts: string[] = [];
  for (const artifact of artifactsToDelete) {
    try {
      fs.unlinkSync(artifact);
      deletedArtifacts.push(artifact);
    } catch (error) {
      const remaining = artifactsToDelete.filter(
        (a) => !deletedArtifacts.includes(a)
      );
      throw new Error(
        `Rollback aborted: failed to delete artifact: ${artifact} (${(error as Error).message})\n\n` +
          `ロールバックを中断しました（state は変更されていません）。\n` +
          `削除済み: ${deletedArtifacts.length > 0 ? deletedArtifacts.join(', ') : 'なし'}\n` +
          `未削除: ${remaining.join(', ')}\n` +
          `手動対応手順:\n` +
          `  1. 未削除ファイルを手動で削除する（rm <ファイル>）\n` +
          `  2. もう一度ロールバックを実行する`,
        { cause: error }
      );
    }
  }

  // ロールバック履歴を記録
  const rollback: RollbackHistory = {
    rollbackId: `rollback_${Date.now()}`,
    fromPhase: state.currentPhase,
    toPhase: targetPhaseId,
    reason,
    deletedArtifacts,
    timestamp: new Date().toISOString(),
  };

  if (!state.rollbackHistory) {
    state.rollbackHistory = [];
  }
  state.rollbackHistory.push(rollback);

  // 完了フェーズを更新
  state.completedPhases = state.completedPhases.filter((phaseId) => {
    const index = workflow.phases.findIndex((p) => p.id === phaseId);
    return index < targetIndex;
  });

  // 現在フェーズを更新
  state.currentPhase = targetPhaseId;
  state.lastUpdatedAt = new Date().toISOString();

  saveState(state);

  return rollback;
}
