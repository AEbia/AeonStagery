import { stageManager } from '../StageManager';
import type { SchedulerContext } from './types';
import type { RuntimeActionContract } from './contracts';

type ImageActionStagePort = Pick<
  typeof stageManager,
  'reportImageError' | 'registerImageAction' | 'beginImageRequest' | 'cancelImageRequest'
  | 'addImage' | 'transformImage' | 'removeImage'
>;

const imageActionStage: ImageActionStagePort = stageManager;

function reportImageActionError(id: string | undefined, file: string, error: unknown): void {
  imageActionStage.reportImageError(id, file, error);
}

export function scheduleAddImage(ctx: SchedulerContext, action: RuntimeActionContract<'addImage'>): void {
  const { tl } = ctx;
  const { time, params } = action;
  const t = time || 0;

  const file = typeof params.file === 'string' ? params.file.trim() : '';

  imageActionStage.registerImageAction({
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
        if (params.id) {
          imageActionStage.cancelImageRequest(params.id);
        }
        // Empty paths are script-authoring diagnostics. Playback keeps the
        // layer absent instead of turning an incomplete draft into a toast.
        return;
      }

      const requestVersion = params.id
        ? imageActionStage.beginImageRequest(params.id, {
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
            imageActionStage.addImage(imageConfig, requestVersion);
          } else {
            imageActionStage.addImage(imageConfig);
          }
        })
        .catch((error) => {
          if (params.id && requestVersion !== undefined) {
            imageActionStage.cancelImageRequest(params.id, requestVersion);
          }
          reportImageActionError(params.id, file, error);
          console.error(`[ImageAction] Failed to resolve image asset "${file}":`, error);
        });
    },
  }, t);
}

export function scheduleTransformImage(ctx: SchedulerContext, action: RuntimeActionContract<'transformImage'>): void {
  const { tl } = ctx;
  const { time, params } = action;
  const t = time || 0;

  if (!params.id) return;

  tl.add(imageActionStage.transformImage({
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

export function scheduleRemoveImage(ctx: SchedulerContext, action: RuntimeActionContract<'removeImage'>): void {
  const { tl } = ctx;
  const { time, params } = action;
  const t = time || 0;

  if (!params.id) return;

  tl.add(imageActionStage.removeImage(params.id, params.duration ?? 0, params.ease), t);
}
