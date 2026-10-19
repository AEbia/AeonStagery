import { vi } from 'vitest';

export class MockExportFrame {
  readonly timestamp: number;
  readonly duration: number | null;
  constructor(_source: CanvasImageSource, init: VideoFrameInit) {
    this.timestamp = init.timestamp ?? 0;
    this.duration = init.duration ?? null;
  }
  close(): void {}
}

export class MockExportEncoder {
  static supports: (config: VideoEncoderConfig) => boolean = () => true;
  static failCodec: string | null = null;
  static failConfigureCodec: string | null = null;
  static configurations: VideoEncoderConfig[] = [];
  static isConfigSupported = vi.fn(async (config: VideoEncoderConfig) => ({ supported: MockExportEncoder.supports(config), config }));
  state: CodecState = 'unconfigured';
  encodeQueueSize = 0;
  private config?: VideoEncoderConfig;
  constructor(private readonly init: VideoEncoderInit) {}
  configure(config: VideoEncoderConfig): void {
    if (MockExportEncoder.failConfigureCodec && config.codec.startsWith(MockExportEncoder.failConfigureCodec)) throw new Error('Hardware configuration failed');
    this.config = config;
    this.state = 'configured';
    MockExportEncoder.configurations.push(config);
  }
  encode(frame: MockExportFrame, options?: VideoEncoderEncodeOptions): void {
    if (MockExportEncoder.failCodec && this.config?.codec.startsWith(MockExportEncoder.failCodec)) {
      this.init.error(new DOMException('Hardware encoder failed', 'EncodingError'));
      return;
    }
    const payload = new Uint8Array([0, 0, 0, 1, 0x65, 0x12]);
    const chunk: EncodedVideoChunk = {
      type: options?.keyFrame ? 'key' : 'delta', timestamp: frame.timestamp, duration: frame.duration,
      byteLength: payload.length,
      copyTo(destination) {
        const bytes = ArrayBuffer.isView(destination)
          ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
          : new Uint8Array(destination);
        bytes.set(payload);
      },
    };
    this.init.output(chunk, {});
  }
  async flush(): Promise<void> {}
  close(): void { this.state = 'closed'; }
}

export function installMockExportEncoder(): void {
  MockExportEncoder.supports = () => true;
  MockExportEncoder.failCodec = null;
  MockExportEncoder.failConfigureCodec = null;
  MockExportEncoder.configurations = [];
  MockExportEncoder.isConfigSupported.mockClear();
  vi.stubGlobal('VideoEncoder', MockExportEncoder);
  vi.stubGlobal('VideoFrame', MockExportFrame);
}
