import { describe, it, expect, beforeEach } from 'vitest';
import { buildCrashReport, formatCrashReportMarkdown, formatCrashReportJson } from '../services/crash/CrashReporter';
import { clearLogBreadcrumbs, getLogger } from '../engine/Logger';

describe('CrashReporter Service', () => {
  beforeEach(() => {
    clearLogBreadcrumbs();
  });

  it('builds a redacted structured CrashReport from an Error instance', () => {
    const logger = getLogger('Timeline');
    logger.info('Action inserted at t=1.5s');

    const error = new Error('WebGL Context Lost at /home/user/project');
    error.name = 'RenderingEngineError';

    const report = buildCrashReport({
      error,
      tier: 1,
      surface: 'editor',
      environment: {
        appVersion: '0.6.1',
        platform: 'linux',
      },
    });

    expect(report.reportId).toMatch(/^crash-[0-9a-z-]+$/);
    expect(report.tier).toBe(1);
    expect(report.surface).toBe('editor');
    expect(report.error.name).toBe('RenderingEngineError');
    expect(report.error.message).toContain('~/project');
    expect(report.environment.appVersion).toBe('0.6.1');
    expect(report.breadcrumbs.length).toBe(1);
    expect(report.breadcrumbs[0].message).toBe('Action inserted at t=1.5s');
    expect(report.redacted).toBe(true);
  });

  it('formats crash report into clean, user-shareable Markdown', () => {
    const error = new Error('Cannot read properties of undefined');
    const report = buildCrashReport({
      error,
      tier: 1,
      surface: 'editor',
      environment: {
        appVersion: '0.6.1',
        electronVersion: '43.1.0',
        platform: 'linux',
        arch: 'x64',
      },
    });

    const md = formatCrashReportMarkdown(report);
    expect(md).toContain('# AeonStagery Crash Diagnostic Report');
    expect(md).toContain('**Report ID**: `' + report.reportId + '`');
    expect(md).toContain('**Surface**: `editor`');
    expect(md).toContain('**App Version**: `0.6.1`');
    expect(md).toContain('### Error Summary');
    expect(md).toContain('Cannot read properties of undefined');
  });

  it('formats crash report into valid JSON', () => {
    const report = buildCrashReport({
      error: 'String error thrown',
      tier: 2,
      surface: 'renderer-global',
    });

    const jsonStr = formatCrashReportJson(report);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.reportId).toBe(report.reportId);
    expect(parsed.error.message).toBe('String error thrown');
  });
});
