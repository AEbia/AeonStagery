import type { ICaptureBackend, BackendInit, BackendFrame } from './ICaptureBackend';

interface ElectronExportAPI {
  startStreamExport(outputPath: string, options: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
  pushEncodedChunk(chunkData: Uint8Array): Promise<{ success: boolean; error?: string }>;
  endStreamExport(): Promise<{ success: boolean; error?: string }>;
}

export class WebCodecsBackend implements ICaptureBackend {
  private encoder: VideoEncoder | null = null;
  private encoderQueue: Promise<unknown>[] = [];
  private isFirstChunk = true;
  private electronAPI: ElectronExportAPI;
  private encoderFailure: Error | null = null;
  private streamStarted = false;
  private streamFinished = false;

  constructor(electronAPI: ElectronExportAPI) {
    this.electronAPI = electronAPI;
  }

  async init(config: BackendInit): Promise<void> {
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
    this.encoderQueue = [];
    this.encoderFailure = null;
    this.streamStarted = true;
    this.streamFinished = false;

    try {
      this.encoder = new VideoEncoder({
        output: async (chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) => {
          try {
            const chunkData = new Uint8Array(chunk.byteLength);
            chunk.copyTo(chunkData);
            const annexB = this.avccToAnnexB(chunkData, metadata);
            const p = this.electronAPI.pushEncodedChunk(annexB).then((pushResult) => {
              assertExportSuccess(pushResult, 'FFmpeg encoded chunk push');
            });
            this.encoderQueue.push(p);
          } catch (error) {
            this.encoderFailure = toError(error);
          }
        },
        error: (e: Error) => {
          this.encoderFailure = e;
          console.error('[WebCodecs] Encoder error:', e);
        },
      });

      this.encoder.configure({
        codec: 'avc1.4D002A',
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

      // Backpressure: wait if encoder queue is backed up
      while (this.encoder.encodeQueueSize > 2) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (this.encoderFailure) throw this.encoderFailure;
      }

      const videoFrame = new VideoFrame(frame.canvas, {
        timestamp: frame.frameIndex * (1_000_000 / frame.fps),
      });

      if (this.encoder.state === 'closed') {
        throw new Error('VideoEncoder unexpectedly closed');
      }

      try {
        this.encoder.encode(videoFrame, {
          keyFrame: frame.frameIndex % 60 === 0,
        });
      } finally {
        videoFrame.close();
      }

      if (this.encoderFailure) throw this.encoderFailure;

      // Drain completed chunk promises periodically
      if (this.encoderQueue.length > 10) {
        await Promise.all(this.encoderQueue.splice(0, 5));
      }
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
      await Promise.all(this.encoderQueue);
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

  async abort(): Promise<void> {
    if (!this.streamStarted || this.streamFinished) return;
    this.streamFinished = true;
    const pendingChunks = this.encoderQueue;
    this.encoderQueue = [];
    try {
      if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    } catch {
      // The encoder may already be closed after a fatal error.
    }
    try {
      await this.electronAPI.endStreamExport();
    } catch {
      // Preserve the original capture failure while still attempting cleanup.
    }
    // A capture/render failure can leave output callbacks with pending IPC
    // writes. Observe them during cleanup without replacing the original
    // failure.
    void Promise.allSettled(pendingChunks);
  }

  /**
   * Convert AVCC (length-prefixed) H.264 to Annex B (start-code delimited).
   * WebCodecs outputs AVCC; FFmpeg raw h264 demuxer expects Annex B.
   */
  private avccToAnnexB(chunkData: Uint8Array, metadata?: EncodedVideoChunkMetadata): Uint8Array {
    const nals: Uint8Array[] = [];

    // Prepend SPS/PPS for the first chunk
    if (this.isFirstChunk && metadata?.decoderConfig?.description) {
      const desc = new Uint8Array(metadata.decoderConfig.description as ArrayBuffer);
      if (desc.length > 10) {
        const spsCount = desc[5] & 0x1f;
        let offset = 6;
        for (let i = 0; i < spsCount; i++) {
          const spsLen = (desc[offset] << 8) | desc[offset + 1];
          offset += 2;
          const sps = desc.slice(offset, offset + spsLen);
          nals.push(new Uint8Array([0, 0, 0, 1]), sps);
          offset += spsLen;
        }
        const ppsCount = desc[offset];
        offset += 1;
        for (let i = 0; i < ppsCount; i++) {
          const ppsLen = (desc[offset] << 8) | desc[offset + 1];
          offset += 2;
          const pps = desc.slice(offset, offset + ppsLen);
          nals.push(new Uint8Array([0, 0, 0, 1]), pps);
          offset += ppsLen;
        }
      }
      this.isFirstChunk = false;
    }

    // Parse AVCC NAL units and convert each to Annex B format
    let pos = 0;
    while (pos < chunkData.length) {
      const nalLen =
        (chunkData[pos] << 24) |
        (chunkData[pos + 1] << 16) |
        (chunkData[pos + 2] << 8) |
        chunkData[pos + 3];
      pos += 4;
      const nal = chunkData.slice(pos, pos + nalLen);
      nals.push(new Uint8Array([0, 0, 0, 1]), nal);
      pos += nalLen;
    }

    // Flatten all NALs into a single Annex B buffer
    const totalSize = nals.reduce((acc, curr) => acc + curr.length, 0);
    const result = new Uint8Array(totalSize);
    let writePos = 0;
    for (const nal of nals) {
      result.set(nal, writePos);
      writePos += nal.length;
    }
    return result;
  }
}

function assertExportSuccess(result: { success: boolean; error?: string } | undefined, operation: string): void {
  if (result?.success === true) return;
  throw new Error(result?.error || `${operation} failed`);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
