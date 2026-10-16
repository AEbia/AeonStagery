import { evaluateCharacterEase } from '../CharacterAnimationContract';

/** Blend mode applied by the parameter mixer after a track is evaluated. */
export type ParameterTrackBlend = 'override' | 'add' | 'multiply';

/** Lifecycle policy applied when a parameter track leaves its active range. */
export type ParameterTrackEndBehavior = 'restore' | 'hold';

/**
 * Easing names understood by the project's GSAP easing boundary.
 *
 * The string shape is intentionally open: GSAP supports more names than the
 * semantic aliases used by the editor, and persisted tracks must remain
 * forward-compatible with those names.
 */
export type ParameterTrackEasing = string;

export interface ParameterTrackKeyframe {
  readonly time: number;
  readonly value: number;
  /** Easing into this keyframe from the preceding keyframe. */
  readonly ease?: ParameterTrackEasing;
}
export interface ParameterTrack {
  readonly parameterId: string;
  readonly keyframes: readonly ParameterTrackKeyframe[];
  readonly blend?: ParameterTrackBlend;
  readonly endBehavior?: ParameterTrackEndBehavior;
}

/** Error raised when a track cannot provide deterministic interpolation. */
export class ParameterTrackValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParameterTrackValidationError';
  }
}

/**
 * Validate the ordering and finite numeric data required by the evaluator.
 *
 * Authored tracks are rejected when keyframes are out of order. Sorting here
 * would make malformed source data appear valid and would make duplicate-time
 * behavior depend on the chosen sort implementation.
 */
export function assertValidParameterTrack(track: ParameterTrack): void {
  if (!Array.isArray(track.keyframes)) {
    throw new ParameterTrackValidationError('Parameter track keyframes must be an array');
  }

  let previousTime: number | undefined;
  for (let index = 0; index < track.keyframes.length; index += 1) {
    const keyframe = track.keyframes[index];
    if (!keyframe || typeof keyframe !== 'object') {
      throw new ParameterTrackValidationError(`Parameter track keyframe ${index} must be an object`);
    }
    if (!Number.isFinite(keyframe.time) || !Number.isFinite(keyframe.value)) {
      throw new ParameterTrackValidationError(
        `Parameter track keyframe ${index} must have finite time and value`,
      );
    }
    if (previousTime !== undefined && keyframe.time <= previousTime) {
      throw new ParameterTrackValidationError(
        'Parameter track keyframe times must be strictly increasing',
      );
    }
    previousTime = keyframe.time;
  }
}

/**
 * Evaluate an authored parameter track at a statement-relative time.
 *
 * Easing belongs to the destination keyframe, matching the camera path
 * contract (each keyframe describes the transition into itself). The first
 * keyframe therefore has no preceding segment and its value is returned
 * exactly. Times outside the first-to-last keyframe range return `undefined`;
 * the track's `endBehavior` is interpreted by the parameter mixer.
 */
export function evaluateParameterTrack(
  track: ParameterTrack,
  relativeTime: number,
): number | undefined {
  assertValidParameterTrack(track);
  if (!Number.isFinite(relativeTime) || track.keyframes.length === 0) return undefined;

  const first = track.keyframes[0];
  const last = track.keyframes[track.keyframes.length - 1];
  if (relativeTime < first.time || relativeTime > last.time) return undefined;
  if (relativeTime === first.time || track.keyframes.length === 1) return first.value;
  if (relativeTime === last.time) return last.value;

  for (let index = 0; index < track.keyframes.length - 1; index += 1) {
    const current = track.keyframes[index];
    const next = track.keyframes[index + 1];
    if (relativeTime > next.time) continue;

    const progress = (relativeTime - current.time) / (next.time - current.time);
    const easedProgress = evaluateCharacterEase(next.ease, progress, 'none');
    return current.value + (next.value - current.value) * easedProgress;
  }

  // Strict ordering and the active-range checks above make this unreachable;
  // retaining an explicit result keeps the function total if the contract is
  // extended with another keyframe representation later.
  return undefined;
}
