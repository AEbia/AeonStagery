import { resolveVec2 } from '../utils/math';
import { DEFAULT_CHARACTER_TRANSFORM_EASE, normalizeCharacterEase } from '../CharacterAnimationContract';
import type { SchedulerContext } from './types';

export function scheduleMoveCharacter(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl, transformationProxies } = ctx;
  const { time, params } = action;
  const t = time || 0;

  const proxy = transformationProxies.get(params.id);
  if (proxy) {
    const anim: any = {
      duration: params.duration ?? 1,
      ease: normalizeCharacterEase(params.ease, DEFAULT_CHARACTER_TRANSFORM_EASE),
    };
    if (params.position) {
      const pos = resolveVec2(params.position);
      anim.x = pos.x * 1920; anim.y = pos.y * 1080;
    }
    if (params.scale !== undefined) anim.scale = params.scale;
    if (params.rotation !== undefined) anim.rotation = params.rotation;
    if (params.opacity !== undefined) anim.opacity = params.opacity;
    if (params.z !== undefined) anim.z = params.z;
    tl.to(proxy, anim, t);
  }
}
