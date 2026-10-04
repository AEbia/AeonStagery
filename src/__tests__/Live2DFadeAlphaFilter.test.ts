// @vitest-environment jsdom
/**
 * Regression: transparent → opaque fade must swap the container's AlphaFilter
 * through the PixiJS 8 `filters` SETTER, never by mutating the getter's return.
 *
 * Under PixiJS 8 the `filters` getter returns an `Object.freeze(...)`'d copy
 * (effectsMixin: `effect.filters = Object.freeze(value.slice(0))`). The v7-era
 * code called `.push()` / `.splice()` on that frozen array — in the live app
 * that threw `TypeError: Cannot delete property '0' of [object Array]` every
 * frame once a character finished fading in, aborting the timeline transform
 * sync and stranding the filter on the container.
 *
 * This pins the real behaviour against a real PIXI.Container so the frozen-array
 * class of bug cannot come back.
 */
import { describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';

vi.mock('../engine/Live2DMotionController', () => ({
  Live2DMotionController: class {
    dispatchMotion() { return Promise.resolve(); }
    _hardReset() { return Promise.resolve(); }
    stopAllCharacterTweens() {}
    pauseAllTweens() {}
    resumeAllTweens() {}
    resetModel() {}
    setScriptEngine() {}
  },
}));

describe('Live2DManager.applyProxyTransform alpha-filter swap (Pixi v8 frozen filters)', () => {
  async function makeManagerWithContainer() {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    vi.spyOn(manager, 'init').mockResolvedValue();

    const container = new PIXI.Container();
    // Seed the container so getContainer() never touches stageManager.
    (manager as any).containers.set('char-a', container);
    return { manager, container };
  }

  it('attaches an AlphaFilter while transparent without mutating the frozen array', async () => {
    const { manager, container } = await makeManagerWithContainer();

    expect(() =>
      manager.applyProxyTransform('char-a', { x: 10, y: 20, opacity: 0.5, scale: 1 }),
    ).not.toThrow();

    const filters = container.filters as any[] | null;
    expect(filters).toBeTruthy();
    expect(filters!.length).toBe(1);
    expect(filters![0]).toBeInstanceOf(PIXI.AlphaFilter);
    expect(filters![0].alpha).toBeCloseTo(0.5, 5);
    // The v8 getter hands back a frozen array; the code must never rely on it.
    expect(Object.isFrozen(container.filters)).toBe(true);
  });

  it('removes the AlphaFilter (sets filters null) when the fade completes', async () => {
    const { manager, container } = await makeManagerWithContainer();

    // Fade in partially, then to opaque. The second call drives the removal
    // branch — the one that used to throw `Cannot delete property '0'`.
    manager.applyProxyTransform('char-a', { x: 10, y: 20, opacity: 0.3, scale: 1 });
    expect((container.filters as any[]).length).toBe(1);

    expect(() =>
      manager.applyProxyTransform('char-a', { x: 10, y: 20, opacity: 1, scale: 1 }),
    ).not.toThrow();

    expect(container.filters).toBeNull();
    expect(container.alpha).toBe(1);
    expect(container.renderable).toBe(true);
  });

  it('does not duplicate the filter across repeated transparent frames', async () => {
    const { manager, container } = await makeManagerWithContainer();

    manager.applyProxyTransform('char-a', { opacity: 0.4, scale: 1 });
    manager.applyProxyTransform('char-a', { opacity: 0.35, scale: 1 });
    manager.applyProxyTransform('char-a', { opacity: 0.3, scale: 1 });

    const filters = container.filters as any[];
    expect(filters.length).toBe(1);
    expect(filters[0].alpha).toBeCloseTo(0.3, 5);
  });
});
