import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, callback: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, callback) },
  dialog: {},
  BrowserWindow: { getAllWindows: () => [] },
}));
import { registerFFmpegHandlers } from '../../electron/ffmpeg-export';

function invoke(name: string, ...args: unknown[]): Promise<unknown> {
  const callback = handlers.get(`ffmpeg:${name}`);
  if (!callback) throw new Error(`Missing export handler: ${name}`);
  return callback(undefined, ...args);
}

function media(args: string[]): Buffer {
  if (!ffmpeg) throw new Error('Bundled FFmpeg is unavailable');
  const result = spawnSync(ffmpeg, ['-v', 'error', ...args], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  expect(result.status, result.stderr?.toString() ?? result.error?.message).toBe(0);
  return result.stdout;
}

describe('streaming export through main-process handlers', () => {
  let directory: string;
  let output: string;
  beforeEach(async () => {
    handlers.clear();
    registerFFmpegHandlers();
    directory = await fs.mkdtemp(join(tmpdir(), 'aeon-stream-integration-'));
    output = join(directory, 'final.mp4');
    await fs.writeFile(output, 'original');
  });
  afterEach(async () => {
    await invoke('cancelExport');
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('streams H.264 into HEVC with audio and publishes only the completed file', async () => {
    const audio = join(directory, 'audio.wav');
    media(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', audio]);
    const h264 = media(['-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=30', '-frames:v', '9', '-c:v', 'libx264', '-bf', '0', '-f', 'h264', '-']);
    expect(await invoke('startStreamExport', output, {
      inputFormat: 'h264', fps: 30, width: 64, height: 64, totalFrames: 9,
      transcode: { codec: 'libx265', crf: 24, speed: 'fast' },
      audioSources: [{ path: audio, delayMs: 0 }],
    })).toMatchObject({ success: true });
    for (let offset = 0; offset < h264.length; offset += 256) {
      expect(await invoke('pushEncodedChunk', h264.subarray(offset, offset + 256))).toMatchObject({ success: true });
    }
    expect(await fs.readFile(output, 'utf8')).toBe('original');
    expect(await invoke('endStreamExport')).toMatchObject({ success: true });
    expect((await fs.readdir(directory)).sort()).toEqual(['audio.wav', 'final.mp4']);
    const frames = media(['-i', output, '-map', '0:v', '-f', 'framemd5', '-']).toString().split('\n').filter(line => /^0,/.test(line));
    expect(frames).toHaveLength(9);
    expect(media(['-i', output, '-map', '0:a', '-f', 'f32le', '-']).length).toBeGreaterThan(0);
  });

  it('waits for a real FFmpeg process to close before removing cancelled output', async () => {
    expect(await invoke('startStreamExport', output, { width: 16, height: 16, fps: 30, codec: 'libx264' })).toMatchObject({ success: true });
    expect(await invoke('pushFrame', new Uint8Array(16 * 16 * 4))).toMatchObject({ success: true });
    expect(await invoke('cancelExport')).toMatchObject({ success: true });
    expect(await fs.readFile(output, 'utf8')).toBe('original');
    expect(await fs.readdir(directory)).toEqual(['final.mp4']);
  });
});
