import { describe, expect, it } from 'vitest';
import type { CharacterMotionOutput, CustomMotionKeyframe, CustomMotionTrack } from '../api/types/semantic-scene';
import {
  evaluateCustomMotion,
  evaluateCustomMotionSegment,
  evaluateCustomMotionTrack,
  solveBezierTime,
} from '../engine/live2d/customMotion';

function motionOf(
  tracks: Extract<CharacterMotionOutput, { kind: 'custom' }>['tracks'],
  durationSeconds = 2,
): Extract<CharacterMotionOutput, { kind: 'custom' }> {
  return {
    kind: 'custom',
    durationSeconds,
    fadeInSeconds: 0.5,
    derivedFrom: { key: 'source' },
    tracks,
  };
}

describe('evaluateCustomMotionTrack', () => {
  it('interpolates linear segments and holds the tail value', () => {
    const track: CustomMotionTrack = {
      parameterId: 'PARAM_ANGLE_X',
      keyframes: [
        { time: 0, value: 0, segment: { type: 'linear' } },
        { time: 1, value: 10, segment: { type: 'linear' } },
        { time: 2, value: 20 },
      ],
    };

    expect(evaluateCustomMotionTrack(track, 0)).toBe(0);
    expect(evaluateCustomMotionTrack(track, 0.5)).toBeCloseTo(5);
    expect(evaluateCustomMotionTrack(track, 1.5)).toBeCloseTo(15);
    expect(evaluateCustomMotionTrack(track, 2)).toBe(20);
    expect(evaluateCustomMotionTrack(track, 5)).toBe(20);
  });

  it('keeps the current value for stepped segments', () => {
    const track: CustomMotionTrack = {
      parameterId: 'PARAM_ANGLE_X',
      keyframes: [
        { time: 0, value: 0, segment: { type: 'stepped' } },
        { time: 1, value: 10, segment: { type: 'stepped' } },
        { time: 2, value: 20 },
      ],
    };

    expect(evaluateCustomMotionTrack(track, 0.4)).toBe(0);
    expect(evaluateCustomMotionTrack(track, 0.999)).toBe(0);
    expect(evaluateCustomMotionTrack(track, 1)).toBe(10);
    expect(evaluateCustomMotionTrack(track, 1.5)).toBe(10);
    expect(evaluateCustomMotionTrack(track, 2)).toBe(20);
  });

  it('adopts the next value immediately for inverse stepped segments', () => {
    const track: CustomMotionTrack = {
      parameterId: 'PARAM_ANGLE_X',
      keyframes: [
        { time: 0, value: 0, segment: { type: 'inverseStepped' } },
        { time: 1, value: 10, segment: { type: 'inverseStepped' } },
        { time: 2, value: 20 },
      ],
    };

    expect(evaluateCustomMotionTrack(track, 0.01)).toBe(10);
    expect(evaluateCustomMotionTrack(track, 0.5)).toBe(10);
    expect(evaluateCustomMotionTrack(track, 1.01)).toBe(20);
    expect(evaluateCustomMotionTrack(track, 2)).toBe(20);
  });

  it('evaluates bezier segments through absolute control point coordinates', () => {
    const track: CustomMotionTrack = {
      parameterId: 'PARAM_ANGLE_X',
      keyframes: [
        {
          time: 0,
          value: 0,
          segment: {
            type: 'bezier',
            controlPoints: [
              { time: 1 / 3, value: 5 },
              { time: 2 / 3, value: 5 },
            ],
          },
        },
        { time: 1, value: 10 },
      ],
    };

    expect(evaluateCustomMotionTrack(track, 0.5)).toBeCloseTo(5, 6);
    expect(evaluateCustomMotionTrack(track, 0.25)).toBeCloseTo(2.96875, 6);
    expect(evaluateCustomMotionTrack(track, 0)).toBe(0);
    expect(evaluateCustomMotionTrack(track, 1)).toBe(10);
  });

  it('solves bezier time for non-equidistant control point times', () => {
    const track: CustomMotionTrack = {
      parameterId: 'PARAM_ANGLE_X',
      keyframes: [
        {
          time: 0,
          value: 0,
          segment: {
            type: 'bezier',
            controlPoints: [
              { time: 0.2, value: 0 },
              { time: 0.9, value: 10 },
            ],
          },
        },
        { time: 1, value: 10 },
      ],
    };

    expect(evaluateCustomMotionTrack(track, 0)).toBe(0);
    expect(evaluateCustomMotionTrack(track, 1)).toBe(10);
    const mid = evaluateCustomMotionTrack(track, 0.5)!;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(10);
  });

  it('returns null for invalid local times and unknown parameters', () => {
    const track: CustomMotionTrack = {
      parameterId: 'PARAM_ANGLE_X',
      keyframes: [
        { time: 0, value: 0, segment: { type: 'linear' } },
        { time: 1, value: 10 },
      ],
    };

    expect(evaluateCustomMotionTrack(track, Number.NaN)).toBeNull();
    expect(evaluateCustomMotionTrack(track, Number.POSITIVE_INFINITY)).toBeNull();
    expect(evaluateCustomMotionTrack({ ...track, parameterId: '' }, 0.5)).toBeNull();
    expect(evaluateCustomMotionTrack({ ...track, keyframes: [] }, 0.5)).toBeNull();
  });

  it('returns the first keyframe value before F0', () => {
    const track: CustomMotionTrack = {
      parameterId: 'PARAM_ANGLE_X',
      keyframes: [
        { time: 0, value: 5, segment: { type: 'linear' } },
        { time: 1, value: 10 },
      ],
    };

    expect(evaluateCustomMotionTrack(track, -1)).toBe(5);
  });

  it('stays deterministic for out-of-order bezier control point times (regression)', () => {
    // Legacy / hand-edited data can carry control point times outside the
    // segment span; x(t) then doubles back and has multiple roots. The grid
    // scan must pick the root nearest the linear guess instead of converging
    // to an arbitrary wrong root. Here x(t) = 0.5 has three roots
    // (≈0.2598, 0.5, ≈0.7402) and the linear guess is exactly 0.5.
    const track: CustomMotionTrack = {
      parameterId: 'PARAM_ANGLE_X',
      keyframes: [
        {
          time: 0,
          value: 0,
          segment: {
            type: 'bezier',
            controlPoints: [
              { time: 1.2, value: 0 },
              { time: -0.2, value: 10 },
            ],
          },
        },
        { time: 1, value: 10 },
      ],
    };

    const f0 = track.keyframes[0];
    const segment = f0.segment;
    const [cp1, cp2] = segment?.type === 'bezier'
      ? segment.controlPoints
      : [{ time: 0, value: 0 }, { time: 0, value: 0 }];

    expect(solveBezierTime(f0, cp1, cp2, track.keyframes[1], 0.5)).toBeCloseTo(0.5, 9);
    expect(evaluateCustomMotionTrack(track, 0.5)).toBeCloseTo(5, 6);
    expect(evaluateCustomMotionTrack(track, 0.05)).toBeGreaterThan(0);
    expect(evaluateCustomMotionTrack(track, 0.95)).toBeLessThan(10);
    expect(Number.isFinite(evaluateCustomMotionTrack(track, 0.3)!)).toBe(true);
  });
});

describe('evaluateCustomMotionSegment', () => {
  it('evaluates the outgoing segment without a parameterId (editor lane insert)', () => {
    // The editor samples a segment between two existing keyframes through
    // this function; a synthetic track with an empty parameterId must not be
    // needed and must not fall back to the segment-start value.
    const a: CustomMotionKeyframe = { time: 0, value: 0, segment: { type: 'linear' } };
    const b: CustomMotionKeyframe = { time: 1, value: 10 };
    expect(evaluateCustomMotionSegment(a, b, 0.5)).toBeCloseTo(5, 9);
    expect(evaluateCustomMotionSegment(a, b, 0.25)).toBeCloseTo(2.5, 9);
  });

  it('evaluates bezier and stepped segments through the shared evaluator', () => {
    const bezier: CustomMotionKeyframe = {
      time: 0,
      value: 0,
      segment: {
        type: 'bezier',
        controlPoints: [
          { time: 1 / 3, value: 5 },
          { time: 2 / 3, value: 5 },
        ],
      },
    };
    expect(evaluateCustomMotionSegment(bezier, { time: 1, value: 10 }, 0.5)).toBeCloseTo(5, 6);
    const stepped: CustomMotionKeyframe = { time: 0, value: 3, segment: { type: 'stepped' } };
    expect(evaluateCustomMotionSegment(stepped, { time: 1, value: 10 }, 0.9)).toBe(3);
  });
});

describe('evaluateCustomMotion', () => {
  it('aggregates all tracks into a parameter value map', () => {
    const motion = motionOf([
      {
        parameterId: 'PARAM_ANGLE_X',
        keyframes: [
          { time: 0, value: 0, segment: { type: 'linear' } },
          { time: 2, value: 20 },
        ],
      },
      {
        parameterId: 'PARAM_ANGLE_Y',
        keyframes: [
          { time: 0, value: 0, segment: { type: 'stepped' } },
          { time: 2, value: 5 },
        ],
      },
    ]);

    const frame = evaluateCustomMotion(motion, 1);
    expect(frame.active).toBe(true);
    expect(frame.values).toEqual({
      PARAM_ANGLE_X: 10,
      PARAM_ANGLE_Y: 0,
    });
  });

  it('marks negative or non-finite times as inactive', () => {
    const motion = motionOf([
      {
        parameterId: 'PARAM_ANGLE_X',
        keyframes: [
          { time: 0, value: 0, segment: { type: 'linear' } },
          { time: 2, value: 20 },
        ],
      },
    ]);

    expect(evaluateCustomMotion(motion, -0.5).active).toBe(false);
    expect(evaluateCustomMotion(motion, Number.NaN).active).toBe(false);
    expect(evaluateCustomMotion(motion, Number.POSITIVE_INFINITY).active).toBe(false);
  });

  it('holds tail values beyond the last keyframe', () => {
    const motion = motionOf([
      {
        parameterId: 'PARAM_ANGLE_X',
        keyframes: [
          { time: 0, value: 0, segment: { type: 'linear' } },
          { time: 2, value: 20 },
        ],
      },
    ]);

    expect(evaluateCustomMotion(motion, 10).values.PARAM_ANGLE_X).toBe(20);
  });

  it('correctly evaluates tracks with more than 8 keyframes using binary search', () => {
    const keyframes: CustomMotionKeyframe[] = [];
    for (let i = 0; i <= 20; i++) {
      keyframes.push({
        time: i * 0.5,
        value: i * 10,
        ...(i < 20 ? { segment: { type: 'linear' as const } } : {}),
      });
    }
    const track: CustomMotionTrack = {
      parameterId: 'PARAM_BIG_TRACK',
      keyframes,
    };

    expect(evaluateCustomMotionTrack(track, 0)).toBe(0);
    expect(evaluateCustomMotionTrack(track, 0.25)).toBeCloseTo(5);
    expect(evaluateCustomMotionTrack(track, 2.5)).toBeCloseTo(50);
    expect(evaluateCustomMotionTrack(track, 7.25)).toBeCloseTo(145);
    expect(evaluateCustomMotionTrack(track, 9.75)).toBeCloseTo(195);
    expect(evaluateCustomMotionTrack(track, 10)).toBe(200);
    expect(evaluateCustomMotionTrack(track, 15)).toBe(200);
  });
});
