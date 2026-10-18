import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AeonStageryElectronAPI } from '../api/types/window';
import type { UpdateStatus } from '../api/types/updater';

const ipc = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn().mockResolvedValue({ success: true }),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: ipc.exposeInMainWorld },
  ipcRenderer: ipc,
}));

let bridge: AeonStageryElectronAPI;
beforeAll(async () => {
  await import('../../electron/preload');
  expect(ipc.exposeInMainWorld).toHaveBeenCalledWith('aeonStageryAPI', expect.any(Object));
  bridge = ipc.exposeInMainWorld.mock.calls[0][1] as AeonStageryElectronAPI;
});

describe('Electron preload bridge contracts', () => {
  it('forwards typed dialog, voice and export requests unchanged', async () => {
    const dialog = { title: 'Save', filters: [{ name: 'Video', extensions: ['mp4'] }] };
    await bridge.dialog.showSave(dialog);
    expect(ipc.invoke).toHaveBeenLastCalledWith('dialog:showSave', dialog);
    const voice = { gptRoot: '/voices' };
    await bridge.voiceAuthoring.scanCatalog(voice);
    expect(ipc.invoke).toHaveBeenLastCalledWith('voiceAuthoring:scanCatalog', voice);
    const options = { fps: 60, transparent: true, audioSources: [{ path: '/voice.wav', delayMs: 250 }] };
    await bridge.export.convert('/input.webm', '/output.mov', options);
    expect(ipc.invoke).toHaveBeenLastCalledWith('ffmpeg:convert', '/input.webm', '/output.mov', options);
    await bridge.export.startStreamExport('/output.mov', { transparent: true });
    expect(ipc.invoke).toHaveBeenLastCalledWith('ffmpeg:startStreamExport', '/output.mov', { transparent: true });
  });

  it('strips the Electron event and removes the exact status listener on unsubscribe', () => {
    const callback = vi.fn<(status: UpdateStatus) => void>();
    const unsubscribe = bridge.updater.onStatus(callback);
    const [channel, listener] = ipc.on.mock.calls.at(-1)!;
    const status: UpdateStatus = { state: 'checking', source: 'github' };
    listener({ sender: 'private' }, status);
    expect(channel).toBe('updater:status');
    expect(callback).toHaveBeenCalledExactlyOnceWith(status);
    unsubscribe();
    expect(ipc.removeListener).toHaveBeenCalledWith('updater:status', listener);
  });
});
