/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import {
  MotionCurveCacheService,
  motionCurveCacheKey,
  isIdleMotionKey,
  resolveEffectiveCubism2FadeInSeconds,
  estimateCachedMotionBytes,
  RESOURCE_MOTION_CACHE_BUDGET_BYTES,
  MOTION_CURVE_KEYFRAME_ESTIMATED_BYTES,
  MOTION_CURVE_TRACK_OVERHEAD_ESTIMATED_BYTES,
  RESOURCE_MOTION_CACHE_MAX_REJECTED_ENTRIES,
  type MotionCurveCacheSampler,
  type MotionCurveCacheSource,
  type CachedResourceMotion,
} from '../engine/live2d/motionCurveCache';
import type { Cubism2MotionSamplerTarget } from '../engine/live2d/cubism2MotionSampler';

function fakeTarget(): Cubism2MotionSamplerTarget {
  return { internalModel: {}, motionManager: {} } as unknown as Cubism2MotionSamplerTarget;
}

function waveCurves() {
  return [
    {
      parameterId: 'PARAM_ANGLE_X',
      samples: [
        { time: 0, value: 0 },
        { time: 0.5, value: 10 },
        { time: 1, value: 20 },
        { time: 1.5, value: 30 },
        { time: 2, value: 30 },
      ],
    },
    {
      parameterId: 'PARAM_EYE_OPEN',
      samples: [
        { time: 0, value: 1 },
        { time: 0.5, value: 0.5 },
        { time: 1, value: 0 },
        { time: 1.5, value: 0.5 },
        { time: 2, value: 1 },
      ],
    },
  ];
}

function makeSource(overrides: Partial<MotionCurveCacheSource> = {}): MotionCurveCacheSource {
  return {
    adapterId: 'pixi-live2d-display-cubism2',
    modelRuntimePath: 'asset://models/char.model3.json',
    motionKey: 'wave',
    targets: [fakeTarget()],
    fps: 2,
    ...overrides,
  };
}

function makeSampler(overrides: Partial<MotionCurveCacheSampler> = {}): MotionCurveCacheSampler {
  return {
    resolveMeta: vi.fn(async () => ({ durationSeconds: 2, fadeInSeconds: 0.5, fadeOutSeconds: 0.25 })),
    sample: vi.fn(async () => waveCurves()),
    merge: vi.fn((curves) => (curves[0] ?? []) as readonly any[]),
    ...overrides,
  };
}

describe('motionCurveCache service', () => {
  it('builds a per-frame derived custom motion and caches it', async () => {
    const sampler = makeSampler();
    const cache = new MotionCurveCacheService(sampler);
    const entry = await cache.ensure(makeSource());

    expect(entry).not.toBeNull();
    expect(cache.size).toBe(1);
    expect(entry!.motion.kind).toBe('custom');
    expect(entry!.motion.fadeInSeconds).toBe(0.5);
    expect(entry!.motion.derivedFrom).toEqual({
      key: 'wave',
      fadeInSeconds: 0.5,
      fadeOutSeconds: 0.25,
    });
    expect(entry!.motion.tracks[0].keyframes).toHaveLength(5);
    expect(entry!.motion.tracks[0].keyframes[0]).toMatchObject({
      time: 0,
      value: 0,
      segment: { type: 'linear' },
    });
    expect(entry!.motion.tracks[0].keyframes.at(-1)).toEqual({ time: 2, value: 30 });
    expect(entry!.evaluate(1)).toEqual({
      PARAM_ANGLE_X: 20,
      PARAM_EYE_OPEN: 0,
    });
  });

  it('hits the cache without re-sampling', async () => {
    const sampler = makeSampler();
    const cache = new MotionCurveCacheService(sampler);
    const source = makeSource();
    await cache.ensure(source);
    await cache.ensure(source);
    expect(sampler.sample).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
  });

  it('deduplicates concurrent ensure calls', async () => {
    const sampler = makeSampler();
    const cache = new MotionCurveCacheService(sampler);
    const source = makeSource();
    const [a, b] = await Promise.all([cache.ensure(source), cache.ensure(source)]);
    expect(sampler.sample).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('returns null when sampling fails and never throws', async () => {
    const sampler = makeSampler({
      sample: vi.fn(async () => { throw new Error('boom'); }),
    });
    const cache = new MotionCurveCacheService(sampler);
    await expect(cache.ensure(makeSource())).resolves.toBeNull();
    expect(cache.size).toBe(0);
  });

  it('returns null when no convertible curves are merged', async () => {
    const sampler = makeSampler({
      merge: vi.fn(() => []),
    });
    const cache = new MotionCurveCacheService(sampler);
    await expect(cache.ensure(makeSource())).resolves.toBeNull();
  });

  it('remembers a failed sample as a permanent miss without re-sampling', async () => {
    const sampler = makeSampler({
      sample: vi.fn(async () => { throw new Error('boom'); }),
    });
    const cache = new MotionCurveCacheService(sampler);
    const source = makeSource();
    await expect(cache.ensure(source)).resolves.toBeNull();
    await expect(cache.ensure(source)).resolves.toBeNull();
    // The failed key is registered as a permanent miss: a second ensure must
    // not re-attempt the doomed sample on every call.
    expect(sampler.sample).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(0);
  });

  it('reports the miss reason of a rejected key and clears it after invalidate', async () => {
    const sampler = makeSampler({
      sample: vi.fn(async () => { throw new Error('boom'); }),
    });
    const cache = new MotionCurveCacheService(sampler);
    const source = makeSource();
    await cache.ensure(source);
    expect(cache.missReason(source)).toBe('sampling-failed');
    cache.invalidate(source);
    expect(cache.missReason(source)).toBeNull();
  });

  it('retries a rejected key after invalidate and caches on success', async () => {
    const sampler = makeSampler();
    sampler.sample = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockImplementation(async () => waveCurves());
    const cache = new MotionCurveCacheService(sampler);
    const source = makeSource();
    await expect(cache.ensure(source)).resolves.toBeNull();
    expect(cache.missReason(source)).toBe('sampling-failed');
    cache.invalidate(source);
    const entry = await cache.ensure(source);
    expect(entry).not.toBeNull();
    expect(cache.missReason(source)).toBeNull();
    expect(sampler.sample).toHaveBeenCalledTimes(2);
  });

  it('keeps a motion with parts/layout curves on the SDK path (parity guard)', async () => {
    const sampler = makeSampler({
      resolveMeta: vi.fn(async () => ({ durationSeconds: 2, hasNonParameterCurves: true })),
    });
    const cache = new MotionCurveCacheService(sampler);
    const source = makeSource();
    await expect(cache.ensure(source)).resolves.toBeNull();
    // The source motion animates parts/layouts the pure evaluator cannot
    // represent; converting it would silently lose visuals, so it is rejected
    // without even sampling the parameter curves.
    expect(sampler.sample).not.toHaveBeenCalled();
    expect(cache.missReason(source)).toBe('parts-layout-curves');
  });

  it('evicts the oldest rejected key beyond the rejected-capacity bound', async () => {
    const sampler = makeSampler({
      sample: vi.fn(async () => { throw new Error('boom'); }),
    });
    const cache = new MotionCurveCacheService(sampler);
    for (let i = 0; i <= RESOURCE_MOTION_CACHE_MAX_REJECTED_ENTRIES; i++) {
      await cache.ensure(makeSource({ motionKey: `wave-${i}` }));
    }
    expect(cache.missReason(makeSource({ motionKey: 'wave-0' }))).toBeNull();
    expect(cache.missReason(makeSource({ motionKey: `wave-${RESOURCE_MOTION_CACHE_MAX_REJECTED_ENTRIES}` })))
      .toBe('sampling-failed');
  });

  it('invalidates and clears entries', async () => {
    const sampler = makeSampler();
    const cache = new MotionCurveCacheService(sampler);
    const source = makeSource();
    await cache.ensure(source);
    expect(cache.size).toBe(1);
    cache.invalidate(source);
    expect(cache.size).toBe(0);
    await cache.ensure(source);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('estimates entry memory from keyframe count and track overhead', () => {
    const entry = {
      key: 'k',
      motion: {
        kind: 'custom',
        id: 'k',
        durationSeconds: 2,
        tracks: [
          { id: 'PARAM_A', fadeInSeconds: 0, fadeOutSeconds: 0, keyframes: [{ time: 0, value: 0 }, { time: 1, value: 1 }] },
          { id: 'PARAM_B', fadeInSeconds: 0, fadeOutSeconds: 0, keyframes: [{ time: 0, value: 0 }, { time: 1, value: 2 }, { time: 2, value: 2 }] },
        ],
      } as any,
    } as CachedResourceMotion;
    expect(estimateCachedMotionBytes(entry)).toBe(
      5 * MOTION_CURVE_KEYFRAME_ESTIMATED_BYTES + 2 * MOTION_CURVE_TRACK_OVERHEAD_ESTIMATED_BYTES,
    );
  });

  it('evicts the oldest entries to stay within the byte budget', async () => {
    const sampler = makeSampler();
    // Each 2-track/5-sample entry weighs 10*48 + 2*128 = 736 bytes in the
    // V8-calibrated estimate, so a 1300-byte budget holds one entry and
    // evicts the oldest when the second arrives.
    const cache = new MotionCurveCacheService(sampler, 1300);
    await cache.ensure(makeSource({ motionKey: 'wave-0' }));
    expect(cache.bytesUsed).toBe(736);

    await cache.ensure(makeSource({ motionKey: 'wave-1' }));
    expect(cache.size).toBe(1);
    expect(cache.bytesUsed).toBe(736);
    expect(cache.get(makeSource({ motionKey: 'wave-0' }))).toBeNull();
    expect(cache.get(makeSource({ motionKey: 'wave-1' }))).not.toBeNull();
  });

  it('keeps a single entry even when it exceeds the budget', async () => {
    const cache = new MotionCurveCacheService(makeSampler(), 400);
    await cache.ensure(makeSource());
    expect(cache.size).toBe(1);
    expect(cache.bytesUsed).toBe(736);
    expect(cache.get(makeSource())).not.toBeNull();
  });

  it('releases budget bytes on invalidation and clear', async () => {
    const cache = new MotionCurveCacheService(makeSampler(), 2000);
    await cache.ensure(makeSource({ motionKey: 'wave-0' }));
    await cache.ensure(makeSource({ motionKey: 'wave-1' }));
    expect(cache.size).toBe(2);
    expect(cache.bytesUsed).toBe(1472);

    cache.invalidate(makeSource({ motionKey: 'wave-0' }));
    expect(cache.bytesUsed).toBe(736);
    // The freed budget accommodates a new entry without evicting wave-1.
    await cache.ensure(makeSource({ motionKey: 'wave-2' }));
    expect(cache.size).toBe(2);
    expect(cache.get(makeSource({ motionKey: 'wave-1' }))).not.toBeNull();
    expect(cache.get(makeSource({ motionKey: 'wave-2' }))).not.toBeNull();

    cache.clear();
    expect(cache.bytesUsed).toBe(0);
  });

  it('defaults to the 512MB budget calibrated to real V8 occupancy', async () => {
    const cache = new MotionCurveCacheService(makeSampler());
    expect(cache.budgetBytes).toBe(RESOURCE_MOTION_CACHE_BUDGET_BYTES);
    expect(RESOURCE_MOTION_CACHE_BUDGET_BYTES).toBe(512 * 1024 * 1024);
  });

  it('exposes per-frame occupancy stats for console diagnostics', async () => {
    const cache = new MotionCurveCacheService(makeSampler());
    await cache.ensure(makeSource({ motionKey: 'wave' }));

    const stats = cache.stats();
    expect(stats.entries).toBe(1);
    expect(stats.keyframes).toBe(10); // 2 tracks × 5 samples (per-frame density)
    expect(stats.bytesUsed).toBe(736);
    expect(stats.budgetBytes).toBe(RESOURCE_MOTION_CACHE_BUDGET_BYTES);
    expect(stats.motions).toEqual([
      { key: motionCurveCacheKey(makeSource()), keyframes: 10, bytes: 736 },
    ]);

    // A second distinct motion is listed separately with its own keyframe count.
    await cache.ensure(makeSource({ motionKey: 'idle-0' }));
    expect(cache.stats().entries).toBe(2);
    expect(cache.stats().keyframes).toBe(20);
  });
});

describe('cache key and fade defaults', () => {
  it('derives a stable per-runtime/model/motion key', () => {
    expect(motionCurveCacheKey({
      adapterId: 'pixi-live2d-display-cubism2',
      modelRuntimePath: 'asset://models/char.model3.json',
      motionKey: 'wave',
    })).toBe('pixi-live2d-display-cubism2::asset://models/char.model3.json::wave');
  });

  it('recognizes idle motions and resolves effective Cubism 2 fade defaults', () => {
    expect(isIdleMotionKey('idle')).toBe(true);
    expect(isIdleMotionKey('Idle')).toBe(true);
    expect(isIdleMotionKey('wave')).toBe(false);
    expect(resolveEffectiveCubism2FadeInSeconds({ durationSeconds: 2 }, 'wave')).toBe(0.5);
    expect(resolveEffectiveCubism2FadeInSeconds({ durationSeconds: 2 }, 'idle')).toBe(0);
    expect(resolveEffectiveCubism2FadeInSeconds({ durationSeconds: 2, fadeInSeconds: 0.25 }, 'wave')).toBe(0.25);
  });
});

describe('cached entry structure', () => {
  it('exposes a custom-motion typed object consumable by evaluateCustomMotionRuntime', async () => {
    const cache = new MotionCurveCacheService(makeSampler());
    const entry = (await cache.ensure(makeSource())) as CachedResourceMotion;
    // The synthesized motion satisfies the CharacterMotionOutput custom union.
    expect(entry.motion.kind).toBe('custom');
    expect(Array.isArray(entry.motion.tracks)).toBe(true);
    expect(entry.key).toBe(motionCurveCacheKey(makeSource()));
    expect(entry.isIdle).toBe(false);
    expect(entry.sourceFadeInSeconds).toBe(0.5);
    expect(entry.sourceFadeOutSeconds).toBe(0.25);
  });
});