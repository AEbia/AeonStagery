import type { BackendInit } from './ICaptureBackend';
import type { ExportVideoCodec, FFmpegStreamOptions } from '../../api/types/export';
import { ExportEncodingError, getExportVideoCodec } from '../../api/exportEncoding';
import { avccToAnnexB } from './avccToAnnexB';

type NativeVideoEncoderConfig = VideoEncoderConfig & { hevc?: { format: 'annexb' } };

const H264_MAIN_LEVELS = [
  { level: 42, maxFrameMbs: 8704, maxMbsPerSecond: 522240, maxBitrate: 50_000_000 },
  { level: 50, maxFrameMbs: 22080, maxMbsPerSecond: 589824, maxBitrate: 135_000_000 },
  { level: 51, maxFrameMbs: 36864, maxMbsPerSecond: 983040, maxBitrate: 240_000_000 },
  { level: 52, maxFrameMbs: 36864, maxMbsPerSecond: 2073600, maxBitrate: 240_000_000 },
  { level: 60, maxFrameMbs: 139264, maxMbsPerSecond: 4177920, maxBitrate: 240_000_000 },
  { level: 61, maxFrameMbs: 139264, maxMbsPerSecond: 8355840, maxBitrate: 480_000_000 },
  { level: 62, maxFrameMbs: 139264, maxMbsPerSecond: 16711680, maxBitrate: 800_000_000 },
] as const;

export function nativeCodecCandidates(config: BackendInit): string[] {
  const videoCodec = config.videoCodec ?? getExportVideoCodec(config.codec);
  const pixels = config.width * config.height;
  const pixelRate = pixels * config.fps;
  if (videoCodec === 'h264') {
    const widthMbs = Math.ceil(config.width / 16), heightMbs = Math.ceil(config.height / 16);
    const frameMbs = widthMbs * heightMbs;
    return H264_MAIN_LEVELS.filter(level => frameMbs <= level.maxFrameMbs
      && frameMbs * config.fps <= level.maxMbsPerSecond
      && Math.max(widthMbs, heightMbs) ** 2 <= level.maxFrameMbs * 8
      && config.bitrate <= level.maxBitrate)
      .map(level => `avc1.4D00${level.level.toString(16).toUpperCase()}`);
  }
  if (videoCodec === 'hevc') {
    // HEVC Main profile, main tier: level, luma picture size, luma samples/s, bitrate.
    const levels = [
      [93, 983040, 33177600, 10e6], [120, 2228224, 66846720, 12e6],
      [123, 2228224, 133693440, 20e6], [150, 8912896, 267386880, 25e6],
      [153, 8912896, 534773760, 40e6], [156, 8912896, 1069547520, 60e6],
      [180, 35651584, 1069547520, 60e6], [183, 35651584, 2139095040, 120e6],
      [186, 35651584, 4278190080, 240e6],
    ];
    return levels.filter(([, maxPixels, maxRate, maxBitrate]) => pixels <= maxPixels && pixelRate <= maxRate && config.bitrate <= maxBitrate)
      .map(([level]) => `hvc1.1.6.L${level}.B0`);
  }
  if (videoCodec === 'vp9') {
    const levels = [[40, 2359296, 83558400], [41, 2359296, 160432128], [50, 8912896, 311951360],
      [51, 8912896, 588251136], [52, 8912896, 1176502272], [60, 35651584, 1176502272],
      [61, 35651584, 2353004544], [62, 35651584, 4706009088]];
    return levels.filter(([, maxPixels, maxRate]) => pixels <= maxPixels && pixelRate <= maxRate)
      .map(([level]) => `vp09.00.${level}.08`);
  }
  if (videoCodec === 'av1') {
    const levels = [[8, 2359296, 70778880], [9, 2359296, 141557760], [12, 8912896, 267386880],
      [13, 8912896, 534773760], [14, 8912896, 1069547520], [15, 8912896, 1069547520],
      [16, 35651584, 1069547520], [17, 35651584, 2139095040], [18, 35651584, 4278190080],
      [19, 35651584, 4278190080], [20, 142606336, 4278190080], [21, 142606336, 8556380160],
      [22, 142606336, 17112760320], [23, 142606336, 17112760320]];
    return levels.filter(([, maxPixels, maxRate]) => pixels <= maxPixels && pixelRate <= maxRate)
      .map(([level]) => `av01.0.${String(level).padStart(2, '0')}M.08`);
  }
  return [];
}

export async function resolveNativeEncoderConfig(config: BackendInit): Promise<NativeVideoEncoderConfig> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') throw new ExportEncodingError('当前环境不支持 WebCodecs');
  const videoCodec = config.videoCodec ?? getExportVideoCodec(config.codec);
  const candidates = nativeCodecCandidates(config);
  if (videoCodec === 'h264' && candidates.length === 0) throw new ExportEncodingError('Output exceeds H.264 level limits');
  for (const codec of candidates) {
    const candidate: NativeVideoEncoderConfig = {
      codec, width: config.width, height: config.height, bitrate: config.bitrate,
      framerate: config.fps, bitrateMode: 'variable', latencyMode: 'quality', hardwareAcceleration: 'no-preference',
      ...(videoCodec === 'h264' ? { avc: { format: 'annexb' as const } } : {}),
      ...(videoCodec === 'hevc' ? { hevc: { format: 'annexb' as const } } : {}),
    };
    try {
      const support = await VideoEncoder.isConfigSupported(candidate);
      if (support.supported) return candidate;
    } catch { /* Try the next compatible level. */ }
  }
  throw new ExportEncodingError(`WebCodecs 不支持 ${videoCodec.toUpperCase()} ${config.width}×${config.height} / ${config.fps} fps / ${config.bitrate} bps`);
}

function bytesOf(source: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
}

function hevcToAnnexB(chunk: Uint8Array, description?: AllowSharedBufferSource, lengthSize = 4): Uint8Array {
  const parts: Uint8Array[] = [];
  const append = (bytes: Uint8Array, offset: number, size: number) => {
    if (size <= 0 || offset + size > bytes.byteLength) throw new ExportEncodingError('Incomplete HEVC NAL unit');
    parts.push(bytes.subarray(offset, offset + size));
  };
  if (description) {
    const record = bytesOf(description);
    if (record.length < 23) throw new ExportEncodingError('Incomplete HEVC decoder configuration');
    lengthSize = (record[21] & 3) + 1;
    const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
    let offset = 23;
    for (let array = 0; array < record[22]; array++) {
      if (offset + 3 > record.length) throw new ExportEncodingError('Incomplete HEVC parameter array');
      const count = view.getUint16(offset + 1); offset += 3;
      for (let index = 0; index < count; index++) {
        if (offset + 2 > record.length) throw new ExportEncodingError('Incomplete HEVC parameter length');
        const size = view.getUint16(offset); offset += 2;
        append(record, offset, size); offset += size;
      }
    }
  }
  for (let offset = 0; offset < chunk.length;) {
    if (offset + lengthSize > chunk.length) throw new ExportEncodingError('Incomplete HEVC NAL length');
    let size = 0;
    for (let index = 0; index < lengthSize; index++) size = size * 256 + chunk[offset++];
    append(chunk, offset, size); offset += size;
  }
  const output = new Uint8Array(parts.reduce((size, part) => size + 4 + part.length, 0));
  let offset = 0;
  for (const part of parts) { output[offset + 3] = 1; output.set(part, offset + 4); offset += 4 + part.length; }
  return output;
}

/** Streaming envelopes only: the encoded payload is never decoded or re-encoded. */
export class EncodedVideoStreamWriter {
  readonly inputFormat: FFmpegStreamOptions['inputFormat'];
  private count = 0;
  private lengthPrefixed = false;
  private lengthSize = 4;
  private readonly rate: number;
  private readonly scale: number;

  constructor(private readonly codec: ExportVideoCodec, private readonly width: number, private readonly height: number, private readonly fps: number) {
    this.inputFormat = codec === 'h264' ? 'h264' : codec === 'hevc' ? 'hevc' : 'ivf';
    const numerator = Math.round(fps * 1_000_000);
    const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
    const divisor = gcd(numerator, 1_000_000);
    this.rate = numerator / divisor; this.scale = 1_000_000 / divisor;
  }

  get frameCount(): number { return this.count; }

  write(chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata): Uint8Array {
    // Raw Annex B has no per-packet timestamps. Reject reordering or dropped frames
    // so that FFmpeg's CFR timestamps always describe the actual pictures.
    if (Math.abs(chunk.timestamp - this.count * 1_000_000 / this.fps) > 2) throw new ExportEncodingError('WebCodecs 输出帧时间戳不连续');
    const payload = new Uint8Array(chunk.byteLength); chunk.copyTo(payload);
    const first = this.count++ === 0;
    if (this.inputFormat !== 'ivf') {
      const description = metadata?.decoderConfig?.description;
      if (description) {
        this.lengthPrefixed = true;
        const record = bytesOf(description);
        this.lengthSize = ((record[this.codec === 'hevc' ? 21 : 4] ?? 3) & 3) + 1;
      }
      if (!this.lengthPrefixed) return payload;
      return this.codec === 'h264' ? avccToAnnexB(payload, description, this.lengthSize) : hevcToAnnexB(payload, description, this.lengthSize);
    }
    const headerSize = first ? 32 : 0;
    const output = new Uint8Array(headerSize + 12 + payload.length);
    const view = new DataView(output.buffer);
    if (first) {
      output.set([68, 75, 73, 70]); view.setUint16(6, 32, true);
      output.set(this.codec === 'vp9' ? [86, 80, 57, 48] : [65, 86, 48, 49], 8);
      view.setUint16(12, this.width, true); view.setUint16(14, this.height, true);
      view.setUint32(16, this.rate, true); view.setUint32(20, this.scale, true);
    }
    view.setUint32(headerSize, payload.length, true);
    view.setBigUint64(headerSize + 4, BigInt(this.count - 1), true);
    output.set(payload, headerSize + 12);
    return output;
  }
}
