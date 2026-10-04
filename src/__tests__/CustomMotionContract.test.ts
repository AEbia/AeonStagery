import { describe, expect, it } from 'vitest';
import type { CharacterMotionOutput } from '../api/types/semantic-scene';
import {
  assertCanonicalCustomMotion,
  CustomMotionContractError,
  type CustomMotionContractErrorCode,
} from '../services/semantic-scene/CustomMotionContract';

type CustomMotion = Extract<CharacterMotionOutput, { kind: 'custom' }>;

function validMotion(): CustomMotion {
  return {
    kind: 'custom',
    durationSeconds: 2,
    fadeInSeconds: 0.3,
    derivedFrom: { key: 'wave', fadeInSeconds: 0.4, fadeOutSeconds: 0.2 },
    tracks: [
      {
        parameterId: 'PARAM_ANGLE_X',
        fadeInSeconds: 0.1,
        keyframes: [
          {
            time: 0,
            value: 0,
            segment: {
              type: 'bezier',
              controlPoints: [
                { time: 0.25, value: 3 },
                { time: 0.75, value: 7 },
              ],
            },
          },
          { time: 1, value: 10, segment: { type: 'linear' } },
          { time: 2, value: 5 },
        ],
      },
      {
        parameterId: 'PARAM_EYE_OPEN',
        keyframes: [{ time: 0, value: 1 }],
      },
    ],
  };
}

function changed(mutator: (motion: any) => void): CustomMotion {
  const motion = structuredClone(validMotion());
  mutator(motion);
  return motion as CustomMotion;
}

function expectViolation(
  motion: CustomMotion,
  code: CustomMotionContractErrorCode,
  path: string,
): CustomMotionContractError {
  let captured: unknown;
  try {
    assertCanonicalCustomMotion(motion);
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(CustomMotionContractError);
  expect(captured).toMatchObject({ code, path });
  return captured as CustomMotionContractError;
}

describe('CustomMotionContract', () => {
  it('accepts canonical multi-segment and single-keyframe tracks', () => {
    expect(() => assertCanonicalCustomMotion(validMotion())).not.toThrow();
  });

  it('enforces duration and outer fade invariants', () => {
    expectViolation(changed((motion) => { motion.durationSeconds = 0; }), 'invalid-duration', 'durationSeconds');
    expectViolation(changed((motion) => { motion.durationSeconds = Number.NaN; }), 'invalid-duration', 'durationSeconds');
    expectViolation(changed((motion) => { motion.fadeInSeconds = -1; }), 'invalid-fade', 'fadeInSeconds');
    expectViolation(changed((motion) => { motion.fadeInSeconds = 3; }), 'duration-below-fade', 'fadeInSeconds');
  });

  it('enforces derived-source and track fade invariants', () => {
    expectViolation(
      changed((motion) => { motion.derivedFrom.fadeInSeconds = -0.1; }),
      'invalid-fade',
      'derivedFrom.fadeInSeconds',
    );
    expectViolation(
      changed((motion) => { motion.derivedFrom.fadeOutSeconds = Number.POSITIVE_INFINITY; }),
      'invalid-fade',
      'derivedFrom.fadeOutSeconds',
    );
    expectViolation(
      changed((motion) => { motion.tracks[0].fadeInSeconds = 3; }),
      'duration-below-fade',
      'tracks[0].fadeInSeconds',
    );
  });

  it('requires at least one uniquely identified track', () => {
    expectViolation(changed((motion) => { motion.tracks = []; }), 'track-not-found', 'tracks');
    expectViolation(changed((motion) => {
      motion.tracks[1].parameterId = motion.tracks[0].parameterId;
    }), 'duplicate-track', 'tracks[1].parameterId');
  });

  it('requires at least one keyframe and an F0 keyframe', () => {
    expectViolation(changed((motion) => {
      motion.tracks[0].keyframes = [];
    }), 'keyframe-not-found', 'tracks[0].keyframes');
    expectViolation(changed((motion) => {
      motion.tracks[0].keyframes[0].time = 0.1;
    }), 'f0-required', 'tracks[0].keyframes[0].time');
  });

  it('enforces finite, bounded, strictly increasing keyframes', () => {
    expectViolation(changed((motion) => {
      motion.tracks[0].keyframes[1].time = 0;
    }), 'invalid-keyframe', 'tracks[0].keyframes[1].time');
    expectViolation(changed((motion) => {
      motion.tracks[0].keyframes[2].time = 3;
    }), 'invalid-keyframe', 'tracks[0].keyframes[2].time');
    expectViolation(changed((motion) => {
      motion.tracks[0].keyframes[1].value = Number.NaN;
    }), 'invalid-keyframe', 'tracks[0].keyframes[1].value');
  });

  it('requires an explicit segment on every non-last keyframe', () => {
    expectViolation(changed((motion) => {
      delete motion.tracks[0].keyframes[0].segment;
    }), 'invalid-segment', 'tracks[0].keyframes[0].segment');
  });

  it('rejects a segment on the last keyframe', () => {
    expectViolation(changed((motion) => {
      motion.tracks[0].keyframes[2].segment = { type: 'linear' };
    }), 'invalid-segment', 'tracks[0].keyframes[2].segment');
  });

  it('enforces the canonical segment shapes', () => {
    expectViolation(changed((motion) => {
      motion.tracks[0].keyframes[0].segment.type = 'bogus';
    }), 'invalid-segment', 'tracks[0].keyframes[0].segment.type');
    expectViolation(changed((motion) => {
      motion.tracks[0].keyframes[1].segment.extra = true;
    }), 'invalid-segment', 'tracks[0].keyframes[1].segment');
    expectViolation(changed((motion) => {
      motion.tracks[0].keyframes[0].segment.controlPoints = [{ time: 0.5, value: 5 }];
    }), 'invalid-segment', 'tracks[0].keyframes[0].segment.controlPoints');
  });

  it('enforces finite, ordered control points inside their segment span', () => {
    expectViolation(changed((motion) => {
      motion.tracks[0].keyframes[0].segment.controlPoints[0].value = Number.NaN;
    }), 'invalid-segment', 'tracks[0].keyframes[0].segment.controlPoints[0].value');
    expectViolation(changed((motion) => {
      motion.tracks[0].keyframes[0].segment.controlPoints[0].time = 0.8;
      motion.tracks[0].keyframes[0].segment.controlPoints[1].time = 0.2;
    }), 'invalid-segment', 'tracks[0].keyframes[0].segment.controlPoints');
    expectViolation(changed((motion) => {
      motion.tracks[0].keyframes[0].segment.controlPoints[1].time = 1.2;
    }), 'invalid-segment', 'tracks[0].keyframes[0].segment.controlPoints[1].time');
  });

  it('rejects non-finite and negative keyframe times', () => {
    expectViolation(changed((motion) => {
      motion.tracks[0].keyframes[1].time = -0.5;
    }), 'invalid-keyframe', 'tracks[0].keyframes[1].time');
    expectViolation(changed((motion) => {
      motion.tracks[0].keyframes[1].time = Number.NaN;
    }), 'invalid-keyframe', 'tracks[0].keyframes[1].time');
    expectViolation(changed((motion) => {
      motion.tracks[0].keyframes[1].time = Number.POSITIVE_INFINITY;
    }), 'invalid-keyframe', 'tracks[0].keyframes[1].time');
  });

  it('rejects non-array track and keyframe containers', () => {
    expectViolation(changed((motion) => { (motion as { tracks?: unknown }).tracks = {}; }), 'track-not-found', 'tracks');
    expectViolation(changed((motion) => {
      (motion.tracks[0] as { keyframes?: unknown }).keyframes = {};
    }), 'keyframe-not-found', 'tracks[0].keyframes');
  });

  it('enforces finite non-negative track fades within the duration', () => {
    expectViolation(changed((motion) => {
      motion.tracks[0].fadeInSeconds = Number.NaN;
    }), 'invalid-fade', 'tracks[0].fadeInSeconds');
    expectViolation(changed((motion) => {
      motion.tracks[0].fadeInSeconds = -0.1;
    }), 'invalid-fade', 'tracks[0].fadeInSeconds');
  });

  it('accepts boundary values exactly at the duration edge', () => {
    const motion = changed((mutable) => {
      mutable.fadeInSeconds = 2;
      mutable.tracks[0].fadeInSeconds = 2;
    });
    expect(() => assertCanonicalCustomMotion(motion)).not.toThrow();
  });

  it('accepts all four canonical segment types', () => {
    for (const segment of [
      { type: 'linear' },
      { type: 'stepped' },
      { type: 'inverseStepped' },
    ] as const) {
      const motion = changed((mutable) => {
        mutable.tracks[0].keyframes[0].segment = segment;
      });
      expect(() => assertCanonicalCustomMotion(motion)).not.toThrow();
    }
  });

  it('rejects non-object segments and malformed bezier records', () => {
    expectViolation(changed((motion) => {
      (motion.tracks[0].keyframes[0] as { segment?: unknown }).segment = null;
    }), 'invalid-segment', 'tracks[0].keyframes[0].segment');
    expectViolation(changed((motion) => {
      (motion.tracks[0].keyframes[0] as { segment?: unknown }).segment = 42;
    }), 'invalid-segment', 'tracks[0].keyframes[0].segment');
    expectViolation(changed((motion) => {
      (motion.tracks[0].keyframes[0] as { segment?: unknown }).segment = { type: 'bezier' };
    }), 'invalid-segment', 'tracks[0].keyframes[0].segment');
    expectViolation(changed((motion) => {
      (motion.tracks[0].keyframes[0].segment as Record<string, unknown>).extra = true;
    }), 'invalid-segment', 'tracks[0].keyframes[0].segment');
    expectViolation(changed((motion) => {
      (motion.tracks[0].keyframes[0].segment.controlPoints[0] as Record<string, unknown>).extra = true;
    }), 'invalid-segment', 'tracks[0].keyframes[0].segment.controlPoints[0]');
    expectViolation(changed((motion) => {
      motion.tracks[0].keyframes[0].segment.controlPoints[0].time = Number.NaN;
    }), 'invalid-segment', 'tracks[0].keyframes[0].segment.controlPoints[0].time');
  });

  it('throws a structured consumer-neutral error with code, path and details', () => {
    const error = expectViolation(changed((motion) => {
      motion.tracks[0].keyframes[1].value = Number.NaN;
    }), 'invalid-keyframe', 'tracks[0].keyframes[1].value');
    expect(error.name).toBe('CustomMotionContractError');
    expect(error.details).toMatchObject({ parameterId: 'PARAM_ANGLE_X', keyframeIndex: 1 });
    expect(typeof error.message).toBe('string');
  });
});
