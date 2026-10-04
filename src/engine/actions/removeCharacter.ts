import { live2DManager } from '../Live2DManager';
import { animationDirector } from '../AnimationDirector';
import type { SchedulerContext } from './types';

export function scheduleRemoveCharacter(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl, isReconstructing, transformationProxies } = ctx;
  const { time, params } = action;
  const t = time || 0;

  const at = (fn: () => any) => { tl.to({}, { duration: 0.001, onStart: () => { fn(); } }, t); };

  if (params.exit && params.exit !== 'none') {
    const dur = params.duration ?? params.exitDuration ?? 0.6;
    const exitTimeline = animationDirector.characterExit(
      params.id,
      params.exit,
      dur,
      params.exitEase ?? 'power2.in',
      transformationProxies.get(params.id),
    );

    // The exit animation must be a child of ScriptEngine's master timeline.
    // Creating it from an onStart callback would detach it from pause/seek/export
    // and could remove the model before the visual transition completed.
    tl.add(exitTimeline, t);
    return;
  }

  at(() => {
    if (isReconstructing()) return;
    live2DManager.removeCharacter(params.id);
  });
}
