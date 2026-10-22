/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';
import { Container, ObservablePoint, type Application } from 'pixi.js';
import ScriptEngine from '../engine/ScriptEngine';
import { BakeEngine } from '../engine/BakeEngine';
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
import type { CameraEvaluationOutput } from '../engine/CameraChannelEvaluator';

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
  function installModelBoundary(onFrame: () => void = () => {}, onHead: () => void = () => {}) {
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
      createModel: async () => Object.assign(new Container(), {
        anchor: new ObservablePoint({ _onUpdate: () => {} }, 0, 0),
        getLocalBounds: () => ({ x: 0, y: 0, width: 100, height: 200 }),
      }),
      createTestControls: () => mockControls({ captureSnapshot: () => snapshot, captureIdleSnapshot: () => snapshot,
        getHeadAnchor: () => { onHead(); return { x: 0.5, y: 0.2 }; },
        stepBakeFrame: onFrame,
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
    return { root, run, resizes };
  }
  afterEach(() => { engine.destroy(); bake.destroy(); gsap.globalTimeline.clear(); setStageDimensions(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('publishes the same final camera as formal playback and seek at Bake subframes', async () => {
    const scene = await cameraCrossEntryScene();
    await engine.loadPreparedScene(scene);
    const result = await bake.bakePreparedRange(scene, new Map(), 1, 0.875, 1.125, 0.125);
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
    engine = new ScriptEngine(() => new BakeEngine({ renderer: {} } as Application));
    const scene = await cameraCrossEntryScene(true);
    await engine.loadPreparedScene(scene);
    const result = await bake.bakePreparedRange(scene, new Map(), 3, 0, 7, 0.125);
    expect(result.cameraStates).toHaveLength(57);
    expect(result.anchorTrajectories?.find(track => track.part === 'head')?.validity).toHaveLength(2);
    for (const sample of result.cameraStates ?? []) {
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
    const result = await bake.prepareCameraAnchorsPrepared(scene, new Map(), 101, { includeCameraStates: false });
    expect(result.anchorTrajectories?.find(track => track.part === 'center')?.validity).toHaveLength(2);
    expect(result.cameraStates).toBeUndefined();
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
    const result = await bake.prepareCameraAnchorsPrepared(scene, new Map(), 102, { includeCameraStates: false });
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
    const result = await bake.prepareCameraAnchorsPrepared(scene, new Map(), 100, { includeCameraStates: false });
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
        return bake.prepareCameraAnchorsPrepared(scene, paths, token);
      }, cancel: () => bake.cancel(), destroy: () => {},
    }));
    const loading = engine.loadPreparedScene(await cameraCrossEntryScene(true));
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
        return bake.prepareCameraAnchorsPrepared(scene, paths, token);
      }, cancel: () => bake.cancel(), destroy: () => {},
    }));
    const loading = engine.loadPreparedScene(await cameraCrossEntryScene(true));
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

  it('discards a cancelled actual Bake preparation and recovers without publishing its camera bundle', async () => {
    let cancelNext = true;
    installModelBoundary(() => { if (cancelNext) { cancelNext = false; bake.cancel(); } });
    const scene = await cameraCrossEntryScene(true);
    const cancelled = await bake.bakePreparedRange(scene, new Map(), 8, 1, 2, 0.125);
    expect(cancelled).toEqual({ snapshotHistory: [] });
    const recovered = await bake.bakePreparedRange(scene, new Map(), 9, 1, 2, 0.125);
    expect(recovered.cameraStates).toHaveLength(9);
    expect(recovered.anchorTrajectories?.length).toBeGreaterThan(0);
  });

  it('reuses the current immutable camera bundle for seeded range Bake without preparing character anchors again', async () => {
    let allowPreparation = true;
    installModelBoundary(() => {}, () => { if (!allowPreparation) throw new Error('Unexpected repeated anchor preparation'); });
    const scene = await cameraCrossEntryScene(true);
    const prepared = await bake.prepareCameraAnchorsPrepared(scene, new Map(), 10);
    allowPreparation = false;
    const result = await bake.bakePreparedRange(scene, new Map(), 11, 2.125, 2.25, 0.125, undefined, true, {
      scene, logicalReferenceSize: { width: STAGE_WIDTH, height: STAGE_HEIGHT },
      anchorRevision: prepared.anchorRevision!, anchorTrajectories: prepared.anchorTrajectories!,
    });
    expect(result.cameraStates?.map(sample => sample.time)).toEqual([2.125, 2.25]);
    expect(result.anchorRevision).toBe(prepared.anchorRevision);
  });

  it('hands the immutable bundle through the actual background daemon into actual Bake snapshots', async () => {
    let allowPreparation = true;
    installModelBoundary(() => {}, () => { if (!allowPreparation) throw new Error('Daemon repeated anchor preparation'); });
    const scene = await cameraCrossEntryScene(true);
    const prepared = await bake.prepareCameraAnchorsPrepared(scene, new Map(), 15);
    allowPreparation = false;
    const daemon = new PreBakeDaemon();
    const store = new SnapshotStore();
    try {
      daemon.attach(store, scene, Object.freeze({ scene,
        logicalReferenceSize: { width: STAGE_WIDTH, height: STAGE_HEIGHT },
        anchorRevision: prepared.anchorRevision!, anchorTrajectories: prepared.anchorTrajectories!,
      }));
      daemon.triggerColdScan();
      await vi.waitFor(() => expect(store.size).toBeGreaterThan(0), { timeout: 4000, interval: 10 });
      expect(store.findBefore(6)?.models.has('hero')).toBe(true);
    } finally { daemon.dispose(); }
  });

  it.each(['scene', 'reference', 'content', 'mid-frame'] as const)('discards stale %s history supplied to actual range Bake', async mode => {
    let valid = true;
    let invalidateOnFrame = false;
    installModelBoundary(() => { if (invalidateOnFrame) valid = false; });
    const scene = await cameraCrossEntryScene(true);
    const prepared = await bake.prepareCameraAnchorsPrepared(scene, new Map(), 12);
    invalidateOnFrame = mode === 'mid-frame';
    const result = await bake.bakePreparedRange(scene, new Map(), 13, 2.125, 2.25, 0.125, undefined, true, {
      scene: mode === 'scene' ? { ...scene } : scene,
      logicalReferenceSize: { width: STAGE_WIDTH + (mode === 'reference' ? 1 : 0), height: STAGE_HEIGHT },
      anchorRevision: prepared.anchorRevision!, anchorTrajectories: prepared.anchorTrajectories!,
      isCurrent: () => mode !== 'content' && valid,
    });
    expect(result).toEqual({ snapshotHistory: [] });
  });

  it('drops a trajectory batch whose reference size changes during isolated model preparation', async () => {
    let changed = false;
    installModelBoundary(() => { if (!changed) { changed = true; setStageDimensions({ width: 1080, height: 1920, fps: 60 }); } });
    const result = await bake.bakePreparedRange(await cameraCrossEntryScene(true), new Map(), 14, 1, 2, 0.125);
    expect(result).toEqual({ snapshotHistory: [] });
  });

  it.each([{ width: 1920, height: 1080 }, { width: 1080, height: 1920 }, { width: 1080, height: 1080 }])(
    'preserves projected character orientation, UI and authoring-unit shake at $width x $height and double output pixels', async format => {
      setStageDimensions({ ...format, fps: 60 });
      installModelBoundary(); engine.destroy();
      engine = new ScriptEngine(() => new BakeEngine({ renderer: {} } as Application));
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

  it('keeps camera evaluation reads free of camera events and character pose updates after fps sampling', async () => {
    installModelBoundary(); engine.destroy();
    engine = new ScriptEngine(() => new BakeEngine({ renderer: {} } as Application));
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
    engine = new ScriptEngine(() => new BakeEngine({ renderer: {} } as Application));
    const scene = await cameraCrossEntryScene(true);
    await engine.loadPreparedScene(scene);
    const commonTimes = [0.125, 0.5, 0.75, 1.125, 1.25, 1.5, 1.75, 2, 2.375, 2.75, 3.25, 4, 4.125, 4.75, 5.625];
    const common: CameraState[] = [];
    for (const time of commonTimes) { await engine.seek(time); common.push(engine.getCurrentCamera()); }
    for (const fps of [24, 30, 60, 120]) {
      const start = 0.125;
      const end = 7;
      const baked = await bake.bakePreparedRange(scene, new Map(), fps, start, end, 1 / fps);
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
