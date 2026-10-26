/**
 * Unit Tests for metrics-collector.js
 */

import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const metricsCollector = require('../../.claude/hooks/metrics-collector') as any;

describe('metrics-collector', () => {
  describe('validateEvent', () => {
    test('should validate correct event', () => {
      const event = {
        timestamp: new Date().toISOString(),
        hookName: 'test-hook',
        phase: 'PreToolUse',
        toolName: 'Write',
        eventType: 'allow',
        processingTimeMs: 50,
        sessionId: 'session-2026-02-13-abc123'
      };
      const result = metricsCollector.validateEvent(event);
      expect(result.isValid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    test('should reject event without timestamp', () => {
      const event = {
        hookName: 'test-hook',
        phase: 'PreToolUse',
        eventType: 'allow',
        processingTimeMs: 50,
        sessionId: 'session-2026-02-13-abc123'
      };
      const result = metricsCollector.validateEvent(event);
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('timestamp'))).toBe(true);
    });

    test('should reject event with invalid timestamp format', () => {
      const event = {
        timestamp: '2026-02-13',
        hookName: 'test-hook',
        phase: 'PreToolUse',
        eventType: 'allow',
        processingTimeMs: 50,
        sessionId: 'session-2026-02-13-abc123'
      };
      const result = metricsCollector.validateEvent(event);
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('ISO 8601'))).toBe(true);
    });

    test('should reject block event without reason', () => {
      const event = {
        timestamp: new Date().toISOString(),
        hookName: 'test-hook',
        phase: 'PreToolUse',
        eventType: 'block',
        processingTimeMs: 50,
        sessionId: 'session-2026-02-13-abc123'
      };
      const result = metricsCollector.validateEvent(event);
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('reason'))).toBe(true);
    });

    test('should accept processingTimeMs up to 10000', () => {
      const event = {
        timestamp: new Date().toISOString(),
        hookName: 'test-hook',
        phase: 'PreToolUse',
        eventType: 'allow',
        processingTimeMs: 10000,
        sessionId: 'session-2026-02-13-abc123'
      };
      const result = metricsCollector.validateEvent(event);
      expect(result.isValid).toBe(true);
    });
  });

  describe('recordMetric', () => {
    test('should process event without error', async () => {
      const event = {
        timestamp: new Date().toISOString(),
        hookName: 'test-hook',
        phase: 'UserPromptSubmit',
        eventType: 'allow',
        processingTimeMs: 45,
        sessionId: 'session-2026-02-13-test001'
      };
      await expect(metricsCollector.recordMetric(event)).resolves.toBeUndefined();
    });

    test('should handle invalid event gracefully', async () => {
      const event = {
        timestamp: 'invalid-timestamp',
        hookName: 'test-hook'
      };
      await expect(metricsCollector.recordMetric(event)).resolves.toBeUndefined();
    });
  });

  describe('getBufferStatus', () => {
    test('should return buffer status object', () => {
      const status = metricsCollector.getBufferStatus();
      expect(status).toHaveProperty('bufferSize');
      expect(status).toHaveProperty('maxBufferSize');
      expect(status).toHaveProperty('bufferUtilization');
      expect(status).toHaveProperty('isFlushingBuffer');
      expect(status).toHaveProperty('hasFlushTimer');
    });

    test('buffer size should be number', () => {
      const status = metricsCollector.getBufferStatus();
      expect(typeof status.bufferSize).toBe('number');
      expect(status.bufferSize >= 0).toBe(true);
    });
  });

  afterAll(async () => {
    // Drain the buffer so the pending 15-minute flush timer is cleared and Jest can exit
    await metricsCollector.flushBuffer();
  });
});
