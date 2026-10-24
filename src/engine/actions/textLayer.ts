import { textLayerManager } from '../TextLayerManager';
import type { TextLayerConfig, TextLayerTransformConfig } from '../../api/types/textLayer';
import type { SchedulerContext } from './types';
import type { RuntimeActionContract } from './contracts';

export function scheduleAddTextLayer(ctx: SchedulerContext, action: RuntimeActionContract<'addTextLayer'>): void {
  const { tl } = ctx;
  const { time, params } = action;
  const t = time || 0;

  const id = params.id;
  if (!id) return;

  const config: TextLayerConfig = { ...params, id, text: params.text ?? '' };
  const textLayerTl = textLayerManager.addLayer(config);
  tl.add(textLayerTl, t);
}

export function scheduleRemoveTextLayer(ctx: SchedulerContext, action: RuntimeActionContract<'removeTextLayer'>): void {
  const { tl } = ctx;
  const { time, params } = action;
  const t = time || 0;

  const id = params.id;
  if (!id) return;

  const removeTl = textLayerManager.removeLayer(id, params.duration);
  tl.add(removeTl, t);
}

export function scheduleTransformTextLayer(ctx: SchedulerContext, action: RuntimeActionContract<'transformTextLayer'>): void {
  const { tl } = ctx;
  const { time, params } = action;
  const t = time || 0;

  const id = params.id;
  if (!id) return;

  // Text transform duration is optional in historical compiled actions; keep
  // the original value so GSAP can apply its normal omitted-duration default.
  const transformTl = textLayerManager.transformLayer(params as TextLayerTransformConfig);
  tl.add(transformTl, t);
}
