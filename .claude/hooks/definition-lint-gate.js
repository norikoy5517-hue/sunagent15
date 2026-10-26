#!/usr/bin/env node
/**
 * Definition Lint Gate - ワークフロー/ポリシー定義の検証
 *
 * PostToolUse (Write/Edit) 時に実行され、
 * YAML/JSON形式の定義ファイルを検証します。
 *
 * 検証対象:
 * - workflow*.yaml/yml
 * - policy*.yaml/yml
 * - *.workflow.json
 * - *.policy.json
 * - skill-mapping.json
 *
 * 防止する問題:
 * - 不正な定義ファイルの保存
 * - 必須フィールドの欠落
 * - 無効な参照
 */

const fs = require('fs');
const path = require('path');
const { readStdin } = require('./utils/read-stdin');

// 検証対象ファイルパターン
const TARGET_PATTERNS = [
  /workflow.*\.(yaml|yml|json)$/i,
  /policy.*\.(yaml|yml|json)$/i,
  /skill-mapping\.json$/i,
  /\.workflow\.json$/i,
  /\.policy\.json$/i,
];

/**
 * lint 対象ファイルか判定（PostToolUse main() と lint-all 再帰スキャンで共通）
 * - TARGET_PATTERNS にマッチするファイル名
 * - または workflows ディレクトリ配下の .json（ワークフロー定義は
 *   content_creation_v1.json のようにファイル名に "workflow" を含まないため）
 * - "_" 始まりのファイル（_schema.json 等）は除外
 */
function isLintTarget(filePath) {
  const fileName = path.basename(filePath);
  if (fileName.startsWith('_')) return false;
  if (TARGET_PATTERNS.some((pattern) => pattern.test(fileName))) return true;
  return (
    fileName.endsWith('.json') &&
    // Split on both separators: hook inputs on Windows may use '/' or '\'
    path.dirname(filePath).split(/[\\/]/).includes('workflows')
  );
}

// 必須フィールド定義
const SCHEMA_DEFINITIONS = {
  workflow: {
    required: ['name', 'phases'],
    recommended: ['version', 'description'],
    phaseFields: ['name', 'steps'],
  },
  policy: {
    required: ['name', 'rules'],
    recommended: ['version', 'description'],
    ruleFields: ['name', 'action'],
  },
  skillMapping: {
    required: ['mappings'],
    mappingFields: ['name', 'required_skills'],
    mappingRecommended: ['when_contains_all', 'when_contains_any', 'description'],
  },
};

async function main() {
  let input = {};

  try {
    const stdinData = await readStdin();
    if (stdinData) {
      input = JSON.parse(stdinData);
    }
  } catch (e) {
    process.exit(0);
    return;
  }

  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};

  // Write/Edit ツールのみチェック
  if (toolName !== 'Write' && toolName !== 'Edit') {
    process.exit(0);
    return;
  }

  const filePath = toolInput.file_path || '';
  const fileName = path.basename(filePath);

  // 対象ファイルかチェック（lint-all と同一判定。workflows ディレクトリ配下の
  // .json はファイル名に "workflow" を含まなくても対象）
  if (!isLintTarget(filePath)) {
    process.exit(0);
    return;
  }

  // ファイルが存在するか確認
  if (!fs.existsSync(filePath)) {
    process.exit(0);
    return;
  }

  // ファイル内容を読み込んで検証
  const violations = [];
  const warnings = [];

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    let data;

    // JSON/YAML パース
    if (filePath.endsWith('.json')) {
      data = JSON.parse(content);
    } else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
      // 簡易YAMLパース（基本的なケースのみ）
      data = parseSimpleYaml(content);
    }

    if (!data) {
      violations.push({
        type: 'parse_error',
        message: 'ファイルのパースに失敗しました',
      });
    } else {
      // スキーマに基づく検証
      const fileType = detectFileType(fileName, data);
      const schema = SCHEMA_DEFINITIONS[fileType];

      if (schema) {
        // 必須フィールドチェック
        if (schema.required) {
          for (const field of schema.required) {
            if (!data[field]) {
              violations.push({
                type: 'missing_required',
                message: `必須フィールド "${field}" が見つかりません`,
              });
            }
          }
        }

        // 推奨フィールドチェック
        if (schema.recommended) {
          for (const field of schema.recommended) {
            if (!data[field]) {
              warnings.push({
                type: 'missing_recommended',
                message: `推奨フィールド "${field}" がありません`,
              });
            }
          }
        }

        // ネストされた項目のチェック
        if (fileType === 'skillMapping' && data.mappings) {
          for (let i = 0; i < data.mappings.length; i++) {
            const mapping = data.mappings[i];
            for (const field of schema.mappingFields) {
              if (!mapping[field]) {
                violations.push({
                  type: 'missing_mapping_field',
                  message: `mappings[${i}] に必須フィールド "${field}" がありません`,
                });
              }
            }
          }
        }

        // 追加の検証ルール
        validateAdditionalRules(data, fileType, violations, warnings);
      }
    }
  } catch (e) {
    violations.push({
      type: 'validation_error',
      message: `検証エラー: ${e.message}`,
    });
  }

  // 結果を出力
  if (violations.length > 0 || warnings.length > 0) {
    // 詳細をJSONファイルに退避
    try {
      const detailFile = path.join(process.cwd(), '.claude/hooks/data/lint-gate-detail.json');
      const detailDir = path.dirname(detailFile);
      if (!fs.existsSync(detailDir)) {
        fs.mkdirSync(detailDir, { recursive: true });
      }
      fs.writeFileSync(detailFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        fileName,
        violations,
        warnings
      }, null, 2));
    } catch (e) { /* ignore */ }

    if (violations.length > 0) {
      // stdout: AI向け1行（コンテキスト注入）
      console.log(`[Lint Gate] ⚠️ ADVISORY: ${fileName}: CRITICAL ${violations.length}件 -> 詳細: .claude/hooks/data/lint-gate-detail.json`);
      // stderr: 人間向け表示（警告のみ、ブロックしない）
      console.error(`\x1b[33m[Lint Gate] ADVISORY: ${fileName}: CRITICAL ${violations.length}件, WARNING ${warnings.length}件\x1b[0m`);
      violations.forEach((v, i) => {
        console.error(`  ${i + 1}. [${v.type}] ${v.message}`);
      });
      console.error('\x1b[33m  → 多人数共有システムのため警告のみ（ブロックしません）\x1b[0m');
      // 多人数共有システム: 警告のみ、ブロックしない
      process.exit(0);
      return;
    }

    // warnings のみの場合: stderrのみ（stdoutに出力しない）
    console.error(`\x1b[33m[Lint Gate] ${fileName}: WARNING ${warnings.length}件\x1b[0m`);
    warnings.forEach((w, i) => {
      console.error(`  ${i + 1}. [${w.type}] ${w.message}`);
    });
  }

  process.exit(0);
}

/**
 * ファイルタイプを検出
 */
function detectFileType(fileName, data) {
  if (fileName.includes('skill-mapping') || data.mappings) {
    return 'skillMapping';
  }
  if (fileName.includes('workflow') || data.phases) {
    return 'workflow';
  }
  if (fileName.includes('policy') || data.rules) {
    return 'policy';
  }
  return null;
}

/**
 * 追加の検証ルール
 */
function validateAdditionalRules(data, fileType, violations, warnings) {
  if (fileType === 'skillMapping') {
    // スキルマッピング固有の検証
    if (data.mappings) {
      for (let i = 0; i < data.mappings.length; i++) {
        const mapping = data.mappings[i];

        // required_skills が空配列でないか
        if (mapping.required_skills && mapping.required_skills.length === 0) {
          warnings.push({
            type: 'empty_skills',
            message: `mappings[${i}] (${mapping.name}) の required_skills が空です`,
          });
        }

        // when_contains_all と when_contains_any が両方空の場合
        const hasAll = mapping.when_contains_all && mapping.when_contains_all.length > 0;
        const hasAny = mapping.when_contains_any && mapping.when_contains_any.length > 0;
        if (!hasAll && !hasAny) {
          warnings.push({
            type: 'no_trigger',
            message: `mappings[${i}] (${mapping.name}) にトリガー条件がありません`,
          });
        }

        // priority が0以上か
        if (typeof mapping.priority === 'number' && mapping.priority < 0) {
          violations.push({
            type: 'invalid_priority',
            message: `mappings[${i}] (${mapping.name}) の priority は0以上である必要があります`,
          });
        }
      }
    }

    // 設定の検証
    if (data.settings) {
      if (typeof data.settings.block_on_missing_skill !== 'boolean') {
        warnings.push({
          type: 'missing_setting',
          message: 'settings.block_on_missing_skill の指定を推奨します',
        });
      }
    }
  }

  if (fileType === 'workflow') {
    // ワークフロー固有の検証
    if (data.phases) {
      for (let i = 0; i < data.phases.length; i++) {
        const phase = data.phases[i];
        if (!phase.name) {
          violations.push({
            type: 'missing_phase_name',
            message: `phases[${i}] に name がありません`,
          });
        }
      }
    }
  }
}

/**
 * 簡易YAMLパーサー（基本的なkey: valueのみ対応）
 */
function parseSimpleYaml(content) {
  // 基本的なYAMLのみ対応
  // 複雑な場合は js-yaml などのライブラリを使用すべき
  const lines = content.split('\n');
  const result = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex > 0) {
      const key = trimmed.substring(0, colonIndex).trim();
      const value = trimmed.substring(colonIndex + 1).trim();
      result[key] = value || true;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

// ===== Phase 7: Definition Lint Hard Gate API =====

/**
 * 既知のスキル/エージェント名を収集（allowedSkills 実在検証用）
 * - scripts/skill-profiles.json（配布スキルの SSoT・全プロファイル）
 * - .claude/skills/ のディレクトリ名（リポジトリ同梱スキル）
 * - .claude/agent-source/ の frontmatter name（エージェント名。
 *   ワークフローの allowedSkills はスキル名とエージェント名の混在名前空間のため）
 */
function loadKnownSkillNames(cwd) {
  const known = new Set();

  try {
    const profiles = JSON.parse(
      fs.readFileSync(path.join(cwd, 'scripts/skill-profiles.json'), 'utf8')
    );
    for (const profile of Object.values(profiles.profiles || {})) {
      for (const skill of profile.skills || []) known.add(skill);
    }
  } catch (e) { /* SSoTが無い環境では skills/agents のみで検証 */ }

  const skillsDir = path.join(cwd, '.claude/skills');
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) known.add(entry.name);
    }
  }

  const agentDir = path.join(cwd, '.claude/agent-source');
  if (fs.existsSync(agentDir)) {
    for (const file of fs.readdirSync(agentDir)) {
      if (!file.endsWith('.md')) continue;
      try {
        const head = fs.readFileSync(path.join(agentDir, file), 'utf8').slice(0, 500);
        const m = head.match(/^name:\s*(\S+)/m);
        if (m) known.add(m[1]);
      } catch (e) { /* ignore */ }
    }
  }

  return known;
}

/**
 * ディレクトリを再帰走査して lint 対象ファイル（isLintTarget 判定）を収集
 * - "_" 始まり（_schema.md / _drafts/ 等）はディレクトリ・ファイルとも除外
 * - 隠しディレクトリ・node_modules も除外
 */
function collectLintTargets(dir, targets) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name.startsWith('.') ||
      entry.name.startsWith('_') ||
      entry.name === 'node_modules'
    ) {
      continue;
    }
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectLintTargets(filePath, targets);
    } else if (entry.isFile() && isLintTarget(filePath)) {
      targets.push(filePath);
    }
  }
}

/**
 * 全定義ファイルをLintする（ワークフロー開始時に呼び出し）
 * config/workflows/ 配下も再帰スキャンする（旧実装は非再帰でワークフロー定義を見ていなかった）
 */
function lintAllDefinitions(cwd) {
  const results = {
    valid: true,
    violations: [],
    warnings: [],
    checkedFiles: [],
    workflowFilesChecked: 0
  };

  // 検索対象ディレクトリ
  const searchPaths = [
    path.join(cwd, '.claude/hooks/config'),
    path.join(cwd, 'config'),
    path.join(cwd, 'artifacts')
  ];

  const targets = [];
  for (const searchPath of searchPaths) {
    collectLintTargets(searchPath, targets);
  }

  const knownSkills = loadKnownSkillNames(cwd);

  for (const filePath of targets) {
    const result = lintFile(filePath);
    results.checkedFiles.push(filePath);

    // allowedSkills 実在検証（ワークフロー定義のみ・警告レベル）
    // 未解決名はリポジトリ外エージェント等の可能性があるためブロックしない
    if (filePath.endsWith('.json')) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (Array.isArray(data.phases)) {
          results.workflowFilesChecked += 1;
          for (const phase of data.phases) {
            for (const skill of phase.allowedSkills || []) {
              if (!knownSkills.has(skill)) {
                result.warnings.push({
                  type: 'unknown_skill',
                  message: `phase "${phase.id}" の allowedSkills "${skill}" がスキル/エージェント定義に見つかりません（skill-profiles.json / .claude/skills / .claude/agent-source を確認）`
                });
              }
            }
          }
        }
      } catch (e) { /* パース不能は lintFile 側で violation 済み */ }
    }

    if (result.violations.length > 0) {
      results.valid = false;
      results.violations.push({
        file: filePath,
        issues: result.violations
      });
    }
    if (result.warnings.length > 0) {
      results.warnings.push({
        file: filePath,
        issues: result.warnings
      });
    }
  }

  return results;
}

/**
 * 単一ファイルをLintする
 */
function lintFile(filePath) {
  const violations = [];
  const warnings = [];

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    let data;

    if (filePath.endsWith('.json')) {
      data = JSON.parse(content);
    } else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
      data = parseSimpleYaml(content);
    }

    if (!data) {
      violations.push({
        type: 'parse_error',
        message: 'ファイルのパースに失敗しました'
      });
    } else {
      const fileName = path.basename(filePath);
      const fileType = detectFileType(fileName, data);
      const schema = SCHEMA_DEFINITIONS[fileType];

      if (schema) {
        if (schema.required) {
          for (const field of schema.required) {
            if (!data[field]) {
              violations.push({
                type: 'missing_required',
                message: `必須フィールド "${field}" が見つかりません`
              });
            }
          }
        }

        if (schema.recommended) {
          for (const field of schema.recommended) {
            if (!data[field]) {
              warnings.push({
                type: 'missing_recommended',
                message: `推奨フィールド "${field}" がありません`
              });
            }
          }
        }
      }
    }
  } catch (e) {
    violations.push({
      type: 'validation_error',
      message: `検証エラー: ${e.message}`
    });
  }

  return { violations, warnings };
}

// CLI実行
if (require.main === module) {
  // コマンドライン引数でlint実行
  if (process.argv[2] === 'lint-all') {
    const cwd = process.argv[3] || process.cwd();
    const results = lintAllDefinitions(cwd);
    console.log(JSON.stringify(results, null, 2));
    process.exit(results.valid ? 0 : 2);
  } else {
    main().catch(() => process.exit(0));
  }
}

// モジュールエクスポート
module.exports = {
  lintAllDefinitions,
  lintFile,
  isLintTarget,
  SCHEMA_DEFINITIONS,
  TARGET_PATTERNS
};
