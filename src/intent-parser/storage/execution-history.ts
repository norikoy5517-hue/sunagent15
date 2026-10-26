/**
 * Execution History Storage
 *
 * 実行履歴をJSONL形式で永続化
 * バッファリング（30秒 or 100件でフラッシュ）
 * ログローテーション（1MB上限）
 */

import * as fs from 'fs';
import * as path from 'path';
import { ExecutionRecord } from '../types';

const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', '..', '.claude', 'hooks', 'data');
const DEFAULT_FILE_NAME = 'execution-history.jsonl';
const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024; // 1MB
const FLUSH_INTERVAL_MS = 30_000; // 30秒
const FLUSH_BATCH_SIZE = 100;

export class ExecutionHistory {
  private readonly filePath: string;
  private buffer: ExecutionRecord[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;
  // Parsed file cache keyed by mtime+size: predict() reads history on every call, and
  // re-parsing the whole JSONL (up to 1MB) each time made it O(file size) per prediction.
  private fileCache: { mtimeMs: number; size: number; records: ExecutionRecord[] } | null = null;

  constructor(dataDir?: string) {
    const dir = dataDir || DEFAULT_DATA_DIR;
    this.filePath = path.join(dir, DEFAULT_FILE_NAME);
  }

  private ensureDir(): void {
    if (this.initialized) return;
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.initialized = true;
  }

  record(entry: ExecutionRecord): void {
    this.buffer.push(entry);

    if (this.buffer.length >= FLUSH_BATCH_SIZE) {
      this.flush();
      return;
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.buffer.length === 0) return;

    this.ensureDir();
    this.rotateIfNeeded();

    const lines = this.buffer.map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.appendFileSync(this.filePath, lines, 'utf8');
    this.buffer = [];
  }

  private rotateIfNeeded(): void {
    if (!fs.existsSync(this.filePath)) return;

    const stats = fs.statSync(this.filePath);
    if (stats.size < MAX_FILE_SIZE_BYTES) return;

    const rotatedPath = this.filePath + '.old';
    if (fs.existsSync(rotatedPath)) {
      fs.unlinkSync(rotatedPath);
    }
    fs.renameSync(this.filePath, rotatedPath);
  }

  loadAll(): ExecutionRecord[] {
    if (!fs.existsSync(this.filePath)) return [];

    // Re-parse only when the file changed (appends from any process change size/mtime)
    const stat = fs.statSync(this.filePath);
    if (this.fileCache && this.fileCache.mtimeMs === stat.mtimeMs && this.fileCache.size === stat.size) {
      return this.fileCache.records.slice();
    }

    const content = fs.readFileSync(this.filePath, 'utf8').trim();
    const records: ExecutionRecord[] = [];
    for (const line of content ? content.split('\n') : []) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as ExecutionRecord);
      } catch {
        // 破損行はスキップ
      }
    }
    this.fileCache = { mtimeMs: stat.mtimeMs, size: stat.size, records };
    return records.slice();
  }

  loadRecent(count: number): ExecutionRecord[] {
    const all = this.loadAll();
    return all.slice(-count);
  }

  count(): number {
    if (!fs.existsSync(this.filePath)) return this.buffer.length;

    const content = fs.readFileSync(this.filePath, 'utf8');
    const fileCount = content.split('\n').filter((l) => l.trim()).length;
    return fileCount + this.buffer.length;
  }

  get pendingCount(): number {
    return this.buffer.length;
  }

  get path(): string {
    return this.filePath;
  }

  destroy(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.buffer = [];
  }
}

let historyInstance: ExecutionHistory | null = null;

export function getExecutionHistory(dataDir?: string): ExecutionHistory {
  if (!historyInstance) {
    historyInstance = new ExecutionHistory(dataDir);
  }
  return historyInstance;
}

export function resetExecutionHistory(): void {
  if (historyInstance) {
    historyInstance.destroy();
    historyInstance = null;
  }
}
