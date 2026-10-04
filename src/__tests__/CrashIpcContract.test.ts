import { describe, it, expect } from 'vitest';
import type { CrashRecordResult } from '../api/types/crash';
import { buildCrashReport } from '../services/crash/CrashReporter';

describe('Crash IPC Contract', () => {
  it('validates shape of CrashReport and CrashRecordResult', () => {
    const report = buildCrashReport({
      error: new Error('IPC test error'),
      tier: 1,
      surface: 'editor',
    });

    expect(report.reportId).toBeDefined();
    expect(report.timestamp).toBeDefined();
    expect(report.tier).toBe(1);
    expect(report.surface).toBe('editor');
    expect(report.redacted).toBe(true);

    const result: CrashRecordResult = {
      success: true,
      reportId: report.reportId,
      filePath: '/userData/crash-reports/crash-123.json',
    };

    expect(result.success).toBe(true);
    expect(result.reportId).toBe(report.reportId);
  });
});
