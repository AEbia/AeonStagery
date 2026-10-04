/**
 * @vitest-environment jsdom
 */
/**
 * Regression tests for stale ("dirty data") motion/expression state surviving a
 * seek (ADR-0029).
 *
 * Every failing case here reproduces the same user-visible symptom: the seeked
 * frame — and most visibly the fade-in window right after it — still shows the
 * previous action / expression because one of the retained runtime channels
 * keeps writing a pose that belongs to another scene time.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Live2DManager from '../engine/Live2DManager';
import { Cubism2PixiLive2DModelControls } from '../engine/Live2DRuntimeAdapter';
import { evaluateCustomMotionRuntime } from '../engine/live2d/customMotionRuntime';
import ScriptEngine, { resolveExpressionPredecessors } from '../engine/ScriptEngine';
import { live2DManager } from '../engine/Live2DManager';

function createCubism2Character() {
  const paramValues = new Float32Array([0, 0, 0]);
  const opacities = new Float32Array([1, 1, 1]);
  const expressionState = { current: null as string | null };
  const motionManager: any = {
    playing: false,
    state: { currentGroup: undefined, reservedGroup: undefined, queue: [] },
    _motionQueueManager: { stopAllMotions: vi.fn() },
    loadMotion: vi.fn().mockResolvedValue(undefined),
    startMotion: vi.fn().mockImplementation(async (group: string) => {
      motionManager.state.currentGroup = group;
      motionManager.playing = true;
      // A real Cubism motion leaves its first frame at the previous pose.
      paramValues[0] = 0.8;
      return true;
    }),
    stopAllMotions: vi.fn(() => {
      motionManager.state.currentGroup = undefined;
      motionManager.state.queue = [];
      motionManager.playing = false;
    }),
  };
  const expressionManager: any = {
    state: { currentGroup: undefined },
    setExpression: vi.fn((name: string | null) => { expressionState.current = name; }),
    stopAllExpressions: vi.fn(() => { expressionState.current = null; }),
    resetExpression: vi.fn(() => { expressionState.current = null; }),
  };
  motionManager.expressionManager = expressionManager;
  const coreModel: any = {
    getParamIndex: vi.fn(() => 1),
    setParamFloat: vi.fn((_id: any, value: number) => { paramValues[1] = value; }),
    getParameterValues: () => paramValues,
    getPartOpacities: () => opacities,
    loadParam: vi.fn(() => { paramValues[0] = 0; paramValues[1] = 0; }),
    saveParam: vi.fn(),
  };
  const model: any = {
    destroyed: false,
    x: 0,
    y: 0,
    rotation: 0,
    alpha: 1,
    _modelUrl: 'hero.model.json',
    scale: { x: 1, y: 1, set: vi.fn() },
    anchor: { set: vi.fn() },
    expression: vi.fn((name: string | null) => { expressionState.current = name; }),
    update: vi.fn(),
    stopAllMotions: vi.fn(),
    internalModel: {
      settings: { motions: { wave: [{}], idle: [{}] } },
      motionManager,
      expressionManager,
      parameterValues: paramValues,
      partOpacities: opacities,
      coreModel,
    },
  };
  return { model, motionManager, expressionManager, expressionState, paramValues, coreModel };
}

function makeManager(char: ReturnType<typeof createCubism2Character>) {
  const manager = new Live2DManager();
  const entry: any = {
    id: 'hero',
    model: char.model,
    modelPath: 'hero.model.json',
    modelUrl: 'hero.model.json',
    runtime: { runtimeFamily: 'cubism2', adapterId: 'pixi-live2d-display-cubism2', supported: true },
    adapterId: 'pixi-live2d-display-cubism2',
    config: {},
    injectedParams: {},
    lipSyncParameterIds: new Set<string>(),
    motionEpoch: 0,
  };
  (manager as any).characters = new Map([['hero', entry]]);
  (manager as any).containers = new Map();
  return manager;
}

function installUtSystem() {
  (globalThis as any).window = {
    UtSystem: { getUserTimeMSec: vi.fn(() => 1000), setUserTimeMSec: vi.fn() },
  };
}

describe('seek to a time before a motion', () => {
  beforeEach(installUtSystem);

  it('stops the SDK motion queue and drops the previous action pose', async () => {
    const char = createCubism2Character();
    const manager = makeManager(char);
    const engine: any = { isReconstructing: false, getCurrentTime: () => 3 };
    manager.setScriptEngine(engine);

    manager.playMotion('hero', 'wave', 3, 1, 3);
    await manager.updateAll(16);
    await manager.waitForAllLoaded();
    expect(char.motionManager.playing).toBe(true);
    expect(char.paramValues[0]).toBeGreaterThan(0);

    // ScriptEngine._doSeek (reconstruct branch) + CharacterSynchronizer's
    // "desired state has no motion" reset for the seeked time.
    engine.isReconstructing = true;
    manager.clearAllPendingMotions();
    manager.purgeAllCharacterRuntimeState();
    manager.resetToIdle('hero');
    await manager.waitForAllLoaded();

    expect(char.motionManager.playing).toBe(false);
    expect(char.motionManager.state.currentGroup).toBeUndefined();
    expect(char.paramValues[0]).toBe(0);
  });

  it('drops the seek-boundary pose that would be re-applied inside the fade-in', async () => {
    const char = createCubism2Character();
    const manager = makeManager(char);
    manager.setScriptEngine({ isReconstructing: false, getCurrentTime: () => 3 } as any);
    const entry = (manager as any).characters.get('hero');

    // A seek that landed inside the handoff window latched a boundary pose;
    // updateAll re-applies it every paused frame inside that window.
    entry.pendingSeekBoundarySnapshot = { params: new Float32Array([0.9]), opacities: new Float32Array([1]) };
    entry.pendingSeekBoundaryMotionStartTime = 3;
    entry.pendingSeekBoundaryDuration = 0.5;
    entry.lastSnapshot = { params: new Float32Array([0.9]), opacities: new Float32Array([1]) };
    entry.injectedParams.PARAM_ANGLE_X = 0.9;
    entry.expressionKey = 'smile';

    manager.purgeAllCharacterRuntimeState();

    expect(entry.pendingSeekBoundarySnapshot).toBeUndefined();
    expect(entry.pendingSeekBoundaryMotionStartTime).toBeUndefined();
    expect(entry.pendingSeekBoundaryDuration).toBeUndefined();
    expect(entry.lastSnapshot).toBeUndefined();
    expect(entry.injectedParams.PARAM_ANGLE_X).toBeUndefined();
    expect(entry.expressionKey).toBeNull();
    expect(char.expressionState.current).toBeNull();
  });

  it('discards a queued motion intent from the pre-seek position', async () => {
    const char = createCubism2Character();
    const manager = makeManager(char);
    manager.setScriptEngine({ isReconstructing: false, getCurrentTime: () => 3 } as any);
    const entry = (manager as any).characters.get('hero');
    const epoch = entry.motionEpoch;

    manager.playMotion('hero', 'wave', 3, 1, 3);
    expect(entry._pendingPlayMotion).toBeDefined();

    manager.purgeAllCharacterRuntimeState();

    expect(entry._pendingPlayMotion).toBeUndefined();
    expect(entry.motionEpoch).toBeGreaterThan(epoch);
    // The buffered intent must not start once the next frame runs.
    await manager.updateAll(16);
    await manager.waitForAllLoaded();
    expect(char.motionManager.playing).toBe(false);
  });
});

describe('seek to a time before the character entrance', () => {
  beforeEach(installUtSystem);

  it('recycles a neutral model instance into the preload pool', async () => {
    const char = createCubism2Character();
    const manager = makeManager(char);
    manager.setScriptEngine({ isReconstructing: false, getCurrentTime: () => 3 } as any);

    manager.playMotion('hero', 'wave', 3, 1, 3);
    manager.setExpression('hero', 'smile');
    await manager.updateAll(16);
    await manager.waitForAllLoaded();
    expect(char.paramValues[0]).toBeGreaterThan(0);

    // Seeking before the entrance removes the character; the model instance is
    // pooled and reused by the next entrance, whose fade-in would otherwise
    // reveal the previous action's pose.
    manager.removeCharacter('hero');

    const pool = (manager as any).modelLoader.preloadedModels.get('hero.model.json');
    expect(pool?.length ?? 0).toBe(1);
    expect(char.motionManager.playing).toBe(false);
    expect(char.expressionState.current).toBeNull();
    expect(char.paramValues[0]).toBe(0);
  });
});

describe('custom motion edit inside its fade-in window', () => {
  it('evaluates the edited curve instead of the accumulated pre-edit frames', () => {
    const motion: any = {
      kind: 'custom',
      durationSeconds: 2,
      fadeInSeconds: 1,
      tracks: [{
        parameterId: 'PARAM_ANGLE_X',
        fadeInSeconds: 1,
        keyframes: [
          { time: 0, value: 0, segment: { type: 'linear' } },
          { time: 1, value: 10 },
        ],
      }],
    };
    const handoff: any = { values: { PARAM_ANGLE_X: 0 } };

    const before = evaluateCustomMotionRuntime(motion, 10, 10.5, handoff);
    expect(before.values.PARAM_ANGLE_X).toBeGreaterThan(0);

    // Same motion object (an edit that mutates it in place must still apply).
    (motion.tracks[0].keyframes[1] as any).value = -10;
    const after = evaluateCustomMotionRuntime(motion, 10, 10.5, handoff);

    expect(after.values.PARAM_ANGLE_X).toBeLessThan(0);
  });
});

describe('seek expression fade-in source', () => {
  function createExpressionHarness() {
    let utTime = 100_000;
    const parameterValues = new Float32Array([0.25]);
    const coreModel = {
      getParamFloat: () => parameterValues[0],
      setParamFloat: (_id: string | number, value: number) => { parameterValues[0] = value; },
      getParameterValues: () => parameterValues,
      saveParam: vi.fn(),
      loadParam: vi.fn(),
      update: vi.fn(),
    };
    const queue: Array<{ motion: any; startTime: number | null }> = [];
    const startTimes: Array<{ name: string; startTime: number }> = [];
    const queueManager = {
      startMotion: (motion: any) => { queue.push({ motion, startTime: null }); },
      stopAllMotions: () => { queue.length = 0; },
    };
    const updateParam = (model: any) => {
      for (const entry of queue) {
        if (entry.startTime === null) {
          entry.startTime = utTime;
          startTimes.push({ name: entry.motion.name ?? '?', startTime: utTime });
        }
        const elapsed = Math.max(0, utTime - entry.startTime);
        const weight = Math.max(0, Math.min(1, elapsed / 500));
        entry.motion.updateParamExe(model, elapsed, weight);
      }
    };
    const expressionA = { name: 'a', updateParamExe: vi.fn((model: any, _t: number, w: number) => model.setParamFloat('PARAM_MOUTH_FORM', 0.9 * w)) };
    const expressionB = { name: 'b', updateParamExe: vi.fn((model: any, _t: number, w: number) => model.setParamFloat('PARAM_EYE_OPEN', 0.6 * w)) };
    const defaultExpression = { name: 'default' };
    const expressionManager: any = {
      expressions: [expressionA, expressionB],
      definitions: [{ name: 'a' }, { name: 'b' }],
      currentExpression: defaultExpression,
      defaultExpression,
      reserveExpressionIndex: -1,
      queueManager,
      getExpressionIndex: (name: string) => (name === 'a' ? 0 : name === 'b' ? 1 : -1),
      loadExpression: vi.fn(async (index: number) => (index === 0 ? expressionA : expressionB)),
      _setExpression: vi.fn((motion: any) => { queueManager.startMotion(motion); }),
      update: (model: any) => { updateParam(model); },
    };
    const model = {
      update: vi.fn((delta: number) => { if (delta > 0) expressionManager.update(coreModel); }),
      render: vi.fn(),
      internalModel: { parameterValues, coreModel, motionManager: { expressionManager } },
    };
    (globalThis as any).window = {
      UtSystem: {
        getUserTimeMSec: () => utTime,
        setUserTimeMSec: (value: number) => { utTime = value; },
      },
    };
    return {
      controls: new Cubism2PixiLive2DModelControls(),
      model,
      expressionManager,
      expressionA,
      expressionB,
      startTimes,
    };
  }

  it('does not blend out of the expression the model happened to have', async () => {
    const harness = createExpressionHarness();
    // Playback left expression B applied — a seek to a time before B must not
    // use it as the resident fade source.
    harness.expressionManager.currentExpression = harness.expressionB;

    await harness.controls.setExpressionForSeek(harness.model, 'a', 0.2, null);

    expect(harness.expressionManager._setExpression).toHaveBeenCalledTimes(1);
    expect(harness.expressionManager._setExpression.mock.calls[0][0]).toBe(harness.expressionA);
    expect(harness.startTimes.map((entry) => entry.name)).toEqual(['a']);
  });

  it('blends out of the authored predecessor when the scene has one', async () => {
    const harness = createExpressionHarness();

    await harness.controls.setExpressionForSeek(harness.model, 'a', 0.2, 'b');

    expect(harness.expressionManager._setExpression).toHaveBeenCalledTimes(2);
    expect(harness.expressionManager._setExpression.mock.calls[0][0]).toBe(harness.expressionB);
    expect(harness.expressionManager._setExpression.mock.calls[1][0]).toBe(harness.expressionA);
  });
});

describe('scene-resolved expression predecessor', () => {
  it('resolves the expression in effect just before each target start', () => {
    const desired = new Map<string, any>([
      ['hero', { expression: { key: 'sad', time: 4 } }],
      ['other', { expression: { key: 'angry', time: 4 } }],
      ['late', { expression: { key: 'happy', time: 8 } }],
      ['untimed', { expression: { key: 'flat' } }],
      ['none', {}],
    ]);
    const queries: number[] = [];
    const charactersAtTime = (time: number) => {
      queries.push(time);
      return new Map<string, any>([
        ['hero', { expression: { key: 'smile' } }],
        ['other', {}],
        ['late', { expression: { key: 'sad' } }],
      ]);
    };

    const resolved = resolveExpressionPredecessors(desired, charactersAtTime);

    expect(resolved.get('hero')).toBe('smile');
    expect(resolved.get('other')).toBeNull();
    expect(resolved.get('late')).toBe('sad');
    // No recorded start time: never fall back to a guessed predecessor.
    expect(resolved.get('untimed')).toBeNull();
    // One state evaluation per distinct start time, not per character.
    expect(queries).toEqual([4 - 0.001, 8 - 0.001]);
  });
});

describe('light seek (the path a scene edit takes)', () => {
  it('purges retained character state before rebuilding it at the target time', async () => {
    (globalThis as any).window.AeonStagery = {
      services: {
        projectResources: {
          getCurrentProject: () => ({ rootPath: 'D:/demo' }),
          resolveForRuntime: async (path: string) => `asset://localhost/${path}`,
        },
      },
    };
    const engine = new ScriptEngine();
    (engine as any).masterTimeline = { seek: vi.fn(), time: () => 1, kill: vi.fn(), pause: vi.fn(), play: vi.fn() };
    (engine as any).currentScene = {
      sceneId: 'edit-seek',
      meta: { fps: 30 },
      timeline: [
        { _id: 'a1', action: 'addCharacter', time: 0, params: { id: 'char1', model: 'figure/m.json' } },
      ],
    };
    const hasCharacter = vi.spyOn(live2DManager, 'hasCharacter').mockReturnValue(true);
    const listCharacters = vi.spyOn(live2DManager, 'listCharacters').mockReturnValue(['char1']);
    const matchesLoadedModel = vi.spyOn(live2DManager, 'matchesLoadedModel').mockResolvedValue(true);
    const purge = vi.spyOn(live2DManager, 'purgeAllCharacterRuntimeState');
    const sync = vi.fn().mockResolvedValue(undefined);
    (engine as any).syncAllStates = sync;
    (engine as any).pauseForSeek = vi.fn();

    try {
      await engine.seek(1, false);
      // The light branch must purge: it is the path a motion edit takes, and no
      // model rebuild happens there to clear the retained channels.
      expect(purge).toHaveBeenCalledTimes(1);
      expect(sync).toHaveBeenCalledTimes(1);
    } finally {
      hasCharacter.mockRestore();
      listCharacters.mockRestore();
      matchesLoadedModel.mockRestore();
      purge.mockRestore();
    }
  });
});
