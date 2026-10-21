import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { afterAll, describe, expect, it } from 'vitest';
import { buildFFmpegConvertArgs, buildFFmpegStreamArgs, buildFFmpegVideoArgs } from '../../electron/ffmpeg-args';
import { EncodedVideoStreamWriter } from '../engine/export/WebCodecsEncoding';

const directory = mkdtempSync(join(tmpdir(), 'aeon-export-media-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function run(args: string[], input?: Uint8Array): Buffer {
  if (!ffmpeg) throw new Error('Bundled FFmpeg is unavailable');
  const result = spawnSync(ffmpeg, ['-v', 'error', ...args], { input, timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  expect(result.error?.message ?? (result.status === 0 ? '' : result.stderr.toString())).toBe('');
  expect(result.status, result.stderr.toString()).toBe(0);
  return result.stdout;
}

function frameHashes(input: string): string[] {
  return run(['-i', input, '-f', 'framemd5', '-']).toString().split('\n').filter(line => /^0,/.test(line)).map(line => line.split(',').at(-1)!.trim());
}

describe('bundled FFmpeg export media', () => {
  it.each([
    ['raw', 'mp4'], ['copy', 'mp4'], ['transcode', 'mp4'],
    ['raw', 'mkv'], ['copy', 'mkv'], ['transcode', 'mkv'],
  ] as const)('mixes delayed audio during %s streaming in %s without losing fractional-rate tail frames', (mode, container) => {
    const fps = 30000 / 1001;
    const output = join(directory, `stream-${mode}.${container}`);
    const audio = join(directory, `stream-${mode}.wav`);
    run(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1', audio]);
    const pixels = run(['-f', 'lavfi', '-i', `testsrc2=size=64x64:rate=${fps}`, '-frames:v', '9', '-pix_fmt', 'rgba', '-threads', '1', '-f', 'rawvideo', '-']);
    const h264 = mode === 'raw' ? undefined : run([
      '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', '64x64', '-framerate', String(fps), '-i', '-',
      '-c:v', 'libx264', '-bf', '0', '-f', 'h264', '-',
    ], pixels);
    run(buildFFmpegStreamArgs(output, {
      inputFormat: mode === 'raw' ? 'rgba' : 'h264', codec: 'libx264', crf: 18,
      width: 64, height: 64, fps, totalFrames: 9,
      audioSources: [{ path: audio, delayMs: 150, volume: 0.5, fadeIn: 0.02, fadeOut: 0.02 }],
      ...(mode === 'transcode' ? { transcode: { codec: 'libx265', crf: 24, speed: 'fast' } } : {}),
    }), h264 ?? pixels);
    const hashes = frameHashes(output);
    expect(hashes).toHaveLength(9);
    const timestamps = run(['-i', output, '-map', '0:v', '-f', 'framemd5', '-']).toString();
    expect(timestamps).toContain('#tb 0: 1001/30000');
    const pcm = run(['-i', output, '-map', '0:a', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']);
    const amplitudes = Array.from({ length: pcm.length / 4 }, (_, i) => Math.abs(pcm.readFloatLE(i * 4)));
    expect(Math.max(...amplitudes.slice(0, 4800))).toBeLessThan(0.001);
    expect(Math.max(...amplitudes.slice(8500, 11000))).toBeGreaterThan(0.01);
    expect(amplitudes.length / 48000).toBeCloseTo(9 / fps, 1);
  });

  it.each([
    ['libx264', 'mp4'], ['libx265', 'mp4'], ['libvpx-vp9', 'webm'], ['libaom-av1', 'webm'], ['libaom-av1', 'mp4'],
    ['libx264', 'mkv'], ['libx265', 'mkv'], ['libvpx-vp9', 'mkv'], ['libaom-av1', 'mkv'],
  ] as const)('encodes RGBA with %s in %s and copies frames through audio muxing', (codec, container) => {
    const path = join(directory, `${codec}.${container}`), mixed = join(directory, `${codec}-mixed.${container}`);
    const pixels = run(['-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=30000/1001', '-frames:v', '3', '-pix_fmt', 'rgba', '-threads', '1', '-f', 'rawvideo', '-']);
    run(buildFFmpegStreamArgs(path, { codec, crf: codec === 'libx264' || codec === 'libx265' ? 20 : 30, speed: 'fast', width: 64, height: 64, fps: 30000 / 1001 }), pixels);
    const hashes = frameHashes(path);
    expect(hashes).toHaveLength(3);
    const audio = join(directory, 'audio.wav');
    run(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', audio]);
    run(buildFFmpegConvertArgs(path, mixed, { codec: 'copy', fps: 30000 / 1001, totalFrames: 3,
      audioSources: [{ path: audio, delayMs: 0 }], audioCodec: container === 'webm' ? 'libopus' : 'aac' }));
    expect(frameHashes(mixed)).toEqual(hashes);
    const timestamps = run(['-i', mixed, '-f', 'framemd5', '-']).toString();
    expect(timestamps).toContain('#tb 0: 1001/30000');
  });

  it.each([['vp9', 'libvpx-vp9'], ['av1', 'libaom-av1']] as const)('muxes actual %s packets through the WebCodecs IVF writer', (videoCodec, encoder) => {
    const source = join(directory, `${videoCodec}-source.ivf`), output = join(directory, `${videoCodec}-native.webm`);
    const ivf = run(['-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=29.97', '-frames:v', '3',
      ...buildFFmpegVideoArgs({ codec: encoder, crf: 30, speed: 'fast' }, 29.97), '-f', 'ivf', '-']);
    // Save the reference with FFmpeg, then feed the same frame payloads through
    // the streaming envelope used for WebCodecs output.
    run(['-y', '-f', 'ivf', '-i', '-', '-c:v', 'copy', source], ivf);
    const writer = new EncodedVideoStreamWriter(videoCodec, 64, 64, 29.97);
    const chunks: Uint8Array[] = [];
    let offset = 32, index = 0;
    while (offset < ivf.length) {
      const size = ivf.readUInt32LE(offset), bytes = ivf.subarray(offset + 12, offset + 12 + size);
      const chunk: EncodedVideoChunk = {
        type: index === 0 ? 'key' : 'delta', byteLength: size, timestamp: Math.round(index * 1e6 / 29.97), duration: null,
        copyTo(destination) {
          const target = ArrayBuffer.isView(destination) ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength) : new Uint8Array(destination);
          target.set(bytes);
        },
      };
      chunks.push(writer.write(chunk)); offset += 12 + size; index++;
    }
    run(buildFFmpegStreamArgs(output, { inputFormat: 'ivf', codec: encoder, fps: 29.97 }), Buffer.concat(chunks));
    expect(frameHashes(output)).toEqual(frameHashes(source));
  });
});
