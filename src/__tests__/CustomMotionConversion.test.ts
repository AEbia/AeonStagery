import { describe, expect, it } from 'vitest';
import type { CustomMotionKeyframe } from '../api/types/semantic-scene';
import {
  CUSTOM_MOTION_DENSITY_ERROR_RATIOS,
  CUSTOM_MOTION_FIT_ABSOLUTE_TOLERANCE,
  CUSTOM_MOTION_FIT_ALGORITHM_VERSION,
  convertSampledMotionToCustomMotion,
  estimateCustomMotionKeyframes,
  fitCustomMotionLinearKeyframes,
  resolveFitScale,
} from '../engine/live2d/customMotionConversion';
import type { CustomMotionSamplePoint } from '../engine/live2d/customMotionConversion';

function samplesOf(values: readonly number[], fps = 60): CustomMotionSamplePoint[] {
  return values.map((value, index) => ({ time: index / fps, value }));
}

function maxError(
  samples: readonly CustomMotionSamplePoint[],
  keyframes: readonly CustomMotionKeyframe[],
): number {
  let max = 0;
  for (const sample of samples) {
    const value = interpolate(sample.time, keyframes);
    max = Math.max(max, Math.abs(value - sample.value));
  }
  return max;
}

function interpolate(time: number, keyframes: readonly CustomMotionKeyframe[]): number {
  if (time <= keyframes[0].time) return keyframes[0].value;
  if (time >= keyframes[keyframes.length - 1].time) return keyframes[keyframes.length - 1].value;
  for (let index = 0; index < keyframes.length - 1; index++) {
    const current = keyframes[index];
    const next = keyframes[index + 1];
    if (time > next.time) continue;
    const t = (time - current.time) / (next.time - current.time);
    return current.value + (next.value - current.value) * t;
  }
  return keyframes[keyframes.length - 1].value;
}

describe('resolveFitScale', () => {
  it('uses the explicit model scale when reliable', () => {
    expect(resolveFitScale(samplesOf([0, 1, 2]), 30)).toBe(30);
  });

  it('falls back to the sampled motion amplitude', () => {
    expect(resolveFitScale(samplesOf([5, 10, 5]), undefined)).toBe(5);
  });

  it('never returns a zero or non-finite scale', () => {
    expect(resolveFitScale(samplesOf([2, 2, 2]), undefined)).toBe(1);
  });
});

describe('fitCustomMotionLinearKeyframes', () => {
  it('returns empty for no samples and keeps per-frame density verbatim', () => {
    expect(fitCustomMotionLinearKeyframes([], { density: 'standard' })).toEqual([]);
    const samples = samplesOf([0, 3, 7, 2], 10);
    const perFrame = fitCustomMotionLinearKeyframes(samples, { density: 'perFrame' });
    expect(perFrame).toHaveLength(4);
    expect(perFrame[perFrame.length - 1]).not.toHaveProperty('segment');
    expect(perFrame[0].segment).toEqual({ type: 'linear' });
  });

  it('keeps F0 and the motion end sample for a constant track', () => {
    const samples = samplesOf([5, 5, 5, 5, 5], 60);
    const keyframes = fitCustomMotionLinearKeyframes(samples, { density: 'standard' });
    expect(keyframes.map((keyframe) => keyframe.time)).toEqual([0, 4 / 60]);
    expect(keyframes.map((keyframe) => keyframe.value)).toEqual([5, 5]);
    expect(maxError(samples, keyframes)).toBeLessThanOrEqual(CUSTOM_MOTION_FIT_ABSOLUTE_TOLERANCE);
  });

  it('fits a linear ramp exactly with two keyframes', () => {
    const samples = samplesOf([0, 1, 2, 3, 4, 5], 60);
    const keyframes = fitCustomMotionLinearKeyframes(samples, { density: 'standard' });
    expect(keyframes).toHaveLength(2);
    expect(keyframes[0]).toEqual({ time: 0, value: 0, segment: { type: 'linear' } });
    expect(keyframes[1]).toEqual({ time: 5 / 60, value: 5 });
    expect(maxError(samples, keyframes)).toBeLessThanOrEqual(CUSTOM_MOTION_FIT_ABSOLUTE_TOLERANCE);
  });

  it('preserves a stepped jump boundary as mandatory keyframes', () => {
    // Value jumps from 0 to 30 in a single frame: an explicit boundary.
    const samples = samplesOf([0, 0, 0, 30, 30, 30], 60);
    const keyframes = fitCustomMotionLinearKeyframes(samples, { density: 'standard' });
    expect(keyframes.map((keyframe) => keyframe.value)).toEqual([0, 0, 30, 30]);
    expect(maxError(samples, keyframes)).toBeLessThanOrEqual(CUSTOM_MOTION_FIT_ABSOLUTE_TOLERANCE);
  });

  it('simplifies a smooth sine within the allowed error ratio', () => {
    const fps = 60;
    const samples = Array.from({ length: 121 }, (_, index) => ({
      time: index / fps,
      value: Math.sin(index / fps * Math.PI * 2),
    }));
    const keyframes = fitCustomMotionLinearKeyframes(samples, { density: 'standard' });
    const allowed = Math.max(
      CUSTOM_MOTION_DENSITY_ERROR_RATIOS.standard * resolveFitScale(samples, undefined),
      CUSTOM_MOTION_FIT_ABSOLUTE_TOLERANCE,
    );
    expect(keyframes.length).toBeLessThan(samples.length);
    expect(maxError(samples, keyframes)).toBeLessThanOrEqual(allowed + 1e-9);
    expect(keyframes[0].time).toBe(0);
    expect(keyframes[keyframes.length - 1].time).toBe(2);
  });

  it('supports the sparse density with a looser error budget', () => {
    const samples = samplesOf([0, 1, 0, 1, 0, 1], 10);
    const keyframes = fitCustomMotionLinearKeyframes(samples, { density: 'sparse' });
    const allowed = Math.max(CUSTOM_MOTION_DENSITY_ERROR_RATIOS.sparse * 1, CUSTOM_MOTION_FIT_ABSOLUTE_TOLERANCE);
    expect(maxError(samples, keyframes)).toBeLessThanOrEqual(allowed + 1e-9);
  });

  it('does not drop the mandatory F0 even when deletion is cheaper', () => {
    const samples = samplesOf([2, 3, 4, 5, 6], 60);
    const keyframes = fitCustomMotionLinearKeyframes(samples, { density: 'fine' });
    expect(keyframes[0].time).toBe(0);
    expect(keyframes[keyframes.length - 1].time).toBe(4 / 60);
  });
});

describe('convertSampledMotionToCustomMotion', () => {
  it('assembles a codec-valid custom motion and reports static tracks', () => {
    const result = convertSampledMotionToCustomMotion({
      durationSeconds: 2,
      fadeInSeconds: 0.5,
      derivedFromKey: 'wave',
      derivedFromFadeInSeconds: 0.3,
      derivedFromFadeOutSeconds: 0.2,
      density: 'standard',
      sampledTracks: [
        {
          parameterId: 'PARAM_ANGLE_X',
          samples: samplesOf([0, 10, 20, 10, 0], 10),
        },
        {
          parameterId: 'PARAM_EYE_OPEN',
          samples: samplesOf([1, 1, 1, 1], 10),
        },
      ],
    });

    expect(result.motion.kind).toBe('custom');
    expect(result.motion.durationSeconds).toBe(2);
    expect(result.motion.fadeInSeconds).toBe(0.5);
    expect(result.motion.derivedFrom).toEqual({
      key: 'wave',
      fadeInSeconds: 0.3,
      fadeOutSeconds: 0.2,
    });
    expect(result.motion.tracks.map((track) => track.parameterId)).toEqual(['PARAM_ANGLE_X', 'PARAM_EYE_OPEN']);
    expect(result.staticTrackIds).toEqual(['PARAM_EYE_OPEN']);
    expect(result.simplifiedTrackIds).toContain('PARAM_ANGLE_X');
  });

  it('rejects invalid durations, fades, empty tracks, and duplicate ids', () => {
    const base = {
      durationSeconds: 2,
      fadeInSeconds: 0.5,
      derivedFromKey: 'wave',
      density: 'standard' as const,
      sampledTracks: [{ parameterId: 'A', samples: samplesOf([0, 1]) }],
    };

    expect(() => convertSampledMotionToCustomMotion({ ...base, durationSeconds: 0 })).toThrow(/duration/);
    expect(() => convertSampledMotionToCustomMotion({ ...base, durationSeconds: Number.NaN })).toThrow(/duration/);
    expect(() => convertSampledMotionToCustomMotion({ ...base, fadeInSeconds: -1 })).toThrow(/fadeInSeconds/);
    expect(() => convertSampledMotionToCustomMotion({ ...base, fadeInSeconds: 3 })).toThrow(/fadeInSeconds/);
    expect(() => convertSampledMotionToCustomMotion({ ...base, sampledTracks: [] })).toThrow(/track/);
    expect(() => convertSampledMotionToCustomMotion({
      ...base,
      sampledTracks: [
        { parameterId: 'A', samples: samplesOf([0, 1]) },
        { parameterId: 'A', samples: samplesOf([1, 0]) },
      ],
    })).toThrow(/Duplicate/);
  });

  it('exposes the versioned algorithm contract', () => {
    expect(CUSTOM_MOTION_FIT_ALGORITHM_VERSION).toBe(1);
    expect(CUSTOM_MOTION_DENSITY_ERROR_RATIOS).toEqual({ sparse: 0.05, standard: 0.02, fine: 0.005 });
  });

  describe('estimateCustomMotionKeyframes', () => {
    it('returns 0 for non-positive or non-finite duration', () => {
      expect(estimateCustomMotionKeyframes(0, 'standard')).toBe(0);
      expect(estimateCustomMotionKeyframes(-1, 'standard')).toBe(0);
      expect(estimateCustomMotionKeyframes(Number.NaN, 'standard')).toBe(0);
    });

    it('estimates exact frame count for perFrame density at 60 fps', () => {
      expect(estimateCustomMotionKeyframes(1.0, 'perFrame', 60)).toBe(60);
      expect(estimateCustomMotionKeyframes(2.0, 'perFrame', 60)).toBe(120);
      expect(estimateCustomMotionKeyframes(2.5, 'perFrame', 60)).toBe(150);
    });

    it('estimates proportional frames for sparse, standard, fine densities at 60 fps', () => {
      // 2.0s at 60fps = 120 frames
      expect(estimateCustomMotionKeyframes(2.0, 'sparse', 60)).toBe(12); // 10%
      expect(estimateCustomMotionKeyframes(2.0, 'standard', 60)).toBe(30); // 25%
      expect(estimateCustomMotionKeyframes(2.0, 'fine', 60)).toBe(72); // 60%
      expect(estimateCustomMotionKeyframes(2.0, 'perFrame', 60)).toBe(120); // 100%
    });

    it('respects custom scene fps', () => {
      // 2.0s at 30fps = 60 frames
      expect(estimateCustomMotionKeyframes(2.0, 'perFrame', 30)).toBe(60);
      expect(estimateCustomMotionKeyframes(2.0, 'standard', 30)).toBe(15);
    });
  });
});
