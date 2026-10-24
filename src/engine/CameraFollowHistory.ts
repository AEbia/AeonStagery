import type { CameraPosition } from './CameraStateResolver';
import { cameraFollowRate } from './CameraFollowSmoothing';

export interface CameraAnchorValidityInterval {
  readonly start: number;
  readonly end: number;
}

export interface CameraAnchorSample {
  readonly time: number;
  readonly position: CameraPosition;
}

export interface CameraAnchorEvent {
  readonly time: number;
  readonly left: CameraPosition;
  readonly right: CameraPosition;
}

/** Immutable anchor history. `version` identifies this schema; `revision` identifies its contents. */
export interface CameraAnchorTrajectory {
  readonly version: 1;
  readonly revision?: string | number;
  readonly characterId: string;
  readonly part: string;
  readonly validity: readonly CameraAnchorValidityInterval[];
  readonly samples: readonly CameraAnchorSample[];
  readonly events: readonly CameraAnchorEvent[];
}

export type CameraAnchorEventSide = 'left' | 'right';

export interface CameraFollowHistoryOptions {
  readonly startTime: number;
  readonly queryTime: number;
  readonly initialPosition: CameraPosition;
  readonly offset: CameraPosition;
  readonly smoothing: number;
  readonly gridHz?: number;
  readonly checkpointSeconds?: number;
  readonly cacheKey?: string;
  readonly eventSide?: CameraAnchorEventSide;
}

export const CAMERA_FOLLOW_HISTORY_GRID_HZ = 960;
export const CAMERA_FOLLOW_HISTORY_CHECKPOINT_SECONDS = 1;

const followCheckpointCache = new WeakMap<CameraAnchorTrajectory, Map<string, Map<number, CameraPosition>>>();

interface IndexedAnchorPoint {
  readonly time: number;
  readonly left: CameraPosition;
  readonly right: CameraPosition;
  readonly exactEvent?: CameraAnchorEvent;
}
interface IndexedInterval {
  readonly start: number;
  readonly end: number;
  readonly points: readonly IndexedAnchorPoint[];
}
interface TrajectoryIndex {
  readonly revision: CameraAnchorTrajectory['revision'];
  readonly samples: CameraAnchorTrajectory['samples'];
  readonly events: CameraAnchorTrajectory['events'];
  readonly validity: CameraAnchorTrajectory['validity'];
  readonly intervals: readonly IndexedInterval[];
  queries: number;
}
const trajectoryIndexes = new WeakMap<CameraAnchorTrajectory, TrajectoryIndex>();

function indexTrajectory(trajectory: CameraAnchorTrajectory): TrajectoryIndex {
  const known = trajectoryIndexes.get(trajectory);
  if (known && known.revision === trajectory.revision && known.samples === trajectory.samples
    && known.events === trajectory.events && known.validity === trajectory.validity) return known;
  const intervals = trajectory.validity.map(interval => {
    const points = new Map<number, IndexedAnchorPoint>();
    for (const sample of trajectory.samples) {
      if (sample.time >= interval.start && sample.time <= interval.end && !points.has(sample.time)) {
        points.set(sample.time, { time: sample.time, left: sample.position, right: sample.position });
      }
    }
    for (const event of trajectory.events) {
      if (event.time >= interval.start && event.time <= interval.end) {
        points.set(event.time, { time: event.time, left: event.left, right: event.right,
          exactEvent: points.get(event.time)?.exactEvent ?? event });
      }
    }
    return { ...interval, points: [...points.values()].sort((left, right) => left.time - right.time) };
  });
  const index = { revision: trajectory.revision, samples: trajectory.samples, events: trajectory.events,
    validity: trajectory.validity, intervals, queries: 0 };
  trajectoryIndexes.set(trajectory, index);
  return index;
}

/** Actual retained derived-entry counts; byte sizes depend on the JS engine. */
export function getCameraFollowHistoryDiagnostics(trajectory: CameraAnchorTrajectory) {
  const index = trajectoryIndexes.get(trajectory);
  const contexts = followCheckpointCache.get(trajectory);
  return {
    anchorQueries: index?.queries ?? 0,
    indexedPoints: index?.intervals.reduce((sum, interval) => sum + interval.points.length, 0) ?? 0,
    contexts: contexts?.size ?? 0,
    checkpoints: [...contexts?.values() ?? []].reduce((sum, checkpoints) => sum + checkpoints.size, 0),
  };
}

/** Sample only inside declared validity. Index immutable source data once, then binary-search. */
export function sampleCameraAnchorTrajectory(
  trajectory: CameraAnchorTrajectory,
  time: number,
  side: CameraAnchorEventSide = 'right',
): CameraPosition | null {
  const index = indexTrajectory(trajectory);
  index.queries++;
  const interval = index.intervals.find(candidate => side === 'left'
    ? time > candidate.start && time <= candidate.end
    : time >= candidate.start && time < candidate.end);
  if (!interval) return null;
  const points = interval.points;
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle].time < time) low = middle + 1;
    else high = middle;
  }
  const after = points[low];
  if (after?.time === time) return { ...(after.exactEvent?.[side] ?? after[side]) };
  const before = points[low - 1];
  if (!before || !after) return null;
  const progress = (time - before.time) / (after.time - before.time);
  return { x: before.right.x + (after.left.x - before.right.x) * progress,
    y: before.right.y + (after.left.y - before.right.y) * progress };
}

function integrateLinearTarget(
  position: CameraPosition,
  from: CameraPosition,
  to: CameraPosition,
  duration: number,
  lambda: number,
): CameraPosition {
  if (duration <= 0) return position;
  if (lambda === Infinity) return { ...to };
  const decay = Math.exp(-lambda * duration);
  const integrate = (p: number, a: number, b: number) => {
    const slope = (b - a) / duration;
    return b - slope / lambda + (p - a + slope / lambda) * decay;
  };
  return {
    x: integrate(position.x, from.x, to.x),
    y: integrate(position.y, from.y, to.y),
  };
}

/**
 * Reconstruct exponential pursuit from a fixed global grid, splitting at
 * trajectory validity and discontinuity boundaries. Grid prefixes are stable
 * across query order; a partial final interval is integrated but not cached.
 */
export function evaluateCameraFollowHistory(
  trajectory: CameraAnchorTrajectory,
  options: CameraFollowHistoryOptions,
): CameraPosition {
  const { startTime, queryTime, initialPosition, offset } = options;
  if (queryTime < startTime) return { ...initialPosition };
  const lambda = cameraFollowRate(options.smoothing);
  const instant = lambda === Infinity;
  if (queryTime === startTime && !instant) return { ...initialPosition };
  if (queryTime === startTime) {
    const target = sampleCameraAnchorTrajectory(trajectory, startTime, options.eventSide ?? 'right');
    return target
      ? { x: target.x + offset.x, y: target.y + offset.y }
      : { ...initialPosition };
  }
  // An immediately following camera has no pursuit history while its target
  // is available. Missing targets still use reconstruction to retain the last
  // valid position.
  if (instant) {
    const right = sampleCameraAnchorTrajectory(trajectory, queryTime, 'right');
    if (right) {
      const leftEvent = options.eventSide === 'left' && trajectory.events.some(event => event.time === queryTime);
      const target = leftEvent ? sampleCameraAnchorTrajectory(trajectory, queryTime, 'left') ?? right : right;
      return { x: target.x + offset.x, y: target.y + offset.y };
    }
  }
  const gridHz = options.gridHz ?? CAMERA_FOLLOW_HISTORY_GRID_HZ;
  const requestedCheckpointSeconds = options.checkpointSeconds ?? CAMERA_FOLLOW_HISTORY_CHECKPOINT_SECONDS;
  const checkpointSeconds = requestedCheckpointSeconds > 0 ? requestedCheckpointSeconds : CAMERA_FOLLOW_HISTORY_CHECKPOINT_SECONDS;
  const baseCacheKey = options.cacheKey === undefined ? undefined : [
    options.cacheKey,
    startTime,
    initialPosition.x,
    initialPosition.y,
    offset.x,
    offset.y,
    lambda,
    gridHz,
    checkpointSeconds,
    options.eventSide ?? 'right',
  ].join('|');
  let checkpoints = baseCacheKey
    ? followCheckpointCache.get(trajectory)?.get(baseCacheKey)
    : undefined;
  const checkpointIndex = Math.floor(queryTime / checkpointSeconds);
  const candidateCheckpoint = checkpointIndex * checkpointSeconds;
  const queryIsLeftEvent = options.eventSide === 'left' && trajectory.events.some(event => event.time === queryTime);
  let integrationStart = startTime;
  let cachedCheckpoint: CameraPosition | undefined;
  if (checkpoints) {
    for (const [time, frame] of checkpoints) {
      if (time > integrationStart && time <= candidateCheckpoint && (!queryIsLeftEvent || time < queryTime)) {
        integrationStart = time;
        cachedCheckpoint = frame;
      }
    }
  }
  let position = cachedCheckpoint ? { ...cachedCheckpoint } : { ...initialPosition };
  let priorTime = integrationStart;
  let priorTarget = sampleCameraAnchorTrajectory(trajectory, integrationStart, options.eventSide ?? 'right');
  if (priorTarget) {
    priorTarget = { x: priorTarget.x + offset.x, y: priorTarget.y + offset.y };
  }

  const boundaries = new Set<number>([integrationStart, queryTime]);
  for (const interval of trajectory.validity) {
    if (interval.start > integrationStart && interval.start < queryTime) boundaries.add(interval.start);
    if (interval.end > integrationStart && interval.end < queryTime) boundaries.add(interval.end);
  }
  for (const event of trajectory.events) {
    if (event.time > integrationStart && event.time < queryTime) boundaries.add(event.time);
  }
  const firstGrid = Math.floor(integrationStart * gridHz) + 1;
  const lastGrid = Math.floor(queryTime * gridHz);
  for (let tick = firstGrid; tick <= lastGrid; tick += 1) {
    const time = tick / gridHz;
    if (time > integrationStart && time < queryTime) boundaries.add(time);
  }
  const firstCheckpoint = Math.floor(integrationStart / checkpointSeconds) + 1;
  const lastCheckpoint = Math.floor(queryTime / checkpointSeconds);
  for (let checkpoint = firstCheckpoint; checkpoint <= lastCheckpoint; checkpoint += 1) {
    const time = checkpoint * checkpointSeconds;
    if (time > integrationStart && time < queryTime) boundaries.add(time);
  }
  const times = [...boundaries].sort((a, b) => a - b);

  for (const time of times.slice(1)) {
    const leftBoundary = trajectory.events.some((event) => event.time === time)
      || trajectory.validity.some((interval) => interval.end === time);
    const rawLeft = sampleCameraAnchorTrajectory(trajectory, time, leftBoundary ? 'left' : 'right');
    const rawRight = sampleCameraAnchorTrajectory(trajectory, time, 'right');
    const leftTarget = rawLeft
      ? { x: rawLeft.x + offset.x, y: rawLeft.y + offset.y }
      : null;
    const rightTarget = rawRight
      ? { x: rawRight.x + offset.x, y: rawRight.y + offset.y }
      : null;
    if (lambda === Infinity && rightTarget) {
      const isTerminalEvent = time === queryTime && trajectory.events.some((event) => event.time === time);
      position = isTerminalEvent && options.eventSide === 'left' ? (leftTarget ?? rightTarget) : rightTarget;
    } else if (leftTarget && priorTarget) {
      position = integrateLinearTarget(position, priorTarget, leftTarget, time - priorTime, lambda);
    } else if (rightTarget && instant) {
      position = { ...rightTarget };
    }
    priorTime = time;
    priorTarget = rightTarget;
    const checkpointNumber = time / checkpointSeconds;
    if (baseCacheKey && time < queryTime && Math.abs(checkpointNumber - Math.round(checkpointNumber)) < 1e-9) {
      const cache = checkpoints ?? new Map<number, CameraPosition>();
      cache.set(time, { ...position });
      while (cache.size > 256) cache.delete(cache.keys().next().value as number);
      if (!checkpoints) {
        const perTrajectory = followCheckpointCache.get(trajectory) ?? new Map<string, Map<number, CameraPosition>>();
        perTrajectory.set(baseCacheKey, cache);
        while (perTrajectory.size > 32) perTrajectory.delete(perTrajectory.keys().next().value as string);
        followCheckpointCache.set(trajectory, perTrajectory);
        checkpoints = cache;
      }
    }
  }
  const queryIsCheckpoint = Math.abs(queryTime / checkpointSeconds - Math.round(queryTime / checkpointSeconds)) < 1e-9;
  if (baseCacheKey && queryIsCheckpoint && !queryIsLeftEvent) {
    const cache = checkpoints ?? new Map<number, CameraPosition>();
    cache.set(queryTime, { ...position });
    while (cache.size > 256) cache.delete(cache.keys().next().value as number);
    if (!checkpoints) {
      const perTrajectory = followCheckpointCache.get(trajectory) ?? new Map<string, Map<number, CameraPosition>>();
      perTrajectory.set(baseCacheKey, cache);
      while (perTrajectory.size > 32) perTrajectory.delete(perTrajectory.keys().next().value as string);
      followCheckpointCache.set(trajectory, perTrajectory);
      checkpoints = cache;
    }
  }
  return position;
}
