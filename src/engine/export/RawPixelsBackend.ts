import type { ICaptureBackend, BackendInit, BackendFrame } from './ICaptureBackend';

interface ElectronExportAPI {
  startStreamExport(outputPath: string, options: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
  pushFrame(frameData: Uint8Array | Uint8ClampedArray): Promise<{ success: boolean; error?: string }>;
  endStreamExport(): Promise<{ success: boolean; error?: string }>;
}

export class RawPixelsBackend implements ICaptureBackend {
  private electronAPI: ElectronExportAPI;
  private pushQueue: Promise<unknown>[] = [];
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
    this.pushQueue = [];
    this.streamStarted = true;
    this.streamFinished = false;
  }

  async encodeFrame(frame: BackendFrame): Promise<void> {
    try {
      if (!frame.pixels) throw new Error('RawPixelsBackend requires pixel data');

      const p = this.electronAPI.pushFrame(frame.pixels).then((result) => {
        assertExportSuccess(result, 'FFmpeg frame push');
      });
      this.pushQueue.push(p);

      // Backpressure: drain completed pushes periodically
      if (this.pushQueue.length > 5) {
        await Promise.all(this.pushQueue.splice(0, 3));
      }
    } catch (error) {
      await this.abort();
      throw error;
    }
  }

  async finish(): Promise<void> {
    try {
      await Promise.all(this.pushQueue);
      const result = await this.electronAPI.endStreamExport();
      this.streamFinished = true;
      assertExportSuccess(result, 'FFmpeg stream finish');
    } catch (error) {
      await this.abort();
      throw error;
    }
  }

  async abort(): Promise<void> {
    if (!this.streamStarted || this.streamFinished) return;
    this.streamFinished = true;
    const pendingPushes = this.pushQueue;
    this.pushQueue = [];
    try {
      await this.electronAPI.endStreamExport();
    } catch {
      // Preserve the original capture failure while still attempting cleanup.
    }
    // Capture cleanup may run before a queued IPC write has settled. Attach a
    // rejection handler so that cleanup itself cannot create an unhandled
    // stream-write rejection.
    void Promise.allSettled(pendingPushes);
  }
}

function assertExportSuccess(result: { success: boolean; error?: string } | undefined, operation: string): void {
  if (result?.success === true) return;
  throw new Error(result?.error || `${operation} failed`);
}
