import type {
  CharacterMotionOutput,
  CustomMotionSegment,
  CustomMotionTrack,
} from '../../api/types/semantic-scene';

/**
 * Canonical persisted Custom Motion invariants (authority: ADR-0029).
 *
 * This module is the single home of the typed persistence contract: the
 * scene codec (shape parsing stays in `SceneStatementDefinitionRegistry`),
 * the timeline keyframe editor (`customMotionKeyframeEdits`) and the
 * resource-to-custom conversion (`CustomMotionConversionCommand`) all funnel
 * their produced motions through `assertCanonicalCustomMotion`. Failures
 * throw a consumer-neutral, structured {@link CustomMotionContractError} with
 * a stable `code`, a contract-relative `path` and optional `details`; each
 * adapter maps that onto its own domain error.
 *
 * Non-canonical current Scene Document data is rejected, never silently normalized: the editor
 * refuses to commit it, the conversion refuses to produce it, and the codec
 * refuses to load it — with one legacy exception. Documents saved by editors
 * that predate this contract may carry implicit linear segments (missing
 * `segment` on non-last keyframes); that exact shape is completed to
 * `{ type: 'linear' }` at the codec boundary (the current counterpart of the v3
 * migration) before strict validation, and every other non-canonical shape
 * is still rejected. The runtime evaluator (`engine/live2d/customMotion`)
 * deliberately keeps its defensive behaviour for historical or hand-edited
 * data that bypassed these gates.
 */
type CustomMotion = Extract<CharacterMotionOutput, { kind: 'custom' }>;

export type CustomMotionContractErrorCode =
  | 'invalid-duration'
  | 'invalid-fade'
  | 'duration-below-fade'
  | 'track-not-found'
  | 'duplicate-track'
  | 'keyframe-not-found'
  | 'f0-required'
  | 'invalid-keyframe'
  | 'invalid-segment';

/** Consumer-neutral structured contract failure (see module doc). */
export class CustomMotionContractError extends Error {
  constructor(
    message: string,
    readonly code: CustomMotionContractErrorCode,
    /** Contract-relative path, e.g. `tracks[0].keyframes[2].time`. */
    readonly path: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'CustomMotionContractError';
  }
}

const CUSTOM_MOTION_SEGMENT_TYPES = ['linear', 'bezier', 'stepped', 'inverseStepped'] as const;
const SEGMENT_SPAN_TOLERANCE = 1e-9;

/**
 * Enforce the canonical persisted Custom Motion invariants from ADR-0029:
 * duration and fades finite and bounded, unique non-empty tracks, at least
 * one keyframe per track starting at F0 with strictly increasing finite
 * times inside the duration, explicit segments on every non-last keyframe
 * (never on the last), and bezier control points finite, ordered and inside
 * their segment span. Throws {@link CustomMotionContractError} on the first
 * violation; never sorts, clamps, merges or strips input.
 */
export function assertCanonicalCustomMotion(motion: CustomMotion): void {
  if (!Number.isFinite(motion.durationSeconds) || motion.durationSeconds <= 0) {
    fail(
      `Expected a finite positive durationSeconds, got ${motion.durationSeconds}`,
      'invalid-duration',
      'durationSeconds',
      { value: motion.durationSeconds },
    );
  }

  assertFade(motion.fadeInSeconds, 'fadeInSeconds', motion.durationSeconds);
  assertOptionalFade(motion.derivedFrom.fadeInSeconds, 'derivedFrom.fadeInSeconds');
  assertOptionalFade(motion.derivedFrom.fadeOutSeconds, 'derivedFrom.fadeOutSeconds');

  if (!Array.isArray(motion.tracks) || motion.tracks.length === 0) {
    fail('Expected at least one track', 'track-not-found', 'tracks');
  }

  const parameterIds = new Set<string>();
  for (let trackIndex = 0; trackIndex < motion.tracks.length; trackIndex += 1) {
    const track = motion.tracks[trackIndex];
    const trackPath = `tracks[${trackIndex}]`;
    if (parameterIds.has(track.parameterId)) {
      fail(
        `Duplicate parameter track: ${track.parameterId}`,
        'duplicate-track',
        `${trackPath}.parameterId`,
        { parameterId: track.parameterId },
      );
    }
    parameterIds.add(track.parameterId);
    assertTrack(track, trackPath, motion.durationSeconds);
  }
}

function assertTrack(track: CustomMotionTrack, path: string, durationSeconds: number): void {
  if (track.fadeInSeconds !== undefined) {
    assertFade(track.fadeInSeconds, `${path}.fadeInSeconds`, durationSeconds, track.parameterId);
  }
  if (!Array.isArray(track.keyframes) || track.keyframes.length === 0) {
    fail(
      `Expected at least one keyframe on "${track.parameterId}"`,
      'keyframe-not-found',
      `${path}.keyframes`,
      { parameterId: track.parameterId },
    );
  }

  for (let keyframeIndex = 0; keyframeIndex < track.keyframes.length; keyframeIndex += 1) {
    const keyframe = track.keyframes[keyframeIndex];
    const keyframePath = `${path}.keyframes[${keyframeIndex}]`;
    if (!Number.isFinite(keyframe.time) || keyframe.time < 0) {
      fail(
        `Expected a finite non-negative keyframe time on "${track.parameterId}"`,
        'invalid-keyframe',
        `${keyframePath}.time`,
        { parameterId: track.parameterId, keyframeIndex, value: keyframe.time },
      );
    }
    if (keyframeIndex === 0 && keyframe.time !== 0) {
      fail(
        `Expected the first keyframe at F0 (time 0) on "${track.parameterId}"`,
        'f0-required',
        `${keyframePath}.time`,
        { parameterId: track.parameterId, value: keyframe.time },
      );
    }
    if (keyframe.time > durationSeconds) {
      fail(
        `Keyframe time ${keyframe.time} exceeds durationSeconds ${durationSeconds} on "${track.parameterId}"`,
        'invalid-keyframe',
        `${keyframePath}.time`,
        { parameterId: track.parameterId, keyframeIndex, durationSeconds, value: keyframe.time },
      );
    }
    if (!Number.isFinite(keyframe.value)) {
      fail(
        `Expected a finite keyframe value on "${track.parameterId}"`,
        'invalid-keyframe',
        `${keyframePath}.value`,
        { parameterId: track.parameterId, keyframeIndex, value: keyframe.value },
      );
    }
    if (keyframeIndex > 0 && keyframe.time <= track.keyframes[keyframeIndex - 1].time) {
      fail(
        `Expected strictly increasing keyframe times on "${track.parameterId}"`,
        'invalid-keyframe',
        `${keyframePath}.time`,
        { parameterId: track.parameterId, keyframeIndex, value: keyframe.time },
      );
    }

  }

  for (let keyframeIndex = 0; keyframeIndex < track.keyframes.length; keyframeIndex += 1) {
    const keyframe = track.keyframes[keyframeIndex];
    const keyframePath = `${path}.keyframes[${keyframeIndex}]`;
    const isLast = keyframeIndex === track.keyframes.length - 1;
    if (isLast && keyframe.segment !== undefined) {
      fail(
        `The last keyframe of "${track.parameterId}" must omit the segment`,
        'invalid-segment',
        `${keyframePath}.segment`,
        { parameterId: track.parameterId, keyframeIndex },
      );
    }
    if (!isLast && keyframe.segment === undefined) {
      fail(
        `Every non-last keyframe of "${track.parameterId}" must include a segment`,
        'invalid-segment',
        `${keyframePath}.segment`,
        { parameterId: track.parameterId, keyframeIndex },
      );
    }
    if (!isLast && keyframe.segment !== undefined) {
      assertSegment(
        keyframe.segment,
        `${keyframePath}.segment`,
        track.parameterId,
        keyframeIndex,
        keyframe.time,
        track.keyframes[keyframeIndex + 1].time,
      );
    }
  }
}

function assertSegment(
  segment: CustomMotionSegment,
  path: string,
  parameterId: string,
  keyframeIndex: number,
  spanStart: number,
  spanEnd: number,
): void {
  const record = segment as unknown as Record<string, unknown>;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    fail(`Expected a segment object on "${parameterId}"`, 'invalid-segment', path, { parameterId, keyframeIndex });
  }

  const type = record.type;
  if (typeof type !== 'string' || !(CUSTOM_MOTION_SEGMENT_TYPES as readonly string[]).includes(type)) {
    fail(
      `Invalid segment type "${String(type)}" on "${parameterId}"`,
      'invalid-segment',
      `${path}.type`,
      { parameterId, keyframeIndex, type },
    );
  }

  if (type !== 'bezier') {
    if (Object.keys(record).length !== 1) {
      fail(
        `Segment of type "${type}" on "${parameterId}" must not carry extra fields`,
        'invalid-segment',
        path,
        { parameterId, keyframeIndex, type },
      );
    }
    return;
  }

  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes('controlPoints')) {
    fail(
      `Bezier segment on "${parameterId}" must contain exactly "type" and "controlPoints"`,
      'invalid-segment',
      path,
      { parameterId, keyframeIndex },
    );
  }
  const controlPoints = record.controlPoints;
  if (!Array.isArray(controlPoints) || controlPoints.length !== 2) {
    fail(
      `Bezier segment on "${parameterId}" must contain exactly two control points`,
      'invalid-segment',
      `${path}.controlPoints`,
      { parameterId, keyframeIndex },
    );
  }

  const parsed = controlPoints as Array<Record<string, unknown>>;
  for (let pointIndex = 0; pointIndex < parsed.length; pointIndex += 1) {
    const point = parsed[pointIndex];
    const pointPath = `${path}.controlPoints[${pointIndex}]`;
    if (!point || typeof point !== 'object' || Array.isArray(point)) {
      fail(
        `Expected a control point object on "${parameterId}"`,
        'invalid-segment',
        pointPath,
        { parameterId, keyframeIndex, pointIndex },
      );
    }
    const pointKeys = Object.keys(point);
    if (pointKeys.length !== 2 || !pointKeys.includes('time') || !pointKeys.includes('value')) {
      fail(
        `Bezier control point ${pointIndex} on "${parameterId}" must contain exactly "time" and "value"`,
        'invalid-segment',
        pointPath,
        { parameterId, keyframeIndex, pointIndex },
      );
    }
    if (typeof point.time !== 'number' || !Number.isFinite(point.time)) {
      fail(
        `Bezier control point time must be a finite number on "${parameterId}"`,
        'invalid-segment',
        `${pointPath}.time`,
        { parameterId, keyframeIndex, pointIndex, value: point.time },
      );
    }
    if (typeof point.value !== 'number' || !Number.isFinite(point.value)) {
      fail(
        `Bezier control point value must be a finite number on "${parameterId}"`,
        'invalid-segment',
        `${pointPath}.value`,
        { parameterId, keyframeIndex, pointIndex, value: point.value },
      );
    }
  }

  if ((parsed[0].time as number) > (parsed[1].time as number)) {
    fail(
      `Bezier control point times must be ordered (first <= second) on "${parameterId}"`,
      'invalid-segment',
      `${path}.controlPoints`,
      { parameterId, keyframeIndex },
    );
  }
  for (let pointIndex = 0; pointIndex < parsed.length; pointIndex += 1) {
    const pointTime = parsed[pointIndex].time as number;
    if (pointTime < spanStart - SEGMENT_SPAN_TOLERANCE || pointTime > spanEnd + SEGMENT_SPAN_TOLERANCE) {
      fail(
        `Bezier control point ${pointIndex} time (${pointTime}) must lie within [${spanStart}, ${spanEnd}] on "${parameterId}"`,
        'invalid-segment',
        `${path}.controlPoints[${pointIndex}].time`,
        { parameterId, keyframeIndex, pointIndex, spanStart, spanEnd, value: pointTime },
      );
    }
  }
}

function assertFade(value: number, path: string, durationSeconds: number, parameterId?: string): void {
  if (!Number.isFinite(value) || value < 0) {
    fail(
      `Expected a finite non-negative fadeInSeconds${parameterId ? ` on "${parameterId}"` : ''}`,
      'invalid-fade',
      path,
      { ...(parameterId ? { parameterId } : {}), value },
    );
  }
  if (value > durationSeconds) {
    fail(
      `fadeInSeconds (${value}) must not exceed durationSeconds (${durationSeconds})${parameterId ? ` on "${parameterId}"` : ''}`,
      'duration-below-fade',
      path,
      { ...(parameterId ? { parameterId } : {}), durationSeconds, value },
    );
  }
}

function assertOptionalFade(value: number | undefined, path: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    fail('Expected a finite non-negative source fade', 'invalid-fade', path, { value });
  }
}

function fail(
  message: string,
  code: CustomMotionContractErrorCode,
  path: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new CustomMotionContractError(message, code, path, details);
}
