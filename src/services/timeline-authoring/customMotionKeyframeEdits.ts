import type {
  CharacterMotionOutput,
  CustomMotionKeyframe,
  CustomMotionSegment,
  CustomMotionTrack,
} from '../../api/types/semantic-scene';
import { evaluateCustomMotionTrack, solveBezierTime } from '../../engine/live2d/customMotion';
import {
  assertCanonicalCustomMotion,
  CustomMotionContractError,
  type CustomMotionContractErrorCode,
} from '../semantic-scene';

/** Compare persisted motion structure independently of object field insertion order. */
export function customMotionFingerprint(motion: Extract<CharacterMotionOutput, { kind: 'custom' }>): string {
  return JSON.stringify(motion, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
    }
    return value;
  });
}

export interface CustomMotionKeyframeRef {
  parameterId: string;
  time: number;
}

export type CustomMotionKeyframeEdit =
  | {
      /** Move every referenced point simultaneously, preserving relative timing. */
      type: 'move-keyframes';
      keyframes: readonly CustomMotionKeyframeRef[];
      deltaTime: number;
      /** Value movement is restricted to a single parameter. */
      deltaValue?: number;
    }
  | {
      /** Insert a keyframe at an exact motion-local time (never F0, which always exists). */
      type: 'insert-keyframe';
      trackParameterId: string;
      time: number;
      value: number;
      /** Explicit segment for the inserted point; defaults to the inherited one. */
      segment?: CustomMotionSegment;
    }
  | {
      /** Delete the keyframe at an exact time. F0 (time 0) is protected. */
      type: 'remove-keyframe';
      trackParameterId: string;
      time: number;
    }
  | {
      /** Change the value and/or move the keyframe at an exact time. */
      type: 'update-keyframe';
      trackParameterId: string;
      time: number;
      value: number;
      /** New time when moving; defaults to the current time (value-only edit). */
      newTime?: number;
    }
  | {
      /**
       * Set the outer entry fade (no trackParameterId) or a track-level fade
       * override. `null` removes an explicit track override (restores
       * inheritance from the outer fade). The outer fade itself is required
       * on custom motions and cannot be removed.
       */
      type: 'set-fade-in';
      trackParameterId?: string;
      fadeInSeconds?: number | null;
    }
  | {
      /** Set the outgoing segment type of the keyframe at an exact time. */
      type: 'set-segment';
      trackParameterId: string;
      time: number;
      segment: CustomMotionSegment;
    }
  | {
      /** Crop (destructive) or extend the motion edit range. */
      type: 'set-duration';
      durationSeconds: number;
    };

export type CustomMotionEditErrorCode =
  | 'not-custom-motion'
  | 'track-not-found'
  | 'duplicate-track'
  | 'keyframe-not-found'
  | 'keyframe-time-collision'
  | 'f0-protected'
  | 'duration-below-fade'
  | 'invalid-duration'
  | 'invalid-fade'
  | 'outer-fade-required'
  | 'invalid-keyframe'
  | 'invalid-segment';

export class CustomMotionEditError extends Error {
  constructor(
    message: string,
    readonly code: CustomMotionEditErrorCode,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CustomMotionEditError';
  }
}

/**
 * Apply a batch of keyframe edits to a custom motion. The batch is atomic:
 * any invalid edit aborts before a new motion is produced, leaving the input
 * untouched. The returned motion preserves `derivedFrom` and passes the
 * canonical Custom Motion contract (ADR-0029; enforced via
 * `assertValidCustomMotionEdit`, which delegates to
 * `CustomMotionContract.assertCanonicalCustomMotion`).
 */
export function applyCustomMotionKeyframeEdits(
  motion: Extract<CharacterMotionOutput, { kind: 'custom' }>,
  edits: readonly CustomMotionKeyframeEdit[],
): Extract<CharacterMotionOutput, { kind: 'custom' }> {
  let tracks = motion.tracks.slice();
  let durationSeconds = motion.durationSeconds;
  let fadeInSeconds = motion.fadeInSeconds;

  for (const edit of edits) {
    switch (edit.type) {
      case 'move-keyframes':
        tracks = moveKeyframes(tracks, edit);
        break;
      case 'insert-keyframe':
        tracks = insertKeyframe(tracks, edit);
        break;
      case 'remove-keyframe':
        tracks = removeKeyframe(tracks, edit);
        break;
      case 'update-keyframe':
        tracks = updateKeyframe(tracks, edit);
        break;
      case 'set-fade-in': {
        if (edit.trackParameterId === undefined) {
          if (edit.fadeInSeconds === null || edit.fadeInSeconds === undefined) {
            throw new CustomMotionEditError(
              'The outer fadeInSeconds is required on custom motions and cannot be removed',
              'outer-fade-required',
            );
          }
          fadeInSeconds = requireFiniteFade(edit.fadeInSeconds);
        } else {
          tracks = setTrackFadeIn(tracks, edit.trackParameterId, edit.fadeInSeconds);
        }
        break;
      }
      case 'set-segment':
        tracks = setSegment(tracks, edit);
        break;
      case 'set-duration': {
        durationSeconds = requirePositiveDuration(edit.durationSeconds);
        tracks = cropTracksToDuration(tracks, durationSeconds);
        break;
      }
    }
  }

  const next: Extract<CharacterMotionOutput, { kind: 'custom' }> = {
    ...motion,
    durationSeconds,
    fadeInSeconds,
    tracks,
  };
  assertValidCustomMotionEdit(next);
  return next;
}

/**
 * Validate a produced custom motion against the canonical persisted
 * invariants. The rules themselves live in exactly one place —
 * `CustomMotionContract.assertCanonicalCustomMotion` (authority: ADR-0029) —
 * and this adapter maps the consumer-neutral contract error onto the
 * editor's domain error codes so callers keep their diagnostics. Rules that
 * are edit mechanics rather than persistence invariants (F0 protection,
 * occupied times, missing tracks/keyframes, required outer fade) stay in the
 * edit functions above; the contract guards the final shape of every
 * produced motion.
 */
export function assertValidCustomMotionEdit(
  motion: Extract<CharacterMotionOutput, { kind: 'custom' }>,
): void {
  try {
    assertCanonicalCustomMotion(motion);
  } catch (error) {
    if (error instanceof CustomMotionContractError) {
      throw new CustomMotionEditError(error.message, mapContractCodeToEditCode(error.code), {
        ...error.details,
        contractPath: error.path,
      });
    }
    throw error;
  }
}

function mapContractCodeToEditCode(code: CustomMotionContractErrorCode): CustomMotionEditErrorCode {
  switch (code) {
    case 'invalid-duration': return 'invalid-duration';
    case 'invalid-fade': return 'invalid-fade';
    case 'duration-below-fade': return 'duration-below-fade';
    case 'track-not-found': return 'track-not-found';
    case 'duplicate-track': return 'duplicate-track';
    case 'keyframe-not-found': return 'keyframe-not-found';
    case 'f0-required': return 'f0-protected';
    case 'invalid-keyframe': return 'invalid-keyframe';
    case 'invalid-segment': return 'invalid-segment';
  }
}

function moveKeyframes(
  tracks: CustomMotionTrack[],
  edit: Extract<CustomMotionKeyframeEdit, { type: 'move-keyframes' }>,
): CustomMotionTrack[] {
  const deltaValue = edit.deltaValue ?? 0;
  if (!Number.isFinite(edit.deltaTime) || !Number.isFinite(deltaValue)) {
    throw new CustomMotionEditError('Movement must be finite', 'invalid-keyframe');
  }
  const selected = new Map<string, Set<number>>();
  const pointTimes = new Map(tracks.map((track) => [track.parameterId, new Set(track.keyframes.map((point) => point.time))]));
  for (const ref of edit.keyframes) {
    const timesOnTrack = pointTimes.get(ref.parameterId);
    if (!timesOnTrack) throw new CustomMotionEditError('Selected track no longer exists', 'track-not-found');
    if (!timesOnTrack.has(ref.time)) {
      throw new CustomMotionEditError('Selected keyframe no longer exists', 'keyframe-not-found');
    }
    const times = selected.get(ref.parameterId) ?? new Set<number>();
    times.add(ref.time);
    selected.set(ref.parameterId, times);
  }
  if (deltaValue !== 0 && selected.size > 1) {
    throw new CustomMotionEditError('Value movement requires one parameter', 'invalid-keyframe');
  }
  return tracks.map((track) => {
    const times = selected.get(track.parameterId);
    if (!times || (edit.deltaTime === 0 && deltaValue === 0)) return track;
    const originalByPoint = new Map<CustomMotionKeyframe, number>();
    const points = track.keyframes.map((point, index) => {
      const next = times.has(point.time)
        ? { ...point, time: point.time + edit.deltaTime, value: point.value + deltaValue }
        : point;
      originalByPoint.set(next, index);
      return next;
    });
    if (times.has(0) && edit.deltaTime > 0) {
      const boundary = { ...track.keyframes[0] };
      points.push(boundary);
      originalByPoint.set(boundary, 0);
    }
    points.sort((a, b) => a.time - b.time);
    for (let i = 0; i < points.length; i++) {
      if (points[i].time < 0 || !Number.isFinite(points[i].value)) {
        throw new CustomMotionEditError('Movement is outside the editable range', 'invalid-keyframe');
      }
      if (i > 0 && points[i].time === points[i - 1].time) {
        throw new CustomMotionEditError('Keyframe time is already occupied', 'keyframe-time-collision');
      }
    }
    const repaired = points.map((point, index): CustomMotionKeyframe => {
      const end = points[index + 1];
      if (!end) {
        const { segment: _segment, ...tail } = point;
        return tail;
      }
      const originalIndex = originalByPoint.get(point)!;
      const original = track.keyframes[originalIndex];
      const originalEnd = track.keyframes[originalIndex + 1];
      if (original.segment?.type !== 'bezier' || !originalEnd) {
        return point.segment ? point : { ...point, segment: { type: 'linear' } };
      }
      // Transform the original segment once against its final endpoints.
      // When both endpoints move together this translates the handles exactly.
      const span = originalEnd.time - original.time;
      const controlPoints = original.segment.controlPoints.map((cp, cpIndex) => ({
        time: point.time + (cp.time - original.time) / span * (end.time - point.time),
        value: cp.value + (cpIndex === 0 ? point.value - original.value : end.value - originalEnd.value),
      })) as [{ time: number; value: number }, { time: number; value: number }];
      return { ...point, segment: { type: 'bezier', controlPoints } };
    });
    return { ...track, keyframes: repaired };
  });
}

function insertKeyframe(
  tracks: CustomMotionTrack[],
  edit: Extract<CustomMotionKeyframeEdit, { type: 'insert-keyframe' }>,
): CustomMotionTrack[] {
  const track = requireTrack(tracks, edit.trackParameterId);
  const index = requireFreeInsertionIndex(track, edit.time, edit.trackParameterId);
  const isLast = index === track.keyframes.length;

  if (!isLast) {
    const previous = track.keyframes[index - 1];
    const next = track.keyframes[index];
    const inherited = previous.segment;
    if (inherited && inherited.type === 'bezier') {
      // Lossless split (ADR-0029): the segment is a cubic Bezier spanning
      // previous -> next; copying it onto both halves would change the curve
      // at every other time. de Casteljau splitting replaces the original
      // segment with two halves that reproduce the exact same curve.
      const split = splitBezierSegment(previous, next, inherited, edit.time);
      const inserted: CustomMotionKeyframe = {
        time: edit.time,
        value: edit.value,
        segment: edit.segment ?? split.right,
      };
      const nextKeyframes = [...track.keyframes];
      nextKeyframes[index - 1] = {
        time: previous.time,
        value: previous.value,
        segment: split.left,
      };
      nextKeyframes.splice(index, 0, inserted);
      return replaceTrack(tracks, track, { ...track, keyframes: nextKeyframes });
    }
  }

  const inherited = index > 0 ? track.keyframes[index - 1].segment : undefined;
  const inserted: CustomMotionKeyframe = {
    time: edit.time,
    value: edit.value,
    // Inside an existing segment the new point inherits it; at the tail the
    // point is the new last keyframe and must omit the segment (contract).
    // An explicit segment from the caller wins for interior inserts.
    ...(!isLast
      ? { segment: edit.segment ?? inherited }
      : {}),
  };

  const nextKeyframes = [...track.keyframes];
  nextKeyframes.splice(index, 0, inserted);
  if (isLast && index > 0) {
    // The former last keyframe becomes interior and must carry an explicit
    // segment; appending at the curve end defaults to linear (ADR-0029).
    const previousLast = track.keyframes[index - 1];
    nextKeyframes[index - 1] = {
      time: previousLast.time,
      value: previousLast.value,
      segment: { type: 'linear' },
    };
  }
  return replaceTrack(tracks, track, { ...track, keyframes: normalizeTailSegment(nextKeyframes) });
}

function removeKeyframe(
  tracks: CustomMotionTrack[],
  edit: Extract<CustomMotionKeyframeEdit, { type: 'remove-keyframe' }>,
): CustomMotionTrack[] {
  const track = requireTrack(tracks, edit.trackParameterId);
  const index = track.keyframes.findIndex((keyframe) => keyframe.time === edit.time);
  if (index < 0) {
    throw new CustomMotionEditError(
      `Keyframe at time ${edit.time} not found on "${edit.trackParameterId}"`,
      'keyframe-not-found',
      { parameterId: edit.trackParameterId, time: edit.time },
    );
  }
  if (index === 0) {
    throw new CustomMotionEditError(
      `The F0 keyframe (time 0) of "${edit.trackParameterId}" is protected and cannot be deleted`,
      'f0-protected',
      { parameterId: edit.trackParameterId },
    );
  }
  const nextKeyframes = track.keyframes.filter((keyframe) => keyframe.time !== edit.time);
  return replaceTrack(tracks, track, { ...track, keyframes: normalizeTailSegment(nextKeyframes) });
}

function updateKeyframe(
  tracks: CustomMotionTrack[],
  edit: Extract<CustomMotionKeyframeEdit, { type: 'update-keyframe' }>,
): CustomMotionTrack[] {
  const track = requireTrack(tracks, edit.trackParameterId);
  const index = track.keyframes.findIndex((keyframe) => keyframe.time === edit.time);
  if (index < 0) {
    throw new CustomMotionEditError(
      `Keyframe at time ${edit.time} not found on "${edit.trackParameterId}"`,
      'keyframe-not-found',
      { parameterId: edit.trackParameterId, time: edit.time },
    );
  }

  const newTime = edit.newTime ?? edit.time;
  if (!Number.isFinite(newTime) || newTime < 0) {
    throw new CustomMotionEditError(
      `Expected a finite non-negative keyframe time on "${edit.trackParameterId}"`,
      'invalid-keyframe',
      { parameterId: edit.trackParameterId },
    );
  }
  if (newTime !== edit.time && track.keyframes.some((keyframe, other) => other !== index && keyframe.time === newTime)) {
    throw new CustomMotionEditError(
      `Keyframe time ${newTime} is already occupied on "${edit.trackParameterId}"`,
      'keyframe-time-collision',
      { parameterId: edit.trackParameterId, time: newTime },
    );
  }

  const source = track.keyframes[index];
  const moved: CustomMotionKeyframe = {
    ...source,
    time: newTime,
    value: edit.value,
  };
  const rest = track.keyframes.filter((_, other) => other !== index);

  if (edit.time === 0 && newTime !== 0) {
    // Moving F0: leave an equal-value F0 boundary point behind (ADR-0029).
    // The original first segment is carried over so the curve shape from F0
    // to the next keyframe survives the move.
    const boundary: CustomMotionKeyframe = {
      time: 0,
      value: source.value,
      ...(source.segment ? { segment: cloneSegment(source.segment) } : {}),
    };
    rest.push(boundary, moved);
  } else {
    rest.push(moved);
  }

  const sorted = rest.sort((a, b) => a.time - b.time);
  const repaired = repairBezierSpansAfterMove(track.keyframes, index, newTime, sorted);
  return replaceTrack(tracks, track, { ...track, keyframes: normalizeTailSegment(repaired) });
}

/**
 * After a keyframe time move the spans of the two adjacent bezier segments
 * change; control points that fall outside the new span would violate the cp
 * ordering contract and make x(t) non-monotonic. Re-split such segments
 * losslessly (de Casteljau) so the curve keeps its shape; a carried segment
 * that describes nothing (the keyframe jumped past its old neighbour) falls
 * back to a linear segment rather than persisting invalid control points.
 *
 * Splits are anchored on the segment's ORIGINAL end keyframes (the moved
 * keyframe at its old time / its old next), because the control points are
 * expressed in that coordinate system.
 */
function repairBezierSpansAfterMove(
  original: readonly CustomMotionKeyframe[],
  movedIndex: number,
  newTime: number,
  sorted: readonly CustomMotionKeyframe[],
): CustomMotionKeyframe[] {
  const result = [...sorted];
  const movedResultIndex = result.findIndex((keyframe) => keyframe.time === newTime);
  if (movedResultIndex < 0) return result;
  const source = original[movedIndex];
  const oldTime = source.time;
  const oldNext = original[movedIndex + 1];
  const prev = result[movedResultIndex - 1];
  const moved = result[movedResultIndex];
  const next = result[movedResultIndex + 1];

  if (prev && moved && prev.segment?.type === 'bezier') {
    // The previous keyframe's segment now ends at newTime; resolve its
    // original end keyframe (the F0 boundary case resolves back to the
    // original first segment's next keyframe) and keep the lossless left
    // half when the span shrank.
    const prevOriginalIndex = original.findIndex((keyframe) => keyframe.time === prev.time);
    const segmentEnd = prevOriginalIndex >= 0 ? original[prevOriginalIndex + 1] : undefined;
    if (segmentEnd && prev.segment.controlPoints[1].time > newTime) {
      const split = splitBezierSegment(prev, segmentEnd, prev.segment, newTime);
      result[movedResultIndex - 1] = { time: prev.time, value: prev.value, segment: split.left };
    }
  }

  if (moved && next && moved.segment === undefined) {
    // The moved keyframe carried no segment (it was the tail) and now sits
    // interior: the contract requires every non-last keyframe to carry an
    // explicit segment, linear included (ADR-0029).
    result[movedResultIndex] = { time: moved.time, value: moved.value, segment: { type: 'linear' } };
  } else if (moved && next && moved.segment?.type === 'bezier') {
    const segment = moved.segment;
    const cp1 = segment.controlPoints[0];
    const cp2 = segment.controlPoints[1];
    const fits = cp1.time >= newTime && cp2.time <= next.time;
    if (!fits) {
      if (oldNext && newTime > oldTime && newTime < oldNext.time) {
        // The span shifted right inside the segment's own range: keep the
        // lossless right half so the curve continues towards the next point.
        const split = splitBezierSegment(source, oldNext, segment, newTime);
        result[movedResultIndex] = { time: moved.time, value: moved.value, segment: split.right };
      } else {
        // The carried control points describe nothing under the new span;
        // fall back to an explicit linear segment (the contract requires
        // every non-last keyframe to carry one, linear included).
        result[movedResultIndex] = { time: moved.time, value: moved.value, segment: { type: 'linear' } };
      }
    }
  }
  return result;
}

function setTrackFadeIn(
  tracks: CustomMotionTrack[],
  trackParameterId: string,
  fadeInSeconds: number | null | undefined,
): CustomMotionTrack[] {
  const track = requireTrack(tracks, trackParameterId);
  if (fadeInSeconds === null || fadeInSeconds === undefined) {
    const next: CustomMotionTrack = { parameterId: track.parameterId, keyframes: track.keyframes };
    if (track.fadeInSeconds !== undefined) {
      // Preserve ordering of own fields while dropping the override.
      delete (next as { fadeInSeconds?: number }).fadeInSeconds;
    }
    return replaceTrack(tracks, track, next);
  }
  const value = requireFiniteFade(fadeInSeconds);
  return replaceTrack(tracks, track, { ...track, fadeInSeconds: value });
}

function setSegment(
  tracks: CustomMotionTrack[],
  edit: Extract<CustomMotionKeyframeEdit, { type: 'set-segment' }>,
): CustomMotionTrack[] {
  const track = requireTrack(tracks, edit.trackParameterId);
  const index = track.keyframes.findIndex((keyframe) => keyframe.time === edit.time);
  if (index < 0) {
    throw new CustomMotionEditError(
      `Keyframe at time ${edit.time} not found on "${edit.trackParameterId}"`,
      'keyframe-not-found',
      { parameterId: edit.trackParameterId, time: edit.time },
    );
  }
  if (index === track.keyframes.length - 1) {
    throw new CustomMotionEditError(
      `The last keyframe of "${edit.trackParameterId}" must omit the segment (codec contract)`,
      'invalid-segment',
      { parameterId: edit.trackParameterId, time: edit.time },
    );
  }
  // Cheap edit-input guard before cloning: the full segment shape and the cp
  // ordering contract are enforced by the canonical contract on the produced
  // motion (assertValidCustomMotionEdit below).
  const raw = edit.segment as unknown as { type?: string; controlPoints?: unknown };
  if (raw.type === 'bezier'
    && (!Array.isArray(raw.controlPoints) || raw.controlPoints.length !== 2
      || !raw.controlPoints[0] || typeof raw.controlPoints[0] !== 'object'
      || !raw.controlPoints[1] || typeof raw.controlPoints[1] !== 'object')) {
    throw new CustomMotionEditError(
      `Bezier segment on "${edit.trackParameterId}" must contain exactly two control points`,
      'invalid-segment',
      { parameterId: edit.trackParameterId, time: edit.time },
    );
  }
  const segment = cloneSegment(edit.segment);
  const nextKeyframes = track.keyframes.map((keyframe, keyframeIndex) => {
    if (keyframeIndex !== index) return keyframe;
    // Linear is still an explicit segment: the contract requires every
    // non-last keyframe to carry one, linear included (ADR-0029).
    return { time: keyframe.time, value: keyframe.value, segment };
  });
  return replaceTrack(tracks, track, { ...track, keyframes: normalizeTailSegment(nextKeyframes) });
}

/**
 * Strip a stale `segment` from the last keyframe after structural edits:
 * the trailing point describes nothing, so it must omit the segment.
 */
function normalizeTailSegment(keyframes: readonly CustomMotionKeyframe[]): CustomMotionKeyframe[] {
  return keyframes.map((keyframe, index) => {
    if (index !== keyframes.length - 1) return keyframe;
    return { time: keyframe.time, value: keyframe.value };
  });
}

function requireFreeInsertionIndex(
  track: CustomMotionTrack,
  time: number,
  parameterId: string,
): number {
  if (!Number.isFinite(time) || time < 0) {
    throw new CustomMotionEditError(
      `Expected a finite non-negative keyframe time on "${parameterId}"`,
      'invalid-keyframe',
      { parameterId },
    );
  }
  for (let index = 0; index < track.keyframes.length; index++) {
    const candidate = track.keyframes[index];
    if (candidate.time === time) {
      throw new CustomMotionEditError(
        `Keyframe time ${time} is already occupied on "${parameterId}"`,
        'keyframe-time-collision',
        { parameterId, time },
      );
    }
    if (candidate.time > time) return index;
  }
  return track.keyframes.length;
}

function requireTrack(tracks: readonly CustomMotionTrack[], parameterId: string): CustomMotionTrack {
  const track = tracks.find((candidate) => candidate.parameterId === parameterId);
  if (!track) {
    throw new CustomMotionEditError(`Parameter track not found: ${parameterId}`, 'track-not-found', { parameterId });
  }
  return track;
}

function replaceTrack(
  tracks: CustomMotionTrack[],
  source: CustomMotionTrack,
  next: CustomMotionTrack,
): CustomMotionTrack[] {
  return tracks.map((track) => (track.parameterId === source.parameterId ? next : track));
}

function requireFiniteFade(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new CustomMotionEditError(`Expected a finite non-negative fadeInSeconds, got ${value}`, 'invalid-fade');
  }
  return value;
}

function requirePositiveDuration(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new CustomMotionEditError(`Expected a finite positive durationSeconds, got ${value}`, 'invalid-duration');
  }
  return value;
}

function cloneSegment(segment: CustomMotionSegment): CustomMotionSegment {
  if (segment.type === 'bezier') {
    return {
      type: 'bezier',
      controlPoints: [
        { time: segment.controlPoints[0].time, value: segment.controlPoints[0].value },
        { time: segment.controlPoints[1].time, value: segment.controlPoints[1].value },
      ],
    };
  }
  return { type: segment.type };
}

interface CustomMotionPoint {
  readonly time: number;
  readonly value: number;
}

/**
 * Split the cubic Bezier segment spanning `current -> next` at the absolute
 * motion-local `splitTime` (de Casteljau). Control points use absolute
 * coordinates, so each half keeps the exact curve of the original segment
 * restricted to its own time range (ADR-0029 lossless insert/crop).
 *
 * The segment parameter is not linear in time (the x-axis itself is a cubic
 * Bezier), so the split parameter must be solved for `x(u) = splitTime`
 * exactly like the runtime evaluator does.
 */
function splitBezierSegment(
  current: CustomMotionKeyframe,
  next: CustomMotionKeyframe,
  segment: Extract<CustomMotionSegment, { type: 'bezier' }>,
  splitTime: number,
): {
  left: Extract<CustomMotionSegment, { type: 'bezier' }>;
  right: Extract<CustomMotionSegment, { type: 'bezier' }>;
  splitValue: number;
} {
  const p1 = segment.controlPoints[0];
  const p2 = segment.controlPoints[1];
  const u = solveBezierTime(current, p1, p2, next, splitTime);
  const a1 = lerpPoint(current, p1, u);
  const b1 = lerpPoint(p1, p2, u);
  const c1 = lerpPoint(p2, next, u);
  const a2 = lerpPoint(a1, b1, u);
  const b2 = lerpPoint(b1, c1, u);
  const split = lerpPoint(a2, b2, u);
  return {
    left: { type: 'bezier', controlPoints: [a1, a2] },
    right: { type: 'bezier', controlPoints: [b2, c1] },
    splitValue: split.value,
  };
}

function lerpPoint(a: CustomMotionPoint, b: CustomMotionPoint, t: number): CustomMotionPoint {
  return {
    time: a.time + (b.time - a.time) * t,
    value: a.value + (b.value - a.value) * t,
  };
}

/**
 * Crop helper: when the new duration cuts through a segment, create a
 * boundary keyframe at the crop point with the interpolated curve value so
 * the retained range stays visually identical (ADR-0029). Extending never
 * creates keyframes — the tail value is held instead.
 */
export function cropCustomMotionToDuration(
  motion: Extract<CharacterMotionOutput, { kind: 'custom' }>,
  durationSeconds: number,
): Extract<CharacterMotionOutput, { kind: 'custom' }> {
  const duration = requirePositiveDuration(durationSeconds);
  const tracks = cropTracksToDuration(motion.tracks, duration);
  const next: Extract<CharacterMotionOutput, { kind: 'custom' }> = {
    ...motion,
    durationSeconds: duration,
    tracks,
  };
  assertValidCustomMotionEdit(next);
  return next;
}

function cropTracksToDuration(
  tracks: readonly CustomMotionTrack[],
  durationSeconds: number,
): CustomMotionTrack[] {
  return tracks.map((track) => {
    const last = track.keyframes[track.keyframes.length - 1];
    if (last.time <= durationSeconds) return track;
    if (last.time === durationSeconds) return { ...track, keyframes: normalizeTailSegment(track.keyframes) };

    let keyframes = track.keyframes;
    const boundaryTime = durationSeconds;
    if (keyframes.every((keyframe) => keyframe.time !== boundaryTime)) {
      // Only interpolate when the crop point falls strictly inside a segment
      // (between two existing keyframes); evaluateCustomMotionTrack returns
      // the tail-hold value past the last point, which must NOT create a
      // fake boundary at an empty tail.
      const index = keyframes.findIndex((keyframe) => keyframe.time > boundaryTime);
      const inside = index > 0;
      if (inside) {
        const previous = keyframes[index - 1];
        const next = keyframes[index];
        const inherited = previous.segment;
        let previousSegment = inherited;
        let boundarySegment = inherited;
        let boundaryValue: number | null = null;
        if (inherited && inherited.type === 'bezier') {
          // de Casteljau split (ADR-0029): the retained range must reproduce
          // the original curve exactly, so the segment up to the boundary is
          // the left half and the boundary value is the split point.
          const split = splitBezierSegment(previous, next, inherited, boundaryTime);
          previousSegment = split.left;
          boundarySegment = split.right;
          boundaryValue = split.splitValue;
        } else {
          boundaryValue = evaluateCustomMotionTrack(track, boundaryTime);
        }
        keyframes = [
          ...keyframes.slice(0, index - 1),
          ...(previousSegment
            ? [{ time: previous.time, value: previous.value, segment: previousSegment }]
            : [{ time: previous.time, value: previous.value }]),
          { time: boundaryTime, value: boundaryValue ?? 0, segment: boundarySegment },
          ...keyframes.slice(index),
        ];
      }
    }
    const cropped = keyframes.filter((keyframe) => keyframe.time <= durationSeconds);
    return { ...track, keyframes: normalizeTailSegment(cropped) };
  });
}

/**
 * Cap a fade value to fit the motion duration; used by the editor when the
 * duration shrinks below an entry fade (the UI must stop the trim handle at
 * the largest fade instead of clamping silently).
 */
export function maxAllowedDuration(motion: Extract<CharacterMotionOutput, { kind: 'custom' }>): number {
  let max = motion.fadeInSeconds;
  for (const track of motion.tracks) {
    if (track.fadeInSeconds !== undefined) max = Math.max(max, track.fadeInSeconds);
  }
  return max;
}
