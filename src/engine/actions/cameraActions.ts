import gsap from 'gsap';
import { cameraController } from '../CameraController';
import { hookSystem } from '../../api/hooks';
import type { SchedulerContext } from './types';
import type { CameraMotionConfig } from '../../api/types/camera';
import type { RuntimeTimelineAction } from '../RuntimeTimelineScene';

/** Keep scene timing and hooks without allocating a second camera writer. */
function scheduleEvaluatedCamera(ctx: SchedulerContext, action: RuntimeTimelineAction): boolean {
  if (!ctx.cameraStateDriven) return false;
  const { params } = action;
  const isPath = action.action === 'cameraPath';
  const isFollowStateChange = action.action === 'cameraFollow' || action.action === 'cameraUnfollow';
  let duration = isFollowStateChange ? 0 : typeof params.duration === 'number' ? params.duration
    : typeof params.durationSeconds === 'number' ? params.durationSeconds : isPath ? 0 : 1;
  if (isPath && Array.isArray(params.keyframes)) {
    const keyframes: readonly { time?: number }[] = params.keyframes;
    const period = keyframes.reduce((end, frame) => Math.max(end, frame.time ?? 0), 0);
    const repeats = typeof params.repeat === 'number' && params.repeat >= 0 ? params.repeat : 0;
    duration = Math.max(duration, period * (params.loop === true ? 1 : repeats + 1));
  }
  const segment = gsap.timeline();
  if (action.action !== 'cameraReset' && action.action !== 'cameraUnfollow') {
    segment.call(() => hookSystem.execute('camera:move', action.action === 'cameraPath'
      ? { type: 'path', keyframes: params.keyframes, config: params }
      : { type: 'motion', config: action.action === 'cameraFollow' ? { ...params, move: 'follow' } : params }), undefined, 0);
  }
  segment.to({}, { duration: Math.max(0, duration) }, 0);
  ctx.tl.add(segment, action.time ?? 0);
  return true;
}

// ── Backward-compat: route cameraFollow through executeMotion ──

export function scheduleCameraFollow(ctx: SchedulerContext, action: RuntimeTimelineAction): void {
  if (scheduleEvaluatedCamera(ctx, action)) return;
  const { tl } = ctx;
  const { time, params } = action;

  const config: CameraMotionConfig = {
    move: 'follow',
    easing: 'linear',
    duration: 0,
    characterId: params.characterId,
    offset: params.offset,
    smoothing: params.smoothing,
  };

  const camTl = cameraController.executeMotion(config);
  tl.add(camTl, time);
}

export function scheduleCameraPath(ctx: SchedulerContext, action: RuntimeTimelineAction): void {
  if (scheduleEvaluatedCamera(ctx, action)) return;
  const { tl } = ctx;
  const { time, params } = action;
  const camTl = cameraController.createPath(params.keyframes, { defaultEase: params.ease, loop: params.loop, repeat: params.repeat, yoyo: params.yoyo });
  tl.add(camTl, time);
}

export function scheduleCameraShake(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl } = ctx;
  const { time, params } = action;
  // Keep timing on the master timeline; the engine samples additive shake
  // envelopes from scene time so seek/reset never destroys scheduled effects.
  const camTl = gsap.timeline();
  camTl.call(() => hookSystem.execute('camera:shake', params), undefined, 0);
  camTl.to({}, { duration: params.duration ?? 0.5 }, 0);
  tl.add(camTl, time);
}

// Releasing a follow only stops position tracking — never a full camera reset.
export function scheduleCameraUnfollow(ctx: SchedulerContext, action: RuntimeTimelineAction): void {
  if (scheduleEvaluatedCamera(ctx, action)) return;
  const { tl } = ctx;
  const { time } = action;
  const camTl = cameraController.stopFollow();
  tl.add(camTl, time);
}

export function scheduleCameraReset(ctx: SchedulerContext, action: RuntimeTimelineAction): void {
  if (scheduleEvaluatedCamera(ctx, action)) return;
  const { tl } = ctx;
  const { time, params } = action;
  const duration = typeof params.duration === 'number'
    ? params.duration
    : typeof params.durationSeconds === 'number'
      ? params.durationSeconds
      : 1;
  const ease = params.ease ?? params.easing;
  const camTl = cameraController.reset(duration, ease);
  tl.add(camTl, time);
}

export function scheduleCameraHitchcock(ctx: SchedulerContext, action: RuntimeTimelineAction): void {
  if (scheduleEvaluatedCamera(ctx, action)) return;
  const { tl } = ctx;
  const { time, params } = action;
  const camTl = cameraController.hitchcockZoom(params as any);
  tl.add(camTl, time);
}

export function scheduleCameraMotion(ctx: SchedulerContext, action: RuntimeTimelineAction): void {
  if (scheduleEvaluatedCamera(ctx, action)) return;
  const { tl } = ctx;
  const { time, params } = action;
  const camTl = cameraController.executeMotion(params as CameraMotionConfig);
  tl.add(camTl, time);
}
