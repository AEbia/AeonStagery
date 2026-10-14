import { gsap } from 'gsap';
import type { Live2DFocusAnimationAction, Live2DFocusInput } from '../../runtime/Live2DRuntimeContracts';

/** SDK controllers remain private to the adapters. */
export interface RuntimeFocusController {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  vx?: number;
  vy?: number;
  faceX?: number;
  faceY?: number;
  faceTargetX?: number;
  faceTargetY?: number;
  _x?: number;
  _y?: number;
  _targetX?: number;
  _targetY?: number;
  update?: (deltaMs: number) => void;
  focus?: (x: number, y: number, instant?: boolean) => void;
}

const originalUpdates = new WeakMap<RuntimeFocusController, NonNullable<RuntimeFocusController['update']>>();

function restoreUpdate(controller: RuntimeFocusController): void {
  const update = originalUpdates.get(controller);
  if (update) {
    controller.update = update;
    originalUpdates.delete(controller);
  }
}

function writeFrame(controller: RuntimeFocusController, targetX: number, targetY: number, x: number, y: number): void {
  Object.assign(controller, {
    x, y, targetX, targetY, faceX: x, faceY: y,
    faceTargetX: targetX, faceTargetY: targetY,
    _x: x, _y: y, _targetX: targetX, _targetY: targetY, vx: 0, vy: 0,
  });
}

/** The timeline's duration and seek offset own interpolation instead of SDK inertia. */
export function applyRuntimeFocus(controller: RuntimeFocusController, input: Live2DFocusInput): void {
  gsap.killTweensOf(controller);
  restoreUpdate(controller);
  const targetX = Number.isFinite(input.focusX) ? input.focusX : 0;
  const targetY = Number.isFinite(input.focusY) ? input.focusY : 0;
  const duration = Number.isFinite(input.duration) ? Math.max(0, input.duration!) : 0.5;
  const options = input.options;
  const fromX = Number.isFinite(options?.fromX) ? options!.fromX! : Number.isFinite(controller.x) ? controller.x : 0;
  const fromY = Number.isFinite(options?.fromY) ? options!.fromY! : Number.isFinite(controller.y) ? controller.y : 0;
  const elapsed = Number.isFinite(options?.elapsed) ? Math.max(0, options!.elapsed!) : 0;
  const ease = options?.ease?.trim() || 'power1.out';
  const finish = () => {
    writeFrame(controller, targetX, targetY, targetX, targetY);
    restoreUpdate(controller);
  };
  if (duration === 0 || elapsed >= duration) {
    finish();
    controller.focus?.(targetX, targetY);
    return;
  }
  if (controller.update) {
    originalUpdates.set(controller, controller.update);
    controller.update = () => {};
  }
  const progress = Math.min(1, elapsed / duration);
  const weight = gsap.parseEase(ease)(progress);
  writeFrame(controller, targetX, targetY, fromX + (targetX - fromX) * weight, fromY + (targetY - fromY) * weight);
  controller.focus?.(targetX, targetY);
  gsap.to(controller, {
    x: targetX, y: targetY, duration: duration - elapsed,
    ease: progress > 0 ? 'none' : ease,
    onUpdate: () => writeFrame(controller, targetX, targetY, controller.x, controller.y),
    onComplete: finish, onInterrupt: finish,
  });
}

export function manageRuntimeFocusAnimations(controllers: readonly RuntimeFocusController[], action: Live2DFocusAnimationAction): void {
  for (const controller of controllers) {
    if (action === 'stop') {
      gsap.killTweensOf(controller);
      restoreUpdate(controller);
    } else {
      for (const tween of gsap.getTweensOf(controller)) {
        if (action === 'pause') tween.pause();
        else tween.resume();
      }
    }
  }
}
