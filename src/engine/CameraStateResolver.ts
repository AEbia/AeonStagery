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

export interface CameraPosition {
  x: number;
  y: number;
}

export interface ActiveFollowResolution {
  characterId: string;
  offset: CameraPosition;
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
  /** Evaluate writes by their compiled property values, not legacy move labels. */
  compiledChannelOwnership?: boolean;
}

export const STAGE_DEFAULT_CAMERA_POSITION: CameraPosition = { x: 0.5, y: 0.5 };
export const STAGE_DEFAULT_CAMERA_ZOOM = 1;
export const STAGE_DEFAULT_CAMERA_ROTATION = 0;
/**
 * Must match CameraController.follow()'s built-in default — playback glides
 * into a follow with alpha = 1 − smoothing^(60·dt) per frame, and seek
 * reconstruction mirrors that exponential pursuit deterministically.
 */
export const FOLLOW_DEFAULT_SMOOTHING = 0.85;

/** Continuous rate of tickFollow()'s discrete pursuit: λ = −60·ln(smoothing). */
function followTransientWeight(smoothing: number, elapsedSeconds: number): number {
  if (elapsedSeconds <= 0) return 1;
  const k = Math.min(Math.max(smoothing, 0.0001), 0.9999);
  const lambda = -60 * Math.log(k);
  return Math.exp(-lambda * elapsedSeconds);
}

/**
 * When playback would stop tracking (authored duration end or a release
 * action), the ticker stops and the camera latches its current glide frame.
 */
function findFollowReleaseInstant(timeline: readonly RuntimeTimelineAction[], afterStart: number): number {
  let release = Infinity;
  for (const action of timeline) {
    if (action.action !== 'cameraUnfollow' && action.action !== 'cameraReset') continue;
    const time = action.time ?? 0;
    if (time > afterStart && time < release) release = time;
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

interface MotionChannels extends CameraPosition { zoom: number; rotation: number }

/**
 * Resolve the deterministic camera state at `time`.
 */
interface ResolverEvaluationContext {
  readonly actionIds: WeakMap<object, number>;
  readonly states: Map<string, ResolvedCameraState>;
  nextActionId: number;
}

export function computeCameraStateAtTime(
  timeline: readonly RuntimeTimelineAction[],
  time: number,
  deps: CameraStateResolverDeps = {},
): ResolvedCameraState {
  const evaluationDeps: CameraStateResolverDeps = deps.compiledChannelOwnership === undefined
    ? { ...deps, compiledChannelOwnership: true }
    : deps;
  const context: ResolverEvaluationContext = { actionIds: new WeakMap(), states: new Map(), nextActionId: 0 };
  return computeCameraStateAtTimeInternal(timeline, time, evaluationDeps, context);
}

function computeCameraStateAtTimeInternal(
  timeline: readonly RuntimeTimelineAction[],
  time: number,
  deps: CameraStateResolverDeps,
  context: ResolverEvaluationContext,
): ResolvedCameraState {
  const timelineKey = timeline.map((action) => {
    let id = context.actionIds.get(action);
    if (id === undefined) {
      id = context.nextActionId++;
      context.actionIds.set(action, id);
    }
    return id;
  }).join(',');
  const cacheKey = `${time}|${timelineKey}`;
  const cached = context.states.get(cacheKey);
  if (cached) return cached;

  const channels: MotionChannels = {
    x: STAGE_DEFAULT_CAMERA_POSITION.x,
    y: STAGE_DEFAULT_CAMERA_POSITION.y,
    zoom: STAGE_DEFAULT_CAMERA_ZOOM,
    rotation: STAGE_DEFAULT_CAMERA_ROTATION,
  };

  let follow: ActiveFollowResolution | null = null;
  let composedFollowFrame: CameraPosition | null = null;
  const coverage: CameraChannelCoverage = { position: false, zoom: false, rotation: false };

  const orderedEvents = toOrderedEvents(timeline, time);
  for (const [eventIndex, event] of orderedEvents.entries()) {
    const { action, time: start } = event;
    const sampleTime = time;
    if (deps.compiledChannelOwnership && action.action === 'cameraFollow') {
      const startState = computeCameraStateAtTimeInternal(orderedEvents.slice(0, eventIndex).map(({ action: previous }) => previous), start, deps, context);
      channels.x = startState.position.x;
      channels.y = startState.position.y;
    }
    if (action.action === 'cameraFollow') {
      const params = action.params ?? {};
      if (!params.characterId) continue;
      const duration = typeof params.duration === 'number' && params.duration > 0 ? params.duration : Infinity;
      follow = sampleTime <= start + duration
        ? {
            characterId: params.characterId,
            offset: normalizeOffset(params.offset),
            smoothing: typeof params.smoothing === 'number' ? params.smoothing : undefined,
          }
        : null;
      coverage.position = true;
      if (follow) {
        // Active follow: mirror tickFollow()'s exponential entry glide so a
        // seek into the transition presents the intermediate frame instead of
        // the settled anchor. The transient decays from the pre-follow channel
        // state toward the tracked anchor, measured against the anchor as it
        // was at the follow start.
        const liveAnchor = deps.resolveCharacterPosition?.(follow.characterId) ?? null;
        const releaseAt = Math.min(duration === Infinity ? Infinity : start + duration, findFollowReleaseInstant(timeline, start));
        const anchor = (releaseAt < sampleTime && deps.resolveCharacterPositionAtTime)
          ? deps.resolveCharacterPositionAtTime(follow.characterId, releaseAt) ?? liveAnchor
          : liveAnchor;
        if (anchor) {
          const startAnchor = deps.resolveCharacterPositionAtTime?.(follow.characterId, start) ?? anchor;
          const smoothing = follow.smoothing ?? FOLLOW_DEFAULT_SMOOTHING;
          const elapsed = Math.max(0, Math.min(sampleTime, releaseAt) - start);
          const weight = followTransientWeight(smoothing, elapsed);
          const target = clampPointIntoViewport({ x: anchor.x + follow.offset.x, y: anchor.y + follow.offset.y }, channels.zoom);
          const startTarget = clampPointIntoViewport({ x: startAnchor.x + follow.offset.x, y: startAnchor.y + follow.offset.y }, channels.zoom);
          // Only the targets are viewport-clamped (like tickFollow()); the
          // gliding position itself may sit outside the clamp range mid-entry,
          // so the composed transient must not be re-clamped.
          channels.x = target.x + (channels.x - startTarget.x) * weight;
          channels.y = target.y + (channels.y - startTarget.y) * weight;
          composedFollowFrame = { x: channels.x, y: channels.y };
        } else {
          composedFollowFrame = null;
        }
      } else if (duration !== Infinity) {
        // Duration-expired follow: playback's auto-unfollow latches the last
        // tracked glide frame — write that through so release semantics match
        // the explicit-unfollow path instead of reverting to pre-follow values.
        const liveAnchor = deps.resolveCharacterPosition?.(params.characterId) ?? null;
        const releaseAt = Math.min(start + duration, findFollowReleaseInstant(timeline, start));
        const anchor = (releaseAt < time && deps.resolveCharacterPositionAtTime)
          ? deps.resolveCharacterPositionAtTime(params.characterId, releaseAt) ?? liveAnchor
          : liveAnchor;
        if (anchor) {
          const startAnchor = deps.resolveCharacterPositionAtTime?.(params.characterId, start) ?? anchor;
          const smoothing = typeof params.smoothing === 'number' ? params.smoothing : FOLLOW_DEFAULT_SMOOTHING;
          const elapsed = Math.max(0, releaseAt - start);
          const weight = followTransientWeight(smoothing, elapsed);
          const offset = normalizeOffset(params.offset);
          const target = clampPointIntoViewport({ x: anchor.x + offset.x, y: anchor.y + offset.y }, channels.zoom);
          const startTarget = clampPointIntoViewport({ x: startAnchor.x + offset.x, y: startAnchor.y + offset.y }, channels.zoom);
          channels.x = target.x + (channels.x - startTarget.x) * weight;
          channels.y = target.y + (channels.y - startTarget.y) * weight;
        }
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
        const startState = computeCameraStateAtTimeInternal(orderedEvents.slice(0, eventIndex).map(({ action: previous }) => previous), start, deps, context);
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
        const startState = computeCameraStateAtTimeInternal(orderedEvents.slice(0, eventIndex).map(({ action: previous }) => previous), start, deps, context);
        if (compiledMotionWritesX(action.params ?? {})) channels.x = startState.position.x;
        if (compiledMotionWritesY(action.params ?? {})) channels.y = startState.position.y;
        if (compiledMotionWritesZoom(action.params ?? {})) channels.zoom = startState.zoom;
        if (compiledMotionWritesRotation(action.params ?? {})) channels.rotation = startState.rotation;
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
        const startState = computeCameraStateAtTimeInternal(orderedEvents.slice(0, eventIndex).map(({ action: previous }) => previous), start, deps, context);
        if (compiledPathWritesProperty(action.params ?? {}, 'position')) {
          channels.x = startState.position.x;
          channels.y = startState.position.y;
        }
        if (compiledPathWritesProperty(action.params ?? {}, 'zoom')) channels.zoom = startState.zoom;
        if (compiledPathWritesProperty(action.params ?? {}, 'rotation')) channels.rotation = startState.rotation;
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
      const anchor = deps.resolveCharacterPosition?.(follow.characterId) ?? null;
      if (anchor) {
        channels.x = anchor.x + follow.offset.x;
        channels.y = anchor.y + follow.offset.y;
        clampPositionIntoViewport(channels);
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
  context.states.set(cacheKey, resolved);
  return resolved;
}

function compiledMotionWritesX(params: Record<string, unknown>): boolean {
  const focus = params.focus && typeof params.focus === 'object' && !Array.isArray(params.focus)
    ? params.focus as Record<string, unknown>
    : {};
  return typeof focus.character === 'string'
    || params.target !== undefined
    || params.to !== undefined
    || params.position !== undefined
    || focus.point !== undefined
    || (params.move === 'pan' && typeof params.strength === 'number');
}

function compiledMotionWritesY(params: Record<string, unknown>): boolean {
  const focus = params.focus && typeof params.focus === 'object' && !Array.isArray(params.focus)
    ? params.focus as Record<string, unknown>
    : {};
  return typeof focus.character === 'string'
    || params.target !== undefined
    || params.to !== undefined
    || params.position !== undefined
    || focus.point !== undefined
    || (params.move === 'tilt' && (typeof params.toY === 'number' || typeof params.strength === 'number'));
}

function compiledMotionWritesPosition(params: Record<string, unknown>): boolean {
  return compiledMotionWritesX(params) || compiledMotionWritesY(params);
}

function compiledMotionWritesZoom(params: Record<string, unknown>): boolean {
  return params.zoom !== undefined;
}

function compiledMotionWritesRotation(params: Record<string, unknown>): boolean {
  return typeof params.angle === 'number' || typeof params.rotation === 'number';
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

  // Character focus is independent of zoom: only follow/dolly constrain
  // framing to the viewport. Preserve the same authored offsets as moveTo().
  const resolveFocusAnchor = (characterId: string): CameraPosition | null =>
    deps.resolveCharacterPositionAtTime
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
  const characterId = typeof focus.character === 'string' ? focus.character : undefined;
  const part = typeof focus.part === 'string' ? focus.part : DEFAULT_CAMERA_FOCUS_PART;
  const rawPosition = params.target ?? params.to ?? params.position ?? focus.point;
  const point = rawPosition === undefined ? null : normalizePoint(rawPosition);
  const anchor = characterId
    ? deps.resolveCharacterPositionAtTime
      ? deps.resolveCharacterPositionAtTime(characterId, start, part)
      : deps.resolveCharacterPosition?.(characterId, part) ?? null
    : null;
  const positionTarget = anchor
    ? { x: anchor.x + (Number(focus.offsetX) || 0), y: anchor.y + (Number(focus.offsetY) || 0) }
    : point;

  if (params.move === 'tilt') {
    const targetY = typeof params.toY === 'number'
      ? params.toY
      : typeof params.strength === 'number' ? channels.y + params.strength : undefined;
    if (targetY !== undefined) {
      channels.y += (targetY - channels.y) * weight;
      coverage.position = true;
    }
  } else if (params.move === 'pan' && typeof params.strength === 'number') {
    channels.x += params.strength * weight;
    coverage.position = true;
  } else if (characterId || point) {
    if (positionTarget) {
      if (compiledMotionWritesX(params)) channels.x += (positionTarget.x - channels.x) * weight;
      if (compiledMotionWritesY(params)) channels.y += (positionTarget.y - channels.y) * weight;
      coverage.position = true;
    }
  }

  if (params.zoom !== undefined) {
    const zoomTo = resolveZoomValue(params.zoom, channels.zoom);
    if (zoomTo !== undefined) {
      channels.zoom += (zoomTo - channels.zoom) * weight;
      coverage.zoom = true;
    }
  }
  const rotation = typeof params.angle === 'number'
    ? params.angle
    : typeof params.rotation === 'number' ? params.rotation : undefined;
  if (rotation !== undefined) {
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
  params: Record<string, any>,
  start: number,
  time: number,
): void {
  const raw = Array.isArray(params.keyframes) ? params.keyframes : [];
  const keyframes = raw
    .filter((kf: any) => kf && Number.isFinite(kf.time))
    .sort((a: any, b: any) => a.time - b.time) as Array<Record<string, any>>;
  if (keyframes.length === 0) return;

  if (keyframes.some((kf) => kf.position !== undefined)) coverage.position = true;
  if (keyframes.some((kf) => kf.zoom !== undefined)) coverage.zoom = true;
  if (keyframes.some((kf) => kf.rotation !== undefined)) coverage.rotation = true;

  let local = time - start;
  const duration = Number(keyframes[keyframes.length - 1].time);
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
    initial: number | CameraPosition,
  ): number | CameraPosition => {
    const track = keyframes.filter((keyframe) => {
      if (property === 'position') return keyframe.position !== undefined;
      return Number.isFinite(keyframe[property]);
    });
    let value = initial;
    let previousTime = 0;
    for (const keyframe of track) {
      const keyTime = Number(keyframe.time);
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

  const position = sampleProperty('position', { x: channels.x, y: channels.y });
  if (typeof position !== 'number') {
    channels.x = position.x;
    channels.y = position.y;
  }
  const zoom = sampleProperty('zoom', channels.zoom);
  if (typeof zoom === 'number') channels.zoom = zoom;
  const rotation = sampleProperty('rotation', channels.rotation);
  if (typeof rotation === 'number') channels.rotation = rotation;
}

function normalizePoint(value: unknown): CameraPosition | null {  const point = resolveVec2(value as any);
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

/** Same viewport clamp as tickFollow(): tracking never reveals black edges. */
function clampPositionIntoViewport(channels: MotionChannels): void {
  const clamped = clampPointIntoViewport({ x: channels.x, y: channels.y }, channels.zoom);
  channels.x = clamped.x;
  channels.y = clamped.y;
}

function clampPointIntoViewport(point: CameraPosition, zoom: number): CameraPosition {
  const safeZoom = zoom > 0 ? zoom : 1;
  const halfView = 0.5 / safeZoom;
  return {
    x: Math.max(halfView, Math.min(point.x, 1 - halfView)),
    y: Math.max(halfView, Math.min(point.y, 1 - halfView)),
  };
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
