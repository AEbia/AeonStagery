import { afterEach, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import {
  createLive2DModelHandle,
  getLive2DRuntimeCapabilities,
  resolveLive2DRuntimeCapabilities,
  submitLive2DBakeFrameBatch,
} from '../engine/live2d/runtime/Live2DRuntimeControlModule';
import {
  isSharedRuntimeClockLocked,
  registerSharedRuntimeClockProvider,
  withSharedRuntimeClock,
} from '../engine/live2d/runtime/Live2DRuntimeClockCoordinator';
import { Cubism2PixiLive2DModelControls } from '../engine/runtime/Cubism2PixiLive2DModelControls';
import type {
  Live2DRuntimeControlPort,
} from '../engine/runtime/Live2DRuntimeControlPort';
import type { Live2DSeekRestoreResult } from '../engine/runtime/Live2DRuntimeContracts';
import { mockControls } from './helpers/mockLive2DRuntimeAdapter';
import { Live2DCompositeModel } from '../engine/Live2DCompositeModel';

const cubism2Runtime = {
  runtimeFamily: 'cubism2' as const,
  adapterId: 'pixi-live2d-display-cubism2' as const,
  supported: true,
};

function createClock(initialTime: number) {
  let time = initialTime;
  const setUserTimeMSec = vi.fn((next: number) => { time = next; });
  return {
    clock: { getUserTimeMSec: () => time, setUserTimeMSec },
    setUserTimeMSec,
    getTime: () => time,
  };
}

afterEach(() => {
  registerSharedRuntimeClockProvider(() => null);
});

function createControls(): Live2DRuntimeControlPort {
  return mockControls({
    restoreSeekState: vi.fn(async (): Promise<Live2DSeekRestoreResult> => ({
      status: 'unsupported',
      tierUsed: 'unsupported',
    })),
  });
}

describe('createLive2DModelHandle', () => {
  it('distinguishes SDK offset replay from direct native offsets', () => {
    const capabilities = resolveLive2DRuntimeCapabilities({
      runtimeFamily: 'cubism3-plus',
      adapterId: 'untitled-pixi-live2d-engine-cubism',
      supported: true,
    });
    expect(capabilities).toMatchObject({
      evaluatesPoseOnZeroDelta: true,
      supportsMotionHandoff: true,
      supportsCompositeModels: false,
      supportsFallbackModel: false,
      determinism: {
        supportsNativeMotionOffset: true,
        supportsMotionOffsetReplay: false,
        supportsStateReplay: false,
      },
    });
  });

  it('uses handle capabilities even when the descriptor identifies a different adapter', () => {
    const capabilities = resolveLive2DRuntimeCapabilities({
      runtimeFamily: 'cubism3-plus',
      adapterId: 'untitled-pixi-live2d-engine-cubism',
      supported: true,
    });
    expect(getLive2DRuntimeCapabilities({
      runtime: { runtimeFamily: 'cubism2', adapterId: 'pixi-live2d-display-cubism2', supported: true },
      runtimeHandle: { capabilities },
    })).toBe(capabilities);
    expect(getLive2DRuntimeCapabilities({})).not.toHaveProperty('usesCubism2PrivateControls');
  });

  it('does not advertise controls for an unsupported composite runtime', () => {
    const capabilities = resolveLive2DRuntimeCapabilities({
      runtimeFamily: 'cubism3-plus',
      adapterId: 'untitled-pixi-live2d-engine-cubism',
      supported: false,
    });
    expect(capabilities).toMatchObject({
      supportsMotion: false,
      supportsSnapshot: false,
      evaluatesPoseOnZeroDelta: false,
      supportsCompositeModels: false,
      determinism: { tier: 'unsupported', supportsNativeMotionOffset: false, supportsMotionOffsetReplay: false },
    });
  });

  it('exposes runtime metadata and capability flags', () => {
    const model = { name: 'tomori-model' };
    const handle = createLive2DModelHandle({
      id: 'tomori',
      model,
      runtime: {
        runtimeFamily: 'cubism2',
        adapterId: 'pixi-live2d-display-cubism2',
        supported: true,
      },
      controls: createControls(),
    });

    expect(handle.id).toBe('tomori');
    expect(handle.runtime.runtimeFamily).toBe('cubism2');
    expect(handle.displayObject).toBe(model);
    expect(handle).not.toHaveProperty('rawModel');
    expect(handle.capabilities).toEqual({
      runtimeFamily: 'cubism2',
      adapterId: 'pixi-live2d-display-cubism2',
      supportsMotion: true,
      supportsExpression: true,
      supportsParameterInjection: true,
      supportsSnapshot: true,
      supportsBakeRender: true,
      evaluatesPoseOnZeroDelta: false,
      supportsMotionHandoff: false,
      supportsCompositeModels: true,
      supportsFallbackModel: true,
      determinism: {
        tier: 'offset-replay-deterministic',
        supportsParameterCurves: true,
        supportsNativeMotionOffset: false,
        supportsMotionOffsetReplay: true,
        supportsStateReplay: false,
        diagnostics: [
          'Cubism 2 motion offsets require fixed-step replay with a shared SDK clock.',
          'Stateful Physics/Pose replay is not guaranteed by this adapter.',
        ],
      },
    });

    const unknownHandle = createLive2DModelHandle({
      id: 'unknown',
      model,
      runtime: {
        runtimeFamily: 'unknown',
        adapterId: 'unknown',
        supported: true,
      },
      controls: createControls(),
    });
    expect(unknownHandle.capabilities).toMatchObject({
      supportsMotion: false,
      supportsExpression: false,
      supportsParameterInjection: false,
      supportsSnapshot: false,
      supportsBakeRender: false,
      determinism: {
        tier: 'unsupported',
        supportsParameterCurves: false,
        supportsNativeMotionOffset: false,
        supportsMotionOffsetReplay: false,
        supportsStateReplay: false,
        diagnostics: ['No runtime adapter can provide deterministic motion evaluation.'],
      },
    });
  });

  it('delegates lifecycle operations to controls for the wrapped model', () => {
    const model = { name: 'lifecycle-model' };
    const controls = createControls();
    const handle = createLive2DModelHandle({
      id: 'lifecycle',
      model,
      runtime: {
        runtimeFamily: 'cubism2',
        adapterId: 'pixi-live2d-display-cubism2',
        supported: true,
      },
      controls,
    });

    handle.lifecycle.clearMotionState();
    handle.lifecycle.stopAllMotions();

    expect(controls.clearMotionState).toHaveBeenCalledWith(model);
    expect(controls.stopAllMotions).toHaveBeenCalledWith(model);
  });

  it('delegates motion queries and preload requests through the motion facade', async () => {
    const model = { name: 'motion-model' };
    const controls = createControls();
    vi.mocked(controls.getAvailableMotions).mockReturnValue(['idle', 'wave']);
    vi.mocked(controls.getMotionDuration).mockReturnValue(1.75);
    vi.mocked(controls.getMotionDebugState).mockReturnValue({ currentGroup: 'wave' });
    const handle = createLive2DModelHandle({
      id: 'motion',
      model,
      runtime: {
        runtimeFamily: 'cubism3-plus',
        adapterId: 'untitled-pixi-live2d-engine-cubism',
        supported: true,
      },
      controls,
    });

    expect(handle.motion.getAvailableMotions()).toEqual(['idle', 'wave']);
    expect(handle.motion.getMotionDuration('wave')).toBe(1.75);
    expect(handle.motion.getMotionDebugState()).toEqual({ currentGroup: 'wave' });
    await handle.motion.preloadMotion('wave');

    expect(controls.getAvailableMotions).toHaveBeenCalledWith(model);
    expect(controls.getMotionDuration).toHaveBeenCalledWith(model, 'wave');
    expect(controls.getMotionDebugState).toHaveBeenCalledWith(model);
    expect(controls.preloadMotion).toHaveBeenCalledWith(model, 'wave');
  });

  it('delegates expression listing and expression reset/set operations', () => {
    const model = { name: 'expression-model' };
    const controls = createControls();
    vi.mocked(controls.getAvailableExpressions).mockReturnValue(['smile', 'angry']);
    const handle = createLive2DModelHandle({
      id: 'expression',
      model,
      runtime: {
        runtimeFamily: 'cubism3-plus',
        adapterId: 'untitled-pixi-live2d-engine-cubism',
        supported: true,
      },
      controls,
    });

    expect(handle.expression.getAvailableExpressions()).toEqual(['smile', 'angry']);
    handle.expression.setExpression('smile');
    handle.expression.setExpression(null);

    expect(controls.getAvailableExpressions).toHaveBeenCalledWith(model);
    expect(controls.setExpression).toHaveBeenNthCalledWith(1, model, 'smile');
    expect(controls.setExpression).toHaveBeenNthCalledWith(2, model, null);
  });

  it('delegates parameter reads, injection, and input synchronization', () => {
    const model = { name: 'parameter-model' };
    const controls = createControls();
    const values = [{ index: 0, name: 'PARAM_ANGLE_X', value: 0.25 }];
    vi.mocked(controls.getParameterValues).mockReturnValue(values);
    const handle = createLive2DModelHandle({
      id: 'parameter',
      model,
      runtime: {
        runtimeFamily: 'cubism2',
        adapterId: 'pixi-live2d-display-cubism2',
        supported: true,
      },
      controls,
    });

    expect(handle.parameters.getParameterValues()).toEqual(values);
    handle.parameters.setInjectedParameter('PARAM_ANGLE_X', 0.8);
    handle.parameters.syncInputParameters();

    expect(controls.getParameterValues).toHaveBeenCalledWith(model);
    expect(controls.setInjectedParameter).toHaveBeenCalledWith(model, 'PARAM_ANGLE_X', 0.8);
    expect(controls.syncInputParameters).toHaveBeenCalledWith(model);
  });

  it('delegates snapshot capture, application, and seek restoration', async () => {
    const model = { name: 'snapshot-model' };
    const controls = createControls();
    const snapshot = { params: new Float32Array([0.25]) } as any;
    const seekInput = {
      id: 'snapshot',
      targetSceneTime: 4,
      isScrubbing: true,
    } as any;
    const restoreResult = { status: 'restored', tierUsed: 'native' } as any;
    vi.mocked(controls.captureSnapshot).mockReturnValue(snapshot);
    vi.mocked(controls.restoreSeekState).mockResolvedValue(restoreResult);
    const handle = createLive2DModelHandle({
      id: 'snapshot',
      model,
      runtime: {
        runtimeFamily: 'cubism3-plus',
        adapterId: 'untitled-pixi-live2d-engine-cubism',
        supported: true,
      },
      controls,
    });

    expect(handle.snapshot.captureSnapshot(3.5)).toBe(snapshot);
    handle.snapshot.applySnapshot(snapshot);
    await expect(handle.snapshot.restoreSeekState(seekInput)).resolves.toBe(restoreResult);

    expect(controls.captureSnapshot).toHaveBeenCalledWith('snapshot', model, 3.5);
    expect(controls.applySnapshot).toHaveBeenCalledWith(model, snapshot);
    expect(controls.restoreSeekState).toHaveBeenCalledWith(model, expect.objectContaining({
      ...seekInput,
      id: 'snapshot',
      isCurrent: expect.any(Function),
    }));
  });

  it('owns preload, snapshot handoff, replay and expression restoration in a bound transition', async () => {
    const model = { name: 'transition-model' };
    const controls = createControls();
    const order: string[] = [];
    const handoff = { params: new Float32Array([0.5]), opacities: new Float32Array([1]) };
    vi.mocked(controls.preloadMotion).mockImplementation(async () => { order.push('preload'); });
    vi.mocked(controls.startMotion).mockImplementation(async (_model, _key, _priority, _offset, options) => {
      order.push('start');
      await options?.beforeReplay?.({ motionStartUtTimeMs: 10 });
      return { ok: true, offsetReplayMs: 50, motionStartUtTimeMs: 10 };
    });
    vi.mocked(controls.applySnapshot).mockImplementation(() => { order.push('snapshot'); });
    vi.mocked(controls.setExpressionForSeek!).mockImplementation(async () => { order.push('expression'); });
    vi.mocked(controls.captureSnapshot).mockReturnValue({
      params: new Float32Array([0]),
      opacities: new Float32Array([1]),
    });
    const handle = createLive2DModelHandle({
      id: 'transition',
      model,
      runtime: { runtimeFamily: 'cubism2', adapterId: 'pixi-live2d-display-cubism2', supported: true },
      controls,
    });

    const result = await handle.performance.transition({
      motionKey: 'wave', priority: 3, offsetSeconds: 0.05, sceneTimeSeconds: 2,
      handoffSnapshot: handoff, expressionKey: 'smile', restoreHandoffBoundary: true, isCurrent: () => true,
    });

    expect(result).toMatchObject({ status: 'started', offsetReplayMs: 50, retainedHandoffBoundary: true });
    expect(order).toEqual(['preload', 'start', 'snapshot', 'expression', 'snapshot']);
    expect(controls.setExpressionForSeek).toHaveBeenCalledWith(
      model, 'smile', 0, undefined, expect.any(Function), expect.objectContaining({ token: expect.any(Symbol) }),
    );
    expect(controls.startMotion).toHaveBeenCalledWith(model, 'wave', 3, 0.05, expect.objectContaining({
      clearQueueFirst: undefined,
      isCurrent: expect.any(Function),
      beforeReplay: expect.any(Function),
    }));
  });

  it('drops a transition after preload when its operation is no longer current', async () => {
    const controls = createControls();
    let current = true;
    vi.mocked(controls.preloadMotion).mockImplementation(async () => { current = false; });
    const handle = createLive2DModelHandle({
      id: 'stale-transition',
      model: {},
      runtime: { runtimeFamily: 'cubism3-plus', adapterId: 'untitled-pixi-live2d-engine-cubism', supported: true },
      controls,
    });

    await expect(handle.performance.transition({
      motionKey: 'wave', priority: 3, offsetSeconds: 0, sceneTimeSeconds: 1, isCurrent: () => current,
    })).resolves.toMatchObject({ status: 'cancelled' });
    expect(controls.startMotion).not.toHaveBeenCalled();
    expect(controls.applySnapshot).not.toHaveBeenCalled();
  });

  it('waits for cancellable expression restoration and suppresses a stale result', async () => {
    const controls = createControls();
    const model = {};
    let current = true;
    let finishExpression!: () => void;
    const expressionLoad = new Promise<void>((resolve) => { finishExpression = resolve; });
    const appliedExpressions: Array<string | null> = [];
    vi.mocked(controls.setExpressionForSeek!).mockImplementation(async (_model, expression, _elapsed, _previous, isCurrent) => {
      await expressionLoad;
      if (isCurrent?.()) appliedExpressions.push(expression);
    });
    const handle = createLive2DModelHandle({
      id: 'stale-expression-transition',
      model,
      runtime: { runtimeFamily: 'cubism3-plus', adapterId: 'untitled-pixi-live2d-engine-cubism', supported: true },
      controls,
    });

    const transition = handle.performance.transition({
      motionKey: 'wave', priority: 3, offsetSeconds: 0, sceneTimeSeconds: 1,
      expressionKey: 'smile', isCurrent: () => current,
    });
    await vi.waitFor(() => expect(controls.setExpressionForSeek).toHaveBeenCalledOnce());
    current = false;
    finishExpression();

    await expect(transition).resolves.toMatchObject({ status: 'cancelled' });
    expect(appliedExpressions).toEqual([]);
  });

  it('submits frame parameters after advancement and commits geometry once per batch', () => {
    const model = { name: 'frame-model' };
    const controls = createControls();
    const order: string[] = [];
    vi.mocked(controls.advanceFrame).mockImplementation(() => { order.push('advance'); });
    vi.mocked(controls.setInjectedParameter).mockImplementation((_model, id) => { order.push(id); });
    vi.mocked(controls.syncInputParameters).mockImplementation(() => { order.push('commit'); });
    const handle = createLive2DModelHandle({
      id: 'frame',
      model,
      runtime: { runtimeFamily: 'cubism3-plus', adapterId: 'untitled-pixi-live2d-engine-cubism', supported: true },
      controls,
    });

    expect(handle.frame.submit({
      deltaMs: 16,
      shouldAdvance: true,
      injectedParameters: { PARAM_ANGLE_X: 0.2, PARAM_MOUTH_OPEN_Y: 0.7 },
    })).toEqual({ status: 'submitted', retainedHandoffBoundary: undefined });
    expect(order).toEqual(['advance', 'PARAM_ANGLE_X', 'PARAM_MOUTH_OPEN_Y', 'commit']);
  });

  it('restores focus updater lifecycle through the bound focus behavior', () => {
    const controls = createControls();
    const handle = createLive2DModelHandle({
      id: 'focus',
      model: {},
      runtime: { runtimeFamily: 'cubism2', adapterId: 'pixi-live2d-display-cubism2', supported: true },
      controls,
    });

    handle.focus.manageAnimations('stop');
    handle.focus.manageAnimations('pause');
    handle.focus.manageAnimations('resume');

    expect(controls.manageFocusAnimations).toHaveBeenNthCalledWith(1, expect.anything(), 'stop');
    expect(controls.manageFocusAnimations).toHaveBeenNthCalledWith(2, expect.anything(), 'pause');
    expect(controls.manageFocusAnimations).toHaveBeenNthCalledWith(3, expect.anything(), 'resume');
  });

  it('delegates bake rendering and invalid-state diagnostics', () => {
    const model = { name: 'render-model' };
    const renderer = { name: 'renderer' } as unknown as PIXI.Renderer;
    const renderTexture = { name: 'texture' } as unknown as PIXI.RenderTexture;
    const controls = createControls();
    vi.mocked(controls.describeInvalidState).mockReturnValue('primary param[0]=NaN');
    const handle = createLive2DModelHandle({
      id: 'render',
      model,
      runtime: {
        runtimeFamily: 'cubism2',
        adapterId: 'pixi-live2d-display-cubism2',
        supported: true,
      },
      controls,
    });

    handle.render.renderForBake(renderer, 'frame-24', renderTexture);

    expect(handle.diagnostics.describeInvalidState()).toBe('primary param[0]=NaN');
    expect(controls.renderForBake).toHaveBeenCalledWith(model, renderer, 'frame-24', renderTexture);
    expect(controls.describeInvalidState).toHaveBeenCalledWith(model);
  });

  it('defers ordinary frame submission while the runtime clock is locked', async () => {
    let time = 100;
    const clock = {
      getUserTimeMSec: () => time,
      setUserTimeMSec: (next: number) => { time = next; },
    };
    const controls = createControls();
    const handle = createLive2DModelHandle({
      id: 'transaction-frame',
      model: {},
      runtime: { runtimeFamily: 'cubism2', adapterId: 'pixi-live2d-display-cubism2', supported: true },
      controls,
    });
    await withSharedRuntimeClock(clock, () => true, async () => {
      expect(isSharedRuntimeClockLocked()).toBe(true);
      expect(handle.frame.submit({ deltaMs: 16, shouldAdvance: true }).status).toBe('deferred');
    });

    expect(controls.advanceFrame).not.toHaveBeenCalled();
    expect(isSharedRuntimeClockLocked()).toBe(false);
  });
});

describe('submitLive2DBakeFrameBatch', () => {
  it('starts transitions, restores idle, and advances one shared clock for multiple bound models', async () => {
    const { clock, setUserTimeMSec, getTime } = createClock(100);
    registerSharedRuntimeClockProvider(() => clock);
    const order: string[] = [];
    const controlsFor = (id: string) => mockControls({
      stopAllMotions: vi.fn(() => { order.push(`${id}:stop`); }),
      clearMotionState: vi.fn(() => { order.push(`${id}:clear`); }),
      applySnapshot: vi.fn(() => { order.push(`${id}:snapshot`); }),
      restartIdleMotion: vi.fn(async () => {
        expect(isSharedRuntimeClockLocked()).toBe(true);
        order.push(`${id}:idle`);
      }),
      hasMotionGroup: vi.fn(() => true),
      startMotion: vi.fn(async (_model, _key, _priority, _offset, options) => {
        expect(isSharedRuntimeClockLocked()).toBe(true);
        expect(options?.clock).toBe(clock);
        order.push(`${id}:motion`);
        return { ok: true, offsetReplayMs: 25 };
      }),
      stepBakeFrame: vi.fn(() => {
        expect(isSharedRuntimeClockLocked()).toBe(true);
        order.push(`${id}:frame`);
      }),
    });
    const firstControls = controlsFor('first');
    const secondControls = controlsFor('second');
    const first = createLive2DModelHandle({ id: 'first', model: {}, runtime: cubism2Runtime, controls: firstControls });
    const second = createLive2DModelHandle({ id: 'second', model: {}, runtime: cubism2Runtime, controls: secondControls });
    const idleSnapshot = { params: new Float32Array([0]), opacities: new Float32Array([1]) };

    const result = await submitLive2DBakeFrameBatch({
      operations: [
        {
          handle: first,
          isCurrent: () => true,
          resetForPlayback: { idleSnapshot, restartIdleMotion: true },
        },
        {
          handle: second,
          isCurrent: () => true,
          motionStart: { motionKey: 'wave', priority: 3, offsetSeconds: 0.25, sceneTimeSeconds: 1 },
        },
      ],
      deltaMs: 16,
      isCurrent: () => true,
    });

    expect(result.status).toBe('submitted');
    expect(result.transitions.get('second')?.status).toBe('started');
    expect(order).toEqual([
      'first:stop', 'first:clear', 'first:snapshot', 'first:idle',
      'second:motion', 'first:frame', 'second:frame',
    ]);
    expect(getTime()).toBe(116);
    expect(setUserTimeMSec).toHaveBeenCalledTimes(1);
    expect(isSharedRuntimeClockLocked()).toBe(false);
  });

  it('cancels after an awaited preload when a model borrow becomes stale', async () => {
    const { clock, setUserTimeMSec } = createClock(250);
    registerSharedRuntimeClockProvider(() => clock);
    let current = true;
    let finishPreload!: () => void;
    const preloadGate = new Promise<void>((resolve) => { finishPreload = resolve; });
    const controls = mockControls({
      preloadMotion: vi.fn(async () => preloadGate),
      startMotion: vi.fn(async () => ({ ok: true, offsetReplayMs: 0 })),
      stepBakeFrame: vi.fn(),
    });
    const handle = createLive2DModelHandle({ id: 'stale', model: {}, runtime: cubism2Runtime, controls });

    const batchPromise = submitLive2DBakeFrameBatch({
      operations: [{
        handle,
        isCurrent: () => current,
        motionStart: { motionKey: 'wave', priority: 3, offsetSeconds: 0.5, sceneTimeSeconds: 1 },
      }],
      deltaMs: 16,
      isCurrent: () => true,
    });
    while (vi.mocked(controls.preloadMotion).mock.calls.length === 0) await Promise.resolve();
    current = false;
    finishPreload();

    const result = await batchPromise;
    expect(result.status).toBe('cancelled');
    expect(controls.startMotion).not.toHaveBeenCalled();
    expect(controls.stepBakeFrame).not.toHaveBeenCalled();
    expect(setUserTimeMSec).not.toHaveBeenCalled();
    expect(isSharedRuntimeClockLocked()).toBe(false);
  });

  it('keeps the shared clock monotonic and releases the lock when a native transition throws', async () => {
    const { clock, setUserTimeMSec, getTime } = createClock(500);
    registerSharedRuntimeClockProvider(() => clock);
    const controls = mockControls({
      hasMotionGroup: vi.fn(() => true),
      startMotion: vi.fn(async (_model, _key, _priority, _offset, options) => {
        options?.clock?.setUserTimeMSec(-20);
        throw new Error('native transition failed');
      }),
      stepBakeFrame: vi.fn(),
    });
    const handle = createLive2DModelHandle({ id: 'throwing', model: {}, runtime: cubism2Runtime, controls });

    await expect(submitLive2DBakeFrameBatch({
      operations: [{
        handle,
        isCurrent: () => true,
        motionStart: { motionKey: 'wave', priority: 3, offsetSeconds: 0.5, sceneTimeSeconds: 1 },
      }],
      deltaMs: 16,
      isCurrent: () => true,
    })).rejects.toThrow('native transition failed');

    expect(getTime()).toBe(500);
    expect(setUserTimeMSec).toHaveBeenCalledWith(500);
    expect(controls.stepBakeFrame).not.toHaveBeenCalled();
    expect(isSharedRuntimeClockLocked()).toBe(false);
  });

  it('keeps the shared clock monotonic and skips later models when a borrow is cancelled during a frame', async () => {
    const { clock, getTime, setUserTimeMSec } = createClock(800);
    registerSharedRuntimeClockProvider(() => clock);
    let current = true;
    const firstControls = mockControls({
      stepBakeFrame: vi.fn(() => { current = false; }),
    });
    const secondControls = mockControls({ stepBakeFrame: vi.fn() });
    const first = createLive2DModelHandle({ id: 'first-cancelled-frame', model: {}, runtime: cubism2Runtime, controls: firstControls });
    const second = createLive2DModelHandle({ id: 'second-cancelled-frame', model: {}, runtime: cubism2Runtime, controls: secondControls });

    const result = await submitLive2DBakeFrameBatch({
      operations: [
        { handle: first, isCurrent: () => current },
        { handle: second, isCurrent: () => true },
      ],
      deltaMs: 16,
      isCurrent: () => true,
    });

    expect(result.status).toBe('cancelled');
    expect(getTime()).toBe(816);
    expect(setUserTimeMSec).toHaveBeenCalledOnce();
    expect(setUserTimeMSec).toHaveBeenCalledWith(816);
    expect(firstControls.stepBakeFrame).toHaveBeenCalledOnce();
    expect(secondControls.stepBakeFrame).not.toHaveBeenCalled();
    expect(isSharedRuntimeClockLocked()).toBe(false);
  });

  it('keeps the shared clock monotonic when a later model is cancelled after an earlier frame submits', async () => {
    const { clock, getTime, setUserTimeMSec } = createClock(900);
    registerSharedRuntimeClockProvider(() => clock);
    let current = true;
    const firstControls = mockControls({ stepBakeFrame: vi.fn() });
    const secondControls = mockControls({ stepBakeFrame: vi.fn(() => { current = false; }) });
    const first = createLive2DModelHandle({ id: 'first-submitted-frame', model: {}, runtime: cubism2Runtime, controls: firstControls });
    const second = createLive2DModelHandle({ id: 'second-cancelled-frame', model: {}, runtime: cubism2Runtime, controls: secondControls });

    const result = await submitLive2DBakeFrameBatch({
      operations: [
        { handle: first, isCurrent: () => current },
        { handle: second, isCurrent: () => current },
      ],
      deltaMs: 16,
      isCurrent: () => true,
    });

    expect(result.status).toBe('cancelled');
    expect(firstControls.stepBakeFrame).toHaveBeenCalledOnce();
    expect(secondControls.stepBakeFrame).toHaveBeenCalledOnce();
    expect(getTime()).toBe(916);
    expect(setUserTimeMSec).toHaveBeenCalledOnce();
    expect(setUserTimeMSec).toHaveBeenCalledWith(916);
    expect(isSharedRuntimeClockLocked()).toBe(false);
  });

  it('keeps the shared clock monotonic when a later model frame throws after an earlier frame submits', async () => {
    const { clock, getTime, setUserTimeMSec } = createClock(920);
    registerSharedRuntimeClockProvider(() => clock);
    const firstControls = mockControls({ stepBakeFrame: vi.fn() });
    const secondControls = mockControls({
      stepBakeFrame: vi.fn(() => { throw new Error('later frame failed'); }),
    });
    const first = createLive2DModelHandle({ id: 'first-submitted-before-throw', model: {}, runtime: cubism2Runtime, controls: firstControls });
    const second = createLive2DModelHandle({ id: 'second-throwing-frame', model: {}, runtime: cubism2Runtime, controls: secondControls });

    await expect(submitLive2DBakeFrameBatch({
      operations: [
        { handle: first, isCurrent: () => true },
        { handle: second, isCurrent: () => true },
      ],
      deltaMs: 16,
      isCurrent: () => true,
    })).rejects.toThrow('later frame failed');

    expect(firstControls.stepBakeFrame).toHaveBeenCalledOnce();
    expect(secondControls.stepBakeFrame).toHaveBeenCalledOnce();
    expect(getTime()).toBe(936);
    expect(setUserTimeMSec).toHaveBeenCalledOnce();
    expect(setUserTimeMSec).toHaveBeenCalledWith(936);
    expect(isSharedRuntimeClockLocked()).toBe(false);
  });

  it('keeps the shared clock monotonic when a bound model frame throws', async () => {
    const { clock, getTime, setUserTimeMSec } = createClock(850);
    registerSharedRuntimeClockProvider(() => clock);
    const controls = mockControls({
      stepBakeFrame: vi.fn(() => { throw new Error('frame failed'); }),
    });
    const handle = createLive2DModelHandle({ id: 'failed-frame', model: {}, runtime: cubism2Runtime, controls });

    await expect(submitLive2DBakeFrameBatch({
      operations: [{ handle, isCurrent: () => true }],
      deltaMs: 16,
      isCurrent: () => true,
    })).rejects.toThrow('frame failed');

    expect(getTime()).toBe(866);
    expect(setUserTimeMSec).toHaveBeenCalledOnce();
    expect(setUserTimeMSec).toHaveBeenCalledWith(866);
    expect(isSharedRuntimeClockLocked()).toBe(false);
  });

  it('normalizes an invalid starting clock to a finite value on failure', async () => {
    const { clock, getTime, setUserTimeMSec } = createClock(Number.NaN);
    registerSharedRuntimeClockProvider(() => clock);
    const controls = mockControls({
      hasMotionGroup: vi.fn(() => true),
      startMotion: vi.fn(async (_model, _key, _priority, _offset, options) => {
        options?.clock?.setUserTimeMSec(Number.NaN);
        throw new Error('native transition failed');
      }),
    });
    const handle = createLive2DModelHandle({ id: 'invalid-clock', model: {}, runtime: cubism2Runtime, controls });

    await expect(submitLive2DBakeFrameBatch({
      operations: [{
        handle,
        isCurrent: () => true,
        motionStart: { motionKey: 'wave', priority: 3, offsetSeconds: 0.5, sceneTimeSeconds: 1 },
      }],
      deltaMs: 16,
      isCurrent: () => true,
    })).rejects.toThrow('native transition failed');

    expect(getTime()).toBe(0);
    expect(setUserTimeMSec).toHaveBeenLastCalledWith(0);
    expect(isSharedRuntimeClockLocked()).toBe(false);
  });

  it('runs a composite bake frame once with main-before-submodel updates', async () => {
    const { clock, getTime, setUserTimeMSec } = createClock(900);
    registerSharedRuntimeClockProvider(() => clock);
    const order: string[] = [];
    const coreModel = () => ({
      getParamIndex: () => -1,
      getParameterValues: () => new Float32Array(0),
      update: vi.fn(),
    });
    const mainModel = new PIXI.Container() as PIXI.Container & {
      internalModel: { coreModel: ReturnType<typeof coreModel> };
      update: ReturnType<typeof vi.fn>;
    };
    mainModel.name = 'main';
    mainModel.internalModel = { coreModel: coreModel() };
    mainModel.update = vi.fn(() => { order.push('main'); });
    const subModel = new PIXI.Container() as PIXI.Container & {
      internalModel: { coreModel: ReturnType<typeof coreModel> };
      update: ReturnType<typeof vi.fn>;
    };
    subModel.name = 'sub';
    subModel.internalModel = { coreModel: coreModel() };
    subModel.update = vi.fn(() => { order.push('sub'); });
    const composite = new Live2DCompositeModel(mainModel, [subModel]);
    const controls = new Cubism2PixiLive2DModelControls();
    const frame = vi.spyOn(controls, 'stepBakeFrame');
    const handle = createLive2DModelHandle({ id: 'composite-bake', model: composite, runtime: cubism2Runtime, controls });

    const result = await submitLive2DBakeFrameBatch({
      operations: [{ handle, isCurrent: () => true }],
      deltaMs: 16,
      isCurrent: () => true,
    });

    expect(result.status).toBe('submitted');
    expect(frame).toHaveBeenCalledOnce();
    expect(order).toEqual(['main', 'sub']);
    expect(getTime()).toBe(916);
    expect(setUserTimeMSec).toHaveBeenCalledOnce();
  });
});
