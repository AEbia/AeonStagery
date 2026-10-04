import { describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';
import { actionSchedulers } from '../engine/actions';
import type { SchedulerContext, TransformationProxy } from '../engine/actions/types';

function createContext(proxy: TransformationProxy): SchedulerContext {
  return {
    tl: gsap.timeline({ paused: true }),
    resolvePath: (value: string) => value,
    transformationProxies: new Map([['tomori', proxy]]),
    environmentLayerProxies: new Map(),
    backgroundProxy: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 },
    isReconstructing: () => false,
    audioElements: new Map(),
    takeSnapshot: vi.fn(),
    getCurrentTime: () => 0,
    getCharacterMeta: vi.fn(),
  };
}

describe('actionSchedulers', () => {
  it('transforms a character at its scheduled time using stage pixels and semantic easing', () => {
    const proxy = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 };
    const ctx = createContext(proxy);

    actionSchedulers.transformCharacter(ctx, {
      time: 1,
      action: 'transformCharacter',
      _id: 'transform-character-1',
      params: {
        id: 'tomori',
        position: [0.25, 0.75],
        scale: 1.2,
        rotation: 12,
        opacity: 0.6,
        z: 4,
        duration: 2,
        ease: 'smooth',
      },
    });

    ctx.tl.seek(0.999, false);
    expect(proxy).toMatchObject({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 });

    ctx.tl.seek(2, false);
    expect(proxy).toMatchObject({ x: 240, y: 405, scale: 1.1, rotation: 6, opacity: 0.8, z: 2 });

    ctx.tl.seek(3, false);
    expect(proxy).toMatchObject({ x: 480, y: 810, scale: 1.2, rotation: 12, opacity: 0.6, z: 4 });
  });

  it('keeps a lighting action at its scheduled time for its transition duration', () => {
    const ctx = createContext({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 });

    actionSchedulers.setLighting(ctx, {
      time: 2,
      action: 'setLighting',
      _id: 'set-lighting-1',
      params: { duration: 1.5, brightness: 0.7 },
    });

    expect(ctx.tl.duration()).toBeCloseTo(3.5, 6);
    ctx.tl.seek(1.999, false);
    expect(ctx.tl.time()).toBeCloseTo(1.999, 3);
    ctx.tl.seek(3.5, false);
    expect(ctx.tl.time()).toBeCloseTo(3.5, 3);
  });

  it('keeps every lighting action on the timeline until its transition completes', () => {
    const lightingActions = [
      'setLighting',
      'resetLighting',
      'setBlur',
      'resetBlur',
      'setGodrays',
      'resetGodrays',
      'setPostProcessing',
      'resetPostProcessing',
      'addColorOverlay',
      'removeColorOverlay',
      'clearColorOverlays',
      'addPointLight',
      'removePointLight',
      'clearPointLights',
    ] as const;

    for (const action of lightingActions) {
      const ctx = createContext({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 });

      actionSchedulers[action](ctx, {
        time: 1.25,
        action,
        _id: `lighting-${action}`,
        params: { duration: 0.75 },
      });

      expect(ctx.tl.duration(), action).toBeCloseTo(2, 6);
    }
  });

  it('accepts every visual runtime directive without changing timeline state', () => {
    const directiveActions = [
      'addLensFilter',
      'changeLensFilter',
      'resetLensFilters',
      'setCompositeRecipe',
      'modulateComposite',
      'resetCompositeRecipe',
    ] as const;

    for (const action of directiveActions) {
      const ctx = createContext({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 });
      actionSchedulers[action](ctx, {
        time: 4,
        action,
        _id: `directive-${action}`,
        params: { id: 'directive', value: 1 },
      });

      expect(ctx.tl.duration(), action).toBe(0);
    }
  });
});
