/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const customAnimMocks = vi.hoisted(() => ({
  seek: vi.fn(),
  captureFrame: vi.fn().mockResolvedValue(null),
  getActiveAnimationCount: vi.fn(() => 0),
}));

vi.mock('../engine/CustomAnimHost', () => ({ customAnimHost: customAnimMocks }));

import { FrameCaptureEngine } from '../engine/export/FrameCaptureEngine';

function createMockStage() {
  return {
    getApp: vi.fn().mockReturnValue({
      renderer: {
        width: 1280, height: 720, resolution: 2,
        render: vi.fn(),
        resize: vi.fn(),
        // Pixi v8 shape: systems expose `resetState()` and the renderer
        // forwards to them via `renderer.resetState()`. There is no
        // `renderer.state` / `renderer.texture` namespace to poke.
        resetState: vi.fn(),
        extract: { pixels: vi.fn(() => new Uint8ClampedArray([0, 0, 255, 255])) },
        background: { color: 0x0a0a0f, alpha: 1 },
      },
      stage: {},
      view: {} as HTMLCanvasElement,
    }),
    pauseTicker: vi.fn(),
    resumeTicker: vi.fn(),
    getLayer: vi.fn((_name: string) => null as { visible: boolean } | null),
  };
}

function createMockPlayback() {
  return {
    seek: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    getDuration: vi.fn().mockReturnValue(10),
    setSilentMode: vi.fn(),
    getMasterTimeline: vi.fn().mockReturnValue({ seek: vi.fn() }),
  };
}

function createMockLighting() {
  return {
    reset: vi.fn(),
    syncEffects: vi.fn(),
    applyVisualOverlay: vi.fn(),
  };
}

function createMockLive2D() {
  return {
    setExportMode: vi.fn(),
    waitForAllLoaded: vi.fn().mockResolvedValue(undefined),
    updateAll: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockCamera() {
  return { init: vi.fn() };
}

function createMockBackend() {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    encodeFrame: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
  };
}

describe('FrameCaptureEngine', () => {
  let engine: FrameCaptureEngine;
  let stage: ReturnType<typeof createMockStage>;
  let playback: ReturnType<typeof createMockPlayback>;
  let lighting: ReturnType<typeof createMockLighting>;
  let live2D: ReturnType<typeof createMockLive2D>;
  let camera: ReturnType<typeof createMockCamera>;

  beforeEach(() => {
    stage = createMockStage();
    playback = createMockPlayback();
    lighting = createMockLighting();
    live2D = createMockLive2D();
    camera = createMockCamera();
    customAnimMocks.seek.mockClear();
    customAnimMocks.captureFrame.mockReset().mockResolvedValue(null);
    customAnimMocks.getActiveAnimationCount.mockReset().mockReturnValue(0);
    engine = new FrameCaptureEngine(
      stage as any, playback as any, lighting as any,
      live2D as any, camera as any,
    );
  });

  it('constructs with all subsystems', () => {
    expect(engine).toBeDefined();
  });

  it('stops at a frame boundary after cancellation and restores preview state', async () => {
    const backend = createMockBackend();
    const controller = new AbortController();
    backend.encodeFrame.mockImplementation(async () => { controller.abort(); });
    const onProgress = vi.fn();
    await expect(engine.capture({
      fps: 60, rangeStart: 0, rangeEnd: 1, width: 1, height: 1,
      bitrateBps: 12_000_000, outputPath: '/tmp/test.mp4', codec: 'libx264',
      backend, onProgress, signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(backend.encodeFrame).toHaveBeenCalledTimes(1);
    expect(backend.finish).not.toHaveBeenCalled();
    expect(backend.abort).toHaveBeenCalledWith(true);
    expect(stage.resumeTicker).toHaveBeenCalled();
    expect(playback.setSilentMode).toHaveBeenLastCalledWith(false);
    expect(live2D.setExportMode).toHaveBeenLastCalledWith(false);
    expect(document.body.classList.contains('is-exporting')).toBe(false);
  });

  it('cleans up when cancellation arrives during backend initialization', async () => {
    const backend = createMockBackend();
    const controller = new AbortController();
    backend.init.mockImplementation(async () => { controller.abort(); });
    await expect(engine.capture({
      fps: 60, rangeStart: 0, rangeEnd: 1, width: 1, height: 1,
      bitrateBps: 12_000_000, outputPath: '/tmp/test.mp4', codec: 'libx264',
      backend, onProgress: vi.fn(), signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(backend.abort).toHaveBeenCalledWith(true);
    expect(backend.encodeFrame).not.toHaveBeenCalled();
  });

  it('capture calls backend.init with correct config', async () => {
    const backend = createMockBackend();
    const onProgress = vi.fn();

    await engine.capture({
      fps: 60, rangeStart: 0, rangeEnd: 1 / 60,
      width: 1920, height: 1080, bitrateBps: 12_000_000,
      outputPath: '/tmp/test.mp4', codec: 'libx264',
      backend: backend as any, onProgress,
    });

    expect(backend.init).toHaveBeenCalledWith({
      width: 1920, height: 1080, fps: 60,
      bitrate: 12_000_000, outputPath: '/tmp/test.mp4',
      codec: 'libx264', isEncoded: true, transparent: false,
    });
  });

  it('capture resizes renderer then restores it', async () => {
    const backend = createMockBackend();
    const app = stage.getApp();

    await engine.capture({
      fps: 60, rangeStart: 0, rangeEnd: 1 / 60,
      width: 1920, height: 1080, bitrateBps: 12_000_000,
      outputPath: '/tmp/test.mp4', codec: 'libx264',
      backend: backend as any, onProgress: vi.fn(),
    });

    expect(app.renderer.resize).toHaveBeenCalledWith(1920, 1080, 1);
    // After capture, restores to original size
    expect(app.renderer.resize).toHaveBeenLastCalledWith(1280, 720, 2);
  });

  it('capture enters and exits export mode on Live2DManager', async () => {
    const backend = createMockBackend();

    await engine.capture({
      fps: 60, rangeStart: 0, rangeEnd: 1 / 60,
      width: 1920, height: 1080, bitrateBps: 12_000_000,
      outputPath: '/tmp/test.mp4', codec: 'libx264',
      backend: backend as any, onProgress: vi.fn(),
    });

    expect(live2D.setExportMode).toHaveBeenNthCalledWith(1, true);
    expect(live2D.setExportMode).toHaveBeenLastCalledWith(false);
  });

  it('capture calls onProgress with capture phase updates', async () => {
    const backend = createMockBackend();
    const progressCalls: any[] = [];
    const onProgress = vi.fn((p) => progressCalls.push(p));

    await engine.capture({
      fps: 60, rangeStart: 0, rangeEnd: 1 / 60,
      width: 1920, height: 1080, bitrateBps: 12_000_000,
      outputPath: '/tmp/test.mp4', codec: 'libx264',
      backend: backend as any, onProgress,
    });

    expect(progressCalls.length).toBeGreaterThan(0);
    expect(progressCalls[0].phase).toBe('capture');
  });

  it('capture calls backend.finish after the loop', async () => {
    const backend = createMockBackend();

    await engine.capture({
      fps: 60, rangeStart: 0, rangeEnd: 1 / 60,
      width: 1920, height: 1080, bitrateBps: 12_000_000,
      outputPath: '/tmp/test.mp4', codec: 'libx264',
      backend: backend as any, onProgress: vi.fn(),
    });

    expect(backend.finish).toHaveBeenCalledTimes(1);
  });

  it('applies visual overlay during capture when a visual runtime is provided', async () => {
    const backend = createMockBackend();
    const visualRuntime = {
      timeline: [
        { action: 'addLensFilter', time: 0, params: { category: 'optics', recipeId: 'builtin:soft-bloom-rgb' } },
      ],
      applyCompositeAtTime: vi.fn(),
      resolveLightingOverlayAtTime: vi.fn().mockReturnValue({
        postProcessing: { bloomBloomScale: 0.4 },
      }),
    };

    await engine.capture({
      fps: 60,
      rangeStart: 0,
      rangeEnd: 1 / 60,
      width: 1920,
      height: 1080,
      bitrateBps: 12_000_000,
      outputPath: '/tmp/test.mp4',
      codec: 'libx264',
      backend: backend as any,
      onProgress: vi.fn(),
      visualRuntime: visualRuntime as any,
    });

    expect(visualRuntime.applyCompositeAtTime).toHaveBeenCalledWith(0);
    expect(visualRuntime.resolveLightingOverlayAtTime).toHaveBeenCalledWith(0);
    expect(lighting.applyVisualOverlay).toHaveBeenCalled();
    expect(lighting.applyVisualOverlay.mock.calls.some(([overlay]) => overlay && overlay.postProcessing.bloomBloomScale > 0)).toBe(true);
  });

  it('renders and extracts normal exports from the full stage so scene and UI siblings are composited', async () => {
    const backend = { ...createMockBackend(), pushQueue: [] as Promise<unknown>[] };
    const app = stage.getApp();
    const renderTargets: unknown[] = [];
    app.renderer.render = vi.fn((target: unknown) => { renderTargets.push(target); });
    const extractedTargets: unknown[] = [];
    app.renderer.extract.pixels = vi.fn((options: { target: unknown }) => {
      extractedTargets.push(options.target);
      return new Uint8ClampedArray([0, 0, 0, 255]);
    });

    await engine.capture({
      fps: 60,
      rangeStart: 0,
      rangeEnd: 1 / 60,
      width: 1,
      height: 1,
      bitrateBps: 12_000_000,
      outputPath: '/tmp/test.mp4',
      codec: 'libx264',
      backend: backend as any,
      onProgress: vi.fn(),
    });

    expect(renderTargets.length).toBeGreaterThan(0);
    expect(renderTargets.every((target) => target === app.stage)).toBe(true);
    expect(extractedTargets).toEqual([app.stage]);
  });

  it('composites custom HTML capture pixels into the raw export frame', async () => {
    const backend = { ...createMockBackend(), pushQueue: [] as Promise<unknown>[] };
    customAnimMocks.captureFrame.mockResolvedValue({
      width: 1,
      height: 1,
      pixels: new Uint8ClampedArray([255, 0, 0, 128]),
    });

    await engine.capture({
      fps: 60,
      rangeStart: 0,
      rangeEnd: 1 / 60,
      width: 1,
      height: 1,
      bitrateBps: 12_000_000,
      outputPath: '/tmp/test.mp4',
      codec: 'libx264',
      backend: backend as any,
      onProgress: vi.fn(),
    });

    expect(customAnimMocks.captureFrame).toHaveBeenCalledWith(1, 1, 0);
    const encodedPixels = (backend.encodeFrame as any).mock.calls[0][0].pixels as Uint8ClampedArray;
    expect(Array.from(encodedPixels)).toEqual([128, 0, 127, 255]);
  });

  it('awaits a reconstructable seek for every middle export frame', async () => {
    const backend = createMockBackend();

    await engine.capture({
      fps: 60,
      rangeStart: 2,
      rangeEnd: 2 + 2 / 60,
      width: 1,
      height: 1,
      bitrateBps: 12_000_000,
      outputPath: '/tmp/test.mp4',
      codec: 'libx264',
      backend: backend as any,
      onProgress: vi.fn(),
    });

    expect(playback.seek).toHaveBeenCalledWith(2);
    expect(playback.seek).toHaveBeenCalledWith(2 + 1 / 60);
    expect(customAnimMocks.seek).toHaveBeenCalledWith(2);
    expect(customAnimMocks.seek).toHaveBeenCalledWith(2 + 1 / 60);
  });

  it('captures the exact seeked motion fade frame without advancing it again', async () => {
    const backend = createMockBackend();
    await engine.capture({
      fps: 60, rangeStart: 0.25, rangeEnd: 0.25 + 1 / 60,
      width: 1280, height: 720, bitrateBps: 1_000_000,
      outputPath: '/tmp/fade.mp4', codec: 'libx264', backend: backend as any,
      onProgress: vi.fn(),
    });

    expect(live2D.updateAll).toHaveBeenCalledWith(0, true, 250);
  });

  it('resets renderer GL state through the v8 resetState seam before every frame', async () => {
    const backend = createMockBackend();
    const app = stage.getApp();

    await engine.capture({
      fps: 60,
      rangeStart: 1,
      rangeEnd: 1 + 2 / 60,
      width: 1,
      height: 1,
      bitrateBps: 12_000_000,
      outputPath: '/tmp/test.mp4',
      codec: 'libx264',
      backend: backend as any,
      onProgress: vi.fn(),
    });

    // Live2D Cubism 2.1 leaves the WebGL context dirty, so the reset has to
    // happen on each exported frame, immediately before that frame's render.
    // One render also happens before the loop (the warm-up pass), which has no
    // preceding reset.
    const renders = app.renderer.render.mock.invocationCallOrder;
    const resets = app.renderer.resetState.mock.invocationCallOrder;
    expect(resets.length).toBe(renders.length - 1);
    for (let i = 0; i < resets.length; i++) {
      expect(resets[i]).toBeLessThan(renders[i + 1]);
    }
  });

  it('blocks export when an active custom animation has no capture response', async () => {
    const backend = createMockBackend();
    customAnimMocks.getActiveAnimationCount.mockReturnValue(1);

    await expect(engine.capture({
      fps: 60,
      rangeStart: 1,
      rangeEnd: 1 + 1 / 60,
      width: 1,
      height: 1,
      bitrateBps: 12_000_000,
      outputPath: '/tmp/test.mp4',
      codec: 'libx264',
      backend: backend as any,
      onProgress: vi.fn(),
    })).rejects.toThrow(/no verifiable frame/);

    expect(stage.resumeTicker).toHaveBeenCalled();
    expect(live2D.setExportMode).toHaveBeenLastCalledWith(false);
    expect(backend.finish).not.toHaveBeenCalled();
    expect(backend.abort).toHaveBeenCalledTimes(1);
  });

  it('propagates a middle image materialization failure and restores export state', async () => {
    const backend = createMockBackend();
    playback.seek.mockRejectedValueOnce(new Error('Image layer "poster" failed to load'));

    await expect(engine.capture({
      fps: 60,
      rangeStart: 1,
      rangeEnd: 1 + 1 / 60,
      width: 1,
      height: 1,
      bitrateBps: 12_000_000,
      outputPath: '/tmp/test.mp4',
      codec: 'libx264',
      backend: backend as any,
      onProgress: vi.fn(),
    })).rejects.toThrow(/Image layer "poster" failed to load/);

    expect(stage.getApp().renderer.resize).toHaveBeenLastCalledWith(1280, 720, 2);
    expect(stage.resumeTicker).toHaveBeenCalled();
    expect(live2D.setExportMode).toHaveBeenLastCalledWith(false);
    expect(backend.abort).toHaveBeenCalledTimes(1);
  });

  it('aborts the backend when renderer capture fails', async () => {
    const backend = createMockBackend();
    stage.getApp().renderer.render.mockImplementationOnce(() => {
      throw new Error('renderer capture failed');
    });

    await expect(engine.capture({
      fps: 60,
      rangeStart: 1,
      rangeEnd: 1 + 1 / 60,
      width: 1,
      height: 1,
      bitrateBps: 12_000_000,
      outputPath: '/tmp/test.mp4',
      codec: 'libx264',
      backend: backend as any,
      onProgress: vi.fn(),
    })).rejects.toThrow('renderer capture failed');

    expect(backend.abort).toHaveBeenCalledTimes(1);
  });

  it('hides the subtitle layer during capture when includeSubtitles is false and restores it after', async () => {
    const backend = createMockBackend();
    const subtitleLayer = { visible: true };
    let visibleDuringRender: boolean | null = null;
    stage.getLayer = vi.fn((name: string) => (name === 'subtitle' ? subtitleLayer : null));
    stage.getApp().renderer.render = vi.fn(() => {
      if (visibleDuringRender === null) visibleDuringRender = subtitleLayer.visible;
    });

    await engine.capture({
      fps: 60,
      rangeStart: 0,
      rangeEnd: 1 / 60,
      width: 1920,
      height: 1080,
      bitrateBps: 12_000_000,
      outputPath: '/tmp/test.mp4',
      codec: 'libx264',
      backend: backend as any,
      onProgress: vi.fn(),
      includeSubtitles: false,
    });

    expect(stage.getLayer).toHaveBeenCalledWith('subtitle');
    expect(visibleDuringRender).toBe(false);
    expect(subtitleLayer.visible).toBe(true); // restored after capture
  });

  it('does not touch the subtitle layer when includeSubtitles is omitted (default true)', async () => {
    const backend = createMockBackend();
    const subtitleLayer = { visible: true };
    stage.getLayer = vi.fn(() => subtitleLayer);

    await engine.capture({
      fps: 60,
      rangeStart: 0,
      rangeEnd: 1 / 60,
      width: 1920,
      height: 1080,
      bitrateBps: 12_000_000,
      outputPath: '/tmp/test.mp4',
      codec: 'libx264',
      backend: backend as any,
      onProgress: vi.fn(),
    });

    expect(stage.getLayer).not.toHaveBeenCalled();
    expect(subtitleLayer.visible).toBe(true);
  });

  it('restores the subtitle layer visibility when capture fails', async () => {
    const backend = createMockBackend();
    const subtitleLayer = { visible: true };
    stage.getLayer = vi.fn(() => subtitleLayer);
    backend.init = vi.fn().mockRejectedValue(new Error('encoder init failed'));

    await expect(engine.capture({
      fps: 60,
      rangeStart: 0,
      rangeEnd: 1 / 60,
      width: 1920,
      height: 1080,
      bitrateBps: 12_000_000,
      outputPath: '/tmp/test.mp4',
      codec: 'libx264',
      backend: backend as any,
      onProgress: vi.fn(),
      includeSubtitles: false,
    })).rejects.toThrow('encoder init failed');

    expect(subtitleLayer.visible).toBe(true);
  });

  it('requests an alpha-preserving encode for subtitle-only exports', async () => {
    const backend = createMockBackend();
    stage.getLayer = vi.fn(() => ({ visible: true }));

    await engine.capture({
      fps: 60,
      rangeStart: 0,
      rangeEnd: 1 / 60,
      width: 1920,
      height: 1080,
      bitrateBps: 12_000_000,
      outputPath: '/tmp/test.webm',
      codec: 'libvpx-vp9',
      backend: backend as any,
      onProgress: vi.fn(),
      subtitleOnly: true,
    });

    expect(backend.init).toHaveBeenCalledWith(expect.objectContaining({
      transparent: true,
      codec: 'libvpx-vp9',
    }));
  });

  it('renders only the subtitle layer on a transparent background in subtitle-only mode', async () => {
    const backend = createMockBackend();
    const subtitleLayer = { visible: true };
    const renderTargets: unknown[] = [];
    stage.getLayer = vi.fn(() => subtitleLayer);
    const app = stage.getApp();
    app.renderer.render = vi.fn((target: unknown) => { renderTargets.push(target); });

    await engine.capture({
      fps: 60,
      rangeStart: 0,
      rangeEnd: 1 / 60,
      width: 1920,
      height: 1080,
      bitrateBps: 12_000_000,
      outputPath: '/tmp/test.webm',
      codec: 'libvpx-vp9',
      backend: backend as any,
      onProgress: vi.fn(),
      subtitleOnly: true,
    });

    expect(renderTargets.length).toBeGreaterThan(0);
    expect(renderTargets.every((target) => target === subtitleLayer)).toBe(true);
    expect(app.renderer.background.alpha).toBe(1); // restored after capture
  });

  it('clears the renderer background alpha during subtitle-only capture and restores it after', async () => {
    const backend = createMockBackend();
    let alphaDuringRender: number | null = null;
    stage.getLayer = vi.fn(() => ({ visible: true }));
    const app = stage.getApp();
    app.renderer.render = vi.fn(() => {
      if (alphaDuringRender === null) alphaDuringRender = app.renderer.background.alpha;
    });

    await engine.capture({
      fps: 60,
      rangeStart: 0,
      rangeEnd: 1 / 60,
      width: 1920,
      height: 1080,
      bitrateBps: 12_000_000,
      outputPath: '/tmp/test.webm',
      codec: 'libvpx-vp9',
      backend: backend as any,
      onProgress: vi.fn(),
      subtitleOnly: true,
    });

    expect(alphaDuringRender).toBe(0);
    expect(app.renderer.background.alpha).toBe(1);
  });

  it('rejects subtitle-only export when the subtitle layer is not mounted', async () => {
    const backend = createMockBackend();
    stage.getLayer = vi.fn(() => null);

    await expect(engine.capture({
      fps: 60,
      rangeStart: 0,
      rangeEnd: 1 / 60,
      width: 1920,
      height: 1080,
      bitrateBps: 12_000_000,
      outputPath: '/tmp/test.webm',
      codec: 'libvpx-vp9',
      backend: backend as any,
      onProgress: vi.fn(),
      subtitleOnly: true,
    })).rejects.toThrow(/subtitle layer/);
  });

  it('skips custom HTML animation capture for subtitle-only exports', async () => {
    const backend = createMockBackend();
    stage.getLayer = vi.fn(() => ({ visible: true }));
    customAnimMocks.getActiveAnimationCount.mockReturnValue(1);

    await engine.capture({
      fps: 60,
      rangeStart: 0,
      rangeEnd: 1 / 60,
      width: 1920,
      height: 1080,
      bitrateBps: 12_000_000,
      outputPath: '/tmp/test.webm',
      codec: 'libvpx-vp9',
      backend: backend as any,
      onProgress: vi.fn(),
      subtitleOnly: true,
    });

    expect(customAnimMocks.captureFrame).not.toHaveBeenCalled();
    expect(backend.finish).toHaveBeenCalledTimes(1);
  });

  it('renders only the subtitle layer on a chroma-green background in chroma mode', async () => {
    const backend = createMockBackend();
    const subtitleLayer = { visible: true };
    const renderTargets: unknown[] = [];
    const backgroundDuringRender: { color: number; alpha: number }[] = [];
    stage.getLayer = vi.fn(() => subtitleLayer);
    const app = stage.getApp();
    app.renderer.render = vi.fn((target: unknown) => {
      renderTargets.push(target);
      backgroundDuringRender.push({ ...app.renderer.background });
    });

    await engine.capture({
      fps: 60,
      rangeStart: 0,
      rangeEnd: 1 / 60,
      width: 1920,
      height: 1080,
      bitrateBps: 12_000_000,
      outputPath: '/tmp/test.mp4',
      codec: 'libx264',
      backend: backend as any,
      onProgress: vi.fn(),
      subtitleChroma: true,
    });

    expect(renderTargets.length).toBeGreaterThan(0);
    expect(renderTargets.every((target) => target === subtitleLayer)).toBe(true);
    expect(backgroundDuringRender.every((bg) => bg.color === 0x00ff00 && bg.alpha === 1)).toBe(true);
    // Background restored to its original state after capture
    expect(app.renderer.background.color).toBe(0x0a0a0f);
    expect(app.renderer.background.alpha).toBe(1);
  });

  it('does not request an alpha-preserving encode for chroma exports', async () => {
    const backend = createMockBackend();
    stage.getLayer = vi.fn(() => ({ visible: true }));

    await engine.capture({
      fps: 60,
      rangeStart: 0,
      rangeEnd: 1 / 60,
      width: 1920,
      height: 1080,
      bitrateBps: 12_000_000,
      outputPath: '/tmp/test.mp4',
      codec: 'libx264',
      backend: backend as any,
      onProgress: vi.fn(),
      subtitleChroma: true,
    });

    expect(backend.init).toHaveBeenCalledWith(expect.objectContaining({
      transparent: false,
      codec: 'libx264',
    }));
  });
});
