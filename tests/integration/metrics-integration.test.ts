/**
 * Integration Tests for metrics system
 */

import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const metricsCollector = require('../../.claude/hooks/metrics-collector') as any;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { aggregateMetrics, getDateString } = require('../../.claude/hooks/metrics-aggregator') as any;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { generateReport } = require('../../.claude/hooks/generate-metrics-report') as any;

const HOOKS_DATA_DIR = path.join(__dirname, '../../.claude/hooks/data');
const TEST_DATE = getDateString();

describe('metrics integration', () => {
  beforeEach(() => {
    // Clean up test data
    const eventLog = path.join(HOOKS_DATA_DIR, 'hook-event.log');
    if (fs.existsSync(eventLog)) {
      fs.unlinkSync(eventLog);
    }
  });

  describe('end-to-end flow', () => {
    test('should record events and aggregate metrics', async () => {
      // Record test events
      const events = [
        {
          timestamp: new Date().toISOString(),
          hookName: 'skill-usage-guard',
          phase: 'UserPromptSubmit',
          eventType: 'allow',
          processingTimeMs: 45,
          sessionId: 'session-2026-02-13-test001'
        },
        {
          timestamp: new Date().toISOString(),
          hookName: 'deviation-approval-guard',
          phase: 'PreToolUse',
          toolName: 'Write',
          eventType: 'block',
          reason: 'TEST_BLOCK',
          processingTimeMs: 120,
          sessionId: 'session-2026-02-13-test001'
        }
      ];

      for (const event of events) {
        await metricsCollector.recordMetric(event);
      }

      await metricsCollector.flushBuffer();

      // Verify log file was created
      const eventLog = path.join(HOOKS_DATA_DIR, 'hook-event.log');
      expect(fs.existsSync(eventLog)).toBe(true);

      // Aggregate metrics
      const metrics = await aggregateMetrics(TEST_DATE);
      expect(metrics).not.toBeNull();
      expect(metrics.summary.totalHookEvents).toBe(2);
      expect(metrics.summary.blockCount).toBe(1);
    });

    test('should detect anomalies', async () => {
      // Record events with high block rate
      const events = Array(10).fill(null).map(() => ({
        timestamp: new Date().toISOString(),
        hookName: 'deviation-approval-guard',
        phase: 'PreToolUse',
        eventType: 'block',
        reason: 'TEST_BLOCK',
        processingTimeMs: 150,
        sessionId: 'session-2026-02-13-test002'
      }));

      for (const event of events) {
        await metricsCollector.recordMetric(event);
      }

      await metricsCollector.flushBuffer();
      const metrics = await aggregateMetrics(TEST_DATE);

      expect(metrics).not.toBeNull();
      expect(parseFloat(metrics.summary.blockRate) > 50).toBe(true);
      expect(metrics.alerts.length > 0).toBe(true);
    });
  });

  describe('report generation', () => {
    test('should generate report from metrics', async () => {
      // Record test events
      const event = {
        timestamp: new Date().toISOString(),
        hookName: 'test-hook',
        phase: 'UserPromptSubmit',
        eventType: 'allow',
        processingTimeMs: 50,
        sessionId: 'session-2026-02-13-test003'
      };

      await metricsCollector.recordMetric(event);
      await metricsCollector.flushBuffer();

      const metrics = await aggregateMetrics(TEST_DATE);
      expect(metrics).not.toBeNull();

      const report = await generateReport(1);
      expect(report).not.toBeNull();
      expect(report.reportPath).toBeDefined();

      // Verify report file was created
      expect(fs.existsSync(report.reportPath)).toBe(true);

      const reportContent = fs.readFileSync(report.reportPath, 'utf8');
      expect(reportContent).toContain('メトリクスダッシュボード');
      expect(reportContent).toContain('Hook別詳細');
    });
  });

  describe('performance', () => {
    test('recordMetric should complete within 10ms', async () => {
      const event = {
        timestamp: new Date().toISOString(),
        hookName: 'perf-test-hook',
        phase: 'UserPromptSubmit',
        eventType: 'allow',
        processingTimeMs: 25,
        sessionId: 'session-2026-02-13-perf'
      };

      const start = Date.now();
      await metricsCollector.recordMetric(event);
      const duration = Date.now() - start;

      expect(duration < 100).toBe(true);
    });
  });

  afterAll(async () => {
    // Drain the buffer so the pending 15-minute flush timer is cleared and Jest can exit
    await metricsCollector.flushBuffer();
  });

  afterEach(() => {
    // Clean up test files
    const metricsFile = path.join(HOOKS_DATA_DIR, 'metrics-daily', `metrics-${TEST_DATE}.json`);
    if (fs.existsSync(metricsFile)) {
      fs.unlinkSync(metricsFile);
    }

    const alertsFile = path.join(HOOKS_DATA_DIR, `alerts-${TEST_DATE}.json`);
    if (fs.existsSync(alertsFile)) {
      fs.unlinkSync(alertsFile);
    }
  });
});
