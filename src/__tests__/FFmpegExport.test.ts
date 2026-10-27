import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ffmpegMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  spawn: vi.fn(),
  createOutput: vi.fn(),
  getAllWindows: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: ffmpegMocks.getAllWindows,
  },
  dialog: {
    showSaveDialog: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn((name: string, handler: (...args: any[]) => any) => {
      ffmpegMocks.handlers.set(name, handler);
    }),
  },
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: ffmpegMocks.spawn,
}));

vi.mock('../../electron/export-output', () => ({
  ExportOutputTasks: class {
    recover = vi.fn().mockResolvedValue(undefined);
    create = ffmpegMocks.createOutput;
  },
}));

import { registerFFmpegHandlers, resolveFfmpegExecutablePath } from '../../electron/ffmpeg-export';

class FakeInput extends EventEmitter {
  end = vi.fn();
  destroy = vi.fn();
  write = vi.fn((_buffer: Buffer, callback: (error?: Error) => void) => {
    callback();
    return true;
  });
}

class FakeChild extends EventEmitter {
  stdin = new FakeInput();
  stderr = new EventEmitter();
  kill = vi.fn(() => { queueMicrotask(() => this.emit('close', null, 'SIGTERM')); });
}

function handler(name: string): (...args: any[]) => any {
  const value = ffmpegMocks.handlers.get(name);
  if (!value) throw new Error(`Missing IPC handler: ${name}`);
  return value;
}

describe('FFmpeg export failure seam', () => {
  it('honors CRF in raw-pixel encoding and defaults to medium compression', async () => {
    ffmpegMocks.spawn.mockReturnValue(new FakeChild());
    await handler('ffmpeg:startStreamExport')(null, '/tmp/quality.mp4', {
      codec: 'libx264', crf: 18, width: 16, height: 16,
    });
    const args = ffmpegMocks.spawn.mock.calls[0][1] as string[];
    expect(args).toEqual(expect.arrayContaining(['-crf', '18', '-preset', 'medium']));
    expect(args).not.toContain('-b:v');
  });

  it('redirects packaged FFmpeg from app.asar to app.asar.unpacked', () => {
    expect(resolveFfmpegExecutablePath(
      String.raw`C:\Users\23275\AppData\Local\Programs\AeonStagery\resources\app.asar\node_modules\ffmpeg-static\ffmpeg.exe`,
    )).toBe(
      String.raw`C:\Users\23275\AppData\Local\Programs\AeonStagery\resources\app.asar.unpacked\node_modules\ffmpeg-static\ffmpeg.exe`,
    );
  });

  it('does not rewrite ordinary development paths', () => {
    expect(resolveFfmpegExecutablePath(String.raw`D:\repo\node_modules\ffmpeg-static\ffmpeg.exe`))
      .toBe(String.raw`D:\repo\node_modules\ffmpeg-static\ffmpeg.exe`);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    ffmpegMocks.handlers.clear();
    ffmpegMocks.spawn.mockReset();
    ffmpegMocks.getAllWindows.mockReset().mockReturnValue([]);
    ffmpegMocks.createOutput.mockReset().mockImplementation(async (outputPath: string) => ({
      partialPath: outputPath.replace(/(\.[^/.]+)$/, '.partial$1'),
      recordChild: vi.fn().mockResolvedValue(undefined),
      checkSpace: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      // Output lifecycle is mocked here; real filesystem cleanup is covered by ExportOutput.test.ts.
      cleanup: vi.fn().mockResolvedValue(undefined),
    }));
    registerFFmpegHandlers();
  });

  afterEach(() => {
    for (const result of ffmpegMocks.spawn.mock.results) {
      if (result.type === 'return' && result.value instanceof FakeChild) result.value.emit('close', 0);
    }
  });

  it('writes only the encoded chunk subview without copying its storage', async () => {
    const child = new FakeChild();
    ffmpegMocks.spawn.mockReturnValue(child);
    await handler('ffmpeg:startStreamExport')(null, '/tmp/encoded.mp4', { isEncoded: true });
    const storage = new Uint8Array([99, 1, 2, 3, 99]);
    await handler('ffmpeg:pushEncodedChunk')(null, storage.subarray(1, 4));
    const written = child.stdin.write.mock.calls[0][0];
    expect([...written]).toEqual([1, 2, 3]);
    expect(written.buffer).toBe(storage.buffer);
    expect(written.byteOffset).toBe(storage.byteOffset + 1);
  });

  it('does not spawn FFmpeg when output preflight fails', async () => {
    ffmpegMocks.createOutput.mockRejectedValueOnce(new Error('ENOSPC: disk full'));
    await expect(handler('ffmpeg:startStreamExport')(null, '/tmp/output.mp4')).resolves.toMatchObject({ success: false, failureKind: 'output' });
    expect(ffmpegMocks.spawn).not.toHaveBeenCalled();
  });

  it('honors cancellation while the task is being allocated', async () => {
    let allocate!: (value: { partialPath: string; cleanup: ReturnType<typeof vi.fn> }) => void;
    const cleanup = vi.fn().mockResolvedValue(undefined);
    ffmpegMocks.createOutput.mockImplementationOnce(() => new Promise(resolve => { allocate = resolve; }));
    const start = handler('ffmpeg:startStreamExport')(null, '/tmp/output.mp4');
    await vi.waitFor(() => expect(ffmpegMocks.createOutput).toHaveBeenCalled());
    const cancel = handler('ffmpeg:cancelExport')();
    allocate({ partialPath: '/tmp/output.partial.mp4', cleanup });
    await expect(start).resolves.toMatchObject({ success: false, error: 'Export cancelled' });
    await cancel;
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(ffmpegMocks.spawn).not.toHaveBeenCalled();
  });

  it('commits only after FFmpeg has closed and the final disk check succeeds', async () => {
    const child = new FakeChild();
    ffmpegMocks.spawn.mockReturnValue(child);
    await handler('ffmpeg:startStreamExport')(null, '/tmp/output.mp4');
    const output = await ffmpegMocks.createOutput.mock.results[0].value;
    const end = handler('ffmpeg:endStreamExport')();
    await Promise.resolve();
    expect(output.commit).not.toHaveBeenCalled();
    child.emit('close', 0);
    await expect(end).resolves.toMatchObject({ success: true });
    expect(output.checkSpace).toHaveBeenCalledTimes(1);
    expect(output.commit).toHaveBeenCalledTimes(1);
    expect(output.cleanup).toHaveBeenCalledTimes(1);
  });

  it('measures samples without publishing, and cleans them before replying', async () => {
    const child = new FakeChild();
    ffmpegMocks.spawn.mockReturnValue(child);
    await handler('ffmpeg:startStreamExport')(null, '/tmp/sample.mp4', { measureOnly: true });
    const output = await ffmpegMocks.createOutput.mock.results[0].value;
    vi.spyOn(fs.promises, 'stat').mockResolvedValueOnce({ size: 1234 } as fs.Stats);
    const end = handler('ffmpeg:endStreamExport')();
    await Promise.resolve();
    child.emit('close', 0);
    await expect(end).resolves.toMatchObject({ success: true, sizeBytes: 1234 });
    expect(output.commit).not.toHaveBeenCalled();
    expect(output.cleanup).toHaveBeenCalledOnce();
  });

  it('does not publish when cancellation arrives after close during the final disk check', async () => {
    const child = new FakeChild();
    ffmpegMocks.spawn.mockReturnValue(child);
    await handler('ffmpeg:startStreamExport')(null, '/tmp/output.mp4');
    const output = await ffmpegMocks.createOutput.mock.results[0].value;
    let checked!: () => void;
    output.checkSpace.mockImplementationOnce(() => new Promise<void>(resolve => { checked = resolve; }));
    const end = expect(handler('ffmpeg:endStreamExport')()).rejects.toThrow('Export cancelled');
    await Promise.resolve();
    child.emit('close', 0);
    await vi.waitFor(() => expect(output.checkSpace).toHaveBeenCalled());
    await handler('ffmpeg:cancelExport')();
    checked();
    await end;
    expect(output.commit).not.toHaveBeenCalled();
  });

  it('cleans a sample when measuring its size fails', async () => {
    const child = new FakeChild();
    ffmpegMocks.spawn.mockReturnValue(child);
    await handler('ffmpeg:startStreamExport')(null, '/tmp/sample.mp4', { measureOnly: true });
    const output = await ffmpegMocks.createOutput.mock.results[0].value;
    vi.spyOn(fs.promises, 'stat').mockRejectedValueOnce(new Error('sample stat failed'));
    const end = expect(handler('ffmpeg:endStreamExport')()).rejects.toThrow('sample stat failed');
    await Promise.resolve();
    child.emit('close', 0);
    await end;
    expect(output.commit).not.toHaveBeenCalled();
    expect(output.cleanup).toHaveBeenCalledOnce();
  });

  it('cleans a sample if its renderer crashes while size measurement is pending', async () => {
    const owner = Object.assign(new EventEmitter(), { id: 1 });
    const child = new FakeChild();
    ffmpegMocks.spawn.mockReturnValue(child);
    await handler('ffmpeg:startStreamExport')({ sender: owner }, '/tmp/sample.mp4', { measureOnly: true });
    const output = await ffmpegMocks.createOutput.mock.results[0].value;
    let measured!: (stat: fs.Stats) => void;
    const stat = vi.spyOn(fs.promises, 'stat').mockImplementationOnce(() => new Promise(resolve => { measured = resolve; }));
    const end = expect(handler('ffmpeg:endStreamExport')({ sender: owner })).rejects.toThrow('Export window closed');
    await Promise.resolve();
    child.emit('close', 0);
    await vi.waitFor(() => expect(stat).toHaveBeenCalled());
    owner.emit('render-process-gone');
    measured({ size: 1234 } as fs.Stats);
    await end;
    expect(output.commit).not.toHaveBeenCalled();
    expect(output.cleanup).toHaveBeenCalled();
    expect(owner.listenerCount('destroyed')).toBe(0);
  });

  it('waits for an in-flight publication and reports its successful completion', async () => {
    const child = new FakeChild();
    ffmpegMocks.spawn.mockReturnValue(child);
    await handler('ffmpeg:startStreamExport')(null, '/tmp/output.mp4');
    const output = await ffmpegMocks.createOutput.mock.results[0].value;
    let finishPublish!: () => void;
    output.commit.mockImplementation(() => new Promise<void>((resolve) => { finishPublish = resolve; }));

    const ending = handler('ffmpeg:endStreamExport')();
    await vi.waitFor(() => expect(child.stdin.end).toHaveBeenCalled());
    child.emit('close', 0);
    await vi.waitFor(() => expect(output.commit).toHaveBeenCalled());

    const cancellation = handler('ffmpeg:cancelExport')();
    let cancellationSettled = false;
    void cancellation.then(() => { cancellationSettled = true; });
    await Promise.resolve();
    expect(child.kill).not.toHaveBeenCalled();
    expect(cancellationSettled).toBe(false);

    finishPublish();
    await expect(ending).resolves.toMatchObject({ success: true });
    await expect(cancellation).resolves.toMatchObject({ success: true });
    expect(output.cleanup).toHaveBeenCalled();
  });

  it('terminates blocked writes when periodic disk checks find insufficient space', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      child.stdin.write.mockImplementation(() => false);
      ffmpegMocks.spawn.mockReturnValue(child);
      await handler('ffmpeg:startStreamExport')(null, '/tmp/output.mp4');
      const output = await ffmpegMocks.createOutput.mock.results[0].value;
      output.checkSpace.mockRejectedValue(new Error('ENOSPC: disk full'));
      const push = expect(handler('ffmpeg:pushEncodedChunk')(null, new Uint8Array(4))).rejects.toThrow('ENOSPC');
      await vi.advanceTimersByTimeAsync(2000);
      await push;
      await expect(handler('ffmpeg:endStreamExport')()).rejects.toThrow('ENOSPC');
      expect(child.kill).toHaveBeenCalled();
      expect(output.commit).not.toHaveBeenCalled();
      expect(output.cleanup).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('forwards encoder diagnostics through the Electron window bridge', async () => {
    const child = new FakeChild();
    const send = vi.fn();
    ffmpegMocks.spawn.mockReturnValue(child);
    ffmpegMocks.getAllWindows.mockReturnValue([{ webContents: { send } }]);
    await handler('ffmpeg:startStreamExport')(null, '/tmp/output.mp4');

    child.stderr.emit('data', Buffer.from('hevc_nvenc: No capable devices found'));

    expect(send).toHaveBeenCalledWith('ffmpeg:log', 'hevc_nvenc: No capable devices found');
  });

  it('preserves late encoder diagnostics after an initial broken pipe', async () => {
    const remove = vi.spyOn(fs.promises, 'rm').mockRejectedValue(new Error('Unexpected filesystem cleanup'));
    const child = new FakeChild();
    ffmpegMocks.spawn.mockReturnValue(child);
    await handler('ffmpeg:startStreamExport')(null, '/tmp/output.mp4');
    child.stdin.write.mockImplementation(() => false);
    child.kill.mockImplementation(() => {});
    const push = handler('ffmpeg:pushEncodedChunk')(null, new Uint8Array(4));
    const settled = vi.fn();
    void push.then(settled, settled);
    const rejectedPush = expect(push).rejects.toThrow('No capable devices found');
    child.stdin.emit('error', new Error('EPIPE'));
    expect(child.kill).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    child.stderr.emit('data', Buffer.from('hevc_nvenc: No capable devices found'));
    child.emit('close', 1);
    await rejectedPush;
    await handler('ffmpeg:cancelExport')();
    expect(remove).not.toHaveBeenCalled();
  });

  it('closes input and escalates termination before cleaning an unresponsive process', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      child.kill.mockImplementation(() => {});
      ffmpegMocks.spawn.mockReturnValue(child);
      await handler('ffmpeg:startStreamExport')(null, '/tmp/output.mp4');
      const output = await ffmpegMocks.createOutput.mock.results[0].value;
      const cancel = handler('ffmpeg:cancelExport')();
      expect(child.stdin.destroy).toHaveBeenCalledTimes(1);
      expect(output.cleanup).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3000);
      expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
      expect(output.cleanup).not.toHaveBeenCalled();
      child.emit('close', null, 'SIGKILL');
      await cancel;
      expect(output.cleanup).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('keeps stream ownership with its window and cleans up when its renderer crashes', async () => {
    const owner = Object.assign(new EventEmitter(), { id: 1 });
    const other = { sender: { id: 2 } };
    const child = new FakeChild();
    ffmpegMocks.spawn.mockReturnValue(child);
    await handler('ffmpeg:startStreamExport')({ sender: owner }, '/tmp/output.mp4');
    const output = await ffmpegMocks.createOutput.mock.results[0].value;
    await expect(handler('ffmpeg:pushEncodedChunk')(other, new Uint8Array(4))).rejects.toThrow('another window');
    await expect(handler('ffmpeg:cancelExport')(other)).resolves.toMatchObject({ success: false });
    expect(child.kill).not.toHaveBeenCalled();
    owner.emit('render-process-gone');
    await vi.waitFor(() => expect(output.cleanup).toHaveBeenCalled());
    expect(child.kill).toHaveBeenCalled();
    expect(output.commit).not.toHaveBeenCalled();
    expect(owner.listenerCount('destroyed')).toBe(0);
  });

  it.each(['callback-first', 'drain-first'])('waits for callback and drain (%s) before acknowledging or ending', async (order) => {
    const child = new FakeChild();
    let callback!: (error?: Error) => void;
    child.stdin.write.mockImplementation((_buffer, onWrite) => { callback = onWrite; return false; });
    ffmpegMocks.spawn.mockReturnValue(child);
    await handler('ffmpeg:startStreamExport')(null, '/tmp/output.mp4', { width: 1, height: 1 });
    const acknowledged = vi.fn();
    const push = handler('ffmpeg:pushFrame')(null, new Uint8Array(4)).then(acknowledged);
    const finishing = handler('ffmpeg:endStreamExport')();
    if (order === 'callback-first') callback();
    else child.stdin.emit('drain');
    await Promise.resolve();
    expect(acknowledged).not.toHaveBeenCalled();
    expect(child.stdin.end).not.toHaveBeenCalled();
    if (order === 'callback-first') child.stdin.emit('drain');
    else callback();
    await push;
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(child.stdin.listenerCount('drain')).toBe(0);
    child.emit('close', 0);
    await expect(finishing).resolves.toEqual({ success: true, code: 0 });
  });

  it('removes drain listeners when a blocked write fails', async () => {
    const child = new FakeChild();
    child.stdin.write.mockImplementation(() => false);
    ffmpegMocks.spawn.mockReturnValue(child);
    await handler('ffmpeg:startStreamExport')(null, '/tmp/output.mp4', { width: 1, height: 1 });
    const push = handler('ffmpeg:pushFrame')(null, new Uint8Array(4));
    expect(child.stdin.listenerCount('drain')).toBe(1);
    child.stdin.emit('error', new Error('broken pipe'));
    await expect(push).rejects.toThrow('broken pipe');
    expect(child.stdin.listenerCount('drain')).toBe(0);
  });

  it('rejects unfinished writes even if FFmpeg exits with code zero during finalization', async () => {
    const child = new FakeChild();
    child.stdin.write.mockImplementation(() => false);
    ffmpegMocks.spawn.mockReturnValue(child);
    await handler('ffmpeg:startStreamExport')(null, '/tmp/output.mp4', { width: 1, height: 1 });
    const push = expect(handler('ffmpeg:pushFrame')(null, new Uint8Array(4))).rejects.toThrow('pending writes');
    const finish = expect(handler('ffmpeg:endStreamExport')()).rejects.toThrow('pending writes');
    child.emit('close', 0);
    await Promise.all([push, finish]);
    expect(child.stdin.listenerCount('drain')).toBe(0);
  });

  it('shares one drain listener across concurrent blocked chunks', async () => {
    const child = new FakeChild();
    const callbacks: Array<() => void> = [];
    child.stdin.write.mockImplementation((_buffer, callback) => {
      callbacks.push(callback);
      return false;
    });
    ffmpegMocks.spawn.mockReturnValue(child);
    await handler('ffmpeg:startStreamExport')(null, '/tmp/output.mp4', { isEncoded: true });
    const pushes = Array.from({ length: 32 }, () => handler('ffmpeg:pushEncodedChunk')(null, new Uint8Array(4)));
    expect(child.stdin.listenerCount('drain')).toBe(1);
    for (const callback of callbacks) callback();
    child.stdin.emit('drain');
    await Promise.all(pushes);
    expect(child.stdin.listenerCount('drain')).toBe(0);
  });

  it('kills a blocked stream, rejects pending writes, and cleans output after close', async () => {
    const child = new FakeChild();
    child.stdin.write.mockImplementation(() => false);
    child.kill.mockImplementation(() => {});
    ffmpegMocks.spawn.mockReturnValue(child);
    await handler('ffmpeg:startStreamExport')(null, '/tmp/cancelled.mp4', { width: 1, height: 1 });
    const output = await ffmpegMocks.createOutput.mock.results[0].value;
    const push = handler('ffmpeg:pushFrame')(null, new Uint8Array(4));
    const rejectedPush = expect(push).rejects.toThrow('Export cancelled');
    const cancellation = handler('ffmpeg:cancelExport')();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(output.cleanup).not.toHaveBeenCalled();
    child.emit('close', null, 'SIGTERM');
    await rejectedPush;
    await expect(cancellation).resolves.toEqual({ success: true });
    expect(output.cleanup).toHaveBeenCalledTimes(1);
    await expect(handler('ffmpeg:pushFrame')(null, new Uint8Array(4))).rejects.toThrow('No active FFmpeg process');
  });

  it('kills conversion, returns cancellation even on exit code zero, and removes its output', async () => {
    const remove = vi.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    const child = new FakeChild();
    ffmpegMocks.spawn.mockReturnValue(child);
    const conversion = handler('ffmpeg:convert')(null, '/tmp/input.mp4', '/tmp/cancelled.mp4');
    const cancellation = handler('ffmpeg:cancelExport')();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    child.emit('close', 0, null);
    await expect(conversion).resolves.toEqual({ success: false, error: 'Export cancelled' });
    await cancellation;
    expect(remove).toHaveBeenCalledWith('/tmp/cancelled.mp4', { force: true });
    expect(remove).not.toHaveBeenCalledWith('/tmp/input.mp4', expect.anything());
  });

  it('can cancel while waiting for FFmpeg to finalize the stream', async () => {
    vi.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    const child = new FakeChild();
    ffmpegMocks.spawn.mockReturnValue(child);
    await handler('ffmpeg:startStreamExport')(null, '/tmp/cancelled.mp4', { width: 1, height: 1 });
    const finishing = handler('ffmpeg:endStreamExport')();
    const rejectedFinish = expect(finishing).rejects.toThrow('Export cancelled');
    const cancellation = handler('ffmpeg:cancelExport')();
    child.emit('close', null, 'SIGTERM');
    await rejectedFinish;
    await cancellation;
  });

  it('returns a failed convert result for an FFmpeg process error', async () => {
    const child = new FakeChild();
    ffmpegMocks.spawn.mockReturnValue(child);

    const resultPromise = handler('ffmpeg:convert')(null, '/tmp/input.mp4', '/tmp/output.mp4');
    child.emit('error', new Error('spawn unavailable'));

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.error).toContain('spawn unavailable');
  });

  it('returns a failed convert result when spawn throws synchronously', async () => {
    ffmpegMocks.spawn.mockImplementation(() => {
      throw new Error('ffmpeg executable missing');
    });

    const result = await handler('ffmpeg:convert')(null, '/tmp/input.mp4', '/tmp/output.mp4');

    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: expect.stringContaining('ffmpeg executable missing'),
    }));
  });

  it('assigns timestamps to raw H.264 packets before MP4 muxing', async () => {
    const child = new FakeChild();
    ffmpegMocks.spawn.mockReturnValue(child);

    const result = await handler('ffmpeg:startStreamExport')(null, '/tmp/output.mp4', {
      fps: 30,
      isEncoded: true,
    });

    expect(result.success).toBe(true);
    expect(ffmpegMocks.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['-bsf:v', 'setts=pts=N:dts=N']),
    );
  });

  it('encodes raw pixels with a 10-bit 4:4:4 alpha format for ProRes 4444 subtitle exports', async () => {
    const child = new FakeChild();
    ffmpegMocks.spawn.mockReturnValue(child);

    const result = await handler('ffmpeg:startStreamExport')(null, '/tmp/output.mov', {
      fps: 30,
      codec: 'prores_ks',
      transparent: true,
    });

    expect(result.success).toBe(true);
    expect(ffmpegMocks.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['-c:v', 'prores_ks']),
    );
    expect(ffmpegMocks.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['-profile:v', '4444']),
    );
    expect(ffmpegMocks.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['-pix_fmt', 'yuva444p10le']),
    );
  });

  it('returns a failed convert result for a stderr stream error and never overwrites it with close success', async () => {
    const child = new FakeChild();
    ffmpegMocks.spawn.mockReturnValue(child);

    const resultPromise = handler('ffmpeg:convert')(null, '/tmp/input.mp4', '/tmp/output.mp4');
    child.stderr.emit('error', new Error('stderr closed'));
    child.emit('close', 0, null);

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.error).toContain('stderr closed');
  });

  it('rejects stream pushes and end when FFmpeg exits non-zero', async () => {
    const child = new FakeChild();
    ffmpegMocks.spawn.mockReturnValue(child);

    const startResult = await handler('ffmpeg:startStreamExport')(null, '/tmp/output.mp4', {
      width: 1,
      height: 1,
      fps: 30,
    });
    expect(startResult.success).toBe(true);

    child.emit('exit', 7, null);
    child.emit('close', 7, null);

    await expect(handler('ffmpeg:pushFrame')(null, new Uint8Array(4))).rejects.toThrow(/code 7/i);
    await expect(handler('ffmpeg:endStreamExport')()).rejects.toThrow(/code 7/i);
  });

  it('rejects a pending stream write when stdin reports an error', async () => {
    const child = new FakeChild();
    ffmpegMocks.spawn.mockReturnValue(child);

    await handler('ffmpeg:startStreamExport')(null, '/tmp/output.mp4', {
      width: 1,
      height: 1,
    });
    child.stdin.write.mockImplementation(() => false);
    const pushPromise = handler('ffmpeg:pushFrame')(null, new Uint8Array(4));
    child.stdin.emit('error', new Error('broken pipe'));

    await expect(pushPromise).rejects.toThrow(/broken pipe/i);
    await expect(handler('ffmpeg:endStreamExport')()).rejects.toThrow(/broken pipe/i);
  });

  it('records a synchronous write callback failure before returning the push rejection', async () => {
    const child = new FakeChild();
    ffmpegMocks.spawn.mockReturnValue(child);

    const startResult = await handler('ffmpeg:startStreamExport')(null, '/tmp/output.mp4', {
      width: 1,
      height: 1,
    });
    expect(startResult.success).toBe(true);

    child.stdin.write.mockImplementation((_buffer: Buffer, callback: (error?: Error) => void) => {
      callback(new Error('sync broken pipe'));
      return true;
    });

    await expect(handler('ffmpeg:pushFrame')(null, new Uint8Array(4))).rejects.toThrow(/sync broken pipe/i);
    await expect(handler('ffmpeg:endStreamExport')()).rejects.toThrow(/sync broken pipe/i);
  });

  it('rejects writes when the FFmpeg stdin closes before end', async () => {
    const child = new FakeChild();
    ffmpegMocks.spawn.mockReturnValue(child);

    const startResult = await handler('ffmpeg:startStreamExport')(null, '/tmp/output.mp4', {
      width: 1,
      height: 1,
    });
    expect(startResult.success).toBe(true);

    child.stdin.emit('close');

    await expect(handler('ffmpeg:pushFrame')(null, new Uint8Array(4))).rejects.toThrow(/stdin closed/i);
    await expect(handler('ffmpeg:endStreamExport')()).rejects.toThrow(/stdin closed/i);
  });

  it('returns success:false when stream spawn has no writable stdin', async () => {
    const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    child.kill = vi.fn();
    (child as any).stdin = null;
    ffmpegMocks.spawn.mockReturnValue(child);

    const result = await handler('ffmpeg:startStreamExport')(null, '/tmp/output.mp4', {
      width: 1,
      height: 1,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('writable stdin');
    expect(child.kill).toHaveBeenCalled();
  });
});
