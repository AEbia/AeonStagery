import { afterEach, describe, expect, it, vi } from 'vitest';
import { cubism2Live2DAdapter, type Live2DRuntimeModelControls } from '../engine/Live2DRuntimeAdapter';
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
  return {
    visible: false,
    alpha: 1,
    filters: null,
    x: 0,
    y: 0,
    zIndex: 0,
    width: 800,
    height: 1000,
    parent: null,
    scale: {
      x: 1,
      y: 1,
      set(value: number) {
        this.x = value;
        this.y = value;
      },
    },
    anchor: { set: vi.fn() },
    internalModel: {},
  };
}

function createHandle(id: string, model: any) {
  return {
    id,
    runtime: RUNTIME,
    displayObject: model,
    rawModel: model,
    capabilities: {},
    lifecycle: { getCoreModel: () => null, clearMotionState: () => {}, stopAllMotions: () => {} },
    motion: { getAvailableMotions: () => [], getMotionDuration: () => 0, getMotionDebugState: () => null, preloadMotion: vi.fn() },
    expression: { getAvailableExpressions: () => [], setExpression: () => {} },
    parameters: { getParameterValues: () => null, getParameterMetadata: () => null, setInjectedParameter: () => {}, syncInputParameters: () => {} },
    snapshot: { captureSnapshot: () => null, applySnapshot: () => {}, restoreSeekState: vi.fn() },
    render: { renderForBake: () => {} },
    diagnostics: { describeInvalidState: () => null },
  } as any;
}

interface Harness {
  manager: any;
  controls: Live2DRuntimeModelControls;
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

  vi.spyOn(cubism2Live2DAdapter, 'init').mockResolvedValue(undefined as any);
  vi.spyOn(cubism2Live2DAdapter, 'isReady').mockReturnValue(true);
  vi.spyOn(cubism2Live2DAdapter, 'getModelClass').mockReturnValue(function FakeModel() {} as any);
  vi.spyOn(cubism2Live2DAdapter, 'createModel').mockResolvedValue(model as any);
  vi.spyOn(cubism2Live2DAdapter, 'getControls').mockReturnValue(controls);
  vi.spyOn(cubism2Live2DAdapter, 'createModelHandle').mockImplementation((id: string) => createHandle(id, model));

  vi.spyOn((manager as any).modelLoader, 'probeModelPath').mockResolvedValue({
    exists: true,
    fullPath: '/project/figure/char1/model.model.json',
    runtime: RUNTIME as any,
  });
  vi.spyOn(manager as any, 'getContainer').mockReturnValue({
    x: 0,
    y: 0,
    angle: 0,
    parent: null,
    addChild: vi.fn(),
    removeChild: vi.fn(),
    destroy: vi.fn(),
  } as any);
  (manager as any)._tickerAdded = true;

  return { manager, controls };
}

/** Enter the character the way the playback timeline does at the entrance time. */
async function enterCharacter(manager: any): Promise<any> {
  await manager.addCharacter('char1', 'figure/char1/model.model.json', {});
  return manager.getAllCharacters().get('char1');
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
  controls: Live2DRuntimeModelControls,
): Promise<void> {
  const entry = await enterCharacter(manager);
  await manager.updateAll(0, true, MID_CURVE_SCENE_TIME_MS);

  expect(entry.customMotion).toBeUndefined();
  expect(controls.setInjectedParameter).not.toHaveBeenCalledWith(expect.anything(), 'Angle X', expect.anything());
}

describe('character entrance and custom motion at the same time', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
});
