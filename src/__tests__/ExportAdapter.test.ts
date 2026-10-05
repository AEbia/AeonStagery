/**
 * @vitest-environment jsdom
 *
 * ExportAdapter tests
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExportAdapter } from '../api/adapters/ExportAdapter';
import { SCENE_SCHEMA_VERSION, type PreparedCompiledScene } from '../api/types/semantic-scene';

function createMockStageAdapter() {
  return {
    getApp: vi.fn().mockReturnValue({
      renderer: {
        width: 1280,
        height: 720,
        render: vi.fn(),
        resize: vi.fn(),
        extract: { pixels: vi.fn().mockReturnValue(new Uint8Array(1280 * 720 * 4)) },
        // Pixi v8 shape: the renderer exposes `resetState()` (runner fan-out),
        // not v7's `state.reset()` / `texture.reset()`.
        resetState: vi.fn(),
        background: { color: 0x0a0a0f, alpha: 1 },
      },
      stage: {},
    }),
    pauseTicker: vi.fn(),
    resumeTicker: vi.fn(),
    getLayer: vi.fn((_name: string) => null as { visible: boolean } | null),
  };
}

function createMockPlaybackAdapter() {
  return {
    seek: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    getDuration: vi.fn().mockReturnValue(10),
    setSilentMode: vi.fn(),
    getMasterTimeline: vi.fn().mockReturnValue({
      seek: vi.fn(),
    }),
    getBasePath: vi.fn().mockReturnValue('/test/project'),
  };
}

function createMockLightingSystem() {
  return {
    reset: vi.fn(),
    syncEffects: vi.fn(),
  };
}

function createMockLive2DManager() {
  return {
    setExportMode: vi.fn(),
    waitForAllLoaded: vi.fn().mockResolvedValue(undefined),
    updateAll: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockCameraAdapter() {
  return {
    init: vi.fn(),
  };
}

function createMockDocumentStore() {
  const state = {
    preparedScene: null as PreparedCompiledScene | null,
  };
  return {
    filePath: null,
    getPreparedSceneSnapshot: vi.fn(() => state.preparedScene),
    setPreparedScene(scene: PreparedCompiledScene | null) {
      state.preparedScene = scene;
    },
  } as any;
}

function createPreparedScene(overrides: Partial<PreparedCompiledScene> = {}): PreparedCompiledScene {
  return {
    kind: 'prepared-compiled-scene',
    sourceSchemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'test',
    meta: { title: 'Test' },
    durationSeconds: 1,
    actions: [],
    ...overrides,
  };
}

function createMockElectronAPI() {
  return {
    export: {
      cancelExport: vi.fn().mockResolvedValue({ success: true }),
      startStreamExport: vi.fn().mockResolvedValue({ success: true }),
      pushEncodedChunk: vi.fn().mockResolvedValue({ success: true }),
      pushFrame: vi.fn().mockResolvedValue({ success: true }),
      endStreamExport: vi.fn().mockResolvedValue({ success: true }),
      convert: vi.fn().mockResolvedValue({ success: true }),
      getTempDir: vi.fn().mockResolvedValue('/tmp'),
    },
    fs: {
      removeFile: vi.fn().mockResolvedValue({ success: true }),
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn().mockResolvedValue({ success: false }),
      writeFile: vi.fn().mockResolvedValue({ success: true }),
    },
    dialog: {
      showSave: vi.fn().mockResolvedValue({ canceled: true }),
    },
    path: {
      join: vi.fn((...args: string[]) => Promise.resolve(args.join('/'))),
    },
  };
}

describe('ExportAdapter', () => {
  let adapter: ExportAdapter;
  let stageAdapter: ReturnType<typeof createMockStageAdapter>;
  let playbackAdapter: ReturnType<typeof createMockPlaybackAdapter>;
  let lightingSystem: ReturnType<typeof createMockLightingSystem>;
  let live2DManager: ReturnType<typeof createMockLive2DManager>;
  let cameraAdapter: ReturnType<typeof createMockCameraAdapter>;
  let documentStore: ReturnType<typeof createMockDocumentStore>;
  let electronAPI: ReturnType<typeof createMockElectronAPI>;

  beforeEach(() => {
    stageAdapter = createMockStageAdapter();
    playbackAdapter = createMockPlaybackAdapter();
    lightingSystem = createMockLightingSystem();
    live2DManager = createMockLive2DManager();
    cameraAdapter = createMockCameraAdapter();
    documentStore = createMockDocumentStore();
    electronAPI = createMockElectronAPI();

    adapter = new ExportAdapter(
      stageAdapter as any,
      cameraAdapter as any,
      playbackAdapter as any,
      lightingSystem as any,
      () => live2DManager,
      documentStore as any,
      electronAPI as any,
    );
  });

  it('constructor requires all dependencies', () => {
    expect(adapter).toBeDefined();
  });

  it('does not start an export when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await adapter.export({} as any, vi.fn(), controller.signal);
    expect(result).toEqual({ success: false, cancelled: true });
    expect(electronAPI.export.startStreamExport).not.toHaveBeenCalled();
    expect(electronAPI.export.cancelExport).not.toHaveBeenCalled();
  });

  it('cancels during capture, restores preview, and allows a subsequent export', async () => {
    documentStore.setPreparedScene(createPreparedScene());
    const controller = new AbortController();
    const config = {
      format: 'mp4' as const, codec: 'libx264', bitrateMbps: 12, fps: 60,
      width: 1, height: 1, rangeStart: 0, rangeEnd: 1,
      includeAudio: true, backend: 'rawpixels' as const, outputPath: '/output/test.mp4',
    };
    electronAPI.export.pushFrame.mockImplementationOnce(async () => {
      controller.abort();
      return { success: true };
    });
    const progress = vi.fn();
    const result = await adapter.export(config, progress, controller.signal);
    expect(result).toEqual({ success: false, cancelled: true });
    expect(electronAPI.export.cancelExport).toHaveBeenCalledTimes(1);
    expect(electronAPI.export.pushFrame).toHaveBeenCalledTimes(1);
    expect(electronAPI.export.convert).not.toHaveBeenCalled();
    expect(electronAPI.fs.removeFile).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/video_/));
    expect(stageAdapter.resumeTicker).toHaveBeenCalled();
    expect(playbackAdapter.setSilentMode).toHaveBeenLastCalledWith(false);
    expect(live2DManager.setExportMode).toHaveBeenLastCalledWith(false);
    expect(progress.mock.calls.some(([p]: any[]) => p.phase === 'done')).toBe(false);

    const retry = await adapter.export({ ...config, includeAudio: false, rangeEnd: 1 / 60 }, vi.fn());
    expect(retry.success).toBe(true);
  });

  it('cancels a running conversion and does not report completion', async () => {
    documentStore.setPreparedScene(createPreparedScene({ actions: [{
      id: 'voice', action: 'dialogue', time: 0,
      params: { text: 'Hello', speakerId: 'char1', voice: 'voice.wav', duration: 1, lipSync: 'none' },
      source: { statementId: 'voice', outputKey: 'primary' },
    } as any] }));
    electronAPI.fs.exists.mockResolvedValue(true);
    const controller = new AbortController();
    let settleConversion!: (result: { success: boolean }) => void;
    electronAPI.export.convert.mockImplementation(() => {
      const result = new Promise<{ success: boolean }>((resolve) => { settleConversion = resolve; });
      controller.abort();
      return result;
    });
    electronAPI.export.cancelExport.mockImplementation(async () => {
      settleConversion({ success: false });
      return { success: true };
    });
    const progress = vi.fn();
    const result = await adapter.export({
      format: 'mp4', codec: 'libx265', bitrateMbps: 12, fps: 60,
      width: 1, height: 1, rangeStart: 0, rangeEnd: 1 / 60,
      includeAudio: true, backend: 'webcodecs', outputPath: '/output/test.mp4',
    }, progress, controller.signal);
    expect(result).toEqual({ success: false, cancelled: true });
    expect(electronAPI.export.convert).toHaveBeenCalledTimes(1);
    expect(electronAPI.export.cancelExport).toHaveBeenCalledTimes(1);
    expect(progress.mock.calls.some(([p]) => p.phase === 'done')).toBe(false);
  });

  it.each([undefined, 'audio', 'none'])('samples voice mouth parameters at export frame time with lipSync=%s', async (lipSync) => {
    const setLipSyncParameter = vi.fn();
    Object.assign(live2DManager, { setLipSyncParameter, clearLipSyncParameters: vi.fn() });
    const samples = Float32Array.from({ length: 1000 }, (_, i) => i < 500 ? 0.2 : 0);
    const decodeAudioData = vi.fn().mockResolvedValue({
      sampleRate: 1000, length: samples.length, numberOfChannels: 1,
      getChannelData: () => samples,
    });
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decodeAudioData; });
    electronAPI.fs.exists.mockResolvedValue(true);
    electronAPI.fs.readFile.mockResolvedValue({ success: true, data: new ArrayBuffer(8) } as any);
    documentStore.setPreparedScene(createPreparedScene({ actions: [{
      id: 'voiced', action: 'dialogue', time: 0,
      params: { text: 'Hello', speakerId: 'char1', voice: 'voice.wav', duration: 1, lipSync },
      source: { statementId: 'voiced', outputKey: 'primary' },
    } as any] }));
    const frameMouth: number[] = [];
    live2DManager.updateAll.mockImplementation(async () => {
      frameMouth.push(Number(setLipSyncParameter.mock.calls.filter((call) => call[1] === 'PARAM_MOUTH_OPEN_Y').at(-1)?.[2] ?? 0));
    });
    try {
      const result = await adapter.export({
        format: 'mp4', codec: 'libx264', bitrateMbps: 12, fps: 4,
        width: 1, height: 1, rangeStart: 0.25, rangeEnd: 1,
        includeAudio: false, backend: 'rawpixels', outputPath: '/output/voice.mp4',
      }, vi.fn());
      expect(result.success).toBe(true);
      if (lipSync === 'none') {
        expect(setLipSyncParameter).not.toHaveBeenCalled();
        expect(decodeAudioData).not.toHaveBeenCalled();
      } else {
        expect(frameMouth[0]).toBeGreaterThan(0);
        expect(decodeAudioData).toHaveBeenCalledTimes(1);
        expect(electronAPI.fs.readFile).toHaveBeenCalledWith('/test/project/voice.wav');
      }
      expect(frameMouth.at(-1)).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['missing', 'undecodable'])('keeps export available when a dialogue voice is %s', async (failure) => {
    const setLipSyncParameter = vi.fn();
    Object.assign(live2DManager, { setLipSyncParameter, clearLipSyncParameters: vi.fn() });
    electronAPI.fs.readFile.mockResolvedValue({ success: true, data: new ArrayBuffer(8) } as any);
    electronAPI.fs.exists.mockResolvedValue(failure !== 'missing');
    vi.stubGlobal('OfflineAudioContext', class {
      decodeAudioData = async () => { throw new Error('Unsupported audio format'); };
    });
    documentStore.setPreparedScene(createPreparedScene({ actions: [{
      id: 'missing-voice', action: 'dialogue', time: 0,
      params: { text: 'Hello', speakerId: 'char1', voice: 'missing.wav', duration: 1 },
      source: { statementId: 'missing-voice', outputKey: 'primary' },
    } as any] }));
    try {
      const result = await adapter.export({
        format: 'mp4', codec: 'libx264', bitrateMbps: 12, fps: 4,
        width: 1, height: 1, rangeStart: 0.25, rangeEnd: 0.5,
        includeAudio: true, backend: 'rawpixels', outputPath: '/output/missing-voice.mp4',
      }, vi.fn());
      expect(result.success).toBe(true);
      expect(setLipSyncParameter.mock.calls.some((call) => call[2] > 0)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('releases the voice mouth before seeking into same-speaker text dialogue', async () => {
    let mouth = 0;
    Object.assign(live2DManager, {
      setLipSyncParameter: (_id: string, _parameter: string, value: number) => { mouth = value; },
      clearLipSyncParameters: vi.fn(),
    });
    const samples = new Float32Array(1000).fill(0.2);
    vi.stubGlobal('OfflineAudioContext', class {
      decodeAudioData = async () => ({ sampleRate: 1000, length: 1000, numberOfChannels: 1, getChannelData: () => samples });
    });
    electronAPI.fs.exists.mockResolvedValue(true);
    electronAPI.fs.readFile.mockResolvedValue({ success: true, data: new ArrayBuffer(8) } as any);
    documentStore.setPreparedScene(createPreparedScene({ actions: [
      { id: 'voice', action: 'dialogue', time: 0, params: { text: 'Voice', speakerId: 'char1', voice: 'voice.wav', duration: 0.5 } },
      { id: 'text', action: 'dialogue', time: 0.5, params: { text: 'Text', speakerId: 'char1', duration: 0.5 } },
    ] as any }));
    playbackAdapter.seek.mockImplementation(async (time: number) => { if (time >= 0.5) mouth = 0.3; });
    const renderedMouth: number[] = [];
    live2DManager.updateAll.mockImplementation(async () => { renderedMouth.push(mouth); });
    try {
      const result = await adapter.export({
        format: 'mp4', codec: 'libx264', bitrateMbps: 12, fps: 4,
        width: 1, height: 1, rangeStart: 0.25, rangeEnd: 0.75,
        includeAudio: false, backend: 'rawpixels', outputPath: '/output/handoff.mp4',
      }, vi.fn());
      expect(result.success).toBe(true);
      expect(renderedMouth[0]).toBeGreaterThan(0);
      expect(renderedMouth[1]).toBe(0.3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('export returns ExportResult with success: false if no prepared semantic scene exists', async () => {
    const onProgress = vi.fn();
    const result = await adapter.export(
      {
        format: 'mp4',
        codec: 'libx264',
        bitrateMbps: 12,
        fps: 60,
        width: 1920,
        height: 1080,
        rangeStart: 0,
        rangeEnd: 10,
        includeAudio: false,
        backend: 'rawpixels',
        outputPath: '/output/test.mp4',
      },
      onProgress,
    );

    expect(result.success).toBe(false);
  });

  it('export calls onProgress with phase: "capture" at start and "done" at finish', async () => {
    documentStore.setPreparedScene(createPreparedScene());

    const progressCalls: any[] = [];
    const onProgress = vi.fn((p) => progressCalls.push(p));

    const result = await adapter.export(
      {
        format: 'mp4',
        codec: 'libx264',
        bitrateMbps: 12,
        fps: 60,
        width: 1920,
        height: 1080,
        rangeStart: 0,
        rangeEnd: 1 / 60, // single frame
        includeAudio: false,
        backend: 'rawpixels',
        outputPath: '/output/test.mp4',
      },
      onProgress,
    );

    expect(result.success).toBe(true);
    expect(onProgress).toHaveBeenCalled();
    const captureCalls = progressCalls.filter(c => c.phase === 'capture');
    expect(captureCalls.length).toBeGreaterThan(0);

    const lastCall = progressCalls[progressCalls.length - 1];
    expect(lastCall.phase).toBe('done');
  });

  it('passes prepared dialogue voices to the final FFmpeg mix', async () => {
    documentStore.setPreparedScene(createPreparedScene({
      actions: [{
        id: 'dialogue-1',
        time: 0,
        action: 'dialogue',
        source: { statementId: 'dialogue-1', outputKey: 'primary' },
        params: {
          text: 'Hello',
          duration: 1,
          voice: 'voice/line.wav',
        },
      } as any],
    }));
    electronAPI.fs.exists.mockResolvedValue(true);

    const result = await adapter.export(
      {
        format: 'mp4',
        codec: 'libx264',
        bitrateMbps: 12,
        fps: 60,
        width: 1920,
        height: 1080,
        rangeStart: 0,
        rangeEnd: 1 / 60,
        includeAudio: true,
        backend: 'rawpixels',
        outputPath: '/output/with-voice.mp4',
      },
      vi.fn(),
    );

    expect(result.success).toBe(true);
    expect(electronAPI.export.convert).toHaveBeenCalledWith(
      expect.stringContaining('/tmp/video_'),
      '/output/with-voice.mp4',
      expect.objectContaining({
        audioSources: [{
          path: '/test/project/voice/line.wav',
          delayMs: 0,
          duration: 1,
        }],
      }),
    );
  });

  it('returns failure and never reports done when the FFmpeg stream rejects a frame', async () => {
    documentStore.setPreparedScene(createPreparedScene());
    electronAPI.export.pushFrame.mockRejectedValue(new Error('FFmpeg stream broke'));

    const progressCalls: any[] = [];
    const result = await adapter.export(
      {
        format: 'mp4',
        codec: 'libx264',
        bitrateMbps: 12,
        fps: 60,
        width: 1920,
        height: 1080,
        rangeStart: 0,
        rangeEnd: 1 / 60,
        includeAudio: false,
        backend: 'rawpixels',
        outputPath: '/output/failed-stream.mp4',
      },
      (progress) => progressCalls.push(progress),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('FFmpeg stream broke');
    expect(progressCalls.some((progress) => progress.phase === 'done')).toBe(false);
  });

  it('returns failure when the stream start result is unsuccessful', async () => {
    documentStore.setPreparedScene(createPreparedScene());
    electronAPI.export.startStreamExport.mockResolvedValue({
      success: false,
      error: 'FFmpeg executable unavailable',
    });

    const progressCalls: any[] = [];
    const result = await adapter.export(
      {
        format: 'mp4',
        codec: 'libx264',
        bitrateMbps: 12,
        fps: 60,
        width: 1920,
        height: 1080,
        rangeStart: 0,
        rangeEnd: 1 / 60,
        includeAudio: false,
        backend: 'rawpixels',
        outputPath: '/output/start-failed.mp4',
      },
      (progress) => progressCalls.push(progress),
    );

    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: expect.stringContaining('FFmpeg executable unavailable'),
    }));
    expect(progressCalls.some((progress) => progress.phase === 'done')).toBe(false);
  });

  it('returns failure when a successful push response carries success:false', async () => {
    documentStore.setPreparedScene(createPreparedScene());
    electronAPI.export.pushFrame.mockResolvedValue({
      success: false,
      error: 'FFmpeg rejected the frame',
    });

    const progressCalls: any[] = [];
    const result = await adapter.export(
      {
        format: 'mp4',
        codec: 'libx264',
        bitrateMbps: 12,
        fps: 60,
        width: 1920,
        height: 1080,
        rangeStart: 0,
        rangeEnd: 1 / 60,
        includeAudio: false,
        backend: 'rawpixels',
        outputPath: '/output/push-failed.mp4',
      },
      (progress) => progressCalls.push(progress),
    );

    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: expect.stringContaining('FFmpeg rejected the frame'),
    }));
    expect(progressCalls.some((progress) => progress.phase === 'done')).toBe(false);
  });

  it('returns failure and never reports done when the temporary video copy fails', async () => {
    documentStore.setPreparedScene(createPreparedScene());
    electronAPI.fs.readFile.mockResolvedValue({
      success: true,
      data: new ArrayBuffer(4),
    });
    electronAPI.fs.writeFile.mockResolvedValue({
      success: false,
      error: 'destination is not writable',
    });

    const progressCalls: any[] = [];
    const result = await adapter.export(
      {
        format: 'mp4',
        codec: 'libx264',
        bitrateMbps: 12,
        fps: 60,
        width: 1920,
        height: 1080,
        rangeStart: 0,
        rangeEnd: 1 / 60,
        includeAudio: true,
        backend: 'rawpixels',
        outputPath: '/output/copy-failed.mp4',
      },
      (progress) => progressCalls.push(progress),
    );

    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: 'destination is not writable',
    }));
    expect(progressCalls.some((progress) => progress.phase === 'done')).toBe(false);
  });

  it('accepts MOV + Apple ProRes 4444 for subtitle-only exports', async () => {
    documentStore.setPreparedScene(createPreparedScene());
    stageAdapter.getLayer = vi.fn(() => ({ visible: true }));
    electronAPI.export.startStreamExport.mockResolvedValue({ success: true });

    const result = await adapter.export(
      {
        format: 'mov',
        codec: 'prores_ks',
        bitrateMbps: 12,
        fps: 60,
        width: 1920,
        height: 1080,
        rangeStart: 0,
        rangeEnd: 1 / 60,
        includeAudio: false,
        backend: 'webcodecs', // must be overridden to RawPixels
        outputPath: '/output/subtitles.mov',
        subtitleOnly: true,
      },
      () => {},
    );

    expect(result.success).toBe(true);
    expect(electronAPI.export.startStreamExport).toHaveBeenCalledWith(
      '/output/subtitles.mov',
      expect.objectContaining({
        codec: 'prores_ks',
        isEncoded: false,
        transparent: true,
      }),
    );
    expect(electronAPI.export.pushFrame).toHaveBeenCalled();
  });

  it('rejects subtitle-only exports with an incompatible codec/container pairing', async () => {
    documentStore.setPreparedScene(createPreparedScene());
    stageAdapter.getLayer = vi.fn(() => ({ visible: true }));

    const movWithVp9 = await adapter.export(
      {
        format: 'mov',
        codec: 'libvpx-vp9',
        bitrateMbps: 12,
        fps: 60,
        width: 1920,
        height: 1080,
        rangeStart: 0,
        rangeEnd: 1 / 60,
        includeAudio: false,
        backend: 'rawpixels',
        outputPath: '/output/subtitles.mov',
        subtitleOnly: true,
      },
      () => {},
    );

    expect(movWithVp9.success).toBe(false);
    expect(movWithVp9.error).toContain('ProRes');

    const webmWithVp9 = await adapter.export(
      {
        format: 'webm',
        codec: 'libvpx-vp9',
        bitrateMbps: 12,
        fps: 60,
        width: 1920,
        height: 1080,
        rangeStart: 0,
        rangeEnd: 1 / 60,
        includeAudio: false,
        backend: 'rawpixels',
        outputPath: '/output/subtitles.webm',
        subtitleOnly: true,
      },
      () => {},
    );

    expect(webmWithVp9.success).toBe(false);
    expect(webmWithVp9.error).toContain('ProRes');

    const webmWithProRes = await adapter.export(
      {
        format: 'webm',
        codec: 'prores_ks',
        bitrateMbps: 12,
        fps: 60,
        width: 1920,
        height: 1080,
        rangeStart: 0,
        rangeEnd: 1 / 60,
        includeAudio: false,
        backend: 'rawpixels',
        outputPath: '/output/subtitles.webm',
        subtitleOnly: true,
      },
      () => {},
    );

    expect(webmWithProRes.success).toBe(false);
    expect(webmWithProRes.error).toContain('MOV');
  });

  it('accepts MP4 + H.264 for chroma-green subtitle exports without alpha', async () => {
    documentStore.setPreparedScene(createPreparedScene());
    stageAdapter.getLayer = vi.fn(() => ({ visible: true }));
    electronAPI.export.startStreamExport.mockResolvedValue({ success: true });

    const result = await adapter.export(
      {
        format: 'mp4',
        codec: 'libx264',
        bitrateMbps: 12,
        fps: 60,
        width: 1920,
        height: 1080,
        rangeStart: 0,
        rangeEnd: 1 / 60,
        includeAudio: false,
        backend: 'webcodecs', // must be overridden to RawPixels
        outputPath: '/output/subtitles.mp4',
        subtitleChroma: true,
      },
      () => {},
    );

    expect(result.success).toBe(true);
    expect(electronAPI.export.startStreamExport).toHaveBeenCalledWith(
      '/output/subtitles.mp4',
      expect.objectContaining({
        codec: 'libx264',
        isEncoded: false,
      }),
    );
    // Chroma exports never request alpha preservation
    const streamOptions = electronAPI.export.startStreamExport.mock.calls[0][1];
    expect(streamOptions).not.toHaveProperty('transparent');
    expect(electronAPI.export.pushFrame).toHaveBeenCalled();
  });

  it('rejects chroma subtitle exports that do not use MP4 + H.264', async () => {
    documentStore.setPreparedScene(createPreparedScene());
    stageAdapter.getLayer = vi.fn(() => ({ visible: true }));

    const chromaWebm = await adapter.export(
      {
        format: 'webm',
        codec: 'libvpx-vp9',
        bitrateMbps: 12,
        fps: 60,
        width: 1920,
        height: 1080,
        rangeStart: 0,
        rangeEnd: 1 / 60,
        includeAudio: false,
        backend: 'rawpixels',
        outputPath: '/output/subtitles.webm',
        subtitleChroma: true,
      },
      () => {},
    );

    expect(chromaWebm.success).toBe(false);
    expect(chromaWebm.error).toContain('H.264');
  });

  it('rejects enabling both transparent and chroma subtitle backgrounds', async () => {
    documentStore.setPreparedScene(createPreparedScene());
    stageAdapter.getLayer = vi.fn(() => ({ visible: true }));

    const result = await adapter.export(
      {
        format: 'mov',
        codec: 'prores_ks',
        bitrateMbps: 12,
        fps: 60,
        width: 1920,
        height: 1080,
        rangeStart: 0,
        rangeEnd: 1 / 60,
        includeAudio: false,
        backend: 'rawpixels',
        outputPath: '/output/subtitles.mov',
        subtitleOnly: true,
        subtitleChroma: true,
      },
      () => {},
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('二选一');
  });

  it('rejects subtitle-only exports with a non-MOV container', async () => {
    documentStore.setPreparedScene(createPreparedScene());

    const result = await adapter.export(
      {
        format: 'mp4',
        codec: 'libvpx-vp9',
        bitrateMbps: 12,
        fps: 60,
        width: 1920,
        height: 1080,
        rangeStart: 0,
        rangeEnd: 1 / 60,
        includeAudio: false,
        backend: 'rawpixels',
        outputPath: '/output/subtitles.mp4',
        subtitleOnly: true,
      },
      () => {},
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('MOV');
  });

  it('rejects subtitle-only exports with a non-ProRes 4444 codec', async () => {
    documentStore.setPreparedScene(createPreparedScene());

    const result = await adapter.export(
      {
        format: 'webm',
        codec: 'libx264',
        bitrateMbps: 12,
        fps: 60,
        width: 1920,
        height: 1080,
        rangeStart: 0,
        rangeEnd: 1 / 60,
        includeAudio: false,
        backend: 'rawpixels',
        outputPath: '/output/subtitles.webm',
        subtitleOnly: true,
      },
      () => {},
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('ProRes');
  });
});
