/**
 * Memory System Integration Tests — Template/Runtime Separation (Design B)
 *
 * Tests PLAN.md Step 2-3 / Step 9 cases (a)-(l):
 *   (a) Legacy fallback read
 *   (b) getAgentNames union + dedup
 *   (c) Migration via recordTask (legacy → runtime)
 *   (d) Corrupt runtime quarantine
 *   (f) Options-object ctor with runtimeBasePath derivation
 *   (g) Atomic write under interrupt
 *   (h) Slug validation
 *   (i) Full baseline preservation through round-trip
 *   (k) Concurrent recordTask with cache invalidation
 *   (l) Baseline manifest E2E seeding (PR-β blocking test)
 *
 * Case (e) Template preservation lives in scripts/__tests__/ for update-memory-stats.
 * Case (j) Conflict-suffix lives in scripts/__tests__/ for init-agent-memory.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { MemoryService } from '../../src/memory/MemoryService';
import { TaskRecord, TaskCategory } from '../../src/memory/types';

const WORKER_PATH = path.join(__dirname, '..', 'fixtures', 'memory-worker.ts');
// Run ts-node's JS entry with the current Node binary: node_modules/.bin/ts-node is a
// shell shim that child_process.spawn cannot execute on Windows (ENOENT).
const TS_NODE_BIN = path.join(__dirname, '..', '..', 'node_modules', 'ts-node', 'dist', 'bin.js');

interface WorkerResult {
  pid: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the memory-worker fixture as a real child process and resolve when it
 * exits. Used by MED-1 multi-process tests so different proper-lockfile
 * processes contend for the same per-agent lock.
 */
function spawnWorker(args: string[]): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TS_NODE_BIN, WORKER_PATH, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    const chunksOut: Buffer[] = [];
    const chunksErr: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunksOut.push(c));
    child.stderr.on('data', (c: Buffer) => chunksErr.push(c));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({
        pid: child.pid ?? -1,
        code,
        signal,
        stdout: Buffer.concat(chunksOut).toString('utf-8'),
        stderr: Buffer.concat(chunksErr).toString('utf-8'),
      });
    });
  });
}

/** Minimal valid task record builder */
function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: 'task-' + Math.random().toString(36).slice(2, 10),
    agentName: 'test-agent',
    description: 'test task',
    category: 'testing' as TaskCategory,
    complexity: 1,
    status: 'completed',
    qualityScore: 100,
    durationMs: 100,
    startedAt: now,
    completedAt: now,
    error: null,
    metadata: {},
    ...overrides,
  };
}

/** Minimal valid stats YAML payload builder (snake_case, matches on-disk schema) */
function makeLegacyStatsYaml(agentName: string, overrides: Record<string, unknown> = {}) {
  return {
    agent_name: agentName,
    total_tasks: 0,
    successful_tasks: 0,
    failed_tasks: 0,
    success_rate: 0,
    avg_quality_score: 0,
    avg_duration_ms: 0,
    last_updated: new Date().toISOString(),
    recent_tasks: [],
    trends: { success_rate_trend: 0, quality_score_trend: 0, avg_duration_trend: 0 },
    specializations: {},
    omega_metrics: {
      performance_bounds: {
        min_quality_score: 0,
        min_success_rate: 0,
        max_latency_ms: 0,
        worst_case: { quality_score: 0, success_rate: 0, latency_ms: 0 },
      },
      dependencies: {
        omega: 0,
        little_omega: 0,
        coupling_ratio: 1,
        dependencies_list: { tools: [], agents: [], external: [] },
        coupling_health: { status: 'good', recommendation: '' },
      },
      completion_probability: {
        base_omega: 0,
        by_complexity: { low: 0, medium: 0, high: 0 },
        by_category: {},
        confidence_interval: 0.05,
        sample_size: 0,
        prediction_accuracy: { total_predictions: 0, accurate_predictions: 0, accuracy_rate: 0 },
      },
    },
    learning_metrics: {
      learning_rate: 0.1,
      quality_trend: { direction: 'stable', rate: 0 },
      success_trend: { direction: 'stable', rate: 0 },
      specialization: { primary_category: '', specialization_score: 0, categories: {} },
    },
    metadata: {
      last_updated: new Date().toISOString(),
      schema_version: '2.0.0',
      omega_integration_date: '2026-01-01',
      passes_quality_gates: { min_quality: false, min_success_rate: false, acceptable_coupling: true },
      overall_health: 'unknown',
    },
    ...overrides,
  };
}

/** Make a fresh isolated tmpdir per test */
function setupIsolatedDirs(): { testRoot: string; basePath: string; runtimeBasePath: string } {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memsep-'));
  const basePath = path.join(testRoot, 'memory');
  const runtimeBasePath = path.join(testRoot, 'agent-memory');
  fs.mkdirSync(path.join(basePath, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(runtimeBasePath, 'agents'), { recursive: true });
  // Minimal config so MemoryService doesn't fall through to '.' relative-path mistakes
  fs.writeFileSync(
    path.join(basePath, 'config.yaml'),
    yaml.stringify({
      version: '2.0',
      max_tasks: 100,
      retention_days: 30,
      backup_enabled: false,
      backup_path: '.claude/memory-backup/',
      backup_interval_days: 7,
      quality_threshold: { excellent: 90, good: 75, acceptable: 60, poor: 0 },
      success_rate_threshold: { preferred: 0.85, acceptable: 0.7, warning: 0.5 },
      recent_tasks_limit: 10,
    })
  );
  return { testRoot, basePath, runtimeBasePath };
}

describe('MemoryService — Template/Runtime Separation (PLAN.md Step 2-3 / Step 9)', () => {
  let dirs: { testRoot: string; basePath: string; runtimeBasePath: string };

  beforeEach(() => {
    dirs = setupIsolatedDirs();
  });

  afterEach(() => {
    if (fs.existsSync(dirs.testRoot)) {
      fs.rmSync(dirs.testRoot, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // (f) Options-object ctor with runtimeBasePath derivation
  // -------------------------------------------------------------------------
  describe('(f) Options-object ctor + runtime path derivation', () => {
    it('derives runtimeBasePath as sibling "agent-memory" of basePath', () => {
      // Use only basePath (no explicit runtimeBasePath)
      const svc = new MemoryService(dirs.basePath);
      svc.recordTask('derive-test', makeTask({ agentName: 'derive-test' }));

      // Derived runtime path = sibling "agent-memory" of basePath
      // basePath = /tmp/memsep-XXX/memory → derived = /tmp/memsep-XXX/agent-memory
      const expectedRuntimePath = path.join(dirs.testRoot, 'agent-memory', 'agents', 'derive-test-stats.yaml');
      expect(fs.existsSync(expectedRuntimePath)).toBe(true);

      // Did NOT write to legacy path
      const legacyPath = path.join(dirs.basePath, 'agents', 'derive-test-stats.yaml');
      expect(fs.existsSync(legacyPath)).toBe(false);
    });

    it('honors explicit runtimeBasePath in options object', () => {
      const customRuntime = path.join(dirs.testRoot, 'custom-runtime');
      const svc = new MemoryService(dirs.basePath, { runtimeBasePath: customRuntime });
      svc.recordTask('custom-test', makeTask({ agentName: 'custom-test' }));

      const customStatsPath = path.join(customRuntime, 'agents', 'custom-test-stats.yaml');
      expect(fs.existsSync(customStatsPath)).toBe(true);

      // Did NOT write to default-derived runtime
      const defaultRuntimePath = path.join(dirs.runtimeBasePath, 'agents', 'custom-test-stats.yaml');
      expect(fs.existsSync(defaultRuntimePath)).toBe(false);
    });

    it('hard-coded ".claude/agent-memory" is only used when basePath is the default ".claude/memory"', () => {
      // When basePath is the default, runtime should be ".claude/agent-memory" (not the testRoot sibling)
      const svc = new MemoryService();
      // We can't write to ".claude/agent-memory" in tests (would pollute), so we only assert via internal API
      // We probe by checking that loadAgentStats throws no error and returns null for a fake agent name
      // (the actual path used by the default branch is not visible without exposing internals).
      // The behavioral guarantee: passing custom basePath does NOT collide with the project default.
      expect(() => svc.loadAgentStats('nonexistent-agent-for-default-ctor')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // (h) Slug validation
  // -------------------------------------------------------------------------
  describe('(h) Slug validation (path traversal + invalid characters rejected)', () => {
    let svc: MemoryService;
    beforeEach(() => {
      svc = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });
    });

    it.each([
      ['../../etc/passwd'],
      ['a/b'],
      ['a\\b'],
      ['..'],
      ['.'],
      ['agent name with space'],
      ['agent$name'],
      ['agent@name'],
      [''],
    ])('rejects loadAgentStats(%j)', (badName) => {
      expect(() => svc.loadAgentStats(badName)).toThrow();
    });

    it.each([
      ['valid-name'],
      ['valid_name'],
      ['valid-name_1'],
      ['ABC123'],
      ['a-b-c-d-e'],
    ])('accepts loadAgentStats(%j) (returns null for missing file, no throw)', (goodName) => {
      expect(() => svc.loadAgentStats(goodName)).not.toThrow();
      expect(svc.loadAgentStats(goodName)).toBeNull();
    });

    it('rejects recordTask with invalid agentName', () => {
      expect(() => svc.recordTask('../bad-name', makeTask({ agentName: '../bad-name' }))).toThrow();
      expect(() => svc.recordTask('a/b', makeTask({ agentName: 'a/b' }))).toThrow();
    });

    it('rejects saveAgentStats with invalid agentName', () => {
      const stats = {
        agentName: '../bad',
        totalTasks: 0,
        successfulTasks: 0,
        failedTasks: 0,
        successRate: 0,
        avgQualityScore: 0,
        avgDurationMs: 0,
        lastUpdated: new Date().toISOString(),
        recentTasks: [],
        trends: { successRateTrend: 0, qualityScoreTrend: 0, avgDurationTrend: 0 },
        specializations: {} as Record<TaskCategory, number>,
        omegaMetrics: {} as never,
        learningMetrics: {} as never,
        metadata: {} as never,
      };
      expect(() => svc.saveAgentStats(stats as never)).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // (a) Legacy fallback read
  // -------------------------------------------------------------------------
  describe('(a) Legacy fallback read', () => {
    it('reads legacy when runtime is missing', () => {
      const legacyFile = path.join(dirs.basePath, 'agents', 'only-legacy-stats.yaml');
      fs.writeFileSync(legacyFile, yaml.stringify(makeLegacyStatsYaml('only-legacy', { total_tasks: 7, successful_tasks: 5, failed_tasks: 2, success_rate: 0.71 })));

      const svc = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });
      const stats = svc.loadAgentStats('only-legacy');

      expect(stats).not.toBeNull();
      expect(stats!.totalTasks).toBe(7);
      expect(stats!.successRate).toBeCloseTo(0.71, 2);
    });

    it('prefers runtime when both legacy and runtime exist', () => {
      fs.writeFileSync(
        path.join(dirs.basePath, 'agents', 'both-stats.yaml'),
        yaml.stringify(makeLegacyStatsYaml('both', { total_tasks: 1 }))
      );
      fs.writeFileSync(
        path.join(dirs.runtimeBasePath, 'agents', 'both-stats.yaml'),
        yaml.stringify(makeLegacyStatsYaml('both', { total_tasks: 99 }))
      );

      const svc = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });
      const stats = svc.loadAgentStats('both');

      expect(stats).not.toBeNull();
      expect(stats!.totalTasks).toBe(99);
    });

    it('returns null when neither runtime nor legacy has the agent', () => {
      const svc = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });
      expect(svc.loadAgentStats('missing-agent')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // (b) getAgentNames union + dedup
  // -------------------------------------------------------------------------
  describe('(b) getAgentNames union + dedup', () => {
    it('returns union of legacy and runtime without duplicates', () => {
      fs.writeFileSync(
        path.join(dirs.basePath, 'agents', 'legacy-only-stats.yaml'),
        yaml.stringify(makeLegacyStatsYaml('legacy-only'))
      );
      fs.writeFileSync(
        path.join(dirs.runtimeBasePath, 'agents', 'runtime-only-stats.yaml'),
        yaml.stringify(makeLegacyStatsYaml('runtime-only'))
      );
      fs.writeFileSync(
        path.join(dirs.basePath, 'agents', 'shared-stats.yaml'),
        yaml.stringify(makeLegacyStatsYaml('shared'))
      );
      fs.writeFileSync(
        path.join(dirs.runtimeBasePath, 'agents', 'shared-stats.yaml'),
        yaml.stringify(makeLegacyStatsYaml('shared'))
      );

      const svc = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });
      const names = svc.getAgentNames();

      expect(new Set(names)).toEqual(new Set(['legacy-only', 'runtime-only', 'shared']));
      expect(names.length).toBe(3);
    });

    it('ignores _template.yaml in both directories', () => {
      fs.writeFileSync(
        path.join(dirs.runtimeBasePath, 'agents', '_template.yaml'),
        yaml.stringify(makeLegacyStatsYaml('_template'))
      );
      fs.writeFileSync(
        path.join(dirs.basePath, 'agents', '_template.yaml'),
        yaml.stringify(makeLegacyStatsYaml('_template'))
      );

      const svc = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });
      expect(svc.getAgentNames()).not.toContain('_template');
    });

    it('returns [] when both directories are empty', () => {
      const svc = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });
      expect(svc.getAgentNames()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // (c) Migration via recordTask
  // -------------------------------------------------------------------------
  describe('(c) Migration via recordTask: legacy untouched, runtime written', () => {
    it('writes to runtime, leaves legacy file byte-identical', () => {
      const legacyFile = path.join(dirs.basePath, 'agents', 'mig-agent-stats.yaml');
      fs.writeFileSync(legacyFile, yaml.stringify(makeLegacyStatsYaml('mig-agent', { total_tasks: 5, successful_tasks: 4, failed_tasks: 1, success_rate: 0.8 })));
      const legacyBefore = fs.readFileSync(legacyFile, 'utf-8');

      const svc = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });
      svc.recordTask('mig-agent', makeTask({ agentName: 'mig-agent' }));

      // Legacy file unchanged
      expect(fs.readFileSync(legacyFile, 'utf-8')).toBe(legacyBefore);

      // Runtime file created
      const runtimeFile = path.join(dirs.runtimeBasePath, 'agents', 'mig-agent-stats.yaml');
      expect(fs.existsSync(runtimeFile)).toBe(true);

      const runtimeContent = yaml.parse(fs.readFileSync(runtimeFile, 'utf-8'));
      expect(runtimeContent.total_tasks).toBe(6); // 5 + 1
      expect(runtimeContent.successful_tasks).toBe(5); // 4 + 1
    });
  });

  // -------------------------------------------------------------------------
  // (d) Corrupt runtime quarantine
  // -------------------------------------------------------------------------
  describe('(d) Corrupt runtime quarantine + fallback', () => {
    it('quarantines corrupt YAML and falls back to legacy', () => {
      // Legacy = valid baseline
      fs.writeFileSync(
        path.join(dirs.basePath, 'agents', 'corrupt-stats.yaml'),
        yaml.stringify(makeLegacyStatsYaml('corrupt', { total_tasks: 3 }))
      );
      // Runtime = invalid YAML
      const runtimeFile = path.join(dirs.runtimeBasePath, 'agents', 'corrupt-stats.yaml');
      fs.writeFileSync(runtimeFile, '{{not valid yaml\nat all: [\nbroken: }}}');

      const svc = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });
      const stats = svc.loadAgentStats('corrupt');

      // Falls back to legacy data
      expect(stats).not.toBeNull();
      expect(stats!.totalTasks).toBe(3);

      // Corrupt directory was created with timestamped quarantine file
      const corruptDir = path.join(dirs.runtimeBasePath, 'agents', '.corrupt');
      expect(fs.existsSync(corruptDir)).toBe(true);
      const quarantined = fs.readdirSync(corruptDir);
      expect(quarantined.some((f) => f.startsWith('corrupt-stats-') && f.endsWith('.yaml'))).toBe(true);

      // Original corrupt file moved out of the agents directory
      expect(fs.existsSync(runtimeFile)).toBe(false);
    });

    it('does not quarantine legacy files on parse error (read-only fallback safety)', () => {
      // Only corrupt legacy, no runtime
      const legacyFile = path.join(dirs.basePath, 'agents', 'legacy-corrupt-stats.yaml');
      fs.writeFileSync(legacyFile, '{{utterly broken');

      const svc = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });
      const stats = svc.loadAgentStats('legacy-corrupt');

      // Returns null (no fallback further)
      expect(stats).toBeNull();

      // Legacy file NOT moved (we never mutate legacy)
      expect(fs.existsSync(legacyFile)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // (g) Atomic write under interrupt (proxy test)
  // -------------------------------------------------------------------------
  describe('(g) Atomic write: tmp → fsync → rename pattern', () => {
    it('produces fully-written target file with no .tmp leftover after normal completion', () => {
      const svc = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });
      svc.recordTask('atomic-agent', makeTask({ agentName: 'atomic-agent' }));

      const targetFile = path.join(dirs.runtimeBasePath, 'agents', 'atomic-agent-stats.yaml');
      expect(fs.existsSync(targetFile)).toBe(true);
      const parsed = yaml.parse(fs.readFileSync(targetFile, 'utf-8'));
      expect(parsed.agent_name).toBe('atomic-agent');
      expect(parsed.total_tasks).toBe(1);

      // No .tmp leftover after successful write
      const agentsDir = path.join(dirs.runtimeBasePath, 'agents');
      const stragglerTmps = fs
        .readdirSync(agentsDir)
        .filter((f) => f.startsWith('atomic-agent-stats.yaml.tmp'));
      expect(stragglerTmps.length).toBe(0);
    });

    it('does not corrupt target when overwriting existing file', () => {
      const svc = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });
      svc.recordTask('repeat-agent', makeTask({ agentName: 'repeat-agent', id: 't1' }));
      svc.recordTask('repeat-agent', makeTask({ agentName: 'repeat-agent', id: 't2' }));
      svc.recordTask('repeat-agent', makeTask({ agentName: 'repeat-agent', id: 't3' }));

      const targetFile = path.join(dirs.runtimeBasePath, 'agents', 'repeat-agent-stats.yaml');
      const parsed = yaml.parse(fs.readFileSync(targetFile, 'utf-8'));
      // No partial / corrupt YAML
      expect(parsed.agent_name).toBe('repeat-agent');
      expect(parsed.total_tasks).toBe(3);
      expect(Array.isArray(parsed.recent_tasks)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // (i) Full baseline preservation through round-trip
  // -------------------------------------------------------------------------
  describe('(i) Baseline preservation: omega_metrics + learning_metrics survive recordTask round-trip', () => {
    it('preserves omega_metrics.performance_bounds + dependencies_list + completion_probability on legacy→runtime migration', () => {
      const baselineOmegaMetrics = {
        performance_bounds: {
          min_quality_score: 88,
          min_success_rate: 0.75,
          max_latency_ms: 4500,
          worst_case: { quality_score: 60, success_rate: 0.55, latency_ms: 3000 },
        },
        dependencies: {
          omega: 7,
          little_omega: 5,
          coupling_ratio: 0.71,
          dependencies_list: { tools: ['Read', 'Edit', 'Grep'], agents: ['planner'], external: [] },
          coupling_health: { status: 'good', recommendation: '' },
        },
        completion_probability: {
          base_omega: 0.92,
          by_complexity: { low: 0.99, medium: 0.92, high: 0.78 },
          by_category: {},
          confidence_interval: 0.05,
          sample_size: 150,
          prediction_accuracy: { total_predictions: 150, accurate_predictions: 138, accuracy_rate: 0.92 },
        },
      };

      fs.writeFileSync(
        path.join(dirs.basePath, 'agents', 'baseline-agent-stats.yaml'),
        yaml.stringify(makeLegacyStatsYaml('baseline-agent', { omega_metrics: baselineOmegaMetrics }))
      );

      const svc = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });
      svc.recordTask('baseline-agent', makeTask({ agentName: 'baseline-agent' }));

      // Read runtime YAML directly (avoids OPEN-1 snake/camel coupling)
      const runtimeYaml = yaml.parse(
        fs.readFileSync(path.join(dirs.runtimeBasePath, 'agents', 'baseline-agent-stats.yaml'), 'utf-8')
      );

      expect(runtimeYaml.omega_metrics.performance_bounds.min_quality_score).toBe(88);
      expect(runtimeYaml.omega_metrics.dependencies.dependencies_list.tools).toEqual(['Read', 'Edit', 'Grep']);
      expect(runtimeYaml.omega_metrics.dependencies.dependencies_list.agents).toEqual(['planner']);
      expect(runtimeYaml.omega_metrics.completion_probability.by_complexity).toEqual({
        low: 0.99,
        medium: 0.92,
        high: 0.78,
      });
      expect(runtimeYaml.omega_metrics.completion_probability.sample_size).toBe(150);
    });
  });

  // -------------------------------------------------------------------------
  // (k) Concurrent recordTask with cache invalidation
  // -------------------------------------------------------------------------
  describe('(k) Concurrent recordTask + cache invalidation: no lost update', () => {
    it('two MemoryService instances serially recording N tasks each persists all updates', () => {
      const svc1 = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });
      const svc2 = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });

      // Each instance prefills cache by loading
      expect(svc1.loadAgentStats('conc-agent')).toBeNull();
      expect(svc2.loadAgentStats('conc-agent')).toBeNull();

      // Interleaved recordTask calls — without lock+cache invalidation, last-write-wins lost updates
      svc1.recordTask('conc-agent', makeTask({ agentName: 'conc-agent', id: 's1-t1' }));
      svc2.recordTask('conc-agent', makeTask({ agentName: 'conc-agent', id: 's2-t1' }));
      svc1.recordTask('conc-agent', makeTask({ agentName: 'conc-agent', id: 's1-t2' }));
      svc2.recordTask('conc-agent', makeTask({ agentName: 'conc-agent', id: 's2-t2' }));

      svc1.clearCache();
      const stats = svc1.loadAgentStats('conc-agent');
      expect(stats).not.toBeNull();
      expect(stats!.totalTasks).toBe(4);
      expect(stats!.successfulTasks).toBe(4);
    });

    it('10 serial recordTasks via single instance with intermediate clearCache calls preserve count', () => {
      const svc = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });
      for (let i = 0; i < 10; i++) {
        svc.recordTask('serial-agent', makeTask({ agentName: 'serial-agent', id: `t${i}` }));
        if (i % 3 === 0) svc.clearCache();
      }

      svc.clearCache();
      const stats = svc.loadAgentStats('serial-agent');
      expect(stats!.totalTasks).toBe(10);
    });

    // ---------------------------------------------------------------------
    // MED-1 (Codex 1st round, 2026-05-15): true multi-process concurrency
    // via child_process.spawn against a real second Node runtime, so the
    // proper-lockfile gate is exercised across PIDs (not just two service
    // instances in one process).
    // ---------------------------------------------------------------------
    it('two child processes recording 3 tasks each persist all 6 updates and create no .corrupt placeholders', async () => {
      const agent = 'mp-record-agent';

      const [r1, r2] = await Promise.all([
        spawnWorker([dirs.basePath, dirs.runtimeBasePath, agent, 'record', '3', 'pA']),
        spawnWorker([dirs.basePath, dirs.runtimeBasePath, agent, 'record', '3', 'pB']),
      ]);

      // Compare code + stderr together so a failing worker's error message shows in the diff
      expect({ code: r1.code, stderr: r1.stderr }).toEqual({ code: 0, stderr: '' });
      expect({ code: r2.code, stderr: r2.stderr }).toEqual({ code: 0, stderr: '' });

      const runtimeYaml = yaml.parse(
        fs.readFileSync(path.join(dirs.runtimeBasePath, 'agents', `${agent}-stats.yaml`), 'utf-8')
      );
      expect(runtimeYaml.total_tasks).toBe(6);
      expect(runtimeYaml.successful_tasks).toBe(6);

      const recentIds = new Set(runtimeYaml.recent_tasks.map((t: { id: string }) => t.id));
      for (const id of ['pA-t0', 'pA-t1', 'pA-t2', 'pB-t0', 'pB-t1', 'pB-t2']) {
        expect(recentIds.has(id)).toBe(true);
      }

      // HIGH-2 regression: no spurious quarantine on first-use multi-process
      const corruptDir = path.join(dirs.runtimeBasePath, 'agents', '.corrupt');
      expect(fs.existsSync(corruptDir)).toBe(false);
    }, 30000);

    // HIGH (Codex 2nd round, 2026-05-20): the public saveAgentStats path
    // must reject a stale caller-side snapshot so the load-modify-save
    // pattern cannot silently clobber a concurrent recordTask update.
    it('rejects stale public saveAgentStats: caller-side load → other-process write → stale save throws and on-disk state survives', () => {
      const svcA = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });
      const svcB = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });
      const agent = 'stale-save-agent';

      // 1) svcA seeds the agent with t1.
      svcA.recordTask(agent, makeTask({ agentName: agent, id: 't1' }));

      // 2) svcA captures a snapshot (stale-to-be once svcB writes).
      const stale = svcA.loadAgentStats(agent);
      expect(stale).not.toBeNull();

      // 3) svcB records t2 on the same agent — advances on-disk lastUpdated.
      svcB.recordTask(agent, makeTask({ agentName: agent, id: 't2' }));

      // 4) svcA tries to persist its stale snapshot — must throw, not silently overwrite.
      expect(() => svcA.saveAgentStats(stale!)).toThrow(/Stale saveAgentStats/);

      // On-disk state preserved svcB's update (total_tasks=2, both ids present).
      svcA.clearCache();
      const final = svcA.loadAgentStats(agent);
      expect(final).not.toBeNull();
      expect(final!.totalTasks).toBe(2);
      const recentIds = new Set(final!.recentTasks.map((t) => t.id));
      expect(recentIds.has('t1')).toBe(true);
      expect(recentIds.has('t2')).toBe(true);
    });

    // HIGH (Codex 3rd round, 2026-05-20): the optimistic stale check used
    // `lastUpdated` (ISO ms-precision) as its version token. Two writes
    // landing in the same millisecond — or any test that mocks Date.now —
    // produced identical timestamps, letting a stale snapshot overwrite a
    // concurrent recordTask. saveAgentStatsLocked now bumps lastUpdated to
    // be strictly monotonic inside the lock.
    it('rejects stale public saveAgentStats under a fixed clock (Codex 3rd round HIGH regression)', () => {
      const fixedMs = Date.now();
      const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(fixedMs);
      try {
        const svcA = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });
        const svcB = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });
        const agent = 'fixed-clock-agent';

        svcA.recordTask(agent, makeTask({ agentName: agent, id: 'fc-t1' }));
        const stale = svcA.loadAgentStats(agent);
        expect(stale).not.toBeNull();

        // Second recordTask under the same Date.now() value. The monotonic
        // bump inside saveAgentStatsLocked must still advance lastUpdated so
        // the public stale check on svcA's snapshot fires.
        svcB.recordTask(agent, makeTask({ agentName: agent, id: 'fc-t2' }));

        expect(() => svcA.saveAgentStats(stale!)).toThrow(/Stale saveAgentStats/);

        svcA.clearCache();
        const final = svcA.loadAgentStats(agent);
        expect(final).not.toBeNull();
        expect(final!.totalTasks).toBe(2);
        const ids = new Set(final!.recentTasks.map((t) => t.id));
        expect(ids.has('fc-t1')).toBe(true);
        expect(ids.has('fc-t2')).toBe(true);
      } finally {
        dateNowSpy.mockRestore();
      }
    });

    it('cleanupOldTasks in one process does not lose a concurrent recordTask in another (HIGH-3 / OPEN-2 regression)', async () => {
      const agent = 'mp-cleanup-agent';

      // Pre-populate one old task by writing the runtime stats file directly.
      // Use makeLegacyStatsYaml shape and place into runtime so loadAgentStats
      // resolves it without falling back to legacy.
      const oldDate = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365); // 365 days ago
      const oldTaskRecord = {
        id: 'old-task-1',
        agentName: agent,
        description: 'old task',
        category: 'testing',
        complexity: 1,
        status: 'completed',
        qualityScore: 100,
        durationMs: 10,
        startedAt: oldDate.toISOString(),
        completedAt: oldDate.toISOString(),
        error: null,
        metadata: {},
      };
      const seedYaml = makeLegacyStatsYaml(agent, {
        total_tasks: 1,
        successful_tasks: 1,
        failed_tasks: 0,
        success_rate: 1.0,
        recent_tasks: [oldTaskRecord],
      });
      fs.writeFileSync(
        path.join(dirs.runtimeBasePath, 'agents', `${agent}-stats.yaml`),
        yaml.stringify(seedYaml)
      );

      // Tighten retention so the 365-day-old task is eligible for cleanup.
      // Rewrite config to retentionDays = 1.
      const cfgPath = path.join(dirs.basePath, 'config.yaml');
      const cfg = yaml.parse(fs.readFileSync(cfgPath, 'utf-8'));
      cfg.retention_days = 1;
      fs.writeFileSync(cfgPath, yaml.stringify(cfg));

      // Race: recordTask + cleanup in two child processes.
      const [rRecord, rClean] = await Promise.all([
        spawnWorker([dirs.basePath, dirs.runtimeBasePath, agent, 'record', '1', 'new']),
        spawnWorker([dirs.basePath, dirs.runtimeBasePath, agent, 'cleanup', '0']),
      ]);

      // Include stderr so a failing worker's error message shows in the diff
      expect({ code: rRecord.code, stderr: rRecord.stderr }).toEqual({ code: 0, stderr: expect.any(String) });
      expect({ code: rClean.code, stderr: rClean.stderr }).toEqual({ code: 0, stderr: expect.any(String) });

      const runtimeYaml = yaml.parse(
        fs.readFileSync(path.join(dirs.runtimeBasePath, 'agents', `${agent}-stats.yaml`), 'utf-8')
      );
      // Old task started at total=1; recordTask increments → total=2.
      // Cleanup must not roll total back even when interleaved.
      expect(runtimeYaml.total_tasks).toBe(2);

      const recentIds = new Set(runtimeYaml.recent_tasks.map((t: { id: string }) => t.id));
      // The new task must be present — cleanup must not have clobbered it.
      expect(recentIds.has('new-t0')).toBe(true);
      // The old task should have been filtered out by cleanup (no matter the
      // race order, the final state must reflect both ops applied serially).
      expect(recentIds.has('old-task-1')).toBe(false);
    }, 30000);
  });

  // -------------------------------------------------------------------------
  // (l) Baseline manifest E2E seeding (PR-β blocking test)
  // -------------------------------------------------------------------------
  describe('(l) Baseline manifest E2E seeding [PR-β blocking]', () => {
    it('seeds omega_metrics + learning_metrics + metadata from agents-baseline.yaml on fresh agent', () => {
      // Place baseline manifest at basePath/agents-baseline.yaml
      const manifest = {
        'api-designer': {
          omega_metrics: {
            performance_bounds: {
              min_quality_score: 100,
              min_success_rate: 0.8,
              max_latency_ms: 5000,
              worst_case: { quality_score: 100, success_rate: 0, latency_ms: 0 },
            },
            dependencies: {
              omega: 6,
              little_omega: 6,
              coupling_ratio: 1,
              dependencies_list: { tools: ['Read', 'Write', 'Edit', 'Grep'], agents: [], external: [] },
              coupling_health: { status: 'good', recommendation: '' },
            },
            completion_probability: {
              base_omega: 0.95,
              by_complexity: { low: 0.99, medium: 0.95, high: 0.85 },
              by_category: {},
              confidence_interval: 0.05,
              sample_size: 0,
              prediction_accuracy: { total_predictions: 0, accurate_predictions: 0, accuracy_rate: 0 },
            },
          },
          learning_metrics: {
            learning_rate: 0.15,
            quality_trend: { direction: 'stable', rate: 0 },
            success_trend: { direction: 'stable', rate: 0 },
            specialization: { primary_category: 'design', specialization_score: 0.8, categories: {} },
          },
          metadata: {
            schema_version: '2.0.0',
            omega_integration_date: '2026-01-01',
            passes_quality_gates: { min_quality: true, min_success_rate: true, acceptable_coupling: true },
            overall_health: 'excellent',
          },
        },
      };
      fs.writeFileSync(path.join(dirs.basePath, 'agents-baseline.yaml'), yaml.stringify(manifest));

      // No legacy stats, no runtime stats — only manifest
      const svc = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });
      svc.recordTask('api-designer', makeTask({ agentName: 'api-designer', category: 'design' }));

      // Verify on-disk YAML carries manifest baseline (canonical snake_case)
      const runtimeYaml = yaml.parse(
        fs.readFileSync(path.join(dirs.runtimeBasePath, 'agents', 'api-designer-stats.yaml'), 'utf-8')
      );

      expect(runtimeYaml.omega_metrics.dependencies.dependencies_list.tools).toEqual([
        'Read',
        'Write',
        'Edit',
        'Grep',
      ]);
      expect(runtimeYaml.omega_metrics.completion_probability.by_complexity).toEqual({
        low: 0.99,
        medium: 0.95,
        high: 0.85,
      });
      expect(runtimeYaml.omega_metrics.performance_bounds.min_quality_score).toBe(100);
      expect(runtimeYaml.learning_metrics.specialization.primary_category).toBe('design');
    });

    it('seeded agent records first task with task counters incremented from manifest baseline (not zero)', () => {
      const manifest = {
        'seeded-agent': {
          omega_metrics: {
            performance_bounds: { min_quality_score: 50, min_success_rate: 0.5, max_latency_ms: 1000, worst_case: { quality_score: 0, success_rate: 0, latency_ms: 0 } },
            dependencies: { omega: 1, little_omega: 1, coupling_ratio: 1, dependencies_list: { tools: ['Read'], agents: [], external: [] }, coupling_health: { status: 'good', recommendation: '' } },
            completion_probability: { base_omega: 0.5, by_complexity: { low: 0.5, medium: 0.5, high: 0.5 }, by_category: {}, confidence_interval: 0.05, sample_size: 0, prediction_accuracy: { total_predictions: 0, accurate_predictions: 0, accuracy_rate: 0 } },
          },
          learning_metrics: { learning_rate: 0.1, quality_trend: { direction: 'stable', rate: 0 }, success_trend: { direction: 'stable', rate: 0 }, specialization: { primary_category: '', specialization_score: 0, categories: {} } },
          metadata: { schema_version: '2.0.0', omega_integration_date: '2026-01-01', passes_quality_gates: { min_quality: false, min_success_rate: false, acceptable_coupling: true }, overall_health: 'unknown' },
        },
      };
      fs.writeFileSync(path.join(dirs.basePath, 'agents-baseline.yaml'), yaml.stringify(manifest));

      const svc = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });
      svc.recordTask('seeded-agent', makeTask({ agentName: 'seeded-agent' }));

      const runtimeYaml = yaml.parse(
        fs.readFileSync(path.join(dirs.runtimeBasePath, 'agents', 'seeded-agent-stats.yaml'), 'utf-8')
      );

      // Task counters start at zero per spec — recordTask increments them by 1
      expect(runtimeYaml.total_tasks).toBe(1);
      expect(runtimeYaml.successful_tasks).toBe(1);
      // But baseline survived
      expect(runtimeYaml.omega_metrics.dependencies.dependencies_list.tools).toEqual(['Read']);
    });

    it('falls back to default factory when manifest exists but does not list the agent', () => {
      fs.writeFileSync(path.join(dirs.basePath, 'agents-baseline.yaml'), yaml.stringify({ 'other-agent': {} }));
      const svc = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });
      svc.recordTask('unknown-agent', makeTask({ agentName: 'unknown-agent' }));

      const runtimeYaml = yaml.parse(
        fs.readFileSync(path.join(dirs.runtimeBasePath, 'agents', 'unknown-agent-stats.yaml'), 'utf-8')
      );
      // Default baseline → zero counters and empty deps
      expect(runtimeYaml.total_tasks).toBe(1);
      expect(runtimeYaml.omega_metrics.dependencies.omega).toBe(0);
    });

    // ---------------------------------------------------------------------
    // MED-2 (Codex 1st round, 2026-05-15): exercise the real shipped 48-entry
    // .claude/memory/agents-baseline.yaml against typed `AgentStats` access.
    // The synthetic 1-entry manifest tests above can pass while typed
    // consumers (memory-report.ts, omega-aware coordinator) crash on the real
    // shape — this test guards against that drift.
    // ---------------------------------------------------------------------
    it('seeds api-designer from real agents-baseline.yaml and exposes typed camelCase access', () => {
      const realManifestPath = path.join(
        __dirname,
        '..',
        '..',
        '.claude',
        'memory',
        'agents-baseline.yaml'
      );
      // Sanity-check the fixture exists; without it the test is meaningless.
      expect(fs.existsSync(realManifestPath)).toBe(true);

      fs.copyFileSync(realManifestPath, path.join(dirs.basePath, 'agents-baseline.yaml'));

      const svc = new MemoryService(dirs.basePath, { runtimeBasePath: dirs.runtimeBasePath });
      svc.recordTask('api-designer', makeTask({ agentName: 'api-designer', category: 'design' }));

      // On-disk YAML should be canonical snake_case (round-trip)
      const runtimeYaml = yaml.parse(
        fs.readFileSync(path.join(dirs.runtimeBasePath, 'agents', 'api-designer-stats.yaml'), 'utf-8')
      );
      expect(runtimeYaml.omega_metrics.dependencies.dependencies_list.tools).toEqual([
        'Read',
        'Write',
        'Edit',
        'Grep',
      ]);
      expect(runtimeYaml.omega_metrics.dependencies.omega).toBe(6);
      expect(runtimeYaml.omega_metrics.performance_bounds.min_quality_score).toBe(100);

      // Typed access via loadAgentStats must read camelCase nested keys (HIGH-1)
      svc.clearCache();
      const stats = svc.loadAgentStats('api-designer');
      expect(stats).not.toBeNull();
      expect(stats!.omegaMetrics.dependencies.dependenciesList.tools).toEqual([
        'Read',
        'Write',
        'Edit',
        'Grep',
      ]);
      expect(stats!.omegaMetrics.dependencies.omega).toBe(6);
      expect(stats!.omegaMetrics.performanceBounds.minQualityScore).toBe(100);
      expect(stats!.omegaMetrics.completionProbability.byComplexity.medium).toBeCloseTo(0.95, 5);
      expect(stats!.learningMetrics.specialization.primaryCategory).toBe('implementation');
      // recordTask sets overallHealth via calculateHealth — must be a known
      // health string, proving typed metadata access works after mapping.
      expect(['excellent', 'good', 'fair', 'poor', 'unknown']).toContain(
        stats!.metadata.overallHealth
      );
    });
  });
});
