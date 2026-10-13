/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BakeMotionRuntime, type BakeMotionRuntimeHost } from '../engine/BakeMotionRuntime';
import {
  createLive2DModelHandle,
  submitLive2DBakeFrameBatch,
} from '../engine/live2d/runtime/Live2DRuntimeControlModule';
import {
  registerSharedRuntimeClockProvider,
} from '../engine/live2d/runtime/Live2DRuntimeClockCoordinator';
import { mockControls } from './helpers/mockLive2DRuntimeAdapter';
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
    preloadMotion: vi.fn(async () => {}),
    getBaseValues: vi.fn(() => ({})),
    ...overrides,
  };
}

function installSharedClock(initialTimeMs: number) {
  let timeMs = initialTimeMs;
  const clock = {
    getUserTimeMSec: () => timeMs,
    setUserTimeMSec: vi.fn((nextTimeMs: number) => { timeMs = nextTimeMs; }),
  };
  registerSharedRuntimeClockProvider(() => clock);
  return { clock, getTime: () => timeMs };
}

describe('BakeEngine resource motion parity through BakeMotionRuntime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    registerSharedRuntimeClockProvider(() => null);
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
  });

  it('keeps native cache-miss intent and starts only once per segment', async () => {
    const cache = makeCache();
    const host = makeHost();
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

    const pending = runtime.pendingNativeStart('char1');
    expect(pending).toMatchObject({ motionKey: 'sad', priority: 4, offsetSeconds: 0.5 });
    runtime.completeNativeStart('char1', { status: 'started', offsetReplayMs: 500 });
    const second = runtime.applyIntent({
      charId: 'char1',
      intent: { output: { kind: 'resource', key: 'sad' } as any, priority: 4, time: 1 },
      simTime: 1.6,
      injectedParams,
    });
    expect(second.nativeStartRequested).toBe(false);
    expect(runtime.pendingNativeStart('char1')).toBeUndefined();
    expect(runtime.report().offsetReplayMs).toBeGreaterThan(0);
  });

  it('restores and resets state without submitting a frame or advancing the shared clock', async () => {
    const shared = installSharedClock(12_000);
    const model = {};
    const controls = mockControls();
    const handle = createLive2DModelHandle({
      id: 'state-only',
      model,
      runtime: { runtimeFamily: 'cubism2', adapterId: 'pixi-live2d-display-cubism2', supported: true },
      controls,
    });
    const snapshot = { params: new Float32Array([0.25]), opacities: new Float32Array([1]) };

    const result = await submitLive2DBakeFrameBatch({
      operations: [{
        handle,
        isCurrent: () => true,
        resetRuntimeState: { pose: 'idle' },
        restoreSnapshot: snapshot,
        submitFrame: false,
      }],
      deltaMs: 250,
      advanceClock: true,
      isCurrent: () => true,
    });

    expect(result.status).toBe('submitted');
    expect(controls.applySnapshot).toHaveBeenCalledWith(model, snapshot);
    expect(controls.stepBakeFrame).not.toHaveBeenCalled();
    expect(shared.clock.setUserTimeMSec).not.toHaveBeenCalled();
    expect(shared.getTime()).toBe(12_000);
  });

  it('starts a native cache-miss intent in one mixed Cubism 2 and Cubism 3 batch', async () => {
    const shared = installSharedClock(20_000);
    const cache = makeCache();
    const runtime = new BakeMotionRuntime(makeHost(), cache as any);
    await runtime.prepare([
      { charId: 'native', adapterId: 'pixi-live2d-display-cubism2', modelRuntimePath: 'asset://models/native.model3.json', motionKey: 'sad' },
    ]);
    const intent = runtime.applyIntent({
      charId: 'native',
      intent: { output: { kind: 'resource', key: 'sad' }, priority: 4, time: 1 },
      simTime: 1.5,
      injectedParams: {},
    });
    const pending = runtime.pendingNativeStart('native');
    expect(intent).toMatchObject({ driver: 'native', nativeStartRequested: true });
    expect(pending).toBeDefined();

    const cubism2Model = {};
    const cubism2Controls = mockControls();
    const cubism2Handle = createLive2DModelHandle({
      id: 'native',
      model: cubism2Model,
      runtime: { runtimeFamily: 'cubism2', adapterId: 'pixi-live2d-display-cubism2', supported: true },
      controls: cubism2Controls,
    });
    const cubism3Model = {};
    const cubism3Controls = mockControls();
    const cubism3Handle = createLive2DModelHandle({
      id: 'independent',
      model: cubism3Model,
      runtime: { runtimeFamily: 'cubism3-plus', adapterId: 'untitled-pixi-live2d-engine-cubism', supported: true },
      controls: cubism3Controls,
    });

    const result = await submitLive2DBakeFrameBatch({
      operations: [
        {
          handle: cubism2Handle,
          isCurrent: () => true,
          motionStart: {
            motionKey: pending!.motionKey,
            priority: pending!.priority,
            offsetSeconds: pending!.offsetSeconds,
            sceneTimeSeconds: pending!.sceneTimeSeconds,
            fadeInSeconds: pending!.fadeInSeconds,
          },
        },
        { handle: cubism3Handle, isCurrent: () => true },
      ],
      deltaMs: 16,
      isCurrent: () => true,
    });

    expect(result.status).toBe('submitted');
    expect(result.transitions.get('native')?.status).toBe('started');
    expect(result.transitions.has('independent')).toBe(false);
    expect(cubism2Controls.startMotion).toHaveBeenCalledTimes(1);
    expect(cubism2Controls.stepBakeFrame).toHaveBeenCalledTimes(1);
    expect(cubism3Controls.stepBakeFrame).toHaveBeenCalledTimes(1);
    expect(shared.clock.setUserTimeMSec).toHaveBeenCalledTimes(1);
    expect(shared.getTime()).toBe(20_016);

    const transition = result.transitions.get('native');
    expect(transition).toBeDefined();
    runtime.completeNativeStart('native', transition!);
    expect(runtime.pendingNativeStart('native')).toBeUndefined();
    expect(runtime.report().nativeStarts).toBe(1);
  });

  it('cancels a bake batch when the native transition loses its borrow before frame submission', async () => {
    const shared = installSharedClock(30_000);
    let current = true;
    const model = {};
    const controls = mockControls({
      startMotion: vi.fn(async () => {
        current = false;
        return { ok: false, cancelled: true, offsetReplayMs: 0 };
      }),
    });
    const handle = createLive2DModelHandle({
      id: 'cancelled',
      model,
      runtime: { runtimeFamily: 'cubism2', adapterId: 'pixi-live2d-display-cubism2', supported: true },
      controls,
    });

    const result = await submitLive2DBakeFrameBatch({
      operations: [{
        handle,
        isCurrent: () => current,
        motionStart: {
          motionKey: 'wave',
          priority: 3,
          offsetSeconds: 0.25,
          sceneTimeSeconds: 1,
        },
      }],
      deltaMs: 16,
      isCurrent: () => true,
    });

    expect(result.status).toBe('cancelled');
    expect(controls.stepBakeFrame).not.toHaveBeenCalled();
    expect(shared.clock.setUserTimeMSec).not.toHaveBeenCalled();
    expect(shared.getTime()).toBe(30_000);
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
