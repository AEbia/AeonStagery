import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Live2DStageRuntime } from '../engine/Live2DStageRuntime';
import type { CharacterEntry } from '../engine/Live2DConfig';
import type { Live2DRuntimeAdapter, Live2DRuntimeModelControls } from '../engine/runtime/Live2DRuntimeContracts';
import type { MotionRequest } from '../engine/Live2DMotionController';
import * as runtimeAdapter from '../engine/Live2DRuntimeAdapter';
import { CubismPixiLive2DAdapter } from '../engine/Live2DRuntimeAdapter';
import { createCubismModelFixture } from './helpers/cubismModelFixture';

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
  let advanceFrame: ReturnType<typeof vi.fn>;
  let setInjectedParameter: ReturnType<typeof vi.fn>;
  let syncInputParameters: ReturnType<typeof vi.fn>;
  let dispatchMotion: ReturnType<typeof vi.fn<(id: string, request: MotionRequest) => Promise<void>>>;
  let adapter: Live2DRuntimeAdapter;

  beforeEach(() => {
    advanceFrame = vi.fn();
    setInjectedParameter = vi.fn();
    syncInputParameters = vi.fn();
    dispatchMotion = vi.fn().mockResolvedValue(undefined);
    const controls = {
      advanceFrame,
      setInjectedParameter,
      syncInputParameters,
      captureSnapshot: vi.fn(() => null),
      applySnapshot: vi.fn(),
    } as unknown as Live2DRuntimeModelControls;
    adapter = { getControls: () => controls } as unknown as Live2DRuntimeAdapter;
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue(adapter);
  });

  it('drains pending motion intent before committing the frame', async () => {
    const stage = new Live2DStageRuntime({
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
    stage.characters.set(entry.id, entry);

    await stage.step(16, true);

    expect(dispatchMotion).toHaveBeenCalledWith('hero', expect.objectContaining({ key: 'wave' }));
    expect(advanceFrame).toHaveBeenCalledWith(model, 16);
    expect(entry._pendingPlayMotion).toBeUndefined();
  });

  it('keeps parameter injection after runtime advancement', async () => {
    const stage = new Live2DStageRuntime({
      dispatchMotion,
      describeInvalidModelState: () => null,
      repairCorruptedModel: vi.fn().mockResolvedValue(undefined),
      maybeInstallCustomMotionStage: vi.fn(),
      resolveCustomMotionSceneTime: () => 0,
      getScriptEngine: () => null,
    });
    const entry = makeEntry('hero', { autoUpdate: false });
    entry.injectedParams = { PARAM_ANGLE_X: 0.4 };
    stage.characters.set(entry.id, entry);

    await stage.step(16);

    expect(advanceFrame.mock.invocationCallOrder[0]).toBeLessThan(setInjectedParameter.mock.invocationCallOrder[0]);
    expect(setInjectedParameter).toHaveBeenCalledWith(entry.model, 'PARAM_ANGLE_X', 0.4);
    expect(syncInputParameters).toHaveBeenCalledWith(entry.model);
  });

  it('commits cached Cubism 3+ motion poses on paused zero-delta seeks', async () => {
    const { model, internal, drawn } = createCubismModelFixture();
    const controls = new CubismPixiLive2DAdapter().getControls();
    vi.mocked(runtimeAdapter.getLive2DRuntimeAdapter).mockReturnValue({ getControls: () => controls } as Live2DRuntimeAdapter);
    const stage = new Live2DStageRuntime({
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
    entry.customMotionStage = controls.installCustomMotionStage(model, {
      getState: () => entry.customMotion && entry.customMotionHandoff
        ? { motion: entry.customMotion.motion, startSceneTime: 0, handoff: entry.customMotionHandoff, controlledParameterIds: ['ParamAngleX'] }
        : null,
    });
    expect(entry.customMotionStage).not.toBeNull();
    stage.characters.set(entry.id, entry);
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
    const stage = new Live2DStageRuntime({
      dispatchMotion,
      describeInvalidModelState: () => null,
      repairCorruptedModel: vi.fn().mockResolvedValue(undefined),
      maybeInstallCustomMotionStage: vi.fn(),
      resolveCustomMotionSceneTime: () => 0,
      getScriptEngine: () => null,
    });
    const failingModel = { autoUpdate: false, id: 'failing' };
    const healthyModel = { autoUpdate: false, id: 'healthy' };
    advanceFrame.mockImplementation((model: { id: string }) => {
      if (model.id === 'failing') throw new Error('sdk failure');
    });
    stage.characters.set('failing', makeEntry('failing', failingModel));
    stage.characters.set('healthy', makeEntry('healthy', healthyModel));

    await expect(stage.step(16)).resolves.toBeUndefined();
    expect(advanceFrame).toHaveBeenCalledTimes(2);
  });

  it('waits for in-flight operations and clears coordinator state', async () => {
    let releaseMutex!: () => void;
    const mutex = new Promise<void>(resolve => { releaseMutex = resolve; });
    const stage = new Live2DStageRuntime({
      dispatchMotion,
      describeInvalidModelState: () => null,
      repairCorruptedModel: vi.fn().mockResolvedValue(undefined),
      maybeInstallCustomMotionStage: vi.fn(),
      resolveCustomMotionSceneTime: () => 0,
      getScriptEngine: () => null,
    });
    stage.characters.set('hero', makeEntry('hero', { autoUpdate: false }));
    stage.pendingMotions.set('hero', []);
    stage.motionMutex.set('hero', mutex);
    const wait = stage.waitForQuiescence(vi.fn().mockResolvedValue(undefined));

    await Promise.resolve();
    releaseMutex();
    stage.motionMutex.delete('hero');
    await wait;
    stage.clear();

    expect(stage.characters.size).toBe(0);
    expect(stage.pendingMotions.size).toBe(0);
    expect(stage.motionMutex.size).toBe(0);
  });
});
