#!/usr/bin/env npx ts-node
/**
 * UTF-8 Guard - Encoding validation and mojibake detection CLI
 *
 * 文字化け・不正UTF-8を検知するCIゲート用ツール
 *
 * Usage:
 *   npx ts-node scripts/text/utf8-guard.ts              # Check git diff files
 *   npx ts-node scripts/text/utf8-guard.ts --all        # Check all text files
 *   npx ts-node scripts/text/utf8-guard.ts --files a.ts b.ts
 *   npm run text:utf8-guard
 *
 * Options:
 *   --files <paths...>  Specific files to check
 *   --all               Check all text files in repository
 *   --staged            Check only staged files (git diff --cached)
 *   --verbose           Show detailed output
 *   --fix-bom           Remove UTF-8 BOM if found
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

interface ValidationResult {
  file: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
}

interface GuardSummary {
  total: number;
  passed: number;
  failed: number;
  warnings: number;
  results: ValidationResult[];
}

// Text file extensions to check
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.yaml', '.yml',
  '.md', '.txt', '.csv',
  '.html', '.css', '.scss', '.less',
  '.xml', '.svg',
  '.sh', '.bash', '.zsh',
  '.py', '.rb', '.go', '.rs', '.java',
  '.env', '.env.example', '.env.local',
  '.gitignore', '.gitattributes', '.editorconfig',
  '.eslintrc', '.prettierrc', '.babelrc',
]);

/**
 * Check if file is a text file by extension
 */
export function isTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath);

  // Check extension
  if (TEXT_EXTENSIONS.has(ext)) return true;

  // Check known text files without extension
  if (basename === 'Dockerfile' || basename === 'Makefile') return true;
  if (basename.startsWith('.') && !ext) return true; // dotfiles

  return false;
}

/**
 * Validate UTF-8 encoding using TextDecoder with fatal option
 */
export function validateUtf8(buffer: Buffer): { valid: boolean; error?: string } {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    decoder.decode(buffer);
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: 'Invalid UTF-8 byte sequence detected',
    };
  }
}

/**
 * Check for replacement character (U+FFFD) indicating mojibake
 */
export function findReplacementChars(content: string): number[] {
  const positions: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 0xFFFD) {
      positions.push(i);
    }
  }
  return positions;
}

/**
 * Check for UTF-8 BOM (Byte Order Mark)
 */
export function hasBom(buffer: Buffer): boolean {
  return buffer.length >= 3 &&
    buffer[0] === 0xEF &&
    buffer[1] === 0xBB &&
    buffer[2] === 0xBF;
}

/**
 * Remove UTF-8 BOM from buffer
 */
export function removeBom(buffer: Buffer): Buffer {
  if (hasBom(buffer)) {
    return buffer.slice(3);
  }
  return buffer;
}

/**
 * Get line number for character position
 */
export function getLineNumber(content: string, position: number): number {
  let line = 1;
  for (let i = 0; i < position && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/**
 * Validate a single file
 */
export function validateFile(filePath: string, options: { fixBom?: boolean } = {}): ValidationResult {
  const result: ValidationResult = {
    file: filePath,
    valid: true,
    errors: [],
    warnings: [],
  };

  try {
    if (!fs.existsSync(filePath)) {
      result.valid = false;
      result.errors.push('File not found');
      return result;
    }

    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      return result; // Skip directories
    }

    let buffer: Buffer = fs.readFileSync(filePath);

    // Check and optionally fix BOM
    if (hasBom(buffer)) {
      if (options.fixBom) {
        buffer = removeBom(buffer);
        fs.writeFileSync(filePath, buffer);
        result.warnings.push('UTF-8 BOM removed');
      } else {
        result.warnings.push('UTF-8 BOM detected (use --fix-bom to remove)');
      }
    }

    // Validate UTF-8
    const utf8Result = validateUtf8(buffer);
    if (!utf8Result.valid) {
      result.valid = false;
      result.errors.push(utf8Result.error || 'Invalid UTF-8');
      return result;
    }

    // Check for replacement characters
    const content = buffer.toString('utf-8');
    const replacementPositions = findReplacementChars(content);
    if (replacementPositions.length > 0) {
      result.valid = false;
      const lines = replacementPositions.slice(0, 5).map(pos => getLineNumber(content, pos));
      result.errors.push(
        `Found ${replacementPositions.length} U+FFFD replacement character(s) at line(s): ${lines.join(', ')}${replacementPositions.length > 5 ? '...' : ''}`
      );
    }

  } catch (error) {
    result.valid = false;
    result.errors.push(error instanceof Error ? error.message : String(error));
  }

  return result;
}

/**
 * Get files from git diff
 */
export function getGitDiffFiles(staged: boolean = false): string[] {
  try {
    const command = staged
      ? 'git diff --cached --name-only --diff-filter=ACMR'
      : 'git diff --name-only HEAD --diff-filter=ACMR';

    const output = execSync(command, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return output
      .split('\n')
      .map(f => f.trim())
      .filter(f => f.length > 0 && isTextFile(f) && fs.existsSync(f));
  } catch {
    // Not in a git repo or no changes
    return [];
  }
}

/**
 * Get all text files in repository
 */
export function getAllTextFiles(dir: string = '.'): string[] {
  const files: string[] = [];
  const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);

  function walk(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!ignoreDirs.has(entry.name) && !entry.name.startsWith('.')) {
          walk(fullPath);
        }
      } else if (entry.isFile() && isTextFile(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files;
}

/**
 * Parse command line arguments
 */
function parseArgs(): { files: string[]; verbose: boolean; fixBom: boolean; all: boolean; staged: boolean } {
  const args = process.argv.slice(2);
  const options = {
    files: [] as string[],
    verbose: false,
    fixBom: false,
    all: false,
    staged: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    switch (arg) {
      case '--files':
        i++;
        while (i < args.length && !args[i].startsWith('--')) {
          options.files.push(args[i]);
          i++;
        }
        continue;
      case '--all':
        options.all = true;
        break;
      case '--staged':
        options.staged = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--fix-bom':
        options.fixBom = true;
        break;
      default:
        // Assume it's a file path
        if (!arg.startsWith('--')) {
          options.files.push(arg);
        }
    }
    i++;
  }

  return options;
}

/**
 * Run validation on all files
 */
export function runGuard(files: string[], options: { verbose?: boolean; fixBom?: boolean } = {}): GuardSummary {
  const summary: GuardSummary = {
    total: files.length,
    passed: 0,
    failed: 0,
    warnings: 0,
    results: [],
  };

  for (const file of files) {
    const result = validateFile(file, { fixBom: options.fixBom });
    summary.results.push(result);

    if (result.valid) {
      summary.passed++;
    } else {
      summary.failed++;
    }

    if (result.warnings.length > 0) {
      summary.warnings++;
    }
  }

  return summary;
}

/**
 * Main entry point
 */
function main(): void {
  const options = parseArgs();

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔍 UTF-8 Guard - Encoding validation');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Determine files to check
  let files: string[] = options.files;

  if (files.length === 0) {
    if (options.all) {
      files = getAllTextFiles();
      console.log(`📁 Checking all text files (${files.length})...\n`);
    } else {
      files = getGitDiffFiles(options.staged);
      if (files.length === 0) {
        console.log('✅ No changed text files to check\n');
        process.exit(0);
      }
      console.log(`📁 Checking ${options.staged ? 'staged' : 'changed'} files (${files.length})...\n`);
    }
  } else {
    console.log(`📁 Checking specified files (${files.length})...\n`);
  }

  // Run validation
  const summary = runGuard(files, { verbose: options.verbose, fixBom: options.fixBom });

  // Output results
  for (const result of summary.results) {
    if (!result.valid) {
      console.log(`❌ ${result.file}`);
      for (const error of result.errors) {
        console.log(`   └─ ${error}`);
      }
    } else if (result.warnings.length > 0) {
      console.log(`⚠️  ${result.file}`);
      for (const warning of result.warnings) {
        console.log(`   └─ ${warning}`);
      }
    } else if (options.verbose) {
      console.log(`✅ ${result.file}`);
    }
  }

  // Summary
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📊 Summary: ${summary.passed}/${summary.total} files passed`);

  if (summary.warnings > 0) {
    console.log(`⚠️  ${summary.warnings} file(s) with warnings`);
  }

  if (summary.failed > 0) {
    console.log(`\n❌ UTF-8 Guard FAILED - ${summary.failed} file(s) have encoding issues`);
    console.log('\n💡 復旧方法:');
    console.log('   1. git restore <file>  # 変更を元に戻す');
    console.log('   2. .claude/backups/ からバックアップを復元');
    console.log('   3. safe-replace を使って再編集');
    process.exit(1);
  }

  console.log('\n✅ UTF-8 Guard PASSED');
}

// Run if executed directly
if (require.main === module) {
  main();
}
