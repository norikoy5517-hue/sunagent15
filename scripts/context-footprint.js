#!/usr/bin/env node
'use strict';

/**
 * Context Footprint Meter — コンテキスト削減モデルの計測基盤
 *
 * 毎セッション Claude Code に自動注入される固定コンテキスト量を
 * 決定的（同一入力 → 同一数値）に計測する。
 *
 * 使い方:
 *   node scripts/context-footprint.js                  # レポート表示（静的・副作用なし）
 *   node scripts/context-footprint.js --json           # JSON出力
 *   node scripts/context-footprint.js --check --limit 3700   # ゲート（超過で exit 1）
 *   node scripts/context-footprint.js --hooks          # hook stdout も実測
 *       ※ --hooks は実際に hook を実行するため、hook が管理する状態ファイル
 *         （.workflow_state.json / .claude/hooks/data/ 等）を更新する副作用がある。
 *         CI ゲートおよびデフォルトレポートには含めない。
 *
 * 計測区分:
 *   [gate]  毎セッション自動注入されるファイル（CLAUDE.md + rules/*.md）
 *           → 決定的なので CI ゲート対象
 *   [info]  boot/*.md          — 注入経路が検出されないファイル（要棚卸し）
 *   [lazy]  references/*.md    — 明示 Read 時のみロード（ゲート対象外）
 *   [hooks] SessionStart/UserPromptSubmit hook の stdout — 状態依存のため参考値
 *
 * トークン換算（ヒューリスティック）:
 *   CJK文字（日本語等）: 3文字 ≈ 1トークン
 *   その他（英数・記号）: 4文字 ≈ 1トークン
 *   実トークナイザより少なめに出る傾向があるが、削減の相対比較には十分。
 *   注: 「文字数」基準であり「バイト数」基準ではない（日本語はUTF-8で1文字3バイト。
 *   バイト数/3 はトークンではなく文字数の近似になるので混同しないこと）。
 *
 * 削減目標: doc/2026-06-11_improvement-plan-sunagent15.md Phase 3 参照
 *   現状 ~3,587 tokens → Phase 3 完了時 ~1,800 tokens（CI limit は ratchet 方式で追従）
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const claudeDir = path.join(repoRoot, '.claude');

// CJK 判定: 全角記号・ひらがな・カタカナ・CJK統合漢字・全角英数
const CJK_RE = /[　-ヿ一-鿿＀-￯]/;

function estimateTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.round(cjk / 3 + other / 4);
}

function measureFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return {
    // Report paths with '/' on every OS so output is identical on Windows and CI (Linux)
    path: path.relative(repoRoot, filePath).split(path.sep).join('/'),
    bytes: Buffer.byteLength(text, 'utf8'),
    tokens: estimateTokens(text),
  };
}

function listMarkdown(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => path.join(dirPath, name));
}

function collect() {
  const gate = [];
  const claudeMd = path.join(claudeDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMd)) gate.push(measureFile(claudeMd));
  for (const f of listMarkdown(path.join(claudeDir, 'rules'))) gate.push(measureFile(f));

  const info = listMarkdown(path.join(claudeDir, 'boot')).map(measureFile);
  const lazy = listMarkdown(path.join(claudeDir, 'references')).map(measureFile);

  return { gate, info, lazy };
}

// hook stdout 実測（--hooks 指定時のみ）
// 注意: hook を実際に実行するため副作用あり（上記ヘッダー参照）。状態・環境依存の参考値。
function measureHooks() {
  const settingsPath = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) return [];

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return [];
  }

  const results = [];

  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    const fixtureStdin = JSON.stringify({
      hook_event_name: event,
      session_id: 'footprint-fixture',
      cwd: repoRoot,
      prompt: 'こんにちは',
    });

    const entries = (settings.hooks && settings.hooks[event]) || [];
    for (const entry of entries) {
      for (const hook of entry.hooks || []) {
        if (hook.type !== 'command' || !hook.command) continue;
        // settings.json の timeout は秒単位。未指定は 5 秒。
        const timeoutMs = (Number(hook.timeout) > 0 ? Number(hook.timeout) : 5) * 1000;
        const run = spawnSync('bash', ['-c', hook.command], {
          cwd: repoRoot,
          input: fixtureStdin,
          encoding: 'utf8',
          timeout: timeoutMs,
        });
        const stdout = run.stdout || '';
        let status = 'ok';
        if (run.error) status = run.error.code === 'ETIMEDOUT' ? 'timeout' : `error(${run.error.code})`;
        else if (run.signal) status = `signal(${run.signal})`;
        else if (run.status !== 0) status = `exit(${run.status})`;
        results.push({
          path: `${event}: ${hook.command.slice(0, 56)}`,
          bytes: Buffer.byteLength(stdout, 'utf8'),
          tokens: estimateTokens(stdout),
          status,
        });
      }
    }
  }
  return results;
}

function sum(items) {
  return items.reduce(
    (acc, item) => ({ bytes: acc.bytes + item.bytes, tokens: acc.tokens + item.tokens }),
    { bytes: 0, tokens: 0 }
  );
}

function renderTable(title, items, withStatus) {
  if (items.length === 0) return '';
  const lines = [`\n## ${title}\n`];
  const width = Math.max(...items.map((i) => i.path.length), 4);
  const header = `  ${'path'.padEnd(width)}  ${'bytes'.padStart(8)}  ${'tokens'.padStart(7)}`;
  lines.push(withStatus ? `${header}  status` : header);
  for (const item of items) {
    const row = `  ${item.path.padEnd(width)}  ${String(item.bytes).padStart(8)}  ${String(item.tokens).padStart(7)}`;
    lines.push(withStatus ? `${row}  ${item.status || ''}` : row);
  }
  const total = sum(items);
  lines.push(
    `  ${'TOTAL'.padEnd(width)}  ${String(total.bytes).padStart(8)}  ${String(total.tokens).padStart(7)}`
  );
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes('--check');
  const isJson = args.includes('--json');
  const withHooks = args.includes('--hooks');
  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : null;

  if (isCheck && (!Number.isFinite(limit) || limit <= 0)) {
    process.stderr.write('Usage: context-footprint.js --check --limit <tokens>\n');
    process.exit(2);
  }

  if (withHooks) {
    // 副作用の事前可視化（stderr なので --json の stdout は汚さない）
    process.stderr.write(
      '[Context Footprint] ⚠️ --hooks: hook を実際に実行します。' +
        '状態ファイル（.workflow_state.json / .claude/hooks/data/ 等）が更新される副作用があります\n'
    );
  }

  const { gate, info, lazy } = collect();
  const hooks = withHooks ? measureHooks() : [];
  const gateTotal = sum(gate);
  const pass = isCheck ? gateTotal.tokens <= limit : null;

  if (isJson) {
    process.stdout.write(
      JSON.stringify(
        {
          gate,
          gateTotal,
          info,
          lazy,
          hooks: withHooks ? hooks : undefined,
          check: isCheck ? { limit, pass } : undefined,
        },
        null,
        2
      ) + '\n'
    );
  } else {
    process.stdout.write('# Context Footprint Report\n');
    process.stdout.write(renderTable('毎セッション自動注入 [gate — CIゲート対象]', gate));
    process.stdout.write(renderTable('注入経路未検出 [info — 棚卸し対象]', info));
    process.stdout.write(renderTable('遅延参照 [lazy — 明示Read時のみ]', lazy));
    if (withHooks) {
      process.stdout.write(renderTable('hook stdout 実測 [参考値・環境依存・副作用あり]', hooks, true));
    }
    process.stdout.write(
      `\n\n毎セッション固定注入（gate合計）: ${gateTotal.bytes} bytes ≈ ${gateTotal.tokens} tokens\n`
    );
  }

  if (isCheck) {
    if (!pass) {
      process.stderr.write(
        `\n[Context Footprint] ❌ ゲート超過: ${gateTotal.tokens} tokens > 上限 ${limit} tokens\n` +
          `  → CLAUDE.md / .claude/rules/*.md の注入量を削減してください\n` +
          `  → 詳細: npm run context:report / 削減計画: doc/2026-06-11_improvement-plan-sunagent15.md Phase 3\n`
      );
      process.exit(1);
    }
    process.stderr.write(`[Context Footprint] ✅ ゲート通過: ${gateTotal.tokens} <= ${limit} tokens\n`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { estimateTokens, collect, sum };
