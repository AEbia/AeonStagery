import type { ExportConfig, ExportEncodingInfo } from './types/export';
import { resolveExportEncoding } from './exportEncoding';
import { validateVideoFormat } from './types/video-format';

export type ExportSizeEstimateConfig = Omit<ExportConfig, 'outputPath' | 'ffmpegLogCallback'>;

export interface ExportSizeSample {
  bytes: number;
  frames: number;
  encoding?: ExportEncodingInfo;
}

export interface ExportSizeEstimate {
  basis: 'bitrate' | 'sample';
  bytes: number;
  sampledFrames: number;
  totalFrames: number;
  sampleCount: number;
  encoding?: ExportEncodingInfo;
}

/** Native VBR and FFmpeg target bitrate use their own final target, never CRF. */
export function estimateExportSizeFromBitrate(
  config: ExportSizeEstimateConfig,
  bitrateMbps: number,
  encoding?: ExportEncodingInfo,
): ExportSizeEstimate {
  if (!planExportSizeSamples(config).length || !Number.isFinite(bitrateMbps) || bitrateMbps <= 0) {
    throw new Error('请先设置有效的导出规格和时间范围');
  }
  const totalFrames = Math.ceil(config.rangeEnd * config.fps) - Math.floor(config.rangeStart * config.fps);
  const audioMbps = config.includeAudio ? (config.format === 'webm' ? 0.128 : 0.192) : 0;
  const bytes = Math.round((bitrateMbps + audioMbps) * 1_000_000 / 8 * totalFrames / config.fps * 1.01);
  if (!Number.isSafeInteger(bytes)) throw new Error('视频大小估算超出范围');
  return { basis: 'bitrate', bytes, sampledFrames: 0, totalFrames, sampleCount: 0, encoding };
}

export interface ExportSizeSampleRange {
  rangeStart: number;
  rangeEnd: number;
  frames: number;
}

/** Plan up to three two-second clips across the actual output frame range. */
export function planExportSizeSamples(config: ExportSizeEstimateConfig): ExportSizeSampleRange[] {
  if (validateVideoFormat(config) || !Number.isFinite(config.rangeStart)
    || !Number.isFinite(config.rangeEnd) || config.rangeStart < 0
    || config.rangeEnd <= config.rangeStart) return [];
  try { resolveExportEncoding({ ...config, outputPath: '' }); }
  catch { return []; }

  const first = Math.floor(config.rangeStart * config.fps);
  const last = Math.ceil(config.rangeEnd * config.fps);
  const total = last - first;
  if (!Number.isSafeInteger(total) || total <= 0) return [];
  const clipFrames = Math.max(1, Math.round(config.fps * 2));
  if (total <= clipFrames * 3) {
    return [{ rangeStart: config.rangeStart, rangeEnd: config.rangeEnd, frames: total }];
  }
  return [0, 0.5, 1].map(position => {
    const start = first + Math.round((total - clipFrames) * position);
    // Avoid adding a frame when floating point timestamps are rounded by capture.
    return { rangeStart: (start + 1e-6) / config.fps, rangeEnd: (start + clipFrames - 1e-6) / config.fps, frames: clipFrames };
  });
}

/** Extrapolate measured output bytes, including real audio and muxing. */
export function estimateExportSizeFromSamples(
  config: ExportSizeEstimateConfig,
  samples: readonly ExportSizeSample[],
): ExportSizeEstimate {
  const totalFrames = Math.ceil(config.rangeEnd * config.fps) - Math.floor(config.rangeStart * config.fps);
  const sampledFrames = samples.reduce((total, sample) => total + sample.frames, 0);
  if (!samples.length || !Number.isSafeInteger(totalFrames) || totalFrames <= 0
    || samples.some(sample => !Number.isFinite(sample.bytes) || sample.bytes <= 0 || !Number.isSafeInteger(sample.frames) || sample.frames <= 0)
    || !Number.isSafeInteger(sampledFrames) || sampledFrames > totalFrames) {
    throw new Error('视频大小抽样数据无效');
  }
  const encoding = samples[0].encoding;
  if (samples.some(sample => sample.encoding?.implementation !== encoding?.implementation || sample.encoding?.encoder !== encoding?.encoder)) {
    throw new Error('抽样期间编码路径发生变化，无法合并估算');
  }
  const bytes = Math.round(samples.reduce((total, sample) => total + sample.bytes, 0) * totalFrames / sampledFrames);
  if (!Number.isSafeInteger(bytes)) throw new Error('视频大小抽样数据超出范围');
  return { basis: 'sample', bytes, sampledFrames, totalFrames, sampleCount: samples.length, encoding };
}
