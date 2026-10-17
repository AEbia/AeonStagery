import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Cubism3MotionSamplingError,
  loadCubism3Motion,
  resolveCubism3MotionMeta,
  type Cubism3MotionSamplerTarget,
} from '../engine/live2d/cubism3MotionSampler';

const source = {
  Version: 3,
  Meta: { Duration: 1.5, FadeInTime: 0.2, FadeOutTime: 0.1 },
  Curves: [{
    Target: 'Parameter',
    Id: 'ParamAngleX',
    Segments: [0, 0, 0, 1.5, 30],
  }],
};

function target(): Cubism3MotionSamplerTarget {
  return {
    kind: 'cubism3-plus',
    settings: {
      motions: { angry: [{ File: 'motions/angry.motion3.json' }] },
      resolveURL: (file: string) => `asset://model/${file}`,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Cubism 3 motion sampler', () => {
  it('resolves a model motion file and parses it once', async () => {
    const fetchFile = vi.fn(async (url: string) => {
      expect(url).toBe('asset://model/motions/angry.motion3.json');
      return new TextEncoder().encode(JSON.stringify(source)).buffer;
    });

    const parsed = await loadCubism3Motion(target(), 'angry', fetchFile);
    expect(fetchFile).toHaveBeenCalledTimes(1);
    expect(parsed.motion.derivedFrom).toEqual({
      key: 'angry',
      fadeInSeconds: 0.2,
      fadeOutSeconds: 0.1,
    });
    await expect(resolveCubism3MotionMeta(target(), 'angry', fetchFile)).resolves.toEqual({
      durationSeconds: 1.5,
      fadeInSeconds: 0.2,
      fadeOutSeconds: 0.1,
      hasNonParameterCurves: false,
    });
  });

  it('supports lowercase File aliases used by normalized settings', async () => {
    const fetchFile = vi.fn(async () => new TextEncoder().encode(JSON.stringify(source)).buffer);
    const normalized = target();
    const settings = normalized.settings as { motions: Record<string, unknown>; resolveURL: (file: string) => string };
    settings.motions = { angry: [{ file: 'angry.motion3.json' }] };
    await expect(loadCubism3Motion(normalized, 'angry', fetchFile)).resolves.toBeTruthy();
  });

  it('reports missing definitions and malformed resources as typed misses', async () => {
    await expect(loadCubism3Motion(target(), 'missing', async () => new ArrayBuffer(0)))
      .rejects.toMatchObject({ code: 'motion-not-found' } satisfies Partial<Cubism3MotionSamplingError>);
    await expect(loadCubism3Motion(target(), 'angry', async () => new TextEncoder().encode('{bad').buffer))
      .rejects.toMatchObject({ code: 'invalid-motion' } satisfies Partial<Cubism3MotionSamplingError>);
  });
});
