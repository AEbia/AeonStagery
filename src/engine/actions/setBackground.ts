import { stageManager } from '../StageManager';
import { BACKGROUND_LAYER_ID } from '../environmentLayerModel';
import { eventBus } from '../../api/events';
import { getLogger } from '../Logger';
import type { SchedulerContext } from './types';

const logger = getLogger('EnvironmentLayerAction');
let environmentLayerErrorCounter = 0;

function reportEnvironmentLayerError(
  layerId: string,
  image: unknown,
  error: unknown,
  showToast = true,
): void {
  const asset = typeof image === 'string' && image.trim() ? image.trim() : '(empty path)';
  const detail = error instanceof Error ? error.message : String(error);
  const message = `Failed to set environment layer "${layerId}" image "${asset}": ${detail}. Choose an available image resource and retry.`;
  logger.error(message, error);
  if (!showToast) return;
  void eventBus.emit('toast:show', {
    id: `environment_layer_${Date.now()}_${++environmentLayerErrorCounter}`,
    message,
    type: 'error',
  });
}

function getEnvironmentProxy(ctx: SchedulerContext, layerId: string) {
  let proxy = ctx.environmentLayerProxies.get(layerId);
  if (!proxy) {
    proxy = layerId === BACKGROUND_LAYER_ID
      ? ctx.backgroundProxy
      : { ...ctx.backgroundProxy };
    ctx.environmentLayerProxies.set(layerId, proxy);
  }
  return proxy;
}

function animateEnvironmentProxy(
  ctx: SchedulerContext,
  layerId: string,
  time: number,
  params: Record<string, any>,
): void {
  const proxy = getEnvironmentProxy(ctx, layerId);
  const anim: any = { duration: params.duration ?? 1, ease: params.ease ?? 'power2.inOut' };
  if (params.x !== undefined) anim.x = params.x;
  if (params.y !== undefined) anim.y = params.y;
  if (params.scale !== undefined) anim.scale = params.scale;
  if (params.rotation !== undefined) anim.rotation = params.rotation;
  if (params.opacity !== undefined) anim.opacity = params.opacity;
  if (params.z !== undefined) anim.z = params.z;
  ctx.tl.to(proxy, anim, time);
}

function createResolvedEnvironmentTransform(proxy: Record<string, any>, params: Record<string, any>) {
  return {
    x: params.x ?? proxy.x,
    y: params.y ?? proxy.y,
    scale: params.scale ?? proxy.scale,
    rotation: params.rotation ?? proxy.rotation,
    opacity: params.opacity ?? proxy.opacity,
    z: params.z ?? proxy.z,
  };
}

export function scheduleSetEnvironmentLayer(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl, resolvePath, resolvePathAsync } = ctx;
  const { time, params } = action;
  const t = time || 0;
  const duration = params.duration ?? 1;
  const layerId = String(params.layerId || BACKGROUND_LAYER_ID);
  const proxy = getEnvironmentProxy(ctx, layerId);
  const initialTransform = createResolvedEnvironmentTransform(proxy, {});
  const targetTransform = createResolvedEnvironmentTransform(proxy, params);

  const at = (fn: () => void | Promise<void>) => {
    tl.to({}, {
      duration: 0.001,
      onStart: () => {
        void Promise.resolve().then(fn).catch((error) => {
          reportEnvironmentLayerError(layerId, params.image, error);
        });
      },
    }, t);
  };

  if (!ctx.environmentStateDriven) at(async () => {
    const image = typeof params.image === 'string' ? params.image.trim() : '';
    if (!image) {
      reportEnvironmentLayerError(
        layerId,
        params.image,
        new Error('No image path was provided before playback/export.'),
        false,
      );
      return;
    }
    const imagePath = resolvePathAsync ? await resolvePathAsync(image) : resolvePath(image);
    if (duration <= 0) {
      Object.assign(proxy, targetTransform);
    }
    await stageManager.setEnvironmentLayer(layerId, imagePath, {
      transition: params.transition,
      duration,
      layoutMode: params.layoutMode,
      tileScaleX: params.tileScaleX,
      tileScaleY: params.tileScaleY,
      tileOffsetX: params.tileOffsetX,
      tileOffsetY: params.tileOffsetY,
      ...initialTransform,
    });
  });

  if (duration > 0) {
    animateEnvironmentProxy(ctx, layerId, t, {
      ...params,
      ...targetTransform,
    });
  } else {
    Object.assign(proxy, targetTransform);
  }
}

export function scheduleTransformEnvironmentLayer(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { time, params } = action;
  const t = time || 0;
  animateEnvironmentProxy(ctx, String(params.layerId || BACKGROUND_LAYER_ID), t, params);
}

export function scheduleRemoveEnvironmentLayer(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  if (ctx.environmentStateDriven) return;
  const { tl } = ctx;
  const { time, params } = action;
  const t = time || 0;
  const layerId = String(params.layerId || BACKGROUND_LAYER_ID);
  const transition = params.transition ?? 'fadeOut';
  const duration = params.duration ?? 1;

  tl.to({}, {
    duration: 0.001,
    onStart: () => {
      stageManager.removeEnvironmentLayer(layerId, {
        transition,
        duration,
      });
    },
  }, t);
}
