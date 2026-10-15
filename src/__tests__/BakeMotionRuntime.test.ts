/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BakeMotionRuntime,
  type BakeMotionRuntimeHost,
} from '../engine/BakeMotionRuntime';
import type { CachedResourceMotion, MotionCurveCacheKey } from '../engine/live2d/motionCurveCache';
import type { CharacterMotionOutput } from '../api/types/semantic-scene';
import { CubismPixiLive2DAdapter } from '../engine/Live2DRuntimeAdapter';
import { submitLive2DBakeFrameBatch } from '../engine/live2d/runtime/Live2DRuntimeControlModule';
import { createCubismModelFixture } from './helpers/cubismModelFixture';

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
    preloadMotion: vi.fn(async () => {}),
    getBaseValues: vi.fn(() => ({})),
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
  it('composes custom curves with expressions, blink and live mouth input in the Bake frame', async () => {
    const { model, internal, core } = createCubismModelFixture();
    internal.on('expressionUpdate', () => core.setParameterValueByIndex(4, core.getParameterValueByIndex(4) + 5));
    const handle = new CubismPixiLive2DAdapter().createModelHandle('haru', model);
    const injectedParams: Record<string, number> = { ParamMouthOpenY: 0.8 };
    handle.bindRuntimeSource({ mode: 'bake', injectedParamsSource: { injectedParams }, isCurrent: () => true });
    const runtime = new BakeMotionRuntime({
      fps: 30, preloadMotion: async () => {}, getBaseValues: () => ({}),
      installCustomMotionStage: (_id, input) => handle.customMotion.installStage(input),
    });
    const motion: Extract<CharacterMotionOutput, { kind: 'custom' }> = {
      kind: 'custom', durationSeconds: 1, fadeInSeconds: 0, derivedFrom: { key: 'wink' },
      tracks: ['ParamAngleX', 'ParamEyeLOpen', 'ParamMouthOpenY'].map((parameterId, index) => ({
        parameterId, keyframes: [{ time: 0, value: [10, 0.4, 0.2][index] }, { time: 1, value: [10, 0.4, 0.2][index] }],
      })),
    };
    try {
      runtime.applyIntent({ charId: 'haru', intent: { output: motion, time: 0 }, simTime: 0.75,
        injectedParams, channelProtected: new Set(['ParamMouthOpenY']) });
      handle.blink.set(true, 1000, 0.75, 0);
      await submitLive2DBakeFrameBatch({ operations: [{ handle, isCurrent: () => true, sceneTimeSeconds: 0.75 }],
        deltaMs: 1000 / 30, isCurrent: () => true });
      const values = new Map(handle.parameters.getParameterValues()?.map((parameter) => [parameter.name, parameter.value]));
      expect(values.get('ParamAngleX')).toBeCloseTo(15);
      expect(values.get('ParamEyeLOpen')).toBeCloseTo(0.4);
      expect(values.get('ParamEyeROpen')).toBeCloseTo(0.5);
      expect(values.get('ParamMouthOpenY')).toBeCloseTo(0.8);
      runtime.applyIntent({ charId: 'haru', intent: null, simTime: 0.75, injectedParams });
      expect(injectedParams.ParamMouthOpenY).toBeCloseTo(0.8);
    } finally {
      handle.dispose({ mode: 'destroy' });
    }
  });

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
    const runtime = new BakeMotionRuntime(makeHost(), cache as any);
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

    const pending = runtime.pendingNativeStart('soyo');
    expect(pending).toEqual({
      charId: 'soyo', motionKey: 'sad', priority: 4, offsetSeconds: 0,
      sceneTimeSeconds: 10, fadeInSeconds: undefined,
    });
    const completion = runtime.completeNativeStart('soyo', { status: 'started', offsetReplayMs: 12 });
    expect(completion.status).toBe('started');
    expect(runtime.pendingNativeStart('soyo')).toBeUndefined();
    expect(completion.offsetReplayMs).toBe(12);

    const next = runtime.applyIntent({
      charId: 'soyo',
      intent: { output: motion, priority: 4, time: 10 },
      simTime: 10.1,
      injectedParams,
    });
    expect(next.driver).toBe('native');
    expect(next.nativeStartRequested).toBe(false);
    expect(runtime.pendingNativeStart('soyo')).toBeUndefined();
  });

  it('clears a cancelled native transition without recording a successful start', async () => {
    const { cache } = makeCache();
    const runtime = new BakeMotionRuntime(makeHost(), cache as any);
    await runtime.prepare([{
      charId: 'soyo', adapterId: 'pixi-live2d-display-cubism2',
      modelRuntimePath: 'asset://m/char.model3.json', motionKey: 'sad',
    }]);
    const intent = { output: { kind: 'resource', key: 'sad' } as any, priority: 3, time: 0 };
    runtime.applyIntent({ charId: 'soyo', intent, simTime: 0, injectedParams: {} });

    const completion = runtime.completeNativeStart('soyo', { status: 'cancelled', offsetReplayMs: 12 });

    expect(completion).toEqual({ status: 'cancelled', offsetReplayMs: 0 });
    expect(runtime.pendingNativeStart('soyo')).toBeUndefined();
    expect(runtime.report().nativeStarts).toBe(0);
    expect(runtime.applyIntent({ charId: 'soyo', intent, simTime: 0, injectedParams: {} }).nativeStartRequested).toBe(true);
  });

  it('clears a missing native transition without recording a successful start', async () => {
    const { cache } = makeCache();
    const runtime = new BakeMotionRuntime(makeHost(), cache as any);
    await runtime.prepare([{
      charId: 'soyo', adapterId: 'pixi-live2d-display-cubism2',
      modelRuntimePath: 'asset://m/char.model3.json', motionKey: 'sad',
    }]);
    runtime.applyIntent({
      charId: 'soyo', intent: { output: { kind: 'resource', key: 'sad' } as any, priority: 3, time: 0 },
      simTime: 0, injectedParams: {},
    });

    const completion = runtime.completeNativeStart('soyo', { status: 'missing', offsetReplayMs: 0 });

    expect(completion.status).toBe('missing');
    expect(runtime.pendingNativeStart('soyo')).toBeUndefined();
    expect(runtime.report().nativeStarts).toBe(0);
  });

  it('preserves authored fade-in and offset in the native transition intent', async () => {
    const { cache } = makeCache();
    const runtime = new BakeMotionRuntime(makeHost(), cache as any);
    await runtime.prepare([{
      charId: 'soyo', adapterId: 'untitled-pixi-live2d-engine-cubism',
      modelRuntimePath: 'asset://m/char.model3.json', motionKey: 'sad',
    }]);

    runtime.applyIntent({
      charId: 'soyo',
      intent: { output: { kind: 'resource', key: 'sad', fadeInSeconds: 0.5 }, priority: 3, time: 1 },
      simTime: 1.25,
      injectedParams: {},
    });
    expect(runtime.pendingNativeStart('soyo')).toMatchObject({
      motionKey: 'sad', priority: 3, offsetSeconds: 0.25, fadeInSeconds: 0.5,
    });
  });

  it('starts a new native segment when key, start time or priority changes', async () => {
    const { cache } = makeCache();
    const host = makeHost();
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
    const firstStart = runtime.pendingNativeStart('soyo');
    expect(firstStart?.motionKey).toBe('sad');
    runtime.completeNativeStart('soyo', { status: 'started', offsetReplayMs: 0 });

    const changed = runtime.applyIntent({
      charId: 'soyo',
      intent: { output: { kind: 'resource', key: 'wave' } as any, priority: 3, time: 12 },
      simTime: 12,
      injectedParams,
    });
    expect(changed.nativeStartRequested).toBe(true);

    const changedStart = runtime.pendingNativeStart('soyo');
    expect(changedStart?.motionKey).toBe('wave');
    runtime.completeNativeStart('soyo', { status: 'started', offsetReplayMs: 0 });
    // First advance starts sad; second advance starts the changed wave segment.
    expect(runtime.report().nativeStarts).toBe(2);
  });

  it('explicitly clears driver control when state.motion becomes null', async () => {
    const { cache } = makeCache();
    const host = makeHost();
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
    expect(cleared.nativeStopRequested).toBe(false);
    expect(injectedParams.PARAM_ANGLE_X).toBeUndefined();
    expect(runtime.hasPendingNativeStop('soyo')).toBe(false);
  });

  it('defers stopping a native driver until the runtime-owned frame batch', async () => {
    const { cache } = makeCache();
    const runtime = new BakeMotionRuntime(makeHost(), cache as any);
    await runtime.prepare([{
      charId: 'soyo', adapterId: 'pixi-live2d-display-cubism2',
      modelRuntimePath: 'asset://m/char.model3.json', motionKey: 'sad',
    }]);
    runtime.applyIntent({
      charId: 'soyo', intent: { output: { kind: 'resource', key: 'sad' } as any, priority: 3, time: 0 },
      simTime: 0, injectedParams: {},
    });
    runtime.completeNativeStart('soyo', { status: 'started', offsetReplayMs: 0 });

    const changed = runtime.applyIntent({
      charId: 'soyo',
      intent: { output: { kind: 'custom', durationSeconds: 1, tracks: [] } as any, priority: 3, time: 1 },
      simTime: 1, injectedParams: {},
    });

    expect(changed.nativeStopRequested).toBe(true);
    expect(runtime.hasPendingNativeStop('soyo')).toBe(true);
    runtime.completeNativeStop('soyo');
    expect(runtime.hasPendingNativeStop('soyo')).toBe(false);
  });
});

describe('BakeMotionRuntime mixed observability', () => {
  it('reports cacheHitFrames, cacheMissFrames, nativeStarts and offsetReplayMs in one bake', async () => {
    const { cache } = makeCache();
    const runtime = new BakeMotionRuntime(makeHost(), cache as any);
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
    runtime.completeNativeStart('soyo', { status: 'started', offsetReplayMs: 50 });

    const report = runtime.report();
    expect(report.cacheHitFrames).toBe(1);
    expect(report.cacheMissFrames).toBe(1);
    expect(report.nativeStarts).toBe(1);
    expect(report.offsetReplayMs).toBeGreaterThan(0);
  });
});
