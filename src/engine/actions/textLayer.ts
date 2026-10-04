import { textLayerManager } from '../TextLayerManager';
import type { SchedulerContext } from './types';

export function scheduleAddTextLayer(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl } = ctx;
  const { time, params } = action;
  const t = time || 0;

  const id = params.id;
  if (!id) return;

  const textLayerTl = textLayerManager.addLayer(params as any);
  tl.add(textLayerTl, t);
}

export function scheduleRemoveTextLayer(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl } = ctx;
  const { time, params } = action;
  const t = time || 0;

  const id = params.id;
  if (!id) return;

  const removeTl = textLayerManager.removeLayer(id, params.duration);
  tl.add(removeTl, t);
}

export function scheduleTransformTextLayer(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl } = ctx;
  const { time, params } = action;
  const t = time || 0;

  const id = params.id;
  if (!id) return;

  const transformTl = textLayerManager.transformLayer(params as any);
  tl.add(transformTl, t);
}
