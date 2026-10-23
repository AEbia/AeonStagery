import type { ICaptureBackend, BackendInit, BackendFrame, CaptureResult } from './ICaptureBackend';
import { ExportWriteQueue } from './ExportWriteQueue';
import type { ExportOperationResult, FFmpegStreamOptions } from '../../api/types/export';
import { assertExportOperation, classifyExportFailure, ExportEncodingError } from '../../api/exportEncoding';

interface ElectronExportAPI {
  startStreamExport(outputPath: string, options: FFmpegStreamOptions): Promise<ExportOperationResult>;
  pushFrame(frameData: Uint8Array | Uint8ClampedArray): Promise<{ success: boolean; error?: string }>;
  endStreamExport(): Promise<ExportOperationResult>;
  cancelExport(): Promise<ExportOperationResult>;
}

export class RawPixelsBackend implements ICaptureBackend {
  private electronAPI: ElectronExportAPI;
  private pushQueue = new ExportWriteQueue(32 * 1024 * 1024, 4);
  private streamStarted = false;
  private streamFinished = false;

  constructor(electronAPI: ElectronExportAPI) {
    this.electronAPI = electronAPI;
  }

  async init(config: BackendInit): Promise<void> {
    const result = await this.electronAPI.startStreamExport(config.outputPath, {
      fps: config.fps,
      codec: config.codec,
      width: config.width,
      height: config.height,
      isEncoded: false,
      bitrate: config.bitrate / 1_000_000,
      ...config.encoding,
      ...config.streamOptions,
      ...(config.transparent === true ? { transparent: true } : {}),
    });
    assertExportOperation(result, 'FFmpeg stream start');
    this.pushQueue = new ExportWriteQueue(32 * 1024 * 1024, 4);
    this.streamStarted = true;
    this.streamFinished = false;
    config.onStarted?.();
  }

  async encodeFrame(frame: BackendFrame): Promise<void> {
    try {
      if (!frame.pixels) throw new Error('RawPixelsBackend requires pixel data');

      const pixels = frame.pixels;
      await this.pushQueue.ready(pixels.byteLength);
      this.pushQueue.enqueue(pixels.byteLength, async () => {
        const result = await this.electronAPI.pushFrame(pixels);
        assertExportOperation(result, 'FFmpeg frame push');
      });
    } catch (error) {
      await this.abort();
      throw classifyEncodingError(error);
    }
  }

  async finish(): Promise<CaptureResult | void> {
    try {
      await this.pushQueue.drain();
      const result = await this.electronAPI.endStreamExport();
      this.streamFinished = true;
      assertExportOperation(result, 'FFmpeg stream finish');
      if (result.sizeBytes !== undefined) return { sizeBytes: result.sizeBytes };
    } catch (error) {
      await this.abort();
      throw classifyEncodingError(error);
    }
  }

  async abort(cancelled = false): Promise<void> {
    if (!this.streamStarted || this.streamFinished) return;
    this.streamFinished = true;
    this.pushQueue.abort();
    try {
      // User cancellation is terminated by ExportAdapter's cancelExport IPC.
      if (!cancelled) await this.electronAPI.cancelExport();
    } catch {
      // Preserve the original capture failure while still attempting cleanup.
    }
  }
}

function classifyEncodingError(error: unknown): unknown {
  if (error instanceof Error && classifyExportFailure(error.message) === 'encoder') return new ExportEncodingError(error.message);
  return error;
}
