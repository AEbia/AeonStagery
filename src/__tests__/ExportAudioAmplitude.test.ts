import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { buildFFmpegConvertArgs } from '../../electron/ffmpeg-args';

const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string;

describe('export audio amplitude', () => {
  it.each([2, 8])('preserves voice gain with %i sequential dialogue inputs', (inputCount) => {
    const args = buildFFmpegConvertArgs('video', 'output', {
      audioSources: Array.from({ length: inputCount }, (_, index) => ({ path: `voice-${index}`, delayMs: index * 1000 })),
    });
    const graph = args[args.indexOf('-filter_complex') + 1];
    const pcm = execFileSync(ffmpeg, [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=s=2x2:d=2',
      ...Array.from({ length: inputCount }, () => ['-f', 'lavfi', '-i', 'aevalsrc=0.2:s=8000:d=0.5']).flat(),
      '-filter_complex', graph, '-map', '[aout]', '-t', '0.25',
      '-f', 'f32le', '-ac', '1', 'pipe:1',
    ], { maxBuffer: 128 * 1024 });
    expect(pcm.readFloatLE(400)).toBeCloseTo(0.2, 3);
  });
});
