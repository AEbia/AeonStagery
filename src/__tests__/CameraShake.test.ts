import { describe, expect, it } from 'vitest';
import { computeCameraShakeAtTime, sampleCameraShake } from '../engine/CameraShake';
import type { RuntimeTimelineAction } from '../engine/RuntimeTimelineScene';

const first: RuntimeTimelineAction = {
  _id: 'shake-1', action: 'cameraShake', time: 1,
  params: { intensity: 0.6, frequency: 8, duration: 2, decay: false, direction: 'horizontal' },
};

describe('deterministic camera shake envelopes', () => {
  it('samples the same frame after seeking before and after a shake', () => {
    const expected = computeCameraShakeAtTime([first], 1.2);
    expect(expected.x).not.toBe(0);
    expect(expected.y).toBe(0);
    expect(computeCameraShakeAtTime([first], 0)).toEqual({ x: 0, y: 0 });
    expect(computeCameraShakeAtTime([first], 3)).toEqual({ x: 0, y: 0 });
    expect(computeCameraShakeAtTime([first], 1.2)).toEqual(expected);
  });

  it('adds overlapping envelopes and preserves earlier effects when a later effect is scheduled', () => {
    const second = { ...first, _id: 'shake-2', time: 1.5, params: { ...first.params, direction: 'vertical' } };
    const combined = computeCameraShakeAtTime([first, second], 1.7);
    const horizontal = computeCameraShakeAtTime([first], 1.7);
    expect(combined.x).toBe(horizontal.x);
    expect(combined.y).not.toBe(0);
    expect(computeCameraShakeAtTime([first, second], 1.2)).toEqual(computeCameraShakeAtTime([first], 1.2));
  });

  it('releases earlier envelopes on reset and can reconstruct them on a backward seek', () => {
    const reset: RuntimeTimelineAction = { _id: 'reset', action: 'cameraReset', time: 1.5, params: { duration: 0.5 } };
    expect(computeCameraShakeAtTime([first, reset], 1.6)).toEqual({ x: 0, y: 0 });
    expect(computeCameraShakeAtTime([first, reset], 1.2).x).not.toBe(0);
    const restart = { ...first, _id: 'restart', time: 1.6 };
    expect(computeCameraShakeAtTime([first, reset, restart], 1.8).x).not.toBe(0);
  });

  it('obeys source order for a reset at the same time as a shake', () => {
    const reset: RuntimeTimelineAction = { _id: 'reset', action: 'cameraReset', time: 1, params: {} };
    expect(computeCameraShakeAtTime([first, reset], 1.2)).toEqual({ x: 0, y: 0 });
    expect(computeCameraShakeAtTime([reset, first], 1.2).x).not.toBe(0);
  });

  it('handles zero duration, zero frequency and zero intensity without invalid offsets', () => {
    for (const config of [{ duration: 0 }, { frequency: 0 }, { intensity: 0 }]) {
      expect(sampleCameraShake(config, 0.1)).toEqual({ x: 0, y: 0 });
    }
  });

  it('respects direction and decay and ends within the authored duration', () => {
    const config = { duration: 2, frequency: 8, intensity: 1, direction: 'vertical' as const };
    const steady = sampleCameraShake({ ...config, decay: false }, 0.6);
    const decayed = sampleCameraShake(config, 0.6);
    expect(steady.x).toBe(0);
    expect(steady.y).not.toBe(0);
    expect(decayed.y).toBeCloseTo(steady.y * 0.7);
    expect(sampleCameraShake(config, 2)).toEqual({ x: 0, y: 0 });
    expect(sampleCameraShake({ ...config, decay: false }, 2)).toEqual({ x: 0, y: 0 });
  });
});
