import { describe, expect, it } from 'vitest';
import {
  assertValidParameterTrack,
  evaluateParameterTrack,
  ParameterTrackValidationError,
  type ParameterTrack,
} from '../engine/live2d/parameterTrackEvaluator';

function track(keyframes: ParameterTrack['keyframes']): ParameterTrack {
  return { parameterId: 'PARAM_ANGLE_X', keyframes };
}

describe('evaluateParameterTrack', () => {
  it('returns undefined outside the first-to-last keyframe range', () => {
    const curve = track([
      { time: 0, value: 0 },
      { time: 1, value: 10 },
    ]);

    expect(evaluateParameterTrack(curve, -0.001)).toBeUndefined();
    expect(evaluateParameterTrack(curve, 1.001)).toBeUndefined();
    expect(evaluateParameterTrack(curve, Number.NaN)).toBeUndefined();
  });

  it('returns exact keyframe values without easing drift', () => {
    const curve = track([
      { time: 0, value: 2 },
      { time: 0.5, value: 22, ease: 'power2.out' },
      { time: 1, value: -4, ease: 'sine.inOut' },
    ]);

    expect(evaluateParameterTrack(curve, 0)).toBe(2);
    expect(evaluateParameterTrack(curve, 0.5)).toBe(22);
    expect(evaluateParameterTrack(curve, 1)).toBe(-4);
  });

  it('uses the destination keyframe easing for interpolation', () => {
    const curve = track([
      { time: 0, value: 0 },
      { time: 1, value: 10, ease: 'power2.out' },
    ]);

    // The repository's GSAP power2.out curve evaluates to 0.875 at 0.5,
    // rather than the linear midpoint of 5.
    expect(evaluateParameterTrack(curve, 0.5)).toBeCloseTo(8.75, 12);
  });

  it('defaults to linear interpolation when easing is omitted', () => {
    const curve = track([
      { time: 0, value: -2 },
      { time: 2, value: 6 },
    ]);

    expect(evaluateParameterTrack(curve, 0.5)).toBe(0);
    expect(evaluateParameterTrack(curve, 1)).toBe(2);
  });

  it('rejects unsorted or duplicate keyframe times instead of normalizing them', () => {
    const unsorted = track([
      { time: 1, value: 10 },
      { time: 0, value: 0 },
    ]);
    const duplicate = track([
      { time: 0, value: 0 },
      { time: 0, value: 10 },
    ]);

    expect(() => assertValidParameterTrack(unsorted)).toThrow(ParameterTrackValidationError);
    expect(() => evaluateParameterTrack(unsorted, 0.5)).toThrow(/strictly increasing/);
    expect(() => evaluateParameterTrack(duplicate, 0)).toThrow(/strictly increasing/);
  });

  it('produces the same value on repeated evaluation at the same time', () => {
    const curve = track([
      { time: 0, value: -3 },
      { time: 0.7, value: 18, ease: 'sine.inOut' },
      { time: 1.4, value: 4, ease: 'back.out(1.5)' },
    ]);

    const values = Array.from({ length: 10 }, () => evaluateParameterTrack(curve, 0.91));
    expect(new Set(values).size).toBe(1);
  });
});
