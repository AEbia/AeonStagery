import type { PreparedCameraAnchorTrajectory } from '../engine/CameraAnchorPreparation';
import type { Vec2 } from '../api/types/common';
import { Assets } from 'pixi.js';
import { cameraController } from '../engine/CameraController';
import { stageManager } from '../engine/StageManager';
import ScriptEngine from '../engine/ScriptEngine';
import { live2DManager } from '../engine/Live2DManager';
import { lightingSystem } from '../engine/LightingSystem';
import { preBakeDaemon } from '../engine/daemons/PreBakeDaemon';
import { FrameCaptureEngine } from '../engine/export/FrameCaptureEngine';
import { RawPixelsBackend } from '../engine/export/RawPixelsBackend';
import type { BackendFrame } from '../engine/export/ICaptureBackend';
import { evaluateCameraChannels } from '../engine/CameraChannelEvaluator';
import type { ExportOperationResult, FFmpegStreamOptions } from '../api/types/export';
import type { PreparedCompiledScene } from '../api/types/semantic-scene';
import { preparedSceneToRuntimeTimelineScene } from '../engine/PreparedRuntimeScene';

interface ExpectedCameraFrame {
  time: number;
  position: { x: number; y: number };
  zoom: number;
  rotation: number;
}

export interface CameraProductionBrowserInput {
  scene: PreparedCompiledScene;
  anchorRevision: string | number;
  anchorTrajectories: readonly PreparedCameraAnchorTrajectory[];
  modelUrl: string;
  websocketUrl: string;
  outputPath: string;
  fps: number;
  rangeStart: number;
  rangeEnd: number;
  width: number;
  height: number;
  expectedFrames: ExpectedCameraFrame[];
}

export interface CameraProductionBrowserResult {
  playback: {
    sceneStartTime: number;
    requestedSceneEndTime: number;
    actualSceneEndTime: number;
    elapsedMs: number;
    updateCount: number;
    maxSameTimeCompositionUnits: number;
    maxSameTimeZoom: number;
    maxSameTimeRotation: number;
    seekParityCompositionUnits: number;
    seekParityZoom: number;
    seekParityRotation: number;
  };
  backend: 'RawPixelsBackend';
  renderer: 'Pixi WebGL';
  frameCount: number;
  fps: number;
  width: number;
  height: number;
  elapsedMs: number;
  encodedFramesPerSecond: number;
  renderedFrameCount: number;
  uniqueRenderedFrameHashes: number;
  maxCameraParityCompositionUnits: number;
  maxCameraParityZoom: number;
  maxCameraParityRotation: number;
  encodedSizeBytes: number | null;
  firstFrameNonzeroPixelCount: number;
  firstFramePixelsDistinctFromCorner: number;
  modelState: {
    characterPresent: boolean;
    characterPresentBeforeCapture: boolean;
    snapshotAvailable: boolean;
    uniqueParameterSnapshots: number;
    parameterCount: number;
    modelReferenceKind: string;
    modelReferenceUsesFixtureRoute: boolean;
    visibleModelBounds: {
      first: { x: number; y: number; width: number; height: number };
      last: { x: number; y: number; width: number; height: number };
    } | null;
    visibleModelBoundsIntersectStage: boolean;
  };
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface ExportBridge {
  startStreamExport(outputPath: string, options: FFmpegStreamOptions): Promise<ExportOperationResult>;
  pushFrame(frameData: Uint8Array | Uint8ClampedArray): Promise<{ success: boolean; error?: string }>;
  endStreamExport(): Promise<ExportOperationResult>;
  cancelExport(): Promise<ExportOperationResult>;
}

declare global {
  interface Window {
    runCameraProductionExport: (input: CameraProductionBrowserInput) => Promise<CameraProductionBrowserResult>;
  }
}

function replaceFileUrls(value: unknown, modelUrl: string): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (typeof value[index] === 'string' && value[index].startsWith('file://')) value[index] = modelUrl;
      else replaceFileUrls(value[index], modelUrl);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.startsWith('file://')) {
      (value as Record<string, unknown>)[key] = modelUrl;
    } else {
      replaceFileUrls(entry, modelUrl);
    }
  }
}

function createExportBridge(socket: WebSocket): ExportBridge {
  let nextId = 1;
  const pending = new Map<number, PendingRpc>();
  socket.addEventListener('message', (event: MessageEvent<string>) => {
    let message: { id?: unknown; result?: unknown; error?: unknown };
    try {
      message = JSON.parse(event.data) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const rpc = pending.get(message.id);
    if (!rpc) return;
    pending.delete(message.id);
    if (typeof message.error === 'string') rpc.reject(new Error(message.error));
    else rpc.resolve(message.result);
  });

  const request = <T,>(kind: string, payload: Record<string, unknown> = {}): Promise<T> => {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
      });
      socket.send(JSON.stringify({ id, kind, ...payload }));
    });
  };

  const pushFrame = (frameData: Uint8Array | Uint8ClampedArray): Promise<{ success: boolean; error?: string }> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve: value => resolve(value as { success: boolean; error?: string }), reject });
      socket.send(JSON.stringify({ id, kind: 'frame', byteLength: frameData.byteLength }));
      socket.send(frameData);
    });
  };

  return {
    startStreamExport: (outputPath, options) => request('start', { outputPath, options }),
    pushFrame,
    endStreamExport: () => request('finish'),
    cancelExport: () => request('cancel'),
  };
}

function framePixelHash(pixels: Uint8Array | Uint8ClampedArray): number {
  let hash = 2166136261;
  for (let index = 0; index < pixels.length; index++) {
    hash = Math.imul(hash ^ pixels[index], 16777619);
  }
  return hash >>> 0;
}

function numericArrayHash(values: ArrayLike<number>): number {
  let hash = 2166136261;
  for (let index = 0; index < values.length; index++) {
    hash = Math.imul(hash ^ Math.round(values[index] * 1_000_000), 16777619);
  }
  return hash >>> 0;
}

function asPoint(value: Vec2): { x: number; y: number } {
  return Array.isArray(value) ? { x: value[0], y: value[1] } : value;
}

window.runCameraProductionExport = async (input) => {
  const host = document.getElementById('stage');
  if (!host) throw new Error('Browser benchmark stage is missing.');

  const scene = structuredClone(input.scene);
  replaceFileUrls(scene, input.modelUrl);
  const socket = new WebSocket(input.websocketUrl);
  socket.binaryType = 'arraybuffer';
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('Local FFmpeg bridge could not be opened.')), { once: true });
  });

  const daemon = preBakeDaemon as unknown as {
    attach: (...args: unknown[]) => void;
    triggerColdScan: (...args: unknown[]) => void;
  };
  const originalAttach = daemon.attach;
  const originalColdScan = daemon.triggerColdScan;
  daemon.attach = () => {};
  daemon.triggerColdScan = () => {};
  let engine: ScriptEngine | undefined;
  let cameraParityCompositionUnits = 0;
  let cameraParityZoom = 0;
  let cameraParityRotation = 0;
  let maxCaptureClockSkewSeconds = 0;
  let cameraParityLastMismatch: {
    frameIndex: number;
    requestedTime: number;
    actualTime: number;
    lastSeek: { requestedTime: number; beforeTime: number; afterTime: number } | undefined;
    actualPosition: { x: number; y: number };
    actualZoom: number;
    actualRotation: number;
    expectedAtActualTime: ExpectedCameraFrame;
  } | undefined;
  let renderedFrameCount = 0;
  let previousRenderedPixels: Uint8Array | Uint8ClampedArray | undefined;
  let minChangedPixelCount = Number.POSITIVE_INFINITY;
  let maxChangedPixelCount = 0;
  let firstFrameNonzeroPixelCount = 0;
  let firstFramePixelsDistinctFromCorner = 0;
  let snapshotAvailable = false;
  let parameterCount = 0;
  let firstVisibleModelBounds: { x: number; y: number; width: number; height: number } | null = null;
  let lastVisibleModelBounds: { x: number; y: number; width: number; height: number } | null = null;
  let firstVisibleModelBoundsIntersectStage: boolean | undefined;
  let lastVisibleModelBoundsIntersectStage = false;
  const modelParameterHashes = new Set<number>();
  const renderedHashes = new Set<number>();
  let stageInitialized = false;

  try {
    // The Electron asset:// protocol bridge only exists in the page transport.
    // Keep Pixi's real ImageBitmap loader, but disable its worker fetch path so
    // the benchmark's restricted local asset adapter can resolve real textures.
    Assets.setPreferences({ preferWorkers: false });
    await stageManager.init(host);
    stageInitialized = true;
    lightingSystem.init();
    const appRenderer = stageManager.getApp().renderer;
    const renderer = appRenderer as { gl?: WebGLRenderingContext };
    if (!renderer.gl) throw new Error('Pixi did not initialize its production WebGL renderer.');

    engine = new ScriptEngine(() => ({
      prepareCameraAnchorsPrepared: async () => ({
        snapshotHistory: [],
        anchorRevision: input.anchorRevision,
        anchorTrajectories: input.anchorTrajectories,
      }),
      cancel: () => {},
      destroy: () => {},
    }));
    await engine.loadPreparedScene(scene);

    const evaluationTimeline = preparedSceneToRuntimeTimelineScene(scene).timeline;
    const modelAction = evaluationTimeline.find(action => action.action === 'addCharacter'
      && action.params.id === 'hero');
    const modelReference = modelAction?.params.model;
    const modelReferenceKind = typeof modelReference;
    const modelReferenceUsesFixtureRoute = typeof modelReference === 'string'
      && modelReference.includes('/__camera_fixture/');
    const playbackStartTime = 9.95;
    const playbackEndTime = 10.15;
    let maxPlaybackPositionError = 0;
    let maxPlaybackZoomError = 0;
    let maxPlaybackRotationError = 0;
    const playbackObservations: ExpectedCameraFrame[] = [];
    await engine.seek(playbackStartTime, true);
    const playbackStart = performance.now();
    const playbackTimer = await new Promise<{ elapsedMs: number; actualEndTime: number }>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        stopListening();
        engine?.pause();
        reject(new Error('Normal ScriptEngine playback did not reach its measured interval.'));
      }, 10_000);
      const stopListening = engine!.onTimeUpdate((time) => {
        if (time < playbackStartTime) return;
        const actual = engine!.getCurrentCamera();
        const expected = evaluateCameraChannels({
          timeline: evaluationTimeline,
          sceneTime: time,
          logicalReferenceSize: { width: 1920, height: 1080 },
          anchorTrajectories: input.anchorTrajectories,
          trajectoryRevision: input.anchorRevision,
        });
        const actualPosition = asPoint(actual.position);
        maxPlaybackPositionError = Math.max(maxPlaybackPositionError,
          Math.abs(actualPosition.x - expected.position.x) * 1920,
          Math.abs(actualPosition.y - expected.position.y) * 1080);
        maxPlaybackZoomError = Math.max(maxPlaybackZoomError, Math.abs(actual.zoom - expected.zoom));
        maxPlaybackRotationError = Math.max(maxPlaybackRotationError, Math.abs(actual.rotation - expected.rotation));
        playbackObservations.push({ time, position: actualPosition, zoom: actual.zoom, rotation: actual.rotation });
        if (time < playbackEndTime) return;
        window.clearTimeout(timeout);
        stopListening();
        engine!.pause();
        resolve({ elapsedMs: performance.now() - playbackStart, actualEndTime: time });
      });
      engine!.setPlaybackSpeed(1);
      engine!.play();
    });
    if (playbackObservations.length === 0) throw new Error('Normal playback produced no timeline updates.');
    const playbackEnd = playbackObservations[playbackObservations.length - 1];
    await engine.seek(playbackEnd.time, true);
    const seekCamera = engine.getCurrentCamera();
    const seekPosition = asPoint(seekCamera.position);
    const seekParityPositionError = Math.max(
      Math.abs(seekPosition.x - playbackEnd.position.x) * 1920,
      Math.abs(seekPosition.y - playbackEnd.position.y) * 1080,
    );
    const seekParityZoomError = Math.abs(seekCamera.zoom - playbackEnd.zoom);
    const seekParityRotationError = Math.abs(seekCamera.rotation - playbackEnd.rotation);
    if (maxPlaybackPositionError > 1e-8 || maxPlaybackZoomError > 1e-12 || maxPlaybackRotationError > 1e-12
      || seekParityPositionError > 1e-8 || seekParityZoomError > 1e-12 || seekParityRotationError > 1e-12) {
      throw new Error('Normal playback, same-time evaluation, and seek camera states diverged.');
    }
    const playback = {
      sceneStartTime: playbackStartTime,
      requestedSceneEndTime: playbackEndTime,
      actualSceneEndTime: playbackTimer.actualEndTime,
      elapsedMs: playbackTimer.elapsedMs,
      updateCount: playbackObservations.length,
      maxSameTimeCompositionUnits: maxPlaybackPositionError,
      maxSameTimeZoom: maxPlaybackZoomError,
      maxSameTimeRotation: maxPlaybackRotationError,
      seekParityCompositionUnits: seekParityPositionError,
      seekParityZoom: seekParityZoomError,
      seekParityRotation: seekParityRotationError,
    };
    await engine.seek(input.rangeStart, true);
    const characterPresentBeforeCapture = live2DManager.hasCharacter('hero');

    const backend = new RawPixelsBackend(createExportBridge(socket));
    const encodeFrame = backend.encodeFrame.bind(backend);
    backend.encodeFrame = async (frame: BackendFrame) => {
      if (!frame.pixels) throw new Error('Raw-pixel export did not receive rendered pixels.');
      const expected = input.expectedFrames[frame.frameIndex];
      if (!expected) throw new Error(`No camera reference for exported frame ${frame.frameIndex}.`);
      const actualTime = engine!.getCurrentTime();
      const clockSkewSeconds = Math.abs(actualTime - expected.time);
      maxCaptureClockSkewSeconds = Math.max(maxCaptureClockSkewSeconds, clockSkewSeconds);
      if (clockSkewSeconds > 1e-6) {
        throw new Error(`Export frame ${frame.frameIndex} is off its requested scene time by ${clockSkewSeconds}s.`);
      }
      const sameTimeExpectedState = evaluateCameraChannels({
        timeline: evaluationTimeline,
        sceneTime: actualTime,
        logicalReferenceSize: { width: 1920, height: 1080 },
        anchorTrajectories: input.anchorTrajectories,
        trajectoryRevision: input.anchorRevision,
      });
      const sameTimeExpectedPosition = asPoint(sameTimeExpectedState.position);
      const sameTimeExpected: ExpectedCameraFrame = {
        time: actualTime,
        position: sameTimeExpectedPosition,
        zoom: sameTimeExpectedState.zoom,
        rotation: sameTimeExpectedState.rotation,
      };
      const actual = engine!.getCurrentCamera();
      const actualPosition = asPoint(actual.position);
      cameraParityCompositionUnits = Math.max(cameraParityCompositionUnits,
        Math.abs(actualPosition.x - sameTimeExpected.position.x) * 1920,
        Math.abs(actualPosition.y - sameTimeExpected.position.y) * 1080);
      cameraParityZoom = Math.max(cameraParityZoom, Math.abs(actual.zoom - sameTimeExpected.zoom));
      cameraParityRotation = Math.max(cameraParityRotation, Math.abs(actual.rotation - sameTimeExpected.rotation));
      if (cameraParityCompositionUnits > 1e-8 || cameraParityZoom > 1e-12 || cameraParityRotation > 1e-12) {
        cameraParityLastMismatch = {
          frameIndex: frame.frameIndex,
          requestedTime: expected.time,
          actualTime,
          lastSeek: frameSeekUpdates.at(-1),
          actualPosition,
          actualZoom: actual.zoom,
          actualRotation: actual.rotation,
          expectedAtActualTime: sameTimeExpected,
        };
      }
      if (previousRenderedPixels) {
        let changedPixelCount = 0;
        for (let index = 0; index < frame.pixels.length; index += 4) {
          if (frame.pixels[index] !== previousRenderedPixels[index]
            || frame.pixels[index + 1] !== previousRenderedPixels[index + 1]
            || frame.pixels[index + 2] !== previousRenderedPixels[index + 2]
            || frame.pixels[index + 3] !== previousRenderedPixels[index + 3]) changedPixelCount++;
        }
        minChangedPixelCount = Math.min(minChangedPixelCount, changedPixelCount);
        maxChangedPixelCount = Math.max(maxChangedPixelCount, changedPixelCount);
      }
      if (renderedFrameCount === 0) {
        const cornerOffset = 0;
        for (let index = 0; index < frame.pixels.length; index += 4) {
          if (frame.pixels[index] !== 0 || frame.pixels[index + 1] !== 0
            || frame.pixels[index + 2] !== 0 || frame.pixels[index + 3] !== 0) firstFrameNonzeroPixelCount++;
          if (frame.pixels[index] !== frame.pixels[cornerOffset]
            || frame.pixels[index + 1] !== frame.pixels[cornerOffset + 1]
            || frame.pixels[index + 2] !== frame.pixels[cornerOffset + 2]
            || frame.pixels[index + 3] !== frame.pixels[cornerOffset + 3]) firstFramePixelsDistinctFromCorner++;
        }
      }
      const modelSnapshot = live2DManager.captureSnapshot('hero');
      if (modelSnapshot) {
        snapshotAvailable = true;
        parameterCount = modelSnapshot.params.length;
        modelParameterHashes.add(numericArrayHash(modelSnapshot.params));
      }
      if (live2DManager.hasCharacter('hero')) {
        const bounds = live2DManager.getContainer('hero').getBounds();
        const visibleBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
        const intersectsStage = bounds.width > 0 && bounds.height > 0
          && bounds.x < stageManager.getWidth() && bounds.y < stageManager.getHeight()
          && bounds.x + bounds.width > 0 && bounds.y + bounds.height > 0;
        if (!firstVisibleModelBounds) {
          firstVisibleModelBounds = visibleBounds;
          firstVisibleModelBoundsIntersectStage = intersectsStage;
        }
        lastVisibleModelBounds = visibleBounds;
        lastVisibleModelBoundsIntersectStage = intersectsStage;
      }
      previousRenderedPixels = frame.pixels.slice();
      renderedHashes.add(framePixelHash(frame.pixels));
      renderedFrameCount++;
      await encodeFrame(frame);
    };

    const capture = new FrameCaptureEngine({
      getApp: () => stageManager.getApp(),
      getWidth: () => stageManager.getWidth(),
      getHeight: () => stageManager.getHeight(),
      getLayer: (name) => stageManager.getLayer(name),
      pauseTicker: () => stageManager.pauseTicker(),
      resumeTicker: () => stageManager.resumeTicker(),
    }, engine, lightingSystem, live2DManager, cameraController);
    const frameSeekUpdates: { requestedTime: number; beforeTime: number; afterTime: number }[] = [];
    const originalSeek = engine.seek.bind(engine);
    engine.seek = async (time, forceReconstruct) => {
      const beforeTime = engine!.getCurrentTime();
      await originalSeek(time, forceReconstruct);
      frameSeekUpdates.push({ requestedTime: time, beforeTime, afterTime: engine!.getCurrentTime() });
    };
    const captureStart = performance.now();
    const result = await capture.capture({
      fps: input.fps,
      rangeStart: input.rangeStart,
      rangeEnd: input.rangeEnd,
      width: input.width,
      height: input.height,
      bitrateBps: 4_000_000,
      outputPath: input.outputPath,
      codec: 'libx264',
      backend,
      streamOptions: { totalFrames: input.expectedFrames.length },
      onProgress: () => {},
    });
    const elapsedMs = performance.now() - captureStart;
    if (renderedFrameCount !== input.expectedFrames.length) {
      throw new Error(`Expected ${input.expectedFrames.length} rendered frames, received ${renderedFrameCount}.`);
    }
    if (cameraParityCompositionUnits > 1e-8 || cameraParityZoom > 1e-12 || cameraParityRotation > 1e-12) {
      throw new Error(`Rendered export camera state differs from the prepared same-time reference: ${JSON.stringify({
        maxCompositionUnits: cameraParityCompositionUnits,
        maxZoom: cameraParityZoom,
        maxRotation: cameraParityRotation,
        lastMismatch: cameraParityLastMismatch,
      })}`);
    }

    return {
      playback,
      backend: 'RawPixelsBackend',
      renderer: 'Pixi WebGL',
      maxCaptureClockSkewSeconds,
      adjacentFrameChangedPixels: { min: minChangedPixelCount, max: maxChangedPixelCount },
      firstFrameNonzeroPixelCount,
      firstFramePixelsDistinctFromCorner,
      modelState: {
        characterPresent: live2DManager.hasCharacter('hero'),
        characterPresentBeforeCapture,
        snapshotAvailable,
        uniqueParameterSnapshots: modelParameterHashes.size,
        parameterCount,
        modelReferenceKind,
        modelReferenceUsesFixtureRoute,
        visibleModelBounds: firstVisibleModelBounds && lastVisibleModelBounds
          ? { first: firstVisibleModelBounds, last: lastVisibleModelBounds }
          : null,
        visibleModelBoundsIntersectStage: firstVisibleModelBoundsIntersectStage === true
          && lastVisibleModelBoundsIntersectStage,
      },
      frameSeekSamples: frameSeekUpdates.length <= 6
        ? frameSeekUpdates
        : [...frameSeekUpdates.slice(0, 3), ...frameSeekUpdates.slice(-3)],
      frameCount: renderedFrameCount,
      fps: input.fps,
      width: input.width,
      height: input.height,
      elapsedMs,
      encodedFramesPerSecond: renderedFrameCount / (elapsedMs / 1000),
      renderedFrameCount,
      uniqueRenderedFrameHashes: renderedHashes.size,
      maxCameraParityCompositionUnits: cameraParityCompositionUnits,
      maxCameraParityZoom: cameraParityZoom,
      maxCameraParityRotation: cameraParityRotation,
      encodedSizeBytes: result?.sizeBytes ?? null,
    };
  } finally {
    engine?.pause();
    engine?.destroy();
    if (live2DManager.hasCharacter('hero')) await live2DManager.removeCharacter('hero');
    if (stageInitialized) stageManager.destroy();
    daemon.attach = originalAttach;
    daemon.triggerColdScan = originalColdScan;
    socket.close();
  }
};
