import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { UpdateCheckResult } from 'electron-updater';
import { UpdateCoordinator, isUpdateNetworkError } from '../../electron/updateCoordinator';
import { getUpdateChannel } from '../../electron/updaterFeed';

const available = (version = '0.8.1-beta'): UpdateCheckResult => ({
  isUpdateAvailable: true, versionInfo: { version } as never,
  updateInfo: { version, releaseDate: '2026-10-06T00:00:00Z' } as never,
});

function channel() {
  return Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(async () => available()),
    downloadUpdate: vi.fn(async () => ['installer.exe']),
    quitAndInstall: vi.fn(),
  });
}

describe('update network classification', () => {
  it.each([
    Object.assign(new Error('connection failed'), { code: 'ECONNREFUSED' }),
    new Error('net::ERR_INTERNET_DISCONNECTED'),
    new Error('net::ERR_NAME_NOT_RESOLVED'),
    Object.assign(new Error('server unavailable'), { statusCode: 503 }),
    new Error('delta failed', { cause: new Error('Cannot download file, status 502: Bad Gateway') }),
    new Error('delta failed', { cause: new Error('socket hang up') }),
  ])('recognizes network failures including causes logged by electron-updater: %s', (error) => {
    expect(isUpdateNetworkError(error)).toBe(true);
  });

  it.each([
    Object.assign(new Error('Not Found'), { statusCode: 404 }),
    new Error('Cannot download file, status 404: Not Found'),
    new Error('checksum mismatch'),
    new Error('net::ERR_CERT_AUTHORITY_INVALID'),
    Object.assign(new Error('read-only cache'), { code: 'EACCES' }),
    new Error('cancelled'),
  ])('keeps non-network failures on the selected channel: %s', (error) => {
    expect(isUpdateNetworkError(error)).toBe(false);
  });

  it.each([['0.8.0-beta', 'beta'], ['0.8.0-beta.2+build', 'beta'], ['0.8.0-rc-hotfix.2', 'rc-hotfix'], ['0.8.0+build', 'latest']])('derives %s as %s', (version, expected) => {
    expect(getUpdateChannel(version)).toBe(expected);
  });
});

describe('UpdateCoordinator', () => {
  it('checks and installs through the explicit GitHub channel', async () => {
    const oss = channel();
    const github = channel();
    const coordinator = new UpdateCoordinator({ oss, github }, vi.fn());
    await coordinator.checkForUpdates('github');
    await coordinator.downloadUpdate();
    coordinator.installUpdate();
    expect(oss.checkForUpdates).not.toHaveBeenCalled();
    expect(oss.downloadUpdate).not.toHaveBeenCalled();
    expect(oss.quitAndInstall).not.toHaveBeenCalled();
    expect(github.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(coordinator.snapshot).toMatchObject({ state: 'downloaded', source: 'github' });
  });

  it('tries at most two channels when both connections fail', async () => {
    const oss = channel();
    const github = channel();
    for (const port of [oss, github]) port.checkForUpdates.mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED'));
    const coordinator = new UpdateCoordinator({ oss, github }, vi.fn());
    await expect(coordinator.checkForUpdates()).rejects.toThrow('ERR_CONNECTION_REFUSED');
    expect(oss.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(github.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot).toMatchObject({ state: 'error', source: 'github' });
    expect(() => coordinator.installUpdate()).toThrow('请先完成');
  });

  it('does not download a different version while failing over', async () => {
    const oss = channel();
    const github = channel();
    oss.downloadUpdate.mockRejectedValue(new Error('net::ERR_TIMED_OUT'));
    github.checkForUpdates.mockResolvedValue(available('0.8.0-beta'));
    const coordinator = new UpdateCoordinator({ oss, github }, vi.fn());
    await coordinator.checkForUpdates();
    await expect(coordinator.downloadUpdate()).rejects.toThrow('另一渠道尚未提供 0.8.1-beta');
    expect(github.downloadUpdate).not.toHaveBeenCalled();
    await expect(coordinator.downloadUpdate()).rejects.toThrow('请先检查');
  });

  it('serializes checks and downloads across both shared caches', async () => {
    const oss = channel();
    const github = channel();
    let resolve!: (result: UpdateCheckResult) => void;
    oss.checkForUpdates.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const coordinator = new UpdateCoordinator({ oss, github }, vi.fn());
    const checking = coordinator.checkForUpdates();
    await expect(coordinator.checkForUpdates('github')).rejects.toThrow('请稍候');
    await expect(coordinator.downloadUpdate()).rejects.toThrow('请稍候');
    resolve(available());
    await checking;
    await coordinator.downloadUpdate();
    expect(github.checkForUpdates).not.toHaveBeenCalled();
  });

  it('requires a fresh check after a failed check instead of reusing old metadata', async () => {
    const oss = channel();
    const coordinator = new UpdateCoordinator({ oss }, vi.fn());
    await coordinator.checkForUpdates();
    oss.checkForUpdates.mockRejectedValue(new Error('invalid manifest'));
    await expect(coordinator.checkForUpdates()).rejects.toThrow('invalid manifest');
    await expect(coordinator.downloadUpdate()).rejects.toThrow('请先检查');
  });
});
