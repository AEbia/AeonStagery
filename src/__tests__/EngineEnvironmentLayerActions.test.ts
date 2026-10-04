import { describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';

const environmentMocks = vi.hoisted(() => ({
  setEnvironmentLayer: vi.fn(async () => undefined),
  removeEnvironmentLayer: vi.fn(),
}));

vi.mock('../engine/StageManager', () => ({
  stageManager: environmentMocks,
}));

import { actionSchedulers } from '../engine/actions';

function createContext() {
  return {
    tl: gsap.timeline({ paused: true }),
    resolvePath: (value: string) => value,
    resolvePathAsync: vi.fn(async (value: string) => 'asset://' + value),
    transformationProxies: new Map(),
    environmentLayerProxies: new Map(),
    backgroundProxy: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 },
    isReconstructing: () => false,
    audioElements: new Map(),
    takeSnapshot: vi.fn(),
    getCurrentTime: () => 0,
    getCharacterMeta: vi.fn(),
  } as any;
}

describe('environment layer action schedulers', () => {
  it('resolves an environment image and animates its layer proxy', async () => {
    const ctx = createContext();

    actionSchedulers.setEnvironmentLayer(ctx, {
      time: 1,
      action: 'setEnvironmentLayer',
      _id: 'env-set-1',
      params: {
        layerId: 'background',
        image: 'rooms/quiet.png',
        transition: 'crossfade',
        duration: 2,
        x: 120,
        y: 80,
        scale: 1.3,
        opacity: 0.75,
      },
    });

    ctx.tl.seek(2, false);
    await vi.waitFor(() => expect(environmentMocks.setEnvironmentLayer).toHaveBeenCalled());

    expect(ctx.resolvePathAsync).toHaveBeenCalledWith('rooms/quiet.png');
    expect(environmentMocks.setEnvironmentLayer).toHaveBeenCalledWith(
      'background',
      'asset://rooms/quiet.png',
      expect.objectContaining({
        transition: 'crossfade',
        duration: 2,
        x: 0,
        y: 0,
        scale: 1,
        opacity: 1,
      }),
    );

    ctx.tl.seek(2, false);
    expect(ctx.backgroundProxy).toMatchObject({
      x: 60,
      y: 40,
      scale: 1.15,
      opacity: 0.875,
    });
    ctx.tl.seek(3, false);
    expect(ctx.backgroundProxy).toMatchObject({
      x: 120,
      y: 80,
      scale: 1.3,
      opacity: 0.75,
    });
  });

  it('applies a zero-duration environment transform immediately', async () => {
    const ctx = createContext();

    actionSchedulers.setEnvironmentLayer(ctx, {
      time: 2,
      action: 'setEnvironmentLayer',
      _id: 'env-set-2',
      params: {
        layerId: 'foreground',
        image: 'rooms/foreground.png',
        duration: 0,
        x: 240,
        opacity: 0.5,
      },
    });

    const layerProxy = ctx.environmentLayerProxies.get('foreground');
    expect(layerProxy).toMatchObject({
      x: 240,
      y: 0,
      scale: 1,
      opacity: 0.5,
      rotation: 0,
      z: 0,
    });

    ctx.tl.seek(2.001, false);
    await vi.waitFor(() => expect(environmentMocks.setEnvironmentLayer).toHaveBeenCalledWith(
      'foreground',
      'asset://rooms/foreground.png',
      expect.objectContaining({ duration: 0 }),
    ));
  });

  it('keeps a non-background environment transform in its own proxy', () => {
    const ctx = createContext();

    actionSchedulers.transformEnvironmentLayer(ctx, {
      time: 1,
      action: 'transformEnvironmentLayer',
      _id: 'env-transform-1',
      params: {
        layerId: 'foreground',
        x: 100,
        y: 60,
        opacity: 0.4,
        duration: 1,
      },
    });

    const layerProxy = ctx.environmentLayerProxies.get('foreground');
    expect(layerProxy).toBeDefined();
    expect(layerProxy).not.toBe(ctx.backgroundProxy);

    ctx.tl.seek(1.5, false);
    expect(layerProxy).toMatchObject({
      x: 50,
      y: 30,
      opacity: 0.7,
    });
    expect(ctx.backgroundProxy).toMatchObject({
      x: 0,
      y: 0,
      opacity: 1,
    });
  });

  it('removes an environment layer with the default fade transition', () => {
    const ctx = createContext();

    actionSchedulers.removeEnvironmentLayer(ctx, {
      time: 1.5,
      action: 'removeEnvironmentLayer',
      _id: 'env-remove-1',
      params: { layerId: 'foreground' },
    });

    ctx.tl.seek(1.501, false);

    expect(environmentMocks.removeEnvironmentLayer).toHaveBeenCalledWith('foreground', {
      transition: 'fadeOut',
      duration: 1,
    });
  });
});
