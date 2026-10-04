import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ffmpegMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  spawn: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
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

import { registerFFmpegHandlers, resolveFfmpegExecutablePath } from '../../electron/ffmpeg-export';

class FakeInput extends EventEmitter {
  end = vi.fn();
  write = vi.fn((_buffer: Buffer, callback: (error?: Error) => void) => {
    callback();
    return true;
  });
}

class FakeChild extends EventEmitter {
  stdin = new FakeInput();
  stderr = new EventEmitter();
  kill = vi.fn();
}

function handler(name: string): (...args: any[]) => any {
  const value = ffmpegMocks.handlers.get(name);
  if (!value) throw new Error(`Missing IPC handler: ${name}`);
  return value;
}

describe('FFmpeg export failure seam', () => {
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
    ffmpegMocks.handlers.clear();
    ffmpegMocks.spawn.mockReset();
    registerFFmpegHandlers();
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
