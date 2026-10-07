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
  resolveCharacterPositionAtTime?: (characterId: string, time: number) => CameraPosition | null;
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
  return timeline
    .map((action, index) => ({ action, index, time: action.time ?? 0 }))
    .filter((event) => event.time <= time)
    .sort((a, b) => a.time - b.time || a.index - b.index);
}

interface MotionChannels extends CameraPosition { zoom: number; rotation: number }

/**
 * Resolve the deterministic camera state at `time`.
 */
export function computeCameraStateAtTime(
  timeline: readonly RuntimeTimelineAction[],
  time: number,
  deps: CameraStateResolverDeps = {},
): ResolvedCameraState {
  const channels: MotionChannels = {
    x: STAGE_DEFAULT_CAMERA_POSITION.x,
    y: STAGE_DEFAULT_CAMERA_POSITION.y,
    zoom: STAGE_DEFAULT_CAMERA_ZOOM,
    rotation: STAGE_DEFAULT_CAMERA_ROTATION,
  };

  let follow: ActiveFollowResolution | null = null;
  let composedFollowFrame: CameraPosition | null = null;
  const coverage: CameraChannelCoverage = { position: false, zoom: false, rotation: false };

  for (const { action, time: start } of toOrderedEvents(timeline, time)) {
    if (action.action === 'cameraFollow') {
      const params = action.params ?? {};
      if (!params.characterId) continue;
      const duration = typeof params.duration === 'number' && params.duration > 0 ? params.duration : Infinity;
      follow = time <= start + duration
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
        const anchor = (releaseAt < time && deps.resolveCharacterPositionAtTime)
          ? deps.resolveCharacterPositionAtTime(follow.characterId, releaseAt) ?? liveAnchor
          : liveAnchor;
        if (anchor) {
          const startAnchor = deps.resolveCharacterPositionAtTime?.(follow.characterId, start) ?? anchor;
          const smoothing = follow.smoothing ?? FOLLOW_DEFAULT_SMOOTHING;
          const elapsed = Math.max(0, Math.min(time, releaseAt) - start);
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
      applyCameraReset(channels, coverage, action.params ?? {}, start, time);
      continue;
    }

    if (action.action === 'cameraMotion') {
      applyCameraMotion(channels, coverage, action.params ?? {}, start, time, deps);
      continue;
    }

    if (action.action === 'cameraPath') {
      applyCameraPath(channels, coverage, action.params ?? {}, start, time);
      continue;
    }

    if (action.action === 'cameraHitchcock') {
      applyCameraHitchcock(channels, coverage, action.params ?? {}, start, time, deps);
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

  return {
    position: { x: channels.x, y: channels.y },
    zoom: channels.zoom,
    rotation: channels.rotation,
    follow,
    coverage,
  };
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
  const duration = typeof params.duration === 'number' && params.duration > 0 ? params.duration : 1;
  const progress = Math.max(0, Math.min(1, (time - start) / duration));
  if (progress <= 0 && !(start === time)) return;

  const from: MotionChannels = { ...channels };
  const ease = typeof params.easing === 'string' ? params.easing : 'smooth';
  const lerp = (key: keyof MotionChannels, to: number) => {
    channels[key] = from[key] + (to - from[key]) * evaluateCharacterEase(ease, progress, 'power2.inOut');
  };

  // moveTo() clamps character-anchored positions into the viewport using the
  // segment's zoom intent (falling back to the channel zoom at segment start)
  // — the resolver must mirror that capture-time clamp or scrubbed seeks
  // frame differently from playback.
  const characterAnchorClampZoom = (): number =>
    resolveZoomValue(params.zoom ?? params.zoomEnd, from.zoom) ?? from.zoom;
  const anchorTarget = (raw: CameraPosition | null, isCharacterAnchored: boolean): CameraPosition | null => {
    if (!raw) return null;
    if (!isCharacterAnchored) return raw;
    return clampPointIntoViewport(raw, characterAnchorClampZoom());
  };
  const focusPart = params.focus?.part || params.targetPart || DEFAULT_CAMERA_FOCUS_PART;

  switch (params.move) {
    case 'pan': {
      const focusCharacter = params.characterId ?? params.focus?.character;
      const target = focusCharacter
        ? anchorTarget(deps.resolveCharacterPosition?.(focusCharacter, focusPart) ?? null, true)
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
        ? deps.resolveCharacterPosition?.(focusCharacter, focusPart) ?? null
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
        ? deps.resolveCharacterPosition?.(focusCharacter, focusPart) ?? null
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

  const local = time - start;
  const setFields = (target: MotionChannels, kf: Record<string, any>) => {
    const point = kf.position !== undefined ? normalizePoint(kf.position) : null;
    if (point) { target.x = point.x; target.y = point.y; }
    if (Number.isFinite(kf.zoom)) target.zoom = kf.zoom;
    if (Number.isFinite(kf.rotation)) target.rotation = kf.rotation;
  };

  const current: MotionChannels = { x: channels.x, y: channels.y, zoom: channels.zoom, rotation: channels.rotation };
  setFields(current, keyframes[0]);

  let prevTime = Number(keyframes[0].time);
  for (let i = 1; i < keyframes.length; i++) {
    const kf = keyframes[i];
    const segmentEnd = Number(kf.time);
    if (local >= segmentEnd) {
      setFields(current, kf);
      prevTime = segmentEnd;
      continue;
    }
    if (local > prevTime) {
      // Active segment: defined fields ease from the carried values.
      const progress = (local - prevTime) / Math.max(0.000001, segmentEnd - prevTime);
      const from: MotionChannels = { ...current };
      const ease = typeof kf.ease === 'string'
        ? kf.ease
        : typeof params.ease === 'string' ? params.ease : 'power2.inOut';
      const point = kf.position !== undefined ? normalizePoint(kf.position) : null;
      if (point) {
        current.x = from.x + (point.x - from.x) * evaluateCharacterEase(ease, progress, 'power2.inOut');
        current.y = from.y + (point.y - from.y) * evaluateCharacterEase(ease, progress, 'power2.inOut');
      }
      if (Number.isFinite(kf.zoom)) {
        current.zoom = from.zoom + (kf.zoom - from.zoom) * evaluateCharacterEase(ease, progress, 'power2.inOut');
      }
      if (Number.isFinite(kf.rotation)) {
        current.rotation = from.rotation + (kf.rotation - from.rotation) * evaluateCharacterEase(ease, progress, 'power2.inOut');
      }
    }
    break;
  }

  channels.x = current.x;
  channels.y = current.y;
  channels.zoom = current.zoom;
  channels.rotation = current.rotation;
}

/**
 * Hitchcock dolly zoom: zoom tweens zStart→zEnd while the position channel
 * keeps the focus part pinned to its screen point —
 *   S(t)·Z(t) = scaleStart·zoomStart (constant)
 *   y(t) = (Py − S(t)) + (0.5 − Sy) / Z(t)
 * mirroring CameraController.hitchcockZoom() with deterministic anchors.
 */
function applyCameraHitchcock(
  channels: MotionChannels,
  coverage: CameraChannelCoverage,
  params: Record<string, any>,
  start: number,
  time: number,
  deps: CameraStateResolverDeps,
): void {
  const duration = typeof params.duration === 'number' && params.duration > 0 ? params.duration : 2;
  const progress = Math.max(0, Math.min(1, (time - start) / duration));
  if (progress <= 0 && !(start === time)) return;

  const eased = evaluateCharacterEase(
    typeof params.easing === 'string' ? params.easing : 'smooth',
    progress,
    'power3.inOut',
  );

  const zoomStart = Number.isFinite(params.zoomStart) ? params.zoomStart : 1;
  const zoomEnd = Number.isFinite(params.zoomEnd) ? params.zoomEnd : 1.5;
  const zoom = zoomStart + (zoomEnd - zoomStart) * eased;

  const scaleStart = Number.isFinite(params.scaleStart) ? params.scaleStart : 1;
  const hitchcockConstant = scaleStart * zoomStart;
  const scale = zoom !== 0 ? hitchcockConstant / zoom : hitchcockConstant;
  const screenTarget = normalizePoint(params.screenTarget ?? { x: 0.5, y: 0.3 }) ?? { x: 0.5, y: 0.3 };

  const characterId = params.characterId ?? params.focus?.character;
  const headAnchor = characterId
    ? deps.resolveCharacterPosition?.(characterId, params.targetPart ?? DEFAULT_CAMERA_FOCUS_PART) ?? null
    : null;
  const bodyAnchor = characterId
    ? deps.resolveCharacterPosition?.(characterId) ?? null
    : null;
  // The handler falls back to Py = 1.0 when the model anchor is unavailable.
  const bodyY = bodyAnchor ? bodyAnchor.y : 1.0;

  let targetY = (bodyY - scale) + (0.5 - screenTarget.y) / zoom;
  let targetX = headAnchor ? headAnchor.x : channels.x;

  channels.zoom = zoom;
  coverage.zoom = true;
  coverage.position = true;

  const halfView = 0.5 / (zoom > 0 ? zoom : 1);
  targetX = Math.max(halfView, Math.min(targetX, 1 - halfView));
  targetY = Math.max(halfView, Math.min(targetY, 1 - halfView));
  channels.x = targetX;
  channels.y = targetY;
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

/** Same viewport clamp as tickFollow()/moveTo(): tracking never reveals black edges. */
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
