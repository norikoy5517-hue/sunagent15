/**
 * Workflow State Store
 * Handles .workflow_state.json persistence with UTF-8 safety
 */

import * as fs from 'fs';
import * as path from 'path';
import type { WorkflowState } from './types';

const STATE_FILE = '.workflow_state.json';
let stateDirectory = process.cwd();

/**
 * Set custom state directory (for testing)
 */
export function setStateDir(dir: string): void {
  stateDirectory = dir;
}

/**
 * Reset state directory to default (for testing cleanup)
 */
export function resetStateDir(): void {
  stateDirectory = process.cwd();
}

/**
 * Get the state file path (project root or custom directory)
 */
function getStateFilePath(): string {
  return path.join(stateDirectory, STATE_FILE);
}

/**
 * Load workflow state from .workflow_state.json
 * Returns null if file doesn't exist
 */
export function loadState(): WorkflowState | null {
  const filePath = getStateFilePath();

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const state = JSON.parse(content) as WorkflowState;
    return state;
  } catch (error) {
    const err = error as Error;
    throw new Error(`Failed to load workflow state: ${err.message}`, { cause: error });
  }
}

/**
 * Save workflow state to .workflow_state.json (atomic write)
 */
export function saveState(state: WorkflowState): void {
  const filePath = getStateFilePath();
  // Use unique temp file name to avoid race conditions in parallel tests
  const uniqueId = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tmpPath = `${filePath}.${uniqueId}.tmp`;

  try {
    // Update timestamp
    state.lastUpdatedAt = new Date().toISOString();

    // Write to temp file first (atomic)
    const content = JSON.stringify(state, null, 2);
    fs.writeFileSync(tmpPath, content, 'utf-8');

    // Rename (atomic on POSIX, near-atomic on Windows)
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    // Cleanup temp file on error
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch (_cleanupError) {
      // Ignore cleanup errors (file may have been deleted by another test)
    }

    const err = error as Error;
    throw new Error(`Failed to save workflow state: ${err.message}`, { cause: error });
  }
}

/**
 * Clear workflow state (delete .workflow_state.json)
 * Note: Temp files are not cleaned up here to avoid race conditions in parallel tests.
 * They will be cleaned up automatically by the OS or can be removed manually.
 */
export function clearState(): void {
  const filePath = getStateFilePath();

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    // Ignore ENOENT errors (file already deleted by another test)
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Check if workflow state exists
 */
export function hasState(): boolean {
  const filePath = getStateFilePath();
  return fs.existsSync(filePath);
}
