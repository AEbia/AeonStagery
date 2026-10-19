import { describe, expect, it, vi } from 'vitest';
import { RawPixelsBackend } from '../engine/export/RawPixelsBackend';
import { WebCodecsBackend } from '../engine/export/WebCodecsBackend';

function createExportApi() {
  return {
    startStreamExport: vi.fn().mockResolvedValue({ success: true }),
    pushFrame: vi.fn().mockResolvedValue({ success: true }),
    pushEncodedChunk: vi.fn().mockResolvedValue({ success: true }),
    endStreamExport: vi.fn().mockResolvedValue({ success: true }),
  };
}

function createInitConfig() {
  return {
    width: 2,
    height: 2,
    fps: 60,
    bitrate: 12_000_000,
    outputPath: '/tmp/capture.mp4',
    codec: 'libx264',
    isEncoded: false,
  };
}

function withMockWebCodecs(run: () => Promise<void>) {
  const previousVideoEncoder = (globalThis as any).VideoEncoder;
  const previousVideoFrame = (globalThis as any).VideoFrame;

  (globalThis as any).VideoEncoder = MockVideoEncoder;
  (globalThis as any).VideoFrame = MockVideoFrame;

  return run().finally(() => {
    if (previousVideoEncoder) (globalThis as any).VideoEncoder = previousVideoEncoder;
    else delete (globalThis as any).VideoEncoder;
    if (previousVideoFrame) (globalThis as any).VideoFrame = previousVideoFrame;
    else delete (globalThis as any).VideoFrame;
    MockVideoEncoder.instances = [];
  });
}

class MockVideoFrame {
  readonly timestamp: number;
  closed = false;

  constructor(readonly canvas: HTMLCanvasElement, options: { timestamp: number }) {
    this.timestamp = options.timestamp;
  }

  close(): void {
    this.closed = true;
  }
}

class MockEncodedVideoChunk {
  readonly byteLength: number;

  constructor(private readonly bytes: Uint8Array, readonly timestamp: number) {
    this.byteLength = bytes.byteLength;
  }

  copyTo(destination: Uint8Array): void {
    destination.set(this.bytes);
  }
}

class MockVideoEncoder {
  static isConfigSupported = vi.fn(async (config: VideoEncoderConfig) => ({ supported: true, config }));
  static instances: MockVideoEncoder[] = [];
  state = 'configured';
  encodeQueueSize = 0;
  configuredWith: unknown = null;
  encodedFrames: Array<{ frame: MockVideoFrame; options: unknown }> = [];

  constructor(private readonly init: { output: Function; error: Function }) {
    MockVideoEncoder.instances.push(this);
  }

  configure(config: unknown): void {
    this.configuredWith = config;
  }

  encode(frame: MockVideoFrame, options: unknown): void {
    this.encodedFrames.push({ frame, options });
    const chunk = new MockEncodedVideoChunk(new Uint8Array([0, 0, 0, 2, 0xaa, 0xbb]), frame.timestamp);
    const metadata = {
      decoderConfig: {
        description: new Uint8Array([
          1, 0x4d, 0, 0x2a, 0xff, 0xe1,
          0, 2, 0x67, 0x64,
          1,
          0, 1, 0x68,
        ]).buffer,
      },
    };
    this.init.output(chunk, metadata);
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.state = 'closed';
  }
}

describe('capture backend stream cleanup', () => {
  it('RawPixelsBackend exposes abort cleanup and rejects a failed finish result', async () => {
    const api = createExportApi();
    const backend = new RawPixelsBackend(api);

    await backend.init(createInitConfig());
    api.endStreamExport.mockResolvedValueOnce({ success: false, error: 'stream cleanup failed' });
    await expect(backend.abort()).resolves.toBeUndefined();
    expect(api.endStreamExport).toHaveBeenCalledTimes(1);

    const finishApi = createExportApi();
    const finishBackend = new RawPixelsBackend(finishApi);
    await finishBackend.init(createInitConfig());
    finishApi.endStreamExport.mockResolvedValue({ success: false, error: 'stream finish failed' });

    await expect(finishBackend.finish()).rejects.toThrow('stream finish failed');
  });

  it('WebCodecsBackend exposes abort cleanup and rejects a failed finish result', async () => {
    await withMockWebCodecs(async () => {
      const api = createExportApi();
      const backend = new WebCodecsBackend(api);

      await backend.init(createInitConfig());
      api.endStreamExport.mockResolvedValueOnce({ success: false, error: 'stream cleanup failed' });
      await expect(backend.abort()).resolves.toBeUndefined();
      expect(api.endStreamExport).toHaveBeenCalledTimes(1);

      const finishApi = createExportApi();
      const finishBackend = new WebCodecsBackend(finishApi);
      await finishBackend.init(createInitConfig());
      finishApi.endStreamExport.mockResolvedValue({ success: false, error: 'stream finish failed' });

      await expect(finishBackend.finish()).rejects.toThrow('stream finish failed');
    });
  });

  it('user cancellation closes WebCodecs without flushing the cancelled FFmpeg stream', async () => {
    await withMockWebCodecs(async () => {
      const api = createExportApi();
      const backend = new WebCodecsBackend(api);
      await backend.init(createInitConfig());
      await backend.abort(true);
      expect(MockVideoEncoder.instances[0].state).toBe('closed');
      expect(api.endStreamExport).not.toHaveBeenCalled();
      await backend.abort(true);
      expect(api.endStreamExport).not.toHaveBeenCalled();
    });
  });

  it('user cancellation releases queued raw writes without finalizing the cancelled stream', async () => {
    const api = createExportApi();
    let rejectWrite!: (reason: Error) => void;
    api.pushFrame.mockImplementation(() => new Promise((_resolve, reject) => { rejectWrite = reject; }));
    const backend = new RawPixelsBackend(api);
    await backend.init(createInitConfig());
    await backend.encodeFrame({ pixels: new Uint8Array(16), frameIndex: 0, fps: 60 });
    await backend.abort(true);
    rejectWrite(new Error('Export cancelled'));
    expect(api.endStreamExport).not.toHaveBeenCalled();
    await backend.abort(true);
  });

  it('WebCodecsBackend rejects frame encoding before initialization without touching the stream', async () => {
    await withMockWebCodecs(async () => {
      const api = createExportApi();
      const backend = new WebCodecsBackend(api);

      await expect(backend.encodeFrame({
        canvas: {} as HTMLCanvasElement,
        frameIndex: 0,
        fps: 60,
      })).rejects.toThrow('WebCodecsBackend not initialized');

      expect(api.endStreamExport).not.toHaveBeenCalled();
    });
  });

  it('WebCodecsBackend surfaces FFmpeg stream start failure before constructing an encoder', async () => {
    await withMockWebCodecs(async () => {
      const api = createExportApi();
      api.startStreamExport.mockResolvedValueOnce({ success: false, error: 'stream start failed' });
      const backend = new WebCodecsBackend(api);

      await expect(backend.init(createInitConfig())).rejects.toThrow('stream start failed');

      expect(MockVideoEncoder.instances).toHaveLength(0);
      expect(api.endStreamExport).not.toHaveBeenCalled();
    });
  });

  it.each([
    [1920, 1080, 60, 12_000_000, '2A'],
    [2560, 1440, 30, 12_000_000, '32'],
    [2560, 1440, 60, 12_000_000, '33'],
    [1440, 2560, 60, 12_000_000, '33'],
    [3840, 2160, 30, 40_000_000, '33'],
    [3840, 2160, 60, 40_000_000, '34'],
    [3840, 2160, 120, 40_000_000, '3C'],
    [7680, 4320, 60, 40_000_000, '3D'],
    [7680, 4320, 120, 40_000_000, '3E'],
    [1920, 1080, 60, 60_000_000, '32'],
    [8192, 16, 30, 12_000_000, '33'],
  ])('selects a compatible H.264 level for %ix%i at %i fps and %i bps', async (width, height, fps, bitrate, level) => {
    await withMockWebCodecs(async () => {
      const backend = new WebCodecsBackend(createExportApi());
      await backend.init({ ...createInitConfig(), width, height, fps, bitrate });
      expect(MockVideoEncoder.instances[0].configuredWith).toEqual(expect.objectContaining({
        codec: `avc1.4D00${level}`, width, height, framerate: fps, bitrate,
      }));
      await backend.abort();
    });
  });

  it('rejects output beyond H.264 level limits before starting the stream', async () => {
    await withMockWebCodecs(async () => {
      const api = createExportApi();
      const backend = new WebCodecsBackend(api);
      await expect(backend.init({ ...createInitConfig(), width: 8192, height: 8192 }))
        .rejects.toThrow('H.264 level');
      expect(api.startStreamExport).not.toHaveBeenCalled();
      expect(MockVideoEncoder.instances).toHaveLength(0);
    });
  });

  it('WebCodecsBackend encodes canvas frames as Annex B chunks and closes frame handles', async () => {
    await withMockWebCodecs(async () => {
      const api = createExportApi();
      const backend = new WebCodecsBackend(api);

      await backend.init(createInitConfig());
      await backend.encodeFrame({
        canvas: {} as HTMLCanvasElement,
        frameIndex: 0,
        fps: 60,
      });
      await backend.finish();

      const encoder = MockVideoEncoder.instances[0];
      expect(encoder.configuredWith).toEqual(expect.objectContaining({
        width: 2,
        height: 2,
        bitrate: 12_000_000,
        framerate: 60,
      }));
      expect(encoder.encodedFrames[0].options).toEqual({ keyFrame: true });
      expect(encoder.encodedFrames[0].frame.timestamp).toBe(0);
      expect(encoder.encodedFrames[0].frame.closed).toBe(true);
      expect(api.pushEncodedChunk).toHaveBeenCalledWith(new Uint8Array([
        0, 0, 0, 1, 0x67, 0x64,
        0, 0, 0, 1, 0x68,
        0, 0, 0, 1, 0xaa, 0xbb,
      ]));
      expect(api.endStreamExport).toHaveBeenCalledTimes(1);
    });
  });
});
