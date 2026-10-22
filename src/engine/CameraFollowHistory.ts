import type { CameraPosition } from './CameraStateResolver';

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
  readonly zoomAt: (time: number) => number;
  readonly cacheKey?: string;
  readonly eventSide?: CameraAnchorEventSide;
}

export const CAMERA_FOLLOW_HISTORY_GRID_HZ = 240;
export const CAMERA_FOLLOW_HISTORY_CHECKPOINT_SECONDS = 1;

const followCheckpointCache = new WeakMap<CameraAnchorTrajectory, Map<string, Map<number, CameraPosition>>>();

/** Sample only inside declared validity. Left samples may observe an interval's exclusive end. */
export function sampleCameraAnchorTrajectory(
  trajectory: CameraAnchorTrajectory,
  time: number,
  side: CameraAnchorEventSide = 'right',
): CameraPosition | null {
  const interval = trajectory.validity.find((candidate) => side === 'left'
    ? time > candidate.start && time <= candidate.end
    : time >= candidate.start && time < candidate.end);
  if (!interval) return null;

  const events = trajectory.events.filter((event) => event.time >= interval.start && event.time <= interval.end);
  const event = events.find((candidate) => candidate.time === time);
  if (event) return { ...event[side] };

  const samples = trajectory.samples.filter((sample) => sample.time >= interval.start && sample.time <= interval.end);
  let before: CameraAnchorSample | undefined;
  let after: CameraAnchorSample | undefined;
  for (const sample of samples) {
    if (sample.time <= time && (!before || sample.time > before.time)) before = sample;
    if (sample.time >= time && (!after || sample.time < after.time)) after = sample;
  }
  for (const knownEvent of events) {
    if (knownEvent.time < time && (!before || knownEvent.time >= before.time)) {
      before = { time: knownEvent.time, position: knownEvent.right };
    }
    if (knownEvent.time > time && (!after || knownEvent.time <= after.time)) {
      after = { time: knownEvent.time, position: knownEvent.left };
    }
  }
  if (!before || !after) return null;
  if (before.time === after.time) return { ...before.position };
  const progress = (time - before.time) / (after.time - before.time);
  return {
    x: before.position.x + (after.position.x - before.position.x) * progress,
    y: before.position.y + (after.position.y - before.position.y) * progress,
  };
}

function clampTarget(point: CameraPosition, zoom: number): CameraPosition {
  const safeZoom = zoom > 0 ? zoom : 1;
  const halfView = 0.5 / safeZoom;
  return {
    x: Math.max(halfView, Math.min(point.x, 1 - halfView)),
    y: Math.max(halfView, Math.min(point.y, 1 - halfView)),
  };
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
  const smoothing = Math.max(0, Math.min(1, options.smoothing));
  if (smoothing === 1 || (queryTime === startTime && smoothing !== 0)) return { ...initialPosition };
  if (queryTime === startTime) {
    const target = sampleCameraAnchorTrajectory(trajectory, startTime, options.eventSide ?? 'right');
    return target
      ? clampTarget({ x: target.x + offset.x, y: target.y + offset.y }, options.zoomAt(startTime))
      : { ...initialPosition };
  }
  const gridHz = options.gridHz ?? CAMERA_FOLLOW_HISTORY_GRID_HZ;
  const requestedCheckpointSeconds = options.checkpointSeconds ?? CAMERA_FOLLOW_HISTORY_CHECKPOINT_SECONDS;
  const checkpointSeconds = requestedCheckpointSeconds > 0 ? requestedCheckpointSeconds : CAMERA_FOLLOW_HISTORY_CHECKPOINT_SECONDS;
  const lambda = smoothing === 0 ? Infinity : -60 * Math.log(smoothing);
  const baseCacheKey = options.cacheKey === undefined ? undefined : [
    options.cacheKey,
    startTime,
    initialPosition.x,
    initialPosition.y,
    offset.x,
    offset.y,
    smoothing,
    gridHz,
    checkpointSeconds,
    options.eventSide ?? 'right',
  ].join('|');
  let checkpoints = baseCacheKey
    ? followCheckpointCache.get(trajectory)?.get(baseCacheKey)
    : undefined;
  const checkpointIndex = Math.floor(queryTime / checkpointSeconds);
  const candidateCheckpoint = checkpointIndex * checkpointSeconds;
  const cachedCheckpoint = candidateCheckpoint > startTime ? checkpoints?.get(candidateCheckpoint) : undefined;
  const integrationStart = cachedCheckpoint ? candidateCheckpoint : startTime;
  let position = cachedCheckpoint ? { ...cachedCheckpoint } : { ...initialPosition };
  let priorTime = integrationStart;
  let priorTarget = sampleCameraAnchorTrajectory(trajectory, integrationStart, options.eventSide ?? 'right');
  if (priorTarget) {
    priorTarget = clampTarget(
      { x: priorTarget.x + offset.x, y: priorTarget.y + offset.y },
      options.zoomAt(integrationStart),
    );
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
    const zoom = options.zoomAt(time);
    const leftTarget = rawLeft
      ? clampTarget({ x: rawLeft.x + offset.x, y: rawLeft.y + offset.y }, zoom)
      : null;
    const rightTarget = rawRight
      ? clampTarget({ x: rawRight.x + offset.x, y: rawRight.y + offset.y }, zoom)
      : null;
    if (lambda === Infinity && rightTarget) {
      const isTerminalEvent = time === queryTime && trajectory.events.some((event) => event.time === time);
      position = isTerminalEvent && options.eventSide === 'left' ? (leftTarget ?? rightTarget) : rightTarget;
    } else if (leftTarget && priorTarget) {
      position = integrateLinearTarget(position, priorTarget, leftTarget, time - priorTime, lambda);
    } else if (rightTarget && smoothing === 0) {
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
  if (baseCacheKey && queryIsCheckpoint) {
    const cache = checkpoints ?? new Map<number, CameraPosition>();
    cache.set(queryTime, { ...position });
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
