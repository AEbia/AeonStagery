// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { UpdateSettingsPanel } from '../ui/settings/UpdateSettingsPanel';
import type { UpdateStatus } from '../api/types/updater';

let emit: (status: UpdateStatus) => void;
const api = {
  getState: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), installUpdate: vi.fn(),
  onStatus: vi.fn((listener: typeof emit) => { emit = listener; return vi.fn(); }),
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getState.mockResolvedValue({ enabled: true, sources: ['oss', 'github'], state: 'idle', source: 'oss' });
  api.checkForUpdates.mockResolvedValue({ success: true, updateAvailable: true, source: 'oss', version: '0.8.1-beta' });
  api.downloadUpdate.mockResolvedValue({ success: true, source: 'oss' });
  api.installUpdate.mockResolvedValue({ success: true });
  Object.defineProperty(window, 'aeonStageryAPI', { configurable: true, value: { updater: api } });
});
afterEach(cleanup);

async function renderPanel() {
  render(<UpdateSettingsPanel />);
  await waitFor(() => expect(screen.getByRole('button', { name: '检查更新' })).not.toBeDisabled());
}

describe('update settings', () => {
  it('selects GitHub, downloads inside the app, and enables installation only after success', async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole('combobox', { name: '更新渠道' }));
    fireEvent.click(screen.getByRole('option', { name: '海外源（增量下载）' }));
    expect(screen.getByRole('button', { name: '下载增量更新' })).toBeDisabled();
    api.checkForUpdates.mockResolvedValue({ success: true, updateAvailable: true, source: 'github', version: '0.8.1-beta' });
    api.downloadUpdate.mockResolvedValue({ success: true, source: 'github' });
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
    await waitFor(() => expect(api.checkForUpdates).toHaveBeenCalledWith('github'));
    await waitFor(() => expect(screen.getByRole('button', { name: '下载增量更新' })).not.toBeDisabled());
    expect(screen.getByRole('button', { name: '立即重启安装' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '下载增量更新' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '立即重启安装' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: '立即重启安装' }));
    await waitFor(() => expect(api.installUpdate).toHaveBeenCalledTimes(1));
  });

  it('shows automatic network failover and keeps controls disabled throughout it', async () => {
    await renderPanel();
    let resolve!: (value: unknown) => void;
    api.checkForUpdates.mockImplementation(() => new Promise((done) => { resolve = done; }));
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
    emit({ state: 'checking', source: 'github', fallbackFrom: 'oss' });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('国内源 连接失败，正在尝试 海外源'));
    expect(screen.getByRole('combobox', { name: '更新渠道' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '检查中…' })).toBeDisabled();
    resolve({ success: true, updateAvailable: true, source: 'github', version: '0.8.1-beta' });
    await waitFor(() => expect(screen.getByRole('button', { name: '下载增量更新' })).not.toBeDisabled());
  });

  it('releases busy controls when IPC rejects and does not allow installation', async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '下载增量更新' })).not.toBeDisabled());
    api.downloadUpdate.mockRejectedValue(new Error('网络连接失败'));
    fireEvent.click(screen.getByRole('button', { name: '下载增量更新' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('网络连接失败'));
    expect(screen.getByRole('button', { name: '检查更新' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: '下载增量更新' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '立即重启安装' })).toBeDisabled();
  });

  it('invalidates the checked version when switching channels', async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '下载增量更新' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('combobox', { name: '更新渠道' }));
    fireEvent.click(screen.getByRole('option', { name: '海外源（增量下载）' }));
    expect(screen.getByRole('button', { name: '下载增量更新' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '立即重启安装' })).toBeDisabled();
  });

  it('restores a completed GitHub download when reopening settings', async () => {
    api.getState.mockResolvedValue({ enabled: true, sources: ['oss', 'github'], state: 'downloaded', source: 'github', version: '0.8.1-beta' });
    await renderPanel();
    expect(screen.getByRole('button', { name: '立即重启安装' })).not.toBeDisabled();
    expect(screen.getByRole('combobox', { name: '更新渠道' }).textContent).toContain('海外源');
  });
});
