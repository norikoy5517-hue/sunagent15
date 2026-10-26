/**
 * Filesystem helpers that tolerate transient Windows errors.
 *
 * On Windows, antivirus / search indexer briefly holding a freshly written file makes
 * rename fail with EPERM / EACCES / EBUSY (the same case graceful-fs retries). The
 * atomic tmp-file + rename writes in this repo hit it under load.
 *
 * Usage:
 *   import { renameSyncWithRetry } from '../utils/fs-retry';
 *   renameSyncWithRetry(tmpPath, targetPath);
 */

import * as fs from 'fs';

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const MAX_ATTEMPTS = 10;

/**
 * fs.renameSync with retry for transient Windows errors.
 * Other platforms and other error codes throw immediately (no behavior change).
 */
export function renameSyncWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || !RETRY_CODES.has(code) || attempt >= MAX_ATTEMPTS) {
        throw error;
      }
      // Synchronous backoff (10ms, 20ms, ... up to ~450ms total)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 10);
    }
  }
}
