/**
 * AeonStagery — Deterministic Camera State Resolver
 *
 * Pure reconstruction of the virtual camera state at an arbitrary scene time
 * from the compiled runtime timeline — the camera-side counterpart of
 * `computeSceneStateAtTime` (KSM-0003 runtime parity gate: playback, seek,
 * bake and export must agree on the same camera state lifecycle).
 *
 * Channel model:
 * - position / zoom / rotation are state channels with a stage-default
 *   baseline ({x:0.5,y:0.5} / 1 / 0). Regions of the timeline not covered by
 *   any writer resolve to the baseline instead of to whatever value a GSAP
 *   tween or the follow ticker last happened to leave behind.
 * - `cameraFollow` owns the position channel from its start until a
 *   `cameraUnfollow` or `cameraReset` releases it (KSM-0003 follow contract).
 * - `cameraShake` is a finite additive envelope and never persists.
 */

import type { RuntimeTimelineAction } from './RuntimeTimelineScene';
import { evaluateCharacterEase } from './CharacterAnimationContract';
import { resolveVec2 } from './utils/math';
import { DEFAULT_CAMERA_FOCUS_PART } from '../api/types/camera';
import { evaluateCameraFollowHistory, type CameraAnchorEventSide, type CameraAnchorTrajectory } from './CameraFollowHistory';
import { cameraFollowWeight, FOLLOW_DEFAULT_SMOOTHING } from './CameraFollowSmoothing';
export { FOLLOW_DEFAULT_SMOOTHING } from './CameraFollowSmoothing';

export interface CameraPosition {
  x: number;
  y: number;
}

export interface ActiveFollowResolution {
  characterId: string;
  offset: CameraPosition;
  part?: string;
  /** Authored follow smoothing carried through for the live ticker. */
  smoothing?: number;
}

export interface CameraChannelCoverage {
  /** True when any writer touched this channel at or before the query time. */
  position: boolean;
  zoom: boolean;
  rotation: boolean;
}

export interface ResolvedCameraState {
  position: CameraPosition;
  zoom: number;
  rotation: number;
  /** Non-null while a follow owns the position channel at the query time. */
  follow: ActiveFollowResolution | null;
  coverage: CameraChannelCoverage;
}

export interface CameraStateResolverDeps {
  /**
   * Deterministic character anchor resolution in normalized stage coords,
   * evaluated at the query time. Injected so follow reconstruction never
   * depends on live model transform state (which is stale mid-seek until
   * characters are re-synchronized).
   */
  resolveCharacterPosition?: (characterId: string, part?: string) => CameraPosition | null;
  /**
   * Anchor resolution at an ARBITRARY time — used to capture the followed
   * character's framing at the follow statement's own start so the entry
   * transient decays from where playback would have started gliding.
   */
  resolveCharacterPositionAtTime?: (characterId: string, time: number, part?: string) => CameraPosition | null;
  /** One captured destination per focus segment, shared by playback and seeks. */
  resolveFocusPosition?: (characterId: string, time: number, part?: string) => CameraPosition | null;
  /** A live ticker's latched release frame, supplied only during frame reads. */
  resolveLiveFollowRelease?: (action: RuntimeTimelineAction, time: number) => CameraPosition | null;
  /** Evaluate writes by their compiled property values, not legacy move labels. */
  compiledChannelOwnership?: boolean;
  /** Immutable historical inputs used to reconstruct follow pursuit. */
  anchorTrajectories?: readonly CameraAnchorTrajectory[];
  /** Resolve the already-prepared zoom property curve at an arbitrary time. */
  resolveZoomAtTime?: (time: number, beforeAction?: RuntimeTimelineAction) => number;
  followCacheKey?: string;
  followEventSide?: CameraAnchorEventSide;
}

export const STAGE_DEFAULT_CAMERA_POSITION: CameraPosition = { x: 0.5, y: 0.5 };
export const STAGE_DEFAULT_CAMERA_ZOOM = 1;
export const STAGE_DEFAULT_CAMERA_ROTATION = 0;
/**
 * A release action stops the ticker and latches the current glide frame.
 */
export function findFollowReleaseInstant(timeline: readonly RuntimeTimelineAction[], afterAction: RuntimeTimelineAction): number {
  const afterStart = afterAction.time ?? 0;
  const afterIndex = timeline.indexOf(afterAction);
  let release = Infinity;
  for (const [index, action] of timeline.entries()) {
    const time = action.time ?? 0;
    if (time < afterStart || (time === afterStart && index <= afterIndex) || time >= release) continue;
    const params = action.params ?? {};
    const releases = action.action === 'cameraUnfollow'
      || action.action === 'cameraReset'
      || (action.action === 'cameraFollow' && typeof params.characterId === 'string' && params.characterId.length > 0)
      || (action.action === 'cameraMotion' && compiledMotionWritesPosition(params))
      || (action.action === 'cameraPath' && compiledPathWritesPosition(params));
    if (releases) release = time;
  }
  return release;
}

interface TimelineEvent {
  action: RuntimeTimelineAction;
  index: number;
  time: number;
}

function toOrderedEvents(timeline: readonly RuntimeTimelineAction[], time: number): TimelineEvent[] {
  const events = timeline
    .map((action, index) => ({ action, index, time: action.time ?? 0 }))
    .filter((event) => event.time <= time)
    .sort((a, b) => a.time - b.time || a.index - b.index);
  return events;
}

/** Index writers only; no camera poses or future frames are evaluated here. */
function contributingEventPrefixes(events: readonly TimelineEvent[]): readonly (readonly number[])[] {
  const prefixes: number[][] = [[]];
  let x = -1;
  let y = -1;
  let zoom = -1;
  let rotation = -1;
  let unfollow = -1;
  for (const [index, { action }] of events.entries()) {
    const params = action.params ?? {};
    if (action.action === 'cameraReset') {
      x = y = zoom = rotation = index;
    } else if (action.action === 'cameraFollow' && params.characterId) {
      x = y = index;
    } else if (action.action === 'cameraUnfollow') {
      // A stop releases ownership without replacing the latched position.
      unfollow = index;
    } else if (action.action === 'cameraMotion') {
      if (compiledMotionWritesX(params)) x = index;
      if (compiledMotionWritesY(params)) y = index;
      if (compiledMotionWritesZoom(params)) zoom = index;
      if (compiledMotionWritesRotation(params)) rotation = index;
    } else if (action.action === 'cameraPath') {
      if (compiledPathWritesProperty(params, 'position')) x = y = index;
      if (compiledPathWritesProperty(params, 'zoom')) zoom = index;
      if (compiledPathWritesProperty(params, 'rotation')) rotation = index;
    }
    prefixes.push([...new Set([x, y, zoom, rotation, unfollow])]
      .filter((writer) => writer >= 0).sort((left, right) => left - right));
  }
  return prefixes;
}

interface MotionChannels extends CameraPosition { zoom: number; rotation: number }

/**
 * Resolve the deterministic camera state at `time`.
 */
interface ResolverEvaluationContext {
  readonly events: readonly TimelineEvent[];
  readonly contributors: readonly (readonly number[])[] | null;
  readonly releaseTimes: ReadonlyMap<RuntimeTimelineAction, number>;
  readonly states: Map<number, ResolvedCameraState>;
}

export function computeCameraStateAtTime(
  timeline: readonly RuntimeTimelineAction[],
  time: number,
  deps: CameraStateResolverDeps = {},
): ResolvedCameraState {
  const evaluationDeps: CameraStateResolverDeps = deps.compiledChannelOwnership === undefined
    ? { ...deps, compiledChannelOwnership: true }
    : deps;
  const events = toOrderedEvents(timeline, time);
  const releaseTimes = new Map<RuntimeTimelineAction, number>();
  let nextRelease = Infinity;
  for (let index = events.length - 1; index >= 0; index--) {
    const { action, time: start } = events[index];
    const params = action.params ?? {};
    const validFollow = action.action === 'cameraFollow' && typeof params.characterId === 'string' && params.characterId.length > 0;
    if (validFollow) releaseTimes.set(action, nextRelease);
    if (validFollow || action.action === 'cameraUnfollow' || action.action === 'cameraReset'
      || (action.action === 'cameraMotion' && compiledMotionWritesPosition(params))
      || (action.action === 'cameraPath' && compiledPathWritesPosition(params))) nextRelease = start;
  }
  const context: ResolverEvaluationContext = {
    events,
    contributors: evaluationDeps.compiledChannelOwnership && evaluationDeps.resolveZoomAtTime
      ? contributingEventPrefixes(events) : null,
    releaseTimes,
    states: new Map(),
  };

  // Resolve only requested start states. The explicit stack shares one event
  // list and avoids recursive prefix copies, scans and JavaScript stack depth.
  // Every index and memoized state belongs to this query and is then discarded.
  const pending = [{ end: events.length,
    evaluation: evaluateCameraStatePrefix(events.length, time, evaluationDeps, context) }];
  let step = pending[0].evaluation.next();
  while (true) {
    if (step.done) {
      const completed = pending.pop()!;
      if (pending.length === 0) return step.value;
      context.states.set(completed.end, step.value);
      step = pending[pending.length - 1].evaluation.next(step.value);
    } else {
      const end = step.value;
      const cached = context.states.get(end);
      if (cached) {
        step = pending[pending.length - 1].evaluation.next(cached);
      } else {
        const evaluation = evaluateCameraStatePrefix(end, events[end].time, evaluationDeps, context);
        pending.push({ end, evaluation });
        step = evaluation.next();
      }
    }
  }
}

/**
 * Prepare the zoom-only property history once, then resolve samples by the
 * latest writer. Follow integration can query this curve at every grid step
 * without replaying the complete camera action history for each sample.
 */
export function prepareCameraZoomResolver(
  timeline: readonly RuntimeTimelineAction[],
): (time: number, beforeAction?: RuntimeTimelineAction) => number {
  const writers = timeline
    .map((action, index) => ({ action, index, start: action.time ?? 0 }))
    .filter(({ action }) => action.action === 'cameraReset'
      || (action.action === 'cameraMotion' && compiledMotionWritesZoom(action.params ?? {}))
      || (action.action === 'cameraPath' && compiledPathWritesProperty(action.params ?? {}, 'zoom')))
    .sort((left, right) => left.start - right.start || left.index - right.index);

  let current = (_time: number): number => STAGE_DEFAULT_CAMERA_ZOOM;
  const prepared: Array<{ readonly start: number; readonly sample: (time: number) => number }> = [];
  const beforeWriter = new WeakMap<object, (time: number) => number>();
  for (const { action, start } of writers) {
    beforeWriter.set(action, current);
    const from = current(start);
    const sample = createPreparedCameraZoomWriter(action, start, from);
    prepared.push({ start, sample });
    current = sample;
  }

  return (time: number, beforeAction?: RuntimeTimelineAction): number => {
    if (beforeAction) {
      const resolveBeforeWriter = beforeWriter.get(beforeAction);
      if (resolveBeforeWriter) return resolveBeforeWriter(time);
    }
    let low = 0;
    let high = prepared.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (prepared[middle].start <= time) low = middle + 1;
      else high = middle;
    }
    return low === 0 ? STAGE_DEFAULT_CAMERA_ZOOM : prepared[low - 1].sample(time);
  };
}

function createPreparedCameraZoomWriter(
  action: RuntimeTimelineAction,
  start: number,
  from: number,
): (time: number) => number {
  if (action.action === 'cameraReset') {
    const params = action.params ?? {};
    const rawDuration = params.duration ?? params.durationSeconds;
    const duration = typeof rawDuration === 'number' && rawDuration >= 0 ? rawDuration : 1;
    const ease = typeof params.ease === 'string'
      ? params.ease
      : typeof params.easing === 'string' ? params.easing : 'power3.inOut';
    return (time) => {
      const progress = duration === 0 ? 1 : Math.max(0, Math.min(1, (time - start) / duration));
      const weight = evaluateCharacterEase(ease, progress, 'power3.inOut');
      return from + (STAGE_DEFAULT_CAMERA_ZOOM - from) * weight;
    };
  }

  if (action.action === 'cameraMotion') {
    const params = action.params ?? {};
    const duration = typeof params.duration === 'number' && params.duration >= 0 ? params.duration : 1;
    const ease = typeof params.easing === 'string' ? params.easing : 'smooth';
    const legacyDefaults = !Array.isArray(params._cameraProperties);
    const legacyZoomDefault = legacyDefaults
      ? params.move === 'zoom' ? 1.5 : params.move === 'push' ? '+=0.3' : params.move === 'pull' ? '-=0.3' : undefined
      : undefined;
    const rawZoom = params.zoom ?? legacyZoomDefault;
    const zoomTo = compiledMotionWritesZoom(params) && rawZoom !== undefined
      ? resolveZoomValue(rawZoom, from)
      : undefined;
    return (time) => {
      if (time < start || zoomTo === undefined) return from;
      const progress = duration === 0 ? 1 : Math.max(0, Math.min(1, (time - start) / duration));
      const weight = evaluateCharacterEase(ease, progress, 'power2.inOut');
      return from + (zoomTo - from) * weight;
    };
  }

  const params = action.params ?? {};
  const samplePath = createPreparedCameraPath(params);
  return (time) => {
    const channels: MotionChannels = { ...STAGE_DEFAULT_CAMERA_POSITION, zoom: from, rotation: STAGE_DEFAULT_CAMERA_ROTATION };
    const coverage: CameraChannelCoverage = { position: false, zoom: false, rotation: false };
    samplePath(channels, coverage, start, time);
    return channels.zoom;
  };
}

function* evaluateCameraStatePrefix(
  end: number,
  time: number,
  deps: CameraStateResolverDeps,
  context: ResolverEvaluationContext,
): Generator<number, ResolvedCameraState, ResolvedCameraState> {
  const channels: MotionChannels = {
    x: STAGE_DEFAULT_CAMERA_POSITION.x,
    y: STAGE_DEFAULT_CAMERA_POSITION.y,
    zoom: STAGE_DEFAULT_CAMERA_ZOOM,
    rotation: STAGE_DEFAULT_CAMERA_ROTATION,
  };

  let follow: ActiveFollowResolution | null = null;
  let composedFollowFrame: CameraPosition | null = null;
  const coverage: CameraChannelCoverage = { position: false, zoom: false, rotation: false };

  const indexes = context.contributors?.[end] ?? Array.from({ length: end }, (_, index) => index);
  for (const eventIndex of indexes) {
    const event = context.events[eventIndex];
    const { action, time: start } = event;
    const sampleTime = time;
    const inheritStartCoverage = (state: ResolvedCameraState) => {
      // Coverage describes all writes in the elapsed prefix, including a
      // predecessor hidden by a later missing-anchor position writer.
      coverage.position ||= state.coverage.position;
      coverage.zoom ||= state.coverage.zoom;
      coverage.rotation ||= state.coverage.rotation;
      return state;
    };
    if (deps.compiledChannelOwnership && action.action === 'cameraFollow') {
      const startState = inheritStartCoverage(yield eventIndex);
      channels.x = startState.position.x;
      channels.y = startState.position.y;
    }
    if (action.action === 'cameraFollow') {
      const params = action.params ?? {};
      if (!params.characterId) continue;
      follow = {
        characterId: params.characterId,
        offset: normalizeOffset(params.offset),
        ...(typeof params.focus?.part === 'string' ? { part: params.focus.part } : {}),
        smoothing: typeof params.smoothing === 'number' ? params.smoothing : undefined,
      };
      coverage.position = true;
      const liveRelease = deps.resolveLiveFollowRelease?.(action, sampleTime);
      if (liveRelease) {
        channels.x = liveRelease.x;
        channels.y = liveRelease.y;
        composedFollowFrame = liveRelease;
        continue;
      }
      const activeFollow = follow;
      // Active follow: mirror tickFollow()'s exponential entry glide so a
      // seek into the transition presents the intermediate frame instead of
      // the settled anchor. The transient decays from the pre-follow channel
      // state toward the tracked anchor, measured against the anchor as it
      // was at the follow start.
      const releaseAt = context.releaseTimes.get(action) ?? Infinity;
      const followTime = Math.min(sampleTime, releaseAt);
      const trajectory = deps.anchorTrajectories?.find((candidate) =>
        candidate.characterId === activeFollow.characterId && candidate.part === (activeFollow.part ?? 'center'));
      if (trajectory) {
        const frame = evaluateCameraFollowHistory(trajectory, {
          startTime: start,
          queryTime: followTime,
          initialPosition: channels,
          offset: activeFollow.offset,
          smoothing: activeFollow.smoothing ?? FOLLOW_DEFAULT_SMOOTHING,
          cacheKey: deps.followCacheKey,
          eventSide: deps.followEventSide,
        });
        channels.x = frame.x;
        channels.y = frame.y;
        composedFollowFrame = frame;
      } else {
        // A released follow must sample its release frame, even when the
        // caller is seeking/exporting a later frame without a trajectory.
        const anchor = followTime < sampleTime && deps.resolveCharacterPositionAtTime
          ? deps.resolveCharacterPositionAtTime(activeFollow.characterId, followTime, activeFollow.part ?? 'center')
          : deps.resolveCharacterPosition?.(activeFollow.characterId, activeFollow.part ?? 'center') ?? null;
        if (anchor) {
          const target = { x: anchor.x + activeFollow.offset.x, y: anchor.y + activeFollow.offset.y };
          const startAnchor = deps.resolveCharacterPositionAtTime?.(activeFollow.characterId, start, activeFollow.part ?? 'center') ?? anchor;
          const startTarget = { x: startAnchor.x + activeFollow.offset.x, y: startAnchor.y + activeFollow.offset.y };
          const weight = cameraFollowWeight(activeFollow.smoothing ?? FOLLOW_DEFAULT_SMOOTHING, Math.max(0, followTime - start));
          channels.x = target.x + (channels.x - startTarget.x) * weight;
          channels.y = target.y + (channels.y - startTarget.y) * weight;
          composedFollowFrame = { x: channels.x, y: channels.y };
        } else composedFollowFrame = null;
      }
      continue;
    }

    if (action.action === 'cameraUnfollow') {
      follow = null;
      continue;
    }

    if (action.action === 'cameraReset') {
      follow = null;
      composedFollowFrame = null;
      if (deps.compiledChannelOwnership) {
        const startState = inheritStartCoverage(yield eventIndex);
        channels.x = startState.position.x;
        channels.y = startState.position.y;
        channels.zoom = startState.zoom;
        channels.rotation = startState.rotation;
      }
      applyCameraReset(channels, coverage, action.params ?? {}, start, sampleTime);
      continue;
    }

    if (action.action === 'cameraMotion') {
      if (deps.compiledChannelOwnership) {
        const params = action.params ?? {};
        const writesX = compiledMotionWritesX(params);
        const writesY = compiledMotionWritesY(params);
        const writesZoom = compiledMotionWritesZoom(params);
        const writesRotation = compiledMotionWritesRotation(params);
        if (writesX || writesY || writesRotation || (writesZoom && !deps.resolveZoomAtTime)) {
          const startState = inheritStartCoverage(yield eventIndex);
          if (writesX) channels.x = startState.position.x;
          if (writesY) channels.y = startState.position.y;
          if (writesZoom && !deps.resolveZoomAtTime) channels.zoom = startState.zoom;
          if (writesRotation) channels.rotation = startState.rotation;
        }
        if (writesZoom && deps.resolveZoomAtTime) channels.zoom = deps.resolveZoomAtTime(start, action);
      }
      if (deps.compiledChannelOwnership && compiledMotionWritesPosition(action.params ?? {})) {
        follow = null;
        composedFollowFrame = null;
      }
      applyCameraMotion(channels, coverage, action.params ?? {}, start, sampleTime, deps);
      continue;
    }

    if (action.action === 'cameraPath') {
      if (deps.compiledChannelOwnership) {
        const params = action.params ?? {};
        const writesPosition = compiledPathWritesProperty(params, 'position');
        const writesZoom = compiledPathWritesProperty(params, 'zoom');
        const writesRotation = compiledPathWritesProperty(params, 'rotation');
        if (writesPosition || writesRotation || (writesZoom && !deps.resolveZoomAtTime)) {
          const startState = inheritStartCoverage(yield eventIndex);
          if (writesPosition) {
            channels.x = startState.position.x;
            channels.y = startState.position.y;
          }
          if (writesZoom && !deps.resolveZoomAtTime) channels.zoom = startState.zoom;
          if (writesRotation) channels.rotation = startState.rotation;
        }
        if (writesZoom && deps.resolveZoomAtTime) channels.zoom = deps.resolveZoomAtTime(start, action);
      }
      if (deps.compiledChannelOwnership && compiledPathWritesPosition(action.params ?? {})) {
        follow = null;
        composedFollowFrame = null;
      }
      applyCameraPath(channels, coverage, action.params ?? {}, start, sampleTime);
      continue;
    }

  }

  if (follow) {
    // Follow still owns the position channel at the query time: re-assert the
    // composed framing so the returned state tracks the deterministic anchor
    // even when no cameraFollow event sits exactly at/before `time` after a
    // release was filtered out. The transient-aware frame composed during
    // event processing wins; fall back to the raw anchor write-through only
    // when that composition could not resolve an anchor.
    if (composedFollowFrame) {
      channels.x = composedFollowFrame.x;
      channels.y = composedFollowFrame.y;
    } else {
      const anchor = deps.resolveCharacterPosition?.(follow.characterId, follow.part ?? 'center') ?? null;
      if (anchor) {
        channels.x = anchor.x + follow.offset.x;
        channels.y = anchor.y + follow.offset.y;
      }
    }
  }

  const resolved: ResolvedCameraState = {
    position: { x: channels.x, y: channels.y },
    zoom: channels.zoom,
    rotation: channels.rotation,
    follow,
    coverage,
  };
  return resolved;
}

function compiledMotionWritesX(params: Record<string, unknown>): boolean {
  const marked = compiledMotionProperty(params, 'position');
  if (marked !== undefined) return marked;
  const focus = params.focus && typeof params.focus === 'object' && !Array.isArray(params.focus)
    ? params.focus as Record<string, unknown>
    : {};
  return typeof focus.character === 'string'
    || params.target !== undefined
    || params.to !== undefined
    || params.position !== undefined
    || focus.point !== undefined
    || params.move === 'pan'
    || params.move === 'push'
    || params.move === 'pull'
    || params.move === 'zoom';
}

function compiledMotionWritesY(params: Record<string, unknown>): boolean {
  const marked = compiledMotionProperty(params, 'position');
  if (marked !== undefined) return marked;
  const focus = params.focus && typeof params.focus === 'object' && !Array.isArray(params.focus)
    ? params.focus as Record<string, unknown>
    : {};
  if (typeof focus.character === 'string'
    || params.target !== undefined
    || params.to !== undefined
    || params.position !== undefined
    || focus.point !== undefined) return true;
  if (params.move === 'tilt' || params.move === 'push' || params.move === 'pull' || params.move === 'zoom') return true;
  if (params.move === 'pan') return typeof params.strength !== 'number';
  return false;
}

function compiledMotionWritesPosition(params: Record<string, unknown>): boolean {
  return compiledMotionWritesX(params) || compiledMotionWritesY(params);
}

function compiledMotionWritesZoom(params: Record<string, unknown>): boolean {
  const marked = compiledMotionProperty(params, 'zoom');
  if (marked !== undefined) return marked;
  return params.zoom !== undefined || params.move === 'zoom' || params.move === 'push' || params.move === 'pull';
}

function compiledMotionWritesRotation(params: Record<string, unknown>): boolean {
  const marked = compiledMotionProperty(params, 'rotation');
  if (marked !== undefined) return marked;
  return typeof params.angle === 'number' || typeof params.rotation === 'number' || params.move === 'rotate';
}

function compiledMotionProperty(params: Record<string, unknown>, property: 'position' | 'zoom' | 'rotation'): boolean | undefined {
  if (!Array.isArray(params._cameraProperties)) return undefined;
  return params._cameraProperties.includes(property);
}

function compiledPathWritesPosition(params: Record<string, unknown>): boolean {
  return compiledPathWritesProperty(params, 'position');
}

function compiledPathWritesProperty(params: Record<string, unknown>, property: 'position' | 'zoom' | 'rotation'): boolean {
  if (!Array.isArray(params.keyframes)) return false;
  return params.keyframes.some((value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    return (value as Record<string, unknown>)[property] !== undefined;
  });
}

/**
 * Apply one `cameraReset` segment: interpolates all channels from their pre-reset
 * state toward the stage baseline over the authored duration and easing.
 */
function applyCameraReset(
  channels: MotionChannels,
  coverage: CameraChannelCoverage,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Camera statements remain extensible at this runtime boundary.
  params: Record<string, any>,
  start: number,
  time: number,
): void {
  coverage.position = true;
  coverage.zoom = true;
  coverage.rotation = true;

  const rawDuration = params.duration ?? params.durationSeconds;
  const duration = typeof rawDuration === 'number' && rawDuration >= 0 ? rawDuration : 1;
  const progress = duration === 0 ? 1 : Math.max(0, Math.min(1, (time - start) / duration));

  const from: MotionChannels = { ...channels };
  const ease = typeof params.ease === 'string'
    ? params.ease
    : typeof params.easing === 'string'
      ? params.easing
      : 'power3.inOut';

  const eased = evaluateCharacterEase(ease, progress, 'power3.inOut');

  channels.x = from.x + (STAGE_DEFAULT_CAMERA_POSITION.x - from.x) * eased;
  channels.y = from.y + (STAGE_DEFAULT_CAMERA_POSITION.y - from.y) * eased;
  channels.zoom = from.zoom + (STAGE_DEFAULT_CAMERA_ZOOM - from.zoom) * eased;
  channels.rotation = from.rotation + (STAGE_DEFAULT_CAMERA_ROTATION - from.rotation) * eased;
}

/**
 * Apply one `cameraMotion` segment. Events before the query time latch their
 * end values; the active segment interpolates from the channel state captured
 * at its own start (canonical statement-order semantics).
 */
function applyCameraMotion(
  channels: MotionChannels,
  coverage: CameraChannelCoverage,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Camera statements remain extensible at this runtime boundary.
  params: Record<string, any>,
  start: number,
  time: number,
  deps: CameraStateResolverDeps,
): void {
  if (deps.compiledChannelOwnership) {
    applyCompiledCameraMotion(channels, coverage, params, start, time, deps);
    return;
  }
  const duration = typeof params.duration === 'number' && params.duration > 0 ? params.duration : 1;
  const progress = Math.max(0, Math.min(1, (time - start) / duration));
  if (progress <= 0 && !(start === time)) return;

  const from: MotionChannels = { ...channels };
  const ease = typeof params.easing === 'string' ? params.easing : 'smooth';
  const lerp = (key: keyof MotionChannels, to: number) => {
    channels[key] = from[key] + (to - from[key]) * evaluateCharacterEase(ease, progress, 'power2.inOut');
  };

  // Character focus is independent of zoom. Preserve the same authored offsets as moveTo().
  const resolveFocusAnchor = (characterId: string): CameraPosition | null =>
    deps.resolveFocusPosition
      ? deps.resolveFocusPosition(characterId, start, focusPart)
      : deps.resolveCharacterPositionAtTime
        ? deps.resolveCharacterPositionAtTime(characterId, start, focusPart)
        : deps.resolveCharacterPosition?.(characterId, focusPart) ?? null;
  const anchorTarget = (raw: CameraPosition | null, isCharacterAnchored: boolean): CameraPosition | null => {
    if (!raw || !isCharacterAnchored) return raw;
    return {
      x: raw.x + (params.focus?.offsetX ?? 0),
      y: raw.y + (params.focus?.offsetY ?? 0),
    };
  };
  const focusPart = params.focus?.part || params.targetPart || DEFAULT_CAMERA_FOCUS_PART;

  switch (params.move) {
    case 'pan': {
      const focusCharacter = params.characterId ?? params.focus?.character;
      const target = focusCharacter
        ? anchorTarget(resolveFocusAnchor(focusCharacter), true)
        : resolvePanTarget(params, from, deps);
      if (target) {
        lerp('x', target.x);
        lerp('y', target.y);
        coverage.position = true;
      }
      break;
    }
    case 'push':
    case 'pull': {
      // moveTo() family: simultaneous position + zoom toward a subject.
      const fallbackPoint = params.move === 'push' ? { x: 0.5, y: 0.4 } : { x: 0.5, y: 0.5 };
      const focusCharacter = params.characterId ?? params.focus?.character;
      const rawTarget = focusCharacter
        ? resolveFocusAnchor(focusCharacter)
        : normalizePoint(params.focus?.point ?? params.target ?? fallbackPoint);
      const target = anchorTarget(rawTarget, Boolean(focusCharacter));
      if (target) {
        lerp('x', target.x);
        lerp('y', target.y);
        coverage.position = true;
      }
      const rawZoom = params.zoom !== undefined ? params.zoom : (params.move === 'push' ? '+=0.3' : '-=0.3');
      const zoomTo = resolveZoomValue(rawZoom, from.zoom);
      if (zoomTo !== undefined) {
        lerp('zoom', zoomTo);
        coverage.zoom = true;
      }
      break;
    }
    case 'zoom':
    case 'tilt':
    case 'rotate': {
      // Channel-scoped moves. `zoom`/`rotate` still tween position toward a
      // subject/point when one is addressable (moveTo() semantics); `tilt`
      // only ever touches the y channel.
      const focusCharacter = params.characterId ?? params.focus?.character;
      const rawAnchor = focusCharacter
        ? resolveFocusAnchor(focusCharacter)
        : params.move === 'zoom'
          ? normalizePoint(params.focus?.point ?? params.target ?? params.position ?? { x: 0.5, y: 0.5 }) // moveTo() fallback point
          : params.focus?.point !== undefined || params.target !== undefined || params.position !== undefined
            ? normalizePoint(params.focus?.point ?? params.target ?? params.position)
            : null;
      const anchor = anchorTarget(rawAnchor, Boolean(focusCharacter));
      if (params.move !== 'tilt' && anchor) {
        lerp('x', anchor.x);
        lerp('y', anchor.y);
        coverage.position = true;
      }
      if (params.move === 'tilt') {
        const toY = typeof params.toY === 'number'
          ? params.toY
          : typeof params.strength === 'number'
            ? from.y + params.strength
            : 0.7;
        lerp('y', toY);
        coverage.position = true;
      }
      if (params.move === 'zoom') {
        const rawZoom = params.zoom !== undefined ? params.zoom : 1.5;
        const zoomTo = resolveZoomValue(rawZoom, from.zoom);
        if (zoomTo !== undefined) {
          lerp('zoom', zoomTo);
          coverage.zoom = true;
        }
      }
      if (params.move === 'rotate') {
        const directionSign = params.direction === 'ccw' ? -1 : 1;
        const totalAngle = typeof params.rotations === 'number'
          ? params.rotations * 360 * directionSign
          : typeof params.angle === 'number'
            ? params.angle
            : 12;
        lerp('rotation', totalAngle);
        coverage.rotation = true;
        if (params.zoomEnd !== undefined) {
          const zoomToEnd = resolveZoomValue(params.zoomEnd, from.zoom);
          if (zoomToEnd !== undefined) {
            lerp('zoom', zoomToEnd);
            coverage.zoom = true;
          }
        }
      }
      // pan-style cross writes: optional zoom/angle riding on a tilt segment.
      if (params.move === 'tilt') {
        if (params.zoom !== undefined) {
          const zoomTo = resolveZoomValue(params.zoom, from.zoom);
          if (zoomTo !== undefined) {
            lerp('zoom', zoomTo);
            coverage.zoom = true;
          }
        }
        if (params.angle !== undefined) {
          lerp('rotation', params.angle);
          coverage.rotation = true;
        }
      }
      break;
    }
    default:
      break;
  }
}

/** Camera actions lowered from semantic property tracks use independent writes. */
function applyCompiledCameraMotion(
  channels: MotionChannels,
  coverage: CameraChannelCoverage,
  params: Record<string, unknown>,
  start: number,
  time: number,
  deps: CameraStateResolverDeps,
): void {
  const duration = typeof params.duration === 'number' && params.duration >= 0 ? params.duration : 1;
  const progress = duration === 0 ? 1 : Math.max(0, Math.min(1, (time - start) / duration));
  if (time < start) return;
  const ease = typeof params.easing === 'string' ? params.easing : 'smooth';
  const weight = evaluateCharacterEase(ease, progress, 'power2.inOut');
  const focus = params.focus && typeof params.focus === 'object' && !Array.isArray(params.focus)
    ? params.focus as Record<string, unknown>
    : {};
  const legacyDefaults = !Array.isArray(params._cameraProperties);
  const characterId = typeof params.characterId === 'string'
    ? params.characterId
    : typeof focus.character === 'string' ? focus.character : undefined;
  const part = typeof focus.part === 'string'
    ? focus.part
    : typeof params.targetPart === 'string' ? params.targetPart : DEFAULT_CAMERA_FOCUS_PART;
  const legacyPositionDefault = legacyDefaults && !characterId
    ? params.move === 'push'
      ? { x: 0.5, y: 0.4 }
      : params.move === 'pull' || params.move === 'pan' || params.move === 'zoom'
        ? { x: 0.5, y: 0.5 }
        : undefined
    : undefined;
  const rawPosition = characterId
    ? undefined
    : params.target ?? params.to ?? params.position ?? focus.point ?? legacyPositionDefault;
  const point = rawPosition === undefined ? null : normalizePoint(rawPosition);
  const anchor = characterId
    ? deps.resolveFocusPosition
      ? deps.resolveFocusPosition(characterId, start, part)
      : deps.resolveCharacterPositionAtTime
        ? deps.resolveCharacterPositionAtTime(characterId, start, part)
        : deps.resolveCharacterPosition?.(characterId, part) ?? null
    : null;
  const positionTarget = anchor
    ? { x: anchor.x + (Number(focus.offsetX) || 0), y: anchor.y + (Number(focus.offsetY) || 0) }
    : characterId ? null : point;

  if (params.move === 'tilt' && compiledMotionWritesY(params)) {
    const targetY = typeof params.toY === 'number'
      ? params.toY
      : typeof params.strength === 'number' ? channels.y + params.strength : legacyDefaults ? 0.7 : undefined;
    if (targetY !== undefined) {
      channels.y += (targetY - channels.y) * weight;
      coverage.position = true;
    }
  } else if (params.move === 'pan' && !characterId && typeof params.strength === 'number' && compiledMotionWritesX(params)) {
    channels.x += params.strength * weight;
    coverage.position = true;
  } else if (characterId || point) {
    if (positionTarget) {
      const writesX = compiledMotionWritesX(params);
      const writesY = compiledMotionWritesY(params);
      if (writesX) channels.x += (positionTarget.x - channels.x) * weight;
      if (writesY) channels.y += (positionTarget.y - channels.y) * weight;
      if (writesX || writesY) coverage.position = true;
    }
  }

  const legacyZoomDefault = legacyDefaults
    ? params.move === 'zoom' ? 1.5 : params.move === 'push' ? '+=0.3' : params.move === 'pull' ? '-=0.3' : undefined
    : undefined;
  const rawZoom = params.zoom ?? legacyZoomDefault;
  if (compiledMotionWritesZoom(params) && rawZoom !== undefined) {
    const zoomTo = resolveZoomValue(rawZoom, channels.zoom);
    if (zoomTo !== undefined) {
      channels.zoom += (zoomTo - channels.zoom) * weight;
      coverage.zoom = true;
    }
  }
  let rotation = typeof params.angle === 'number'
    ? params.angle
    : typeof params.rotation === 'number' ? params.rotation : undefined;
  if (rotation === undefined && legacyDefaults && params.move === 'rotate') {
    const direction = params.direction === 'ccw' ? -1 : 1;
    rotation = typeof params.rotations === 'number'
      ? params.rotations * 360 * direction
      : 12 * direction;
  }
  if (compiledMotionWritesRotation(params) && rotation !== undefined) {
    channels.rotation += (rotation - channels.rotation) * weight;
    coverage.rotation = true;
  }
}

/**
 * Evaluate a camera path: keyframes are relative to the action start, each
 * segment animates only the fields its keyframe defines, and per-keyframe
 * eases mirror createPath(). Values latch after the final keyframe.
 */
function applyCameraPath(
  channels: MotionChannels,
  coverage: CameraChannelCoverage,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Legacy camera paths remain extensible at this runtime boundary.
  params: Record<string, any>,
  start: number,
  time: number,
): void {
  createPreparedCameraPath(params)(channels, coverage, start, time);
}

type PreparedCameraPathKeyframe = Record<string, unknown> & { readonly time: number };

function createPreparedCameraPath(
  params: Readonly<Record<string, unknown>>,
): (channels: MotionChannels, coverage: CameraChannelCoverage, start: number, time: number) => void {
  const raw = Array.isArray(params.keyframes) ? params.keyframes : [];
  const keyframes = raw
    .filter((value: unknown): value is PreparedCameraPathKeyframe => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const keyframe = value as Record<string, unknown>;
      return typeof keyframe.time === 'number' && Number.isFinite(keyframe.time);
    })
    .sort((left, right) => left.time - right.time);
  const positionTrack = keyframes.filter((keyframe) => keyframe.position !== undefined);
  const zoomTrack = keyframes.filter((keyframe) => Number.isFinite(keyframe.zoom));
  const rotationTrack = keyframes.filter((keyframe) => Number.isFinite(keyframe.rotation));
  const writesPosition = positionTrack.length > 0;
  const writesZoom = zoomTrack.length > 0;
  const writesRotation = rotationTrack.length > 0;

  return (channels, coverage, start, time) => {
    if (keyframes.length === 0) return;

    if (writesPosition) coverage.position = true;
    if (writesZoom) coverage.zoom = true;
    if (writesRotation) coverage.rotation = true;

    let local = time - start;
      const duration = keyframes[keyframes.length - 1].time;
    if (duration > 0) {
      const repeatValue = params.repeat;
      const infinite = params.loop === true || repeatValue === -1;
      const repeatCount = typeof repeatValue === 'number' && Number.isInteger(repeatValue) && repeatValue > 0
        ? repeatValue
        : 0;
      const plays = infinite ? Infinity : repeatCount + 1;
      if (local >= duration && (infinite || local < duration * plays)) {
        const cycle = Math.floor(local / duration);
        local %= duration;
        if (params.yoyo === true && cycle % 2 === 1) local = duration - local;
      } else if (!infinite && local >= duration * plays) {
        local = params.yoyo === true && plays % 2 === 0 ? 0 : duration;
      }
    }

    const sampleProperty = (
      property: 'position' | 'zoom' | 'rotation',
      track: readonly PreparedCameraPathKeyframe[],
      initial: number | CameraPosition,
    ): number | CameraPosition => {
      let value = initial;
      let previousTime = 0;
      for (const keyframe of track) {
        const keyTime = keyframe.time;
        const rawTarget = property === 'position' ? normalizePoint(keyframe.position) : Number(keyframe[property]);
        if (rawTarget === null || (typeof rawTarget === 'number' && !Number.isFinite(rawTarget))) continue;
        if (local >= keyTime) {
          value = rawTarget;
          previousTime = keyTime;
          continue;
        }
        if (keyTime > previousTime) {
          const progress = Math.max(0, Math.min(1, (local - previousTime) / (keyTime - previousTime)));
          const ease = typeof keyframe.ease === 'string'
            ? keyframe.ease
            : typeof params.ease === 'string' ? params.ease : 'power2.inOut';
          const weight = evaluateCharacterEase(ease, progress, 'power2.inOut');
          if (typeof value === 'number' && typeof rawTarget === 'number') {
            return value + (rawTarget - value) * weight;
          }
          if (typeof value !== 'number' && typeof rawTarget !== 'number') {
            return {
              x: value.x + (rawTarget.x - value.x) * weight,
              y: value.y + (rawTarget.y - value.y) * weight,
            };
          }
        }
        break;
      }
      return value;
    };

    const position = sampleProperty('position', positionTrack, { x: channels.x, y: channels.y });
    if (typeof position !== 'number') {
      channels.x = position.x;
      channels.y = position.y;
    }
    const zoom = sampleProperty('zoom', zoomTrack, channels.zoom);
    if (typeof zoom === 'number') channels.zoom = zoom;
    const rotation = sampleProperty('rotation', rotationTrack, channels.rotation);
    if (typeof rotation === 'number') channels.rotation = rotation;
  };
}

function normalizePoint(value: unknown): CameraPosition | null {
  const point = resolveVec2(value as import('../api/types/common').Vec2 | undefined);
  return Number.isFinite(point?.x) && Number.isFinite(point?.y) ? { x: point.x, y: point.y } : null;
}

/**
 * Resolve authored zoom values the way GSAP would at render time: numbers are
 * absolute; `+=`/`-=` strings resolve against the channel value captured at
 * the segment start (canonical statement-order semantics).
 */
export function resolveZoomValue(raw: unknown, currentZoom: number): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith('+=') || trimmed.startsWith('-=')) {
    const delta = Number.parseFloat(trimmed.slice(2));
    if (!Number.isFinite(delta)) return undefined;
    return trimmed.startsWith('+=') ? currentZoom + delta : currentZoom - delta;
  }
  const absolute = Number.parseFloat(trimmed);
  return Number.isFinite(absolute) ? absolute : undefined;
}

function resolvePanTarget(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Legacy camera motion parameters remain extensible at this runtime boundary.
  params: Record<string, any>,
  from: MotionChannels,
  _deps: CameraStateResolverDeps,
): CameraPosition | null {
  if (params.to !== undefined || params.focus?.point !== undefined || params.target !== undefined) {
    const point = resolveVec2(params.to ?? params.focus?.point ?? params.target);
    return { x: point.x, y: point.y };
  }
  if (typeof params.strength === 'number') {
    return { x: from.x + params.strength, y: from.y };
  }
  // Handler default: a pan with no target recenters the position channel.
  return { x: STAGE_DEFAULT_CAMERA_POSITION.x, y: STAGE_DEFAULT_CAMERA_POSITION.y };
}

function normalizeOffset(offset: unknown): CameraPosition {
  if (Array.isArray(offset) && offset.length >= 2 && Number.isFinite(offset[0]) && Number.isFinite(offset[1])) {
    return { x: offset[0], y: offset[1] };
  }
  if (offset && typeof offset === 'object' && Number.isFinite((offset as CameraPosition).x) && Number.isFinite((offset as CameraPosition).y)) {
    return { x: (offset as CameraPosition).x, y: (offset as CameraPosition).y };
  }
  return { x: 0, y: 0 };
}
