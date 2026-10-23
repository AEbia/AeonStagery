import { describe, expect, it } from 'vitest';
import { classifyExportFailure, getFFmpegEncoderCandidates, resolveExportEncoding } from '../api/exportEncoding';
import type { ExportConfig } from '../api/types/export';

const config: ExportConfig = {
  format: 'mp4', codec: 'libx264', bitrateMbps: 12.5, fps: 60, width: 1920, height: 1080,
  rangeStart: 0, rangeEnd: 1, includeAudio: false, backend: 'rawpixels', outputPath: '/out.mp4',
};

describe('export encoding settings', () => {
  it('preserves legacy bitrate mode and fractional Mbps', () => {
    expect(resolveExportEncoding(config)).toMatchObject({ encoder: 'libx264', implementation: 'ffmpeg', rateControl: { mode: 'bitrate', bitrateMbps: 12.5 } });
  });

  it('gives new settings precedence and keeps the intermediate bitrate independent', () => {
    expect(resolveExportEncoding({ ...config, bitrateMbps: 2, encoding: { videoCodec: 'av1', implementation: 'auto', quality: 'balanced' } }))
      .toMatchObject({ encoder: 'auto', implementation: 'auto', rateControl: { mode: 'crf', crf: 32 }, intermediateBitrateMbps: 40 });
  });

  it.each([undefined, 'auto'])('selects compiled-in hardware before software for encoder %s', ffmpegEncoder => {
    const settings = resolveExportEncoding({ ...config, encoding: {
      videoCodec: 'hevc', implementation: 'ffmpeg', quality: 'balanced', ffmpegEncoder,
      rateControl: { mode: 'bitrate', bitrateMbps: 12.5 },
    } });
    expect(getFFmpegEncoderCandidates(settings, ['libx265', 'hevc_qsv', 'h264_nvenc', 'hevc_nvenc']))
      .toEqual(['hevc_nvenc', 'hevc_qsv', 'libx265']);
    expect(getFFmpegEncoderCandidates(settings, [])).toEqual(['libx265']);
    expect(getFFmpegEncoderCandidates(settings)).toEqual(['libx265']);
  });

  it('keeps CRF on software when automatic hardware selection is available', () => {
    const settings = resolveExportEncoding({ ...config, encoding: {
      videoCodec: 'hevc', implementation: 'ffmpeg', quality: 'balanced', ffmpegEncoder: 'auto',
      rateControl: { mode: 'crf', crf: 24 },
    } });
    expect(getFFmpegEncoderCandidates(settings, ['hevc_nvenc', 'libx265'])).toEqual(['libx265']);
  });

  it('honors a manual encoder and only falls back to software', () => {
    const settings = resolveExportEncoding({ ...config, encoding: {
      videoCodec: 'hevc', implementation: 'ffmpeg', quality: 'balanced', ffmpegEncoder: 'hevc_qsv',
      rateControl: { mode: 'bitrate', bitrateMbps: 12.5 },
    } });
    expect(getFFmpegEncoderCandidates(settings, ['hevc_nvenc', 'hevc_qsv', 'libx265'])).toEqual(['hevc_qsv', 'libx265']);
    expect(getFFmpegEncoderCandidates(settings, ['hevc_nvenc', 'libx265'])).toEqual(['libx265']);
  });

  it('disables intermediate encoding for high quality unless explicitly enabled', () => {
    const high: ExportConfig = { ...config, encoding: { videoCodec: 'hevc', implementation: 'auto', quality: 'high' } };
    expect(resolveExportEncoding(high)).toMatchObject({ allowH264Intermediate: false, rateControl: { mode: 'crf', crf: 20 } });
    expect(resolveExportEncoding({ ...high, encoding: { ...high.encoding!, allowH264Intermediate: true } }).allowH264Intermediate).toBe(true);
  });

  it.each([-1, 52, NaN])('rejects invalid H.264 CRF %s before capture', crf => {
    expect(() => resolveExportEncoding({ ...config, encoding: { videoCodec: 'h264', implementation: 'ffmpeg', quality: 'custom', rateControl: { mode: 'crf', crf } } })).toThrow('CRF');
  });

  it('rejects fractional CRF for integer-only encoders', () => {
    expect(() => resolveExportEncoding({ ...config, encoding: { videoCodec: 'av1', implementation: 'ffmpeg', quality: 'custom', rateControl: { mode: 'crf', crf: 25.5 } } })).toThrow('整数');
  });

  it('distinguishes output failures from hardware encoder failures', () => {
    expect(classifyExportFailure('FFmpeg error opening output: Permission denied')).toBe('output');
    expect(classifyExportFailure('Cannot load nvcuda.dll')).toBe('encoder');
    expect(classifyExportFailure('Unknown encoder av1_nvenc')).toBe('encoder');
    expect(classifyExportFailure('Custom HTML animation capture failed')).toBe('process');
  });
});
