import { describe, expect, it } from 'vitest';
import { buildFFmpegConvertArgs } from '../../electron/ffmpeg-args';

function filterComplex(args: string[]): string {
  const index = args.indexOf('-filter_complex');
  expect(index).toBeGreaterThanOrEqual(0);
  return args[index + 1];
}

function evaluateGeneratedVolume(filter: string, time: number): number {
  const match = /volume='if\(lt\(t,([^)]*)\),(.+),(.+)\)':eval=frame/.exec(filter);
  expect(match).not.toBeNull();
  const duration = Number(match![1]);
  const branch = time < duration ? match![2] : match![3];
  // The expression comes directly from buildFFmpegConvertArgs and is limited
  // to numeric arithmetic plus the FFmpeg `t` variable.
  return Function('t', `return ${branch}`)(time) as number;
}

function generatedVolumeFilters(filter: string): string[] {
  return filter.match(/volume='[^']+':eval=frame/g) ?? [];
}

describe('FFmpeg convert args', () => {
  it('caps mixed audio output to the exported video duration', () => {
    const args = buildFFmpegConvertArgs('/tmp/video.mp4', '/out/final.mp4', {
      fps: 30,
      totalFrames: 150,
      audioSources: [
        { path: '/audio/long-bgm.mp3', delayMs: 0 },
      ],
    }, () => true);

    expect(args).toContain('-shortest');
    expect(args.slice(-3)).toEqual(['-t', '5', '/out/final.mp4']);
  });

  it('applies trim, offset, volume, fades, delay, and looping per source', () => {
    const args = buildFFmpegConvertArgs('/tmp/video.mp4', '/out/final.mp4', {
      fps: 60,
      totalFrames: 600,
      audioSources: [
        {
          path: '/audio/theme.mp3',
          delayMs: 1000,
          startOffset: 3,
          duration: 5,
          volume: 0,
          fadeIn: 0.5,
          fadeOut: 2,
          loop: true,
        },
      ],
    }, () => true);

    expect(args).toEqual(expect.arrayContaining(['-stream_loop', '-1', '-i', '/audio/theme.mp3']));
    const filters = filterComplex(args);
    expect(filters).toContain('atrim=start=3:end=8');
    expect(filters).toContain('volume=0');
    expect(filters).toContain('afade=t=in:st=0:d=0.5');
    expect(filters).toContain('afade=t=out:st=3:d=2');
    expect(filters).toContain('adelay=1000|1000');
  });

  it('filters out missing audio sources before adding inputs', () => {
    const args = buildFFmpegConvertArgs('/tmp/video.mp4', '/out/final.mp4', {
      audioSources: [
        { path: '/missing.wav', delayMs: 0 },
      ],
    }, () => false);

    expect(args).not.toContain('/missing.wav');
    expect(args).toContain('-an');
  });

  it('uses an audio codec compatible with the requested container', () => {
    const args = buildFFmpegConvertArgs('/tmp/video.webm', '/out/final.webm', {
      audioCodec: 'libopus',
      audioSources: [{ path: '/audio/voice.wav', delayMs: 0 }],
    }, () => true);

    expect(args).toEqual(expect.arrayContaining(['-c:a', 'libopus', '-b:a', '128k']));
  });

  it('preserves the alpha channel with ProRes 4444 in MOV when transparent is requested', () => {
    const args = buildFFmpegConvertArgs('/tmp/video.mov', '/out/final.mov', {
      fps: 60,
      codec: 'prores_ks',
      transparent: true,
      width: 1920,
      height: 1080,
    }, () => true);

    expect(args).toEqual(expect.arrayContaining(['-c:v', 'prores_ks']));
    expect(args).toEqual(expect.arrayContaining(['-profile:v', '4444']));
    expect(args).toEqual(expect.arrayContaining(['-pix_fmt', 'yuva444p10le']));
    expect(args).not.toEqual(expect.arrayContaining(['-pix_fmt', 'yuva420p']));
  });

  it('keeps export fades aligned when the range begins inside the source interval', () => {
    const args = buildFFmpegConvertArgs('/tmp/video.mp4', '/out/final.mp4', {
      fps: 60,
      totalFrames: 180,
      audioSources: [
        {
          path: '/audio/door.wav',
          delayMs: 0,
          startOffset: 2,
          duration: 3,
          volume: 0.8,
          fadeIn: 2,
          fadeOut: 2,
          fadeInStartGain: 0.5,
          fadeOutStartGain: 0.5,
        },
      ],
    }, () => true);

    const filters = filterComplex(args);
    expect(filters).toContain('atrim=start=2:end=5');
    expect(filters).toContain('volume=0.8');
    expect(filters).toContain("volume='if(lt(t,2),0.5+(1-0.5)*t/2,1)':eval=frame");
    expect(filters).toContain("volume='if(lt(t,2),0.5*(1-t/2),0)':eval=frame");
    expect(filters).not.toContain('afade=t=in:st=0:d=2');
    expect(filters).not.toContain('afade=t=out:st=1:d=2');

    const [midFadeIn, midFadeOut] = generatedVolumeFilters(filters);
    expect(midFadeIn).toBeDefined();
    expect(midFadeOut).toBeDefined();
    expect(evaluateGeneratedVolume(midFadeIn!, 0)).toBeCloseTo(0.5);
    expect(evaluateGeneratedVolume(midFadeIn!, 1)).toBeCloseTo(0.75);
    expect(evaluateGeneratedVolume(midFadeIn!, 2)).toBeCloseTo(1);
    expect(evaluateGeneratedVolume(midFadeOut!, 0)).toBeCloseTo(0.5);
    expect(evaluateGeneratedVolume(midFadeOut!, 1)).toBeCloseTo(0.25);
    expect(evaluateGeneratedVolume(midFadeOut!, 2)).toBeCloseTo(0);
  });
});
