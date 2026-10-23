import { STAGE_WIDTH, STAGE_HEIGHT } from '../StageDimensions';
import { resolveVec2 } from '../utils/math';
import { DEFAULT_CHARACTER_TRANSFORM_EASE, normalizeCharacterEase } from '../CharacterAnimationContract';
import type { SchedulerContext } from './types';
import type { RuntimeActionContract } from './contracts';

export function scheduleMoveCharacter(ctx: SchedulerContext, action: RuntimeActionContract<'transformCharacter'>): void {
  const { tl, transformationProxies } = ctx;
  const { time, params } = action;
  const t = time || 0;

  const proxy = transformationProxies.get(params.id);
  if (proxy) {
    const anim: gsap.TweenVars = {
      duration: params.duration ?? 1,
      ease: normalizeCharacterEase(params.ease, DEFAULT_CHARACTER_TRANSFORM_EASE),
    };
    if (params.position) {
      const pos = resolveVec2(params.position);
      anim.x = pos.x * STAGE_WIDTH; anim.y = pos.y * STAGE_HEIGHT;
    }
    if (params.scale !== undefined) anim.scale = params.scale;
    if (params.rotation !== undefined) anim.rotation = params.rotation;
    if (params.opacity !== undefined) anim.opacity = params.opacity;
    if (params.z !== undefined) anim.z = params.z;
    tl.to(proxy, anim, t);
  }
}
