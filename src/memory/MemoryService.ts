/**
 * Memory Service for TAISUN v2
 *
 * Core service for managing agent statistics, task records, and analytics.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import * as lockfile from 'proper-lockfile';
import {
  AgentStats,
  AgentSummary,
  DailyTrend,
  ErrorPattern,
  ExportFormat,
  MemoryConfig,
  ReportType,
  SkillUsage,
  SystemStats,
  TaskCategory,
  TaskRecord,
} from './types';

/**
 * Slug regex for agent names. Matches the same pattern enforced by
 * scripts/generate-agents-baseline.js so the runtime + baseline manifest agree.
 */
const AGENT_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Options accepted by the {@link MemoryService} constructor (Design B, PLAN.md Step 2).
 *
 * @property runtimeBasePath - Per-machine runtime root. When omitted, derived as a
 *   sibling "agent-memory" directory of {@link basePath} (PLAN.md "sibling pattern").
 */
export interface MemoryServiceOptions {
  runtimeBasePath?: string;
}

/**
 * Default memory configuration
 */
const DEFAULT_CONFIG: MemoryConfig = {
  version: '2.0',
  maxTasks: 1000,
  retentionDays: 90,
  backupEnabled: true,
  backupPath: '.claude/memory-backup/',
  backupIntervalDays: 7,
  qualityThreshold: {
    excellent: 90,
    good: 75,
    acceptable: 60,
    poor: 0,
  },
  successRateThreshold: {
    preferred: 0.85,
    acceptable: 0.7,
    warning: 0.5,
  },
  recentTasksLimit: 10,
  taskTypes: [
    'implementation',
    'bug-fix',
    'refactoring',
    'testing',
    'documentation',
    'deployment',
    'optimization',
    'security',
    'integration',
    'migration',
    'analysis',
    'design',
  ],
};

/**
 * Memory Service class
 */
export class MemoryService {
  private basePath: string;
  private runtimeBasePath: string;
  private baselineManifestPath: string;
  private config: MemoryConfig;
  private agentStatsCache: Map<string, AgentStats> = new Map();
  private baselineManifestCache: Record<string, unknown> | null = null;

  /**
   * Construct a MemoryService for the given basePath and runtime root.
   *
   * - `basePath` holds the tracked layer: template, baseline manifest, and (during
   *   the soak period) legacy `*-stats.yaml` files.
   * - `opts.runtimeBasePath` holds the per-machine runtime layer. When omitted,
   *   it is derived as the sibling `agent-memory` directory of `basePath`:
   *   `.claude/memory` → `.claude/agent-memory`,
   *   `/tmp/x/memory` → `/tmp/x/agent-memory`.
   */
  constructor(basePath: string = '.claude/memory', opts: MemoryServiceOptions = {}) {
    this.basePath = basePath;
    this.runtimeBasePath = opts.runtimeBasePath ?? MemoryService.deriveRuntimeBasePath(basePath);
    this.baselineManifestPath = path.join(this.basePath, 'agents-baseline.yaml');
    this.config = this.loadConfig();
  }

  /**
   * Derive a runtime base path from a tracked base path. The runtime layer lives as
   * a sibling directory named `agent-memory`, mirroring the parent of `basePath`.
   *
   * Examples:
   *   `.claude/memory`              → `.claude/agent-memory`
   *   `/tmp/x/memory`               → `/tmp/x/agent-memory`
   *   `tests/fixtures/test-memory`  → `tests/fixtures/agent-memory`
   */
  static deriveRuntimeBasePath(basePath: string): string {
    return path.join(path.dirname(basePath), 'agent-memory');
  }

  /**
   * Validate that the given agent name is a safe slug: ASCII alphanumeric plus
   * hyphens and underscores. Throws with the offending value when invalid.
   *
   * Per PLAN.md Step 3: defends `loadAgentStats` / `saveAgentStats` / `recordTask`
   * against path-traversal and unexpected separators.
   */
  private static validateSlug(agentName: string): void {
    if (typeof agentName !== 'string' || !AGENT_NAME_REGEX.test(agentName)) {
      throw new Error(
        `Invalid agent name: ${JSON.stringify(agentName)} — must match ${AGENT_NAME_REGEX}`
      );
    }
  }

  /**
   * Resolve the stats path for an agent under a given agents directory, asserting
   * the resolved path stays inside that directory (defense-in-depth against future
   * code paths that bypass {@link validateSlug}).
   */
  private static resolveSafeStatsPath(agentsDir: string, agentName: string): string {
    MemoryService.validateSlug(agentName);
    const resolvedDir = path.resolve(agentsDir);
    const resolved = path.resolve(resolvedDir, `${agentName}-stats.yaml`);
    if (resolved !== path.join(resolvedDir, `${agentName}-stats.yaml`)) {
      throw new Error(`Stats path escapes agents directory: ${resolved}`);
    }
    return resolved;
  }

  /**
   * Load memory configuration
   */
  private loadConfig(): MemoryConfig {
    const configPath = path.join(this.basePath, 'config.yaml');

    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      const rawConfig = yaml.parse(content);

      return {
        version: rawConfig.version || DEFAULT_CONFIG.version,
        maxTasks: rawConfig.max_tasks || DEFAULT_CONFIG.maxTasks,
        retentionDays: rawConfig.retention_days || DEFAULT_CONFIG.retentionDays,
        backupEnabled: rawConfig.backup_enabled ?? DEFAULT_CONFIG.backupEnabled,
        backupPath: rawConfig.backup_path || DEFAULT_CONFIG.backupPath,
        backupIntervalDays: rawConfig.backup_interval_days || DEFAULT_CONFIG.backupIntervalDays,
        qualityThreshold: rawConfig.quality_threshold || DEFAULT_CONFIG.qualityThreshold,
        successRateThreshold: rawConfig.success_rate_threshold || DEFAULT_CONFIG.successRateThreshold,
        recentTasksLimit: rawConfig.recent_tasks_limit || DEFAULT_CONFIG.recentTasksLimit,
        taskTypes: rawConfig.task_types || DEFAULT_CONFIG.taskTypes,
      };
    }

    return DEFAULT_CONFIG;
  }

  /**
   * Return the union of agent names found in the runtime and legacy `agents/`
   * directories. Filenames that don't match the `<slug>-stats.yaml` convention
   * (including the tracked `_template.yaml` and any quarantined `.corrupt/` files)
   * are ignored.
   *
   * The product decision (PLAN.md Step 3 / Round 1 M4) is that this returns
   * agents-with-history, not the catalog of available agents.
   */
  getAgentNames(): string[] {
    const names = new Set<string>();
    const dirs = [
      path.join(this.runtimeBasePath, 'agents'),
      path.join(this.basePath, 'agents'),
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const file of entries) {
        if (!file.endsWith('-stats.yaml')) continue;
        if (file.startsWith('_') || file.startsWith('.')) continue;
        const name = file.slice(0, -'-stats.yaml'.length);
        if (!AGENT_NAME_REGEX.test(name)) continue;
        names.add(name);
      }
    }

    return Array.from(names);
  }

  /**
   * Load agent statistics.
   *
   * Read order (PLAN.md Step 3):
   *   1. Runtime `${runtimeBasePath}/agents/${name}-stats.yaml`
   *      - On parse error: quarantine to `${runtimeBasePath}/agents/.corrupt/`
   *        with an ISO timestamp suffix, then fall through to legacy.
   *   2. Legacy `${basePath}/agents/${name}-stats.yaml`
   *      - On parse error: log via console.error and return null. Legacy files
   *        are tracked in git, so we never mutate them from this code path.
   *
   * Returns the cached AgentStats on subsequent calls until {@link clearCache}
   * (or {@link recordTask}, which invalidates inside its locked path) is invoked.
   */
  loadAgentStats(agentName: string): AgentStats | null {
    MemoryService.validateSlug(agentName);

    if (this.agentStatsCache.has(agentName)) {
      return this.agentStatsCache.get(agentName)!;
    }

    const runtimePath = MemoryService.resolveSafeStatsPath(
      path.join(this.runtimeBasePath, 'agents'),
      agentName
    );
    const legacyPath = MemoryService.resolveSafeStatsPath(
      path.join(this.basePath, 'agents'),
      agentName
    );

    const fromRuntime = this.tryLoadFromFile(runtimePath, agentName, /*quarantineOnError*/ true);
    if (fromRuntime !== null) {
      this.agentStatsCache.set(agentName, fromRuntime);
      return fromRuntime;
    }

    const fromLegacy = this.tryLoadFromFile(legacyPath, agentName, /*quarantineOnError*/ false);
    if (fromLegacy !== null) {
      this.agentStatsCache.set(agentName, fromLegacy);
      return fromLegacy;
    }

    return null;
  }

  /**
   * Read a stats YAML file and project it into an {@link AgentStats}. Returns null
   * when the file is missing or unparseable. When `quarantineOnError` is set and
   * parsing fails, the offending file is moved into `.corrupt/` under the agents
   * directory with an ISO-timestamped suffix.
   */
  private tryLoadFromFile(
    statsPath: string,
    agentName: string,
    quarantineOnError: boolean
  ): AgentStats | null {
    if (!fs.existsSync(statsPath)) {
      return null;
    }

    let rawStats: Record<string, unknown>;
    try {
      const content = fs.readFileSync(statsPath, 'utf-8');
      const parsed = yaml.parse(content);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Parsed YAML root is not a mapping');
      }
      rawStats = parsed as Record<string, unknown>;
    } catch (error) {
      if (quarantineOnError) {
        this.quarantineCorruptFile(statsPath, agentName, error as Error);
      } else {
        console.error(`Failed to parse legacy stats for ${agentName}:`, error);
      }
      return null;
    }

    return this.projectRawStats(rawStats, agentName);
  }

  /**
   * Recursive snake_case → camelCase key rename. Used to convert nested
   * `omega_metrics` / `learning_metrics` / `metadata` subtrees from on-disk
   * YAML shape into the typed {@link AgentStats} shape (HIGH-1, Codex 1st
   * round 2026-05-15 / PLAN.md OPEN-1).
   *
   * - Only renames keys that contain `_<lowercase letter or digit>`. Keys with
   *   hyphens (TaskCategory values like `bug-fix`) are preserved as-is so
   *   `specializations` / `categories` / `by_category` maps round-trip cleanly.
   * - Recurses into arrays (positional, no key rename) and plain objects only;
   *   primitives (number / string / boolean / null) are returned unchanged.
   */
  private static snakeToCamelDeep<T = unknown>(value: T): T {
    if (Array.isArray(value)) {
      return value.map((v) => MemoryService.snakeToCamelDeep(v)) as unknown as T;
    }
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        const camel = key.replace(/_([a-z0-9])/g, (_match, ch: string) => ch.toUpperCase());
        result[camel] = MemoryService.snakeToCamelDeep(v);
      }
      return result as unknown as T;
    }
    return value;
  }

  /**
   * Recursive camelCase → snake_case key rename. Used to convert nested
   * `omegaMetrics` / `learningMetrics` / `metadata` subtrees back into the
   * canonical on-disk YAML snake_case shape on save (HIGH-1).
   *
   * Inverse of {@link snakeToCamelDeep}. Hyphenated keys (TaskCategory values)
   * pass through unchanged because the regex only inserts `_` before uppercase.
   */
  private static camelToSnakeDeep<T = unknown>(value: T): T {
    if (Array.isArray(value)) {
      return value.map((v) => MemoryService.camelToSnakeDeep(v)) as unknown as T;
    }
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        const snake = key.replace(/([A-Z])/g, '_$1').toLowerCase();
        result[snake] = MemoryService.camelToSnakeDeep(v);
      }
      return result as unknown as T;
    }
    return value;
  }

  /**
   * Convert a raw on-disk YAML object (snake_case) into the typed
   * {@link AgentStats} (camelCase). Top-level fields use explicit conversion;
   * the nested `omega_metrics` / `learning_metrics` / `metadata` subtrees are
   * mapped recursively via {@link snakeToCamelDeep} (HIGH-1 / PLAN.md OPEN-1).
   *
   * `recent_tasks` is intentionally passed through as-is: TaskRecord on disk is
   * already camelCase under the current writer, and converting its keys would
   * mangle them. Changing the on-disk shape of `recent_tasks` is out of scope
   * for HIGH-1.
   */
  private projectRawStats(rawStats: Record<string, unknown>, agentName: string): AgentStats {
    const trends = (rawStats.trends as Record<string, unknown> | undefined) ?? {};
    const rawOmega = rawStats.omega_metrics;
    const rawLearning = rawStats.learning_metrics;
    const rawMetadata = rawStats.metadata;
    const stats: AgentStats = {
      agentName: (rawStats.agent_name as string) || agentName,
      totalTasks: (rawStats.total_tasks as number) || 0,
      successfulTasks: (rawStats.successful_tasks as number) || 0,
      failedTasks: (rawStats.failed_tasks as number) || 0,
      successRate: (rawStats.success_rate as number) || 0,
      avgQualityScore: (rawStats.avg_quality_score as number) || 0,
      avgDurationMs: (rawStats.avg_duration_ms as number) || 0,
      lastUpdated: (rawStats.last_updated as string) || new Date().toISOString(),
      recentTasks: (rawStats.recent_tasks as AgentStats['recentTasks']) || [],
      trends: {
        successRateTrend: (trends.success_rate_trend as number) || 0,
        qualityScoreTrend: (trends.quality_score_trend as number) || 0,
        avgDurationTrend: (trends.avg_duration_trend as number) || 0,
      },
      specializations:
        (rawStats.specializations as AgentStats['specializations']) ||
        ({} as AgentStats['specializations']),
      omegaMetrics: rawOmega
        ? (MemoryService.snakeToCamelDeep(rawOmega) as AgentStats['omegaMetrics'])
        : this.getDefaultOmegaMetrics(),
      learningMetrics: rawLearning
        ? (MemoryService.snakeToCamelDeep(rawLearning) as AgentStats['learningMetrics'])
        : this.getDefaultLearningMetrics(),
      metadata: rawMetadata
        ? (MemoryService.snakeToCamelDeep(rawMetadata) as AgentStats['metadata'])
        : this.getDefaultMetadata(),
    };
    return stats;
  }

  /**
   * Move a corrupt runtime stats file into `${runtimeBasePath}/agents/.corrupt/`
   * with an ISO-timestamped filename. Surfaces a console.warn so the operator can
   * audit later (PLAN.md Step 3 / Round 1 M5).
   */
  private quarantineCorruptFile(filePath: string, agentName: string, error: Error): void {
    const corruptDir = path.join(this.runtimeBasePath, 'agents', '.corrupt');
    try {
      if (!fs.existsSync(corruptDir)) {
        fs.mkdirSync(corruptDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const quarantinePath = path.join(corruptDir, `${agentName}-stats-${timestamp}.yaml`);
      fs.renameSync(filePath, quarantinePath);
      // eslint-disable-next-line no-console
      console.warn(
        `MemoryService: quarantined corrupt stats file: ${filePath} → ${quarantinePath} (reason: ${error.message})`
      );
    } catch (renameErr) {
      // eslint-disable-next-line no-console
      console.error(
        `MemoryService: failed to quarantine corrupt stats file ${filePath}:`,
        renameErr
      );
    }
  }

  /**
   * Get all agent statistics
   */
  getAllAgentStats(): AgentStats[] {
    const agentNames = this.getAgentNames();
    return agentNames.map((name) => this.loadAgentStats(name)).filter((s): s is AgentStats => s !== null);
  }

  /**
   * Calculate system-wide statistics
   */
  getSystemStats(): SystemStats {
    const allStats = this.getAllAgentStats();

    const totalTasks = allStats.reduce((sum, s) => sum + s.totalTasks, 0);
    const successfulTasks = allStats.reduce((sum, s) => sum + s.successfulTasks, 0);
    const overallSuccessRate = totalTasks > 0 ? successfulTasks / totalTasks : 0;

    const qualityScores = allStats.filter((s) => s.avgQualityScore > 0).map((s) => s.avgQualityScore);
    const avgQualityScore =
      qualityScores.length > 0 ? qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length : 0;

    // Sort by success rate for top performers
    const sortedBySuccess = [...allStats].sort((a, b) => b.successRate - a.successRate);

    const topPerformers: AgentSummary[] = sortedBySuccess.slice(0, 5).map((s) => ({
      name: s.agentName,
      successRate: s.successRate,
      avgQualityScore: s.avgQualityScore,
      totalTasks: s.totalTasks,
      health: s.metadata.overallHealth,
    }));

    // Find agents needing attention (poor health or low success rate)
    const needsAttention: AgentSummary[] = allStats
      .filter(
        (s) =>
          s.metadata.overallHealth === 'poor' ||
          s.metadata.overallHealth === 'fair' ||
          s.successRate < this.config.successRateThreshold.warning
      )
      .map((s) => ({
        name: s.agentName,
        successRate: s.successRate,
        avgQualityScore: s.avgQualityScore,
        totalTasks: s.totalTasks,
        health: s.metadata.overallHealth,
      }));

    // Calculate task distribution
    const taskDistribution: Record<TaskCategory, number> = {} as Record<TaskCategory, number>;
    for (const stats of allStats) {
      for (const [category, count] of Object.entries(stats.specializations)) {
        taskDistribution[category as TaskCategory] =
          (taskDistribution[category as TaskCategory] || 0) + (count as number);
      }
    }

    return {
      totalAgents: allStats.length,
      totalTasks,
      overallSuccessRate,
      avgQualityScore,
      topPerformers,
      needsAttention,
      taskDistribution,
      dailyTrends: this.calculateDailyTrends(allStats),
      skillUsage: this.calculateSkillUsage(),
      errorPatterns: this.analyzeErrorPatterns(allStats),
    };
  }

  /**
   * Calculate daily trends from agent stats
   */
  private calculateDailyTrends(allStats: AgentStats[]): DailyTrend[] {
    const trends: DailyTrend[] = [];
    const today = new Date();

    // Generate last 30 days of trends
    for (let i = 29; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];

      // Aggregate stats for this date (simplified - in real implementation would query task records)
      let totalTasks = 0;
      let successfulTasks = 0;
      let qualitySum = 0;
      let qualityCount = 0;

      for (const stats of allStats) {
        for (const task of stats.recentTasks) {
          if (task.completedAt?.startsWith(dateStr)) {
            totalTasks++;
            if (task.status === 'completed') {
              successfulTasks++;
            }
            if (task.qualityScore !== null) {
              qualitySum += task.qualityScore;
              qualityCount++;
            }
          }
        }
      }

      trends.push({
        date: dateStr,
        totalTasks,
        successfulTasks,
        avgQualityScore: qualityCount > 0 ? qualitySum / qualityCount : 0,
      });
    }

    return trends;
  }

  /**
   * Calculate skill usage statistics
   */
  private calculateSkillUsage(): SkillUsage[] {
    // This would be populated from actual skill invocation logs
    // For now, return sample data structure
    return [];
  }

  /**
   * Analyze error patterns across agents
   */
  private analyzeErrorPatterns(allStats: AgentStats[]): ErrorPattern[] {
    const errorCounts: Map<string, { count: number; agents: Set<string>; lastOccurrence: string }> = new Map();

    for (const stats of allStats) {
      for (const task of stats.recentTasks) {
        if (task.error) {
          const pattern = this.normalizeError(task.error);
          const existing = errorCounts.get(pattern) || {
            count: 0,
            agents: new Set<string>(),
            lastOccurrence: '',
          };

          existing.count++;
          existing.agents.add(stats.agentName);
          if (!existing.lastOccurrence || task.completedAt! > existing.lastOccurrence) {
            existing.lastOccurrence = task.completedAt || '';
          }

          errorCounts.set(pattern, existing);
        }
      }
    }

    return Array.from(errorCounts.entries())
      .map(([pattern, data]) => ({
        pattern,
        count: data.count,
        affectedAgents: Array.from(data.agents),
        lastOccurrence: data.lastOccurrence,
        suggestedFix: this.suggestFix(pattern),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }

  /**
   * Normalize error message for pattern matching
   */
  private normalizeError(error: string): string {
    // Remove specific file paths, line numbers, etc.
    return error
      .replace(/\/[^\s]+/g, '<path>')
      .replace(/line \d+/gi, 'line <N>')
      .replace(/\d+/g, '<N>')
      .substring(0, 100);
  }

  /**
   * Suggest fix for common error patterns
   */
  private suggestFix(pattern: string): string {
    const fixes: Record<string, string> = {
      timeout: 'Increase timeout or optimize task complexity',
      'not found': 'Verify file/resource existence before operation',
      permission: 'Check file/directory permissions',
      'syntax error': 'Validate input/code before processing',
      'network error': 'Add retry logic and error handling',
    };

    for (const [key, fix] of Object.entries(fixes)) {
      if (pattern.toLowerCase().includes(key)) {
        return fix;
      }
    }

    return 'Review error details and add specific handling';
  }

  /**
   * Export data in various formats
   */
  exportData(format: ExportFormat, outputPath: string): void {
    const systemStats = this.getSystemStats();
    const allAgentStats = this.getAllAgentStats();

    const data = {
      exportDate: new Date().toISOString(),
      system: systemStats,
      agents: allAgentStats,
    };

    let content: string;

    switch (format) {
      case 'json':
        content = JSON.stringify(data, null, 2);
        break;
      case 'yaml':
        content = yaml.stringify(data);
        break;
      case 'csv':
        content = this.convertToCSV(allAgentStats);
        break;
      default:
        throw new Error(`Unsupported format: ${format}`);
    }

    const dir = path.dirname(outputPath);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    MemoryService.atomicWriteFile(outputPath, content);
  }

  /**
   * Convert agent stats to CSV format
   */
  private convertToCSV(agents: AgentStats[]): string {
    const headers = [
      'agent_name',
      'total_tasks',
      'successful_tasks',
      'failed_tasks',
      'success_rate',
      'avg_quality_score',
      'avg_duration_ms',
      'health',
      'last_updated',
    ];

    const rows = agents.map((a) => [
      a.agentName,
      a.totalTasks,
      a.successfulTasks,
      a.failedTasks,
      a.successRate.toFixed(4),
      a.avgQualityScore.toFixed(2),
      a.avgDurationMs,
      a.metadata.overallHealth,
      a.lastUpdated,
    ]);

    return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  }

  /**
   * Generate CLI report
   */
  generateReport(type: ReportType = 'summary'): string {
    const systemStats = this.getSystemStats();

    switch (type) {
      case 'summary':
        return this.generateSummaryReport(systemStats);
      case 'detailed':
        return this.generateDetailedReport(systemStats);
      case 'trends':
        return this.generateTrendsReport(systemStats);
      case 'errors':
        return this.generateErrorsReport(systemStats);
      default:
        return this.generateSummaryReport(systemStats);
    }
  }

  /**
   * Generate summary report
   */
  private generateSummaryReport(stats: SystemStats): string {
    const lines: string[] = [];

    lines.push('═══════════════════════════════════════════════════════════════');
    lines.push('                    TAISUN v2 Memory Dashboard                   ');
    lines.push('═══════════════════════════════════════════════════════════════');
    lines.push('');
    lines.push('┌─────────────────────────────────────────────────────────────┐');
    lines.push('│  System Overview                                            │');
    lines.push('├─────────────────────────────────────────────────────────────┤');
    lines.push(`│  Total Agents:        ${String(stats.totalAgents).padStart(6)}                              │`);
    lines.push(`│  Total Tasks:         ${String(stats.totalTasks).padStart(6)}                              │`);
    lines.push(`│  Success Rate:        ${(stats.overallSuccessRate * 100).toFixed(1).padStart(6)}%                             │`);
    lines.push(`│  Avg Quality Score:   ${stats.avgQualityScore.toFixed(1).padStart(6)}                              │`);
    lines.push('└─────────────────────────────────────────────────────────────┘');
    lines.push('');

    if (stats.topPerformers.length > 0) {
      lines.push('┌─────────────────────────────────────────────────────────────┐');
      lines.push('│  Top Performers                                             │');
      lines.push('├─────────────────────────────────────────────────────────────┤');
      for (const agent of stats.topPerformers.slice(0, 5)) {
        const name = agent.name.substring(0, 25).padEnd(25);
        const rate = (agent.successRate * 100).toFixed(1).padStart(6);
        const quality = agent.avgQualityScore.toFixed(1).padStart(5);
        lines.push(`│  ${name} ${rate}%  Q:${quality}  │`);
      }
      lines.push('└─────────────────────────────────────────────────────────────┘');
      lines.push('');
    }

    if (stats.needsAttention.length > 0) {
      lines.push('┌─────────────────────────────────────────────────────────────┐');
      lines.push('│  ⚠ Needs Attention                                          │');
      lines.push('├─────────────────────────────────────────────────────────────┤');
      for (const agent of stats.needsAttention.slice(0, 5)) {
        const name = agent.name.substring(0, 25).padEnd(25);
        const rate = (agent.successRate * 100).toFixed(1).padStart(6);
        const health = agent.health.padEnd(8);
        lines.push(`│  ${name} ${rate}%  ${health} │`);
      }
      lines.push('└─────────────────────────────────────────────────────────────┘');
    }

    lines.push('');
    lines.push(`Report generated: ${new Date().toISOString()}`);

    return lines.join('\n');
  }

  /**
   * Generate detailed report
   */
  private generateDetailedReport(_stats: SystemStats): string {
    const allAgents = this.getAllAgentStats();
    const lines: string[] = [];

    lines.push('═══════════════════════════════════════════════════════════════');
    lines.push('                TAISUN v2 Detailed Agent Report                 ');
    lines.push('═══════════════════════════════════════════════════════════════');
    lines.push('');

    for (const agent of allAgents) {
      lines.push(`┌─────────────────────────────────────────────────────────────┐`);
      lines.push(`│  ${agent.agentName.padEnd(57)} │`);
      lines.push(`├─────────────────────────────────────────────────────────────┤`);
      lines.push(`│  Tasks: ${agent.totalTasks} (${agent.successfulTasks} success, ${agent.failedTasks} failed)`.padEnd(62) + '│');
      lines.push(`│  Success Rate: ${(agent.successRate * 100).toFixed(1)}%`.padEnd(62) + '│');
      lines.push(`│  Quality Score: ${agent.avgQualityScore.toFixed(1)}`.padEnd(62) + '│');
      lines.push(`│  Health: ${agent.metadata.overallHealth}`.padEnd(62) + '│');
      lines.push(`└─────────────────────────────────────────────────────────────┘`);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Generate trends report
   */
  private generateTrendsReport(stats: SystemStats): string {
    const lines: string[] = [];

    lines.push('═══════════════════════════════════════════════════════════════');
    lines.push('                   TAISUN v2 Trends Report                      ');
    lines.push('═══════════════════════════════════════════════════════════════');
    lines.push('');
    lines.push('Daily Activity (Last 30 Days):');
    lines.push('');
    lines.push('Date        Tasks  Success  Avg Quality');
    lines.push('──────────  ─────  ───────  ───────────');

    for (const trend of stats.dailyTrends.slice(-14)) {
      // Show last 14 days
      const date = trend.date;
      const tasks = String(trend.totalTasks).padStart(5);
      const success = String(trend.successfulTasks).padStart(7);
      const quality = trend.avgQualityScore > 0 ? trend.avgQualityScore.toFixed(1).padStart(11) : '        N/A';
      lines.push(`${date}  ${tasks}  ${success}  ${quality}`);
    }

    return lines.join('\n');
  }

  /**
   * Generate errors report
   */
  private generateErrorsReport(stats: SystemStats): string {
    const lines: string[] = [];

    lines.push('═══════════════════════════════════════════════════════════════');
    lines.push('                   TAISUN v2 Error Analysis                     ');
    lines.push('═══════════════════════════════════════════════════════════════');
    lines.push('');

    if (stats.errorPatterns.length === 0) {
      lines.push('No error patterns detected in recent tasks.');
    } else {
      for (const error of stats.errorPatterns) {
        lines.push(`Pattern: ${error.pattern}`);
        lines.push(`  Count: ${error.count}`);
        lines.push(`  Affected Agents: ${error.affectedAgents.join(', ')}`);
        lines.push(`  Suggested Fix: ${error.suggestedFix}`);
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * Get default Omega metrics
   */
  private getDefaultOmegaMetrics(): AgentStats['omegaMetrics'] {
    return {
      performanceBounds: {
        minQualityScore: 0,
        minSuccessRate: 0,
        maxLatencyMs: 0,
        worstCase: {
          qualityScore: 0,
          successRate: 0,
          latencyMs: 0,
        },
      },
      dependencies: {
        omega: 0,
        littleOmega: 0,
        couplingRatio: 1,
        dependenciesList: {
          tools: [],
          agents: [],
          external: [],
        },
        couplingHealth: {
          status: 'good',
          recommendation: '',
        },
      },
      completionProbability: {
        baseOmega: 0,
        byComplexity: {
          low: 0,
          medium: 0,
          high: 0,
        },
        byCategory: {} as Record<TaskCategory, number>,
        confidenceInterval: 0.05,
        sampleSize: 0,
        predictionAccuracy: {
          totalPredictions: 0,
          accuratePredictions: 0,
          accuracyRate: 0,
        },
      },
    };
  }

  /**
   * Get default learning metrics
   */
  private getDefaultLearningMetrics(): AgentStats['learningMetrics'] {
    return {
      learningRate: 0.1,
      qualityTrend: {
        direction: 'stable',
        rate: 0,
      },
      successTrend: {
        direction: 'stable',
        rate: 0,
      },
      specialization: {
        primaryCategory: '',
        specializationScore: 0,
        categories: {} as Record<TaskCategory, number>,
      },
    };
  }

  /**
   * Get default metadata
   */
  private getDefaultMetadata(): AgentStats['metadata'] {
    return {
      lastUpdated: new Date().toISOString(),
      schemaVersion: '2.0.0',
      omegaIntegrationDate: new Date().toISOString().split('T')[0],
      passesQualityGates: {
        minQuality: false,
        minSuccessRate: false,
        acceptableCoupling: true,
      },
      overallHealth: 'unknown',
    };
  }

  /**
   * Save agent statistics atomically to the runtime layer.
   *
   * Public entry point: acquires the per-agent lock via {@link withAgentLock}
   * and then delegates to {@link saveAgentStatsLocked} (HIGH-3, Codex 1st round
   * 2026-05-15 / PLAN.md OPEN-2). This prevents concurrent writers — including
   * `cleanupOldTasks()` and external callers — from clobbering each other.
   *
   * Validates `stats.agentName` as a slug before acquiring the lock so invalid
   * names fail fast.
   */
  saveAgentStats(stats: AgentStats): void {
    MemoryService.validateSlug(stats.agentName);
    this.withAgentLock(stats.agentName, () => {
      // HIGH (Codex 2nd round, 2026-05-20): optimistic concurrency check.
      // Acquiring the lock prevents two writers from interleaving the
      // tmp+rename, but it does NOT protect a caller-side load-modify-save
      // sequence: if the caller loaded `stats` before a concurrent
      // recordTask in another process advanced the on-disk state, writing
      // the stale snapshot would clobber that update. Re-read the current
      // on-disk version under the lock and reject when its lastUpdated has
      // moved on since the caller loaded it.
      //
      // The check is skipped when no on-disk file exists yet (first-write
      // for a fresh agent) and when the on-disk file is unparseable
      // (caller's data is the most we have — surfacing the parse error
      // here would just mask the corruption).
      const agentsPath = path.join(this.runtimeBasePath, 'agents');
      const statsPath = MemoryService.resolveSafeStatsPath(agentsPath, stats.agentName);
      if (fs.existsSync(statsPath)) {
        const onDisk = this.tryLoadFromFile(
          statsPath,
          stats.agentName,
          /*quarantineOnError*/ false
        );
        if (onDisk && onDisk.lastUpdated !== stats.lastUpdated) {
          throw new Error(
            `Stale saveAgentStats for ${stats.agentName}: ` +
              `on-disk lastUpdated=${onDisk.lastUpdated} but provided lastUpdated=${stats.lastUpdated}. ` +
              `Re-load via loadAgentStats() before saving (or use recordTask, which handles this internally).`
          );
        }
      }
      this.saveAgentStatsLocked(stats);
    });
  }

  /**
   * Internal save path. The caller MUST hold the per-agent lock for
   * `stats.agentName` (acquired via {@link withAgentLock}). Writes go through
   * tmp-file + fsync + rename so an interrupt mid-write leaves either the
   * previous version or the new version on disk — never a half-written blend
   * (PLAN.md Step 3 / Round 2 H3).
   */
  private saveAgentStatsLocked(stats: AgentStats): void {
    const agentsPath = path.join(this.runtimeBasePath, 'agents');

    if (!fs.existsSync(agentsPath)) {
      fs.mkdirSync(agentsPath, { recursive: true });
    }

    const statsPath = MemoryService.resolveSafeStatsPath(agentsPath, stats.agentName);

    // HIGH (Codex 3rd round, 2026-05-20): make `lastUpdated` strictly monotonic
    // within the per-agent lock. Otherwise two saves landing in the same
    // millisecond (or under a fixed clock) produce identical ISO strings, and
    // the public-path optimistic stale check (which compares lastUpdated) can
    // pass even though a real concurrent update was just committed → lost
    // update regression. We read the on-disk last_updated under the lock and
    // bump by 1 ms whenever the wall clock has not moved past it.
    const nowMs = Date.now();
    let candidateMs = nowMs;
    if (fs.existsSync(statsPath)) {
      try {
        const raw = yaml.parse(fs.readFileSync(statsPath, 'utf-8'));
        const onDiskIso = raw && typeof raw === 'object' ? (raw as { last_updated?: unknown }).last_updated : undefined;
        if (typeof onDiskIso === 'string') {
          const onDiskMs = Date.parse(onDiskIso);
          if (Number.isFinite(onDiskMs) && onDiskMs >= candidateMs) {
            candidateMs = onDiskMs + 1;
          }
        }
      } catch {
        // Unparseable on-disk YAML: fall through with nowMs. The atomic
        // write below will replace it.
      }
    }
    const lastUpdated = new Date(candidateMs).toISOString();
    const yamlData = {
      agent_name: stats.agentName,
      total_tasks: stats.totalTasks,
      successful_tasks: stats.successfulTasks,
      failed_tasks: stats.failedTasks,
      success_rate: stats.successRate,
      avg_quality_score: stats.avgQualityScore,
      avg_duration_ms: stats.avgDurationMs,
      last_updated: lastUpdated,
      recent_tasks: stats.recentTasks.slice(0, this.config.recentTasksLimit),
      trends: {
        success_rate_trend: stats.trends.successRateTrend,
        quality_score_trend: stats.trends.qualityScoreTrend,
        avg_duration_trend: stats.trends.avgDurationTrend,
      },
      specializations: stats.specializations,
      // HIGH-1 (Codex 1st round, 2026-05-15): convert nested camelCase subtrees
      // back to canonical snake_case so on-disk YAML keeps the shipped baseline
      // shape. Round-trip lossless with projectRawStats's snakeToCamelDeep.
      omega_metrics: MemoryService.camelToSnakeDeep(stats.omegaMetrics),
      learning_metrics: MemoryService.camelToSnakeDeep(stats.learningMetrics),
      metadata: MemoryService.camelToSnakeDeep(stats.metadata),
    };

    MemoryService.atomicWriteFile(statsPath, yaml.stringify(yamlData));

    stats.lastUpdated = lastUpdated;
    this.agentStatsCache.set(stats.agentName, stats);
  }

  /**
   * Acquire the per-agent file lock, run `fn`, and release the lock in finally.
   * Centralizes the lock acquisition so every write path goes through the same
   * gate (HIGH-3 / PLAN.md OPEN-2).
   *
   * The lock target is a dedicated marker file under
   * `${runtimeBasePath}/agents/.locks/${agentName}.target`, NOT the stats data
   * file (HIGH-2). The marker is created on-demand and is never read by
   * loadAgentStats / getAgentNames.
   */
  private withAgentLock<T>(agentName: string, fn: () => T): T {
    MemoryService.validateSlug(agentName);
    const agentsDir = path.join(this.runtimeBasePath, 'agents');
    const locksDir = path.join(agentsDir, '.locks');
    if (!fs.existsSync(agentsDir)) fs.mkdirSync(agentsDir, { recursive: true });
    if (!fs.existsSync(locksDir)) fs.mkdirSync(locksDir, { recursive: true });

    const lockTargetPath = path.join(locksDir, `${agentName}.target`);
    const lockfilePath = path.join(locksDir, `${agentName}.lock`);
    if (!fs.existsSync(lockTargetPath)) {
      fs.writeFileSync(lockTargetPath, '');
    }

    const release = MemoryService.acquireLockWithRetry(lockTargetPath, lockfilePath, {
      maxAttempts: 5,
      retryDelayMs: 1000,
      staleMs: 10000,
    });
    try {
      return fn();
    } finally {
      release();
    }
  }

  /**
   * Acquire a proper-lockfile lock with hand-rolled retry, since the sync API
   * does not accept the `retries` option. Returns the release function on success
   * and throws the last underlying error after `maxAttempts` failures.
   *
   * Sleeps between attempts via Atomics.wait so the loop yields the runtime
   * rather than busy-spinning.
   */
  private static acquireLockWithRetry(
    lockTargetPath: string,
    lockfilePath: string,
    opts: { maxAttempts: number; retryDelayMs: number; staleMs: number }
  ): () => void {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
      try {
        return lockfile.lockSync(lockTargetPath, {
          realpath: false,
          stale: opts.staleMs,
          lockfilePath,
        });
      } catch (err) {
        lastError = err;
        if (attempt < opts.maxAttempts - 1) {
          const sab = new SharedArrayBuffer(4);
          const arr = new Int32Array(sab);
          Atomics.wait(arr, 0, 0, opts.retryDelayMs);
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`Failed to acquire lock for ${lockTargetPath}: ${String(lastError)}`);
  }

  /**
   * Atomically write a UTF-8 string to `targetPath` via tmp-file + fsync + rename.
   *
   * The tmp filename embeds PID + ms + random bytes so concurrent writers and
   * leftover tmps from crashes do not collide. On any failure the tmp file is
   * removed so the agents directory stays clean.
   */
  private static atomicWriteFile(targetPath: string, content: string): void {
    const dir = path.dirname(targetPath);
    const random = crypto.randomBytes(4).toString('hex');
    const tmpPath = path.join(
      dir,
      `${path.basename(targetPath)}.tmp.${process.pid}.${Date.now()}.${random}`
    );
    let fd: number | null = null;
    try {
      fd = fs.openSync(tmpPath, 'w');
      fs.writeFileSync(fd, content, { encoding: 'utf-8' });
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmpPath, targetPath);
    } catch (err) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore close failures during cleanup */
        }
      }
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        /* ignore cleanup failures */
      }
      throw err;
    }
  }

  /**
   * Record a new task for an agent. The whole load-update-save cycle is wrapped
   * in a per-agent {@link https://github.com/moxystudio/node-proper-lockfile proper-lockfile}
   * file lock so two long-lived processes cannot overwrite each other's updates
   * (PLAN.md Step 3 / Round 3 H3 / Final-Round H2). Inside the lock we
   * unconditionally clear the cache and re-read from disk before applying the
   * update so a stale in-process cache cannot mask a fresher on-disk version.
   *
   * For a previously-unknown agent, this seeds per-agent calibration from
   * {@link MemoryService#loadBaselineManifest} when the agent appears there
   * (PLAN.md Step 10 baseline manifest), otherwise from the default factory.
   */
  recordTask(agentName: string, task: TaskRecord): void {
    MemoryService.validateSlug(agentName);

    this.withAgentLock(agentName, () => {
      // Invalidate in-process cache and re-read so we always update from the
      // freshest on-disk state (cache-invalidation-inside-lock contract).
      this.agentStatsCache.delete(agentName);
      let stats = this.loadAgentStats(agentName);

      if (!stats) {
        stats = this.createSeededStats(agentName);
      }

      stats.totalTasks++;
      if (task.status === 'completed') {
        stats.successfulTasks++;
      } else if (task.status === 'failed') {
        stats.failedTasks++;
      }

      stats.successRate = stats.successfulTasks / stats.totalTasks;

      if (task.qualityScore !== null) {
        const totalQuality = stats.avgQualityScore * (stats.totalTasks - 1) + task.qualityScore;
        stats.avgQualityScore = totalQuality / stats.totalTasks;
      }

      if (task.durationMs !== null) {
        const totalDuration = stats.avgDurationMs * (stats.totalTasks - 1) + task.durationMs;
        stats.avgDurationMs = totalDuration / stats.totalTasks;
      }

      stats.specializations[task.category] =
        (stats.specializations[task.category] || 0) + 1;

      stats.recentTasks.unshift(task);
      stats.recentTasks = stats.recentTasks.slice(0, this.config.recentTasksLimit);

      stats.metadata.overallHealth = this.calculateHealth(stats);
      stats.metadata.passesQualityGates = {
        minQuality: stats.avgQualityScore >= this.config.qualityThreshold.acceptable,
        minSuccessRate: stats.successRate >= this.config.successRateThreshold.acceptable,
        acceptableCoupling: true,
      };

      // Use the locked save path; we already hold the per-agent lock.
      this.saveAgentStatsLocked(stats);
    });
  }

  /**
   * Build a brand-new {@link AgentStats} for an agent that has no runtime / legacy
   * file. Per-agent baseline (`omega_metrics` / `learning_metrics` / `metadata`)
   * is seeded from `agents-baseline.yaml` when the agent appears in the manifest;
   * otherwise the default factory is used.
   *
   * The manifest is canonical snake_case; nested subtrees are converted to
   * camelCase via {@link snakeToCamelDeep} so seeded stats are immediately
   * usable through typed access (HIGH-1).
   */
  private createSeededStats(agentName: string): AgentStats {
    const manifest = this.loadBaselineManifest();
    const seed = manifest?.[agentName] as
      | {
          omega_metrics?: unknown;
          learning_metrics?: unknown;
          metadata?: unknown;
        }
      | undefined;

    return {
      agentName,
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
      omegaMetrics: seed?.omega_metrics
        ? (MemoryService.snakeToCamelDeep(seed.omega_metrics) as AgentStats['omegaMetrics'])
        : this.getDefaultOmegaMetrics(),
      learningMetrics: seed?.learning_metrics
        ? (MemoryService.snakeToCamelDeep(seed.learning_metrics) as AgentStats['learningMetrics'])
        : this.getDefaultLearningMetrics(),
      metadata: seed?.metadata
        ? (MemoryService.snakeToCamelDeep(seed.metadata) as AgentStats['metadata'])
        : this.getDefaultMetadata(),
    };
  }

  /**
   * Load and cache `${basePath}/agents-baseline.yaml`. Returns an empty record
   * (cached as `{}`) when the manifest is missing or unparseable so subsequent
   * lookups are O(1).
   */
  private loadBaselineManifest(): Record<string, unknown> | null {
    if (this.baselineManifestCache !== null) {
      return this.baselineManifestCache;
    }
    if (!fs.existsSync(this.baselineManifestPath)) {
      this.baselineManifestCache = {};
      return this.baselineManifestCache;
    }
    try {
      const content = fs.readFileSync(this.baselineManifestPath, 'utf-8');
      const parsed = yaml.parse(content);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.baselineManifestCache = parsed as Record<string, unknown>;
        return this.baselineManifestCache;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`MemoryService: failed to parse baseline manifest:`, err);
    }
    this.baselineManifestCache = {};
    return this.baselineManifestCache;
  }

  /**
   * Calculate overall health status
   */
  private calculateHealth(
    stats: AgentStats
  ): 'excellent' | 'good' | 'fair' | 'poor' | 'unknown' {
    if (stats.totalTasks < 3) {
      return 'unknown';
    }

    const qualityScore = stats.avgQualityScore;
    const successRate = stats.successRate;

    if (
      qualityScore >= this.config.qualityThreshold.excellent &&
      successRate >= this.config.successRateThreshold.preferred
    ) {
      return 'excellent';
    }

    if (
      qualityScore >= this.config.qualityThreshold.good &&
      successRate >= this.config.successRateThreshold.acceptable
    ) {
      return 'good';
    }

    if (
      qualityScore >= this.config.qualityThreshold.acceptable &&
      successRate >= this.config.successRateThreshold.warning
    ) {
      return 'fair';
    }

    return 'poor';
  }

  /**
   * Create backup of memory data
   */
  createBackup(): string {
    const backupDir = path.join(this.basePath, '..', this.config.backupPath);

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(backupDir, `backup-${timestamp}.json`);

    this.exportData('json', backupFile);

    return backupFile;
  }

  /**
   * Cleanup old tasks beyond retention period.
   *
   * HIGH-3 (Codex 1st round, 2026-05-15 / PLAN.md OPEN-2): each agent's
   * load-mutate-save cycle runs inside {@link withAgentLock}. Without this,
   * cleanup would read a stale snapshot, then a concurrent recordTask in
   * another process would commit a new task, and cleanup would clobber that
   * update by writing its stale snapshot. Acquiring the lock + re-reading
   * inside the lock ensures every save is based on the latest on-disk state.
   */
  cleanupOldTasks(): number {
    let cleanedCount = 0;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.retentionDays);
    const cutoffStr = cutoffDate.toISOString();

    const agentNames = this.getAgentNames();

    for (const name of agentNames) {
      this.withAgentLock(name, () => {
        // Force a fresh read inside the lock — never trust the in-memory cache
        // when we're about to write.
        this.agentStatsCache.delete(name);
        const stats = this.loadAgentStats(name);
        if (!stats) return;

        const originalCount = stats.recentTasks.length;
        stats.recentTasks = stats.recentTasks.filter(
          (task) => !task.completedAt || task.completedAt >= cutoffStr
        );

        if (stats.recentTasks.length < originalCount) {
          cleanedCount += originalCount - stats.recentTasks.length;
          this.saveAgentStatsLocked(stats);
        }
      });
    }

    return cleanedCount;
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.agentStatsCache.clear();
  }

  /**
   * Get configuration
   */
  getConfig(): MemoryConfig {
    return { ...this.config };
  }
}

/**
 * Export singleton instance
 */
export const memoryService = new MemoryService();
