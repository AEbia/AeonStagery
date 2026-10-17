import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({
  app: { getAppPath: () => '/app' },
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, handler) },
}));

import { registerFileSystemHandlers } from '../../electron/ipc/fs';

describe('export filesystem I/O', () => {
  let directory: string;
  beforeEach(async () => {
    handlers.clear();
    registerFileSystemHandlers();
    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aeon-export-io-test-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(directory, { recursive: true, force: true });
  });

  it('copies video within the main process and creates the destination directory asynchronously', async () => {
    const source = path.join(directory, 'source.mp4');
    const destination = path.join(directory, 'output', 'video.mp4');
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await fs.promises.writeFile(source, bytes);
    const copy = vi.spyOn(fs.promises, 'copyFile');
    expect(await handlers.get('fs:copyFile')?.(null, source, destination)).toEqual({ success: true });
    expect(copy).toHaveBeenCalledWith(source, destination);
    expect(await fs.promises.readFile(destination)).toEqual(Buffer.from(bytes));
  });

  it('reads audio asynchronously and returns only the requested bytes', async () => {
    const source = path.join(directory, 'voice.wav');
    await fs.promises.writeFile(source, new Uint8Array([1, 2, 3]));
    const read = vi.spyOn(fs.promises, 'readFile');
    const result = await handlers.get('fs:readFile')?.(null, source) as { success: boolean; data: ArrayBuffer };
    expect(read).toHaveBeenCalledWith(source);
    expect(result.success).toBe(true);
    expect(new Uint8Array(result.data)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('reports a copy failure without reading the missing video into memory', async () => {
    const read = vi.spyOn(fs.promises, 'readFile');
    expect(await handlers.get('fs:copyFile')?.(null, path.join(directory, 'missing'), path.join(directory, 'out')))
      .toEqual({ success: false, error: expect.stringContaining('ENOENT') });
    expect(read).not.toHaveBeenCalled();
  });
});
