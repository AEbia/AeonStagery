/**
 * @vitest-environment jsdom
 *
 * ExportAdapter tests
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ExportAdapter } from '../api/adapters/ExportAdapter';
import type { ExportConfig } from '../api/types/export';
import { installMockExportEncoder, MockExportEncoder } from './helpers/MockExportEncoder';
import { SCENE_SCHEMA_VERSION, type PreparedCompiledScene } from '../api/types/semantic-scene';

function createMockStageAdapter() {
  return {
    getApp: vi.fn().mockReturnValue({
      canvas: document.createElement('canvas'),
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
    getCurrentTime: vi.fn().mockReturnValue(4),
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
    setLipSyncParameter: vi.fn(),
    clearLipSyncParameters: vi.fn(),
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
      endStreamExport: vi.fn().mockResolvedValue({ success: true, sizeBytes: 50_000 }),
      convert: vi.fn().mockResolvedValue({ success: true }),
      getTempDir: vi.fn().mockResolvedValue('/tmp'),
      getEncodingCapabilities: vi.fn().mockResolvedValue({ success: false, encoders: [] }),
    },
    fs: {
      stat: vi.fn().mockResolvedValue({ success: true, data: { isFile: true, sizeBytes: 50_000 } }),
      removeFile: vi.fn().mockResolvedValue({ success: true }),
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn().mockResolvedValue({ success: false }),
      writeFile: vi.fn().mockResolvedValue({ success: true }),
      copyFile: vi.fn().mockResolvedValue({ success: true }),
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
  afterEach(() => vi.unstubAllGlobals());
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

  function nativeConfig(overrides: Partial<ExportConfig> = {}): ExportConfig {
    return {
      format: 'mp4', codec: 'libx265', bitrateMbps: 8, fps: 30, width: 16, height: 16,
      rangeStart: 0, rangeEnd: 2 / 30, includeAudio: false, backend: 'webcodecs', outputPath: '/output/native.mp4',
      encoding: { videoCodec: 'hevc', implementation: 'auto', quality: 'balanced' }, ...overrides,
    };
  }

  it('samples through the real export pipeline without changing the dialog layout, and restores the playhead', async () => {
    installMockExportEncoder();
    documentStore.setPreparedScene(createPreparedScene());
    const addClass = vi.spyOn(document.body.classList, 'add');
    try {
      const sampling = adapter.estimateSize(nativeConfig({ encoding: { videoCodec: 'hevc', implementation: 'ffmpeg', quality: 'balanced' } }));
      const overlapping = await adapter.export(nativeConfig(), vi.fn());
      expect(overlapping).toMatchObject({ success: false });
      const result = await sampling;
      expect(result.bytes).toBe(50_000);
      expect(result.sampledFrames).toBe(2);
      expect(result.encoding?.implementation).toBe('ffmpeg');
      expect(electronAPI.export.startStreamExport).toHaveBeenCalledWith(
        expect.stringMatching(/size-sample-.+\.mp4$/), expect.objectContaining({ measureOnly: true }),
      );
      expect(electronAPI.fs.stat).not.toHaveBeenCalled();
      expect(electronAPI.fs.removeFile).not.toHaveBeenCalled();
      expect(playbackAdapter.seek).toHaveBeenLastCalledWith(4, true);
      expect(addClass).not.toHaveBeenCalledWith('is-exporting');
    } finally { addClass.mockRestore(); }
  });

  it('estimates supported WebCodecs VBR from target bitrate without sampling or applying CRF', async () => {
    installMockExportEncoder();
    const settings = nativeConfig({ rangeEnd: 10, encoding: {
      videoCodec: 'hevc', implementation: 'auto', quality: 'custom', rateControl: { mode: 'crf', crf: 10 },
    } });
    const estimate = await adapter.estimateSize(settings);
    expect(estimate).toMatchObject({ basis: 'bitrate', sampleCount: 0, bytes: 10_100_000 });
    expect(estimate.encoding?.implementation).toBe('webcodecs');
    const changed = await adapter.estimateSize({ ...settings, encoding: { ...settings.encoding!, rateControl: { mode: 'crf', crf: 40 } } });
    expect(changed.bytes).toBe(estimate.bytes);
    expect(electronAPI.export.startStreamExport).not.toHaveBeenCalled();
    expect(electronAPI.export.getTempDir).not.toHaveBeenCalled();
    expect(playbackAdapter.seek).not.toHaveBeenCalled();
  });

  it.each([
    ['hevc', 'webcodecs'], ['av1', 'webcodecs'], ['hevc', 'auto'], ['av1', 'auto'],
  ] as const)('does not sample a speculative FFmpeg fallback for %s in %s mode', async (videoCodec, implementation) => {
    installMockExportEncoder();
    MockExportEncoder.supports = candidate => candidate.codec.startsWith('avc1.');
    documentStore.setPreparedScene(createPreparedScene());
    const estimate = await adapter.estimateSize(nativeConfig({
      codec: videoCodec === 'hevc' ? 'libx265' : 'libaom-av1', rangeEnd: 10,
      encoding: { videoCodec, implementation, quality: 'balanced' },
    }));
    expect(estimate).toMatchObject({ basis: 'bitrate', sampleCount: 0, bytes: 10_100_000 });
    expect(estimate.encoding?.implementation).toBe('webcodecs');
    expect(electronAPI.export.getTempDir).not.toHaveBeenCalled();
    expect(electronAPI.export.startStreamExport).not.toHaveBeenCalled();
    expect(playbackAdapter.seek).not.toHaveBeenCalled();
    expect(MockExportEncoder.isConfigSupported).not.toHaveBeenCalled();
  });

  it('encodes the selected standard natively without a second video encode', async () => {
    installMockExportEncoder();
    documentStore.setPreparedScene(createPreparedScene());
    const result = await adapter.export(nativeConfig(), vi.fn());
    expect(result.success).toBe(true);
    expect(MockExportEncoder.configurations[0].codec).toMatch(/^hvc1\./);
    expect(electronAPI.export.startStreamExport).toHaveBeenCalledWith('/output/native.mp4', expect.objectContaining({ inputFormat: 'hevc' }));
    expect(electronAPI.export.convert).not.toHaveBeenCalled();
  });

  it.each(['ffmpeg', 'auto', 'webcodecs'] as const)('applies the dialog target bitrate to FFmpeg output in %s mode', async implementation => {
    installMockExportEncoder();
    MockExportEncoder.supports = () => false;
    documentStore.setPreparedScene(createPreparedScene());
    const result = await adapter.export(nativeConfig({
      bitrateMbps: 12.5,
      encoding: { videoCodec: 'hevc', implementation, quality: 'custom', rateControl: { mode: 'bitrate', bitrateMbps: 12.5 } },
    }), vi.fn());
    expect(result.success).toBe(true);
    expect(electronAPI.export.startStreamExport).toHaveBeenCalledWith('/output/native.mp4', expect.objectContaining({
      isEncoded: false, codec: 'libx265', bitrate: 12.5,
    }));
    expect(electronAPI.export.startStreamExport.mock.calls[0][1]).not.toHaveProperty('crf');
  });

  it.each([
    ['h264', 'libx264', 'h264'], ['hevc', 'libx265', 'hevc'],
    ['vp9', 'libvpx-vp9', 'ivf'], ['av1', 'libaom-av1', 'ivf'],
  ] as const)('accepts MKV with native %s encoding', async (videoCodec, codec, inputFormat) => {
    installMockExportEncoder();
    documentStore.setPreparedScene(createPreparedScene());
    const result = await adapter.export(nativeConfig({
      format: 'mkv', outputPath: '/output/native.mkv', codec,
      encoding: { videoCodec, implementation: 'auto', quality: 'balanced' },
    }), vi.fn());
    expect(result.success).toBe(true);
    expect(electronAPI.export.startStreamExport).toHaveBeenCalledWith('/output/native.mkv', expect.objectContaining({ inputFormat, audioCodec: 'aac' }));
    expect(result.encoding?.implementation).toBe('webcodecs');
    expect(electronAPI.export.convert).not.toHaveBeenCalled();
  });

  it('streams high-bitrate H.264 directly into a CRF-controlled VP9 transcode', async () => {
    installMockExportEncoder();
    MockExportEncoder.supports = config => config.codec.startsWith('avc1.');
    documentStore.setPreparedScene(createPreparedScene());
    const result = await adapter.export(nativeConfig({ format: 'webm', outputPath: '/output/final.webm', codec: 'libvpx-vp9', bitrateMbps: 2,
      encoding: { videoCodec: 'vp9', implementation: 'auto', quality: 'balanced', intermediateBitrateMbps: 40, rateControl: { mode: 'crf', crf: 29 } } }), vi.fn());
    expect(result.success).toBe(true);
    expect(electronAPI.export.startStreamExport).toHaveBeenCalledWith('/output/final.webm', expect.objectContaining({ inputFormat: 'h264', bitrate: 40, transcode: { codec: 'libvpx-vp9', crf: 29, speed: 'balanced' } }));
    expect(electronAPI.export.convert).not.toHaveBeenCalled();
    expect(result.encoding?.implementation).toBe('webcodecs-transcode');
    expect(electronAPI.fs.removeFile).not.toHaveBeenCalled();
  });

  it.each(['auto', 'webcodecs', 'ffmpeg'] as const)('selects hardware automatically when WebCodecs is unavailable in %s mode', async implementation => {
    vi.stubGlobal('VideoEncoder', undefined);
    documentStore.setPreparedScene(createPreparedScene());
    electronAPI.export.getEncodingCapabilities.mockResolvedValue({ success: true, encoders: ['libx265', 'hevc_qsv'] });
    const result = await adapter.export(nativeConfig({ encoding: {
      videoCodec: 'hevc', implementation, quality: 'balanced', rateControl: { mode: 'bitrate', bitrateMbps: 8 },
    } }), vi.fn());
    expect(result.success).toBe(true);
    expect(result.encoding).toMatchObject({ implementation: 'ffmpeg', encoder: 'hevc_qsv', attempt: 1 });
    expect(electronAPI.export.startStreamExport).toHaveBeenCalledWith('/output/native.mp4', expect.objectContaining({
      isEncoded: false, codec: 'hevc_qsv', bitrate: 8,
    }));
  });

  it('tries remaining available hardware before software after runtime initialization failures', async () => {
    vi.stubGlobal('VideoEncoder', undefined);
    documentStore.setPreparedScene(createPreparedScene());
    electronAPI.export.getEncodingCapabilities.mockResolvedValue({ success: true, encoders: ['hevc_nvenc', 'hevc_qsv', 'libx265'] });
    electronAPI.export.pushFrame
      .mockResolvedValueOnce({ success: false, error: 'Cannot load nvcuda.dll' })
      .mockResolvedValueOnce({ success: false, error: 'hevc_qsv: No capable devices found' });
    const result = await adapter.export(nativeConfig({ encoding: {
      videoCodec: 'hevc', implementation: 'auto', quality: 'balanced', ffmpegEncoder: 'auto',
      rateControl: { mode: 'bitrate', bitrateMbps: 8 },
    } }), vi.fn());
    expect(result.success).toBe(true);
    expect(electronAPI.export.startStreamExport.mock.calls.map(([, options]) => options.codec))
      .toEqual(['hevc_nvenc', 'hevc_qsv', 'libx265']);
    expect(result.encoding).toMatchObject({ encoder: 'libx265', attempt: 3 });
    expect(electronAPI.export.cancelExport).toHaveBeenCalledTimes(2);
  });

  it('uses automatic hardware encoding for the H.264 intermediate transcode', async () => {
    installMockExportEncoder();
    MockExportEncoder.supports = config => config.codec.startsWith('avc1.');
    documentStore.setPreparedScene(createPreparedScene());
    electronAPI.export.getEncodingCapabilities.mockResolvedValue({ success: true, encoders: ['hevc_qsv', 'libx265'] });
    const result = await adapter.export(nativeConfig({ encoding: {
      videoCodec: 'hevc', implementation: 'auto', quality: 'balanced', rateControl: { mode: 'bitrate', bitrateMbps: 8 },
    } }), vi.fn());
    expect(result.success).toBe(true);
    expect(result.encoding).toMatchObject({ implementation: 'webcodecs-transcode', encoder: 'hevc_qsv' });
    expect(electronAPI.export.startStreamExport).toHaveBeenCalledWith('/output/native.mp4', expect.objectContaining({
      inputFormat: 'h264', transcode: { codec: 'hevc_qsv', bitrate: 8, speed: 'balanced' },
    }));
  });

  it('uses software when the capability query rejects', async () => {
    vi.stubGlobal('VideoEncoder', undefined);
    documentStore.setPreparedScene(createPreparedScene());
    electronAPI.export.getEncodingCapabilities.mockRejectedValue(new Error('IPC unavailable'));
    const result = await adapter.export(nativeConfig({ encoding: {
      videoCodec: 'hevc', implementation: 'ffmpeg', quality: 'balanced', rateControl: { mode: 'bitrate', bitrateMbps: 8 },
    } }), vi.fn());
    expect(result.success).toBe(true);
    expect(result.encoding?.encoder).toBe('libx265');
  });

  it('skips the H.264 intermediate for high quality and passes CRF to raw-pixel encoding', async () => {
    installMockExportEncoder();
    MockExportEncoder.supports = () => false;
    documentStore.setPreparedScene(createPreparedScene());
    const result = await adapter.export(nativeConfig({ encoding: { videoCodec: 'hevc', implementation: 'auto', quality: 'high' } }), vi.fn());
    expect(result.success).toBe(true);
    expect(electronAPI.export.startStreamExport).toHaveBeenCalledTimes(1);
    expect(electronAPI.export.startStreamExport).toHaveBeenCalledWith('/output/native.mp4', expect.objectContaining({ isEncoded: false, codec: 'libx265', crf: 20 }));
    expect(MockExportEncoder.configurations).toHaveLength(0);
  });

  it('restarts capture with H.264 after a target encoder fails at runtime', async () => {
    installMockExportEncoder();
    MockExportEncoder.failCodec = 'hvc1.';
    documentStore.setPreparedScene(createPreparedScene());
    const result = await adapter.export(nativeConfig(), vi.fn());
    expect(result.success).toBe(true);
    expect(MockExportEncoder.configurations.map(config => config.codec.split('.')[0])).toEqual(['hvc1', 'avc1']);
    expect(electronAPI.export.cancelExport).toHaveBeenCalledTimes(1);
    expect(playbackAdapter.seek.mock.calls.filter(([time]) => time === 0).length).toBeGreaterThanOrEqual(2);
    expect(result.encoding?.attempt).toBe(2);
  });

  it('does not retry an output write failure as an encoder compatibility failure', async () => {
    installMockExportEncoder();
    documentStore.setPreparedScene(createPreparedScene());
    electronAPI.export.pushEncodedChunk.mockResolvedValue({ success: false, error: 'disk full' });
    const result = await adapter.export(nativeConfig(), vi.fn());
    expect(result.success).toBe(false);
    expect(result.error).toContain('disk full');
    expect(electronAPI.export.startStreamExport).toHaveBeenCalledTimes(1);
  });

  it('recaptures H.264 with software transcoding after a streaming hardware encoder failure', async () => {
    installMockExportEncoder();
    MockExportEncoder.supports = config => config.codec.startsWith('avc1.');
    documentStore.setPreparedScene(createPreparedScene());
    electronAPI.export.pushEncodedChunk.mockRejectedValueOnce(new Error('hevc_nvenc: No capable devices found'));
    const result = await adapter.export(nativeConfig({
      encoding: { videoCodec: 'hevc', implementation: 'auto', quality: 'balanced',
        ffmpegEncoder: 'hevc_nvenc', rateControl: { mode: 'bitrate', bitrateMbps: 8 } },
    }), vi.fn());
    expect(result.success).toBe(true);
    expect(result.encoding?.encoder).toBe('libx265');
    expect(electronAPI.export.startStreamExport.mock.calls.map(([, options]) => options.transcode?.codec)).toEqual(['hevc_nvenc', 'libx265']);
    expect(playbackAdapter.seek.mock.calls.filter(([time]) => time === 0).length).toBeGreaterThanOrEqual(2);
    expect(electronAPI.export.cancelExport).toHaveBeenCalledTimes(1);
    expect(electronAPI.export.convert).not.toHaveBeenCalled();
  });

  it('cancels the failed task without deleting the destination when encoder configuration fails', async () => {
    installMockExportEncoder();
    MockExportEncoder.failConfigureCodec = 'hvc1.';
    documentStore.setPreparedScene(createPreparedScene());
    const result = await adapter.export(nativeConfig(), vi.fn());
    expect(result.success).toBe(true);
    expect(electronAPI.export.cancelExport).toHaveBeenCalledTimes(1);
    expect(electronAPI.fs.removeFile).not.toHaveBeenCalled();
    expect(result.encoding?.implementation).toBe('webcodecs-transcode');
  });

  it('falls back to raw pixels once when neither native standard is supported', async () => {
    installMockExportEncoder();
    MockExportEncoder.supports = () => false;
    documentStore.setPreparedScene(createPreparedScene());
    const result = await adapter.export(nativeConfig(), vi.fn());
    expect(result.success).toBe(true);
    expect(result.encoding?.implementation).toBe('ffmpeg');
    expect(electronAPI.export.startStreamExport).toHaveBeenCalledTimes(1);
    expect(electronAPI.export.convert).not.toHaveBeenCalled();
  });

  it('mixes audio during native target capture without a second file pass', async () => {
    installMockExportEncoder();
    documentStore.setPreparedScene(createPreparedScene({ actions: [{
      id: 'voice', action: 'dialogue', time: 0, params: { voice: 'voice.wav', duration: 1, lipSync: 'none' },
      source: { statementId: 'voice', outputKey: 'primary' },
    }] }));
    electronAPI.fs.exists.mockResolvedValue(true);
    const result = await adapter.export(nativeConfig({ includeAudio: true }), vi.fn());
    expect(result.success).toBe(true);
    expect(electronAPI.export.startStreamExport).toHaveBeenCalledWith('/output/native.mp4', expect.objectContaining({ inputFormat: 'hevc', audioSources: [expect.objectContaining({ path: '/test/project/voice.wav' })], totalFrames: 2 }));
    expect(electronAPI.export.convert).not.toHaveBeenCalled();
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
      width: 16, height: 16, rangeStart: 0, rangeEnd: 1,
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
    expect(electronAPI.fs.removeFile).not.toHaveBeenCalled();
    expect(stageAdapter.resumeTicker).toHaveBeenCalled();
    expect(playbackAdapter.setSilentMode).toHaveBeenLastCalledWith(false);
    expect(live2DManager.setExportMode).toHaveBeenLastCalledWith(false);
    expect(progress.mock.calls.some(([p]: any[]) => p.phase === 'done')).toBe(false);

    const retry = await adapter.export({ ...config, includeAudio: false, rangeEnd: 1 / 60 }, vi.fn());
    expect(retry.success).toBe(true);
  });

  it('reports completion when cancellation races with successful finalization', async () => {
    documentStore.setPreparedScene(createPreparedScene());
    const controller = new AbortController();
    electronAPI.export.endStreamExport.mockImplementation(async () => {
      // Model the race where FFmpeg has closed and the main process has
      // dropped its active stream before the renderer receives the result.
      controller.abort();
      return { success: true };
    });

    const result = await adapter.export({
      format: 'mp4', codec: 'libx264', bitrateMbps: 12, fps: 60,
      width: 16, height: 16, rangeStart: 0, rangeEnd: 1 / 60,
      includeAudio: false, backend: 'rawpixels', outputPath: '/output/direct.mp4',
    }, vi.fn(), controller.signal);

    expect(result).toMatchObject({ success: true, outputPath: '/output/direct.mp4' });
    expect(electronAPI.export.cancelExport).toHaveBeenCalledTimes(1);
    expect(electronAPI.fs.removeFile).not.toHaveBeenCalled();
  });

  it('cancels stream finalization with audio and does not report completion', async () => {
    documentStore.setPreparedScene(createPreparedScene({ actions: [{
      id: 'voice', action: 'dialogue', time: 0,
      params: { text: 'Hello', speakerId: 'char1', voice: 'voice.wav', duration: 1, lipSync: 'none' },
      source: { statementId: 'voice', outputKey: 'primary' },
    } as any] }));
    electronAPI.fs.exists.mockResolvedValue(true);
    const controller = new AbortController();
    let settleFinalization!: (result: { success: boolean }) => void;
    electronAPI.export.endStreamExport.mockImplementation(() => {
      const result = new Promise<{ success: boolean }>((resolve) => { settleFinalization = resolve; });
      controller.abort();
      return result;
    });
    electronAPI.export.cancelExport.mockImplementation(async () => {
      settleFinalization({ success: false });
      return { success: true };
    });
    const progress = vi.fn();
    const result = await adapter.export({
      format: 'mp4', codec: 'libx265', bitrateMbps: 12, fps: 60,
      width: 16, height: 16, rangeStart: 0, rangeEnd: 1 / 60,
      includeAudio: true, backend: 'webcodecs', outputPath: '/output/test.mp4',
    }, progress, controller.signal);
    expect(result).toEqual({ success: false, cancelled: true });
    expect(electronAPI.export.endStreamExport).toHaveBeenCalledTimes(1);
    expect(electronAPI.export.convert).not.toHaveBeenCalled();
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
        width: 16, height: 16, rangeStart: 0.25, rangeEnd: 1,
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
        width: 16, height: 16, rangeStart: 0.25, rangeEnd: 0.5,
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
        width: 16, height: 16, rangeStart: 0.25, rangeEnd: 0.75,
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
    expect(electronAPI.export.startStreamExport).toHaveBeenCalledWith(
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

  it('exports directly when audio is requested but no sources are available', async () => {
    documentStore.setPreparedScene(createPreparedScene());
    const result = await adapter.export({
      format: 'mp4', codec: 'libx264', bitrateMbps: 12, fps: 60,
      width: 16, height: 16, rangeStart: 0, rangeEnd: 1 / 60,
      includeAudio: true, backend: 'rawpixels', outputPath: '/output/direct.mp4',
    }, vi.fn());
    expect(result).toEqual({ success: true, outputPath: '/output/direct.mp4' });
    expect(electronAPI.export.getTempDir).not.toHaveBeenCalled();
    expect(electronAPI.export.startStreamExport).toHaveBeenCalledWith('/output/direct.mp4', expect.anything());
    expect(electronAPI.fs.readFile).not.toHaveBeenCalled();
    expect(electronAPI.fs.writeFile).not.toHaveBeenCalled();
    expect(electronAPI.fs.copyFile).not.toHaveBeenCalled();
  });

  it.each([true, false])('returns stream finalization success=%s without creating a video intermediate', async (success) => {
    documentStore.setPreparedScene(createPreparedScene({ actions: [{
      id: 'voice', action: 'dialogue', time: 0,
      params: { voice: 'voice.wav', duration: 1, lipSync: 'none' },
      source: { statementId: 'voice', outputKey: 'primary' },
    }] }));
    electronAPI.fs.exists.mockResolvedValue(true);
    electronAPI.export.endStreamExport.mockResolvedValue({ success });
    const result = await adapter.export({
      format: 'mp4', codec: 'libx264', bitrateMbps: 12, fps: 60,
      width: 16, height: 16, rangeStart: 0, rangeEnd: 1 / 60,
      includeAudio: true, backend: 'rawpixels', outputPath: '/output/mixed.mp4',
    }, vi.fn());
    expect(result.success).toBe(success);
    expect(electronAPI.export.startStreamExport).toHaveBeenCalledWith('/output/mixed.mp4', expect.objectContaining({ audioSources: expect.any(Array) }));
    expect(electronAPI.export.getTempDir).not.toHaveBeenCalled();
    expect(electronAPI.fs.removeFile).not.toHaveBeenCalled();
    expect(electronAPI.fs.readFile).not.toHaveBeenCalled();
    expect(electronAPI.fs.exists).toHaveBeenCalledTimes(1);
  });

  it('stops before capturing frames when output space is insufficient', async () => {
    documentStore.setPreparedScene(createPreparedScene());
    electronAPI.export.startStreamExport.mockResolvedValue({ success: false, error: 'ENOSPC: 导出磁盘空间不足', failureKind: 'output' });
    const result = await adapter.export(nativeConfig(), vi.fn());
    expect(result.success).toBe(false);
    expect(result.error).toContain('ENOSPC');
    expect(electronAPI.export.startStreamExport).toHaveBeenCalledTimes(1);
    expect(electronAPI.export.pushFrame).not.toHaveBeenCalled();
    expect(electronAPI.export.pushEncodedChunk).not.toHaveBeenCalled();
    expect(electronAPI.fs.removeFile).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'failure'])('waits for main-process task cleanup before returning on %s', async (mode) => {
    documentStore.setPreparedScene(createPreparedScene({ actions: [{
      id: 'voice', action: 'dialogue', time: 0,
      params: { voice: 'voice.wav', duration: 1, lipSync: 'none' },
      source: { statementId: 'voice', outputKey: 'primary' },
    }] }));
    electronAPI.fs.exists.mockResolvedValue(true);
    const controller = new AbortController();
    let release!: () => void;
    let started!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => { started = resolve; });
    electronAPI.export.cancelExport.mockImplementation(async () => {
      started();
      await new Promise<void>((resolve) => { release = resolve; });
      return { success: true };
    });
    electronAPI.export.pushFrame.mockImplementationOnce(async () => {
      if (mode === 'failure') throw new Error('write failed');
      controller.abort();
      return { success: true };
    });
    const exporting = adapter.export({
      format: 'mp4', codec: 'libx264', bitrateMbps: 12, fps: 60,
      width: 16, height: 16, rangeStart: 0, rangeEnd: 1 / 60,
      includeAudio: true, backend: 'rawpixels', outputPath: '/output/test.mp4',
    }, vi.fn(), controller.signal);
    await cleanupStarted;
    expect(electronAPI.fs.removeFile).not.toHaveBeenCalled();
    release();
    const result = await exporting;
    expect(result).toMatchObject(mode === 'cancel'
      ? { success: false, cancelled: true }
      : { success: false, error: 'write failed' });
    expect(electronAPI.fs.removeFile).not.toHaveBeenCalled();
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
