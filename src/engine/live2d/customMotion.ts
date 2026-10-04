import type {
  CharacterMotionOutput,
  CustomMotionKeyframe,
  CustomMotionTrack,
} from '../../api/types/semantic-scene';

export interface CustomMotionFrame {
  readonly active: boolean;
  readonly localTime: number;
  readonly values: Readonly<Record<string, number>>;
}

const EPSILON = 1e-7;
const BEZIER_GRID_STEPS = 64;
const BEZIER_ROOT_EPSILON = 1e-9;

/**
 * Evaluate one custom motion track at a motion-local time (seconds).
 * The keyframe contract is enforced by the scene codec: strictly increasing
 * times, first keyframe at F0, explicit segments on every non-last keyframe,
 * finite values. The evaluator does not sort, clamp or merge authored data.
 *
 * After the last keyframe the tail value is held; before F0 the track is
 * inactive (null) so the runtime can decide handoff behaviour.
 */
export function evaluateCustomMotionTrack(track: CustomMotionTrack, localTime: number): number | null {
  if (!track.parameterId || !Number.isFinite(localTime) || track.keyframes.length === 0) return null;
  const keyframes = track.keyframes;
  if (localTime < 0 || localTime <= keyframes[0].time) return keyframes[0].value;
  if (localTime >= keyframes[keyframes.length - 1].time) return keyframes[keyframes.length - 1].value;

  if (keyframes.length > 8) {
    let low = 0;
    let high = keyframes.length - 2;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const current = keyframes[mid];
      const next = keyframes[mid + 1];
      if (localTime < current.time) {
        high = mid - 1;
      } else if (localTime >= next.time) {
        low = mid + 1;
      } else {
        return interpolateSegment(current, next, localTime);
      }
    }
  } else {
    for (let index = 0; index < keyframes.length - 1; index++) {
      const current = keyframes[index];
      const next = keyframes[index + 1];
      if (localTime >= next.time) continue;
      return interpolateSegment(current, next, localTime);
    }
  }

  return keyframes[keyframes.length - 1].value;
}

export function evaluateCustomMotion(
  motion: Extract<CharacterMotionOutput, { kind: 'custom' }>,
  localTime: number,
): CustomMotionFrame {
  if (!Number.isFinite(localTime) || localTime < 0) {
    return { active: false, localTime, values: {} };
  }
  const values: Record<string, number> = {};
  for (const track of motion.tracks) {
    const value = evaluateCustomMotionTrack(track, localTime);
    if (value !== null && Number.isFinite(value)) {
      values[track.parameterId] = value;
    }
  }
  return { active: true, localTime, values };
}

/**
 * Evaluate the outgoing segment of `current` toward `next` at a motion-local
 * time (seconds). Exported so the editor's lane-insert sampling writes the
 * exact curve value instead of reconstructing a synthetic track, which the
 * track-level evaluator rejects (empty parameterId guard).
 */
export function evaluateCustomMotionSegment(
  current: CustomMotionKeyframe,
  next: CustomMotionKeyframe,
  localTime: number,
): number {
  return interpolateSegment(current, next, localTime);
}

function interpolateSegment(
  current: CustomMotionKeyframe,
  next: CustomMotionKeyframe,
  localTime: number,
): number {
  const segment = current.segment;
  if (!segment || segment.type === 'linear') {
    return lerp(current.value, next.value, progress(current, next, localTime));
  }
  if (segment.type === 'stepped') return current.value;
  if (segment.type === 'inverseStepped') return next.value;
  return evaluateBezierSegment(current, next, segment.controlPoints, localTime);
}

function evaluateBezierSegment(
  current: CustomMotionKeyframe,
  next: CustomMotionKeyframe,
  controlPoints: readonly [
    { readonly time: number; readonly value: number },
    { readonly time: number; readonly value: number },
  ],
  localTime: number,
): number {
  const p1 = controlPoints[0];
  const p2 = controlPoints[1];
  const span = next.time - current.time;
  if (span <= EPSILON) return next.value;

  const t = solveBezierTime(current, p1, p2, next, localTime);
  return cubicBezier(t, current.value, p1.value, p2.value, next.value);
}

/**
 * Solve the bezier parameter t for an absolute time coordinate. Control
 * points use absolute motion-local seconds, so x(t) spans
 * [current.time, next.time].
 *
 * x(t) is only guaranteed monotonic when the control point times are ordered
 * inside the segment span (codec contract, ADR-0029). Legacy or hand-edited
 * data can double back in time; a coarse grid scan collects every crossing of
 * x(t) = targetX and the root nearest the linear guess wins, so evaluation
 * stays deterministic and never converges to an arbitrary wrong root.
 */
export function solveBezierTime(
  current: CustomMotionKeyframe,
  p1: { readonly time: number; readonly value: number },
  p2: { readonly time: number; readonly value: number },
  next: CustomMotionKeyframe,
  targetX: number,
): number {
  const span = next.time - current.time;
  if (span <= EPSILON) return targetX <= current.time ? 0 : 1;
  if (targetX <= current.time + EPSILON) return 0;
  if (targetX >= next.time - EPSILON) return 1;

  const linearGuess = (targetX - current.time) / span;
  let bestT = clamp(linearGuess, 0, 1);
  let bestError = Number.POSITIVE_INFINITY;
  const consider = (t: number, error: number) => {
    if (error < bestError - BEZIER_ROOT_EPSILON) {
      bestT = t;
      bestError = error;
    } else if (Math.abs(error - bestError) <= BEZIER_ROOT_EPSILON
      && Math.abs(t - linearGuess) < Math.abs(bestT - linearGuess)) {
      bestT = t;
      bestError = error;
    }
  };

  let prevT = 0;
  let prevX = cubicBezier(prevT, current.time, p1.time, p2.time, next.time) - targetX;
  for (let step = 1; step <= BEZIER_GRID_STEPS; step++) {
    const t = step / BEZIER_GRID_STEPS;
    const x = cubicBezier(t, current.time, p1.time, p2.time, next.time) - targetX;
    if (Math.abs(x) < BEZIER_ROOT_EPSILON) {
      // Root sitting on a grid point (e.g. the linear guess itself).
      consider(t, Math.abs(x));
    } else if ((prevX <= 0 && x >= 0) || (prevX >= 0 && x <= 0)) {
      // Sign change inside [prevT, t]: bisect to the crossing.
      let low = prevT;
      let high = t;
      for (let i = 0; i < 32; i++) {
        const mid = (low + high) / 2;
        const mx = cubicBezier(mid, current.time, p1.time, p2.time, next.time) - targetX;
        if (Math.abs(mx) < BEZIER_ROOT_EPSILON || high - low < 1e-12) {
          low = mid;
          high = mid;
          break;
        }
        if ((prevX <= 0 && mx <= 0) || (prevX >= 0 && mx >= 0)) low = mid;
        else high = mid;
      }
      const root = (low + high) / 2;
      consider(root, Math.abs(cubicBezier(root, current.time, p1.time, p2.time, next.time) - targetX));
    }
    prevT = t;
    prevX = x;
  }

  return bestT;
}

function progress(current: CustomMotionKeyframe, next: CustomMotionKeyframe, localTime: number): number {
  const span = next.time - current.time;
  if (span <= EPSILON) return 1;
  return clamp((localTime - current.time) / span, 0, 1);
}

function cubicBezier(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const oneMinusT = 1 - t;
  return oneMinusT ** 3 * p0
    + 3 * oneMinusT ** 2 * t * p1
    + 3 * oneMinusT * t ** 2 * p2
    + t ** 3 * p3;
}

function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
