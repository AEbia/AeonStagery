import { describe, expect, it } from 'vitest';
import type { CharacterMotionOutput } from '../api/types/semantic-scene';
import {
  applyCustomMotionValues,
  cubismSineFadeWeight,
  customMotionControlledParameterIds,
  evaluateCustomMotionRuntime,
  resolveTrackFadeInSeconds,
  seedCustomMotionFadeResumeFrames,
  selectHandoffPoseValues,
} from '../engine/live2d/customMotionRuntime';

function customMotionOf(
  overrides: Partial<Extract<CharacterMotionOutput, { kind: 'custom' }>> = {},
): Extract<CharacterMotionOutput, { kind: 'custom' }> {
  return {
    kind: 'custom',
    durationSeconds: 2,
    fadeInSeconds: 0.5,
    derivedFrom: { key: 'wave' },
    tracks: [
      {
        parameterId: 'PARAM_ANGLE_X',
        keyframes: [
          { time: 0, value: 0, segment: { type: 'linear' } },
          { time: 2, value: 20 },
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

describe('cubismSineFadeWeight', () => {
  it('follows 0.5 - 0.5 * cos(progress * PI) and clamps', () => {
    expect(cubismSineFadeWeight(0)).toBe(0);
    expect(cubismSineFadeWeight(1)).toBe(1);
    expect(cubismSineFadeWeight(0.5)).toBeCloseTo(0.5);
    expect(cubismSineFadeWeight(-1)).toBe(0);
    expect(cubismSineFadeWeight(2)).toBe(1);
  });
});

describe('resolveTrackFadeInSeconds', () => {
  it('prefers the track fade-in and falls back to the motion fade-in', () => {
    const motion = customMotionOf();
    expect(resolveTrackFadeInSeconds(motion.tracks[0], 0.5)).toBe(0.5);
    expect(resolveTrackFadeInSeconds({ ...motion.tracks[0], fadeInSeconds: 0 }, 0.5)).toBe(0);
    expect(resolveTrackFadeInSeconds({ ...motion.tracks[0], fadeInSeconds: 1.5 }, 0.5)).toBe(1.5);
  });
});

describe('evaluateCustomMotionRuntime', () => {
  it('matches Cubism per-frame accumulation during fade-in', () => {
    const motion = customMotionOf();
    const handoff = { values: { PARAM_ANGLE_X: -10, PARAM_EYE_OPEN: 1 } };

    // At localTime 0 the sine weight is 0: handoff pose verbatim.
    const atStart = evaluateCustomMotionRuntime(motion, 10, 10, handoff);
    expect(atStart.values.PARAM_ANGLE_X).toBe(-10);
    expect(atStart.fadingIn).toBe(true);

    // Cubism blends from the previously saved parameter on every SDK frame,
    // rather than restarting from the original handoff pose on every frame.
    const halfFade = evaluateCustomMotionRuntime(motion, 10, 10.25, handoff);
    let expected = -10;
    for (let frame = 0; frame <= 15; frame++) {
      const localTime = frame / 60;
      const curveValue = localTime * 10; // linear 0 -> 20 over 2s
      const weight = cubismSineFadeWeight(localTime / 0.5);
      expected += (curveValue - expected) * weight;
    }
    expect(halfFade.values.PARAM_ANGLE_X).toBeCloseTo(expected, 6);
    expect(halfFade.fadingIn).toBe(true);

    // After fade-in the curve is used verbatim.
    const afterFade = evaluateCustomMotionRuntime(motion, 10, 10.75, handoff);
    expect(afterFade.values.PARAM_ANGLE_X).toBeCloseTo(7.5, 6);
    expect(afterFade.fadingIn).toBe(false);
  });

  it('holds the discrete 60Hz frame value between frame boundaries during fade-in', () => {
    // Cubism renders the value accumulated at the frame boundary <= t; no
    // fractional-step blend may be appended between boundaries. Both the
    // boundary instant and a point just inside the next interval must return
    // the same accumulated frame value.
    const motion = customMotionOf();
    const handoff = { values: { PARAM_ANGLE_X: -10, PARAM_EYE_OPEN: 1 } };

    const atFrame10 = evaluateCustomMotionRuntime(motion, 10, 10 + 10 / 60, handoff);
    const justAfterFrame10 = evaluateCustomMotionRuntime(motion, 10, 10 + 10 / 60 + 0.001, handoff);
    expect(justAfterFrame10.values.PARAM_ANGLE_X).toBe(atFrame10.values.PARAM_ANGLE_X);
    expect(Number.isFinite(justAfterFrame10.values.PARAM_ANGLE_X)).toBe(true);

    // The value is not interpolated toward the next frame's curve point.
    const nextFrame = evaluateCustomMotionRuntime(motion, 10, 10 + 11 / 60, handoff);
    expect(justAfterFrame10.values.PARAM_ANGLE_X).not.toBeCloseTo(nextFrame.values.PARAM_ANGLE_X, 6);
  });

  it('continues a mid-fade reconstruction from seeded accumulated frames', () => {
    const motion = customMotionOf();
    const handoff = { values: { PARAM_ANGLE_X: -10, PARAM_EYE_OPEN: 1 } };
    // Uninterrupted playback truth: two evaluations sharing ONE handoff object
    // continue the same 60Hz accumulation cache (fadeCacheByHandoff), exactly
    // like consecutive playback frames.
    const live = evaluateCustomMotionRuntime(motion, 10, 10.4, handoff);
    const continuous = evaluateCustomMotionRuntime(motion, 10, 10.45, handoff);
    // Seeded path: the 10.4 pose seeded by its CAPTURE TIME (0.4s), evaluated
    // at 10.45 — missing frames 25-27 are re-accumulated by the evaluator from
    // the seeded prefix, equal to uninterrupted playback.
    const pose = { PARAM_ANGLE_X: live.values.PARAM_ANGLE_X! };
    const resumed = evaluateCustomMotionRuntime(motion, 10, 10.45, {
      ...handoff,
      resumeFrames: seedCustomMotionFadeResumeFrames(0.4, pose),
    });
    expect(resumed.values.PARAM_ANGLE_X).toBeCloseTo(continuous.values.PARAM_ANGLE_X!, 6);
    // Discriminant (the P1 regression): seeding by the WRONG frame number —
    // the evaluation target instead of the snapshot capture time — fills every
    // frame up to the target with the capture pose and freezes the interval,
    // producing a materially different value than uninterrupted playback.
    const misSeeded = evaluateCustomMotionRuntime(motion, 10, 10.45, {
      ...handoff,
      resumeFrames: seedCustomMotionFadeResumeFrames(0.45, pose),
    });
    expect(misSeeded.values.PARAM_ANGLE_X).not.toBeCloseTo(continuous.values.PARAM_ANGLE_X!, 6);
    // At the exact fade boundary (localTime == fadeInSeconds) the resume
    // frames must not be read — both paths equal the raw curve value.
    const boundaryResumed = evaluateCustomMotionRuntime(motion, 10, 10.5, { ...handoff, resumeFrames: resumeFramesOf(0.4, pose) });
    expect(evaluateCustomMotionRuntime(motion, 10, 10.5, handoff).values.PARAM_ANGLE_X)
      .toBeCloseTo(boundaryResumed.values.PARAM_ANGLE_X!, 6);
  });

function resumeFramesOf(localTime: number, pose: Record<string, number>) {
  return seedCustomMotionFadeResumeFrames(localTime, pose);
}

  it('uses per-track fade-in when declared', () => {
    const motion = customMotionOf({
      tracks: [
        {
          parameterId: 'PARAM_ANGLE_X',
          fadeInSeconds: 0,
          keyframes: [
            { time: 0, value: 0, segment: { type: 'linear' } },
            { time: 2, value: 20 },
          ],
        },
      ],
    });
    const handoff = { values: { PARAM_ANGLE_X: -10 } };

    // Track fade-in 0: curve value immediately, no blending.
    const frame = evaluateCustomMotionRuntime(motion, 10, 10.1, handoff);
    expect(frame.values.PARAM_ANGLE_X).toBeCloseTo(1, 6);
    expect(frame.fadingIn).toBe(false);
  });

  it('holds the tail value past the last keyframe', () => {
    const motion = customMotionOf();
    const handoff = { values: { PARAM_ANGLE_X: -10 } };
    const frame = evaluateCustomMotionRuntime(motion, 10, 20, handoff);
    expect(frame.values.PARAM_ANGLE_X).toBe(20);
    expect(frame.fadingIn).toBe(false);
  });

  it('is inactive before the motion starts', () => {
    const motion = customMotionOf();
    const frame = evaluateCustomMotionRuntime(motion, 10, 5, { values: {} });
    expect(frame.values).toEqual({});
    expect(frame.fadingIn).toBe(false);
  });
});

describe('applyCustomMotionValues', () => {
  it('writes evaluated values and releases ids no longer controlled', () => {
    const injected: Record<string, number> = { PARAM_ANGLE_X: 99, PARAM_EYE_OPEN: 99, PARAM_OTHER: 5 };
    applyCustomMotionValues(
      injected,
      ['PARAM_ANGLE_X', 'PARAM_EYE_OPEN'],
      { PARAM_ANGLE_X: 3 },
    );

    expect(injected.PARAM_ANGLE_X).toBe(3);
    expect(injected).not.toHaveProperty('PARAM_EYE_OPEN');
    expect(injected.PARAM_OTHER).toBe(5);
  });

  it('skips non-finite values', () => {
    const injected: Record<string, number> = {};
    applyCustomMotionValues(injected, ['PARAM_ANGLE_X'], { PARAM_ANGLE_X: Number.NaN });
    expect(injected).toEqual({});
  });

  it('neither overwrites nor releases protected effect-channel parameters (ADR-0029 stage separation)', () => {
    // Lip sync keeps running in its own stage while a custom motion evaluates;
    // its live mouth value must survive the motion frame untouched.
    const injected: Record<string, number> = { ParamMouthOpenY: 0.6, PARAM_ANGLE_X: 99 };
    applyCustomMotionValues(
      injected,
      ['ParamMouthOpenY', 'PARAM_ANGLE_X'],
      { ParamMouthOpenY: 0.1, PARAM_ANGLE_X: 30 },
      new Set(['ParamMouthOpenY']),
    );

    expect(injected.ParamMouthOpenY).toBe(0.6);
    expect(injected.PARAM_ANGLE_X).toBe(30);
  });

  it('does not delete protected parameters even when the curve has no value this frame', () => {
    const injected: Record<string, number> = { ParamMouthOpenY: 0.4 };
    applyCustomMotionValues(
      injected,
      ['ParamMouthOpenY'],
      {},
      new Set(['ParamMouthOpenY']),
    );

    expect(injected.ParamMouthOpenY).toBe(0.4);
  });
});

describe('customMotionControlledParameterIds', () => {
  it('lists only tracks that actually carry keyframes', () => {
    // A track left without keyframes drives nothing; claiming it would let the
    // per-frame release wipe values owned by other channels (e.g. lip sync).
    const motion = customMotionOf({
      tracks: [
        { parameterId: 'ParamMouthOpenY', keyframes: [] },
        { parameterId: 'PARAM_EYE_OPEN', keyframes: [{ time: 0, value: 1 }] },
      ],
    });
    expect(customMotionControlledParameterIds(motion)).toEqual(['PARAM_EYE_OPEN']);
  });

  it('keeps listing every parameter of fully keyframed tracks', () => {
    expect(customMotionControlledParameterIds(customMotionOf())).toEqual([
      'PARAM_ANGLE_X',
      'PARAM_EYE_OPEN',
    ]);
  });
});

describe('selectHandoffPoseValues', () => {
  const parameters = [
    { name: 'PARAM_ANGLE_X', index: 0, value: 12 },
    { name: 'ParamMouthOpenY', index: 1, value: 0.7 },
  ];

  it('captures controlled parameter values for the fade-in source', () => {
    const byName = new Map(parameters.map((parameter) => [parameter.name, parameter]));
    expect(selectHandoffPoseValues(byName, ['PARAM_ANGLE_X'], null)).toEqual({
      PARAM_ANGLE_X: 12,
    });
  });

  it('excludes effect-channel parameters so transient lip-sync values are not baked into the fade source', () => {
    const byName = new Map(parameters.map((parameter) => [parameter.name, parameter]));
    expect(
      selectHandoffPoseValues(byName, ['PARAM_ANGLE_X', 'ParamMouthOpenY'], null, new Set(['ParamMouthOpenY'])),
    ).toEqual({ PARAM_ANGLE_X: 12 });
  });
});
