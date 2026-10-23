/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';
import { Assets, Container, ObservablePoint, Texture, type Application } from 'pixi.js';
import ScriptEngine from '../engine/ScriptEngine';
import { BakeEngine } from '../engine/BakeEngine';
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
import { evaluateCameraChannels } from '../engine/CameraChannelEvaluator';
import { resolveVec2 } from '../engine/utils/math';
import { CameraAdapter } from '../api/adapters/CameraAdapter';
import { SemanticScenePipeline } from '../services/semantic-scene/SemanticScenePipeline';

// Capture the SDK boundary before singleton Live2DModelResources binds it.
vi.mock('../engine/Live2DRuntimeAdapter', async importOriginal => ({
  ...await importOriginal<typeof import('../engine/Live2DRuntimeAdapter')>(),
  getLive2DRuntimeAdapter: vi.fn(),
}));

describe('formal camera Bake/export parity', () => {
  let engine: ScriptEngine;
  let bake: BakeEngine;
  beforeEach(() => {
    vi.spyOn(subtitleRenderer, 'preloadPreparedScene').mockResolvedValue(undefined);
    vi.spyOn(subtitleRenderer, 'clear').mockImplementation(() => {});
    vi.spyOn(textLayerManager, 'clearAll').mockImplementation(() => {});
    vi.spyOn(preBakeDaemon, 'attach').mockImplementation(() => {});
    vi.spyOn(preBakeDaemon, 'triggerColdScan').mockImplementation(() => {});
    vi.spyOn(stageManager, 'updateImages').mockImplementation(() => {});
    engine = new ScriptEngine();
    bake = new BakeEngine({ renderer: {} } as Application);
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
  afterEach(() => { engine.destroy(); bake.destroy(); gsap.globalTimeline.clear(); setStageDimensions(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  async function cameraSamples(scene: PreparedCompiledScene, start: number, end: number, precision: number) {
    const timeline = preparedSceneToRuntimeTimelineScene(scene).timeline;
    const cameraStates = [];
    for (let index = 0; start + index * precision <= end + 1e-9; index++) {
      const time = Math.min(start + index * precision, end);
      cameraStates.push({ time, state: evaluateCameraChannels({ timeline, sceneTime: time,
        logicalReferenceSize: { width: STAGE_WIDTH, height: STAGE_HEIGHT },
        anchorTrajectories: [],
      }) });
    }
    return { cameraStates };
  }

  it('reloads and scrubs character cameras repeatedly without creating simulation models or frames', async () => {
    const simulationFrame = vi.fn();
    installModelBoundary(simulationFrame);
    const createModel = vi.spyOn(runtimeAdapter.getLive2DRuntimeAdapter({ runtimeFamily: 'cubism3-plus', adapterId: 'untitled-pixi-live2d-engine-cubism', supported: true }), 'createModel');
    const initial = await cameraCrossEntryScene(true);
    await engine.loadPreparedScene(initial);
    await engine.seek(1.8, false);
    engine.pause();
    const visibleModel = live2DManager.getContainer('hero');
    const initialLoads = createModel.mock.calls.length;
    const initialFrames = simulationFrame.mock.calls.length;
    for (let edit = 0; edit < 12; edit++) {
      const scene = { ...initial, actions: initial.actions.map(action => action.source.statementId === 'focus'
        ? { ...action, params: { ...action.params, duration: 0.1 + edit / 100 } } : action) };
      await engine.loadPreparedScene(scene);
      await engine.seek(1.6 + edit / 100, false);
      expect(live2DManager.getContainer('hero')).toBe(visibleModel);
      expect(engine.isPlaying()).toBe(false);
    }
    expect(simulationFrame).toHaveBeenCalledTimes(initialFrames);
    expect(createModel).toHaveBeenCalledTimes(initialLoads);
    expect(initialLoads).toBe(1);
    expect(simulationFrame).not.toHaveBeenCalled();
    const session = await engine.prepareForExport();
    session.assertCurrent();
    expect(simulationFrame).not.toHaveBeenCalled();
  });

  it('resolves a character focus from the visible head without historical preparation', async () => {
    installModelBoundary(() => {}, () => {}, true);
    const base = await cameraCrossEntryScene(true);
    const scene = { ...base, actions: base.actions.filter(action =>
      ['enter', 'walk', 'focus'].includes(action.source.statementId)) };
    await engine.loadPreparedScene(scene);
    await engine.seek(1.75);
    const head = live2DManager.getPoint('hero', 'head');
    expect(head).not.toBeNull();
    const position = engine.getCurrentCamera().position;
    expect(Array.isArray(position)).toBe(false);
    if (Array.isArray(position)) throw new Error('Expected resolved camera position');
    expect(position.x).toBeCloseTo(head!.x, 6);
    expect(position.y).toBeCloseTo(head!.y, 6);
  });

  it('uses the captured live focus destination when playback resumes after its first seek', async () => {
    const simulationFrame = vi.fn();
    installModelBoundary(simulationFrame, () => {}, true);
    const base = await cameraCrossEntryScene(true);
    const scene = { ...base, actions: base.actions
      .filter(action => ['enter', 'focus'].includes(action.source.statementId))
      .map(action => action.source.statementId === 'focus'
        ? { ...action, params: { ...action.params, duration: 2 } } : action) };
    await engine.loadPreparedScene(scene);
    await engine.seek(2, true);
    const master = engine.getMasterTimeline()!;
    engine.play();
    master.pause();
    master.seek(2.5, false);
    const playback = engine.getCurrentCamera();
    engine.pause();
    await engine.seek(2.5, true);
    expect(engine.getCurrentCamera()).toEqual(playback);
    master.seek(3.5, false);
    const playbackEnd = engine.getCurrentCamera();
    await engine.seek(3.5, true);
    expect(engine.getCurrentCamera()).toEqual(playbackEnd);
    expect(simulationFrame).not.toHaveBeenCalled();
  });

  it('bakes the requested scene tail after the last authored action', async () => {
    installModelBoundary();
    const base = await cameraCrossEntryScene(true);
    const scene = { ...base, actions: base.actions.filter(action => action.source.statementId === 'enter') };
    const paths = new Map([['hero.model3.json', 'hero.model3.json']]);
    const result = await bake.bakePreparedRange(scene, paths, 1, 0, 2, 0.25);
    expect(result.snapshotHistory.at(-1)?.time).toBe(2);

    const seed = result.snapshotHistory.at(-1);
    const tail = await bake.bakePreparedRange(scene, paths, 2, 2, 3, 0.25, seed);
    expect(tail.snapshotHistory.map(snapshot => snapshot.time)).toEqual([2, 2.25, 2.5, 2.75, 3]);
    expect(tail).not.toHaveProperty('cameraStates');
  });

  it('retains live follow pursuit when reading the camera during playback and after pausing', async () => {
    installModelBoundary();
    const base = await cameraCrossEntryScene(true);
    const scene = { ...base, actions: base.actions.filter(action => ['enter', 'move', 'follow'].includes(action.source.statementId)) };
    await engine.loadPreparedScene(scene);
    await engine.seek(1.75, true);
    engine.play();
    engine.getMasterTimeline()!.pause();
    vi.spyOn(live2DManager, 'getPosition').mockReturnValue({ x: 0.8, y: 0.8 });
    cameraController.tickFollow(false, 1 / 60);
    const pursued = cameraController.getState();
    expect(engine.getCurrentCamera()).toEqual(pursued);
    engine.pause();
    expect(engine.getCurrentCamera()).toEqual(pursued);
    await engine.seek(1, true);
    expect(engine.getCurrentCamera()).not.toEqual(pursued);
  });

  it('holds the release position through seek and frame capture after follow stop', async () => {
    installModelBoundary();
    const { prepared } = await new SemanticScenePipeline({ resolveAsset: source => source }).processDocument({
      schemaVersion: 5, sceneId: 'released-follow',
      meta: { title: 'Released follow', resolution: [1920, 1080], fps: 60, durationSeconds: 5,
        characters: [{ id: 'hero', name: 'Hero', model: 'hero.model3.json' }] },
      statements: [
        { id: 'enter', type: 'characterPresence', time: 0,
          params: { mode: 'enter', id: 'hero', position: [0.4, 0.5], durationSeconds: 0 } },
        { id: 'walk', type: 'characterTransform', time: 0,
          params: { id: 'hero', position: [0.8, 0.5], durationSeconds: 4, ease: 'linear' } },
        { id: 'zoom', type: 'camera', time: 0,
          params: { mode: 'move', zoom: { kind: 'absolute', value: 2 }, durationSeconds: 0 } },
        { id: 'follow', type: 'camera', time: 1,
          params: { mode: 'follow', operation: 'start', target: 'hero', smoothing: 0.85 } },
        { id: 'stop', type: 'camera', time: 2,
          params: { mode: 'follow', operation: 'stop' } },
      ],
    });
    // Keep part geometry fixed relative to the proxy origin while the authored
    // character keeps moving after release. No historical trajectory is supplied.
    const point = (id: string) => {
      const proxy = engine.transformationProxies.get(id);
      return proxy ? { x: proxy.x / STAGE_WIDTH, y: proxy.y / STAGE_HEIGHT } : null;
    };
    vi.spyOn(live2DManager, 'getPoint').mockImplementation(point);
    vi.spyOn(live2DManager, 'getPosition').mockImplementation(point);
    await engine.loadPreparedScene(prepared);
    for (const time of [3, 2.25, 3.5]) {
      await engine.seek(time, true);
      expect(resolveVec2(engine.getCurrentCamera().position).x).toBeCloseTo(0.6, 8);
    }
    const rendered: number[] = [];
    const rig = captureRig(() => { rendered.push(resolveVec2(engine.getCurrentCamera().position).x); });
    try {
      await rig.run({ init: async () => {}, encodeFrame: async () => {}, finish: async () => {} }, undefined,
        { fps: 4, rangeStart: 2, rangeEnd: 4 });
      expect(rendered.length).toBeGreaterThanOrEqual(8);
      for (const x of rendered) expect(x).toBeCloseTo(0.6, 8);
    } finally { rig.root.destroy(); }
  });

  it.each(['stop', 'move'] as const)('hands the live pursuit position to a following %s without snapping', async operation => {
    installModelBoundary();
    const base = await cameraCrossEntryScene(true);
    const takeover = base.actions.find(action => action.source.statementId === 'takeover');
    if (!takeover) throw new Error('Missing takeover fixture');
    const release = operation === 'move' ? takeover : { ...takeover, action: 'cameraUnfollow' as const, params: {} };
    const scene = { ...base, actions: [
      ...base.actions.filter(action => ['enter', 'move', 'follow'].includes(action.source.statementId)),
      release,
    ] };
    await engine.loadPreparedScene(scene);
    await engine.seek(3.2, true);
    engine.play();
    const master = engine.getMasterTimeline()!;
    master.pause();
    vi.spyOn(live2DManager, 'getPosition').mockReturnValue({ x: 0.8, y: 0.8 });
    cameraController.tickFollow(false, 1 / 60);
    const pursued = cameraController.getState();
    master.seek(3.25, false);
    expect(engine.getCurrentCamera()).toEqual(pursued);
    master.seek(3.5, false);
    const position = resolveVec2(pursued.position);
    const expectedPosition = operation !== 'move' ? pursued.position : {
      x: (position.x + 0.3) / 2,
      y: (position.y + 0.6) / 2,
    };
    expect(engine.getCurrentCamera()).toMatchObject({ position: expectedPosition });
  });

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

  it('keeps the mid-action landing and removes temporary camera writers through the production camera adapter', async () => {
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
      { setExportMode: () => {}, waitForAllLoaded: async () => {}, updateAll: async () => {} }, new CameraAdapter());
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

  it('bakes only Live2D snapshots without preparing or returning camera history', async () => {
    installModelBoundary(() => {}, () => { throw new Error('Snapshot Bake must not query camera anchors'); });
    const result = await bake.bakePreparedRange(await cameraCrossEntryScene(true), new Map(), 99, 1, 2, 0.125);
    expect(result.snapshotHistory.length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty('anchorTrajectories');
    expect(result).not.toHaveProperty('anchorRevision');
    expect(result).not.toHaveProperty('cameraStates');
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
});
