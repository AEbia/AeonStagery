import { live2DManager } from '../Live2DManager';
import { animationDirector } from '../AnimationDirector';
import { resolveVec2 } from '../utils/math';
import { getLogger } from '../Logger';
import type { SchedulerContext } from './types';

const logger = getLogger('AddCharacterAction');

export function scheduleAddCharacter(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl, resolvePath, resolvePathAsync, transformationProxies } = ctx;
  const { time, params } = action;
  const t = time || 0;

  // A missing or unresolvable model resource is a SCRIPT-level defect (an empty
  // path the prepared scene unwrapped from an unavailable reference). Mirror the
  // seek-time Maginot line: leave the character off stage instead of throwing.
  // A throw here surfaces inside a GSAP onStart callback as an unhandled
  // rejection and, via the collaboration apply path, would be misread as a sync
  // failure even though the connection and the rest of the scene are healthy.
  const model = typeof params.model === 'string' ? params.model.trim() : '';
  if (!model) {
    logger.warn(`Character "${params.id}" has no model resource; leaving it off stage. Choose a Live2D model to restore it.`);
    return;
  }

  const hasEntrance = params.enter !== 'none' && (
    (params.enter && params.enter !== 'none') ||
    params.duration !== undefined ||
    params.enterDuration !== undefined
  );
  const targetOpacity = params.opacity ?? 1;
  const initialOpacity = hasEntrance ? 0 : targetOpacity;
  const proxy = transformationProxies.get(params.id);

  if (proxy) {
    const initVals: any = {};
    if (params.position) {
      const pos = resolveVec2(params.position);
      initVals.x = pos.x * 1920; initVals.y = pos.y * 1080;
    }
    if (params.scale !== undefined) initVals.scale = params.scale;
    if (params.rotation !== undefined) initVals.rotation = params.rotation;
    initVals.opacity = hasEntrance ? 0 : targetOpacity;
    if (params.z !== undefined) initVals.z = params.z;
    
    // Use tl.set to ensure GSAP registers these values even when seek() suppresses events
    tl.set(proxy, initVals, t);
  }

  const at = (fn: () => any) => { tl.to({}, { duration: 0.001, onStart: () => { fn(); } }, t); };

  at(async () => {
    const nextModelPath = resolvePathAsync ? await resolvePathAsync(params.model) : resolvePath(params.model);
    const currentEntry = live2DManager.getAllCharacters().get(params.id);
    if (currentEntry) {
      if (currentEntry.modelPath !== nextModelPath) {
        live2DManager.removeCharacter(params.id);
      } else {
        // If it's already loaded, ensure we apply the proxy transform immediately
        if (proxy) live2DManager.applyProxyTransform(params.id, proxy);
        return;
      }
    }

    await live2DManager.addCharacter(params.id, nextModelPath, {
      position: params.position, scale: params.scale, rotation: params.rotation,
      opacity: initialOpacity, flipX: params.flipX, zIndex: params.zIndex,
    });

    if (proxy) live2DManager.applyProxyTransform(params.id, proxy);
  });

  if (hasEntrance) {
    const proxy = transformationProxies.get(params.id);
    const dur = params.duration ?? params.enterDuration ?? 0.6;
    const preset = params.enter || 'fadeIn';
    const entranceTl = animationDirector.characterEnter(params.id, preset, dur, params.enterEase, proxy, targetOpacity);
    tl.add(entranceTl, t);
  }
}
