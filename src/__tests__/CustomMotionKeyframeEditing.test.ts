import { describe, expect, it } from 'vitest';
import type { CharacterMotionOutput } from '../api/types/semantic-scene';
import { evaluateCustomMotionTrack } from '../engine/live2d/customMotion';
import {
  applyCustomMotionKeyframeEdits,
  assertValidCustomMotionEdit,
  cropCustomMotionToDuration,
  maxAllowedDuration,
} from '../services/timeline-authoring/customMotionKeyframeEdits';

type CustomMotion = Extract<CharacterMotionOutput, { kind: 'custom' }>;

function makeMotion(overrides: Partial<CustomMotion> = {}): CustomMotion {
  return {
    kind: 'custom',
    durationSeconds: 2,
    fadeInSeconds: 0.3,
    derivedFrom: { key: 'wave', fadeInSeconds: 0.4, fadeOutSeconds: 0.2 },
    tracks: [
      {
        parameterId: 'PARAM_ANGLE_X',
        keyframes: [
          { time: 0, value: 0, segment: { type: 'linear' } },
          { time: 1, value: 10, segment: { type: 'linear' } },
          { time: 2, value: 5 },
        ],
      },
      {
        parameterId: 'PARAM_EYE_OPEN',
        keyframes: [
          { time: 0, value: 1, segment: { type: 'linear' } },
          { time: 2, value: 1 },
        ],
      },
    ],
    ...overrides,
  };
}

describe('applyCustomMotionKeyframeEdits', () => {
  it('inserts a keyframe inside a segment inheriting the segment type', () => {
    const result = applyCustomMotionKeyframeEdits(makeMotion(), [
      { type: 'insert-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 0.5, value: 5 },
    ]);
    const track = result.tracks[0];
    expect(track.keyframes.map((keyframe) => keyframe.time)).toEqual([0, 0.5, 1, 2]);
    expect(track.keyframes[1].value).toBe(5);
    expect(track.keyframes[1].segment).toEqual({ type: 'linear' });
    expect(track.keyframes[track.keyframes.length - 1]).not.toHaveProperty('segment');
  });

  it('inserts at the tail without a segment (new last keyframe)', () => {
    const result = applyCustomMotionKeyframeEdits(makeMotion(), [
      { type: 'insert-keyframe', trackParameterId: 'PARAM_EYE_OPEN', time: 1.5, value: 0.5, segment: { type: 'linear' } },
    ]);
    const track = result.tracks[1];
    expect(track.keyframes.map((keyframe) => keyframe.time)).toEqual([0, 1.5, 2]);
    expect(track.keyframes[1].value).toBe(0.5);
    expect(track.keyframes[1].segment).toEqual({ type: 'linear' });
    expect(track.keyframes[2]).not.toHaveProperty('segment');
  });

  it('rejects duplicate insertion times', () => {
    expect(() => applyCustomMotionKeyframeEdits(makeMotion(), [
      { type: 'insert-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 1, value: 9 },
    ])).toThrowError(/occupied/);
  });

  it('deletes non-F0 keyframes and protects F0', () => {
    const result = applyCustomMotionKeyframeEdits(makeMotion(), [
      { type: 'remove-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 1 },
    ]);
    expect(result.tracks[0].keyframes.map((keyframe) => keyframe.time)).toEqual([0, 2]);
    expect(result.tracks[0].keyframes[0].segment).toEqual({ type: 'linear' });
    expect(result.tracks[0].keyframes[1]).not.toHaveProperty('segment');

    expect(() => applyCustomMotionKeyframeEdits(makeMotion(), [
      { type: 'remove-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 0 },
    ])).toThrowError(/protected/);

    expect(() => applyCustomMotionKeyframeEdits(makeMotion(), [
      { type: 'remove-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 1.5 },
    ])).toThrowError(/not found/);
  });

  it('updates values without moving (F0 value edit allowed)', () => {
    const result = applyCustomMotionKeyframeEdits(makeMotion(), [
      { type: 'update-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 0, value: -2 },
    ]);
    expect(result.tracks[0].keyframes[0]).toEqual({ time: 0, value: -2, segment: { type: 'linear' } });
  });

  it('moves a keyframe and leaves an equal-value F0 boundary when F0 moves', () => {
    const result = applyCustomMotionKeyframeEdits(makeMotion(), [
      { type: 'update-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 0, value: 0, newTime: 0.5 },
    ]);
    const track = result.tracks[0];
    expect(track.keyframes.map((keyframe) => keyframe.time)).toEqual([0, 0.5, 1, 2]);
    expect(track.keyframes[0].value).toBe(0);
    expect(track.keyframes[0].segment).toEqual({ type: 'linear' });
    expect(track.keyframes[1].value).toBe(0);

    const moved = applyCustomMotionKeyframeEdits(makeMotion(), [
      { type: 'update-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 1, value: 11, newTime: 1.5 },
    ]);
    expect(moved.tracks[0].keyframes.map((keyframe) => keyframe.time)).toEqual([0, 1.5, 2]);
    expect(moved.tracks[0].keyframes[1].value).toBe(11);
  });

  it('splits the original F0 bezier segment losslessly when F0 moves', () => {
    const motion = makeMotion();
    (motion.tracks[0] as { keyframes: CustomMotion['tracks'][number]['keyframes'] }).keyframes = [
      {
        time: 0,
        value: 0,
        segment: {
          type: 'bezier',
          controlPoints: [
            { time: 0.25, value: 4 },
            { time: 0.75, value: 8 },
          ],
        },
      },
      { time: 1, value: 10, segment: { type: 'linear' } },
      { time: 2, value: 20 },
    ];
    const result = applyCustomMotionKeyframeEdits(motion, [
      { type: 'update-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 0, value: 0, newTime: 0.5 },
    ]);
    const boundary = result.tracks[0].keyframes[0];
    expect(boundary.time).toBe(0);
    expect(boundary.value).toBe(0);
    // The carried segment must stay valid under the cp ordering contract:
    // moving F0 splits the original segment (de Casteljau at 0.5) so both
    // halves keep their control points inside the new spans.
    expect(boundary.segment).toEqual({
      type: 'bezier',
      controlPoints: [
        { time: 0.125, value: 2 },
        { time: 0.3125, value: 4 },
      ],
    });
    const moved = result.tracks[0].keyframes[1];
    expect(moved.time).toBe(0.5);
    expect(moved.segment).toEqual({
      type: 'bezier',
      controlPoints: [
        { time: 0.6875, value: 7.5 },
        { time: 0.875, value: 9 },
      ],
    });
    expect(boundary.segment).not.toBe(motion.tracks[0].keyframes[0].segment);
  });

  it('drops a carried bezier segment when the move jumps past the old span', () => {
    const motion = makeMotion();
    (motion.tracks[0] as { keyframes: CustomMotion['tracks'][number]['keyframes'] }).keyframes = [
      {
        time: 0,
        value: 0,
        segment: {
          type: 'bezier',
          controlPoints: [
            { time: 0.25, value: 4 },
            { time: 0.75, value: 8 },
          ],
        },
      },
      { time: 1, value: 10, segment: { type: 'linear' } },
      { time: 2, value: 20 },
    ];
    // F0 jumps past the first keyframe: the old span [0, 1] can no longer be
    // split at 1.5, so the carried control points fall back to an explicit
    // linear segment (ADR-0029: every non-last keyframe carries a segment).
    const result = applyCustomMotionKeyframeEdits(motion, [
      { type: 'update-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 0, value: 0, newTime: 1.5 },
    ]);
    const moved = result.tracks[0].keyframes[2];
    expect(moved.time).toBe(1.5);
    expect(moved.segment).toEqual({ type: 'linear' });
    expect(moved.value).toBe(0);
  });

  it('rejects moves onto an occupied time', () => {
    expect(() => applyCustomMotionKeyframeEdits(makeMotion(), [
      { type: 'update-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 0, value: 0, newTime: 1 },
    ])).toThrowError(/occupied/);
  });

  it('sets outer and track-level fades and removes track overrides', () => {
    const motion = makeMotion();
    (motion.tracks[0] as { fadeInSeconds?: number }).fadeInSeconds = 0.6;
    const result = applyCustomMotionKeyframeEdits(motion, [
      { type: 'set-fade-in', fadeInSeconds: 0.4 },
      { type: 'set-fade-in', trackParameterId: 'PARAM_ANGLE_X', fadeInSeconds: 0 },
    ]);
    expect(result.fadeInSeconds).toBe(0.4);
    expect(result.tracks[0].fadeInSeconds).toBe(0);

    const removed = applyCustomMotionKeyframeEdits(result, [
      { type: 'set-fade-in', trackParameterId: 'PARAM_ANGLE_X', fadeInSeconds: null },
    ]);
    expect(removed.tracks[0]).not.toHaveProperty('fadeInSeconds');

    expect(() => applyCustomMotionKeyframeEdits(makeMotion(), [
      { type: 'set-fade-in', fadeInSeconds: null },
    ])).toThrowError(/required/);
    expect(() => applyCustomMotionKeyframeEdits(makeMotion(), [
      { type: 'set-fade-in', trackParameterId: 'MISSING', fadeInSeconds: 0.1 },
    ])).toThrowError(/not found/);
  });

  it('sets the outgoing segment type of an interior keyframe', () => {
    const result = applyCustomMotionKeyframeEdits(makeMotion(), [
      { type: 'set-segment', trackParameterId: 'PARAM_ANGLE_X', time: 1, segment: { type: 'bezier', controlPoints: [{ time: 1.3, value: 9 }, { time: 1.6, value: 6 }] } },
    ]);
    const keyframe = result.tracks[0].keyframes[1];
    expect(keyframe.segment).toEqual({ type: 'bezier', controlPoints: [{ time: 1.3, value: 9 }, { time: 1.6, value: 6 }] });
  });

  it('keeps an explicit linear segment when switching back to linear', () => {
    const motion = makeMotion();
    (motion.tracks[0].keyframes[1] as { segment?: unknown }).segment = { type: 'stepped' };
    const result = applyCustomMotionKeyframeEdits(motion, [
      { type: 'set-segment', trackParameterId: 'PARAM_ANGLE_X', time: 1, segment: { type: 'linear' } },
    ]);
    // The contract requires every non-last keyframe to carry an explicit
    // segment, linear included (ADR-0029); the edit must not strip it.
    const keyframe = result.tracks[0].keyframes[1];
    expect(keyframe.segment).toEqual({ type: 'linear' });
  });

  it('inserts after the last keyframe, giving the former last an explicit linear segment', () => {
    const result = applyCustomMotionKeyframeEdits(makeMotion(), [
      { type: 'set-duration', durationSeconds: 3 },
      { type: 'insert-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 2.5, value: 8 },
    ]);
    const track = result.tracks[0];
    expect(track.keyframes.map((keyframe) => keyframe.time)).toEqual([0, 1, 2, 2.5]);
    // The former last keyframe is interior now and must carry a segment;
    // appending at the curve end defaults to linear (ADR-0029).
    expect(track.keyframes[2].segment).toEqual({ type: 'linear' });
    expect(track.keyframes[3]).not.toHaveProperty('segment');
    expect(() => assertValidCustomMotionEdit(result)).not.toThrow();
  });

  it('falls back to an explicit linear segment when a move jumps past the old bezier span', () => {
    const motion = makeMotion();
    (motion.tracks[0] as { keyframes: CustomMotion['tracks'][number]['keyframes'] }).keyframes = [
      { time: 0, value: 0, segment: { type: 'linear' } },
      {
        time: 1,
        value: 10,
        segment: {
          type: 'bezier',
          controlPoints: [
            { time: 1.3, value: 12 },
            { time: 1.6, value: 8 },
          ],
        },
      },
      { time: 2, value: 20, segment: { type: 'linear' } },
      { time: 3, value: 30 },
    ];
    const result = applyCustomMotionKeyframeEdits(motion, [
      { type: 'set-duration', durationSeconds: 3.5 },
      { type: 'update-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 1, value: 10, newTime: 2.5 },
    ]);
    const moved = result.tracks[0].keyframes.find((keyframe) => keyframe.time === 2.5)!;
    // The carried bezier control points describe nothing under the new span;
    // the fallback must be an explicit linear segment, not a missing one.
    expect(moved.segment).toEqual({ type: 'linear' });
    expect(() => assertValidCustomMotionEdit(result)).not.toThrow();
  });

  it('defaults the former tail keyframe to an explicit linear segment when a move lands it interior', () => {
    const result = applyCustomMotionKeyframeEdits(makeMotion(), [
      { type: 'update-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 2, value: 20, newTime: 0.5 },
    ]);
    const track = result.tracks[0];
    expect(track.keyframes.map((keyframe) => keyframe.time)).toEqual([0, 0.5, 1]);
    // The moved keyframe carried no segment (it was the tail) and now sits
    // interior; the contract requires an explicit linear segment, not a
    // rejection of the whole batch (ADR-0029).
    expect(track.keyframes[1].segment).toEqual({ type: 'linear' });
    expect(() => assertValidCustomMotionEdit(result)).not.toThrow();
  });

  it('rejects set-segment on the last keyframe (segment omitted by codec)', () => {
    expect(() => applyCustomMotionKeyframeEdits(makeMotion(), [
      { type: 'set-segment', trackParameterId: 'PARAM_ANGLE_X', time: 2, segment: { type: 'stepped' } },
    ])).toThrowError(/segment/);
  });

  it('rejects set-segment on a missing keyframe or track and malformed bezier edits', () => {
    expect(() => applyCustomMotionKeyframeEdits(makeMotion(), [
      { type: 'set-segment', trackParameterId: 'PARAM_ANGLE_X', time: 1.5, segment: { type: 'stepped' } },
    ])).toThrowError(/not found/);
    expect(() => applyCustomMotionKeyframeEdits(makeMotion(), [
      { type: 'set-segment', trackParameterId: 'MISSING', time: 1, segment: { type: 'stepped' } },
    ])).toThrowError(/not found/);
    // A bezier segment with a single control point is rejected by the
    // editor's clone guard before it can reach the canonical contract.
    expect(() => applyCustomMotionKeyframeEdits(makeMotion(), [
      { type: 'set-segment', trackParameterId: 'PARAM_ANGLE_X', time: 1, segment: { type: 'bezier', controlPoints: [{ time: 1.3, value: 9 }] } as never },
    ])).toThrowError(/segment/);
  });

  it('crops with an interpolated boundary keyframe and strips trailing segments', () => {
    const result = applyCustomMotionKeyframeEdits(makeMotion(), [
      { type: 'set-duration', durationSeconds: 1.5 },
    ]);
    expect(result.durationSeconds).toBe(1.5);
    const track = result.tracks[0];
    expect(track.keyframes.map((keyframe) => keyframe.time)).toEqual([0, 1, 1.5]);
    expect(track.keyframes[2].value).toBe(7.5);
    expect(track.keyframes[2]).not.toHaveProperty('segment');
    // The static track is cropped to its F0 boundary only.
    expect(result.tracks[1].keyframes.map((keyframe) => keyframe.time)).toEqual([0, 1.5]);
    expect(result.tracks[1].keyframes[0].value).toBe(1);
  });

  it('extends without adding keyframes', () => {
    const result = applyCustomMotionKeyframeEdits(makeMotion(), [
      { type: 'set-duration', durationSeconds: 3 },
    ]);
    expect(result.durationSeconds).toBe(3);
    expect(result.tracks[0].keyframes.map((keyframe) => keyframe.time)).toEqual([0, 1, 2]);
  });

  it('rejects cropping below any active fade and invalid durations', () => {
    expect(() => applyCustomMotionKeyframeEdits(makeMotion(), [
      { type: 'set-duration', durationSeconds: 0.2 },
    ])).toThrowError(/fadeInSeconds/);

    const withTrackFade = makeMotion();
    (withTrackFade.tracks[0] as { fadeInSeconds?: number }).fadeInSeconds = 0.8;
    expect(() => applyCustomMotionKeyframeEdits(withTrackFade, [
      { type: 'set-duration', durationSeconds: 0.5 },
    ])).toThrowError(/fadeInSeconds/);

    expect(() => applyCustomMotionKeyframeEdits(makeMotion(), [
      { type: 'set-duration', durationSeconds: 0 },
    ])).toThrowError(/duration/);
  });

  it('never mutates the input motion', () => {
    const motion = makeMotion();
    const snapshot = JSON.parse(JSON.stringify(motion));
    applyCustomMotionKeyframeEdits(motion, [
      { type: 'update-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 1, value: 99 },
      { type: 'set-fade-in', fadeInSeconds: 0.9 },
    ]);
    expect(motion).toEqual(snapshot);
  });

  it('splits a bezier segment losslessly when inserting inside it', () => {
    const motion = makeMotion();
    (motion.tracks[0] as { keyframes: CustomMotion['tracks'][number]['keyframes'] }).keyframes = [
      {
        time: 0,
        value: 0,
        segment: {
          type: 'bezier',
          controlPoints: [
            { time: 0.4, value: 8 },
            { time: 0.7, value: 2 },
          ],
        },
      },
      { time: 1, value: 10, segment: { type: 'linear' } },
      { time: 2, value: 5 },
    ];
    const sampleTimes = [0.1, 0.25, 0.5, 0.9];
    const before = sampleTimes.map((time) => evaluateCustomMotionTrack(motion.tracks[0], time));
    const insertTime = 0.6;
    const curveValue = evaluateCustomMotionTrack(motion.tracks[0], insertTime)!;

    const result = applyCustomMotionKeyframeEdits(motion, [
      { type: 'insert-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: insertTime, value: curveValue },
    ]);

    const keyframes = result.tracks[0].keyframes;
    expect(keyframes.map((keyframe) => keyframe.time)).toEqual([0, 0.6, 1, 2]);
    expect(keyframes[0].segment?.type).toBe('bezier');
    const leftControlPoints = (keyframes[0].segment as unknown as { type: 'bezier'; controlPoints: Array<{ time: number; value: number }> }).controlPoints;
    expect(leftControlPoints).toHaveLength(2);
    leftControlPoints.forEach((point) => {
      expect(Number.isFinite(point.time)).toBe(true);
      expect(Number.isFinite(point.value)).toBe(true);
    });
    expect(keyframes[1].segment?.type).toBe('bezier');
    expect(keyframes[1].value).toBeCloseTo(curveValue, 6);
    const after = sampleTimes.map((time) => evaluateCustomMotionTrack(result.tracks[0], time));
    before.forEach((value, index) => expect(after[index]).toBeCloseTo(value!, 6));
  });

  it('keeps an explicit segment on the right half of a bezier insertion', () => {
    const motion = makeMotion();
    (motion.tracks[0] as { keyframes: CustomMotion['tracks'][number]['keyframes'] }).keyframes = [
      {
        time: 0,
        value: 0,
        segment: {
          type: 'bezier',
          controlPoints: [
            { time: 0.4, value: 8 },
            { time: 0.7, value: 2 },
          ],
        },
      },
      { time: 1, value: 10, segment: { type: 'linear' } },
      { time: 2, value: 5 },
    ];

    const result = applyCustomMotionKeyframeEdits(motion, [
      {
        type: 'insert-keyframe',
        trackParameterId: 'PARAM_ANGLE_X',
        time: 0.6,
        value: 5,
        segment: { type: 'linear' },
      },
    ]);

    // The left half is the de Casteljau split of the original bezier; the
    // right half uses the caller's explicit segment. An off-curve value only
    // changes the local curve (insert-then-modify semantics), so lossless
    // equality is not asserted here.
    expect(result.tracks[0].keyframes.map((keyframe) => keyframe.time)).toEqual([0, 0.6, 1, 2]);
    expect(result.tracks[0].keyframes[0].segment?.type).toBe('bezier');
    expect(result.tracks[0].keyframes[1].segment).toEqual({ type: 'linear' });
    expect(result.tracks[0].keyframes[1].value).toBe(5);
    expect(result.tracks[0].keyframes[0].value).toBe(0);
  });

  it('splits a bezier segment losslessly when cropping inside it', () => {
    const motion = makeMotion();
    (motion.tracks[0] as { keyframes: CustomMotion['tracks'][number]['keyframes'] }).keyframes = [
      {
        time: 0,
        value: 0,
        segment: {
          type: 'bezier',
          controlPoints: [
            { time: 0.4, value: 8 },
            { time: 0.7, value: 2 },
          ],
        },
      },
      { time: 1, value: 10, segment: { type: 'linear' } },
      { time: 2, value: 5 },
    ];
    const sampleTimes = [0.1, 0.25, 0.5, 0.55];
    const before = sampleTimes.map((time) => evaluateCustomMotionTrack(motion.tracks[0], time));

    const result = cropCustomMotionToDuration(motion, 0.6);

    expect(result.durationSeconds).toBe(0.6);
    expect(result.tracks[0].keyframes.map((keyframe) => keyframe.time)).toEqual([0, 0.6]);
    expect(result.tracks[0].keyframes[0].segment?.type).toBe('bezier');
    expect(result.tracks[0].keyframes[1]).not.toHaveProperty('segment');
    expect(result.tracks[0].keyframes[1].value).toBeCloseTo(
      evaluateCustomMotionTrack(motion.tracks[0], 0.6)!,
      6,
    );
    const after = sampleTimes.map((time) => evaluateCustomMotionTrack(result.tracks[0], time));
    before.forEach((value, index) => expect(after[index]).toBeCloseTo(value!, 6));
  });

  describe('assertValidCustomMotionEdit (editor adapter)', () => {
    // The full invariant matrix lives in CustomMotionContract.test.ts; this
    // adapter test only verifies the thin error conversion onto editor codes.
    const mutable = () => JSON.parse(JSON.stringify(makeMotion())) as CustomMotion & {
      tracks: Array<{ parameterId: string; fadeInSeconds?: number; keyframes: Array<{ time: number; value: number; segment?: unknown }> }>;
    };
    const expectMapped = (motion: CustomMotion, code: string, contractPath: string) => {
      let captured: unknown;
      try {
        assertValidCustomMotionEdit(motion);
      } catch (error) {
        captured = error;
      }
      expect(captured).toMatchObject({
        name: 'CustomMotionEditError',
        code,
        details: { contractPath },
      });
    };

    it('maps canonical contract violations onto editor domain codes', () => {
      const noF0 = mutable();
      noF0.tracks[0].keyframes = [{ time: 0.5, value: 0 }, { time: 1, value: 1 }];
      expectMapped(noF0 as CustomMotion, 'f0-protected', 'tracks[0].keyframes[0].time');

      const duplicate = mutable();
      duplicate.tracks = [...duplicate.tracks, { parameterId: 'PARAM_ANGLE_X', keyframes: [{ time: 0, value: 0 }] }];
      expectMapped(duplicate as CustomMotion, 'duplicate-track', 'tracks[2].parameterId');

      const belowFade = mutable();
      (belowFade as { fadeInSeconds?: number }).fadeInSeconds = 3;
      expectMapped(belowFade as CustomMotion, 'duration-below-fade', 'fadeInSeconds');

      const badValue = mutable();
      badValue.tracks[0].keyframes[1].value = Number.NaN;
      expectMapped(badValue as CustomMotion, 'invalid-keyframe', 'tracks[0].keyframes[1].value');

      const badSegment = mutable();
      (badSegment.tracks[0].keyframes[0].segment as { type: string }).type = 'bogus';
      expectMapped(badSegment as CustomMotion, 'invalid-segment', 'tracks[0].keyframes[0].segment.type');

      const empty = mutable();
      empty.tracks = [];
      expectMapped(empty as CustomMotion, 'track-not-found', 'tracks');
    });
  });
});

describe('cropCustomMotionToDuration / maxAllowedDuration', () => {
  it('crop and maxAllowedDuration stay consistent with the edit path', () => {
    const motion = makeMotion();
    const cropped = cropCustomMotionToDuration(motion, 1.2);
    expect(cropped.durationSeconds).toBe(1.2);
    expect(cropped.tracks[0].keyframes.map((keyframe) => keyframe.time)).toEqual([0, 1, 1.2]);
    expect(maxAllowedDuration(motion)).toBe(0.3);

    const withTrackFade = makeMotion();
    (withTrackFade.tracks[0] as { fadeInSeconds?: number }).fadeInSeconds = 0.8;
    expect(maxAllowedDuration(withTrackFade)).toBe(0.8);
  });
});
