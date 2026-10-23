/**
 * AeonStagery — Video Bitrate Recommendation Engine
 *
 * Dynamically computes recommended video bitrate (Mbps)
 * based on resolution, frame rate, and encoder efficiency.
 */

export interface BitrateRecommendation {
  readonly standard: number;
  readonly high: number;
  readonly minSuggested: number;
  readonly label: string;
}

export function getRecommendedBitrate(
  width: number,
  height: number,
  fps: number,
  codec: string,
): BitrateRecommendation {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1920;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 1080;
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;

  // Base H.264 bitrate at 1080p @ 30fps is 10 Mbps
  const baseRate = 10;
  // Sub-linear resolution scaling (0.75 exponent)
  const resFactor = Math.pow((safeWidth * safeHeight) / (1920 * 1080), 0.75);
  // Square-root frame-rate scaling (temporal compression)
  const fpsFactor = Math.pow(Math.max(15, Math.min(120, safeFps)) / 30, 0.5);
  const h264Bitrate = baseRate * resFactor * fpsFactor;

  // Codec efficiency relative to H.264 (1.0)
  let codecFactor = 1.0;
  const normalizedCodec = codec.toLowerCase();

  if (normalizedCodec === 'libx265') {
    codecFactor = 0.65; // High efficiency software HEVC
  } else if (normalizedCodec.includes('hevc') || normalizedCodec.includes('h265')) {
    codecFactor = 0.75; // Hardware HEVC (NVENC / MediaFoundation)
  } else if (normalizedCodec === 'vp9' || normalizedCodec === 'libvpx-vp9') {
    codecFactor = 0.7; // VP9 in WebM
  } else if (normalizedCodec === 'libaom-av1') {
    codecFactor = 0.5; // High efficiency software AV1
  } else if (normalizedCodec.includes('av1')) {
    codecFactor = 0.6; // Hardware AV1 (NVENC / AMF)
  } else if (normalizedCodec.includes('prores')) {
    codecFactor = 3.5; // Intra-frame mezzanine codec
  }

  const standard = Math.max(1, Math.min(100, Math.round(h264Bitrate * codecFactor)));
  const high = Math.max(1, Math.min(100, Math.round(standard * 1.4)));
  const minSuggested = Math.max(1, Math.round(standard * 0.7));

  return {
    standard,
    high,
    minSuggested,
    label: `${standard} Mbps (标准) · ${high} Mbps (高画质)`,
  };
}

export function evaluateBitrateQuality(
  bitrate: number,
  recommendation: BitrateRecommendation,
): { status: 'low' | 'standard' | 'high' | 'ultra'; text: string; color: string } {
  if (bitrate < recommendation.minSuggested) {
    return {
      status: 'low',
      text: '偏低',
      color: 'var(--warning)',
    };
  }
  if (bitrate <= recommendation.standard * 1.15) {
    return {
      status: 'standard',
      text: '标准',
      color: 'var(--accent-primary)',
    };
  }
  if (bitrate <= recommendation.high * 1.15) {
    return {
      status: 'high',
      text: '高画质',
      color: 'var(--success)',
    };
  }
  return {
    status: 'ultra',
    text: '超高画质',
    color: 'var(--text-secondary)',
  };
}
