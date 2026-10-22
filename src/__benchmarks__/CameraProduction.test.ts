/** @vitest-environment node */
/** Opt-in real-Core benchmark. See docs/camera-production-benchmark.md. */
import { referencePreparedFollow } from './cameraProductionReference';
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Container, type Application } from 'pixi.js';
import gsap from 'gsap';
import { resolveCubismWebCorePath } from '../__tests__/helpers/live2dRuntimeFixture';
import { CubismPixiLive2DAdapter } from '../engine/runtime/CubismPixiLive2DAdapter';
import * as adapters from '../engine/Live2DRuntimeAdapter';
import * as runtimeResolver from '../engine/Live2DRuntimeResolver';
import { installCubismPixiModelRuntime } from '../engine/CubismPixiModel';
import type { Live2DModelDisplayObject } from '../engine/runtime/Live2DRuntimeContracts';
import { SemanticScenePipeline } from '../services/semantic-scene/SemanticScenePipeline';
import type { CurrentSceneDocument } from '../api/types/semantic-scene';
import { BakeEngine, type BakeResult } from '../engine/BakeEngine';
import ScriptEngine from '../engine/ScriptEngine';
import { stageManager } from '../engine/StageManager';
import { subtitleRenderer } from '../engine/SubtitleRenderer';
import { textLayerManager } from '../engine/TextLayerManager';
import { preBakeDaemon } from '../engine/daemons/PreBakeDaemon';
import { FrameCaptureEngine } from '../engine/export/FrameCaptureEngine';
import { cameraController } from '../engine/CameraController';
import { evaluateCameraChannels, sampleCameraAnchorTrajectory } from '../engine/CameraChannelEvaluator';
import { getCameraFollowHistoryDiagnostics } from '../engine/CameraFollowHistory';
import { preparedSceneToRuntimeTimelineScene } from '../engine/PreparedRuntimeScene';

vi.hoisted(() => {
  vi.stubGlobal('document', { body: { classList: { add: () => {}, remove: () => {} } }, documentElement: { setAttribute: () => {}, removeAttribute: () => {}, style: { setProperty: () => {} } }, createElement: () => ({ getContext: () => null, style: {} }) });
});

vi.mock('../engine/Live2DRuntimeAdapter', async original => ({
  ...await original<typeof import('../engine/Live2DRuntimeAdapter')>(), getLive2DRuntimeAdapter: vi.fn(),
}));

// Compare the actual prior production algorithm, never a synthetic prototype.
// The generated copy is workspace-only; the pinned Git object is its source.
vi.mock('../engine/CameraFollowHistory', async original => {
  if (process.env.AEON_CAMERA_BENCHMARK_POLICY !== 'baseline') return original();
  const { execFileSync } = await import('node:child_process');
  const filesystem = await import('node:fs');
  const paths = await import('node:path');
  const { pathToFileURL: fileUrl } = await import('node:url');
  const directory = paths.resolve('.superpowers/sdd/camera-production-baseline-runtime');
  filesystem.mkdirSync(directory, { recursive: true });
  const file = paths.join(directory, 'CameraFollowHistory.ts');
  const source = execFileSync('git', ['show', 'acfee6cbc5b87fe2d18dcebd401f786d9199dd20:src/engine/CameraFollowHistory.ts'], { encoding: 'utf8' })
    .replace("from './CameraStateResolver'", "from '../../../src/engine/CameraStateResolver'");
  // Diagnostics do not alter the algorithm or cache contents.
  filesystem.writeFileSync(file, source + `
export function getCameraFollowHistoryDiagnostics(trajectory: CameraAnchorTrajectory) {
  const contexts = followCheckpointCache.get(trajectory);
  return { anchorQueries: 0, indexedPoints: 0, contexts: contexts?.size ?? 0,
    checkpoints: [...contexts?.values() ?? []].reduce((sum, frames) => sum + frames.size, 0) };
}
`);
  return await import(fileUrl(file).href) as typeof import('../engine/CameraFollowHistory');
});

const enabled = process.env.AEON_CAMERA_BENCHMARK === '1';
// Imports need a canvas boundary even when skipped. Restore it immediately
// in normal suites; skipped tests do not execute afterEach cleanup.
if (!enabled) vi.unstubAllGlobals();
const duration = 600;
const runtime = { runtimeFamily: 'cubism3-plus', adapterId: 'untitled-pixi-live2d-engine-cubism', supported: true } as const;
const bytes = (file: string): ArrayBuffer => new Uint8Array(fs.readFileSync(file)).buffer;
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const timed = async <T,>(run: () => T | Promise<T>) => {
  const start = performance.now(); const value = await run(); return { value, ms: performance.now() - start };
};

afterEach(() => { gsap.globalTimeline.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.skipIf(!enabled)('measures real prepared history across ten-minute playback, seek, Bake and capture', async () => {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node >=24 is required.');
  const output = process.env.AEON_CAMERA_BENCHMARK_OUTPUT ?? '.superpowers/sdd/camera-production-current.json';
  const progress: Record<string, unknown> = {};
  const persist = (stage: string, data: unknown) => { progress[stage] = data; fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output + '.progress.json', JSON.stringify(progress, null, 2) + '\n'); };
  const entry = process.env.AEON_CUBISM_TEST_MODEL;
  const core = resolveCubismWebCorePath();
  if (!entry || !core) throw new Error('Real model and Core fixtures are required.');
  const source: { FileReferences: { Moc: string; Physics?: string; Motions: Record<string, { File: string; Sound?: string }[]>; Expressions: unknown[] }; url?: string } = JSON.parse(fs.readFileSync(entry, 'utf8'));
  const motion = process.env.AEON_CUBISM_TEST_MOTION ?? Object.keys(source.FileReferences.Motions)[0];
  const motionFile = path.resolve(path.dirname(entry), source.FileReferences.Motions[motion][0].File);
  const motionData: { Meta: { Duration: number; Fps: number; Loop: boolean } } = JSON.parse(fs.readFileSync(motionFile, 'utf8'));
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('self', globalThis);
  vi.stubGlobal('WebGLBuffer', class {});
  fs.writeSync(1, 'CAMERA_BENCHMARK stage=core-load\n');
  vm.runInThisContext(fs.readFileSync(core, 'utf8'), { filename: 'live2dcubismcore.min.js' });
  Object.assign(window, { Live2DCubismCore: (globalThis as typeof globalThis & { Live2DCubismCore?: unknown }).Live2DCubismCore });
  fs.writeSync(1, 'CAMERA_BENCHMARK stage=sdk-load\n');
  const sdk = await import('untitled-pixi-live2d-engine/cubism');
  fs.writeSync(1, 'CAMERA_BENCHMARK stage=sdk-ready\n');
  await sdk.cubismReady();
  let modelCount = 0;
  let coreFrames = 0;
  let recordDense: { start: number; end: number } | null = null;
  const densePoses: { time: number; position: { x: number; y: number } }[] = [];
  const adapter = new CubismPixiLive2DAdapter();
  vi.spyOn(adapter, 'createModel').mockImplementation(async () => {
    const json = structuredClone(source);
    json.FileReferences.Motions = { [motion]: json.FileReferences.Motions[motion] };
    json.FileReferences.Expressions = [];
    json.url = pathToFileURL(entry).href;
    for (const definition of json.FileReferences.Motions[motion]) delete definition.Sound;
    const factory = sdk.Live2DFactory.runtimes[0];
    const settings = factory.createModelSettings(json);
    const native = factory.createCoreModel(bytes(path.resolve(path.dirname(entry), json.FileReferences.Moc)));
    const internal = factory.createInternalModel(native, settings, { motionPreload: sdk.MotionPreloadStrategy.NONE, eyeBlink: false });
    const model = new sdk.Live2DModel({ autoUpdate: false, autoFocus: false });
    model.internalModel = internal;
    // Real Core geometry and production motion stages; this benchmark has no GPU/texture context.
    Object.assign(model, { renderForBake: () => {} });
    installCubismPixiModelRuntime(model);
    const geometry = model as unknown as {
      setSceneTime: (time: number, delta?: number) => void;
      renderForBake: (renderer: unknown, target?: unknown) => void;
      updateDrawableBounds: () => void;
    };
    expect(typeof geometry.updateDrawableBounds).toBe('function');
    const initialHeight = model.getLocalBounds().height;
    const setTime = geometry.setSceneTime.bind(model);
    const render = geometry.renderForBake.bind(model);
    let sceneTime = 0;
    geometry.setSceneTime = (time, delta) => { sceneTime = time; setTime(time, delta); };
    geometry.renderForBake = (renderer, target) => {
      render(renderer, target);
      if (!recordDense || sceneTime < recordDense.start || sceneTime > recordDense.end) return;
      geometry.updateDrawableBounds();
      const bounds = model.getLocalBounds();
      // Independent direct posed-bounds formula in composition units. No
      // production anchor helper, prepared sampler or camera evaluator oracle.
      const progress = Math.max(0, Math.min(1, (sceneTime - 10) / 0.08));
      densePoses.push({ time: sceneTime, position: {
        x: 0.65 - 0.3 * progress + (bounds.x + bounds.width / 2 - model.pivot.x) / initialHeight * 1080 / 1920,
        y: 0.7 - 0.2 * progress + (bounds.y + bounds.height / 2 - model.pivot.y) / initialHeight,
      } });
    };
    const update = model.update.bind(model);
    model.update = delta => { coreFrames++; update(delta); };
    modelCount++;
    return model as unknown as Live2DModelDisplayObject;
  });
  vi.spyOn(adapters, 'getLive2DRuntimeAdapter').mockReturnValue(adapter);
  vi.spyOn(runtimeResolver, 'resolveLive2DRuntimeDescriptor').mockReturnValue(runtime);
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    const value = String(url); const file = value.startsWith('asset://')
      ? decodeURIComponent(new URL(value).pathname) : value.startsWith('file:') ? fileURLToPath(value) : path.resolve(value);
    const data = fs.readFileSync(file);
    return { ok: true, json: async () => JSON.parse(data.toString()), arrayBuffer: async () => new Uint8Array(data).buffer };
  }));
  vi.spyOn(subtitleRenderer, 'preloadPreparedScene').mockResolvedValue(undefined);
  vi.spyOn(subtitleRenderer, 'clear').mockImplementation(() => {});
  vi.spyOn(textLayerManager, 'clearAll').mockImplementation(() => {});
  vi.spyOn(preBakeDaemon, 'attach').mockImplementation(() => {});
  vi.spyOn(preBakeDaemon, 'triggerColdScan').mockImplementation(() => {});
  vi.spyOn(stageManager, 'updateImages').mockImplementation(() => {});
  const root = new Container();
  let rendered = 0;
  let captureStarted = false;
  let lastRenderedCamera: ReturnType<typeof cameraController.getState> | undefined;
  const app = { stage: root, canvas: document.createElement('canvas'), ticker: { add: () => {}, remove: () => {} }, renderer: {
    width: 1920, height: 1080, resolution: 1, screen: { width: 1920, height: 1080 }, background: { color: 0, alpha: 1 },
    resize: () => {}, resetState: () => {}, render: () => { rendered++; if (captureStarted) lastRenderedCamera = cameraController.getState(); },
  } } as unknown as Application;
  vi.spyOn(stageManager, 'getApp').mockReturnValue(app);
  vi.spyOn(stageManager, 'getLayer').mockReturnValue(root);
  const statements: CurrentSceneDocument['statements'] = [
    { id: 'enter', type: 'characterPresence', time: 0, params: { mode: 'enter', id: 'hero', position: [0.65, 0.7], durationSeconds: 0 } },
    { id: 'motion', type: 'characterPerformance', time: 0, params: { target: 'hero', motion: { kind: 'resource', key: motion, durationSeconds: duration } } },
    { id: 'zoom', type: 'camera', time: 0, params: { mode: 'move', zoom: { kind: 'absolute', value: 2 }, durationSeconds: 0 } },
    { id: 'follow', type: 'camera', time: 0, params: { mode: 'follow', operation: 'start', target: 'hero', smoothing: 0.9 } },
    { id: 'walk', type: 'characterTransform', time: 10, params: { id: 'hero', position: [0.35, 0.5], durationSeconds: 0.08, ease: 'linear' } },
    { id: 'leave', type: 'characterPresence', time: 300, params: { mode: 'exit', id: 'hero', durationSeconds: 0 } },
    { id: 'end', type: 'camera', time: duration, params: { mode: 'move', zoom: { kind: 'absolute', value: 2 }, durationSeconds: 0 } },
    { id: 'return', type: 'characterPresence', time: 302, params: { mode: 'enter', id: 'hero', position: [0.75, 0.7], durationSeconds: 0 } },
  ];
  const scene = (await new SemanticScenePipeline({ resolveAsset: source => source }).processDocument({
    schemaVersion: 5, sceneId: 'camera-production', meta: { title: 'Real camera production benchmark', resolution: [1920, 1080], fps: 60,
      durationSeconds: duration, characters: [{ id: 'hero', name: 'Real fixture', model: pathToFileURL(entry).href }] }, statements,
  })).prepared;
  const bake = new BakeEngine(app);
  let prepared: BakeResult | undefined;
  let preparationMs = 0;
  const engine = new ScriptEngine(() => ({ prepareCameraAnchorsPrepared: async (value, paths, token, options) => {
    const measured = await timed(() => bake.prepareCameraAnchorsPrepared(value, paths, token, options));
    prepared = measured.value; preparationMs = measured.ms;
    return measured.value;
  }, cancel: () => bake.cancel(), destroy: () => {} }));
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  gc?.(); const heapBefore = process.memoryUsage();
  fs.writeSync(1, 'CAMERA_BENCHMARK stage=prepare\n');
  try {
    const load = await timed(() => engine.loadPreparedScene(scene));
    persist('preparation', { preparationMs, loadMs: load.ms, coreFrames, modelCount });
    const tracks = prepared!.anchorTrajectories!;
    const head = tracks.find(track => track.part === 'center')!;
    fs.writeSync(1, `CAMERA_BENCHMARK preparedMs=${preparationMs} samples=${head.samples.length} models=${modelCount} coreFrames=${coreFrames}\n`);
    fs.writeSync(1, JSON.stringify({ sceneDuration: scene.durationSeconds, validity: head.validity, lastSample: head.samples.at(-1), actionSummary: scene.actions.map(action => ({ action: action.action, time: action.time, duration: action.params.duration })) }) + '\n');
    persist('tracks', { validity: head.validity, samples: head.samples.length, trackCount: tracks.length });
    expect(head.samples.length).toBeGreaterThan(8900);
    expect(head.validity[0].end).toBe(300);
    expect(head.validity[1].start).toBe(302);
    expect(head.validity).toHaveLength(2);
    expect(Math.hypot(head.samples[1].position.x - head.samples[0].position.x,
      head.samples[1].position.y - head.samples[0].position.y)).toBeGreaterThan(1e-8);
    // Count sample-array reads at the public evaluator seam without changing coordinates/order.
    let reads = 0;
    let baselineQueries = 0;
    const validity = new Proxy(head.validity, { get(target, property, receiver) {
      if (property === 'find') return (...args: Parameters<typeof target.find>) => { baselineQueries++; return target.find(...args); };
      return Reflect.get(target, property, receiver);
    } });
    const countedHead = { ...head, validity, samples: new Proxy(head.samples, { get(target, property, receiver) {
      if (property === 'filter') return (...args: Parameters<typeof target.filter>) => { reads += target.length; return target.filter(...args); };
      if (typeof property === 'string' && /^\d+$/.test(property)) reads++; return Reflect.get(target, property, receiver);
    } }) };
    const timeline = preparedSceneToRuntimeTimelineScene(scene).timeline;
    const evaluation = { timeline, logicalReferenceSize: { width: 1920, height: 1080 },
      anchorTrajectories: [countedHead], trajectoryRevision: prepared!.anchorRevision };
    fs.writeSync(1, 'CAMERA_BENCHMARK stage=cold-query\n');
    gc?.(); const derivedHeapBefore = process.memoryUsage().heapUsed;
    const coreFramesBeforeQueries = coreFrames;
    const first = await timed(() => evaluateCameraChannels({ ...evaluation, sceneTime: 599.12345 }));
    gc?.(); const derivedHeapAfter = process.memoryUsage().heapUsed;
    const coldReads = reads; const coldBaselineQueries = baselineQueries; baselineQueries = 0; const coldDiagnostics = getCameraFollowHistoryDiagnostics(countedHead); reads = 0;
    const warm = await timed(() => { for (let index = 0; index < 100; index++) evaluateCameraChannels({ ...evaluation, sceneTime: 599.12345 }); });
    const warmReads = reads; const warmBaselineQueries = baselineQueries; const warmDiagnostics = getCameraFollowHistoryDiagnostics(countedHead);
    expect(coreFrames).toBe(coreFramesBeforeQueries);
    const firstSeek = await timed(() => engine.seek(599.12345));
    const warmSeek = await timed(async () => { for (let index = 0; index < 20; index++) await engine.seek(599.12345); });
    persist('queries', { firstMs: first.ms, coldReads, coldDiagnostics, coldBaselineQueries, warmBaselineQueries, warm100Ms: warm.ms, warmReads, warmDiagnostics, firstSeekMs: firstSeek.ms, warm20SeeksMs: warmSeek.ms, gc: !!gc, derivedHeapBefore, derivedHeapAfter, derivedHeapDelta: derivedHeapAfter - derivedHeapBefore });
    const checkTimes = [0, 0.012345, 10.01234, 299.99999, 300, 301, 302, 302.00001, 598.12345, 599.12345];
    const expected = checkTimes.map(sceneTime => evaluateCameraChannels({ ...evaluation, sceneTime }));
    const historyIntegrationErrors = checkTimes.map((time, index) => {
      const reference = referencePreparedFollow(head, time);
      const actual = expected[index].position;
      return { time, compositionUnits: Math.hypot((actual.x - reference.x) * 1920, (actual.y - reference.y) * 1080) };
    });
    expect(Math.max(...historyIntegrationErrors.map(sample => sample.compositionUnits))).toBeLessThan(0.5);
    for (const fps of [24, 30, 60, 120]) {
      for (let frame = 0; frame <= fps; frame++) evaluateCameraChannels({ ...evaluation, sceneTime: 598 + frame / fps });
      for (let index = checkTimes.length - 1; index >= 0; index--) expect(evaluateCameraChannels({ ...evaluation, sceneTime: checkTimes[index] })).toEqual(expected[index]);
    }
    const coldTrack = { ...head, samples: [...head.samples] };
    expect(evaluateCameraChannels({ ...evaluation, anchorTrajectories: [coldTrack], sceneTime: 599.12345 })).toEqual(first.value);
    fs.writeSync(1, 'CAMERA_BENCHMARK stage=dense-reference\n');
    recordDense = { start: 0, end: 5 };
    const dense = await timed(() => bake.bakePreparedRange(scene, new Map(), 99, 0, 5, 1 / 240, undefined, true, {
      scene, logicalReferenceSize: { width: 1920, height: 1080 }, anchorTrajectories: tracks, anchorRevision: prepared!.anchorRevision!,
    }));
    recordDense = { start: 9.95, end: 10.15 };
    const fastDense = await timed(() => bake.bakePreparedRange(scene, new Map(), 98, 9.95, 10.15, 1 / 240, undefined, true, {
      scene, logicalReferenceSize: { width: 1920, height: 1080 }, anchorTrajectories: tracks, anchorRevision: prepared!.anchorRevision!,
    }));
    recordDense = null;
    const trajectoryErrors = densePoses.filter(sample => sample.time > 0).map(sample => {
      const approximate = sampleCameraAnchorTrajectory(head, sample.time)!;
      return Math.hypot((approximate.x - sample.position.x) * 1920, (approximate.y - sample.position.y) * 1080);
    });
    expect(trajectoryErrors.length).toBeGreaterThan(1000);
    expect(Math.max(...trajectoryErrors)).toBeLessThan(1);
    const approximation = { cadenceHz: 15, referenceHz: 240, referenceWindows: [[0, 5], [9.95, 10.15]], samples: trajectoryErrors.length,
      maxCompositionPixels: Math.max(...trajectoryErrors), rmsCompositionPixels: Math.sqrt(trajectoryErrors.reduce((sum, error) => sum + error * error, 0) / trajectoryErrors.length), denseBakeMs: dense.ms, fastDenseBakeMs: fastDense.ms };
    persist('approximation', approximation);
    fs.writeSync(1, 'CAMERA_BENCHMARK stage=bake\n');
    const baked = await timed(() => bake.bakePreparedRange(scene, new Map(), 100, 598, 600, 1 / 24, undefined, true, {
      scene, logicalReferenceSize: { width: 1920, height: 1080 }, anchorTrajectories: tracks, anchorRevision: prepared!.anchorRevision!,
    }));
    for (const sample of baked.value.cameraStates ?? []) {
      await engine.seek(sample.time); expect(engine.getCameraEvaluation()).toEqual(sample.state);
      engine.getMasterTimeline()!.seek(sample.time, false); expect(engine.getCameraEvaluation()).toEqual(sample.state);
    }
    persist('bake', { ms: baked.ms, samples: baked.value.cameraStates?.length });
    fs.writeSync(1, 'CAMERA_BENCHMARK stage=capture\n');
    let encoded = 0;
    const capture = new FrameCaptureEngine({ getApp: () => app, getWidth: () => 1920, getHeight: () => 1080, pauseTicker: () => {}, resumeTicker: () => {} }, engine,
      { reset: () => {}, syncEffects: () => {} }, { setExportMode: () => {}, waitForAllLoaded: async () => {}, updateAll: async () => {} }, cameraController);
    const renderedBeforeCapture = rendered;
    const exportTiming = await timed(() => capture.capture({ fps: 24, rangeStart: 598, rangeEnd: 600, width: 1920, height: 1080,
      bitrateBps: 1, outputPath: '/tmp/camera-production.mp4', codec: 'h264', backend: { init: async () => { captureStarted = true; }, encodeFrame: async () => {
        const evaluated = engine.getCameraEvaluation();
        expect(evaluated).toBeDefined(); expect(lastRenderedCamera).toBeDefined();
        expect(lastRenderedCamera!.position).toEqual(evaluated!.position);
        expect(lastRenderedCamera!.zoom).toBe(evaluated!.zoom);
        expect(lastRenderedCamera!.rotation).toBe(evaluated!.rotation);
        encoded++;
      }, finish: async () => {} }, onProgress: () => {} }));
    gc?.(); const heapAfter = process.memoryUsage();
    const prefixWriterProbe = [];
    for (const count of [64, 128, 256]) {
      const writers = Array.from({ length: count }, (_, index) => ({ _id: `zoom-${index}`, action: 'cameraMotion' as const,
        time: index / count, params: { zoom: 2 + index / count, duration: 0, _cameraProperties: ['zoom'] } }));
      const sample = await timed(() => {
        for (let repeat = 0; repeat < 3; repeat++) evaluateCameraChannels({ timeline: writers, sceneTime: 1,
          logicalReferenceSize: { width: 1920, height: 1080 }, anchorTrajectories: [] });
      });
      prefixWriterProbe.push({ writers: count, threeEvaluationsMs: sample.ms });
    }
    const result = { policy: process.env.AEON_CAMERA_BENCHMARK_POLICY ?? 'production', environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, gc: !!gc },
      input: { fixture: { prunedMotionCatalog: true, physics: false, textures: false, autoEyeBlink: false }, duration, characterCount: 1, motion, motionMeta: motionData.Meta, modelSha256: digest(entry), motionSha256: digest(motionFile),
        modelCount, coreFrames, trackCount: tracks.length, samples: tracks.reduce((sum, track) => sum + track.samples.length, 0), events: head.events.length,
        validity: head.validity, retainedTrajectoryJsonBytes: Buffer.byteLength(JSON.stringify(tracks)) },
      timingsMs: { loadIncludingPreparation: load.ms, preparation: preparationMs, firstColdEvaluation: first.ms, warm100Evaluations: warm.ms,
        firstSeekAfterPreparation: firstSeek.ms, warm20Seeks: warmSeek.ms, bake49Samples: baked.ms, capture48Frames: exportTiming.ms },
      observations: checkTimes.map((time, index) => ({ time, state: expected[index] })), historyIntegrationErrors, prefixWriterProbe, approximation, diagnostics: { cold: coldDiagnostics, warm100: warmDiagnostics, coldBaselineQueries, warmBaselineQueries }, sampleArrayReads: { cold: coldReads, warm100: warmReads }, memory: { derivedHeapBefore, derivedHeapAfter, derivedHeapDelta: derivedHeapAfter - derivedHeapBefore, heapBefore, heapAfter, heapUsedDelta: heapAfter.heapUsed - heapBefore.heapUsed },
      capture: { encoded, rendered: rendered - renderedBeforeCapture, allPipelineRenders: rendered, schedulingFramesPerSecond: encoded / (exportTiming.ms / 1000), gpu: false, imageEncoding: false, videoEncoding: false },
      deterministicParity: 'repeated/reverse/subframe/cold/warm/24/30/60/120 fps passed',
      anchorProbe: [0, 1, 100, 299, 302, 599].map(time => ({ time, position: sampleCameraAnchorTrajectory(head, time) })) };
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    fs.writeSync(1, 'CAMERA_BENCHMARK_RESULT ' + JSON.stringify(result) + '\n');
  } finally { engine.destroy(); bake.destroy(); root.destroy({ children: true }); }
}, 43_200_000);
