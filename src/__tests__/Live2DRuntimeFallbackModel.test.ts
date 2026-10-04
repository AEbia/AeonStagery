/**
 * @vitest-environment jsdom
 *
 * The Cubism 2 fallback placeholder model builds a PIXI.Graphics (which pulls
 * the 16x16 white texture through the canvas adapter), so this surface lives in
 * its own jsdom file while the rest of the adapter unit tests run headless.
 * jsdom provides no real 2D canvas context, so the canvas context is stubbed
 * with an inert 2D surface (the canvas element itself stays real so PIXI's
 * CanvasResource auto-detection accepts it).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Texture } from 'pixi.js';
import { Cubism2PixiLive2DAdapter } from '../engine/Live2DRuntimeAdapter';

function installInert2dContext() {
  const prototype: any = HTMLCanvasElement.prototype;
  const original = prototype.getContext;
  prototype.getContext = function (type: string, ...args: unknown[]) {
    if (type === '2d') {
      return {
        fillStyle: '',
        fillRect: () => {},
        clearRect: () => {},
        drawImage: () => {},
        getImageData: () => ({ data: new Uint8ClampedArray(16 * 16 * 4) }),
      };
    }
    return original.call(this, type, ...args);
  };
  return () => {
    prototype.getContext = original;
  };
}

describe('Cubism2PixiLive2DAdapter.createFallbackModel', () => {
  afterEach(() => {
    installInert2dContext();
  });

  function makeAdapter() {
    const adapter = new Cubism2PixiLive2DAdapter(async () => ({
      config: { cubism2: { maskSize: 1024 } },
      from: async () => ({}),
    }));
    return adapter.init().then(() => adapter);
  }

  it('produces a placeholder model that satisfies the standard lifecycle surface', async () => {
    installInert2dContext();
    const adapter = await makeAdapter();

    const fallback = adapter.createFallbackModel(undefined);

    expect(fallback).toBeTruthy();
    expect(typeof fallback.update).toBe('function');
    expect(fallback.internalModel.coreModel).toBeTruthy();
    expect(typeof fallback.internalModel.coreModel.getParameterValues).toBe('function');
    expect(typeof fallback.internalModel.coreModel.getPartOpacities).toBe('function');
    expect(fallback.internalModel.settings.motions).toBeTruthy();
    // The placeholder must survive the adapter's own lifecycle hooks.
    adapter.getControls().advanceFrame(fallback, 16);
    adapter.getControls().clearMotionState(fallback);
    adapter.getControls().stopAllMotions(fallback);
    expect(adapter.getControls().describeInvalidState(fallback)).toBeNull();
    expect(() => adapter.getControls().disposeModel(fallback, { mode: 'soft-detach' })).not.toThrow();
    expect(() => adapter.getControls().disposeModel(fallback, { mode: 'destroy', keepTextures: false })).not.toThrow();
  });

  it('renders through a provided renderer texture instead of a raw canvas when available', async () => {
    installInert2dContext();
    const adapter = await makeAdapter();

    const fakeTexture = Texture.from(document.createElement('canvas'));
    const renderer = {
      generateTexture: () => fakeTexture,
    };

    const fallback = adapter.createFallbackModel(renderer as any);

    expect(fallback.texture).toBe(fakeTexture);
  });
});
