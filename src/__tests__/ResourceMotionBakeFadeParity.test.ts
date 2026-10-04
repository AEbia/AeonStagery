/**
 * @vitest-environment jsdom
 *
 * Bake snapshots of cache-backed Cubism 2 resource motions must contain the
 * Live2D fade-in pose Seek later restores. The curve cache stores pure motion
 * targets (ADR-0033); fade-in is reconstructed at 60Hz from the handoff pose
 * and must be committed to core parameters before captureModelSnapshot.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { SCENE_SCHEMA_VERSION, type PreparedCompiledScene } from '../api/types/semantic-scene';
import { BakeEngine } from '../engine/BakeEngine';
import * as runtimeAdapter from '../engine/Live2DRuntimeAdapter';
import * as runtimeResolver from '../engine/Live2DRuntimeResolver';
import { motionCurveCache, type CachedResourceMotion } from '../engine/live2d/motionCurveCache';
import { mockControls, mockAdapter } from './helpers/mockLive2DRuntimeAdapter';
import type { CharacterMotionOutput } from '../api/types/semantic-scene';

const SOURCE_MODEL = 'figure/soyo/model.json';
const RESOLVED_MODEL = 'D:/mock/demo/figure/soyo/model.json';
const RUNTIME_URI = 'asset://localhost/D:/mock/demo/figure/soyo/model.json';

const CACHED_WAVE: Extract<CharacterMotionOutput, { kind: 'custom' }> = {
  kind: 'custom',
  durationSeconds: 2,
  fadeInSeconds: 0.5,
  derivedFrom: { key: 'wave', fadeInSeconds: 0.5 },
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

const CACHED_HOLD: Extract<CharacterMotionOutput, { kind: 'custom' }> = {
  kind: 'custom',
  durationSeconds: 2,
  fadeInSeconds: 0,
  derivedFrom: { key: 'hold' },
  tracks: [
    {
      parameterId: 'PARAM_ANGLE_X',
      keyframes: [
        { time: 0, value: 20, segment: { type: 'linear' } },
        { time: 2, value: 20 },
      ],
    },
  ],
};

const CACHED_RETURN: Extract<CharacterMotionOutput, { kind: 'custom' }> = {
  kind: 'custom',
  durationSeconds: 2,
  fadeInSeconds: 0.5,
  derivedFrom: { key: 'return', fadeInSeconds: 0.5 },
  tracks: [
    {
      parameterId: 'PARAM_ANGLE_X',
      keyframes: [
        { time: 0, value: 0, segment: { type: 'linear' } },
        { time: 2, value: 0 },
      ],
    },
  ],
};

function cachedEntry(motion: Extract<CharacterMotionOutput, { kind: 'custom' }>): CachedResourceMotion {
  return {
    key: `pixi-live2d-display-cubism2::${RUNTIME_URI}::${motion.derivedFrom.key}`,
    motion,
    sourceFadeInSeconds: motion.fadeInSeconds,
    isIdle: false,
    evaluate: () => ({}),
  };
}

function createApp(): any {
  return { renderer: {} };
}

function createCubism2BakeModel() {
  const params = new Float32Array([0]);
  const opacities = new Float32Array([1]);
  const listeners = new Map<string, Set<() => void>>();
  const coreModel = {
    getParamIndex: (name: string) => (name === 'PARAM_ANGLE_X' ? 0 : -1),
    setParamFloat: (index: number, value: number) => {
      if (index === 0) params[0] = value;
    },
    getParamFloat: (index: number) => (index === 0 ? params[0] : 0),
    getParameterValues: () => params,
    getPartOpacities: () => opacities,
    update: vi.fn(),
  };
  const internalModel: any = {
    coreModel,
    parameterValues: params,
    partOpacities: opacities,
    settings: { motions: { idle: [{}], wave: [{}], hold: [{}], return: [{}] } },
    motionManager: {
      loadMotion: vi.fn(async () => true),
      startMotion: vi.fn(async () => true),
      stopAllMotions: vi.fn(),
      state: {},
      _motionQueueManager: { stopAllMotions: vi.fn() },
    },
    on: (event: string, handler: () => void) => {
      (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(handler);
    },
    off: (event: string, handler: () => void) => {
      listeners.get(event)?.delete(handler);
    },
    emit: (event: string) => {
      listeners.get(event)?.forEach((handler) => handler());
    },
    update: vi.fn((_dt?: number, _now?: number) => {
      internalModel.emit('afterMotionUpdate');
    }),
  };
  const model: any = new PIXI.Container();
  model.visible = true;
  model.renderable = true;
  model.alpha = 1;
  model.x = 0;
  model.y = 0;
  model.rotation = 0;
  model.scale.set(1, 1);
  model.internalModel = internalModel;
  model.deltaTime = 16;
  model.elapsedTime = 16;
  model.update = vi.fn((dt?: number) => {
    model.deltaTime = Number(dt) || 16;
    model.elapsedTime = (model.elapsedTime ?? 0) + model.deltaTime;
    internalModel.update(model.deltaTime, model.elapsedTime);
    coreModel.update();
  });
  return { model, params, coreModel, internalModel };
}

function cubism2Controls(model: ReturnType<typeof createCubism2BakeModel>) {
  // The bake loop delegates every behavior to the adapter's controls; the real
  // cubism2 controls contain the relocated legacy logic (advance-without-render
  // fast path, snapshot capture, sampler targets), so delegate to them to keep
  // the mock model driven exactly as the engine used to drive it.
  const realControls = runtimeAdapter.cubism2Live2DAdapter.getControls();
  return mockControls({
    getCoreModel: () => model.coreModel,
    getMotionDuration: () => 2,
    getParameterValues: () => [{ index: 0, name: 'PARAM_ANGLE_X', value: model.params[0] }],
    getMotionSamplingTargets: (m: any) => realControls.getMotionSamplingTargets(m),
    stepBakeFrame: (m: any, deltaMs: number, renderer?: any, label?: string, flushCore?: boolean) =>
      realControls.stepBakeFrame(m, deltaMs, renderer, label, flushCore),
    captureSnapshot: (id: string, m: any, motionStartTime?: number) =>
      realControls.captureSnapshot(id, m, motionStartTime),
    prepareModel: (m: any, options: any) => realControls.prepareModel(m, options),
    flushIdleState: (m: any) => realControls.flushIdleState(m),
    restartIdleMotion: (m: any) => realControls.restartIdleMotion(m),
    isolateMask: (m: any) => realControls.isolateMask(m),
    installBakeRenderGuards: (m: any) => realControls.installBakeRenderGuards(m),
    stopAllMotions: (m: any) => realControls.stopAllMotions(m),
    clearMotionState: (m: any) => realControls.clearMotionState(m),
    setInjectedParameter: (_liveModel: any, paramName: string, value: number) => {
      if (paramName === 'PARAM_ANGLE_X') model.params[0] = value;
    },
    applySnapshot: (_liveModel: any, snapshot: { params?: ArrayLike<number> }) => {
      if (snapshot.params && snapshot.params.length > 0) {
        model.params[0] = snapshot.params[0];
      }
    },
    renderForBake: vi.fn(),
  });
}

function installCubism2BakeRuntime(modelFactory: () => ReturnType<typeof createCubism2BakeModel>) {
  const created: ReturnType<typeof createCubism2BakeModel>[] = [];
  vi.spyOn(runtimeResolver, 'resolveLive2DRuntimeDescriptor').mockReturnValue({
    runtimeFamily: 'cubism2',
    adapterId: 'pixi-live2d-display-cubism2',
    supported: true,
  });
  vi.spyOn(runtimeAdapter.cubism2Live2DAdapter, 'init').mockResolvedValue(undefined as never);
  vi.spyOn(runtimeAdapter.cubism2Live2DAdapter, 'isReady').mockReturnValue(true);
  vi.spyOn(runtimeAdapter.cubism2Live2DAdapter, 'getModelClass').mockReturnValue({
    config: { cubism2: { maskSize: 1024 } },
  });
  vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockImplementation(() => {
    const current = created[created.length - 1];
    return mockAdapter({
      getModelClass: vi.fn(() => null),
      createModel: vi.fn(async () => {
        const next = modelFactory();
        created.push(next);
        return next.model;
      }),
      getControls: () => cubism2Controls(created[created.length - 1] ?? current),
    } as any);
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })) as any);
  return created;
}

function preparedScene(actions: PreparedCompiledScene['actions'], durationSeconds: number): PreparedCompiledScene {
  return {
    kind: 'prepared-compiled-scene',
    sourceSchemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'bake-fade',
    meta: {
      title: 'Bake Fade',
      characters: [{ id: 'soyo', name: 'Soyo', model: SOURCE_MODEL }],
      fps: 60,
    },
    durationSeconds,
    actions,
  };
}

function addCharacterAction(): PreparedCompiledScene['actions'][number] {
  return {
    id: 'compiled:add-character',
    time: 0,
    action: 'addCharacter',
    params: {
      id: 'soyo',
      model: { source: SOURCE_MODEL, runtimeUri: RUNTIME_URI },
    },
    source: { statementId: 'stmt-soyo', outputKey: 'primary' },
  };
}

function playResourceMotionAction(id: string, time: number, key: string, duration = 2): PreparedCompiledScene['actions'][number] {
  return {
    id,
    time,
    action: 'playMotion',
    params: {
      id: 'soyo',
      motion: { kind: 'resource', key },
      priority: 3,
      duration,
    },
    source: { statementId: id, outputKey: 'primary' },
  };
}

describe('BakeEngine Cubism 2.1 resource-motion fade-in snapshots', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('captures the 60Hz Cubism fade-in blend, not idle and not the raw curve target', async () => {
    installCubism2BakeRuntime(createCubism2BakeModel);
    vi.spyOn(motionCurveCache, 'ensure').mockResolvedValue(cachedEntry(CACHED_WAVE));
    vi.spyOn(motionCurveCache, 'missReason').mockReturnValue(null);

    const engine = new BakeEngine(createApp());
    const result = await engine.bakePreparedRange(
      preparedScene([
        addCharacterAction(),
        playResourceMotionAction('compiled:play-wave', 0, 'wave'),
      ], 2),
      new Map([[SOURCE_MODEL, RESOLVED_MODEL]]),
      1,
      0,
      0.25,
      0.25,
      undefined,
      true,
    );

    const snap = result.snapshotHistory.find((entry) => Math.abs(entry.time - 0.25) < 1e-6);
    expect(snap).toBeDefined();
    const angle = snap!.models.get('soyo')!.params[0];
    // Independent Cubism 60Hz sine accumulation from handoff 0 toward the
    // linear 0→20 / 2s curve at localTime 0.25s with fadeIn 0.5s.
    // Idle is 0; the raw (unfaded) curve target is 2.5.
    expect(angle).toBeCloseTo(2.2556, 3);
    expect(angle).not.toBeCloseTo(0, 2);
    expect(angle).not.toBeCloseTo(2.5, 2);

    engine.destroy();
  });

  it('fades the next resource motion in from the previous motion pose, not idle', async () => {
    installCubism2BakeRuntime(createCubism2BakeModel);
    vi.spyOn(motionCurveCache, 'ensure').mockImplementation(async (source: any) => {
      if (source.motionKey === 'hold') return cachedEntry(CACHED_HOLD);
      if (source.motionKey === 'return') return cachedEntry(CACHED_RETURN);
      return null;
    });
    vi.spyOn(motionCurveCache, 'missReason').mockReturnValue(null);

    const engine = new BakeEngine(createApp());
    const result = await engine.bakePreparedRange(
      preparedScene([
        addCharacterAction(),
        playResourceMotionAction('compiled:play-hold', 0, 'hold'),
        playResourceMotionAction('compiled:play-return', 2, 'return'),
      ], 3),
      new Map([[SOURCE_MODEL, RESOLVED_MODEL]]),
      1,
      0,
      2.25,
      0.25,
      undefined,
      true,
    );

    const snap = result.snapshotHistory.find((entry) => Math.abs(entry.time - 2.25) < 1e-6);
    expect(snap).toBeDefined();
    const angle = snap!.models.get('soyo')!.params[0];
    // Motion B's curve target is 0. Fading from idle (0) would stay 0;
    // fading from motion A's held pose (20) yields the Cubism 60Hz blend.
    expect(angle).toBeCloseTo(0.5167, 3);
    expect(angle).not.toBeCloseTo(0, 2);
    expect(angle).not.toBeCloseTo(20, 2);

    engine.destroy();
  });

  it('does not restart fade-in when a motion-start seed jumps into the fade window', async () => {
    installCubism2BakeRuntime(createCubism2BakeModel);
    vi.spyOn(motionCurveCache, 'ensure').mockImplementation(async (source: any) => {
      if (source.motionKey === 'hold') return cachedEntry(CACHED_HOLD);
      if (source.motionKey === 'return') return cachedEntry(CACHED_RETURN);
      return null;
    });
    vi.spyOn(motionCurveCache, 'missReason').mockReturnValue(null);

    const engine = new BakeEngine(createApp());
    const paths = new Map([[SOURCE_MODEL, RESOLVED_MODEL]]);
    const scene = preparedScene([
      addCharacterAction(),
      playResourceMotionAction('compiled:play-hold', 0, 'hold'),
      playResourceMotionAction('compiled:play-return', 2, 'return'),
    ], 3);

    const prefix = await engine.bakePreparedRange(scene, paths, 1, 0, 2.0, 0.2, undefined, true);
    const seed = [...prefix.snapshotHistory].reverse().find((entry) => entry.time <= 2);
    expect(seed).toBeDefined();
    expect(seed!.time).toBeLessThanOrEqual(2);

    const result = await engine.bakePreparedRange(scene, paths, 2, 2.2, 2.25, 0.05, seed, true);
    const snap = result.snapshotHistory.find((entry) => Math.abs(entry.time - 2.25) < 1e-3);
    expect(snap).toBeDefined();
    const angle = snap!.models.get('soyo')!.params[0];
    // Range starts at 2.2, inside B's 0.5s fade. The seed is the motion-start
    // pose (A's held 20 at 2.0). Fade-in must keep reconstructing from that
    // handoff — not idle-reset the seeded character, and not treat 2.2 as a
    // new fade origin. 60Hz sine accumulation from 20 at localTime 0.25s is
    // ~0.5167.
    expect(angle).toBeCloseTo(0.5167, 3);
    expect(angle).not.toBeCloseTo(0, 2);

    engine.destroy();
  });

  it('keeps reconstructing fade-in from the motion-start pose when the seed itself sits inside the fade window', async () => {
    installCubism2BakeRuntime(createCubism2BakeModel);
    vi.spyOn(motionCurveCache, 'ensure').mockImplementation(async (source: any) => {
      if (source.motionKey === 'hold') return cachedEntry(CACHED_HOLD);
      if (source.motionKey === 'return') return cachedEntry(CACHED_RETURN);
      return null;
    });
    vi.spyOn(motionCurveCache, 'missReason').mockReturnValue(null);

    const engine = new BakeEngine(createApp());
    const paths = new Map([[SOURCE_MODEL, RESOLVED_MODEL]]);
    const scene = preparedScene([
      addCharacterAction(),
      playResourceMotionAction('compiled:play-hold', 0, 'hold'),
      playResourceMotionAction('compiled:play-return', 2, 'return'),
    ], 3);

    const prefix = await engine.bakePreparedRange(scene, paths, 1, 0, 2.2, 0.2, undefined, true);
    const seed = prefix.snapshotHistory.find((entry) => Math.abs(entry.time - 2.2) < 1e-3);
    expect(seed).toBeDefined();
    expect(seed!.time).toBeGreaterThan(2);

    const result = await engine.bakePreparedRange(scene, paths, 2, seed!.time, 2.25, 0.05, seed, true);
    const snap = result.snapshotHistory.find((entry) => Math.abs(entry.time - 2.25) < 1e-3);
    expect(snap).toBeDefined();
    const angle = snap!.models.get('soyo')!.params[0];
    // Seed pose is already mid-fade. Using it as the Cubism handoff would
    // restart the 60Hz accumulation from that blended value (~0.40 at 2.25).
    // Fade-in must keep the motion-start pose (20) as the source.
    expect(angle).toBeCloseTo(0.5167, 3);
    expect(angle).not.toBeCloseTo(0.4014, 3);

    engine.destroy();
  });

  it('resumes fade-in from the seed capture time, not the range-start frame number', async () => {
    installCubism2BakeRuntime(createCubism2BakeModel);
    vi.spyOn(motionCurveCache, 'ensure').mockImplementation(async (source: any) => {
      if (source.motionKey === 'hold') return cachedEntry(CACHED_HOLD);
      if (source.motionKey === 'return') return cachedEntry(CACHED_RETURN);
      return null;
    });
    vi.spyOn(motionCurveCache, 'missReason').mockReturnValue(null);

    const engine = new BakeEngine(createApp());
    const paths = new Map([[SOURCE_MODEL, RESOLVED_MODEL]]);
    const scene = preparedScene([
      addCharacterAction(),
      playResourceMotionAction('compiled:play-hold', 0, 'hold'),
      playResourceMotionAction('compiled:play-return', 2, 'return'),
    ], 3);

    // Prefix bakes up to 2.25 (inside return's 0.5s fade); the seed snapshot
    // is captured at 2.25 but the next range starts at 2.3 — seed.time is
    // STRICTLY EARLIER than rangeStart, the production norm (PreBakeDaemon
    // seeds with snapshotStore.findBefore(task.rangeStart)).
    const prefix = await engine.bakePreparedRange(scene, paths, 1, 0, 2.25, 0.25, undefined, true);
    const seed = prefix.snapshotHistory.find((entry) => Math.abs(entry.time - 2.25) < 1e-3);
    expect(seed).toBeDefined();
    expect(seed!.time).toBe(2.25);

    const result = await engine.bakePreparedRange(scene, paths, 2, 2.3, 2.5, 0.1, seed, true);
    const snap = result.snapshotHistory.find((entry) => Math.abs(entry.time - 2.3) < 1e-3);
    expect(snap).toBeDefined();
    const angle = snap!.models.get('soyo')!.params[0];
    // Truth: uninterrupted 60Hz accumulation from handoff 20 at 0.3s into the
    // fade is ~0.0317 (the 2.25 pose ~0.5167 has advanced 3 more frames).
    // Seeding frames by rangeStart's frame number (0.3) would fill frames
    // 0..18 with the 2.25 pose and freeze the whole interval at 0.5167 —
    // the pre-fix behaviour this test guards (P1 regression).
    expect(angle).toBeCloseTo(0.0317, 3);
    expect(angle).not.toBeCloseTo(0.5167, 2);

    engine.destroy();
  });
});
