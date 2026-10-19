import type { ICaptureBackend, BackendInit, BackendFrame } from './ICaptureBackend';
import { ExportWriteQueue } from './ExportWriteQueue';
import { avccToAnnexB } from './avccToAnnexB';

interface ElectronExportAPI {
  startStreamExport(outputPath: string, options: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
  pushEncodedChunk(chunkData: Uint8Array): Promise<{ success: boolean; error?: string }>;
  endStreamExport(): Promise<{ success: boolean; error?: string }>;
}

// H.264 Table A-1 limits for Main profile. Keep level 4.2 as the minimum
// to preserve the existing 1080p configuration; larger output needs higher levels.
// https://chromium.googlesource.com/chromium/src/+/lkgr/media/parsers/h264_level_limits.cc
const H264_MAIN_LEVELS = [
  { level: 42, maxFrameMbs: 8704, maxMbsPerSecond: 522240, maxBitrate: 50_000_000 },
  { level: 50, maxFrameMbs: 22080, maxMbsPerSecond: 589824, maxBitrate: 135_000_000 },
  { level: 51, maxFrameMbs: 36864, maxMbsPerSecond: 983040, maxBitrate: 240_000_000 },
  { level: 52, maxFrameMbs: 36864, maxMbsPerSecond: 2073600, maxBitrate: 240_000_000 },
  { level: 60, maxFrameMbs: 139264, maxMbsPerSecond: 4177920, maxBitrate: 240_000_000 },
  { level: 61, maxFrameMbs: 139264, maxMbsPerSecond: 8355840, maxBitrate: 480_000_000 },
  { level: 62, maxFrameMbs: 139264, maxMbsPerSecond: 16711680, maxBitrate: 800_000_000 },
] as const;

function selectH264Codec(config: BackendInit): string {
  const widthMbs = Math.ceil(config.width / 16);
  const heightMbs = Math.ceil(config.height / 16);
  const frameMbs = widthMbs * heightMbs;
  const limits = H264_MAIN_LEVELS.find(candidate => (
    frameMbs <= candidate.maxFrameMbs
    && frameMbs * config.fps <= candidate.maxMbsPerSecond
    && Math.max(widthMbs, heightMbs) ** 2 <= candidate.maxFrameMbs * 8
    && config.bitrate <= candidate.maxBitrate
  ));
  if (!limits) {
    throw new Error(`Output ${config.width}×${config.height} at ${config.fps} fps and ${config.bitrate} bps exceeds H.264 level limits.`);
  }
  return `avc1.4D00${limits.level.toString(16).toUpperCase()}`;
}

export class WebCodecsBackend implements ICaptureBackend {
  private encoder: VideoEncoder | null = null;
  private encoderQueue = new ExportWriteQueue(8 * 1024 * 1024, 32);
  private isFirstChunk = true;
  private electronAPI: ElectronExportAPI;
  private encoderFailure: Error | null = null;
  private streamStarted = false;
  private streamFinished = false;

  constructor(electronAPI: ElectronExportAPI) {
    this.electronAPI = electronAPI;
  }

  async init(config: BackendInit): Promise<void> {
    const codec = selectH264Codec(config);
    // Start the backend FFmpeg stream for muxing Annex B data
    const result = await this.electronAPI.startStreamExport(config.outputPath, {
      fps: config.fps,
      codec: config.codec,
      width: config.width,
      height: config.height,
      crf: 18,
      isEncoded: true,
      bitrate: Math.round(config.bitrate / 1_000_000),
    });
    assertExportSuccess(result, 'FFmpeg stream start');

    this.isFirstChunk = true;
    this.encoderQueue = new ExportWriteQueue(8 * 1024 * 1024, 32);
    this.encoderFailure = null;
    this.streamStarted = true;
    this.streamFinished = false;

    try {
      this.encoder = new VideoEncoder({
        output: (chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) => {
          try {
            const chunkData = new Uint8Array(chunk.byteLength);
            chunk.copyTo(chunkData);
            const description = this.isFirstChunk ? metadata?.decoderConfig?.description : undefined;
            const annexB = avccToAnnexB(chunkData, description);
            if (description) this.isFirstChunk = false;
            this.encoderQueue.enqueue(annexB.byteLength, async () => {
              const pushResult = await this.electronAPI.pushEncodedChunk(annexB);
              assertExportSuccess(pushResult, 'FFmpeg encoded chunk push');
            });
          } catch (error) {
            this.encoderFailure = toError(error);
            this.encoderQueue.abort(this.encoderFailure);
          }
        },
        error: (e: Error) => {
          this.encoderFailure = e;
          this.encoderQueue.abort(e);
          console.error('[WebCodecs] Encoder error:', e);
        },
      });

      this.encoder.configure({
        codec,
        width: config.width,
        height: config.height,
        bitrate: config.bitrate,
        framerate: config.fps,
        latencyMode: 'quality',
        hardwareAcceleration: 'no-preference',
      });
    } catch (error) {
      await this.abort();
      throw error;
    }
  }

  async encodeFrame(frame: BackendFrame): Promise<void> {
    try {
      if (!this.encoder) throw new Error('WebCodecsBackend not initialized');
      if (this.encoderFailure) throw this.encoderFailure;
      if (!frame.canvas) throw new Error('WebCodecs requires canvas for VideoFrame');
      await this.encoderQueue.ready();

      // Backpressure: wait if encoder queue is backed up
      while (this.encoder.encodeQueueSize > 2) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (this.encoderFailure) throw this.encoderFailure;
        await this.encoderQueue.ready();
      }

      if (this.encoder.state === 'closed') {
        throw new Error('VideoEncoder unexpectedly closed');
      }

      const videoFrame = new VideoFrame(frame.canvas, {
        timestamp: frame.frameIndex * (1_000_000 / frame.fps),
      });
      try {
        this.encoder.encode(videoFrame, {
          keyFrame: frame.frameIndex % 60 === 0,
        });
      } finally {
        videoFrame.close();
      }

      if (this.encoderFailure) throw this.encoderFailure;

      // Output callbacks cannot pause the encoder. The queue limits active IPC
      // writes; pause frame submission while buffered output exceeds its budget.
      await this.encoderQueue.ready();
    } catch (error) {
      await this.abort();
      throw error;
    }
  }

  async finish(): Promise<void> {
    try {
      if (!this.encoder) throw new Error('WebCodecsBackend not initialized');
      if (this.encoderFailure) throw this.encoderFailure;
      await this.encoder.flush();
      await this.encoderQueue.drain();
      if (this.encoderFailure) throw this.encoderFailure;

      if (this.encoder.state !== 'closed') {
        this.encoder.close();
      }

      const result = await this.electronAPI.endStreamExport();
      this.streamFinished = true;
      assertExportSuccess(result, 'FFmpeg stream finish');
    } catch (error) {
      await this.abort();
      throw error;
    }
  }

  async abort(cancelled = false): Promise<void> {
    if (!this.streamStarted || this.streamFinished) return;
    this.streamFinished = true;
    this.encoderQueue.abort();
    try {
      if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    } catch {
      // The encoder may already be closed after a fatal error.
    }
    try {
      // User cancellation is terminated by ExportAdapter's cancelExport IPC.
      if (!cancelled) await this.electronAPI.endStreamExport();
    } catch {
      // Preserve the original capture failure while still attempting cleanup.
    }
  }
}

function assertExportSuccess(result: { success: boolean; error?: string } | undefined, operation: string): void {
  if (result?.success === true) return;
  throw new Error(result?.error || `${operation} failed`);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
