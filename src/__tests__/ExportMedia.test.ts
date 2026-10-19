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
    ['libx264', 'mp4'], ['libx265', 'mp4'], ['libvpx-vp9', 'webm'], ['libaom-av1', 'webm'], ['libaom-av1', 'mp4'],
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
