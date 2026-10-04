import { describe, it, expect } from 'vitest';
import { redactText, redactErrorDetails, redactBreadcrumbs } from '../services/crash/CrashRedactor';
import type { LogBreadcrumb, CrashErrorDetails } from '../api/types/crash';

describe('CrashRedactor', () => {
  it('redacts OpenAI / DeepSeek / Claude API keys', () => {
    const text = 'Failed to request model with apiKey sk-proj-1234567890abcdef1234567890 and sk-ant-api03-abcdef1234567890';
    const redacted = redactText(text);
    expect(redacted).not.toContain('sk-proj-1234567890abcdef1234567890');
    expect(redacted).not.toContain('sk-ant-api03-abcdef1234567890');
    expect(redacted).toContain('[REDACTED_API_KEY]');
  });

  it('redacts Bearer tokens and key=value pairs', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdef123456';
    const redacted = redactText(text);
    expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdef123456');
    expect(redacted).toContain('[REDACTED_TOKEN]');
  });

  it('anonymizes user home directories', () => {
    const linuxPath = 'Error at /home/john_doe/AeonStagery-dev/src/main.ts:12:34';
    const macPath = 'Error at /Users/alice/Documents/AeonStagery/scene.json:5:10';
    const winPath = 'Error at C:\\Users\\bob\\AppData\\Local\\AeonStagery\\log.txt';

    expect(redactText(linuxPath)).toBe('Error at ~/AeonStagery-dev/src/main.ts:12:34');
    expect(redactText(macPath)).toBe('Error at ~/Documents/AeonStagery/scene.json:5:10');
    expect(redactText(winPath)).toBe('Error at ~/AppData\\Local\\AeonStagery\\log.txt');
  });

  it('redacts error details and breadcrumbs collections', () => {
    const error: CrashErrorDetails = {
      name: 'ApiAuthError',
      message: 'Invalid key sk-9876543210fedcba9876543210 at /home/developer/code',
      stack: 'Error: sk-9876543210fedcba9876543210\n    at /home/developer/code/index.ts:1:1',
    };

    const redactedErr = redactErrorDetails(error);
    expect(redactedErr.message).toContain('[REDACTED_API_KEY]');
    expect(redactedErr.message).toContain('~/code');
    expect(redactedErr.stack).toContain('[REDACTED_API_KEY]');
    expect(redactedErr.stack).toContain('~/code/index.ts');

    const breadcrumbs: LogBreadcrumb[] = [
      {
        timestamp: '2026-08-17T00:00:00Z',
        level: 'info',
        context: 'Auth',
        message: 'Loaded key sk-11223344556677889900aabbcc',
      },
    ];

    const redactedBreadcrumbs = redactBreadcrumbs(breadcrumbs);
    expect(redactedBreadcrumbs[0].message).toContain('[REDACTED_API_KEY]');
    expect(redactedBreadcrumbs[0].message).not.toContain('sk-11223344556677889900aabbcc');
  });
});
