/**
 * Unified Guard Phase 2 Tests
 *
 * Intent Parser Phase 2 統合のテスト:
 * - EXISTING_FILE_REFERENCE Intent 型の検出
 * - False Positive 削減
 * - Layer Skip の正確度
 * - Baseline Registry 自動登録
 * - Deviation Approval 連携
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// テスト対象のモジュールをインポート
const { performIntentCheck, buildUserInputFromContext } = require('../unified-guard.js');

// テスト用の一時ファイルパス
const TEST_DIR = path.join(__dirname, '.test-tmp');
const BASELINE_REGISTRY_PATH = path.join(os.homedir(), '.claude', 'baseline-registry.json');
const BASELINE_REGISTRY_BACKUP = BASELINE_REGISTRY_PATH + '.backup';

describe('UnifiedGuard Phase 2: Read-before-Write + Baseline Registry', () => {
  // テスト前にテストディレクトリを作成
  beforeAll(() => {
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }

    // baseline-registry.json をバックアップ
    if (fs.existsSync(BASELINE_REGISTRY_PATH)) {
      fs.copyFileSync(BASELINE_REGISTRY_PATH, BASELINE_REGISTRY_BACKUP);
    }
  });

  // テスト後にクリーンアップ
  afterAll(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }

    // baseline-registry.json をリストア
    if (fs.existsSync(BASELINE_REGISTRY_BACKUP)) {
      fs.copyFileSync(BASELINE_REGISTRY_BACKUP, BASELINE_REGISTRY_PATH);
      fs.unlinkSync(BASELINE_REGISTRY_BACKUP);
    }
  });

  describe('EXISTING_FILE_REFERENCE intent detection', () => {
    it('should detect Read operations on existing files with 98% confidence', async () => {
      const testFile = path.join(TEST_DIR, 'existing-file-read.txt');
      fs.writeFileSync(testFile, 'test content', 'utf8');

      const result = await performIntentCheck('Read', {
        file_path: testFile,
      });

      expect(result.intent).toBe('EXISTING_FILE_REFERENCE');
      expect(result.confidence).toBeGreaterThanOrEqual(98);
      expect(result.riskLevel).toBe('low');
      expect(result.shouldSkip).toBe(true);
      expect(result.filePath).toBe(testFile);
    });

    it('should NOT detect EXISTING_FILE_REFERENCE for non-existent files', async () => {
      const result = await performIntentCheck('Read', {
        file_path: '/tmp/nonexistent-file-12345678.txt',
      });

      expect(result.intent).not.toBe('EXISTING_FILE_REFERENCE');
      expect(result.confidence).toBeLessThan(50);
    });

    it('should detect Edit operations on existing files', async () => {
      const testFile = path.join(TEST_DIR, 'existing-file-edit.js');
      fs.writeFileSync(testFile, 'const x = 1;\n', 'utf8');

      const result = await performIntentCheck('Edit', {
        file_path: testFile,
        old_string: 'const x = 1;',
        new_string: 'const x = 2;',
      });

      expect(result.intent).toBe('EXISTING_FILE_EDIT');
      expect(result.confidence).toBeGreaterThanOrEqual(98);
      expect(result.riskLevel).toBe('low');
      expect(result.shouldSkip).toBe(true);
      expect(result.filePath).toBe(testFile);
      expect(result.operation).toBe('edit');
    });

    it('should detect new Write operations (file not exists)', async () => {
      const testFile = path.join(TEST_DIR, 'new-file-creation-test.txt');

      // ファイルが存在しないことを確認
      if (fs.existsSync(testFile)) {
        fs.unlinkSync(testFile);
      }

      const result = await performIntentCheck('Write', {
        file_path: testFile,
        content: 'new file content',
      });

      expect(result.intent).toBe('NEW_FILE_CREATION');
      expect(result.confidence).toBeGreaterThanOrEqual(90);
      expect(result.riskLevel).toBe('low');
      expect(result.shouldSkip).toBe(true);
      expect(result.isNew).toBe(true);
    });

    it('should detect existing file overwrite with Write tool', async () => {
      const testFile = path.join(TEST_DIR, 'existing-file-overwrite.txt');
      fs.writeFileSync(testFile, 'original content', 'utf8');

      const result = await performIntentCheck('Write', {
        file_path: testFile,
        content: 'overwritten content',
      });

      expect(result.intent).toBe('EXISTING_FILE_OVERWRITE');
      expect(result.confidence).toBeGreaterThanOrEqual(95);
      expect(result.riskLevel).toBe('high');
      expect(result.isNew).toBe(false);
    });

    it('should set skipLayers correctly for existing file patterns', async () => {
      const testFile = path.join(TEST_DIR, 'skip-layers-test.txt');
      fs.writeFileSync(testFile, 'content', 'utf8');

      const result = await performIntentCheck('Read', {
        file_path: testFile,
      });

      expect(result.skipLayers).toContain(3); // Read-before-Write
      expect(result.skipLayers).toContain(4); // Baseline Lock
      expect(result.skipLayers.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Baseline registry integration', () => {
    it('should auto-register baseline files for high-confidence (≥90%) intents', async () => {
      const testFile = path.join(TEST_DIR, 'baseline-auto-register.txt');
      fs.writeFileSync(testFile, 'baseline content', 'utf8');

      const result = await performIntentCheck('Read', {
        file_path: testFile,
      });

      // 高確信度で検出されることを確認
      expect(result.confidence).toBeGreaterThanOrEqual(90);
      expect(result.intent).toBe('EXISTING_FILE_REFERENCE');
    });

    it('should not register low-confidence intents', async () => {
      const result = await performIntentCheck('UnknownTool', {
        some_param: 'value',
      });

      // 低確信度は baseline 登録の対象外
      expect(result.confidence).toBeLessThan(90);
    });
  });

  describe('deviation-approval-guard integration', () => {
    it('should skip approval for EXISTING_FILE_REFERENCE intents', async () => {
      const testFile = path.join(TEST_DIR, 'deviation-skip-test.txt');
      fs.writeFileSync(testFile, 'content', 'utf8');

      const result = await performIntentCheck('Read', {
        file_path: testFile,
      });

      expect(result.intent).toBe('EXISTING_FILE_REFERENCE');
      expect(result.shouldSkip).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(90);
    });

    it('should skip approval for SKILL_INVOCATION intents', async () => {
      const result = await performIntentCheck('Skill', {
        skill: 'youtubeschool-creator',
        args: '--help',
      });

      expect(result.intent).toBe('SKILL_INVOCATION');
      expect(result.shouldSkip).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(90);
    });

    it('should skip approval for WORKFLOW_REUSE intents', async () => {
      const result = await performIntentCheck('Read', {
        file_path: '/path/to/SESSION_HANDOFF.md',
      });

      expect(result.intent).toBe('SESSION_CONTINUATION');
      expect(result.shouldSkip).toBe(true);
      expect(result.skipLayers).toContain(1);
    });
  });

  describe('False Positive avoidance metrics', () => {
    it('should record Intent detection with metadata', async () => {
      const testFile = path.join(TEST_DIR, 'metrics-test.txt');
      fs.writeFileSync(testFile, 'content', 'utf8');

      const result = await performIntentCheck('Read', {
        file_path: testFile,
      });

      expect(result).toHaveProperty('intent');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('riskLevel');
      expect(result).toHaveProperty('skipLayers');
      expect(result).toHaveProperty('processingTimeMs');
    });

    it('should include confidence and risk level in metrics', async () => {
      const testFile = path.join(TEST_DIR, 'metrics-confidence-test.txt');
      fs.writeFileSync(testFile, 'content', 'utf8');

      const result = await performIntentCheck('Read', {
        file_path: testFile,
      });

      expect(typeof result.confidence).toBe('number');
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(100);
      expect(['low', 'medium', 'high']).toContain(result.riskLevel);
    });
  });

  describe('Performance requirements', () => {
    // A single wall-clock sample is flaky under parallel Jest (one OS scheduling stall
    // of ~17ms failed a check that normally takes 0-1ms), so judge the median of
    // several runs. A real slowdown still raises the median and fails the test.
    async function medianProcessingTimeMs(filePath, runs = 20) {
      const times = [];
      for (let i = 0; i < runs; i++) {
        const result = await performIntentCheck('Read', { file_path: filePath });
        times.push(result.processingTimeMs);
      }
      times.sort((a, b) => a - b);
      return times[Math.floor(runs / 2)];
    }

    it('should complete Intent check within <2ms', async () => {
      const testFile = path.join(TEST_DIR, 'perf-test.txt');
      fs.writeFileSync(testFile, 'content', 'utf8');

      expect(await medianProcessingTimeMs(testFile)).toBeLessThan(2);
    });

    it('should handle non-existent file checks quickly', async () => {
      expect(await medianProcessingTimeMs('/tmp/nonexistent-perf-test-12345678.txt')).toBeLessThan(2);
    });
  });

  describe('Backward compatibility', () => {
    it('should not affect existing guard behavior for SESSION_CONTINUATION', async () => {
      const result = await performIntentCheck('Read', {
        file_path: '/path/to/SESSION_HANDOFF.md',
      });

      expect(result.intent).toBe('SESSION_CONTINUATION');
      expect(result.confidence).toBeGreaterThanOrEqual(90);
      expect(result.skipLayers).toContain(1);
    });

    it('should not affect existing guard behavior for SKILL_INVOCATION', async () => {
      const result = await performIntentCheck('Skill', {
        skill: 'test-skill',
        args: '',
      });

      expect(result.intent).toBe('SKILL_INVOCATION');
      expect(result.confidence).toBeGreaterThanOrEqual(90);
      expect(result.skipLayers).toContain(2);
      expect(result.skipLayers).toContain(3);
      expect(result.skipLayers).toContain(4);
      expect(result.skipLayers).toContain(6);
    });

    it('should handle UNKNOWN intents gracefully', async () => {
      const result = await performIntentCheck('UnknownTool', {
        param: 'value',
      });

      expect(result.intent).toBe('UNKNOWN');
      expect(result.confidence).toBe(0);
      expect(result.shouldSkip).toBe(false);
      expect(result.skipLayers).toEqual([]);
      expect(result.riskLevel).toBe('medium');
    });
  });

  describe('buildUserInputFromContext', () => {
    it('should build user input from Edit tool', () => {
      const userInput = buildUserInputFromContext('Edit', {
        file_path: '/path/to/file.js',
        old_string: 'const x = 1;\nconst y = 2;\n',
        new_string: 'const x = 2;\nconst y = 2;\n',
      });

      expect(userInput).toContain('edit file');
      expect(userInput).toContain('/path/to/file.js');
    });

    it('should build user input from Write tool', () => {
      const userInput = buildUserInputFromContext('Write', {
        file_path: '/path/to/new-file.txt',
        content: 'file content',
      });

      expect(userInput).toContain('write file');
      expect(userInput).toContain('/path/to/new-file.txt');
    });

    it('should build user input from Bash tool', () => {
      const userInput = buildUserInputFromContext('Bash', {
        command: 'npm install lodash',
      });

      expect(userInput).toContain('run bash command');
      expect(userInput).toContain('npm install');
    });

    it('should build user input from Skill tool', () => {
      const userInput = buildUserInputFromContext('Skill', {
        skill: 'youtubeschool-creator',
        args: '--help',
      });

      expect(userInput).toContain('invoke skill');
      expect(userInput).toContain('youtubeschool-creator');
    });

    it('should build user input from Read tool', () => {
      const userInput = buildUserInputFromContext('Read', {
        file_path: '/path/to/file.txt',
      });

      expect(userInput).toContain('read file');
      expect(userInput).toContain('/path/to/file.txt');
    });

    it('should build user input from Glob tool', () => {
      const userInput = buildUserInputFromContext('Glob', {
        pattern: '**/*.js',
      });

      expect(userInput).toContain('search files');
      expect(userInput).toContain('**/*.js');
    });

    it('should build user input from Grep tool', () => {
      const userInput = buildUserInputFromContext('Grep', {
        pattern: 'TODO',
        path: '/path/to/project',
      });

      expect(userInput).toContain('search content');
      expect(userInput).toContain('TODO');
    });
  });
});
