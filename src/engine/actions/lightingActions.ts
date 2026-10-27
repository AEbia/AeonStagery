import type { SchedulerContext } from './types';
import type { RuntimeActionContract } from './contracts';

function scheduleLightingMarker(
  tl: SchedulerContext['tl'],
  time: number | undefined,
  duration?: number,
): void {
  const at = time ?? 0;
  tl.call(() => {}, undefined, at);
  if (typeof duration === 'number' && duration > 0) {
    tl.to({}, { duration }, at);
  }
}

export function scheduleSetLighting(ctx: SchedulerContext, action: RuntimeActionContract<'setLighting'>): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleResetLighting(ctx: SchedulerContext, action: RuntimeActionContract<'resetLighting'>): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleSetBlur(ctx: SchedulerContext, action: RuntimeActionContract<'setBlur'>): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleResetBlur(ctx: SchedulerContext, action: RuntimeActionContract<'resetBlur'>): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleAddPointLight(ctx: SchedulerContext, action: RuntimeActionContract<'addPointLight'>): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleRemovePointLight(ctx: SchedulerContext, action: RuntimeActionContract<'removePointLight'>): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleClearPointLights(ctx: SchedulerContext, action: RuntimeActionContract<'clearPointLights'>): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleSetGodrays(ctx: SchedulerContext, action: RuntimeActionContract<'setGodrays'>): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleResetGodrays(ctx: SchedulerContext, action: RuntimeActionContract<'resetGodrays'>): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleSetPostProcessing(ctx: SchedulerContext, action: RuntimeActionContract<'setPostProcessing'>): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleResetPostProcessing(ctx: SchedulerContext, action: RuntimeActionContract<'resetPostProcessing'>): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleAddColorOverlay(ctx: SchedulerContext, action: RuntimeActionContract<'addColorOverlay'>): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleRemoveColorOverlay(ctx: SchedulerContext, action: RuntimeActionContract<'removeColorOverlay'>): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleClearColorOverlays(ctx: SchedulerContext, action: RuntimeActionContract<'clearColorOverlays'>): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}
