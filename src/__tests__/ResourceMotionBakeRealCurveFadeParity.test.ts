/**
 * @vitest-environment jsdom
 *
 * Bake snapshots of cache-backed Cubism 2 resource motions must contain the
 * Live2D fade-in pose at the FIRST frame of a new motion: the handoff to the
 * predecessor motion must take effect.
 *
 * Unlike ResourceMotionBakeFadeParity, the motion curve cache is NOT mocked:
 * the real sampler + cache pipeline builds the synthesized curves from fake
 * .mtn files, so the fade assert runs on the real derived-motion shape
 * (ADR-0029/0033: cache stores pure targets, fade reconstructed at 60Hz).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { SCENE_SCHEMA_VERSION, type PreparedCompiledScene } from '../api/types/semantic-scene';
import { BakeEngine } from '../engine/BakeEngine';
import * as runtimeAdapter from '../engine/Live2DRuntimeAdapter';
import * as runtimeResolver from '../engine/Live2DRuntimeResolver';
import { motionCurveCache } from '../engine/live2d/motionCurveCache';
import { mockControls, mockAdapter } from './helpers/mockLive2DRuntimeAdapter';

const SOURCE_MODEL = 'figure/soyo/model.json';
const RESOLVED_MODEL = 'D:/mock/demo/figure/soyo/model.json';
const RUNTIME_URI = 'asset://localhost/D:/mock/demo/figure/soyo/model.json';

interface FakeParamCurve {
  readonly id: string;
  readonly values: readonly number[];
  readonly type?: number;
}

interface FakeMotionFile {
  readonly fps: number;
  readonly curves: readonly FakeParamCurve[];
}

function encodeMotionFile(file: FakeMotionFile): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(file)).buffer as ArrayBuffer;
}

function createMotion(file: FakeMotionFile) {
  const durationMs = Math.round(
    Math.max(...file.curves.map((curve) => curve.values.length), 0) * 1000 / file.fps,
  );
  return {
    motions: file.curves.map((curve) => ({
      _$4P: curve.id,
      _$RP: curve.type ?? 0,
    })),
    setFadeIn: vi.fn(),
    setFadeOut: vi.fn(),
    getDurationMSec: () => durationMs,
    evaluate(model: any, elapsedMs: number) {
      const framePosition = elapsedMs * file.fps / 1000;
      const frame = Math.floor(framePosition);
      const ratio = framePosition - frame;
      for (const curve of file.curves) {
        if ((curve.type ?? 0) !== 0) continue;
        const left = curve.values[Math.min(frame, curve.values.length - 1)];
        const right = curve.values[Math.min(frame + 1, curve.values.length - 1)];
        model.setParamFloat(curve.id, left + (right - left) * ratio);
      }
    },
  };
}

class FakeMotionQueueManager {
  private motion: ReturnType<typeof createMotion> | null = null;
  private startTime: number | null = null;

  startMotion(motion: ReturnType<typeof createMotion>): number {
    this.motion = motion;
    return 1;
  }

  updateParam(model: any): boolean {
    if (!this.motion) return false;
    const now = (window as any).UtSystem.getUserTimeMSec();
    const startTime = this.startTime ?? now;
    this.startTime = startTime;
    this.motion.evaluate(model, now - startTime);
    return true;
  }

  stopAllMotions(): void {
    this.motion = null;
  }
}

function installCubism2SamplerRuntime() {
  let now = 1000;
  (window as any).UtSystem = {
    getUserTimeMSec: vi.fn(() => now),
    setUserTimeMSec: vi.fn((value: number) => { now = value; }),
  };
  (window as any).Live2DMotion = {
    loadMotion: vi.fn((buffer: ArrayBuffer) => {
      const file = JSON.parse(new TextDecoder().decode(buffer)) as FakeMotionFile;
      return createMotion(file);
    }),
  };
  (window as any).MotionQueueManager = FakeMotionQueueManager;
}

const MOTION_FILES: Record<string, FakeMotionFile> = {
  // Holds a non-zero pose (20) for 2s — the predecessor of the return motion.
  'hold.mtn': {
    fps: 2,
    curves: [{ id: 'PARAM_ANGLE_X', values: [20, 20, 20, 20] }],
  },
  // Returns to neutral (0) for 2s — the motion whose first frame must NOT jump.
  'return.mtn': {
    fps: 2,
    curves: [{ id: 'PARAM_ANGLE_X', values: [0, 0, 0, 0] }],
  },
};

function fetchMotionFiles(url: string): Promise<{ ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }> {
  if (url.endsWith('.mtn')) {
    const name = url.split('/').pop()!;
    const file = MOTION_FILES[name];
    return Promise.resolve({
      ok: true,
      arrayBuffer: async () => encodeMotionFile(file),
    });
  }
  // Model descriptor fetch: reject so resolveBakeRuntime falls back to the
  // runtime descriptor (same as the other BakeEngine tests).
  return Promise.resolve({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) });
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
    settings: {
      motions: {
        idle: [{ file: 'idle.mtn' }],
        hold: [{ file: 'hold.mtn' }],
        return: [{ file: 'return.mtn' }],
      },
      resolveURL: (file: string) => `asset://localhost/${file}`,
    },
    motionManager: {
      settings: {
        motions: {
          idle: [{ file: 'idle.mtn' }],
          hold: [{ file: 'hold.mtn' }],
          return: [{ file: 'return.mtn' }],
        },
        resolveURL: (file: string) => `asset://localhost/${file}`,
      },
      loadMotion: vi.fn(async () => undefined),
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
  vi.stubGlobal('fetch', vi.fn(fetchMotionFiles) as any);
  return created;
}

function preparedScene(actions: PreparedCompiledScene['actions'], durationSeconds: number): PreparedCompiledScene {
  return {
    kind: 'prepared-compiled-scene',
    sourceSchemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'bake-real-fade',
    meta: {
      title: 'Bake Real Fade',
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

describe('BakeEngine real curve-cache fade parity at motion boundaries', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    motionCurveCache.clear();
  });

  it.each([false, true])('does not bake a later motion into entrance snapshots when reusing a model for an earlier range (seeded=%s)', async (seeded) => {
    installCubism2SamplerRuntime();
    installCubism2BakeRuntime(createCubism2BakeModel);
    const engine = new BakeEngine(createApp());
    const scene = preparedScene([
      addCharacterAction(),
      playResourceMotionAction('compiled:play-hold', 1, 'hold'),
    ], 3);
    const paths = new Map([[SOURCE_MODEL, RESOLVED_MODEL]]);
    try {
      const later = await engine.bakePreparedRange(scene, paths, 1, 0, 2, 0.25, undefined, true);
      expect(later.snapshotHistory.at(-1)!.models.get('soyo')!.params[0]).toBeCloseTo(20, 2);

      const seed = seeded ? later.snapshotHistory.find(snapshot => snapshot.time === 0.25) : undefined;
      const earlier = await engine.bakePreparedRange(scene, paths, 2, seeded ? 0.25 : 0, 0.75, 0.25, seed, true);
      expect(earlier.snapshotHistory.length).toBeGreaterThan(0);
      for (const snapshot of earlier.snapshotHistory) {
        expect(snapshot.models.get('soyo')!.params[0], `entrance snapshot at ${snapshot.time}`).toBeCloseTo(0, 3);
      }
    } finally {
      engine.destroy();
    }
  });

  it('does not jump to standing on the first frame of the new motion (real sampler + cache)', async () => {
    installCubism2SamplerRuntime();
    installCubism2BakeRuntime(createCubism2BakeModel);

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

    // The real sampler/cache must have produced cached entries (cache hit path).
    expect(motionCurveCache.size).toBeGreaterThanOrEqual(2);

    // First snapshot at/after the boundary snapshot times: 2.0 must be the
    // predecessor hold pose (20) — the handoff — not the return curve target (0).
    const first = result.snapshotHistory.find((entry) => Math.abs(entry.time - 2.0) < 1e-6);
    expect(first).toBeDefined();
    const firstAngle = first!.models.get('soyo')!.params[0];
    expect(firstAngle).toBeCloseTo(20, 2);

    // Fade still in progress at 2.25: blended value, not 20 and not 0.
    const snap = result.snapshotHistory.find((entry) => Math.abs(entry.time - 2.25) < 1e-6);
    expect(snap).toBeDefined();
    const angle = snap!.models.get('soyo')!.params[0];
    expect(angle).toBeGreaterThan(0.1);
    expect(angle).toBeLessThan(19.5);

    engine.destroy();
  });
});

function createApp(): any {
  return { renderer: {} };
}
