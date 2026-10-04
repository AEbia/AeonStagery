import { describe, it, expect } from 'vitest';
import type { UpdateCheckResult } from 'electron-updater';
import { toUpdateCheckOutcome } from '../../electron/updaterCheckResult';

function checkResult(overrides: {
  isUpdateAvailable: boolean;
  version?: string;
  releaseName?: string;
  releaseDate?: string;
  releaseNotes?: unknown;
}): UpdateCheckResult {
  const info = {
    version: overrides.version ?? '0.0.0',
    ...(overrides.releaseName === undefined ? {} : { releaseName: overrides.releaseName }),
    ...(overrides.releaseDate === undefined ? {} : { releaseDate: overrides.releaseDate }),
    ...(overrides.releaseNotes === undefined ? {} : { releaseNotes: overrides.releaseNotes }),
  };
  return {
    isUpdateAvailable: overrides.isUpdateAvailable,
    updateInfo: info,
    versionInfo: info,
  } as unknown as UpdateCheckResult;
}

describe('toUpdateCheckOutcome', () => {
  it('does not report an update when the feed version matches the running version', () => {
    // electron-updater resolves with a populated updateInfo even on the not-available
    // branch, which is what previously produced "发现新版本 <当前版本>".
    const outcome = toUpdateCheckOutcome(
      checkResult({ isUpdateAvailable: false, version: '0.7.7' }),
    );

    expect(outcome.updateAvailable).toBe(false);
    expect(outcome.version).toBeNull();
    expect(outcome.releaseName).toBeNull();
    expect(outcome.releaseDate).toBeNull();
    expect(outcome.notes).toBeNull();
  });

  it('reports the published version when a newer build exists', () => {
    const outcome = toUpdateCheckOutcome(
      checkResult({
        isUpdateAvailable: true,
        version: '0.7.8',
        releaseName: 'AeonStagery 0.7.8',
        releaseDate: '2026-10-03T00:00:00.000Z',
        releaseNotes: 'notes',
      }),
    );

    expect(outcome).toMatchObject({
      success: true,
      updateAvailable: true,
      version: '0.7.8',
      releaseName: 'AeonStagery 0.7.8',
      releaseDate: '2026-10-03T00:00:00.000Z',
      notes: 'notes',
    });
  });

  it('fails closed when the check result is missing or unmarked', () => {
    expect(toUpdateCheckOutcome(null).updateAvailable).toBe(false);

    const unmarked = { updateInfo: { version: '0.9.9' } } as unknown as UpdateCheckResult;
    expect(toUpdateCheckOutcome(unmarked).updateAvailable).toBe(false);
    expect(toUpdateCheckOutcome(unmarked).version).toBeNull();
  });
});
