/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BakeMotionRuntime,
  type BakeMotionRuntimeHost,
} from '../engine/BakeMotionRuntime';
import type { CachedResourceMotion, MotionCurveCacheKey } from '../engine/live2d/motionCurveCache';

function cachedMotion(): CachedResourceMotion {
  return {
    key: 'key',
    motion: {
      kind: 'custom',
      durationSeconds: 1,
      tracks: [],
    },
    isIdle: false,
    evaluate: () => ({}),
  } as unknown as CachedResourceMotion;
}

function makeCache() {
  const cacheEntry = cachedMotion();
  const ensure = vi.fn(async (key: any) => {
    return key.motionKey === 'wave' ? cacheEntry : null;
  });
  const missReason = vi.fn((key: MotionCurveCacheKey) => {
    return key.motionKey === 'sad' ? 'parts-layout-curves' : null;
  });
  return {
    cacheEntry,
    cache: {
      ensure,
      missReason,
      get: vi.fn(),
      clear: vi.fn(),
    },
  };
}

function makeHost(overrides: Partial<BakeMotionRuntimeHost> = {}): BakeMotionRuntimeHost {
  return {
    fps: 30,
    getSamplingTargets: vi.fn(() => []),
    preloadMotion: vi.fn(async () => {}),
    getBaseValues: vi.fn(() => ({})),
    stopNativeMotion: vi.fn(),
    getModel: vi.fn(() => undefined),
    ...overrides,
  };
}

describe('BakeMotionRuntime.prepare', () => {
  it('builds a plan with curve entries for cache hits and native entries for misses', async () => {
    const { cache, cacheEntry } = makeCache();
    const host = makeHost();
    const runtime = new BakeMotionRuntime(host, cache as any);

    const plan = await runtime.prepare([
      { charId: 'soyo', adapterId: 'pixi-live2d-display-cubism2', modelRuntimePath: 'asset://m/char.model3.json', motionKey: 'wave' },
      { charId: 'soyo', adapterId: 'pixi-live2d-display-cubism2', modelRuntimePath: 'asset://m/char.model3.json', motionKey: 'sad' },
    ]);

    expect(cache.ensure).toHaveBeenCalledTimes(2);
    expect(plan.entries).toHaveLength(2);
    const wave = plan.entries.find((entry) => entry.motionKey === 'wave')!;
    const sad = plan.entries.find((entry) => entry.motionKey === 'sad')!;
    expect(wave.resolution.kind).toBe('curve');
    if (wave.resolution.kind === 'curve') {
      expect(wave.resolution.cacheEntry).toBe(cacheEntry);
    }
    expect(sad.resolution.kind).toBe('native');
    if (sad.resolution.kind === 'native') {
      expect(sad.resolution.missReason).toBe('parts-layout-curves');
    }
    expect(host.preloadMotion).toHaveBeenCalledWith('soyo', 'sad');

    const report = runtime.report();
    expect(report.uniqueCurveKeys).toBe(1);
    expect(report.uniqueNativeKeys).toBe(1);
    expect(report.nativePreloads).toBe(1);
  });

  it('deduplicates concurrent prepare requests by cache key while preloading each native character', async () => {
    const { cache } = makeCache();
    const host = makeHost();
    const runtime = new BakeMotionRuntime(host, cache as any);

    const plan = await runtime.prepare([
      { charId: 'soyo', adapterId: 'pixi-live2d-display-cubism2', modelRuntimePath: 'asset://m/char.model3.json', motionKey: 'wave' },
      { charId: 'rana', adapterId: 'pixi-live2d-display-cubism2', modelRuntimePath: 'asset://m/char.model3.json', motionKey: 'wave' },
      { charId: 'soyo', adapterId: 'pixi-live2d-display-cubism2', modelRuntimePath: 'asset://m/char.model3.json', motionKey: 'sad' },
      { charId: 'rana', adapterId: 'pixi-live2d-display-cubism2', modelRuntimePath: 'asset://m/char.model3.json', motionKey: 'sad' },
    ]);

    expect(cache.ensure).toHaveBeenCalledTimes(2);
    expect(host.preloadMotion).toHaveBeenCalledTimes(2);
    expect(host.preloadMotion).toHaveBeenCalledWith('soyo', 'sad');
    expect(host.preloadMotion).toHaveBeenCalledWith('rana', 'sad');
    expect(plan.entries).toHaveLength(4);
    expect(runtime.report().nativePreloads).toBe(2);
  });

  it('keeps strong references to cached motions so later eviction cannot affect this bake', async () => {
    const { cache, cacheEntry } = makeCache();
    const host = makeHost();
    const runtime = new BakeMotionRuntime(host, cache as any);

    const plan = await runtime.prepare([
      { charId: 'soyo', adapterId: 'pixi-live2d-display-cubism2', modelRuntimePath: 'asset://m/char.model3.json', motionKey: 'wave' },
    ]);

    cache.clear();
    const wave = plan.entries.find((entry) => entry.motionKey === 'wave')!;
    expect(wave.resolution.kind).toBe('curve');
    if (wave.resolution.kind === 'curve') {
      expect(wave.resolution.cacheEntry).toBe(cacheEntry);
      expect(wave.resolution.cacheEntry.motion.durationSeconds).toBe(1);
    }
  });
});

describe('BakeMotionRuntime.applyIntent', () => {
  it('evaluates an authored custom motion through the curve driver without consulting the cache', () => {
    const { cache } = makeCache();
    const host = makeHost({ getBaseValues: vi.fn(() => ({ PARAM_ANGLE_X: 0 })) });
    const runtime = new BakeMotionRuntime(host, cache as any);
    const motion = {
      kind: 'custom',
      durationSeconds: 1,
      fadeInSeconds: 0,
      tracks: [
        { parameterId: 'PARAM_ANGLE_X', keyframes: [{ time: 0, value: 33 }] },
      ],
    } as any;

    const injectedParams: Record<string, number> = {};
    const result = runtime.applyIntent({
      charId: 'soyo',
      intent: { output: motion, priority: 3, time: 10 },
      simTime: 10,
      injectedParams,
    });

    expect(result.driver).toBe('curve');
    expect(injectedParams.PARAM_ANGLE_X).toBe(33);
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.ensure).not.toHaveBeenCalled();
  });

  it('uses the prepared curve-entry resource motion and counts cache hit frames', async () => {
    const { cache } = makeCache();
    const host = makeHost({ getBaseValues: vi.fn(() => ({ PARAM_ANGLE_X: 0 })) });
    const runtime = new BakeMotionRuntime(host, cache as any);
    await runtime.prepare([
      { charId: 'soyo', adapterId: 'pixi-live2d-display-cubism2', modelRuntimePath: 'asset://m/char.model3.json', motionKey: 'wave' },
    ]);

    const motion = { kind: 'resource', key: 'wave' } as any;
    const injectedParams: Record<string, number> = {};
    const result = runtime.applyIntent({
      charId: 'soyo',
      intent: { output: motion, priority: 3, time: 5 },
      simTime: 5,
      injectedParams,
    });

    expect(result.driver).toBe('curve');
    expect(runtime.report().cacheHitFrames).toBe(1);
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('routes a cache-miss resource motion through the native driver and does not restart on monotonic advance', async () => {
    const { cache } = makeCache();
    const motionManager = { startMotion: vi.fn(async () => true) };
    const model: any = {
      update: vi.fn(),
      internalModel: {
        motionManager,
        physics: null,
        settings: { motions: { sad: [{}], wave: [{}] } },
      },
    };
    const host = makeHost({
      getModel: () => ({ model, internalModel: model.internalModel, motionManager, runtimeFamily: 'cubism2', adapterId: 'pixi-live2d-display-cubism2' } as any),
      stopNativeMotion: vi.fn(),
    });
    const runtime = new BakeMotionRuntime(host, cache as any);
    await runtime.prepare([
      { charId: 'soyo', adapterId: 'pixi-live2d-display-cubism2', modelRuntimePath: 'asset://m/char.model3.json', motionKey: 'sad' },
    ]);

    const motion = { kind: 'resource', key: 'sad' } as any;
    const injectedParams: Record<string, number> = {};
    const first = runtime.applyIntent({
      charId: 'soyo',
      intent: { output: motion, priority: 4, time: 10 },
      simTime: 10,
      injectedParams,
    });

    expect(first.driver).toBe('native');
    expect(first.nativeStartRequested).toBe(true);

    const clock = { getUserTimeMSec: () => 1000, setUserTimeMSec: vi.fn() };
    const adv = await runtime.advanceNative({ charId: 'soyo', utSystem: clock as any });
    expect(adv.executed).toBe(true);
    expect(motionManager.startMotion).toHaveBeenCalledTimes(1);

    const next = runtime.applyIntent({
      charId: 'soyo',
      intent: { output: motion, priority: 4, time: 10 },
      simTime: 10.1,
      injectedParams,
    });
    expect(next.driver).toBe('native');
    expect(next.nativeStartRequested).toBe(false);
    const advAgain = await runtime.advanceNative({ charId: 'soyo', utSystem: clock as any });
    expect(advAgain.executed).toBe(false);
    expect(motionManager.startMotion).toHaveBeenCalledTimes(1);
  });

  it('passes the authored fade-in to the official native bake motion', async () => {
    const { cache } = makeCache();
    const model = { startMotion: vi.fn(async () => true) };
    const host = makeHost({
      getModel: () => ({ model, runtimeFamily: 'cubism3-plus', adapterId: 'official-cubism-web' }),
    });
    const runtime = new BakeMotionRuntime(host, cache as any);
    await runtime.prepare([{
      charId: 'soyo', adapterId: 'official-cubism-web',
      modelRuntimePath: 'asset://m/char.model3.json', motionKey: 'sad',
    }]);

    runtime.applyIntent({
      charId: 'soyo',
      intent: { output: { kind: 'resource', key: 'sad', fadeInSeconds: 0.5 }, priority: 3, time: 1 },
      simTime: 1.25,
      injectedParams: {},
    });
    await runtime.advanceNative({ charId: 'soyo', utSystem: null });

    expect(model.startMotion).toHaveBeenCalledWith('sad', 0, 3, 0.25, 0.5);
  });

  it('starts a new native segment when key, start time or priority changes', async () => {
    const { cache } = makeCache();
    const motionManager = { startMotion: vi.fn(async () => true) };
    const model: any = {
      update: vi.fn(),
      internalModel: {
        motionManager,
        physics: null,
        settings: { motions: { sad: [{}], wave: [{}] } },
      },
    };
    const host = makeHost({
      getModel: () => ({ model, internalModel: model.internalModel, motionManager, runtimeFamily: 'cubism2', adapterId: 'pixi-live2d-display-cubism2' } as any),
    });
    // Both keys miss in this fake cache: 'sad' and 'wave' -> null/miss.
    (cache.ensure as any).mockImplementation(async (key: any) => key.motionKey === 'sad' ? null : null);
    (cache.missReason as any).mockImplementation(() => 'not-cached');
    host.preloadMotion = vi.fn(async () => {});
    const runtime = new BakeMotionRuntime(host, cache as any);
    await runtime.prepare([
      { charId: 'soyo', adapterId: 'pixi-live2d-display-cubism2', modelRuntimePath: 'asset://m/char.model3.json', motionKey: 'sad' },
      { charId: 'soyo', adapterId: 'pixi-live2d-display-cubism2', modelRuntimePath: 'asset://m/char.model3.json', motionKey: 'wave' },
    ]);

    const injectedParams: Record<string, number> = {};
    runtime.applyIntent({
      charId: 'soyo',
      intent: { output: { kind: 'resource', key: 'sad' } as any, priority: 4, time: 10 },
      simTime: 10,
      injectedParams,
    });
    const clock = { getUserTimeMSec: () => 1000, setUserTimeMSec: vi.fn() };
    await runtime.advanceNative({ charId: 'soyo', utSystem: clock as any });

    const changed = runtime.applyIntent({
      charId: 'soyo',
      intent: { output: { kind: 'resource', key: 'wave' } as any, priority: 3, time: 12 },
      simTime: 12,
      injectedParams,
    });
    expect(changed.nativeStartRequested).toBe(true);

    await runtime.advanceNative({ charId: 'soyo', utSystem: clock as any });
    // First advance starts sad; second advance starts the changed wave segment.
    expect(runtime.report().nativeStarts).toBe(2);
    expect(motionManager.startMotion).toHaveBeenCalledTimes(2);
  });

  it('explicitly clears driver control when state.motion becomes null', async () => {
    const { cache } = makeCache();
    const stopNativeMotion = vi.fn();
    const host = makeHost({ stopNativeMotion });
    const runtime = new BakeMotionRuntime(host, cache as any);
    const motion = {
      kind: 'custom',
      durationSeconds: 1,
      fadeInSeconds: 0,
      tracks: [{ parameterId: 'PARAM_ANGLE_X', keyframes: [{ time: 0, value: 42 }] }],
    } as any;

    const injectedParams: Record<string, number> = {};
    runtime.applyIntent({
      charId: 'soyo',
      intent: { output: motion, priority: 3, time: 0 },
      simTime: 0,
      injectedParams,
    });
    expect(injectedParams.PARAM_ANGLE_X).toBe(42);

    const cleared = runtime.applyIntent({
      charId: 'soyo',
      intent: null,
      simTime: 1,
      injectedParams,
    });

    expect(cleared.driver).toBe('none');
    expect(injectedParams.PARAM_ANGLE_X).toBeUndefined();
    expect(stopNativeMotion).not.toHaveBeenCalled();
  });
});

describe('BakeMotionRuntime mixed observability', () => {
  it('reports cacheHitFrames, cacheMissFrames, nativeStarts and offsetReplayMs in one bake', async () => {
    const { cache } = makeCache();
    const motionManager = { startMotion: vi.fn(async () => true) };
    const model: any = {
      update: vi.fn(),
      internalModel: {
        motionManager,
        physics: null,
        settings: { motions: { sad: [{}], wave: [{}] } },
      },
    };
    const host = makeHost({
      getModel: () => ({ model, internalModel: model.internalModel, motionManager, runtimeFamily: 'cubism2', adapterId: 'pixi-live2d-display-cubism2' } as any),
    });
    const runtime = new BakeMotionRuntime(host, cache as any);
    await runtime.prepare([
      { charId: 'soyo', adapterId: 'pixi-live2d-display-cubism2', modelRuntimePath: 'asset://m/char.model3.json', motionKey: 'wave' },
      { charId: 'soyo', adapterId: 'pixi-live2d-display-cubism2', modelRuntimePath: 'asset://m/char.model3.json', motionKey: 'sad' },
    ]);

    const injectedParams: Record<string, number> = {};
    runtime.applyIntent({
      charId: 'soyo',
      intent: { output: { kind: 'resource', key: 'wave' } as any, priority: 3, time: 0 },
      simTime: 0,
      injectedParams,
    });
    runtime.applyIntent({
      charId: 'soyo',
      intent: { output: { kind: 'resource', key: 'sad' } as any, priority: 4, time: 2 },
      simTime: 2.25,
      injectedParams,
    });
    await runtime.advanceNative({
      charId: 'soyo',
      utSystem: { getUserTimeMSec: () => 100000, setUserTimeMSec: vi.fn() } as any,
    });

    const report = runtime.report();
    expect(report.cacheHitFrames).toBe(1);
    expect(report.cacheMissFrames).toBe(1);
    expect(report.nativeStarts).toBe(1);
    expect(report.offsetReplayMs).toBeGreaterThan(0);
  });
});
