import { live2DManager } from '../Live2DManager';
import {
  resolveBlinkIntervalMilliseconds,
  resolveBlinkIntervalRangeMilliseconds,
} from '../RuntimeSceneState';
import { resolveLookAtFocus, type LookAtPointLookup } from '../lookAtFocus';
import type { CharacterMotionOutput } from '../../api/types/semantic-scene';
import type { SchedulerContext } from './types';

function resolveLookAtPointLookup(): LookAtPointLookup | undefined {
  return typeof live2DManager.getPoint === 'function'
    ? (id, part) => live2DManager.getPoint(id, part)
    : undefined;
}

export function scheduleCharacterLookAt(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl } = ctx;
  const { time, params } = action;
  const t = time || 0;

  const at = (fn: () => any) => { tl.to({}, { duration: 0.001, onStart: () => { fn(); } }, t); };
  at(() => {
    const [focusX, focusY] = resolveLookAtFocus(params, resolveLookAtPointLookup(), params.id);
    live2DManager.lookAt(params.id, focusX, focusY, params.duration ?? 0.5);
  });
}

export function scheduleCharacterBlink(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl } = ctx;
  const { time, params } = action;
  const t = time || 0;

  const at = (fn: () => any) => { tl.to({}, { duration: 0.001, onStart: () => { fn(); } }, t); };
  at(() => {
    const hasRange = typeof params.intervalRange === 'number' && Number.isFinite(params.intervalRange);
    if (hasRange) {
      live2DManager.setBlink(
        params.id,
        params.enabled ?? true,
        resolveBlinkIntervalMilliseconds(params),
        t,
        t,
        resolveBlinkIntervalRangeMilliseconds(params),
      );
    } else {
      live2DManager.setBlink(
        params.id,
        params.enabled ?? true,
        resolveBlinkIntervalMilliseconds(params),
      );
    }
  });
}

export function schedulePlayMotion(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl, isReconstructing, takeSnapshot } = ctx;
  const { time, params } = action;
  const t = time || 0;
  const id = resolveRequiredString(params.id);
  const customMotion = resolveCustomMotion(params.motion);
  const motionKey = resolveMotionKey(params.motion);
  if (!id || (!customMotion && !motionKey)) return;

  const at = (fn: () => any) => { tl.to({}, { duration: 0.001, onStart: () => { fn(); } }, t); };
  at(() => {
    if (isReconstructing()) return;
    const currentTime = tl.time();
    if (customMotion) {
      live2DManager.playCustomMotion(id, customMotion, currentTime);
    } else {
      live2DManager.playMotion(id, motionKey, params.priority ?? 3, Math.max(0, currentTime - t), currentTime);
    }
    takeSnapshot(currentTime);
  });
}

function resolveMotionKey(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    const candidate = value as { kind?: unknown; key?: unknown };
    if (candidate.kind === 'resource' && typeof candidate.key === 'string') return candidate.key;
    return '';
  }
  return '';
}

function resolveCustomMotion(value: unknown): Extract<CharacterMotionOutput, { kind: 'custom' }> | null {
  if (value && typeof value === 'object') {
    const candidate = value as { kind?: unknown };
    if (candidate.kind === 'custom') return value as Extract<CharacterMotionOutput, { kind: 'custom' }>;
  }
  return null;
}

function resolveRequiredString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : '';
}

export function scheduleSetExpression(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl, isReconstructing } = ctx;
  const { time, params } = action;
  const t = time || 0;
  const id = resolveRequiredString(params.id);
  if (!id) return;

  const at = (fn: () => any) => { tl.to({}, { duration: 0.001, onStart: () => { fn(); } }, t); };
  at(() => {
    if (isReconstructing()) return;
    live2DManager.setExpression(id, params.expression);
  });
}

export function scheduleSetCharacterRimLight(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl } = ctx;
  const { time, params } = action;
  const t = time || 0;

  const at = (fn: () => any) => { tl.to({}, { duration: 0.001, onStart: () => { fn(); } }, t); };
  at(() => { 
    if (params.mode === 'reset') {
      const baseline = ctx.getRimLightBaseline?.(params.id);
      if (baseline) {
        live2DManager.resetRimLight(params.id, params.duration ?? 0.4, baseline);
      } else {
        live2DManager.resetRimLight(params.id, params.duration ?? 0.4);
      }
      return;
    }

    live2DManager.setRimLight(
      params.id, 
      params.color ?? '#ffffff', 
      params.intensity ?? 1.0, 
      params.thickness ?? 10, 
      params.angle ?? 45, 
      params.softness ?? 2,
      params.duration ?? 0
    ); 
  });
}
