import { stageManager } from '../StageManager';
import { eventBus } from '../../api/events';
import type { SchedulerContext } from './types';

let imageActionErrorCounter = 0;

function reportImageActionError(id: string | undefined, file: string, error: unknown): void {
  const reporter = (stageManager as any).reportImageError;
  if (typeof reporter === 'function') {
    reporter.call(stageManager, id, file, error);
    return;
  }

  const detail = error instanceof Error ? error.message : String(error);
  void eventBus.emit('toast:show', {
    id: `image_action_${Date.now()}_${++imageActionErrorCounter}`,
    message: `Failed to resolve image asset "${file}": ${detail}. Choose an available image resource and retry.`,
    type: 'error',
  });
}

export function scheduleAddImage(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl } = ctx;
  const { time, params } = action;
  const t = time || 0;

  const file = typeof params.file === 'string' ? params.file.trim() : '';

  (stageManager as any).registerImageAction?.({
    id: params.id,
    file,
    position: params.position,
    scale: params.scale ?? 1,
    rotation: params.rotation ?? 0,
    opacity: params.opacity ?? 1,
    zIndex: params.zIndex ?? 10,
    z: params.z,
  });

  tl.to({}, {
    duration: 0.001,
    onStart: () => {
      if (!file) {
        if (params.id && typeof (stageManager as any).cancelImageRequest === 'function') {
          (stageManager as any).cancelImageRequest(params.id);
        }
        // Empty paths are script-authoring diagnostics. Playback keeps the
        // layer absent instead of turning an incomplete draft into a toast.
        return;
      }

      const requestVersion = params.id && typeof (stageManager as any).beginImageRequest === 'function'
        ? (stageManager as any).beginImageRequest(params.id, {
          file,
          position: params.position,
          scale: params.scale ?? 1,
          rotation: params.rotation ?? 0,
          opacity: params.opacity ?? 1,
          zIndex: params.zIndex ?? 10,
          z: params.z,
        })
        : undefined;

      const resolvedFile = Promise.resolve().then(() => (
        ctx.resolvePathAsync ? ctx.resolvePathAsync(file) : ctx.resolvePath(file)
      ));

      void resolvedFile
        .then((runtimeFile) => {
          const usableRuntimeFile = typeof runtimeFile === 'string' ? runtimeFile.trim() : '';
          if (!usableRuntimeFile) {
            throw new Error('The resolved image asset path is empty. Choose an available image resource and retry.');
          }
          const imageConfig = {
            id: params.id,
            file: usableRuntimeFile,
            position: params.position,
            scale: params.scale ?? 1,
            rotation: params.rotation ?? 0,
            opacity: params.opacity ?? 1,
            zIndex: params.zIndex ?? 10,
            duration: params.duration ?? 0,
            z: params.z,
          };
          if (requestVersion !== undefined) {
            stageManager.addImage(imageConfig, requestVersion);
          } else {
            stageManager.addImage(imageConfig);
          }
        })
        .catch((error) => {
          if (params.id && requestVersion !== undefined && typeof (stageManager as any).cancelImageRequest === 'function') {
            (stageManager as any).cancelImageRequest(params.id, requestVersion);
          }
          reportImageActionError(params.id, file, error);
          console.error(`[ImageAction] Failed to resolve image asset "${file}":`, error);
        });
    },
  }, t);
}

export function scheduleTransformImage(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl } = ctx;
  const { time, params } = action;
  const t = time || 0;

  if (!params.id) return;

  tl.add(stageManager.transformImage({
    id: params.id,
    position: params.position,
    scale: params.scale,
    rotation: params.rotation,
    opacity: params.opacity,
    zIndex: params.zIndex,
    duration: params.duration ?? 0,
    ease: params.ease,
    z: params.z,
  }), t);
}

export function scheduleRemoveImage(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl } = ctx;
  const { time, params } = action;
  const t = time || 0;

  if (!params.id) return;

  tl.add(stageManager.removeImage(params.id, params.duration ?? 0, params.ease), t);
}
