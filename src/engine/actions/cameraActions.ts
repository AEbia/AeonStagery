import gsap from 'gsap';
import { cameraController } from '../CameraController';
import { hookSystem } from '../../api/hooks';
import type { SchedulerContext } from './types';
import type { RuntimeActionType } from '../../api/types/semantic-scene';
import type { CameraHitchcockConfig, CameraMotionConfig } from '../../api/types/camera';
import type { RuntimeActionContract } from './contracts';

type CameraActionName =
  | 'cameraFollow'
  | 'cameraPath'
  | 'cameraShake'
  | 'cameraUnfollow'
  | 'cameraReset'
  | 'cameraHitchcock'
  | 'cameraMotion';

type RuntimeCameraActionInput<Action extends CameraActionName> =
  Omit<RuntimeActionContract<Action>, 'action'> & { readonly action?: RuntimeActionType };

interface CameraEvaluationAction {
  readonly time?: number;
  readonly params: Readonly<Record<string, unknown>>;
}

/** Keep scene timing and hooks without allocating a second camera writer. */
function scheduleEvaluatedCamera(
  ctx: SchedulerContext,
  action: CameraEvaluationAction,
  actionName: CameraActionName,
): boolean {
  if (!ctx.cameraStateDriven) return false;
  const { params } = action;
  const isPath = actionName === 'cameraPath';
  const isFollowStateChange = actionName === 'cameraFollow' || actionName === 'cameraUnfollow';
  let duration = isFollowStateChange ? 0 : typeof params.duration === 'number' ? params.duration
    : typeof params.durationSeconds === 'number' ? params.durationSeconds : isPath ? 0 : 1;
  if (isPath && Array.isArray(params.keyframes)) {
    const keyframes = params.keyframes as readonly { time?: number }[];
    const period = keyframes.reduce((end, frame) => Math.max(end, frame.time ?? 0), 0);
    const repeats = typeof params.repeat === 'number' && params.repeat >= 0 ? params.repeat : 0;
    duration = Math.max(duration, period * (params.loop === true ? 1 : repeats + 1));
  }
  const segment = gsap.timeline();
  if (actionName !== 'cameraReset' && actionName !== 'cameraUnfollow') {
    segment.call(() => hookSystem.execute('camera:move', actionName === 'cameraPath'
      ? { type: 'path', keyframes: params.keyframes, config: params }
      : { type: 'motion', config: actionName === 'cameraFollow' ? { ...params, move: 'follow' } : params }), undefined, 0);
  }
  segment.to({}, { duration: Math.max(0, duration) }, 0);
  ctx.tl.add(segment, action.time ?? 0);
  return true;
}

// ── Backward-compat: route cameraFollow through executeMotion ──

export function scheduleCameraFollow(ctx: SchedulerContext, action: RuntimeCameraActionInput<'cameraFollow'>): void {
  if (scheduleEvaluatedCamera(ctx, action, 'cameraFollow')) return;
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

export function scheduleCameraPath(ctx: SchedulerContext, action: RuntimeCameraActionInput<'cameraPath'>): void {
  if (scheduleEvaluatedCamera(ctx, action, 'cameraPath')) return;
  const { tl } = ctx;
  const { time, params } = action;
  const camTl = cameraController.createPath(params.keyframes, { defaultEase: params.ease, loop: params.loop, repeat: params.repeat, yoyo: params.yoyo });
  tl.add(camTl, time);
}

export function scheduleCameraShake(ctx: SchedulerContext, action: RuntimeCameraActionInput<'cameraShake'>): void {
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
export function scheduleCameraUnfollow(ctx: SchedulerContext, action: RuntimeCameraActionInput<'cameraUnfollow'>): void {
  if (scheduleEvaluatedCamera(ctx, action, 'cameraUnfollow')) return;
  const { tl } = ctx;
  const { time } = action;
  const camTl = cameraController.stopFollow();
  tl.add(camTl, time);
}

export function scheduleCameraReset(ctx: SchedulerContext, action: RuntimeCameraActionInput<'cameraReset'>): void {
  if (scheduleEvaluatedCamera(ctx, action, 'cameraReset')) return;
  const { tl } = ctx;
  const { time, params } = action;
  const duration = typeof params.duration === 'number'
    ? params.duration
    : typeof params.durationSeconds === 'number'
      ? params.durationSeconds
      : 1;
  const ease = typeof params.ease === 'string' ? params.ease : params.easing;
  const camTl = cameraController.reset(duration, ease);
  tl.add(camTl, time);
}

export function scheduleCameraHitchcock(ctx: SchedulerContext, action: RuntimeCameraActionInput<'cameraHitchcock'>): void {
  if (scheduleEvaluatedCamera(ctx, action, 'cameraHitchcock')) return;
  const { tl } = ctx;
  const { time, params } = action;
  const camTl = cameraController.hitchcockZoom(params as CameraHitchcockConfig);
  tl.add(camTl, time);
}

export function scheduleCameraMotion(ctx: SchedulerContext, action: RuntimeCameraActionInput<'cameraMotion'>): void {
  if (scheduleEvaluatedCamera(ctx, action, 'cameraMotion')) return;
  const { tl } = ctx;
  const { time, params } = action;
  const camTl = cameraController.executeMotion(params as CameraMotionConfig);
  tl.add(camTl, time);
}
