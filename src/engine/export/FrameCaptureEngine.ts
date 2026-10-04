import type { ICaptureBackend } from './ICaptureBackend';
import type { ExportProgress } from '../../api/types/export';
import type { VisualLightingOverlay } from '../visual-runtime/VisualRuntimeResolver';
import gsap from 'gsap';
import { objectCompositeRuntimeController } from '../visual-runtime/ObjectCompositeRuntimeController';
import { customAnimHost } from '../CustomAnimHost';
import type { CustomAnimationCaptureFrame } from '../CustomAnimHost';
import { cubism2Live2DAdapter } from '../Live2DRuntimeAdapter';
import { Rectangle } from 'pixi.js';

// Minimal interfaces for injected dependencies — only what FrameCaptureEngine actually uses
interface StageSubsystem {
  getApp(): import('pixi.js').Application;
  pauseTicker(): void;
  resumeTicker(): void;
  /** Optional access to named stage layers (used to hide/render the subtitle layer during subtitle-less or subtitle-only export). */
  getLayer?(name: 'subtitle'): import('pixi.js').Container | null | undefined;
}

interface PlaybackSubsystem {
  seek(time: number): Promise<void>;
  pause(): void;
  getDuration(): number;
  setSilentMode(v: boolean): void;
  getMasterTimeline(): gsap.core.Timeline | null;
}

interface LightingSubsystem {
  reset(): void;
  resetRuntimeState?(): void;
  syncEffects(): void;
  deriveLightingSnapshotAtTime?(time: number, timeline: readonly any[], visualOverlay: VisualLightingOverlay | null): unknown;
  applySnapshot?(snapshot: unknown): void;
  reconcile?(time: number, timeline: readonly any[]): void;
  applyVisualOverlay?(overlay: VisualLightingOverlay | null): void;
}

interface Live2DSubsystem {
  setExportMode(enabled: boolean): void;
  waitForAllLoaded(): Promise<void>;
  updateAll(dt: number, forceStep: boolean, manualTimeMs?: number): Promise<void>;
}

interface CameraSubsystem {
  init(): void;
}

export interface FrameCaptureVisualRuntime {
  readonly timeline?: readonly any[];
  applyCompositeAtTime(time: number): void;
  resolveLightingOverlayAtTime(time: number): VisualLightingOverlay | null;
}

interface FrameCaptureConfig {
  fps: number;
  rangeStart: number;
  rangeEnd: number;
  width: number;
  height: number;
  bitrateBps: number;
  outputPath: string;
  codec: string;
  backend: ICaptureBackend;
  onProgress: (p: ExportProgress) => void;
  visualRuntime?: FrameCaptureVisualRuntime;
  voiceLipSync?: { beforeSeek(time: number): void; applyAtTime(time: number): void; dispose(): void };
  /**
   * Set to false to render the exported video without the subtitle layer
   * (dialogue subtitles & text layers). Defaults to true.
   */
  includeSubtitles?: boolean;
  /**
   * Render ONLY the subtitle layer on a fully transparent background.
   * The backend must preserve alpha (ProRes 4444 / yuva444p10le).
   */
  subtitleOnly?: boolean;
  /**
   * Render ONLY the subtitle layer over a solid chroma-green background
   * (RGB 0,255,0) for keying in editors. No alpha channel is required.
   */
  subtitleChroma?: boolean;
}

function blendRgbaPixels(
  base: Uint8Array | Uint8ClampedArray,
  overlay: Uint8Array | Uint8ClampedArray,
): Uint8ClampedArray {
  const result = new Uint8ClampedArray(base);
  const count = Math.min(result.length, overlay.length);
  for (let index = 0; index < count; index += 4) {
    const sourceAlpha = overlay[index + 3] / 255;
    if (sourceAlpha <= 0) continue;
    const destinationAlpha = result[index + 3] / 255;
    const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
    if (outputAlpha <= 0) continue;
    result[index] = Math.round((overlay[index] * sourceAlpha + result[index] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
    result[index + 1] = Math.round((overlay[index + 1] * sourceAlpha + result[index + 1] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
    result[index + 2] = Math.round((overlay[index + 2] * sourceAlpha + result[index + 2] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
    result[index + 3] = Math.round(outputAlpha * 255);
  }
  return result;
}

function createCompositeCanvas(
  baseCanvas: HTMLCanvasElement,
  customFrame: CustomAnimationCaptureFrame,
  width: number,
  height: number,
): HTMLCanvasElement | null {
  if (typeof document === 'undefined') {
    throw new Error('Custom HTML capture cannot be composited because no document canvas is available.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Custom HTML capture could not create a 2D compositor canvas.');
  }

  try {
    context.drawImage(baseCanvas, 0, 0, width, height);
    if (customFrame.pixels) {
      if (customFrame.pixels.length !== customFrame.width * customFrame.height * 4) {
        throw new Error('Custom HTML capture returned an incomplete RGBA frame.');
      }
      const overlayCanvas = document.createElement('canvas');
      overlayCanvas.width = customFrame.width;
      overlayCanvas.height = customFrame.height;
      const overlayContext = overlayCanvas.getContext('2d');
      if (!overlayContext) {
        throw new Error('Custom HTML capture could not create an RGBA overlay canvas.');
      }
      const imageData = overlayContext.createImageData(customFrame.width, customFrame.height);
      imageData.data.set(customFrame.pixels);
      overlayContext.putImageData(imageData, 0, 0);
      context.drawImage(overlayCanvas, 0, 0, width, height);
    } else if (customFrame.canvas) {
      context.drawImage(customFrame.canvas as CanvasImageSource, 0, 0, width, height);
    } else {
      throw new Error('Custom HTML capture returned no pixels or canvas.');
    }
    return canvas;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Custom HTML capture')) throw error;
    throw new Error(`Custom HTML capture compositing failed: ${String(error)}`);
  }
}

declare const UtSystem: {
  getUserTimeMSec(): number;
  setUserTimeMSec(ms: number): void;
} | undefined;

/**
 * Best-effort SDK clock access through the Cubism 2 runtime adapter (export
 * keeps the same monotonic discipline as the engine runtime).
 */
function getRuntimeClock(): import('../Live2DRuntimeAdapter').Live2DRuntimeClock | null {
  return cubism2Live2DAdapter.getClock();
}

export class FrameCaptureEngine {
  private stage: StageSubsystem;
  private playback: PlaybackSubsystem;
  private lighting: LightingSubsystem | (() => LightingSubsystem);
  private live2D: Live2DSubsystem | (() => Live2DSubsystem);
  private camera: CameraSubsystem;

  constructor(
    stage: StageSubsystem,
    playback: PlaybackSubsystem,
    lighting: LightingSubsystem | (() => LightingSubsystem),
    live2D: Live2DSubsystem | (() => Live2DSubsystem),
    camera: CameraSubsystem,
  ) {
    this.stage = stage;
    this.playback = playback;
    this.lighting = lighting;
    this.live2D = live2D;
    this.camera = camera;
  }

  /**
   * Capture frames from the engine to video via the configured backend.
   * Owns the entire capture lifecycle:
   *  - renderer resize, engine lockdown, frame stepping, cleanup.
   */
  async capture(config: FrameCaptureConfig): Promise<void> {
    const { fps, rangeStart, rangeEnd, width, height, bitrateBps, outputPath, codec, backend, onProgress } = config;

    // Resolve lazy-loaded subsystem singletons (dynamic getters)
    const live2D = typeof this.live2D === 'function' ? this.live2D() : this.live2D;
    const lighting = typeof this.lighting === 'function' ? this.lighting() : this.lighting;

    if (!live2D) {
      throw new Error('Live2DManager not initialized yet. Please try again after the engine fully loads.');
    }
    if (!lighting) {
      throw new Error('LightingSystem not initialized yet. Please try again after the engine fully loads.');
    }

    const app = this.stage.getApp();
    const originalWidth = app.renderer.width;
    const originalHeight = app.renderer.height;
    const originalResolution = app.renderer.resolution;
    const canvasStyle = app.canvas?.style;
    const originalCanvasStyle = canvasStyle
      ? { width: canvasStyle.width, height: canvasStyle.height }
      : null;
    let backendFinished = false;

    // Subtitle layer handling for the optional subtitle export modes:
    //  - includeSubtitles=false hides the subtitle layer for the whole capture
    //    (GSAP timelines keep running on the hidden containers so a later seek
    //    or the interactive preview finds consistent scene state).
    //  - subtitleOnly / subtitleChroma render ONLY the subtitle layer; the
    //    background is transparent (alpha 0, backend must preserve alpha) or
    //    solid chroma green for keying in editors.
    const includeSubtitles = config.includeSubtitles !== false;
    const subtitleOnly = config.subtitleOnly === true;
    const subtitleChroma = config.subtitleChroma === true;
    const renderSubtitlesOnly = subtitleOnly || subtitleChroma;
    const originalBackgroundAlpha = (app.renderer.background)?.alpha;
    const originalBackgroundColor = (app.renderer.background)?.color;
    let subtitleLayer: import('pixi.js').Container | null | undefined;
    let originalSubtitleVisible = true;

    try {
      // ── Init ──
      // Video dimensions are physical output pixels. Preview DPR must not
      // multiply the encoder input size.
      app.renderer.resize(width, height, 1);

      if (renderSubtitlesOnly) {
        subtitleLayer = this.stage.getLayer?.('subtitle') ?? null;
        if (!subtitleLayer) {
          throw new Error('Subtitle-only export requires the subtitle layer to be mounted on the stage.');
        }
        if (subtitleChroma) {
          app.renderer.background.alpha = 1;
          app.renderer.background.color = 0x00ff00;
        } else {
          app.renderer.background.alpha = 0;
        }
      } else if (!includeSubtitles) {
        subtitleLayer = this.stage.getLayer?.('subtitle') ?? null;
        if (subtitleLayer) {
          originalSubtitleVisible = subtitleLayer.visible;
          subtitleLayer.visible = false;
        }
      }

      await backend.init({
        width,
        height,
        fps,
        bitrate: bitrateBps,
        outputPath,
        codec,
        isEncoded: true,
        transparent: subtitleOnly,
      });

      // ── Deterministic Lockdown ──
      live2D.setExportMode(true);
      objectCompositeRuntimeController.setSamplingMode('export');
      objectCompositeRuntimeController.invalidateEnvironmentSamples(undefined, { snapToSample: true });
      // Freeze playback before the reconstruction seek. Otherwise a scene
      // that was playing can make ScriptEngine resume its custom iframes in
      // the small window between seek completion and export pause.
      this.playback.pause();
      await this.playback.seek(rangeStart);
      this.playback.pause();

      this.camera.init();
      if (typeof lighting.resetRuntimeState === 'function') {
        lighting.resetRuntimeState();
      } else {
        lighting.reset();
      }
      lighting.syncEffects();
      await live2D.waitForAllLoaded();
      await new Promise(resolve => setTimeout(resolve, 100));

      // Render only the subtitle layer for subtitle-only exports; the layer
      // was resolved above and is guaranteed non-null in that mode.
      const renderTarget = subtitleLayer ?? app.stage;

      app.renderer.render(renderTarget);
      const nextFrame = typeof requestAnimationFrame !== 'undefined'
        ? requestAnimationFrame
        : (cb: any) => setTimeout(cb, 16);
      await new Promise(resolve => nextFrame(resolve));
      await new Promise(resolve => nextFrame(resolve));
      gsap.globalTimeline.pause();

      // ── Performance Lockdown ──
      this.stage.pauseTicker();
      this.playback.setSilentMode(true);
      if (typeof document !== 'undefined') {
        document.body.classList.add('is-exporting');
      }

      const runtimeClock = getRuntimeClock();
      let exportUtBaseline = runtimeClock ? runtimeClock.getUserTimeMSec() : 0;

      const startFrame = Math.floor(rangeStart * fps);
      const endFrame = Math.ceil(rangeEnd * fps);
      const totalFrames = endFrame - startFrame;

      let lastUiUpdate = Date.now();

      for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
        const time = rangeStart + frameIdx / fps;
        const dtMs = 1000 / fps;

        // Monotonically advance UtSystem — never rewind
        if (runtimeClock) {
          exportUtBaseline += dtMs;
          runtimeClock.setUserTimeMSec(exportUtBaseline);
        }

        // Reconcile all graphic layers through the awaited seek seam on every
        // export frame. Directly crossing a GSAP callback is not sufficient
        // when export starts in the middle of an action interval.
        config.voiceLipSync?.beforeSeek(time);
        await this.playback.seek(time);
        gsap.globalTimeline.totalTime(time, false);
        config.visualRuntime?.applyCompositeAtTime(time);
        const visualOverlay = config.visualRuntime?.resolveLightingOverlayAtTime(time) ?? null;
        const timeline = config.visualRuntime?.timeline;
        let appliedViaSnapshot = false;
        if (timeline && typeof lighting.deriveLightingSnapshotAtTime === 'function' && typeof lighting.applySnapshot === 'function') {
          const snapshot = lighting.deriveLightingSnapshotAtTime(time, timeline, visualOverlay);
          lighting.applySnapshot(snapshot);
          appliedViaSnapshot = true;
        } else if (timeline && typeof lighting.reconcile === 'function') {
          lighting.reconcile(time, timeline);
        } else {
          lighting.syncEffects();
        }
        if (!appliedViaSnapshot && typeof lighting.applyVisualOverlay === 'function') {
          lighting.applyVisualOverlay(visualOverlay);
        }
        config.voiceLipSync?.applyAtTime(time);
        // seek() has already reconstructed the SDK motion at this scene time.
        // A further frame step would export the next fade weight instead.
        await live2D.updateAll(0, true, time * 1000);

        if (!renderSubtitlesOnly && typeof (customAnimHost as any).seek === 'function') {
          await (customAnimHost as any).seek(time);
        }

        // WebGL state reset (Live2D Cubism 2.1 pollutes global state).
        // In Pixi v8 this is a single renderer-level call: it emits the
        // `resetState` runner, which resets every GL system that can hold a
        // stale cache (state, texture, shader, geometry, buffer, stencil,
        // render target). The v7 per-system `state.reset()` / `texture.reset()`
        // methods no longer exist on AbstractRenderer's systems.
        app.renderer.resetState();

        app.renderer.render(renderTarget);

        // Custom HTML animations are part of the scene, not the subtitle
        // layer — never composite them into a subtitle-only export.
        let customFrame: CustomAnimationCaptureFrame | null = null;
        const activeCustomAnimationCount = renderSubtitlesOnly
          ? 0
          : typeof (customAnimHost as any).getActiveAnimationCount === 'function'
            ? (customAnimHost as any).getActiveAnimationCount()
            : 0;
        if (!renderSubtitlesOnly && typeof (customAnimHost as any).captureFrame === 'function') {
          try {
            customFrame = await (customAnimHost as any).captureFrame(width, height, time);
          } catch (error) {
            throw new Error(
              `Custom HTML animation capture failed at ${time.toFixed(3)}s: ${String(error)} `
              + 'Register a capture provider or implement the iframe captureFrame response before exporting.',
            );
          }
        }
        if (activeCustomAnimationCount > 0 && !customFrame) {
          throw new Error(
            `Custom HTML animation capture returned no verifiable frame at ${time.toFixed(3)}s. `
            + 'Register a capture provider or implement the iframe captureFrame response before exporting.',
          );
        }

        // If the backend has pushFrame (RawPixelsBackend), it needs the
        // composited RGBA pixels. WebCodecs receives a composited canvas.
        const isRawPixels = 'pushQueue' in backend || typeof (backend as any).pushQueue !== 'undefined';
        if (isRawPixels) {
          const extractedPixels = app.renderer.extract.pixels({
            // Match the render target. Subtitle-only exports must not pull the
            // camera-affected scene (including panorama post effects) back in
            // through a second full-stage extraction.
            target: renderTarget,
            frame: new Rectangle(0, 0, width, height),
          });
          const pixels = extractedPixels instanceof Uint8Array || extractedPixels instanceof Uint8ClampedArray
            ? extractedPixels
            : extractedPixels.pixels;
          const customPixels = await this.resolveCustomFramePixels(customFrame, width, height);
          await backend.encodeFrame({
            pixels: customPixels ? blendRgbaPixels(pixels, customPixels) : pixels,
            frameIndex: frameIdx,
            fps,
          });
        } else {
          const compositedCanvas = customFrame
            ? createCompositeCanvas(app.canvas, customFrame, width, height)
            : null;
          await backend.encodeFrame({
            canvas: compositedCanvas || app.canvas,
            frameIndex: frameIdx,
            fps,
          });
        }

        // UI throttle: 400ms between progress updates
        const now = Date.now();
        if (now - lastUiUpdate > 400 || frameIdx === totalFrames - 1) {
          const pct = Math.round((frameIdx / totalFrames) * 90); // 0-90% for capture phase
          onProgress({
            phase: 'capture',
            percent: pct,
            frame: frameIdx,
            totalFrames,
          });
          lastUiUpdate = now;
        }
      }

      await backend.finish();
      backendFinished = true;
    } catch (error) {
      const abortBackend = (backend as typeof backend & { abort?: () => Promise<void> }).abort;
      if (!backendFinished && typeof abortBackend === 'function') {
        try {
          await abortBackend.call(backend);
        } catch (cleanupError) {
          // Preserve the capture/renderer/seek failure while still exposing
          // cleanup problems in diagnostics.
          console.error('[FrameCapture] Failed to abort backend stream:', cleanupError);
        }
      }
      throw error;
    } finally {
      // ── Restore ──
      config.voiceLipSync?.dispose();
      app.renderer.resize(originalWidth, originalHeight, originalResolution);
      if (canvasStyle && originalCanvasStyle) {
        canvasStyle.width = originalCanvasStyle.width;
        canvasStyle.height = originalCanvasStyle.height;
      }
      this.stage.resumeTicker();
      this.playback.setSilentMode(false);
      if (subtitleLayer) {
        subtitleLayer.visible = originalSubtitleVisible;
      }
      if (originalBackgroundAlpha !== undefined) {
        app.renderer.background.alpha = originalBackgroundAlpha;
      }
      if (originalBackgroundColor !== undefined) {
        app.renderer.background.color = originalBackgroundColor;
      }
      if (typeof document !== 'undefined') {
        document.body.classList.remove('is-exporting');
      }
      gsap.globalTimeline.play();
      objectCompositeRuntimeController.setSamplingMode('interactive');
      objectCompositeRuntimeController.invalidateEnvironmentSamples(undefined, { snapToSample: true });
      const live2D = typeof this.live2D === 'function' ? this.live2D() : this.live2D;
      if (live2D) {
        live2D.setExportMode(false);
      }
    }
  }

  private async resolveCustomFramePixels(
    frame: CustomAnimationCaptureFrame | null,
    width: number,
    height: number,
  ): Promise<Uint8Array | Uint8ClampedArray | null> {
    if (!frame) return null;
    if (frame.pixels) {
      if (frame.pixels.length !== frame.width * frame.height * 4) {
        throw new Error('Custom HTML capture returned an incomplete RGBA frame.');
      }
      if (frame.width === width && frame.height === height) return frame.pixels;
      if (typeof document === 'undefined') {
        throw new Error('Custom HTML capture dimensions do not match the export frame and cannot be scaled.');
      }
      const canvas = document.createElement('canvas');
      canvas.width = frame.width;
      canvas.height = frame.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Custom HTML capture could not create an RGBA scaling canvas.');
      const imageData = context.createImageData(frame.width, frame.height);
      imageData.data.set(frame.pixels);
      context.putImageData(imageData, 0, 0);
      const scaled = document.createElement('canvas');
      scaled.width = width;
      scaled.height = height;
      const scaledContext = scaled.getContext('2d');
      if (!scaledContext) throw new Error('Custom HTML capture could not create a scaled compositor canvas.');
      scaledContext.drawImage(canvas, 0, 0, width, height);
      return scaledContext.getImageData(0, 0, width, height).data;
    }
    if (!frame.canvas) {
      throw new Error('Custom HTML capture returned no pixels or canvas.');
    }

    try {
      const context = frame.canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!context || typeof context.getImageData !== 'function') {
        throw new Error('Custom HTML capture canvas cannot provide readable pixels.');
      }
      return context.getImageData(0, 0, width, height).data;
    } catch (error) {
      throw new Error(`Custom HTML capture pixel extraction failed: ${String(error)}`);
    }
  }
}
