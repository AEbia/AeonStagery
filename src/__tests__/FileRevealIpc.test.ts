import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import type { IpcWindowContext } from '../../electron/ipc/windows';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>>(),
  reveal: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getAppPath: () => '/app' },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>) => mocks.handlers.set(channel, handler) },
  shell: { showItemInFolder: mocks.reveal },
}));
import { registerFileSystemHandlers } from '../../electron/ipc/fs';

describe('native file reveal IPC', () => {
  let directory: string;
  const mainFrame = {};
  const webContents = { id: 1, mainFrame };
  const windows = { mainWindow: { webContents, isDestroyed: () => false } } as unknown as IpcWindowContext;
  const event = { sender: webContents, senderFrame: mainFrame } as IpcMainInvokeEvent;
  const invoke = (value: unknown, sender = event) => {
    const handler = mocks.handlers.get('fs:showItemInFolder');
    if (!handler) throw new Error('Missing file reveal handler');
    return handler(sender, value);
  };

  beforeEach(async () => {
    mocks.handlers.clear();
    mocks.reveal.mockReset();
    directory = await mkdtemp(join(tmpdir(), 'aeon-reveal-'));
    registerFileSystemHandlers(windows);
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('reveals an existing local file and directory without invoking a command or URL', async () => {
    const file = join(directory, '角色 image.png');
    await writeFile(file, 'image');
    expect(await invoke(file)).toEqual({ success: true });
    expect(mocks.reveal).toHaveBeenCalledWith(await fs.promises.realpath(file));
    expect(await invoke(directory)).toEqual({ success: true });
  });

  it.each(['', 'background/image.png', 'https://example.com', 'file:///tmp/project', 'asset://localhost/a', '/tmp/a\0b', 123, null])('rejects a non-local or invalid path: %s', async (value) => {
    expect(await invoke(value)).toMatchObject({ success: false });
    expect(mocks.reveal).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'win32')('accepts a UNC filesystem path when the host resolves it', async () => {
    const sharePath = '\\\\server\\share\\project.json';
    const realpath = vi.spyOn(fs.promises, 'realpath').mockResolvedValue(sharePath as never);
    expect(await invoke(sharePath)).toEqual({ success: true });
    expect(realpath).toHaveBeenCalledWith(sharePath);
    expect(mocks.reveal).toHaveBeenCalledWith(sharePath);
    realpath.mockRestore();
  });

  it('rejects an untrusted sender or child frame', async () => {
    expect(await invoke(directory, { ...event, senderFrame: {} } as IpcMainInvokeEvent)).toMatchObject({ success: false });
    expect(await invoke(directory, { ...event, sender: { id: 2 } } as IpcMainInvokeEvent)).toMatchObject({ success: false });
    expect(mocks.reveal).not.toHaveBeenCalled();
  });

  it('reports missing files and native failures', async () => {
    expect(await invoke(join(directory, 'missing'))).toEqual({ success: false, error: '文件不存在或已移动，请检查路径后重试。' });
    expect(mocks.reveal).not.toHaveBeenCalled();
    mocks.reveal.mockImplementation(() => { throw new Error('File manager unavailable'); });
    expect(await invoke(directory)).toEqual({ success: false, error: 'File manager unavailable' });
  });
});
