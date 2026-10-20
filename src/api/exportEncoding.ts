import type { ExportConfig, ExportEncodingSettings, ExportEncodingSpeed, ExportOperationResult, ExportRateControl, ExportVideoCodec } from './types/export';
import { getRecommendedBitrate } from './videoBitrate';

const SOFTWARE_ENCODERS: Record<ExportVideoCodec, string> = {
  h264: 'libx264', hevc: 'libx265', vp9: 'libvpx-vp9', av1: 'libaom-av1', prores: 'prores_ks',
};

export const FFMPEG_ENCODERS: Record<ExportVideoCodec, readonly string[]> = {
  h264: ['libx264', 'h264_nvenc', 'h264_amf', 'h264_qsv', 'h264_mf'],
  hevc: ['libx265', 'hevc_nvenc', 'hevc_amf', 'hevc_qsv', 'hevc_mf'],
  vp9: ['libvpx-vp9'],
  av1: ['libaom-av1', 'av1_nvenc', 'av1_amf', 'av1_qsv'],
  prores: ['prores_ks'],
};

export function getSoftwareEncoder(codec: ExportVideoCodec): string { return SOFTWARE_ENCODERS[codec]; }

export function getExportVideoCodec(encoder: string): ExportVideoCodec {
  if (encoder === 'vp9' || encoder === 'libvpx-vp9') return 'vp9';
  for (const codec of Object.keys(FFMPEG_ENCODERS) as ExportVideoCodec[]) {
    if (FFMPEG_ENCODERS[codec].includes(encoder)) return codec;
  }
  throw new Error(`不支持的编码器：${encoder}`);
}

export function getDefaultCrf(codec: ExportVideoCodec, quality: 'balanced' | 'high' | 'custom'): number {
  const values: Record<ExportVideoCodec, readonly [number, number]> = {
    h264: [20, 18], hevc: [24, 20], vp9: [32, 28], av1: [32, 28], prores: [6, 6],
  };
  return values[codec][quality === 'high' ? 1 : 0];
}

export function isHardwareEncoder(encoder: string): boolean {
  return /_(nvenc|amf|qsv|mf)$/.test(encoder);
}

export interface ResolvedExportEncoding {
  videoCodec: ExportVideoCodec;
  implementation: ExportEncodingSettings['implementation'];
  encoder: string;
  bitrateMbps: number;
  rateControl: ExportRateControl;
  speed: ExportEncodingSpeed;
  allowH264Intermediate: boolean;
  intermediateBitrateMbps: number;
}

export function resolveExportEncoding(config: ExportConfig): ResolvedExportEncoding {
  const settings = config.encoding;
  const videoCodec = settings?.videoCodec ?? getExportVideoCodec(config.codec);
  const encoder = settings?.ffmpegEncoder || (settings ? getSoftwareEncoder(videoCodec) : config.codec === 'vp9' ? 'libvpx-vp9' : config.codec);
  if (!FFMPEG_ENCODERS[videoCodec]?.includes(encoder)) throw new Error('编码标准与编码器不匹配');
  const rateControl: ExportRateControl = settings?.rateControl ?? (settings
    ? { mode: 'crf', crf: getDefaultCrf(videoCodec, settings.quality) }
    : { mode: 'bitrate', bitrateMbps: config.bitrateMbps });
  const intermediateBitrateMbps = settings?.intermediateBitrateMbps
    ?? getRecommendedBitrate(config.width, config.height, config.fps, 'libx264').high * 2;
  if (!Number.isFinite(config.bitrateMbps) || config.bitrateMbps <= 0
    || !Number.isFinite(intermediateBitrateMbps) || intermediateBitrateMbps <= 0) {
    throw new Error('视频码率必须为正数');
  }
  if (rateControl.mode === 'crf') {
    const max = videoCodec === 'h264' || videoCodec === 'hevc' ? 51 : 63;
    if (!Number.isFinite(rateControl.crf) || rateControl.crf < 0 || rateControl.crf > max) throw new Error(`CRF 必须在 0–${max} 之间`);
    if ((videoCodec === 'vp9' || videoCodec === 'av1') && !Number.isInteger(rateControl.crf)) throw new Error('VP9 / AV1 的 CRF 必须为整数');
  } else if (!Number.isFinite(rateControl.bitrateMbps) || rateControl.bitrateMbps <= 0) {
    throw new Error('视频码率必须为正数');
  }
  return {
    videoCodec, encoder, rateControl,
    implementation: settings?.implementation ?? (config.backend === 'webcodecs' ? 'webcodecs' : 'ffmpeg'),
    bitrateMbps: config.bitrateMbps,
    speed: settings?.speed ?? 'balanced',
    allowH264Intermediate: settings?.allowH264Intermediate ?? (settings?.quality !== 'high'),
    intermediateBitrateMbps,
  };
}

export class ExportEncodingError extends Error {
  constructor(message: string) { super(message); this.name = 'ExportEncodingError'; }
}

export class ExportOutputError extends Error {
  constructor(message: string) { super(message); this.name = 'ExportOutputError'; }
}

export function classifyExportFailure(message: string): ExportOperationResult['failureKind'] {
  if (/ENOSPC|EACCES|EPERM|ENOENT|no space|disk full|permission denied|read-only|input\/output error|error opening output|failed to open.*output/i.test(message)) return 'output';
  if (/unknown encoder|encoder.*(?:not found|not available|not supported|failed|error)|(?:cannot|could not|failed to) (?:open|load|initialize|initialise).*|no capable devices|unsupported.*(?:codec|profile|level|format)|invalid.*(?:encoder|profile|level)|nvenc|amf|mfx|qsv|cuda/i.test(message)) return 'encoder';
  return 'process';
}

export function assertExportOperation(result: ExportOperationResult | undefined, operation: string): void {
  if (result?.success) return;
  const message = [result?.error || `${operation} failed`, result?.stderr].filter(Boolean).join('\n');
  if (result?.failureKind === 'output' || classifyExportFailure(message) === 'output') throw new ExportOutputError(message);
  if (result?.failureKind === 'encoder' || classifyExportFailure(message) === 'encoder') throw new ExportEncodingError(message);
  throw new Error(message);
}
