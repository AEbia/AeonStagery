/**
 * @vitest-environment jsdom
 */
/**
 * User-visible symptom: a motion plays (or has finished); seeking to a scene
 * time BEFORE that motion — when no earlier motion exists — must show the
 * character as it entered the stage (its pristine idle pose). The residual
 * motion pose surviving the seek purge is the regression this locks down.
 *
 * Unlike SeekStaleStatePurge.test.ts, this fake models the REAL Cubism 2.1
 * layout the v8 vendor produces (coreModel = live2d.min.js Live2DModelWebGL):
 *  - live parameter values live ONLY in `coreModel._$5S._$_2` (Float32Array)
 *    and part opacities through get/setPartsOpacity; the internalModel
 *    exposes NO `parameterValues` / `getParameterValues` shortcut.
 *  - every internalModel.update() frame ends with saveParam() after the
 *    motion writes, and loadParam() restoring that (motion-polluted) saved
 *    buffer — which is why resetCoreParams()'s loadParam path CANNOT be the
 *    neutralizer, only the pristine capture can.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Live2DManager from '../engine/Live2DManager';
import { getLive2DRuntimeAdapter } from '../engine/Live2DRuntimeAdapter';
import { captureModelNeutralPoseOnce, resetModelToNeutralPose } from '../engine/live2d/characterStatePurge';
import { ProxyRegistry } from '../engine/coordinators/ProxyRegistry';

const PARAM_NAMES = ['PARAM_ANGLE_X', 'PARAM_ANGLE_Z', 'PARAM_EYE_L_OPEN'] as const;
const NEUTRAL = [0, 0, 1]; // eyes open
const NEUTRAL_OPACITIES = [1, 0];
const FADE_IN_MS = 500;
const PARAM_MOTION_TARGET = 30; // motion A drives PARAM_ANGLE_X to 30

const RUNTIME = {
  runtimeFamily: 'cubism2',
  adapterId: 'pixi-live2d-display-cubism2',
  supported: true,
} as any;

function controls() {
  return getLive2DRuntimeAdapter(RUNTIME).getControls();
}

function createRealLayoutSdkModel() {
  // The ONLY truth array, like live2d.min.js `_cM._$_2`:
  const context: any = {
    _$_2: Float32Array.from(NEUTRAL),
    _$pb: PARAM_NAMES.map((id) => ({ id })),
    _$Hr: NEUTRAL_OPACITIES.map((opacity) => ({ opacity })),
  };
  let saved = Float32Array.from(NEUTRAL);
  const indexOf = (id: string | number) => (typeof id === 'number' ? id : PARAM_NAMES.indexOf(id as any));

  const coreModel: any = {
    _$5S: context,
    getParamIndex: (name: string) => PARAM_NAMES.indexOf(name as any),
    setParamFloat(id: string | number, value: number) {
      const i = indexOf(id);
      if (i >= 0) context._$_2[i] = value;
    },
    getParamFloat(id: string | number) {
      const i = indexOf(id);
      return i >= 0 ? context._$_2[i] : 0;
    },
    addToParamFloat(id: string | number, value: number) {
      const i = indexOf(id);
      if (i >= 0) context._$_2[i] += value;
    },
    getPartsOpacity(index: number) { return context._$Hr[index].opacity; },
    setPartsOpacity(index: number, value: number) { context._$Hr[index].opacity = value; },
    // Real framework semantics: the saved buffer is whatever the last
    // saveParam() saw — after playback that is the MOTION pose, not idle.
    saveParam() { saved = Float32Array.from(context._$_2); },
    loadParam() { context._$_2.set(saved); },
    update() { /* matrix computation; does not touch parameter arrays */ },
  };

  const entries: Array<{ owned: Record<string, number>; startValues: Record<string, number>; startTime: number }> = [];
  const now = { ms: 1000 };
  const motionManager: any = {
    playing: false,
    state: { currentGroup: undefined, reservedGroup: undefined, queue: [] },
    loadMotion: vi.fn(async () => undefined),
    startMotion: vi.fn(async (group: string) => {
      if (group !== 'A') return false;
      const owned: Record<string, number> = { PARAM_ANGLE_X: PARAM_MOTION_TARGET };
      const startValues: Record<string, number> = {};
      for (const name of Object.keys(owned)) startValues[name] = coreModel.getParamFloat(name);
      entries.push({ owned, startValues, startTime: now.ms });
      motionManager.state.currentGroup = group;
      motionManager.playing = true;
      return true;
    }),
    // Framework queue semantics: dropping entries never reverts what the
    // motion already wrote into the live parameter array.
    stopAllMotions: () => {
      entries.length = 0;
      motionManager.state.currentGroup = undefined;
      motionManager.state.queue = [];
      motionManager.playing = false;
    },
    update: (_model: any, t: number) => {
      for (const entry of entries) {
        const weight = Math.max(0, Math.min(1, (t - entry.startTime) / FADE_IN_MS));
        for (const [name, target] of Object.entries(entry.owned)) {
          coreModel.setParamFloat(name, entry.startValues[name] + (target - entry.startValues[name]) * weight);
        }
      }
      return entries.length > 0;
    },
  };
  const expressionManager: any = {
    state: { currentGroup: undefined },
    setExpression: vi.fn(),
    stopAllExpressions: vi.fn(),
    resetExpression: vi.fn(),
  };
  motionManager.expressionManager = expressionManager;

  const internalModel: any = {
    settings: { motions: { A: [{}] }, expressions: [] },
    motionManager,
    expressionManager,
    coreModel,
    // Faithful to CubismLegacyInternalModel.update(): motions write, the
    // result is SAVED, the frame ends with model.update() + loadParam().
    update: (dt: number) => {
      now.ms += dt;
      const motionUpdated = motionManager.update(coreModel, now.ms);
      coreModel.saveParam();
      if (!motionUpdated) { /* eyeBlink / natural movements (idle-only) */ }
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
  return { model, internalModel, coreModel, context, motionManager, now };
}

function makeManager(char: ReturnType<typeof createRealLayoutSdkModel>) {
  const manager = new Live2DManager();
  const entry: any = {
    id: 'hero',
    model: char.model,
    modelPath: 'hero.model.json',
    modelUrl: 'hero.model.json',
    runtime: RUNTIME,
    adapterId: RUNTIME.adapterId,
    config: {},
    injectedParams: {},
    lipSyncParameterIds: new Set<string>(),
    motionEpoch: 0,
  };
  (manager as any).characters = new Map([['hero', entry]]);
  (manager as any).containers = new Map();
  return { manager, entry };
}

function closeToArray(expected: number[]) {
  return expected.map((v) => expect.closeTo(v, 1));
}

describe('seek before the first motion returns to the entrance pose (real layout)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (globalThis as any).window = {
      UtSystem: {
        getUserTimeMSec: () => 1000,
        setUserTimeMSec: vi.fn(),
      },
    };
  });

  it('pristine capture + neutralize reach the framework live array on this layout', async () => {
    // Sanity: the whole fix rests on internalModel[NEUTRAL_POSE_MARK] being
    // captured and written through the private context — verify the plumbing
    // on this layout before blaming channels on top of it.
    const char = createRealLayoutSdkModel();
    captureModelNeutralPoseOnce(char.model);

    await char.motionManager.startMotion('A');
    char.model.update(600); // fade completes; saved buffer now holds the pose
    expect(char.context._$_2[0]).toBeCloseTo(PARAM_MOTION_TARGET, 1);

    resetModelToNeutralPose(char.model, RUNTIME);

    expect(char.context._$_2[0]).toBeCloseTo(0, 3);
    expect(char.context._$_2[2]).toBeCloseTo(1, 3);
  });

  it('ScriptEngine reconstruct-seek sequence drops the in-flight motion pose', async () => {
    const char = createRealLayoutSdkModel();
    // Loader-time capture (Live2DModelLoader.preloadModel does this after
    // createModel; addCharacter then neutralizes + captures idleSnapshot).
    captureModelNeutralPoseOnce(char.model);
    const { manager, entry } = makeManager(char);
    entry.idleSnapshot = controls().captureIdleSnapshot(char.model);
    manager.setScriptEngine({ isReconstructing: false, getCurrentTime: () => 4 } as any);

    // Playback: motion A started at scene t=3, we are at t=4 (fade complete).
    await char.motionManager.startMotion('A');
    entry.motionStartTime = 3;
    entry.lastOffset = 1;
    char.model.update(600);
    expect(char.context._$_2[0]).toBeGreaterThan(1); // pose is dirty

    // ── ScriptEngine._doSeek reconstruct branch (target before the motion) ──
    (manager as any)._scriptEngine.isReconstructing = true;
    manager.clearAllPendingMotions();
    manager.purgeAllCharacterRuntimeState();
    // CharacterSynchronizer Phase 3: no desired motion at the target time.
    manager.resetToIdle('hero');

    // A few steady-state frames after the seek (ticker still running while
    // the user was playing): no channel may re-introduce the motion pose.
    for (let i = 0; i < 3; i++) {
      await manager.updateAll(16);
      char.model.update(16);
    }

    expect(Array.from(char.context._$_2)).toEqual(closeToArray(NEUTRAL));
    expect(char.motionManager.playing).toBe(false);
  });

  it('resetModelToIdle restores idleSnapshot on real Cubism 2 coreModel without getParameterValues', async () => {
    const char = createRealLayoutSdkModel();
    const snap = controls().captureIdleSnapshot(char.model);
    expect(snap).not.toBeNull();

    // Play motion A to make context._$_2 dirty
    await char.motionManager.startMotion('A');
    char.model.update(600);
    expect(char.context._$_2[0]).toBeCloseTo(PARAM_MOTION_TARGET, 1);

    // Call resetModelToIdle directly
    await controls().resetModelToIdle(char.model, { idleSnapshot: snap });

    expect(char.context._$_2[0]).toBeCloseTo(0, 2);
  });

  it('Live2DManager.resetToIdle restores neutral pose when an action was playing', async () => {
    const char = createRealLayoutSdkModel();
    captureModelNeutralPoseOnce(char.model);
    const { manager, entry } = makeManager(char);
    entry.idleSnapshot = controls().captureIdleSnapshot(char.model);
    manager.setScriptEngine({ isReconstructing: false, getCurrentTime: () => 4 } as any);

    await char.motionManager.startMotion('A');
    char.model.update(600);
    expect(char.context._$_2[0]).toBeCloseTo(PARAM_MOTION_TARGET, 1);

    manager.resetToIdle('hero');
    await manager.waitForAllLoaded();

    expect(char.context._$_2[0]).toBeCloseTo(0, 2);
  });

  it('resetToIdle during reconstruction also restores neutral pose', async () => {
    const char = createRealLayoutSdkModel();
    captureModelNeutralPoseOnce(char.model);
    const { manager, entry } = makeManager(char);
    entry.idleSnapshot = controls().captureIdleSnapshot(char.model);
    manager.setScriptEngine({ isReconstructing: true, getCurrentTime: () => 4 } as any);

    await char.motionManager.startMotion('A');
    char.model.update(600);
    expect(char.context._$_2[0]).toBeCloseTo(PARAM_MOTION_TARGET, 1);

    manager.resetToIdle('hero');
    await manager.waitForAllLoaded();

    expect(char.context._$_2[0]).toBeCloseTo(0, 2);
  });

  it('CharacterSynchronizer.syncTo restores neutral pose when seeking to a time before any motion (isScrubbing=false)', async () => {
    const char = createRealLayoutSdkModel();
    captureModelNeutralPoseOnce(char.model);
    const { manager, entry } = makeManager(char);
    entry.idleSnapshot = controls().captureIdleSnapshot(char.model);
    manager.setScriptEngine({ isReconstructing: false, getCurrentTime: () => 4 } as any);

    // Play motion A
    await char.motionManager.startMotion('A');
    char.model.update(600);
    expect(char.context._$_2[0]).toBeCloseTo(PARAM_MOTION_TARGET, 1);

    const { CharacterSynchronizer } = await import('../engine/coordinators/CharacterSynchronizer');
    const sync = new CharacterSynchronizer(manager);

    await sync.syncTo({
      time: 1, // before motion A (motion A is at t=3)
      desiredChars: new Map([
        ['hero', { id: 'hero', model: 'hero.model.json', config: {} } as any],
      ]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: { findBefore: () => null } as any,
      shouldCancel: () => false,
      skipHardReset: true,
      isScrubbing: false,
    });

    expect(char.context._$_2[0]).toBeCloseTo(0, 2);
  });

  it('CharacterSynchronizer.syncTo restores neutral pose when scrubbing to a time before any motion (isScrubbing=true)', async () => {
    const char = createRealLayoutSdkModel();
    captureModelNeutralPoseOnce(char.model);
    const { manager, entry } = makeManager(char);
    entry.idleSnapshot = controls().captureIdleSnapshot(char.model);
    manager.setScriptEngine({ isReconstructing: false, getCurrentTime: () => 4 } as any);

    // Play motion A
    await char.motionManager.startMotion('A');
    char.model.update(600);
    expect(char.context._$_2[0]).toBeCloseTo(PARAM_MOTION_TARGET, 1);

    const { CharacterSynchronizer } = await import('../engine/coordinators/CharacterSynchronizer');
    const sync = new CharacterSynchronizer(manager);

    await sync.syncTo({
      time: 1, // before motion A (motion A is at t=3)
      desiredChars: new Map([
        ['hero', { id: 'hero', model: 'hero.model.json', config: {} } as any],
      ]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: { findBefore: () => null } as any,
      shouldCancel: () => false,
      skipHardReset: true,
      isScrubbing: true,
    });

    expect(char.context._$_2[0]).toBeCloseTo(0, 2);
  });
});



