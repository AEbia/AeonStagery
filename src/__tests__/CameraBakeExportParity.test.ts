/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';
import { Assets, Container, ObservablePoint, Texture, type Application } from 'pixi.js';
import ScriptEngine from '../engine/ScriptEngine';
import { BakeEngine } from '../engine/BakeEngine';
import { CameraAnchorSampler } from '../engine/CameraAnchorSampler';
import type { PreparedCompiledScene } from '../api/types/semantic-scene';
import { preparedSceneToRuntimeTimelineScene } from '../engine/PreparedRuntimeScene';
import { stageManager } from '../engine/StageManager';
import { subtitleRenderer } from '../engine/SubtitleRenderer';
import { textLayerManager } from '../engine/TextLayerManager';
import { preBakeDaemon, PreBakeDaemon } from '../engine/daemons/PreBakeDaemon';
import { SnapshotStore } from '../engine/SnapshotStore';
import { cameraCrossEntryScene } from './fixtures/cameraCrossEntryScene';
import { FrameCaptureEngine } from '../engine/export/FrameCaptureEngine';
import { cameraController } from '../engine/CameraController';
import type { CameraState } from '../api/types/camera';
import { mockAdapter, mockControls } from './helpers/mockLive2DRuntimeAdapter';
import * as runtimeAdapter from '../engine/Live2DRuntimeAdapter';
import * as runtimeResolver from '../engine/Live2DRuntimeResolver';
import type { ICaptureBackend } from '../engine/export/ICaptureBackend';
import { projectToScreen } from '../engine/Projection';
import { setStageDimensions, STAGE_WIDTH, STAGE_HEIGHT } from '../engine/StageDimensions';
import { live2DManager } from '../engine/Live2DManager';
import { hookSystem } from '../api/hooks';
import { resolveVec2 } from '../engine/utils/math';
import { live2DStageState } from './helpers/live2DStageState';
import { evaluateCameraChannels, type CameraEvaluationOutput } from '../engine/CameraChannelEvaluator';
import { SemanticScenePipeline } from '../services/semantic-scene/SemanticScenePipeline';

// Capture the SDK boundary before singleton Live2DModelResources binds it.
vi.mock('../engine/Live2DRuntimeAdapter', async importOriginal => ({
  ...await importOriginal<typeof import('../engine/Live2DRuntimeAdapter')>(),
  getLive2DRuntimeAdapter: vi.fn(),
}));

describe('formal camera Bake/export parity', () => {
  let engine: ScriptEngine;
  let bake: BakeEngine;
  let sampler: CameraAnchorSampler;
  beforeEach(() => {
    vi.spyOn(subtitleRenderer, 'preloadPreparedScene').mockResolvedValue(undefined);
    vi.spyOn(subtitleRenderer, 'clear').mockImplementation(() => {});
    vi.spyOn(textLayerManager, 'clearAll').mockImplementation(() => {});
    vi.spyOn(preBakeDaemon, 'attach').mockImplementation(() => {});
    vi.spyOn(preBakeDaemon, 'triggerColdScan').mockImplementation(() => {});
    vi.spyOn(stageManager, 'updateImages').mockImplementation(() => {});
    engine = new ScriptEngine();
    bake = new BakeEngine({ renderer: {} } as Application);
    sampler = new CameraAnchorSampler({ renderer: {} } as Application);
  });
  function installModelBoundary(onFrame: () => void = () => {}, onHead: () => void = () => {}, realisticAnchor = false,
    onMotion: (key: string, offset: number) => void = () => {},
    onFocus: (input: { focusX: number; focusY: number }) => void = () => {}) {
    const stageRoot = new Container();
    vi.spyOn(stageManager, 'getApp').mockReturnValue({ stage: stageRoot,
      ticker: { add: () => {}, remove: () => {} }, renderer: {},
    } as unknown as Application);
    vi.spyOn(stageManager, 'getLayer').mockReturnValue(stageRoot);
    const snapshot = { params: new Float32Array([0]), opacities: new Float32Array([1]) };
    vi.spyOn(runtimeResolver, 'resolveLive2DRuntimeDescriptor').mockReturnValue({
      runtimeFamily: 'cubism3-plus', adapterId: 'untitled-pixi-live2d-engine-cubism', supported: true,
    });
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue(mockAdapter({
      id: 'untitled-pixi-live2d-engine-cubism',
      createModel: async () => {
        const model = new Container();
        const anchor = new ObservablePoint({ _onUpdate: () => {
          if (realisticAnchor) model.pivot.set(anchor.x * 100, anchor.y * 200);
        } }, 0, 0);
        return Object.assign(model, {
          anchor,
          getLocalBounds: () => ({ x: 0, y: 0, width: 100, height: 200 }),
        });
      },
      createTestControls: () => mockControls({ captureSnapshot: () => snapshot, captureIdleSnapshot: () => snapshot,
        getHeadAnchor: () => { onHead(); return { x: 0.5, y: 0.2 }; },
        stepBakeFrame: onFrame,
        startMotion: async (_model, key, _priority, offset) => {
          onMotion(key, offset);
          return { ok: true, offsetReplayMs: 0 };
        },
        applyFocus: (_model, input) => { onFocus(input); },
      }),
    }));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ FileReferences: { Moc: 'hero.moc3' } }) })));
  }
  function captureRig(onRender: () => void = () => {}) {
    const root = new Container();
    const resizes: number[][] = [];
    const app = { stage: root, canvas: document.createElement('canvas'), renderer: {
      width: STAGE_WIDTH, height: STAGE_HEIGHT, resolution: 1, screen: { width: STAGE_WIDTH, height: STAGE_HEIGHT },
      background: { color: 0, alpha: 1 }, resize: (width: number, height: number, resolution: number) => {
        resizes.push([width, height, resolution]);
      }, resetState: () => {}, render: onRender,
    } } as unknown as Application;
    const capture = new FrameCaptureEngine({ getApp: () => app, getWidth: () => STAGE_WIDTH, getHeight: () => STAGE_HEIGHT,
      pauseTicker: () => {}, resumeTicker: () => {} },
      engine, { reset: () => {}, syncEffects: () => {} },
      { setExportMode: () => {}, waitForAllLoaded: async () => {}, updateAll: async () => {} }, cameraController);
    const run = (backend: ICaptureBackend, signal?: AbortSignal, overrides: { fps?: number; rangeStart?: number; rangeEnd?: number; width?: number; height?: number } = {}) => capture.capture({
      fps: 24, rangeStart: 1.125, rangeEnd: 1.125 + 1 / 24,
      width: 1920, height: 1080, bitrateBps: 1, outputPath: '/tmp/parity.mp4', codec: 'h264',
      backend, onProgress: () => {}, signal, ...overrides,
    });
    return { root, run, resizes, app };
  }
  afterEach(() => { engine.destroy(); bake.destroy(); sampler.destroy(); gsap.globalTimeline.clear(); setStageDimensions(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  async function cameraSamples(scene: PreparedCompiledScene, start: number, end: number, precision: number) {
    const history = await sampler.prepareCameraAnchorsPrepared(scene, new Map(), 200);
    const timeline = preparedSceneToRuntimeTimelineScene(scene).timeline;
    const cameraStates = [];
    for (let index = 0; start + index * precision <= end + 1e-9; index++) {
      const time = Math.min(start + index * precision, end);
      cameraStates.push({ time, state: evaluateCameraChannels({ timeline, sceneTime: time,
        logicalReferenceSize: { width: STAGE_WIDTH, height: STAGE_HEIGHT },
        anchorTrajectories: history.anchorTrajectories ?? [], trajectoryRevision: history.anchorRevision,
      }) });
    }
    return { ...history, cameraStates };
  }

  it('publishes the same final camera as formal playback and seek at Bake subframes', async () => {
    const scene = await cameraCrossEntryScene();
    await engine.loadPreparedScene(scene);
    await bake.bakePreparedRange(scene, new Map(), 1, 0.875, 1.125, 0.125);
    const result = await cameraSamples(scene, 0.875, 1.125, 0.125);
    expect(result.cameraStates?.map(sample => sample.time)).toEqual([0.875, 1, 1.125]);
    for (const sample of result.cameraStates ?? []) {
      engine.getMasterTimeline()!.seek(sample.time, false);
      expect(engine.getCameraEvaluation()).toEqual(sample.state);
      await engine.seek(sample.time);
      expect(engine.getCameraEvaluation()).toEqual(sample.state);
    }
  });

  it('keeps the mid-action landing and removes temporary camera writers before actual capture', async () => {
    await engine.loadPreparedScene(await cameraCrossEntryScene());
    await engine.seek(1.125);
    const expected = engine.getCurrentCamera();
    const rendered: CameraState[] = [];
    const root = new Container();
    const app = { stage: root, canvas: document.createElement('canvas'), renderer: {
      width: 1920, height: 1080, resolution: 1, screen: { width: 1920, height: 1080 },
      background: { color: 0, alpha: 1 }, resize: () => {}, resetState: () => {},
      render: () => { rendered.push(cameraController.getState()); },
    } } as unknown as Application;
    const capture = new FrameCaptureEngine({ getApp: () => app, pauseTicker: () => {}, resumeTicker: () => {} },
      engine, { reset: () => {}, syncEffects: () => {} },
      { setExportMode: () => {}, waitForAllLoaded: async () => {}, updateAll: async () => {} }, cameraController);
    cameraController.panTo([0.01, 0.99], 10, 'linear');
    cameraController.zoomTo(9, 10, 'linear');
    cameraController.shake({ duration: 10, intensity: 2 });
    cameraController.reset(10);
    await capture.capture({ fps: 24, rangeStart: 1.125, rangeEnd: 1.125 + 1 / 24,
      width: 1920, height: 1080, bitrateBps: 1, outputPath: '/tmp/parity.mp4', codec: 'h264',
      backend: { init: async () => {}, encodeFrame: async () => {}, finish: async () => {} }, onProgress: () => {},
    });
    expect(rendered.length).toBeGreaterThan(1);
    for (const state of rendered) expect(state).toEqual(expected);
    root.destroy();
  });

  it('matches prepared historical focus, missing/reappearing follow and takeover through formal Bake and scene loading', async () => {
    installModelBoundary();
    engine.destroy();
    engine = new ScriptEngine(() => new CameraAnchorSampler({ renderer: {} } as Application));
    const scene = await cameraCrossEntryScene(true);
    await engine.loadPreparedScene(scene);
    await bake.bakePreparedRange(scene, new Map(), 3, 0, 7, 0.125);
    const result = await cameraSamples(scene, 0, 7, 0.125);
    expect(result.cameraStates).toHaveLength(57);
    expect(result.anchorTrajectories?.find(track => track.part === 'head')?.validity).toHaveLength(2);
    for (const sample of result.cameraStates ?? []) {
      await engine.seek(sample.time);
      engine.getMasterTimeline()!.seek(sample.time, false);
      expect(engine.getCameraEvaluation()).toEqual(sample.state);
      await engine.seek(sample.time);
      expect(engine.getCameraEvaluation()).toEqual(sample.state);
    }
    vi.unstubAllGlobals();
  });

  it('prepares reusable anchors without eagerly materializing camera samples when only history is requested', async () => {
    installModelBoundary();
    const scene = await cameraCrossEntryScene(true);
    const result = await sampler.prepareCameraAnchorsPrepared(scene, new Map(), 101);
    expect(result.anchorTrajectories?.find(track => track.part === 'center')?.validity).toHaveLength(2);
    expect(result).not.toHaveProperty('cameraStates');
  });

  it('focuses on the same posed head that the visible character projects', async () => {
    installModelBoundary(() => {}, () => {}, true);
    const scene = await cameraCrossEntryScene(true);
    await engine.loadPreparedScene(scene);
    await engine.seek(1.75);
    const head = live2DManager.getPoint('hero', 'head');
    expect(head).not.toBeNull();
    expect(resolveVec2(engine.getCurrentCamera().position).x).toBeCloseTo(head!.x, 6);
    expect(resolveVec2(engine.getCurrentCamera().position).y).toBeCloseTo(head!.y, 6);
    const model = live2DStageState(live2DManager).characters.get('hero')!.model;
    const projectedHead = model.toGlobal({ x: 50, y: 40 });
    const shake = engine.getCurrentCamera().shakeOffset;
    expect(projectedHead.x).toBeCloseTo(STAGE_WIDTH / 2 + (shake?.x ?? 0), 6);
    expect(projectedHead.y).toBeCloseTo(STAGE_HEIGHT / 2 + (shake?.y ?? 0), 6);
  });

  it('bakes only Live2D snapshots without preparing or returning camera history', async () => {
    installModelBoundary(() => {}, () => { throw new Error('Snapshot Bake must not query camera anchors'); });
    const result = await bake.bakePreparedRange(await cameraCrossEntryScene(true), new Map(), 99, 1, 2, 0.125);
    expect(result.snapshotHistory.length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty('anchorTrajectories');
    expect(result).not.toHaveProperty('anchorRevision');
    expect(result).not.toHaveProperty('cameraStates');
  });

  it('loads a long scene without scanning its future camera history', async () => {
    let frames = 0;
    installModelBoundary(() => { frames++; }, () => {}, true);
    const base = await cameraCrossEntryScene(true);
    const scene = { ...base, durationSeconds: 600, actions: [ ...base.actions,
      { id: 'terminal', action: 'cameraReset' as const, time: 600, params: { duration: 0 },
        source: { statementId: 'terminal', outputKey: 'primary' } },
    ] };
    await engine.loadPreparedScene(scene);
    expect(frames).toBeLessThan(30);
    await engine.seek(1.75);
    const head = live2DManager.getPoint('hero', 'head')!;
    expect(resolveVec2(engine.getCurrentCamera().position).x).toBeCloseTo(head.x, 6);
    expect(resolveVec2(engine.getCurrentCamera().position).y).toBeCloseTo(head.y, 6);
    expect(frames).toBeLessThan(100);
  });

  it('seeks a late focus without replaying hundreds of seconds of unrelated poses', async () => {
    let frames = 0;
    installModelBoundary(() => { frames++; }, () => {}, true);
    const base = await cameraCrossEntryScene(true);
    const scene = { ...base, durationSeconds: 600, actions: base.actions
      .filter(action => action.action === 'addCharacter').slice(0, 1).map(action => ({ ...action, time: 0 }))
      .concat([{ id: 'late-focus', action: 'cameraMotion' as const, time: 590,
        params: { move: 'pan', focus: { character: 'hero', part: 'head' }, duration: 0,
          _cameraProperties: ['position'] },
        source: { statementId: 'late-focus', outputKey: 'primary' } }]) };
    await engine.loadPreparedScene(scene);
    await engine.seek(595);
    const head = live2DManager.getPoint('hero', 'head')!;
    expect(resolveVec2(engine.getCurrentCamera().position).x).toBeCloseTo(head.x, 6);
    expect(resolveVec2(engine.getCurrentCamera().position).y).toBeCloseTo(head.y, 6);
    expect(engine.getCurrentTime()).toBe(595);
    expect(frames).toBeLessThan(30);
  });

  it('restores native motion offsets across unsampled camera gaps', async () => {
    const starts: number[] = [];
    installModelBoundary(() => {}, () => {}, true, (_key, offset) => { starts.push(offset); });
    const base = await cameraCrossEntryScene(true);
    const entry = base.actions.find(action => action.action === 'addCharacter')!;
    await sampler.prepareCameraAnchorsPrepared({ ...base, durationSeconds: 600, actions: [
      { ...entry, time: 0 },
      { id: 'pose', action: 'playMotion', time: 0, params: { id: 'hero', motion: { kind: 'resource', key: 'pose' } },
        source: { statementId: 'pose', outputKey: 'primary' } },
      { id: 'focus', action: 'cameraMotion', time: 590, params: { move: 'pan',
        focus: { character: 'hero', part: 'head' }, duration: 0, _cameraProperties: ['position'] },
        source: { statementId: 'focus', outputKey: 'primary' } },
    ] }, new Map(), 203, { throughTime: 590, cameraOnly: true });
    expect(starts).toContain(590);
    expect(starts.length).toBeLessThan(5);
  });

  it('retains other character transforms when resolving the focused character gaze', async () => {
    const focuses: number[] = [];
    installModelBoundary(() => {}, () => {}, true, () => {}, input => { focuses.push(input.focusX); });
    const scene = (await new SemanticScenePipeline({ resolveAsset: source => source }).processDocument({
      schemaVersion: 5, sceneId: 'camera-gaze-dependency',
      meta: { title: 'Camera gaze dependency', durationSeconds: 600, characters: [
        { id: 'hero', name: 'Hero', model: 'hero.model3.json' },
        { id: 'other', name: 'Other', model: 'other.model3.json' },
      ] },
      statements: [
        { id: 'hero-enter', type: 'characterPresence', time: 0, params: { mode: 'enter', id: 'hero', position: [0.4, 0.7], durationSeconds: 0 } },
        { id: 'other-enter', type: 'characterPresence', time: 0, params: { mode: 'enter', id: 'other', position: [0.2, 0.7], durationSeconds: 0 } },
        { id: 'gaze', type: 'characterPerformance', time: 0, params: { target: 'hero', lookAt: { target: 'other' } } },
        { id: 'other-move', type: 'characterTransform', time: 580, params: { id: 'other', position: [0.9, 0.7], durationSeconds: 0 } },
        { id: 'focus', type: 'camera', time: 590, params: { mode: 'focus', target: 'hero', durationSeconds: 0 } },
      ],
    })).prepared;
    await sampler.prepareCameraAnchorsPrepared(scene, new Map(), 204, { throughTime: 590, cameraOnly: true });
    expect(focuses.at(-1)).toBeGreaterThan(0);
  });

  it('prepares the authored endpoint of a fast character transform between cadence samples', async () => {
    installModelBoundary();
    const base = await cameraCrossEntryScene(true);
    const scene = { ...base, durationSeconds: 12, actions: [
      ...base.actions.filter(action => !['leave', 'return'].includes(action.source.statementId))
        .map(action => action.source.statementId === 'walk'
          ? { ...action, time: 10, params: { ...action.params, duration: 0.08 } } : action),
      { id: 'terminal', action: 'cameraReset' as const, time: 12, params: { duration: 0 },
        source: { statementId: 'terminal', outputKey: 'primary' } },
    ] };
    const result = await sampler.prepareCameraAnchorsPrepared(scene, new Map(), 102);
    const track = result.anchorTrajectories!.find(track => track.part === 'center')!;
    expect(track.samples.find(sample => sample.time === 10.08)?.position).toBeDefined();
  });

  it('keeps exact disappearance and reentry instants after long fixed-cadence preparation', async () => {
    installModelBoundary();
    const base = await cameraCrossEntryScene(true);
    const scene = { ...base, durationSeconds: 600, actions: [
      ...base.actions.map(action => action.source.statementId === 'leave' ? { ...action, time: 300 }
        : action.source.statementId === 'return' ? { ...action, time: 302 } : action),
      { id: 'terminal', action: 'cameraReset' as const, time: 600, params: { duration: 0 },
        source: { statementId: 'terminal', outputKey: 'primary' } },
    ] };
    const result = await sampler.prepareCameraAnchorsPrepared(scene, new Map(), 100);
    const track = result.anchorTrajectories!.find(track => track.part === 'center')!;
    expect(track.validity[0].end).toBe(300);
    expect(track.validity[1].start).toBe(302);
    expect(track.samples.some(sample => sample.time === 300)).toBe(true);
    expect(track.samples.some(sample => sample.time === 302)).toBe(true);
  });

  it('waits for the current formal trajectory before initializing the backend or rendering', async () => {
    installModelBoundary();
    engine.destroy();
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const preparing = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    engine = new ScriptEngine(() => ({
      prepareCameraAnchorsPrepared: async (scene, paths, token) => {
        started?.(); await gate;
        return sampler.prepareCameraAnchorsPrepared(scene, paths, token);
      }, cancel: () => sampler.cancel(), destroy: () => {},
    }));
    const input = await cameraCrossEntryScene(true);
    const loading = engine.loadPreparedScene({ ...input, actions: input.actions.map(action =>
      action.source.statementId === 'focus' ? { ...action, time: 0 } : action) });
    await preparing;
    let encoded = 0;
    let backendStarted = false;
    const rig = captureRig();
    const exporting = rig.run({ init: async () => { backendStarted = true; },
      encodeFrame: async () => { encoded++; }, finish: async () => {},
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    const startedWhileUnready = backendStarted;
    release?.();
    await loading;
    await exporting;
    expect(startedWhileUnready).toBe(false);
    expect(encoded).toBe(1);
    rig.root.destroy();
  });

  it.each(['cancel', 'failure', 'superseded'] as const)('drops an export waiting for trajectory preparation on %s', async mode => {
    installModelBoundary(); engine.destroy();
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const preparing = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    engine = new ScriptEngine(() => ({
      prepareCameraAnchorsPrepared: async (scene, paths, token) => {
        started?.(); await gate;
        if (mode === 'failure') throw new Error('Anchor preparation failed');
        return sampler.prepareCameraAnchorsPrepared(scene, paths, token);
      }, cancel: () => sampler.cancel(), destroy: () => {},
    }));
    const input = await cameraCrossEntryScene(true);
    const loading = engine.loadPreparedScene({ ...input, actions: input.actions.map(action =>
      action.source.statementId === 'focus' ? { ...action, time: 0 } : action) });
    const loadingOutcome = loading.catch(error => error as Error);
    await preparing;
    const controller = new AbortController();
    let startedBackend = false;
    const rig = captureRig();
    const exporting = rig.run({ init: async () => { startedBackend = true; },
      encodeFrame: async () => {}, finish: async () => {},
    }, controller.signal);
    const rejected = expect(exporting).rejects.toThrow(mode === 'failure' ? 'Anchor preparation failed'
      : mode === 'superseded' ? 'Prepared camera scene changed' : /abort/i);
    if (mode === 'cancel') {
      controller.abort();
      await rejected; // Cancellation settles without waiting for the SDK load.
    }
    const replacement = mode === 'superseded' ? engine.loadPreparedScene(await cameraCrossEntryScene()) : null;
    release?.(); await loadingOutcome; await replacement;
    if (mode !== 'cancel') await rejected;
    expect(startedBackend).toBe(false);
    rig.root.destroy();
  });

  it('rejects a scene replacement between captured frames instead of exporting mixed revisions', async () => {
    await engine.loadPreparedScene(await cameraCrossEntryScene());
    const rig = captureRig();
    let encoded = 0;
    let aborted = false;
    await expect(rig.run({ init: async () => {}, encodeFrame: async () => {
      encoded++; await engine.loadPreparedScene({ ...await cameraCrossEntryScene(), sceneId: 'replacement' });
    }, finish: async () => {}, abort: async () => { aborted = true; } }, undefined,
    { rangeEnd: 1.5 })).rejects.toThrow('Prepared camera scene changed');
    expect(encoded).toBe(1);
    expect(aborted).toBe(true);
    rig.root.destroy();
  });

  it('discards cancelled snapshot Bake work and recovers without publishing camera data', async () => {
    let cancelNext = true;
    installModelBoundary(() => { if (cancelNext) { cancelNext = false; bake.cancel(); } });
    const scene = await cameraCrossEntryScene(true);
    const cancelled = await bake.bakePreparedRange(scene, new Map(), 8, 1, 2, 0.125);
    expect(cancelled).toEqual({ snapshotHistory: [] });
    const recovered = await bake.bakePreparedRange(scene, new Map(), 9, 1, 2, 0.125);
    expect(recovered.snapshotHistory).toHaveLength(9);
    expect(recovered).not.toHaveProperty('cameraStates');
    expect(recovered).not.toHaveProperty('anchorTrajectories');
  });

  it('produces seeded range snapshots without preparing character anchors', async () => {
    installModelBoundary(() => {}, () => { throw new Error('Unexpected anchor preparation'); });
    const scene = await cameraCrossEntryScene(true);
    const result = await bake.bakePreparedRange(scene, new Map(), 11, 2.125, 2.25, 0.125, undefined, true);
    expect(result.snapshotHistory.length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty('cameraStates');
  });

  it('runs the actual background daemon without any camera history input', async () => {
    let allowPreparation = true;
    installModelBoundary(() => {}, () => { if (!allowPreparation) throw new Error('Daemon repeated anchor preparation'); });
    const scene = await cameraCrossEntryScene(true);
    allowPreparation = false;
    const daemon = new PreBakeDaemon();
    const store = new SnapshotStore();
    try {
      daemon.attach(store, scene);
      daemon.triggerColdScan();
      await vi.waitFor(() => expect(store.size).toBeGreaterThan(0), { timeout: 4000, interval: 10 });
      expect(store.findBefore(6)?.models.has('hero')).toBe(true);
    } finally { daemon.dispose(); }
  });

  it('leaves the paused live character and camera unchanged while snapshot Bake advances', async () => {
    let assertDuringBake = () => {};
    installModelBoundary(() => assertDuringBake());
    const scene = await cameraCrossEntryScene(true);
    await engine.loadPreparedScene(scene);
    await engine.seek(1.75);
    engine.pause();
    const camera = engine.getCurrentCamera();
    const actor = live2DManager.getContainer('hero');
    const pose = { x: actor.x, y: actor.y, angle: actor.angle };
    let frames = 0;
    assertDuringBake = () => {
      frames++;
      expect(engine.getCurrentTime()).toBe(1.75);
      expect(engine.getCurrentCamera()).toEqual(camera);
      expect({ x: actor.x, y: actor.y, angle: actor.angle }).toEqual(pose);
    };
    await bake.bakePreparedRange(scene, new Map(), 13, 0, 7, 0.125, undefined, true);
    expect(frames).toBeGreaterThan(10);
  });

  it('drops a trajectory batch whose reference size changes during isolated model preparation', async () => {
    let changed = false;
    installModelBoundary(() => { if (!changed) { changed = true; setStageDimensions({ width: 1080, height: 1920, fps: 60 }); } });
    const result = await sampler.prepareCameraAnchorsPrepared(await cameraCrossEntryScene(true), new Map(), 14);
    expect(result).toEqual({ snapshotHistory: [] });
  });

  it.each([{ width: 1920, height: 1080 }, { width: 1080, height: 1920 }, { width: 1080, height: 1080 }])(
    'preserves projected character orientation, UI and authoring-unit shake at $width x $height and double output pixels', async format => {
      setStageDimensions({ ...format, fps: 60 });
      installModelBoundary(); engine.destroy();
      engine = new ScriptEngine(() => new CameraAnchorSampler({ renderer: {} } as Application));
      const scene = await cameraCrossEntryScene(true);
      await engine.loadPreparedScene(scene);
      await engine.seek(1.125);
      const expectedCamera = engine.getCurrentCamera();
      const proxy = { x: STAGE_WIDTH * 0.625, y: STAGE_HEIGHT * 0.5, scale: 1, rotation: 30, z: 300 };
      const expected = projectToScreen(proxy, expectedCamera, { w: STAGE_WIDTH, h: STAGE_HEIGHT });
      const rig = captureRig(() => {
        // Exercise the actual character projection consumer with the captured camera.
        live2DManager.applyProxyTransform('projection-probe', proxy, undefined, cameraController.getState());
        const character = live2DManager.getContainer('projection-probe');
        expect(character.x).toBeCloseTo(expected.screenX, 8);
        expect(character.y).toBeCloseTo(expected.screenY, 8);
        expect(character.angle).toBeCloseTo(11.25, 8);
        expect(character.zIndex).toBe(300);
      });
      const ui = rig.root.addChild(new Container());
      ui.position.set(12, 34); ui.angle = 7;
      for (const multiplier of [1, 2]) {
        await rig.run({ init: async () => {}, encodeFrame: async () => {
          expect(ui.position.x).toBe(12); expect(ui.position.y).toBe(34); expect(ui.angle).toBe(7);
          const screen = ui.getGlobalPosition();
          expect(screen.x).toBeCloseTo(12, 8); expect(screen.y).toBeCloseTo(34, 8);
          expect(ui.getGlobalTransform().a).toBeCloseTo(Math.cos(7 * Math.PI / 180), 8);
        }, finish: async () => {} }, undefined, { width: format.width * multiplier, height: format.height * multiplier });
        expect(rig.resizes.at(-2)).toEqual([STAGE_WIDTH, STAGE_HEIGHT, multiplier]);
      }
      rig.root.destroy();
    },
  );

  it('captures projected environment and custom images beside fixed UI at 1x and 2x', async () => {
    const scene = await cameraCrossEntryScene();
    await engine.loadPreparedScene(scene);
    await engine.seek(1.125);
    const camera = engine.getCurrentCamera();
    let capturedImage: ReturnType<typeof stageManager.addImage> = null;
    const rig = captureRig(() => {
      capturedImage = stageManager.getImageSprite('capture-image');
      expect(capturedImage?.parent).toBe(effectsLayer);
    });
    const backgroundLayer = new Container();
    const effectsLayer = new Container();
    rig.root.addChild(backgroundLayer, effectsLayer);
    const originalApp = Object.getOwnPropertyDescriptor(stageManager, 'app');
    Object.defineProperty(stageManager, 'app', { configurable: true, writable: true, value: rig.app });
    const getLayerSpy = vi.spyOn(stageManager, 'getLayer').mockImplementation((name) => (
      name === 'background' ? backgroundLayer : effectsLayer
    ));
    const assetLoadSpy = vi.spyOn(Assets, 'load').mockImplementation(async () => Texture.EMPTY as never);

    try {
      vi.spyOn(stageManager, 'updateImages').mockRestore();
      await engine.loadPreparedScene({ ...scene, actions: [...scene.actions, {
        id: 'capture-image', action: 'addImage', time: 0,
        params: { id: 'capture-image', file: 'images/capture-image.png', position: [0.35, 0.65], scale: 1, rotation: -15, z: 20 },
        source: { statementId: 'capture-image', outputKey: 'primary' },
      }] });
      await stageManager.renderEnvironmentLayer({
        layerId: 'capture-environment', x: 0.65, y: 0.4, scale: 1, rotation: 25, z: 10,
        images: [{ image: 'images/capture-environment.png', weight: 1 }],
      }, camera);
      const environment = stageManager.getEnvironmentLayerDisplayObject('capture-environment');
      if (!environment) throw new Error('Capture environment fixture was not materialized.');

      const ui = rig.root.addChild(new Container());
      ui.position.set(18, 27);
      ui.angle = 9;
      const expectedEnvironment = projectToScreen({
        x: 0.65 * STAGE_WIDTH, y: 0.4 * STAGE_HEIGHT, scale: 1, rotation: 25,
        parallaxDepth: 10, drawOrder: 10,
      }, camera, { w: STAGE_WIDTH, h: STAGE_HEIGHT });
      const environmentBaseScale = Math.max(
        STAGE_WIDTH / Texture.EMPTY.width,
        STAGE_HEIGHT / Texture.EMPTY.height,
      );

      for (const multiplier of [1, 2]) {
        let encoded = 0;
        await rig.run({ init: async () => {}, encodeFrame: async () => {
          const imageCamera = cameraController.getState();
          const expectedImage = projectToScreen({
            x: 0.35 * STAGE_WIDTH, y: 0.65 * STAGE_HEIGHT, scale: 1, rotation: -15,
            parallaxDepth: 20, drawOrder: 20,
          }, imageCamera, { w: STAGE_WIDTH, h: STAGE_HEIGHT });
          if (!capturedImage) throw new Error('Capture image fixture was not materialized.');
          expect(environment.parent).toBe(backgroundLayer.children[0]);
          expect(environment.x).toBeCloseTo(expectedEnvironment.screenX, 7);
          expect(environment.y).toBeCloseTo(expectedEnvironment.screenY, 7);
          expect(environment.angle).toBeCloseTo(expectedEnvironment.screenRotation, 7);
          expect(environment.scale.x / environmentBaseScale).toBeCloseTo(expectedEnvironment.screenScale, 7);
          expect(capturedImage.parent).toBe(effectsLayer);
          expect(capturedImage.x).toBeCloseTo(expectedImage.screenX, 7);
          expect(capturedImage.y).toBeCloseTo(expectedImage.screenY, 7);
          expect(capturedImage.angle).toBeCloseTo(expectedImage.screenRotation, 7);
          expect(capturedImage.scale.x).toBeCloseTo(expectedImage.screenScale, 7);
          expect(capturedImage.scale.y).toBeCloseTo(expectedImage.screenScale, 7);
          expect(ui.getGlobalPosition().x).toBeCloseTo(18, 7);
          expect(ui.getGlobalPosition().y).toBeCloseTo(27, 7);
          expect(ui.getGlobalTransform().a).toBeCloseTo(Math.cos(9 * Math.PI / 180), 7);
          encoded++;
        }, finish: async () => {} }, undefined, {
          width: 1920 * multiplier,
          height: 1080 * multiplier,
        });
        expect(encoded).toBe(1);
        expect(rig.resizes.at(-2)).toEqual([STAGE_WIDTH, STAGE_HEIGHT, multiplier]);
      }
    } finally {
      stageManager.cancelImageRequest('capture-image');
      stageManager.clearEnvironmentLayer('capture-environment');
      if (originalApp) Object.defineProperty(stageManager, 'app', originalApp);
      else Reflect.deleteProperty(stageManager, 'app');
      assetLoadSpy.mockRestore();
      getLayerSpy.mockRestore();
      rig.root.destroy({ children: true });
    }
  });

  it('keeps camera evaluation reads free of camera events and character pose updates after fps sampling', async () => {
    installModelBoundary(); engine.destroy();
    engine = new ScriptEngine(() => new CameraAnchorSampler({ renderer: {} } as Application));
    await engine.loadPreparedScene(await cameraCrossEntryScene(true));
    await engine.seek(2.875);
    const update = vi.spyOn(live2DManager, 'updateAll');
    const getPoint = vi.spyOn(live2DManager, 'getPoint');
    const events: string[] = [];
    const off = hookSystem.on('camera:move', () => { events.push('move'); });
    try {
      const pose = engine.getCurrentCamera();
      for (let index = 0; index < 10; index++) expect(engine.getCurrentCamera()).toEqual(pose);
      expect(update).not.toHaveBeenCalled(); expect(getPoint).not.toHaveBeenCalled(); expect(events).toEqual([]);
    } finally { off(); }
  });

  it('keeps actual capture and Bake equal across 24/30/60/120 fps and reverse subframe queries', async () => {
    installModelBoundary(); engine.destroy();
    engine = new ScriptEngine(() => new CameraAnchorSampler({ renderer: {} } as Application));
    const scene = await cameraCrossEntryScene(true);
    await engine.loadPreparedScene(scene);
    const commonTimes = [0.125, 0.5, 0.75, 1.125, 1.25, 1.5, 1.75, 2, 2.375, 2.75, 3.25, 4, 4.125, 4.75, 5.625];
    const common: CameraState[] = [];
    for (const time of commonTimes) { await engine.seek(time); common.push(engine.getCurrentCamera()); }
    for (const fps of [24, 30, 60, 120]) {
      const start = 0.125;
      const end = 7;
      await bake.bakePreparedRange(scene, new Map(), fps, start, end, 1 / fps);
      const baked = await cameraSamples(scene, start, end, 1 / fps);
      const expected: CameraState[] = [];
      const expectedEvaluation: CameraEvaluationOutput[] = [];
      for (const sample of baked.cameraStates ?? []) {
        engine.getMasterTimeline()!.seek(sample.time, false);
        expected.push(engine.getCurrentCamera());
        const camera = engine.getCameraEvaluation()!;
        expectedEvaluation.push(camera);
        expect(camera.position.x).toBeCloseTo(sample.state.position.x, 6);
        expect(camera.position.y).toBeCloseTo(sample.state.position.y, 6);
        expect(camera.zoom).toBeCloseTo(sample.state.zoom, 5);
        expect(camera.rotation).toBeCloseTo(sample.state.rotation, 4);
        expect(camera.shake.x).toBeCloseTo(sample.state.shake.x, 4);
        expect(camera.shake.y).toBeCloseTo(sample.state.shake.y, 4);
        expect(camera.follow).toEqual(sample.state.follow);
        expect(camera.diagnostics).toEqual(sample.state.diagnostics);
      }
      const rig = captureRig();
      let encoded = 0;
      await rig.run({ init: async () => {}, encodeFrame: async ({ frameIndex }) => {
        const state = cameraController.getState();
        expect(state).toEqual(expected[frameIndex]);
        expect(engine.getCameraEvaluation()).toEqual(expectedEvaluation[frameIndex]);
        const proxy = { x: 1200, y: 540, scale: 1, rotation: 25, z: 300 };
        expect(projectToScreen(proxy, state, { w: STAGE_WIDTH, h: STAGE_HEIGHT }))
          .toEqual(projectToScreen(proxy, expected[frameIndex]!, { w: STAGE_WIDTH, h: STAGE_HEIGHT }));
        encoded++;
      }, finish: async () => {} }, undefined, { fps, rangeStart: start, rangeEnd: end });
      expect(encoded).toBe(Math.ceil(end * fps) - Math.floor(start * fps));
      for (const time of [...commonTimes].reverse()) {
        await engine.seek(6.875); await engine.seek(time);
        expect(engine.getCurrentCamera()).toEqual(common[commonTimes.indexOf(time)]);
      }
      rig.root.destroy();
    }
  }, 30_000);
});
