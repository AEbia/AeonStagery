import { customAnimHost } from '../CustomAnimHost';
import { eventBus } from '../../api/events';
import { getLogger } from '../Logger';
import type { SchedulerContext } from './types';

const logger = getLogger('CustomAnimationAction');
let customAnimationErrorCounter = 0;

function reportCustomAnimationError(file: unknown, error: unknown): void {
  const asset = typeof file === 'string' && file.trim() ? file.trim() : '(empty path)';
  const detail = error instanceof Error ? error.message : String(error);
  const message = `Failed to play custom animation asset "${asset}": ${detail}. Choose an available animation resource and retry.`;
  logger.error(message, error);
  void eventBus.emit('toast:show', {
    id: `custom_animation_${Date.now()}_${++customAnimationErrorCounter}`,
    message,
    type: 'error',
  });
}

export function schedulePlayCustomAnimation(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl, isReconstructing, resolvePath, resolvePathAsync } = ctx;
  const { time, params } = action;
  const t = time || 0;

  const at = (fn: () => void | Promise<void>) => {
    tl.to({}, {
      duration: 0.001,
      onStart: () => {
        // GSAP does not await async callbacks.  Start the work through a
        // promise chain so not-ready/error/clear rejections are reported
        // through the existing logger/toast seam instead of becoming global
        // unhandled rejections.
        void Promise.resolve().then(fn).catch((error) => {
          reportCustomAnimationError(params.file, error);
        });
      },
    }, t);
  };

  at(async () => {
    if (isReconstructing()) return;
    if (typeof params.file !== 'string' || !params.file.trim()) {
      // Unavailable degraded resource: skip the layer (validation diagnostics
      // report it); playback and export continue over the gap.
      return;
    }
    const path = resolvePathAsync ? await resolvePathAsync(params.file) : resolvePath(params.file);
    if (!path || !path.trim()) return;
    await customAnimHost.playAnimation(path, params.duration ?? 5, params.layer ?? 'overlay');
  });
}
