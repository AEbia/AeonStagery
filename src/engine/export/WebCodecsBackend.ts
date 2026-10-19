import type { ICaptureBackend, BackendInit, BackendFrame } from './ICaptureBackend';
import { ExportWriteQueue } from './ExportWriteQueue';
import { EncodedVideoStreamWriter, resolveNativeEncoderConfig } from './WebCodecsEncoding';
import { assertExportOperation, ExportEncodingError, getExportVideoCodec } from '../../api/exportEncoding';
import type { ExportOperationResult, FFmpegStreamOptions } from '../../api/types/export';

interface ElectronExportAPI {
  startStreamExport(outputPath: string, options: FFmpegStreamOptions): Promise<ExportOperationResult>;
  pushEncodedChunk(chunkData: Uint8Array): Promise<ExportOperationResult>;
  endStreamExport(): Promise<ExportOperationResult>;
}

export class WebCodecsBackend implements ICaptureBackend {
  private encoder: VideoEncoder | null = null;
  private encoderQueue = new ExportWriteQueue(8 * 1024 * 1024, 32);
  private writer: EncodedVideoStreamWriter | null = null;
  private submittedFrames = 0;
  private electronAPI: ElectronExportAPI;
  private encoderFailure: Error | null = null;
  private streamStarted = false;
  private streamFinished = false;

  constructor(electronAPI: ElectronExportAPI) {
    this.electronAPI = electronAPI;
  }

  async init(config: BackendInit): Promise<void> {
    const encoderConfig = await resolveNativeEncoderConfig(config);
    const writer = new EncodedVideoStreamWriter(config.videoCodec ?? getExportVideoCodec(config.codec), config.width, config.height, config.fps);
    this.writer = writer;
    this.submittedFrames = 0;
    // FFmpeg only muxes the encoded Annex B / IVF stream.
    const result = await this.electronAPI.startStreamExport(config.outputPath, {
      fps: config.fps,
      codec: config.codec,
      width: config.width,
      height: config.height,
      isEncoded: true,
      inputFormat: writer.inputFormat,
      bitrate: config.bitrate / 1_000_000,
    });
    assertExportOperation(result, 'FFmpeg stream start');

    this.encoderQueue = new ExportWriteQueue(8 * 1024 * 1024, 32);
    this.encoderFailure = null;
    this.streamStarted = true;
    this.streamFinished = false;
    config.onStarted?.();

    try {
      this.encoder = new VideoEncoder({
        output: (chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) => {
          try {
            const annexB = writer.write(chunk, metadata);
            this.encoderQueue.enqueue(annexB.byteLength, async () => {
              const pushResult = await this.electronAPI.pushEncodedChunk(annexB);
              assertExportOperation(pushResult, 'FFmpeg encoded chunk push');
            });
          } catch (error) {
            this.encoderFailure = new ExportEncodingError(toError(error).message);
            this.encoderQueue.abort(this.encoderFailure);
          }
        },
        error: (e: Error) => {
          this.encoderFailure = new ExportEncodingError(e.message);
          this.encoderQueue.abort(this.encoderFailure);
          console.error('[WebCodecs] Encoder error:', e);
        },
      });

      try { this.encoder.configure(encoderConfig); }
      catch (error) { throw new ExportEncodingError(toError(error).message); }
    } catch (error) {
      await this.abort();
      throw error instanceof ExportEncodingError ? error : new ExportEncodingError(toError(error).message);
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
        throw new ExportEncodingError('VideoEncoder unexpectedly closed');
      }

      const videoFrame = new VideoFrame(frame.canvas, {
        timestamp: Math.round(frame.frameIndex * (1_000_000 / frame.fps)),
        duration: Math.round((frame.frameIndex + 1) * 1_000_000 / frame.fps) - Math.round(frame.frameIndex * 1_000_000 / frame.fps),
      });
      try {
        this.encoder.encode(videoFrame, {
          keyFrame: frame.frameIndex % Math.max(1, Math.round(frame.fps * 2)) === 0,
        });
        this.submittedFrames++;
      } catch (error) {
        throw new ExportEncodingError(toError(error).message);
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
      try { await this.encoder.flush(); }
      catch (error) { throw new ExportEncodingError(toError(error).message); }
      await this.encoderQueue.drain();
      if (this.writer?.frameCount !== this.submittedFrames) throw new ExportEncodingError('WebCodecs 输出帧数不完整');
      if (this.encoderFailure) throw this.encoderFailure;

      if (this.encoder.state !== 'closed') {
        this.encoder.close();
      }

      const result = await this.electronAPI.endStreamExport();
      this.streamFinished = true;
      assertExportOperation(result, 'FFmpeg stream finish');
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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
