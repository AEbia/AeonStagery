import { describe, expect, it } from 'vitest';
import {
  getRecommendedBitrate,
  evaluateBitrateQuality,
} from '../ui/bitrateRecommendation';

describe('bitrateRecommendation', () => {
  it('calculates standard 1080p bitrates across standard frame rates and codecs', () => {
    // 1080p30 H.264 baseline
    const r1080p30 = getRecommendedBitrate(1920, 1080, 30, 'libx264');
    expect(r1080p30.standard).toBe(10);
    expect(r1080p30.high).toBe(14);

    // 1080p60 H.264 scales with sqrt(60/30)
    const r1080p60 = getRecommendedBitrate(1920, 1080, 60, 'libx264');
    expect(r1080p60.standard).toBe(14);
    expect(r1080p60.high).toBe(20);

    // HEVC (NVENC) achieves same quality at ~75% bitrate
    const rHevc = getRecommendedBitrate(1920, 1080, 60, 'hevc_nvenc');
    expect(rHevc.standard).toBe(11);

    // AV1 achieves high quality at ~60% bitrate
    const rAv1 = getRecommendedBitrate(1920, 1080, 60, 'av1_nvenc');
    expect(rAv1.standard).toBe(8);
  });

  it('scales with resolution: 720p, vertical 1080x1920, and 4K', () => {
    // 720p30 H.264
    const r720p = getRecommendedBitrate(1280, 720, 30, 'libx264');
    expect(r720p.standard).toBe(5);

    // Vertical 1080x1920 (same pixel count as 1080p)
    const rVertical = getRecommendedBitrate(1080, 1920, 30, 'libx264');
    expect(rVertical.standard).toBe(10);

    // 4K60 H.264
    const r4K60 = getRecommendedBitrate(3840, 2160, 60, 'libx264');
    expect(r4K60.standard).toBe(40);
    expect(r4K60.high).toBe(56);

    // 4K60 HEVC
    const r4K60Hevc = getRecommendedBitrate(3840, 2160, 60, 'hevc_nvenc');
    expect(r4K60Hevc.standard).toBe(30);
  });

  it('evaluates bitrate quality relative to recommended standard', () => {
    const rec = getRecommendedBitrate(1920, 1080, 60, 'libx264'); // standard 14, min 10, high 20
    expect(evaluateBitrateQuality(5, rec).status).toBe('low');
    expect(evaluateBitrateQuality(14, rec).status).toBe('standard');
    expect(evaluateBitrateQuality(18, rec).status).toBe('high');
    expect(evaluateBitrateQuality(45, rec).status).toBe('ultra');
  });
});
