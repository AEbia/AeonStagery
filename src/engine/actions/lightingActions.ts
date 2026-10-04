import type { SchedulerContext } from './types';

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

export function scheduleSetLighting(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleResetLighting(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleSetBlur(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleResetBlur(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleAddPointLight(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleRemovePointLight(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleClearPointLights(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleSetGodrays(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleResetGodrays(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleSetPostProcessing(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleResetPostProcessing(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleAddColorOverlay(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleRemoveColorOverlay(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}

export function scheduleClearColorOverlays(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  scheduleLightingMarker(ctx.tl, action.time, action.params.duration);
}
