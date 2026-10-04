/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BakeMotionRuntime, type BakeMotionRuntimeHost } from '../engine/BakeMotionRuntime';
import * as runtimeAdapter from '../engine/Live2DRuntimeAdapter';
import { mockAdapter, mockControls } from './helpers/mockLive2DRuntimeAdapter';
import type { CachedResourceMotion } from '../engine/live2d/motionCurveCache';
import type { CharacterMotionOutput } from '../api/types/semantic-scene';

const cachedMotion: Extract<CharacterMotionOutput, { kind: 'custom' }> = {
  kind: 'custom',
  durationSeconds: 2,
  fadeInSeconds: 0.5,
  derivedFrom: { key: 'wave' },
  tracks: [
    {
      parameterId: 'PARAM_ANGLE_X',
      keyframes: [
        { time: 0, value: 0, segment: { type: 'linear' } },
        { time: 2, value: 20 },
      ],
    },
  ],
};

const cachedEntry: CachedResourceMotion = {
  key: 'pixi-live2d-display-cubism2::asset://models/char.model3.json::wave',
  motion: cachedMotion,
  sourceFadeInSeconds: 0.5,
  isIdle: false,
  evaluate: () => ({}),
};

function makeCache() {
  return {
    cacheEntry: cachedEntry,
    ensure: vi.fn(async (key: any) => key.motionKey === 'wave' ? cachedEntry : null),
    missReason: vi.fn(() => null),
    get: vi.fn(),
  };
}

function makeHost(overrides: Partial<BakeMotionRuntimeHost> = {}): BakeMotionRuntimeHost {
  return {
    fps: 60,
    getSamplingTargets: vi.fn(() => []),
    preloadMotion: vi.fn(async () => {}),
    getBaseValues: vi.fn(() => ({})),
    stopNativeMotion: vi.fn(),
    getModel: vi.fn(() => undefined),
    ...overrides,
  };
}

describe('BakeEngine resource motion parity through BakeMotionRuntime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes a cached resource motion through the shared custom-motion evaluator without SDK pending play', async () => {
    const cache = makeCache();
    const host = makeHost();
    const runtime = new BakeMotionRuntime(host, cache as any);
    await runtime.prepare([
      { charId: 'char1', adapterId: 'pixi-live2d-display-cubism2', modelRuntimePath: 'asset://models/char.model3.json', motionKey: 'wave' },
    ]);

    const injectedParams: Record<string, number> = {};
    const result = runtime.applyIntent({
      charId: 'char1',
      intent: { output: { kind: 'resource', key: 'wave' } as any, priority: 3, time: 1 },
      simTime: 1.5,
      injectedParams,
    });

    expect(result.driver).toBe('curve');
    // Pure evaluator path: no cache lookup during the frame loop.
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.ensure).toHaveBeenCalledTimes(1);
    // The curve driver owns parameters; no native SDK request is generated.
    expect(result.nativeStartRequested).toBe(false);
    expect(host.stopNativeMotion).not.toHaveBeenCalled();
  });

  it('keeps the native SDK path for cache misses and starts only once per segment', async () => {
    const cache = makeCache();
    const motionManager = { startMotion: vi.fn(async (_key: string, _priority: number, _options?: any) => true) };
    const model: any = { update: vi.fn() };
    // The native driver reaches the SDK through the runtime adapter seam,
    // which owns the clock spoof + offset replay (Cubism2NativeMotionSession).
    const startMotion = vi.fn(async (_m: any, key: string, priority: number, offset: number) => {
      await motionManager.startMotion(key, priority, { offset });
      return { ok: true, offsetReplayMs: Math.max(0, offset) * 1000, motionStartUtTimeMs: 10000 };
    });
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue(
      mockAdapter({ getControls: () => mockControls({ startMotion }) }) as any,
    );
    const host = makeHost({
      getModel: () => ({ model, runtimeFamily: 'cubism2', adapterId: 'pixi-live2d-display-cubism2' } as any),
    });
    const runtime = new BakeMotionRuntime(host, cache as any);
    await runtime.prepare([
      { charId: 'char1', adapterId: 'pixi-live2d-display-cubism2', modelRuntimePath: 'asset://models/char.model3.json', motionKey: 'sad' },
    ]);

    const injectedParams: Record<string, number> = {};
    const first = runtime.applyIntent({
      charId: 'char1',
      intent: { output: { kind: 'resource', key: 'sad' } as any, priority: 4, time: 1 },
      simTime: 1.5,
      injectedParams,
    });
    expect(first.driver).toBe('native');
    expect(first.nativeStartRequested).toBe(true);

    const clock = { getUserTimeMSec: () => 10000, setUserTimeMSec: vi.fn() };
    await runtime.advanceNative({ charId: 'char1', utSystem: clock as any });
    const second = runtime.applyIntent({
      charId: 'char1',
      intent: { output: { kind: 'resource', key: 'sad' } as any, priority: 4, time: 1 },
      simTime: 1.6,
      injectedParams,
    });
    expect(second.nativeStartRequested).toBe(false);
    expect(motionManager.startMotion).toHaveBeenCalledTimes(1);
    expect(runtime.report().offsetReplayMs).toBeGreaterThan(0);
  });

  it('still evaluates authored custom motions without consulting the cache', async () => {
    const cache = makeCache();
    const host = makeHost();
    const runtime = new BakeMotionRuntime(host, cache as any);

    const injectedParams: Record<string, number> = {};
    const result = runtime.applyIntent({
      charId: 'char1',
      intent: { output: cachedMotion, priority: 3, time: 2 },
      simTime: 2.5,
      injectedParams,
    });

    expect(result.driver).toBe('curve');
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.ensure).not.toHaveBeenCalled();
  });
});
