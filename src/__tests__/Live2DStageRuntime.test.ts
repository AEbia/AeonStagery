import { live2DStageState } from './helpers/live2DStageState';
import { Live2DModelResources } from '../engine/Live2DModelResources';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Live2DStageRuntime, type Live2DStageRuntimeCallbacks } from '../engine/Live2DStageRuntime';
import type { CharacterEntry } from '../engine/Live2DConfig';
import type { Live2DRuntimeAdapter } from '../engine/runtime/Live2DRuntimeContracts';
import type { Live2DRuntimeControlPort } from '../engine/runtime/Live2DRuntimeControlPort';
import type { Live2DRuntimeDescriptor } from '../engine/Live2DRuntimeResolver';
import type { MotionRequest } from '../engine/Live2DMotionController';
import * as runtimeAdapter from '../engine/Live2DRuntimeAdapter';
import { CubismPixiLive2DAdapter } from '../engine/Live2DRuntimeAdapter';
import { createCubismModelFixture } from './helpers/cubismModelFixture';
import { acquireSharedRuntimeClockLock, releaseSharedRuntimeClockLock } from '../engine/live2d/runtime/Live2DRuntimeClockCoordinator';
import { createLive2DModelHandle } from '../engine/live2d/runtime/Live2DRuntimeControlModule';
import { mockControls } from './helpers/mockLive2DRuntimeAdapter';
import { Bounds, Container, ObservablePoint } from 'pixi.js';
import { stageManager } from '../engine/StageManager';
import { installLive2DRenderPreparation } from '../engine/live2d/runtime/Live2DRenderPreparation';

function createStage(callbacks: Omit<Live2DStageRuntimeCallbacks, 'getCamera' | 'isExportMode' | 'applyIntent'>) {
  return new Live2DStageRuntime({
    ...callbacks,
    getCamera: () => null,
    isExportMode: () => false,
    applyIntent: vi.fn(),
  }, new Live2DModelResources(() => ''));
}

const runtime = {
  runtimeFamily: 'cubism2' as const,
  adapterId: 'pixi-live2d-display-cubism2' as const,
  supported: true,
};

function makeEntry(id: string, model: Record<string, unknown>): CharacterEntry {
  return {
    id,
    model,
    modelPath: `${id}.model.json`,
    modelUrl: `${id}.model.json`,
    runtime,
    adapterId: runtime.adapterId,
    config: {},
    injectedParams: {},
    lipSyncParameterIds: new Set(),
    baseHeight: 100,
    motionEpoch: 0,
  };
}

describe('Live2DStageRuntime', () => {
  let advanceFrame: ReturnType<typeof vi.fn<(model: object, deltaMs: number) => void>>;
  let setInjectedParameter: ReturnType<typeof vi.fn<(model: object, name: string, value: number) => void>>;
  let syncInputParameters: ReturnType<typeof vi.fn<(model: object) => void>>;
  let dispatchMotion: ReturnType<typeof vi.fn<(id: string, request: MotionRequest) => Promise<void>>>;
  let adapter: Live2DRuntimeAdapter;
  let controls: Live2DRuntimeControlPort;

  beforeEach(() => {
    advanceFrame = vi.fn<(model: object, deltaMs: number) => void>();
    setInjectedParameter = vi.fn<(model: object, name: string, value: number) => void>();
    syncInputParameters = vi.fn<(model: object) => void>();
    dispatchMotion = vi.fn().mockResolvedValue(undefined);
    controls = mockControls({
      advanceFrame,
      setInjectedParameter,
      syncInputParameters,
      captureSnapshot: vi.fn(() => null),
      applySnapshot: vi.fn(),
    });
    adapter = {
      createModelHandle: (id: string, model: object, modelRuntime?: Live2DRuntimeDescriptor) => createLive2DModelHandle({
        id,
        model,
        runtime: modelRuntime ?? runtime,
        controls,
      }),
    } as unknown as Live2DRuntimeAdapter;
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue(adapter);
  });

  it('settles cold drawable geometry before publishing a character anchor', async () => {
    const resources = new Live2DModelResources(() => '');
    let drawableReady = false;
    const container = new Container();
    const anchor = new ObservablePoint({ _onUpdate: () => {
      const bounds = model.getLocalBounds();
      container.pivot.set(bounds.x + bounds.width * anchor.x, bounds.y + bounds.height * anchor.y);
    } });
    const model = Object.assign(container, {
      anchor,
      getLocalBounds: () => drawableReady ? new Bounds(300, 300, 1700, 2880) : new Bounds(0, 0, 2000, 2500),
    });
    installLive2DRenderPreparation(model, () => { drawableReady = true; });
    vi.spyOn(resources, 'loadCharacter').mockImplementation(async (_id, _path, ready) => {
      await ready({ model, modelUrl: 'hero.model.json', runtime, isCurrent: () => true, release: () => {} });
    });
    const renderer = {} as Parameters<NonNullable<Container['onRender']>>[0];
    const app = vi.spyOn(stageManager, 'getApp').mockReturnValue({
      ticker: { add: () => {} }, renderer,
    } as unknown as ReturnType<typeof stageManager.getApp>);
    const layer = vi.spyOn(stageManager, 'getLayer').mockReturnValue(new Container());
    try {
      const stage = new Live2DStageRuntime({
        dispatchMotion, describeInvalidModelState: () => null,
        repairCorruptedModel: vi.fn().mockResolvedValue(undefined), maybeInstallCustomMotionStage: () => {},
        resolveCustomMotionSceneTime: () => 0,
        getScriptEngine: () => ({ transformationProxies: new Map([['hero', {
          x: 960, y: 1242, scale: 1.3, rotation: 0, opacity: 1, z: 0,
        }]]) }),
        getCamera: () => null, isExportMode: () => false, applyIntent: () => {},
      }, resources);
      await stage.addCharacter('hero', 'hero.model.json', { position: [0.5, 1.15], scale: 1.3 });
      const anchors = ['head', 'chest', 'feet', 'center'] as const;
      const captured = anchors.map(part => stage.geometry.getPoint('hero', part));
      model.onRender?.(renderer);
      expect(anchors.map(part => stage.geometry.getPoint('hero', part))).toEqual(captured);
    } finally {
      app.mockRestore();
      layer.mockRestore();
    }
  });

  it('drains pending motion intent before committing the frame', async () => {
    const stage = createStage({
      dispatchMotion,
      describeInvalidModelState: () => null,
      repairCorruptedModel: vi.fn().mockResolvedValue(undefined),
      maybeInstallCustomMotionStage: vi.fn(),
      resolveCustomMotionSceneTime: () => 0,
      getScriptEngine: () => null,
    });
    const model = { autoUpdate: false };
    const entry = makeEntry('hero', model);
    entry._pendingPlayMotion = {
      key: 'wave',
      priority: 3,
      offset: 0,
      sceneTime: 1,
      skipHardReset: false,
      reqEpoch: 1,
    };
    live2DStageState(stage).characters.set(entry.id, entry);

    await stage.step(16, true);

    expect(dispatchMotion).toHaveBeenCalledWith('hero', expect.objectContaining({ key: 'wave' }));
    expect(advanceFrame).toHaveBeenCalledWith(model, 16);
    expect(entry._pendingPlayMotion).toBeUndefined();
  });

  it('keeps parameter injection after runtime advancement', async () => {
    const stage = createStage({
      dispatchMotion,
      describeInvalidModelState: () => null,
      repairCorruptedModel: vi.fn().mockResolvedValue(undefined),
      maybeInstallCustomMotionStage: vi.fn(),
      resolveCustomMotionSceneTime: () => 0,
      getScriptEngine: () => null,
    });
    const entry = makeEntry('hero', { autoUpdate: false });
    entry.injectedParams = { PARAM_ANGLE_X: 0.4 };
    live2DStageState(stage).characters.set(entry.id, entry);

    await stage.step(16);

    expect(advanceFrame.mock.invocationCallOrder[0]).toBeLessThan(setInjectedParameter.mock.invocationCallOrder[0]);
    expect(setInjectedParameter).toHaveBeenCalledWith(entry.model, 'PARAM_ANGLE_X', 0.4);
    expect(syncInputParameters).toHaveBeenCalledWith(entry.model);
  });

  it('uses handle clock capabilities to defer motions and updates during shared clock replay', async () => {
    const stage = createStage({
      dispatchMotion,
      describeInvalidModelState: () => null,
      repairCorruptedModel: vi.fn().mockResolvedValue(undefined),
      maybeInstallCustomMotionStage: vi.fn(),
      resolveCustomMotionSceneTime: () => 0,
      getScriptEngine: () => null,
    });
    const independent = makeEntry('independent', {});
    const shared = makeEntry('shared', {});
    for (const entry of [independent, shared]) {
      entry.runtimeHandle = createLive2DModelHandle({
        id: entry.id,
        model: entry.model,
        // Keep the entry descriptor at Cubism 2 while making the loaded handle
        // authoritative for the independent model's clock behavior.
        runtime: entry.id === 'independent'
          ? { runtimeFamily: 'cubism3-plus', adapterId: 'untitled-pixi-live2d-engine-cubism', supported: true }
          : runtime,
        controls,
      });
      entry._pendingPlayMotion = {
        key: 'wave', priority: 3, offset: 0, sceneTime: 0, skipHardReset: false, reqEpoch: 1,
      };
      live2DStageState(stage).characters.set(entry.id, entry);
    }
    // Both entries say Cubism 2; only the loaded handle declares an independent clock.
    await acquireSharedRuntimeClockLock();
    try {
      await stage.step(16);
      expect(dispatchMotion).toHaveBeenCalledTimes(1);
      expect(dispatchMotion).toHaveBeenCalledWith('independent', expect.anything());
      expect(advanceFrame).toHaveBeenCalledTimes(1);
      expect(advanceFrame).toHaveBeenCalledWith(independent.model, 16);
      expect(shared._pendingPlayMotion).toBeDefined();
    } finally {
      releaseSharedRuntimeClockLock();
    }
  });

  it('defers forced and manual stage frames while the shared clock is locked', async () => {
    const stage = createStage({
      dispatchMotion,
      describeInvalidModelState: () => null,
      repairCorruptedModel: vi.fn().mockResolvedValue(undefined),
      maybeInstallCustomMotionStage: vi.fn(),
      resolveCustomMotionSceneTime: () => 0,
      getScriptEngine: () => null,
    });
    const entry = makeEntry('shared', { autoUpdate: false });
    entry.runtimeHandle = createLive2DModelHandle({
      id: entry.id,
      model: entry.model,
      runtime,
      controls,
    });
    live2DStageState(stage).characters.set(entry.id, entry);

    await acquireSharedRuntimeClockLock();
    try {
      await stage.step(16, false, 1000);
      await stage.step(16, true);
      expect(advanceFrame).not.toHaveBeenCalled();
      expect(syncInputParameters).not.toHaveBeenCalled();
    } finally {
      releaseSharedRuntimeClockLock();
    }
  });

  it('commits and freezes zero-delta evaluation according to the handle', async () => {
    const stage = createStage({
      dispatchMotion,
      describeInvalidModelState: () => null,
      repairCorruptedModel: vi.fn().mockResolvedValue(undefined),
      maybeInstallCustomMotionStage: vi.fn(),
      resolveCustomMotionSceneTime: () => 0,
      getScriptEngine: () => null,
    });
    const entry = makeEntry('hero', {});
    const handle = createLive2DModelHandle({ id: entry.id, model: entry.model, runtime, controls });
    entry.runtimeHandle = {
      ...handle,
      capabilities: { ...handle.capabilities, evaluatesPoseOnZeroDelta: true },
    };
    live2DStageState(stage).characters.set(entry.id, entry);
    stage.setAutoUpdate(false);
    await stage.step(0, true, 1000);
    expect(advanceFrame).toHaveBeenCalledExactlyOnceWith(entry.model, 0);
    await stage.step(16);
    expect(advanceFrame).toHaveBeenCalledTimes(1);
  });

  it('commits cached Cubism 3+ motion poses on paused zero-delta seeks', async () => {
    const { model, internal, drawn } = createCubismModelFixture();
    const adapter = new CubismPixiLive2DAdapter();
    vi.mocked(runtimeAdapter.getLive2DRuntimeAdapter).mockReturnValue(adapter);
    const stage = createStage({
      dispatchMotion,
      describeInvalidModelState: () => null,
      repairCorruptedModel: vi.fn().mockResolvedValue(undefined),
      maybeInstallCustomMotionStage: vi.fn(),
      resolveCustomMotionSceneTime: (_entry, timeMs) => (timeMs ?? 0) / 1000,
      getScriptEngine: () => null,
    });
    const entry = makeEntry('hero', model);
    entry.runtime = { runtimeFamily: 'cubism3-plus', adapterId: 'untitled-pixi-live2d-engine-cubism', supported: true };
    entry.adapterId = entry.runtime.adapterId;
    entry.runtimeHandle = adapter.createModelHandle(entry.id, model, entry.runtime);
    entry.customMotion = {
      motion: {
        kind: 'custom', durationSeconds: 2, fadeInSeconds: 0,
        derivedFrom: { key: 'wave' },
        tracks: [{ parameterId: 'ParamAngleX', keyframes: [{ time: 0, value: 0 }, { time: 2, value: 20 }] }],
      },
      startSceneTime: 0,
      controlledParameterIds: ['ParamAngleX'],
    };
    entry.customMotionHandoff = { values: { ParamAngleX: 0 } };
    entry.customMotionStage = entry.runtimeHandle.customMotion.installStage({
      getState: () => entry.customMotion && entry.customMotionHandoff
        ? { motion: entry.customMotion.motion, startSceneTime: 0, handoff: entry.customMotionHandoff, controlledParameterIds: ['ParamAngleX'] }
        : null,
    });
    expect(entry.customMotionStage).not.toBeNull();
    live2DStageState(stage).characters.set(entry.id, entry);
    stage.setAutoUpdate(false);
    const elapsedTime = model.elapsedTime;
    try {
      await stage.step(0, true, 1000);
      expect(drawn()[4]).toBeCloseTo(10);
      await stage.step(0, true, 2000);
      expect(drawn()[4]).toBeCloseTo(20);
      await stage.step(0, true, 1000);
      expect(drawn()[4]).toBeCloseTo(10);
      expect(internal.update).toHaveBeenCalledTimes(3);
      await stage.step(16);
      expect(drawn()[4]).toBeCloseTo(10);
      expect(model.elapsedTime).toBe(elapsedTime);
    } finally {
      entry.customMotionStage?.dispose();
      model.destroy();
    }
  });

  it('isolates a failed model update from the rest of the frame', async () => {
    const stage = createStage({
      dispatchMotion,
      describeInvalidModelState: () => null,
      repairCorruptedModel: vi.fn().mockResolvedValue(undefined),
      maybeInstallCustomMotionStage: vi.fn(),
      resolveCustomMotionSceneTime: () => 0,
      getScriptEngine: () => null,
    });
    const failingModel = { autoUpdate: false, id: 'failing' };
    const healthyModel = { autoUpdate: false, id: 'healthy' };
    advanceFrame.mockImplementation((model: object) => {
      if ((model as { id: string }).id === 'failing') throw new Error('sdk failure');
    });
    live2DStageState(stage).characters.set('failing', makeEntry('failing', failingModel));
    live2DStageState(stage).characters.set('healthy', makeEntry('healthy', healthyModel));

    await expect(stage.step(16)).resolves.toBeUndefined();
    expect(advanceFrame).toHaveBeenCalledTimes(2);
  });

  it('waits for in-flight operations and clears coordinator state', async () => {
    let releaseMutex!: () => void;
    const mutex = new Promise<void>(resolve => { releaseMutex = resolve; });
    const stage = createStage({
      dispatchMotion,
      describeInvalidModelState: () => null,
      repairCorruptedModel: vi.fn().mockResolvedValue(undefined),
      maybeInstallCustomMotionStage: vi.fn(),
      resolveCustomMotionSceneTime: () => 0,
      getScriptEngine: () => null,
    });
    live2DStageState(stage).characters.set('hero', makeEntry('hero', { autoUpdate: false }));
    live2DStageState(stage).pendingMotions.set('hero', []);
    live2DStageState(stage).motionMutex.set('hero', mutex);
    const wait = stage.waitForQuiescence(vi.fn().mockResolvedValue(undefined));

    await Promise.resolve();
    releaseMutex();
    live2DStageState(stage).motionMutex.delete('hero');
    await wait;
    stage.clear();

    expect(live2DStageState(stage).characters.size).toBe(0);
    expect(live2DStageState(stage).pendingMotions.size).toBe(0);
    expect(live2DStageState(stage).motionMutex.size).toBe(0);
  });
});
