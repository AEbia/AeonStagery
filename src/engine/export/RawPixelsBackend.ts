import type { ICaptureBackend, BackendInit, BackendFrame } from './ICaptureBackend';
import { ExportWriteQueue } from './ExportWriteQueue';

interface ElectronExportAPI {
  startStreamExport(outputPath: string, options: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
  pushFrame(frameData: Uint8Array | Uint8ClampedArray): Promise<{ success: boolean; error?: string }>;
  endStreamExport(): Promise<{ success: boolean; error?: string }>;
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
      crf: 18,
      isEncoded: false,
      bitrate: Math.round(config.bitrate / 1_000_000),
      ...(config.transparent === true ? { transparent: true } : {}),
    });
    assertExportSuccess(result, 'FFmpeg stream start');
    this.pushQueue = new ExportWriteQueue(32 * 1024 * 1024, 4);
    this.streamStarted = true;
    this.streamFinished = false;
  }

  async encodeFrame(frame: BackendFrame): Promise<void> {
    try {
      if (!frame.pixels) throw new Error('RawPixelsBackend requires pixel data');

      const pixels = frame.pixels;
      await this.pushQueue.ready(pixels.byteLength);
      this.pushQueue.enqueue(pixels.byteLength, async () => {
        const result = await this.electronAPI.pushFrame(pixels);
        assertExportSuccess(result, 'FFmpeg frame push');
      });
    } catch (error) {
      await this.abort();
      throw error;
    }
  }

  async finish(): Promise<void> {
    try {
      await this.pushQueue.drain();
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
    this.pushQueue.abort();
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
