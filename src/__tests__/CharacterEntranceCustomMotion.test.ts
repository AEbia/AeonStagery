// @vitest-environment jsdom
import * as PIXI from 'pixi.js';
import { stageManager } from '../engine/StageManager';
import type Live2DManager from '../engine/Live2DManager';
import { live2DStageState } from './helpers/live2DStageState';
import { createLive2DModelHandle } from '../engine/live2d/runtime/Live2DRuntimeControlModule';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cubism2Live2DAdapter } from '../engine/Live2DRuntimeAdapter';
import type { Live2DRuntimeControlPort } from '../engine/runtime/Live2DRuntimeControlPort';
import { mockControls } from './helpers/mockLive2DRuntimeAdapter';

if (typeof window === 'undefined') {
  (global as any).window = {};
}

vi.mock('untitled-pixi-live2d-engine/cubism-legacy', () => ({
  config: {},
}));

const RUNTIME = {
  runtimeFamily: 'cubism2',
  adapterId: 'pixi-live2d-display-cubism2',
  supported: true,
} as const;

/**
 * A statement-level custom motion (自定义动作): a linear 0 -> 100 ramp on one
 * parameter over 2s, so the middle of the curve is unambiguous.
 */
function createCustomMotion() {
  return {
    kind: 'custom' as const,
    durationSeconds: 2,
    fadeInSeconds: 0,
    derivedFrom: { key: 'smile01' },
    tracks: [
      {
        parameterId: 'Angle X',
        keyframes: [
          { time: 0, value: 0 },
          { time: 2, value: 100 },
        ],
      },
    ],
  };
}

function createFakeModel() {
  const model = Object.assign(new PIXI.Container(), {
    anchor: new PIXI.ObservablePoint({ _onUpdate: () => undefined }),
    internalModel: {},
  });
  model.visible = false;
  Object.defineProperties(model, {
    width: { get: () => 800 * Math.abs(model.scale.x) },
    height: { get: () => 1000 * model.scale.y },
  });
  return model;
}

function createHandle(id: string, model: object, controls: Live2DRuntimeControlPort) {
  return createLive2DModelHandle({ id, model, runtime: RUNTIME, controls });
}

interface Harness {
  manager: Live2DManager;
  layer: PIXI.Container;
  controls: Live2DRuntimeControlPort;
}

/**
 * A Live2DManager whose model load completes without the real Cubism runtime.
 * The public surface is unchanged: `playCustomMotion`, `playMotion`,
 * `removeCharacter`, `addCharacter` and `updateAll` all behave as in the app.
 */
async function createHarness(): Promise<Harness> {
  const { default: Live2DManager } = await import('../engine/Live2DManager');
  const manager = new Live2DManager();
  const model = createFakeModel();
  const controls = mockControls({
    getConcreteModels: vi.fn((candidate: any) => (candidate ? [candidate] : [])),
    installCustomMotionStage: vi.fn(() => null),
  });

  vi.spyOn(cubism2Live2DAdapter, 'init').mockResolvedValue(undefined);
  vi.spyOn(cubism2Live2DAdapter, 'isReady').mockReturnValue(true);
  vi.spyOn(cubism2Live2DAdapter, 'createModel').mockResolvedValue(model);
  vi.spyOn(cubism2Live2DAdapter, 'createModelHandle').mockImplementation((id: string) => createHandle(id, model, controls));

  vi.stubGlobal('window', { aeonStageryAPI: { fs: {
    readTextFile: async () => ({ success: true, data: '{"model":"hero.moc"}' }),
  } } });
  const layer = new PIXI.Container();
  vi.spyOn(stageManager, 'getLayer').mockReturnValue(layer);
  vi.spyOn(stageManager, 'getApp').mockReturnValue({
    ticker: { add: vi.fn() }, renderer: {},
  } as unknown as PIXI.Application);

  return { manager, controls, layer };
}

/** Enter the character the way the playback timeline does at the entrance time. */
async function enterCharacter(manager: any): Promise<any> {
  await manager.addCharacter('char1', 'figure/char1/model.model.json', {});
  return live2DStageState(manager).characters.get('char1');
}

/** Authored scene time of the custom motion. */
const MOTION_SCENE_TIME = 10;
/** One second into the 0 -> 100 ramp, i.e. scene time 11s. */
const MID_CURVE_SCENE_TIME_MS = 11_000;

/**
 * The character enters, and is not performing the custom motion: neither the
 * curve's parameter is driven nor any motion state remains on the character.
 */
async function expectCharacterNotPerformingCustomMotion(
  manager: any,
  controls: Live2DRuntimeControlPort,
): Promise<void> {
  const entry = await enterCharacter(manager);
  await manager.updateAll(0, true, MID_CURVE_SCENE_TIME_MS);

  expect(entry.customMotion).toBeUndefined();
  expect(controls.setInjectedParameter).not.toHaveBeenCalledWith(expect.anything(), 'Angle X', expect.anything());
}

describe('character entrance and custom motion at the same time', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('performs a custom motion that is requested before the entrance finished loading', async () => {
    const { manager, controls } = await createHarness();

    // Playback: the 角色登场 callback starts the (async) model load, the
    // 自定义动作 callback at the same timestamp fires before the character
    // exists on stage.
    manager.playCustomMotion('char1', createCustomMotion(), MOTION_SCENE_TIME);
    expect(manager.hasCharacter('char1')).toBe(false);

    const entry = await enterCharacter(manager);
    expect(entry).toBeDefined();

    // The character must be performing the custom motion once it is on stage.
    await manager.updateAll(0, true, MID_CURVE_SCENE_TIME_MS);
    expect(controls.setInjectedParameter).toHaveBeenCalledWith(expect.anything(), 'Angle X', 50);
  });

  it('does not replay a buffered custom motion that a newer resource motion replaced', async () => {
    const { manager, controls } = await createHarness();

    // The entrance at t=10 carries a custom motion, a later statement at t=10.2
    // starts a resource motion — both still waiting for the model to load.
    manager.playCustomMotion('char1', createCustomMotion(), MOTION_SCENE_TIME);
    manager.playMotion('char1', 'idle01', 3, 0, 10.2);

    await expectCharacterNotPerformingCustomMotion(manager, controls);
  });

  it('drops a buffered custom motion when the character leaves before it enters', async () => {
    const { manager, controls } = await createHarness();

    manager.playCustomMotion('char1', createCustomMotion(), MOTION_SCENE_TIME);
    manager.removeCharacter('char1');

    await expectCharacterNotPerformingCustomMotion(manager, controls);
  });

  it('drops a buffered custom motion when a seek clears pending motion intents', async () => {
    const { manager, controls } = await createHarness();

    manager.playCustomMotion('char1', createCustomMotion(), MOTION_SCENE_TIME);
    manager.clearAllPendingMotions();

    await expectCharacterNotPerformingCustomMotion(manager, controls);
  });

  it('drops a buffered custom motion when the scene is cleared', async () => {
    const { manager, controls } = await createHarness();

    manager.playCustomMotion('char1', createCustomMotion(), MOTION_SCENE_TIME);
    manager.clear();

    await expectCharacterNotPerformingCustomMotion(manager, controls);
  });

  it('keeps a cancelled entrance off stage after asynchronous idle warmup', async () => {
    const { manager, controls } = await createHarness();
    let finishWarmup!: () => void;
    const warmup = new Promise<void>(resolve => { finishWarmup = resolve; });
    vi.mocked(controls.flushIdleState).mockReturnValueOnce(warmup);
    manager.playCustomMotion('char1', createCustomMotion(), MOTION_SCENE_TIME);
    const entrance = manager.addCharacter('char1', 'figure/char1/model.model.json');
    await vi.waitFor(() => expect(controls.flushIdleState).toHaveBeenCalledTimes(1));
    manager.removeCharacter('char1');
    finishWarmup();
    await entrance;
    await manager.waitForAllLoaded();
    expect(manager.hasCharacter('char1')).toBe(false);
    await expectCharacterNotPerformingCustomMotion(manager, controls);
    expect(cubism2Live2DAdapter.createModel).toHaveBeenCalledTimes(1);
  });

  it('removes a staged entry if replaying a buffered instruction fails', async () => {
    const { manager, controls } = await createHarness();
    manager.playCustomMotion('char1', createCustomMotion(), MOTION_SCENE_TIME);
    const replay = vi.spyOn(manager, 'playCustomMotion').mockImplementationOnce(() => {
      throw new Error('buffered instruction failed');
    });
    await expect(manager.addCharacter('char1', 'figure/char1/model.model.json'))
      .rejects.toThrow('buffered instruction failed');
    expect(manager.hasCharacter('char1')).toBe(false);
    replay.mockRestore();
    await expectCharacterNotPerformingCustomMotion(manager, controls);
    expect(cubism2Live2DAdapter.createModel).toHaveBeenCalledTimes(1);
  });

  it('replays resource motion before the later custom motion without losing its handoff', async () => {
    const { manager, controls } = await createHarness();
    manager.setResourceMotionCacheEnabled(false);
    const handoff = { params: new Float32Array([12]), opacities: new Float32Array([1]) };
    manager.playMotion('char1', 'idle01', 3, 0.25, 10.25, true);
    manager.playCustomMotion('char1', createCustomMotion(), MOTION_SCENE_TIME, handoff);
    const resourceReplay = vi.spyOn(manager, 'playMotion');
    const customReplay = vi.spyOn(manager, 'playCustomMotion');

    await manager.addCharacter('char1', 'figure/char1/model.model.json');

    expect(resourceReplay).toHaveBeenCalledWith('char1', 'idle01', 3, 0.25, 10.25, true, undefined);
    expect(customReplay).toHaveBeenCalledWith('char1', createCustomMotion(), MOTION_SCENE_TIME, handoff);
    expect(resourceReplay.mock.invocationCallOrder[0]).toBeLessThan(customReplay.mock.invocationCallOrder[0]);
    await manager.updateAll(0, true, MID_CURVE_SCENE_TIME_MS);
    expect(controls.setInjectedParameter).toHaveBeenCalledWith(expect.anything(), 'Angle X', 50);
  });

  it('withdraws every buffered intent even when the character has not entered', async () => {
    const { manager } = await createHarness();
    manager.playMotion('char1', 'old-motion', 3, 0.5, 10.5);
    manager.transform('char1', { position: [0.1, 0.2], duration: 0 });
    manager.setExpression('char1', 'old-expression');
    manager.lookAt('char1', 0.7, 0.2);
    manager.setBlink('char1', false, 5000, 2, 1, 500);
    const container = manager.getContainer('char1');
    manager.removeCharacter('char1');
    const motionReplay = vi.spyOn(manager, 'playMotion');
    const expressionReplay = vi.spyOn(manager, 'setExpression');
    const gazeReplay = vi.spyOn(manager, 'lookAt');
    const blinkReplay = vi.spyOn(manager, 'setBlink');

    await manager.addCharacter('char1', 'figure/char1/model.model.json');

    expect(container.destroyed).toBe(true);
    expect(manager.getContainer('char1').x).toBe(960);
    expect(motionReplay).not.toHaveBeenCalled();
    expect(expressionReplay).not.toHaveBeenCalled();
    expect(gazeReplay).not.toHaveBeenCalled();
    expect(blinkReplay).not.toHaveBeenCalled();
  });

  it('preserves visual intent arguments and replays them before motion intent', async () => {
    const { manager } = await createHarness();
    manager.setExpression('char1', null);
    manager.lookAt('char1', 0.7, 0.2, 0.4, { elapsed: 0.1, ease: 'none' });
    manager.setBlink('char1', true, 5000, 2, 1, 500);
    manager.playCustomMotion('char1', createCustomMotion(), MOTION_SCENE_TIME);
    const expression = vi.spyOn(manager, 'setExpression');
    const gaze = vi.spyOn(manager, 'lookAt');
    const blink = vi.spyOn(manager, 'setBlink');
    const motion = vi.spyOn(manager, 'playCustomMotion');

    await manager.addCharacter('char1', 'figure/char1/model.model.json');

    expect(expression).toHaveBeenCalledExactlyOnceWith('char1', null);
    expect(gaze).toHaveBeenCalledExactlyOnceWith('char1', 0.7, 0.2, 0.4, { elapsed: 0.1, ease: 'none' });
    expect(blink).toHaveBeenCalledExactlyOnceWith('char1', true, 5000, 2, 1, 500);
    expect(blink.mock.invocationCallOrder[0]).toBeLessThan(motion.mock.invocationCallOrder[0]);
  });

  it('publishes only the replacement after clear interrupts asynchronous warmup', async () => {
    const { manager, controls, layer } = await createHarness();
    let finishWarmup!: () => void;
    vi.mocked(controls.flushIdleState).mockReturnValueOnce(new Promise<void>(resolve => { finishWarmup = resolve; }));
    const oldEntrance = manager.addCharacter('char1', 'old/model.model.json', { position: [0.1, 0.2] });
    await vi.waitFor(() => expect(controls.flushIdleState).toHaveBeenCalledTimes(1));
    manager.clear();
    const replacement = manager.addCharacter('char1', 'new/model.model.json', { position: [0.8, 0.9] });
    finishWarmup();
    await Promise.all([oldEntrance, replacement]);
    await manager.waitForAllLoaded();

    expect(manager.listCharacters()).toEqual(['char1']);
    expect(manager.getCharacterInfo('char1')?.modelPath).toBe('new/model.model.json');
    expect(manager.getContainer('char1').x).toBe(0.8 * 1920);
    expect(layer.children).toEqual([manager.getContainer('char1')]);
  });

  it('stops consuming entrance intents when replay withdraws the character', async () => {
    const { manager, controls, layer } = await createHarness();
    manager.setExpression('char1', 'exit-on-expression');
    manager.playCustomMotion('char1', createCustomMotion(), MOTION_SCENE_TIME);
    vi.spyOn(manager, 'setExpression').mockImplementationOnce(id => manager.removeCharacter(id));
    const motionReplay = vi.spyOn(manager, 'playCustomMotion');

    await manager.addCharacter('char1', 'figure/char1/model.model.json');

    expect(manager.hasCharacter('char1')).toBe(false);
    expect(layer.children).toHaveLength(0);
    expect(motionReplay).not.toHaveBeenCalled();
    await manager.addCharacter('char1', 'figure/char1/model.model.json');
    await manager.updateAll(0, true, MID_CURVE_SCENE_TIME_MS);
    expect(controls.setInjectedParameter).not.toHaveBeenCalledWith(expect.anything(), 'Angle X', expect.anything());
    expect(cubism2Live2DAdapter.createModel).toHaveBeenCalledTimes(1);
  });

  it('detaches and returns the borrowed model when source binding fails', async () => {
    const { manager, controls, layer } = await createHarness();
    vi.mocked(cubism2Live2DAdapter.createModelHandle).mockImplementationOnce((id, model) => {
      const handle = createHandle(id, model, controls);
      vi.spyOn(handle, 'bindRuntimeSource').mockImplementationOnce(() => { throw new Error('source binding failed'); });
      return handle;
    });
    await expect(manager.addCharacter('char1', 'figure/char1/model.model.json')).rejects.toThrow('source binding failed');

    expect(manager.hasCharacter('char1')).toBe(false);
    expect(layer.children).toHaveLength(0);
    await manager.addCharacter('char1', 'figure/char1/model.model.json');
    expect(manager.getDisplayObject('char1')?.destroyed).toBe(false);
    expect(cubism2Live2DAdapter.createModel).toHaveBeenCalledTimes(1);
  });

  it('aligns the camera and transparent proxy state before publishing an entrance', async () => {
    const { manager } = await createHarness();
    const camera = { position: { x: 960, y: 540 }, zoom: 1.5 };
    manager.setScriptEngine({
      getCurrentCamera: () => camera,
      transformationProxies: new Map([['char1', { x: 960, y: 1080, scale: 1, opacity: 0.3 }]]),
    });

    await manager.addCharacter('char1', 'figure/char1/model.model.json');

    expect(manager.currentCamera).toBe(camera);
    const container = manager.getContainer('char1');
    expect(container.renderable).toBe(true);
    const alphaFilter = container.filters?.find(filter => filter instanceof PIXI.AlphaFilter);
    expect(alphaFilter?.alpha).toBe(0.3);
    expect(manager.getDisplayObject('char1')?.alpha).toBe(1);
  });
});
