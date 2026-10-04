import { cameraController } from '../CameraController';
import type { SchedulerContext } from './types';
import type { CameraMotionConfig } from '../../api/types/camera';

// ── Backward-compat: route cameraFollow through executeMotion ──

export function scheduleCameraFollow(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl } = ctx;
  const { time, params } = action;

  // Legacy actions may carry an authored duration. Honor it so GSAP-driven
  // playback stops at the same moment CameraCoordinator's seek reconciliation
  // (params.duration) does — one lifetime, two paths.
  const authoredDuration =
    typeof params.duration === 'number' && params.duration > 0 ? params.duration : undefined;

  const config: CameraMotionConfig = {
    move: 'follow',
    easing: 'linear',
    duration: authoredDuration ?? 999, // indefinite
    characterId: params.characterId,
    offset: params.offset,
    smoothing: params.smoothing,
    autoUnfollow: authoredDuration !== undefined,
  };

  const camTl = cameraController.executeMotion(config);
  tl.add(camTl, time);
}

export function scheduleCameraPath(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl } = ctx;
  const { time, params } = action;
  const camTl = cameraController.createPath(params.keyframes, { defaultEase: params.ease, loop: params.loop, repeat: params.repeat, yoyo: params.yoyo });
  tl.add(camTl, time);
}

export function scheduleCameraShake(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl } = ctx;
  const { time, params } = action;
  const camTl = cameraController.shake(params);
  tl.add(camTl, time);
}

// Releasing a follow only stops position tracking — never a full camera reset.
export function scheduleCameraUnfollow(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl } = ctx;
  const { time } = action;
  const camTl = cameraController.stopFollow();
  tl.add(camTl, time);
}

export function scheduleCameraReset(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
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

export function scheduleCameraHitchcock(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl } = ctx;
  const { time, params } = action;
  const camTl = cameraController.hitchcockZoom(params as any);
  tl.add(camTl, time);
}

export function scheduleCameraMotion(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl } = ctx;
  const { time, params } = action;
  const camTl = cameraController.executeMotion(params as any);
  tl.add(camTl, time);
}
