/**
 * @vitest-environment jsdom
 */
/**
 * Cubism 2.1 neutral-pose / motion-switch residue.
 *
 * The model doubles here follow the real pixi-live2d-display Cubism 2 runtime:
 *  - `internalModel.update()` calls `coreModel.saveParam()` right after the
 *    motion queue update and `coreModel.loadParam()` at the end of every frame,
 *    so the SDK's saved buffer holds the *last motion pose*, not the idle pose.
 *  - a motion only writes the parameters (and part opacities) it owns, so
 *    parameters owned by the previous motion survive a switch.
 *  - expression/part opacities are a separate channel from parameters.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureModelNeutralPoseOnce, resetModelToNeutralPose } from '../engine/live2d/characterStatePurge';

// v8 migration: the purge helpers reach the vendor engine only through the
// lazily-imported runtime adapter, so no vendor module mock is required.

const PARAM_NAMES = ['PARAM_ANGLE_X', 'PARAM_ANGLE_Z', 'PARAM_EYE_L_OPEN'] as const;
const NEUTRAL = [0, 0, 1]; // eyes open
const FACE_PARAM = 'PARAM_EYE_L_OPEN';
const FACE_A = 0.15; // motion A's built-in squint
const FADE_IN_MS = 500;

/** Which parameters each motion group drives (Cubism 2.1 .mtn contents). */
const MOTIONS: Record<string, Record<string, number>> = {
  A: { PARAM_ANGLE_X: 30, [FACE_PARAM]: FACE_A }, // motion carries an expression
  B: { PARAM_ANGLE_Z: -20 }, // pure body motion
};

function createSdkModel() {
  const params = Float32Array.from(NEUTRAL);
  const opacities = Float32Array.from([1, 0]);
  let saved = Float32Array.from(NEUTRAL); // SDK `_$fs` buffer
  const indexOf = (id: string | number) => (typeof id === 'number' ? id : PARAM_NAMES.indexOf(id as any));

  const coreModel = {
    getParamIndex: (name: string) => PARAM_NAMES.indexOf(name as any),
    setParamFloat(id: string | number, value: number) {
      const i = indexOf(id);
      if (i >= 0) params[i] = value;
    },
    getParamFloat(id: string | number) {
      const i = indexOf(id);
      return i >= 0 ? params[i] : 0;
    },
    getParameterValues: () => params,
    getPartOpacities: () => opacities,
    saveParam() { saved = Float32Array.from(params); },
    loadParam() { params.set(saved); },
    update() {},
  };

  const entries: Array<{
    owned: Record<string, number>;
    startValues: Record<string, number>;
    startTime: number;
  }> = [];
  const step = (t: number) => {
    for (const entry of entries) {
      const weight = Math.max(0, Math.min(1, (t - entry.startTime) / FADE_IN_MS));
      for (const [name, target] of Object.entries(entry.owned)) {
        coreModel.setParamFloat(name, entry.startValues[name] + (target - entry.startValues[name]) * weight);
      }
    }
  };

  const now = { ms: 1000 };
  const motionManager: any = {
    playing: false,
    state: { currentGroup: undefined, reservedGroup: undefined, queue: [] },
    _motionQueueManager: { stopAllMotions: () => { entries.length = 0; }, _motions: entries },
    loadMotion: vi.fn(async () => undefined),
    startMotion: vi.fn(async (group: string) => {
      const owned = MOTIONS[group];
      if (!owned) return false;
      const startValues: Record<string, number> = {};
      for (const name of Object.keys(owned)) startValues[name] = coreModel.getParamFloat(name);
      entries.push({ owned, startValues, startTime: now.ms });
      motionManager.state.currentGroup = group;
      motionManager.playing = true;
      return true;
    }),
    stopAllMotions: () => {
      // Dropping the queue does not revert what it already wrote.
      entries.length = 0;
      motionManager.state.currentGroup = undefined;
      motionManager.state.queue = [];
      motionManager.playing = false;
    },
    update: (_model: any, t: number) => step(t),
  };
  const expressionManager: any = {
    state: { currentGroup: undefined },
    setExpression: vi.fn(),
    stopAllExpressions: vi.fn(),
    resetExpression: vi.fn(),
  };
  motionManager.expressionManager = expressionManager;

  const internalModel: any = {
    settings: { motions: { A: [{}], B: [{}] }, expressions: [] },
    motionManager,
    expressionManager,
    parameterValues: params,
    partOpacities: opacities,
    coreModel,
    // Faithful to Cubism2InternalModel.update(dt, now).
    update: (dt: number) => {
      now.ms += dt;
      motionManager.update(coreModel, now.ms);
      coreModel.saveParam();
      expressionManager.update?.(coreModel, now.ms);
      coreModel.update();
      coreModel.loadParam();
    },
  };
  const model: any = {
    destroyed: false,
    x: 0, y: 0, rotation: 0, alpha: 1,
    _modelUrl: 'hero.model.json',
    scale: { x: 1, y: 1, set: vi.fn() },
    anchor: { set: vi.fn() },
    expression: vi.fn(),
    update: (dt: number) => internalModel.update(dt),
    stopAllMotions: vi.fn(),
    internalModel,
  };

  return { model, internalModel, coreModel, motionManager, params, opacities, now };
}

const RUNTIME = {
  runtimeFamily: 'cubism2',
  adapterId: 'pixi-live2d-display-cubism2',
  supported: true,
} as any;

describe('Cubism 2.1 neutral pose', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (window as any).UtSystem = {
      getUserTimeMSec: () => 1000,
      setUserTimeMSec: vi.fn(),
    };
  });

  it('resetModelToNeutralPose returns a recycled model to the idle pose', async () => {
    const sdk = createSdkModel();
    // The loader captures the pristine pose at creation time.
    captureModelNeutralPoseOnce(sdk.model);

    // Playback left motion B on the model (this is the state a model carries
    // into the preload pool when a backwards seek removes the character).
    await sdk.motionManager.startMotion('B');
    sdk.model.update(600);
    expect(sdk.coreModel.getParamFloat('PARAM_ANGLE_Z')).toBeCloseTo(-20, 1);

    resetModelToNeutralPose(sdk.model, RUNTIME);

    expect(sdk.coreModel.getParamFloat('PARAM_ANGLE_Z')).toBeCloseTo(0, 3);
    expect(sdk.coreModel.getParamFloat(FACE_PARAM)).toBeCloseTo(1, 3);
  });

  it('captures the pristine pose from the Cubism 2 private model context', () => {
    const params = Float32Array.from(NEUTRAL);
    const opacities = Float32Array.from([1, 0]);
    const context = { _$_2: params, _$pb: PARAM_NAMES.map((id) => ({ id })), _$Hr: Array.from(opacities) };
    const coreModel: any = {
      _$5S: context,
      getPartsOpacity: (index: number) => context._$Hr[index],
      setPartsOpacity: (index: number, value: number) => { context._$Hr[index] = value; },
      getParamIndex: (name: string) => PARAM_NAMES.indexOf(name as any),
      setParamFloat(id: string | number, value: number) {
        const index = typeof id === 'number' ? id : PARAM_NAMES.indexOf(id as any);
        if (index >= 0) context._$_2[index] = value;
      },
      getParamFloat(id: string | number) {
        const index = typeof id === 'number' ? id : PARAM_NAMES.indexOf(id as any);
        return index >= 0 ? context._$_2[index] : 0;
      },
      saveParam() {},
      loadParam() { context._$_2.fill(42); },
    };
    const model: any = {
      internalModel: {
        coreModel,
        motionManager: { stopAllMotions: vi.fn() },
        expressionManager: { resetExpression: vi.fn() },
      },
    };

    captureModelNeutralPoseOnce(model);
    context._$_2[0] = 30;
    context._$Hr[0] = 0.25;

    resetModelToNeutralPose(model, RUNTIME);

    expect(Array.from(context._$_2)).toEqual(NEUTRAL);
    expect(Array.from(context._$Hr)).toEqual([1, 0]);
    expect(context._$pb).toEqual(PARAM_NAMES.map((id) => ({ id })));
  });
});
