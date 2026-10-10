import { describe, it, expect, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DIFFERENTIAL_ONLY_REQUIRED_MESSAGE,
  enforceDifferentialOnlyDownload,
  type DifferentialDownloadCapableUpdater,
} from '../../electron/updaterDownloadPolicy';

vi.mock('node:fs/promises', () => ({ rm: vi.fn(async () => {}) }));
const getOrCreateDownloadHelper = async () => ({ cacheDir: '/updater-cache' });

describe('enforceDifferentialOnlyDownload', () => {
  it('turns the full-download fallback into an error', async () => {
    const updater: DifferentialDownloadCapableUpdater = {
      getOrCreateDownloadHelper,
      differentialDownloadInstaller: vi.fn(async () => true),
    };

    expect(enforceDifferentialOnlyDownload(updater)).toBe(true);
    await expect(updater.differentialDownloadInstaller!()).rejects.toThrow(
      DIFFERENTIAL_ONLY_REQUIRED_MESSAGE,
    );
  });

  it('passes a completed differential download through as false', async () => {
    const inner = vi.fn(async () => false);
    const updater: DifferentialDownloadCapableUpdater = { differentialDownloadInstaller: inner, getOrCreateDownloadHelper };

    enforceDifferentialOnlyDownload(updater);

    await expect(updater.differentialDownloadInstaller!()).resolves.toBe(false);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('forwards every argument and keeps the updater instance as this', async () => {
    const seen: Array<{ self: unknown; args: unknown[] }> = [];

    class FakeUpdater {
      getOrCreateDownloadHelper = getOrCreateDownloadHelper;
      async differentialDownloadInstaller(...args: unknown[]): Promise<boolean> {
        seen.push({ self: this, args });
        return false;
      }
    }

    const updater = new FakeUpdater();
    enforceDifferentialOnlyDownload(updater);

    await updater.differentialDownloadInstaller('fileInfo', 'options', 'destination.exe', 'provider', 'installer.exe');

    expect(seen).toEqual([
      {
        self: updater,
        args: ['fileInfo', 'options', 'destination.exe', 'provider', 'installer.exe'],
      },
    ]);
    expect(rm).toHaveBeenCalledWith(join('/updater-cache', 'current.blockmap'), { force: true });
  });

  it('reports an unavailable seam instead of pretending the guard is active', () => {
    expect(enforceDifferentialOnlyDownload({})).toBe(false);
    expect(enforceDifferentialOnlyDownload({ differentialDownloadInstaller: async () => false })).toBe(false);
  });
});
