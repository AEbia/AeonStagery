/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import type { LooseTimelineScene as SceneScript } from './fixtures/TimelineTestTypes';
import { resolveVisualStateAtTime } from '../services/visual-authoring/VisualStateResolver';

const backgroundContainer = new PIXI.Container();
const characterContainer = new PIXI.Container();
const textContainer = new PIXI.Container();
const imageSprite = new PIXI.Sprite();
let backgroundSamplingTarget: PIXI.Container | null = null;
let stableSampleBounds: PIXI.Rectangle | null = null;
let stableWorldSampleBounds: PIXI.Rectangle | null = null;
let mockCurrentCamera: { position: { x: number; y: number }; zoom: number } | null = null;
let mockEnvironmentProxy: { x: number; y: number; scale: number; rotation: number; opacity: number; z: number } | null = null;
let environmentSamplingContainer: PIXI.Container | null = null;
let canApplyCharacterFilters = true;

vi.mock('../engine/StageManager', () => ({
  stageManager: {
    getApp: vi.fn(() => ({
      renderer: {
        extract: {
          canvas: vi.fn(() => null),
        },
      },
    })),
    getBackgroundSprite: vi.fn(() => (
      backgroundSamplingTarget instanceof PIXI.Sprite ? backgroundSamplingTarget : null
    )),
    getEnvironmentLayerDisplayObject: vi.fn(() => backgroundSamplingTarget),
    getEnvironmentSamplingContainer: vi.fn(() => environmentSamplingContainer),
    getLayer: vi.fn((name: string) => {
      if (name === 'background') return backgroundContainer;
      throw new Error(`Unexpected layer ${name}`);
    }),
    getImageSprite: vi.fn((id: string) => (id === 'poster' ? imageSprite : null)),
  },
}));

vi.mock('../engine/Live2DManager', () => ({
  live2DManager: {
    hasCharacter: vi.fn((id: string) => id === 'hero'),
    canApplyContainerFilters: vi.fn((id: string) => id === 'hero' && canApplyCharacterFilters),
    getStableSampleBounds: vi.fn(() => stableSampleBounds),
    getStableWorldSampleBounds: vi.fn(() => stableWorldSampleBounds),
    getEnvironmentLayerProxy: vi.fn(() => mockEnvironmentProxy),
    get currentCamera() {
      return mockCurrentCamera;
    },
    getContainer: vi.fn((id: string) => {
      if (id === 'hero') return characterContainer;
      throw new Error(`Unexpected character ${id}`);
    }),
  },
}));

vi.mock('../engine/TextLayerManager', () => ({
  textLayerManager: {
    getLayerContainer: vi.fn((id: string) => (id === 'caption' ? textContainer : null)),
  },
}));

function makeScene(): SceneScript {
  return {
    sceneId: 'scene',
    meta: { title: 'Object Composite' },
    visual: {
      visualTargets: {
        background: {
          targetType: 'background',
          objectCompositeBaseline: {
            integration: { recipeId: 'builtin:integration-soft-warm' },
          },
        },
        hero: {
          targetType: 'character',
          objectCompositeBaseline: {
            grounding: { recipeId: 'builtin:ground-shadow-soft', semanticOverride: { intensity: 0.8, blend: 0.5 } },
            accent: { recipeId: 'builtin:accent-pop' },
          },
        },
        caption: {
          targetType: 'text-layer',
          objectCompositeBaseline: {
            distortion: { recipeId: 'builtin:rgb-blur', semanticOverride: { intensity: 0.8, bloom: 0.4 } },
          },
        },
        poster: {
          targetType: 'image-layer',
          objectCompositeBaseline: {
            integration: { recipeId: 'scene:poster-integration' },
            accent: { recipeId: 'builtin:accent-pop', semanticOverride: { intensity: 0.5 } },
          },
        },
      },
      recipeOverlay: {
        'scene:poster-integration': {
          stack: 'composite',
          slot: 'integration',
          extendsRecipeId: 'builtin:default-integration',
          payload: {
            adjustment: {
              red: 1.06,
              blue: 0.96,
            },
          },
        },
      },
    },
    timeline: [],
  };
}

describe('ObjectCompositeRuntimeController', () => {
  beforeEach(() => {
    backgroundSamplingTarget = null;
    stableSampleBounds = null;
    stableWorldSampleBounds = null;
    mockCurrentCamera = null;
    mockEnvironmentProxy = null;
    environmentSamplingContainer = null;
    canApplyCharacterFilters = true;
    backgroundContainer.filters = [{ external: true } as unknown as PIXI.Filter];
    characterContainer.filters = null;
    textContainer.filters = null;
    imageSprite.filters = null;
  });

  it('applies composite filters to background, character, text, and image targets', async () => {
    const { objectCompositeRuntimeController } = await import('../engine/visual-runtime/ObjectCompositeRuntimeController');

    const scene = makeScene();
    const state = resolveVisualStateAtTime(scene, 0);
    objectCompositeRuntimeController.apply(scene, state);

    expect(backgroundContainer.filters?.length).toBeGreaterThan(1);
    expect(characterContainer.filters?.length).toBeGreaterThan(0);
    expect(textContainer.filters?.length).toBeGreaterThan(0);
    expect(imageSprite.filters?.length).toBeGreaterThan(0);
    expect((characterContainer as any)._filtersDirty).toBe(true);
  });

  it('applies a visible grounding shadow at the default character integration strength', async () => {
    const { objectCompositeRuntimeController } = await import('../engine/visual-runtime/ObjectCompositeRuntimeController');

    const scene = makeScene();
    const state = resolveVisualStateAtTime(scene, 0);
    objectCompositeRuntimeController.apply(scene, state);

    const shadow = characterContainer.filters?.find((filter) =>
      typeof (filter as any).alpha === 'number' &&
      typeof (filter as any).blur === 'number' &&
      typeof (filter as any).distance === 'number'
    ) as any;

    expect(shadow).toBeDefined();
    expect(shadow.internalOnly).toBe(true);
    expect(shadow.maskDriven).toBe(true);
    expect(shadow.alpha).toBeGreaterThanOrEqual(0.32);
    expect(shadow.distance).toBeGreaterThanOrEqual(14);
  });

  it('keeps a neutral four-corner fallback until environment sampling is available', async () => {
    const { objectCompositeRuntimeController } = await import('../engine/visual-runtime/ObjectCompositeRuntimeController');

    const scene: SceneScript = {
      sceneId: 'color-integration',
      meta: { title: 'Color Integration' },
      visual: {
        visualTargets: {
          hero: { targetType: 'character' },
        },
      },
      timeline: [
        {
          action: 'setCompositeRecipe',
          time: 0,
          params: {
            targetId: 'hero',
            slot: 'integration',
            recipeId: 'builtin:integration-soft',
            color: '#4f8fd8',
            colorStops: ['#102030', '#203040', '#304050', '#405060'],
            intensity: 1.1,
            blend: 0.62,
            contamination: 0.48,
          },
        },
      ],
    };
    objectCompositeRuntimeController.clearAll(scene);
    const state = resolveVisualStateAtTime(scene, 0);
    objectCompositeRuntimeController.apply(scene, state);

    const colorOverlay = characterContainer.filters?.find((filter) =>
      (filter as any).color === 0x808080 &&
      typeof (filter as any).alpha === 'number'
    ) as any;

    expect(colorOverlay).toBeDefined();
    expect(colorOverlay.luminanceProtected).toBe(true);
    expect(colorOverlay.colorStops).toEqual([0x808080, 0x808080, 0x808080, 0x808080]);
    expect(colorOverlay.uniforms.gradientMix).toBe(1);
    expect(colorOverlay.alpha).toBeGreaterThanOrEqual(0.08);
  });

  it('applies small warmth edits and lets an explicit blend mode override the recipe', async () => {
    const { objectCompositeRuntimeController: controller } = await import('../engine/visual-runtime/ObjectCompositeRuntimeController');
    const scene: SceneScript = {
      sceneId: 'integration-controls', meta: { title: 'Integration controls' },
      visual: { recipeOverlay: {
        'scene:integration-overlay': { stack: 'composite', slot: 'integration', payload: {
          adjustment: { red: 1, green: 1, blue: 1 },
          colorOverlay: { color: '#8899aa', alpha: 0.2, mode: 'overlay' },
        } },
      } },
      timeline: [],
    };
    const grade = (warmth: number) => {
      scene.timeline = [{ time: 0, action: 'setCompositeRecipe', params: {
        targetId: 'hero', slot: 'integration', recipeId: 'scene:integration-overlay',
        intensity: 0.8, warmth, colorBlendMode: 'soft-light',
      } }];
      controller.apply(scene, resolveVisualStateAtTime(scene, 0));
      const adjustment = characterContainer.filters?.find((filter) => typeof (filter as any).red === 'number') as any;
      const overlay = characterContainer.filters?.find((filter) => (filter as any).luminanceProtected) as any;
      expect(overlay.mode).toBe('soft-light');
      return { red: adjustment.red, blue: adjustment.blue };
    };
    const neutral = grade(0);
    const warm = grade(0.05);
    const cool = grade(-0.05);
    expect(warm.red).toBeGreaterThan(neutral.red);
    expect(warm.blue).toBeLessThan(neutral.blue);
    expect(cool.red).toBeLessThan(neutral.red);
    expect(cool.blue).toBeGreaterThan(neutral.blue);
  });

  it('applies an explicit brightness control to character integration', async () => {
    const { objectCompositeRuntimeController: controller } = await import('../engine/visual-runtime/ObjectCompositeRuntimeController');
    const scene: SceneScript = {
      sceneId: 'integration-brightness', meta: { title: 'Integration brightness' },
      timeline: [],
    };
    controller.clearAll(scene);
    const applyBrightness = (brightness: number) => {
      scene.timeline = [{ time: 0, action: 'setCompositeRecipe', params: {
        targetId: 'hero', slot: 'integration', recipeId: 'builtin:integration-soft', brightness,
      } }];
      controller.apply(scene, resolveVisualStateAtTime(scene, 0));
      return characterContainer.filters?.find((filter) => typeof (filter as any).brightness === 'number') as any;
    };

    const dim = applyBrightness(-0.2).brightness;
    const neutral = applyBrightness(0).brightness;
    const bright = applyBrightness(0.2).brightness;
    expect(dim).toBeLessThan(neutral);
    expect(bright).toBeGreaterThan(neutral);
  });

  it('scales environment integration with intensity and removes it at zero', async () => {
    const { objectCompositeRuntimeController: controller } = await import('../engine/visual-runtime/ObjectCompositeRuntimeController');
    const scene: SceneScript = {
      sceneId: 'integration-strength',
      meta: { title: 'Integration Strength' },
      visual: {
        visualTargets: {
          hero: {
            targetType: 'character',
            objectCompositeBaseline: {
              integration: { recipeId: 'builtin:integration-soft', semanticOverride: { intensity: 0.5 } },
            },
          },
        },
      },
      timeline: [],
    };
    controller.clearAll(scene);
    const applyStrength = (intensity: number) => {
      scene.visual!.visualTargets!.hero.objectCompositeBaseline!.integration!.semanticOverride = { intensity };
      controller.apply(scene, resolveVisualStateAtTime(scene, 0));
      return characterContainer.filters?.find(filter => (filter as any).luminanceProtected) as any;
    };
    const weakAlpha = applyStrength(0.5).alpha;
    const strongAlpha = applyStrength(1).alpha;
    expect(strongAlpha).toBeGreaterThan(0.2);
    expect(strongAlpha).toBeGreaterThan(weakAlpha);
    expect(applyStrength(0)).toBeUndefined();
    expect(characterContainer.filters).toBeNull();
  });

  it.each([false, true])('samples four surrounding environment regions and follows movement (legacy colors: %s)', async (legacyColors) => {
    const { objectCompositeRuntimeController: controller } = await import('../engine/visual-runtime/ObjectCompositeRuntimeController');
    const { stageManager } = await import('../engine/StageManager');
    environmentSamplingContainer = new PIXI.Container();
    environmentSamplingContainer.getLocalBounds = () => new PIXI.Bounds(0, 0, 640, 360);
    stableSampleBounds = new PIXI.Rectangle(240, 100, 160, 160);
    const pixels = new Uint8ClampedArray(64 * 36 * 4);
    for (let y = 0; y < 36; y++) for (let x = 0; x < 64; x++) {
      const inside = x >= 24 && x <= 40 && y >= 10 && y <= 26;
      const color = inside ? [128, 128, 128] : y < 18
        ? x < 32 ? [240, 30, 30] : [30, 30, 240]
        : x < 32 ? [30, 240, 30] : [240, 240, 30];
      pixels.set([...color, 255], (y * 64 + x) * 4);
    }
    const canvas = { width: 64, height: 36 };
    const extract = vi.fn(() => canvas);
    vi.mocked(stageManager.getApp).mockReturnValue({ renderer: { extract: { canvas: extract } } } as any);
    const probe = vi.spyOn(controller as any, 'getProbeContext').mockReturnValue({ canvas, context: {
      clearRect: vi.fn(), drawImage: vi.fn(), getImageData: () => ({ data: pixels }),
    } });
    const scene: SceneScript = { sceneId: 'surrounding-colors', meta: { title: 'Surrounding colors' }, timeline: [],
      visual: { visualTargets: { hero: { targetType: 'character', objectCompositeBaseline: {
        integration: { recipeId: 'builtin:integration-soft', ...(legacyColors ? { semanticOverride: {
          color: '#ffffff', colorStops: ['#ffffff', '#ffffff', '#ffffff', '#ffffff'],
        } } : {}) },
      } } } },
    };
    const red = (color: number) => (color >> 16) & 255;
    const green = (color: number) => (color >> 8) & 255;
    const blue = (color: number) => color & 255;
    try {
      controller.clearAll(scene);
      const state = resolveVisualStateAtTime(scene, 0);
      controller.apply(scene, state, 0);
      const overlay = characterContainer.filters!.find(filter => (filter as any).luminanceProtected) as any;
      expect(overlay.uniforms.gradientMix).toBe(1);
      const [tl, tr, bl, br] = overlay.colorStops;
      expect(red(tl) - green(tl)).toBeGreaterThan(60);
      expect(blue(tr) - red(tr)).toBeGreaterThan(60);
      expect(green(bl) - blue(bl)).toBeGreaterThan(60);
      expect(red(br) - blue(br)).toBeGreaterThan(60);
      expect(green(br) - blue(br)).toBeGreaterThan(60);
      expect(extract).toHaveBeenCalledWith({ target: environmentSamplingContainer, resolution: 1 / 30 });
      stableSampleBounds = new PIXI.Rectangle(20, 100, 160, 160);
      for (let frame = 1; frame <= 240; frame++) controller.apply(scene, state, frame / 60);
      expect(red(overlay.colorStops[1]) - blue(overlay.colorStops[1])).toBeGreaterThan(60);
      // Environment contents change without bounds changing, including seeking backward.
      for (let i = 0; i < pixels.length; i += 4) pixels.set([20, 200, 220, 255], i);
      controller.apply(scene, state, 0);
      expect(overlay.colorStops).toEqual([0x14c8dc, 0x14c8dc, 0x14c8dc, 0x14c8dc]);
    } finally {
      probe.mockRestore();
      vi.mocked(stageManager.getApp).mockReturnValue({ renderer: { extract: { canvas: vi.fn(() => null) } } } as any);
      controller.clearAll(scene);
    }
  });

  it('resamples the complete environment composition when its pixels change', async () => {
    const { objectCompositeRuntimeController: controller } = await import('../engine/visual-runtime/ObjectCompositeRuntimeController');
    const { stageManager } = await import('../engine/StageManager');
    environmentSamplingContainer = new PIXI.Container();
    environmentSamplingContainer.addChild(new PIXI.Sprite(), new PIXI.Sprite());
    let color = [220, 180, 100];
    const context = {
      clearRect: vi.fn(), drawImage: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray(Array.from({ length: 64 * 36 }, () => [...color, 255]).flat()) }),
    };
    const canvas = { width: 64, height: 36 };
    const extract = vi.fn(() => canvas);
    vi.mocked(stageManager.getApp).mockReturnValue({ renderer: { extract: { canvas: extract } } } as any);
    // Use the canvas seam so the controller still executes refresh, derivation and filter updates.
    const probe = vi.spyOn(controller as any, 'getProbeContext').mockReturnValue({ canvas, context });
    const scene: SceneScript = {
      sceneId: 'environment-composition', meta: { title: 'Environment Composition' }, timeline: [],
      visual: { visualTargets: { hero: { targetType: 'character', objectCompositeBaseline: {
        integration: { recipeId: 'builtin:integration-soft' },
      } } } },
    };
    try {
      controller.invalidateEnvironmentSamples();
      const state = resolveVisualStateAtTime(scene, 0);
      controller.apply(scene, state, 0);
      const overlay = characterContainer.filters!.find(filter => (filter as any).luminanceProtected) as any;
      const initialColor = overlay.color;
      const adjustment = characterContainer.filters!.find(filter => 'brightness' in filter) as any;
      const initialBrightness = adjustment.brightness;
      expect(extract).toHaveBeenCalledWith({ target: environmentSamplingContainer, resolution: 1 / 30 });
      color = [20, 40, 80];
      for (let frame = 1; frame <= 120; frame++) controller.apply(scene, state, frame / 60);
      expect(overlay.color).not.toBe(initialColor);
      expect(adjustment.brightness).toBeLessThan(initialBrightness);
    } finally {
      probe.mockRestore();
      vi.mocked(stageManager.getApp).mockReturnValue({ renderer: { extract: { canvas: vi.fn(() => null) } } } as any);
      controller.invalidateEnvironmentSamples();
    }
  });

  it('does not rescan a stable environment composition on every character frame', async () => {
    const { objectCompositeRuntimeController: controller } = await import('../engine/visual-runtime/ObjectCompositeRuntimeController');
    const { stageManager } = await import('../engine/StageManager');
    const children = [new PIXI.Sprite(), new PIXI.Sprite(), new PIXI.Sprite()];
    let childrenReads = 0;
    const stableEnvironment = {
      getBounds: () => new PIXI.Rectangle(0, 0, 1920, 1080),
      getLocalBounds: () => new PIXI.Bounds(0, 0, 1920, 1080),
      get x() { return 0; },
      get y() { return 0; },
      scale: { x: 1, y: 1 },
      rotation: 0,
      get children() {
        childrenReads += 1;
        return children;
      },
    } as any;
    environmentSamplingContainer = stableEnvironment;
    stableSampleBounds = new PIXI.Rectangle(420, 220, 180, 280);

    const canvas = { width: 64, height: 36 };
    const extract = vi.fn(() => canvas);
    const context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: () => ({
        data: new Uint8ClampedArray(Array.from({ length: 64 * 36 }, () => [120, 140, 180, 255]).flat()),
      }),
    };
    vi.mocked(stageManager.getApp).mockReturnValue({ renderer: { extract: { canvas: extract } } } as any);
    const probe = vi.spyOn(controller as any, 'getProbeContext').mockReturnValue({ canvas, context });
    const scene: SceneScript = {
      sceneId: 'stable-environment-scan',
      meta: { title: 'Stable environment scan' },
      timeline: [],
      visual: { visualTargets: { hero: { targetType: 'character', objectCompositeBaseline: {
        integration: { recipeId: 'builtin:integration-soft' },
      } } } },
    };

    try {
      controller.clearAll(scene);
      controller.invalidateEnvironmentSamples();
      const state = resolveVisualStateAtTime(scene, 0);
      controller.apply(scene, state, 0);
      const initialReads = childrenReads;

      for (let frame = 1; frame <= 60; frame += 1) {
        controller.apply(scene, state, frame / 60);
      }

      expect(childrenReads).toBe(initialReads);
    } finally {
      probe.mockRestore();
      vi.mocked(stageManager.getApp).mockReturnValue({ renderer: { extract: { canvas: vi.fn(() => null) } } } as any);
      controller.invalidateEnvironmentSamples();
    }
  });

  it('updates character integration when an environment layer moves at a paused timestamp', async () => {
    const { objectCompositeRuntimeController: controller } = await import('../engine/visual-runtime/ObjectCompositeRuntimeController');
    const { stageManager } = await import('../engine/StageManager');
    environmentSamplingContainer = new PIXI.Container();
    const environmentLayerSprite = new PIXI.Sprite();
    environmentSamplingContainer.addChild(environmentLayerSprite);
    environmentSamplingContainer.getLocalBounds = () => new PIXI.Bounds(0, 0, 640, 360);
    stableSampleBounds = new PIXI.Rectangle(240, 100, 160, 160);
    let sampledColor = [220, 180, 100];
    const canvas = { width: 64, height: 36 };
    const extract = vi.fn(() => canvas);
    const context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: () => ({
        data: new Uint8ClampedArray(Array.from({ length: 64 * 36 }, () => [...sampledColor, 255]).flat()),
      }),
    };
    vi.mocked(stageManager.getApp).mockReturnValue({ renderer: { extract: { canvas: extract } } } as any);
    const probe = vi.spyOn(controller as any, 'getProbeContext').mockReturnValue({ canvas, context });
    const scene: SceneScript = {
      sceneId: 'paused-environment-move',
      meta: { title: 'Paused environment move' },
      timeline: [],
      visual: { visualTargets: { hero: { targetType: 'character', objectCompositeBaseline: {
        integration: { recipeId: 'builtin:integration-soft' },
      } } } },
    };

    try {
      controller.clearAll(scene);
      const state = resolveVisualStateAtTime(scene, 0);
      controller.apply(scene, state, 10);
      const overlay = characterContainer.filters!.find(filter => (filter as any).luminanceProtected) as any;
      const initialColor = overlay.color;
      const environmentState = (controller as any).environmentStates.get('hero');
      const initialRawColor = environmentState.raw.color;

      // A paused authoring edit moves the environment layer without advancing scene time.
      environmentLayerSprite.x = 120;
      sampledColor = [30, 90, 230];
      controller.apply(scene, state, 10);

      expect(extract).toHaveBeenCalledTimes(2);
      expect(environmentState.raw.color).not.toBe(initialRawColor);
      expect(overlay.color).not.toBe(initialColor);
    } finally {
      probe.mockRestore();
      vi.mocked(stageManager.getApp).mockReturnValue({ renderer: { extract: { canvas: vi.fn(() => null) } } } as any);
      controller.clearAll(scene);
    }
  });

  it('uses target environment overrides as a stable fallback without breaking character filters', async () => {
    const { objectCompositeRuntimeController } = await import('../engine/visual-runtime/ObjectCompositeRuntimeController');

    const scene: SceneScript = {
      sceneId: 'override-fallback',
      meta: { title: 'Override Fallback' },
      visual: {
        visualTargets: {
          hero: {
            targetType: 'character',
            objectCompositeBaseline: {
              grounding: { recipeId: 'builtin:ground-shadow-soft' },
              integration: { recipeId: 'builtin:integration-soft' },
            },
            targetEnvironmentOverride: {
              environmentColor: '#7fb0dd',
              primaryLightDirection: 'left',
            },
          },
        },
      },
      timeline: [],
    };

    const state = resolveVisualStateAtTime(scene, 0);
    objectCompositeRuntimeController.apply(scene, state, 0);

    const colorOverlay = characterContainer.filters?.find((filter) =>
      typeof (filter as any).color === 'number' &&
      typeof (filter as any).alpha === 'number' &&
      'colorStops' in (filter as any)
    ) as any;
    const shadow = characterContainer.filters?.find((filter) =>
      typeof (filter as any).rotation === 'number' &&
      typeof (filter as any).distance === 'number'
    ) as any;

    expect(colorOverlay).toBeDefined();
    expect(colorOverlay.color).toBe(0x7fb0dd);
    expect(colorOverlay.colorStops).toEqual([0x7fb0dd, 0x7fb0dd, 0x7fb0dd, 0x7fb0dd]);
    expect(shadow).toBeDefined();
    expect(shadow.rotation).toBe(118);
  });

  it('samples responsive character integration in background-local space so camera-only motion does not shift colors', async () => {
    const { objectCompositeRuntimeController } = await import('../engine/visual-runtime/ObjectCompositeRuntimeController');

    const probePixels = new Uint8ClampedArray(64 * 36 * 4);
    for (let y = 0; y < 36; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        const index = (y * 64 + x) * 4;
        const warm = x >= 32;
        probePixels[index] = warm ? 0xf1 : 0x1a;
        probePixels[index + 1] = warm ? 0xd3 : 0x24;
        probePixels[index + 2] = warm ? 0x9a : 0x38;
        probePixels[index + 3] = 0xff;
      }
    }
    const fakeContext = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: probePixels })),
    };
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => fakeContext,
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName, options);
    }) as typeof document.createElement);

    const backgroundSprite: any = new PIXI.Sprite();
    Object.defineProperty(backgroundSprite, 'texture', {
      configurable: true,
      value: {
        baseTexture: {
          uid: 'camera-local-source',
          resource: {
            source: { width: 8, height: 4 },
          },
        },
        textureCacheIds: ['camera-local-source'],
      },
    });
    let cameraOffsetX = 100;
    backgroundSprite.getBounds = () => new PIXI.Rectangle(cameraOffsetX, 0, 800, 400);
    backgroundSprite.getLocalBounds = () => new PIXI.Rectangle(0, 0, 80, 40);
    (backgroundSprite as any).toLocal = (point: PIXI.Point) => new PIXI.Point(
      (point.x - cameraOffsetX) / 10,
      point.y / 10,
    );
    backgroundSamplingTarget = backgroundSprite;

    const scene: SceneScript = {
      sceneId: 'camera-stable-integration',
      meta: { title: 'Camera Stable Integration' },
      visual: {
        visualTargets: {
          hero: {
            targetType: 'character',
            objectCompositeBaseline: {
              integration: { recipeId: 'builtin:integration-soft' },
            },
          },
        },
      },
      timeline: [],
    };

    const state = resolveVisualStateAtTime(scene, 0);
    try {
      objectCompositeRuntimeController.clearAll(scene);
      objectCompositeRuntimeController.invalidateEnvironmentSamples();

      stableSampleBounds = new PIXI.Rectangle(220, 180, 120, 240);
      objectCompositeRuntimeController.apply(scene, state, 10);
      const firstColor = (characterContainer.filters?.find((filter) =>
        typeof (filter as any).color === 'number' &&
        typeof (filter as any).alpha === 'number' &&
        'colorStops' in (filter as any)
      ) as any)?.color;
      expect((objectCompositeRuntimeController as any).backgroundProbeCache.coordinateSpace).toBe('background-local');

      cameraOffsetX = 180;
      stableSampleBounds = new PIXI.Rectangle(300, 180, 120, 240);
      objectCompositeRuntimeController.apply(scene, state, 10.1);
      const secondColor = (characterContainer.filters?.find((filter) =>
        typeof (filter as any).color === 'number' &&
        typeof (filter as any).alpha === 'number' &&
        'colorStops' in (filter as any)
      ) as any)?.color;

      expect(firstColor).toBeDefined();
      expect(secondColor).toBe(firstColor);
    } finally {
      createElementSpy.mockRestore();
    }
  });

  it('anchors background-local character sampling in world space during parallax camera motion', async () => {
    const { objectCompositeRuntimeController } = await import('../engine/visual-runtime/ObjectCompositeRuntimeController');

    const probePixels = new Uint8ClampedArray(64 * 36 * 4);
    for (let y = 0; y < 36; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        const index = (y * 64 + x) * 4;
        const warm = x >= 32;
        probePixels[index] = warm ? 0xf1 : 0x1a;
        probePixels[index + 1] = warm ? 0xd3 : 0x24;
        probePixels[index + 2] = warm ? 0x9a : 0x38;
        probePixels[index + 3] = 0xff;
      }
    }
    const fakeContext = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: probePixels })),
    };
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => fakeContext,
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName, options);
    }) as typeof document.createElement);

    const backgroundSprite: any = new PIXI.Sprite();
    backgroundSprite.x = 0;
    backgroundSprite.y = 0;
    backgroundSprite.scale.set(10);
    Object.defineProperty(backgroundSprite, 'texture', {
      configurable: true,
      value: {
        baseTexture: {
          uid: 'parallax-source',
          resource: {
            source: { width: 8, height: 4 },
          },
        },
        textureCacheIds: ['parallax-source'],
      },
    });
    backgroundSprite.getBounds = () => new PIXI.Rectangle(0, 0, 1000, 1000);
    backgroundSprite.getLocalBounds = () => new PIXI.Rectangle(0, 0, 100, 100);
    (backgroundSprite as any).toLocal = (point: PIXI.Point) => new PIXI.Point(point.x / 10, point.y / 10);
    backgroundSamplingTarget = backgroundSprite;

    const scene: SceneScript = {
      sceneId: 'parallax-world-anchor',
      meta: { title: 'Parallax World Anchor' },
      visual: {
        visualTargets: {
          hero: {
            targetType: 'character',
            objectCompositeBaseline: {
              integration: { recipeId: 'builtin:integration-soft' },
            },
          },
        },
      },
      timeline: [],
    };

    const state = resolveVisualStateAtTime(scene, 0);
    try {
      objectCompositeRuntimeController.clearAll(scene);
      objectCompositeRuntimeController.invalidateEnvironmentSamples();

      stableSampleBounds = new PIXI.Rectangle(700, 120, 100, 220);
      stableWorldSampleBounds = new PIXI.Rectangle(100, 120, 100, 220);
      objectCompositeRuntimeController.apply(scene, state, 218.07);

      const sampledColor = (characterContainer.filters?.find((filter) =>
        typeof (filter as any).color === 'number' &&
        typeof (filter as any).alpha === 'number' &&
        'colorStops' in (filter as any)
      ) as any)?.color as number | undefined;
      const red = sampledColor !== undefined ? (sampledColor >> 16) & 0xff : 255;

      expect(sampledColor).toBeDefined();
      expect(red).toBeLessThan(80);
    } finally {
      createElementSpy.mockRestore();
    }
  });

  it('uses the environment proxy instead of camera-shifted display bounds for background-local sampling', async () => {
    const { objectCompositeRuntimeController } = await import('../engine/visual-runtime/ObjectCompositeRuntimeController');

    const probePixels = new Uint8ClampedArray(64 * 36 * 4);
    for (let y = 0; y < 36; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        const index = (y * 64 + x) * 4;
        const warm = x >= 32;
        probePixels[index] = warm ? 0xf1 : 0x1a;
        probePixels[index + 1] = warm ? 0xd3 : 0x24;
        probePixels[index + 2] = warm ? 0x9a : 0x38;
        probePixels[index + 3] = 0xff;
      }
    }
    const fakeContext = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: probePixels })),
    };
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => fakeContext,
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName, options);
    }) as typeof document.createElement);

    const backgroundSprite: any = new PIXI.Sprite();
    Object.defineProperty(backgroundSprite, 'texture', {
      configurable: true,
      value: {
        baseTexture: {
          uid: 'proxy-anchored-source',
          resource: {
            source: { width: 8, height: 4 },
          },
        },
        textureCacheIds: ['proxy-anchored-source'],
      },
    });
    backgroundSprite.x = 140;
    backgroundSprite.y = -260;
    backgroundSprite.scale.set(99);
    backgroundSprite.getBounds = () => new PIXI.Rectangle(140, -260, 3000, 2000);
    backgroundSprite.getLocalBounds = () => new PIXI.Rectangle(-40, -20, 80, 40);
    backgroundSamplingTarget = backgroundSprite;
    mockEnvironmentProxy = { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, z: -260 };

    const scene: SceneScript = {
      sceneId: 'proxy-anchored-integration',
      meta: { title: 'Proxy Anchored Integration' },
      visual: {
        visualTargets: {
          hero: {
            targetType: 'character',
            objectCompositeBaseline: {
              integration: { recipeId: 'builtin:integration-soft' },
            },
          },
        },
      },
      timeline: [],
    };

    const state = resolveVisualStateAtTime(scene, 0);
    try {
      objectCompositeRuntimeController.clearAll(scene);
      objectCompositeRuntimeController.invalidateEnvironmentSamples();

      stableWorldSampleBounds = new PIXI.Rectangle(450, 430, 120, 220);
      objectCompositeRuntimeController.apply(scene, state, 218.07);
      const firstColor = (characterContainer.filters?.find((filter) =>
        typeof (filter as any).color === 'number' &&
        typeof (filter as any).alpha === 'number' &&
        'colorStops' in (filter as any)
      ) as any)?.color as number | undefined;

      backgroundSprite.x = 880;
      backgroundSprite.y = 160;
      backgroundSprite.scale.set(123);
      objectCompositeRuntimeController.apply(scene, state, 218.1);
      const secondColor = (characterContainer.filters?.find((filter) =>
        typeof (filter as any).color === 'number' &&
        typeof (filter as any).alpha === 'number' &&
        'colorStops' in (filter as any)
      ) as any)?.color as number | undefined;

      expect(firstColor).toBeDefined();
      expect(secondColor).toBe(firstColor);
      expect(((firstColor! >> 16) & 0xff)).toBeLessThan(80);
    } finally {
      createElementSpy.mockRestore();
    }
  });

  it('keeps the last character environment probe when background-local mapping is temporarily unavailable', async () => {
    const { objectCompositeRuntimeController } = await import('../engine/visual-runtime/ObjectCompositeRuntimeController');

    const probePixels = new Uint8ClampedArray(64 * 36 * 4);
    for (let y = 0; y < 36; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        const index = (y * 64 + x) * 4;
        const warm = x >= 32;
        probePixels[index] = warm ? 0xf1 : 0x1a;
        probePixels[index + 1] = warm ? 0xd3 : 0x24;
        probePixels[index + 2] = warm ? 0x9a : 0x38;
        probePixels[index + 3] = 0xff;
      }
    }
    const fakeContext = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: probePixels })),
    };
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => fakeContext,
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName, options);
    }) as typeof document.createElement);

    const backgroundSprite: any = new PIXI.Sprite();
    Object.defineProperty(backgroundSprite, 'texture', {
      configurable: true,
      value: {
        baseTexture: {
          uid: 'mapping-gap-source',
          resource: {
            source: { width: 8, height: 4 },
          },
        },
        textureCacheIds: ['mapping-gap-source'],
      },
    });
    backgroundSprite.getBounds = () => new PIXI.Rectangle(0, 0, 1920, 1080);
    backgroundSprite.getLocalBounds = () => new PIXI.Rectangle(-40, -20, 80, 40);
    backgroundSamplingTarget = backgroundSprite;
    mockEnvironmentProxy = { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, z: -260 };

    const scene: SceneScript = {
      sceneId: 'mapping-gap-integration',
      meta: { title: 'Mapping Gap Integration' },
      visual: {
        visualTargets: {
          hero: {
            targetType: 'character',
            objectCompositeBaseline: {
              integration: { recipeId: 'builtin:integration-soft' },
            },
          },
        },
      },
      timeline: [],
    };

    const readOverlayColor = () => (characterContainer.filters?.find((filter) =>
      typeof (filter as any).color === 'number' &&
      typeof (filter as any).alpha === 'number' &&
      'colorStops' in (filter as any)
    ) as any)?.color as number | undefined;

    const state = resolveVisualStateAtTime(scene, 0);
    try {
      objectCompositeRuntimeController.clearAll(scene);
      objectCompositeRuntimeController.invalidateEnvironmentSamples();

      stableWorldSampleBounds = new PIXI.Rectangle(450, 430, 120, 220);
      objectCompositeRuntimeController.apply(scene, state, 218.0);
      const firstColor = readOverlayColor();

      stableWorldSampleBounds = null;
      objectCompositeRuntimeController.apply(scene, state, 218.07);
      const secondColor = readOverlayColor();

      expect(firstColor).toBeDefined();
      expect(secondColor).toBe(firstColor);
      expect(((secondColor! >> 16) & 0xff)).toBeLessThan(80);
    } finally {
      createElementSpy.mockRestore();
    }
  });

  it('retains existing character composite filters while Live2D filter warmup blocks updates', async () => {
    const { objectCompositeRuntimeController } = await import('../engine/visual-runtime/ObjectCompositeRuntimeController');

    const scene = makeScene();
    const state = resolveVisualStateAtTime(scene, 0);
    objectCompositeRuntimeController.clearAll(scene);

    canApplyCharacterFilters = true;
    objectCompositeRuntimeController.apply(scene, state, 10);
    const appliedFilters = characterContainer.filters;

    canApplyCharacterFilters = false;
    objectCompositeRuntimeController.apply(scene, state, 10.05);

    expect(appliedFilters?.length).toBeGreaterThan(0);
    expect(characterContainer.filters).toBe(appliedFilters);
  });

  it('tracks background-local character relation smoothly without frame-coordinate jumps', async () => {
    const { objectCompositeRuntimeController } = await import('../engine/visual-runtime/ObjectCompositeRuntimeController');

    const probePixels = new Uint8ClampedArray(64 * 36 * 4);
    for (let y = 0; y < 36; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        const index = (y * 64 + x) * 4;
        const warm = x >= 32;
        probePixels[index] = warm ? 0xf1 : 0x1a;
        probePixels[index + 1] = warm ? 0xd3 : 0x24;
        probePixels[index + 2] = warm ? 0x9a : 0x38;
        probePixels[index + 3] = 0xff;
      }
    }
    const fakeContext = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: probePixels })),
    };
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => fakeContext,
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName, options);
    }) as typeof document.createElement);

    const backgroundSprite: any = new PIXI.Sprite();
    backgroundSprite.x = 0;
    backgroundSprite.y = 0;
    backgroundSprite.scale.set(10);
    Object.defineProperty(backgroundSprite, 'texture', {
      configurable: true,
      value: {
        baseTexture: {
          uid: 'latched-background-source',
          resource: {
            source: { width: 8, height: 4 },
          },
        },
        textureCacheIds: ['latched-background-source'],
      },
    });
    backgroundSprite.getBounds = () => new PIXI.Rectangle(0, 0, 1000, 1000);
    backgroundSprite.getLocalBounds = () => new PIXI.Rectangle(0, 0, 100, 100);
    backgroundSamplingTarget = backgroundSprite;

    const scene: SceneScript = {
      sceneId: 'latched-character-environment',
      meta: { title: 'Latched Character Environment' },
      visual: {
        visualTargets: {
          hero: {
            targetType: 'character',
            objectCompositeBaseline: {
              integration: { recipeId: 'builtin:integration-soft' },
            },
          },
        },
      },
      timeline: [],
    };

    const readOverlayColor = () => (characterContainer.filters?.find((filter) =>
      typeof (filter as any).color === 'number' &&
      typeof (filter as any).alpha === 'number' &&
      'colorStops' in (filter as any)
    ) as any)?.color as number | undefined;
    const colorDistance = (a: number, b: number) => {
      const ar = (a >> 16) & 0xff;
      const ag = (a >> 8) & 0xff;
      const ab = a & 0xff;
      const br = (b >> 16) & 0xff;
      const bg = (b >> 8) & 0xff;
      const bb = b & 0xff;
      return Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb);
    };

    const state = resolveVisualStateAtTime(scene, 0);
    try {
      objectCompositeRuntimeController.clearAll(scene);
      objectCompositeRuntimeController.invalidateEnvironmentSamples();

      stableWorldSampleBounds = new PIXI.Rectangle(100, 120, 100, 220);
      objectCompositeRuntimeController.apply(scene, state, 216.6);
      const firstColor = readOverlayColor();

      stableWorldSampleBounds = new PIXI.Rectangle(700, 120, 100, 220);
      objectCompositeRuntimeController.apply(scene, state, 226.88);
      const secondColor = readOverlayColor();

      for (let i = 1; i <= 72; i += 1) {
        objectCompositeRuntimeController.apply(scene, state, 226.88 + i / 24);
      }
      const settledColor = readOverlayColor();

      expect(firstColor).toBeDefined();
      expect(secondColor).toBeDefined();
      expect(settledColor).toBeDefined();
      expect(colorDistance(secondColor!, firstColor!)).toBeGreaterThan(0);
      expect(colorDistance(secondColor!, firstColor!)).toBeLessThan(12);
      expect(((settledColor! >> 16) & 0xff)).toBeGreaterThan(((secondColor! >> 16) & 0xff));
    } finally {
      createElementSpy.mockRestore();
    }
  });

  it('does not let shadow-only responsiveness change whole-character adjustment brightness', async () => {
    const { objectCompositeRuntimeController } = await import('../engine/visual-runtime/ObjectCompositeRuntimeController');

    const probePixels = new Uint8ClampedArray(64 * 36 * 4).fill(0xff);
    const fakeContext = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: probePixels })),
    };
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => fakeContext,
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName, options);
    }) as typeof document.createElement);

    const backgroundSprite: any = new PIXI.Sprite();
    Object.defineProperty(backgroundSprite, 'texture', {
      configurable: true,
      value: {
        baseTexture: {
          uid: 'shadow-only-source',
          resource: {
            source: { width: 8, height: 4 },
          },
        },
        textureCacheIds: ['shadow-only-source'],
      },
    });
    backgroundSprite.getBounds = () => new PIXI.Rectangle(0, 0, 1000, 1000);
    backgroundSprite.getLocalBounds = () => new PIXI.Rectangle(0, 0, 100, 100);
    backgroundSamplingTarget = backgroundSprite;
    stableWorldSampleBounds = new PIXI.Rectangle(100, 120, 100, 220);

    const scene: SceneScript = {
      sceneId: 'shadow-only-adjustment',
      meta: { title: 'Shadow Only Adjustment' },
      visual: {
        visualTargets: {
          hero: {
            targetType: 'character',
            objectCompositeBaseline: {
              grounding: { recipeId: 'builtin:ground-shadow-soft' },
              integration: {
                recipeId: 'builtin:integration-soft',
                semanticOverride: { color: '#4f8fd8' },
              },
            },
          },
        },
      },
      timeline: [],
    };

    try {
      objectCompositeRuntimeController.clearAll(scene);
      objectCompositeRuntimeController.invalidateEnvironmentSamples();
      const state = resolveVisualStateAtTime(scene, 0);
      objectCompositeRuntimeController.apply(scene, state, 10);

      const adjustment = characterContainer.filters?.find((filter) =>
        typeof (filter as any).brightness === 'number' &&
        typeof (filter as any).contrast === 'number' &&
        typeof (filter as any).saturation === 'number'
      ) as any;

      expect(adjustment).toBeDefined();
      expect(adjustment.brightness).toBeCloseTo(0.974998, 5);
    } finally {
      createElementSpy.mockRestore();
    }
  });

  it('slew-limits responsive environment changes across forward frame gaps', async () => {
    const { objectCompositeRuntimeController } = await import('../engine/visual-runtime/ObjectCompositeRuntimeController');

    const probePixels = new Uint8ClampedArray(64 * 36 * 4);
    for (let y = 0; y < 36; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        const index = (y * 64 + x) * 4;
        const warm = x >= 32;
        probePixels[index] = warm ? 0xf1 : 0x1a;
        probePixels[index + 1] = warm ? 0xd3 : 0x24;
        probePixels[index + 2] = warm ? 0x9a : 0x38;
        probePixels[index + 3] = 0xff;
      }
    }

    const fakeContext = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: probePixels })),
    };
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => fakeContext,
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName, options);
    }) as typeof document.createElement);

    const backgroundSprite: any = new PIXI.Sprite();
    Object.defineProperty(backgroundSprite, 'texture', {
      configurable: true,
      value: {
        baseTexture: {
          uid: 'forward-gap-source',
          resource: {
            source: { width: 8, height: 4 },
          },
        },
        textureCacheIds: ['forward-gap-source'],
      },
    });
    backgroundSprite.getBounds = () => new PIXI.Rectangle(0, 0, 1000, 1000);
    backgroundSprite.getLocalBounds = () => new PIXI.Rectangle(0, 0, 100, 100);
    (backgroundSprite as any).toLocal = (point: PIXI.Point) => new PIXI.Point(point.x / 10, point.y / 10);
    backgroundSamplingTarget = backgroundSprite;

    const scene: SceneScript = {
      sceneId: 'forward-gap-integration',
      meta: { title: 'Forward Gap Integration' },
      visual: {
        visualTargets: {
          hero: {
            targetType: 'character',
            objectCompositeBaseline: {
              integration: { recipeId: 'builtin:integration-soft' },
            },
          },
        },
      },
      timeline: [],
    };

    const colorDistance = (a: number, b: number) => {
      const ar = (a >> 16) & 0xff;
      const ag = (a >> 8) & 0xff;
      const ab = a & 0xff;
      const br = (b >> 16) & 0xff;
      const bg = (b >> 8) & 0xff;
      const bb = b & 0xff;
      return Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb);
    };
    const readOverlayColor = () => (characterContainer.filters?.find((filter) =>
      typeof (filter as any).color === 'number' &&
      typeof (filter as any).alpha === 'number' &&
      'colorStops' in (filter as any)
    ) as any)?.color as number | undefined;

    const state = resolveVisualStateAtTime(scene, 0);
    try {
      objectCompositeRuntimeController.clearAll(scene);
      objectCompositeRuntimeController.invalidateEnvironmentSamples();

      stableSampleBounds = new PIXI.Rectangle(100, 120, 100, 220);
      objectCompositeRuntimeController.apply(scene, state, 216.6);
      const firstColor = readOverlayColor();

      stableSampleBounds = new PIXI.Rectangle(700, 120, 100, 220);
      objectCompositeRuntimeController.apply(scene, state, 218.07);
      const secondColor = readOverlayColor();

      expect(firstColor).toBeDefined();
      expect(secondColor).toBeDefined();
      expect(colorDistance(secondColor!, firstColor!)).toBeLessThan(12);
    } finally {
      createElementSpy.mockRestore();
    }
  });

  it('clears only owned composite filters while preserving external filters', async () => {
    const { objectCompositeRuntimeController } = await import('../engine/visual-runtime/ObjectCompositeRuntimeController');

    const scene = makeScene();
    const state = resolveVisualStateAtTime(scene, 0);
    objectCompositeRuntimeController.apply(scene, state);
    objectCompositeRuntimeController.clearAll(scene);

    expect(backgroundContainer.filters).toHaveLength(1);
    expect(characterContainer.filters).toBeNull();
    expect(textContainer.filters).toBeNull();
    expect(imageSprite.filters).toBeNull();
    expect((characterContainer as any)._filtersDirty).toBe(true);
  });

  it('preserves target post-processing across composite removal and reapplication', async () => {
    const { objectCompositeRuntimeController } = await import('../engine/visual-runtime/ObjectCompositeRuntimeController');
    const {
      default: TargetPostProcessingController,
      TARGET_POST_PROCESSING_OWNER,
    } = await import('../engine/visual-runtime/TargetPostProcessingController');
    const {
      createDefaultLightingSnapshot,
      DEFAULT_POST_PROCESSING_SNAPSHOT,
    } = await import('../engine/LightingSnapshot');
    const targetController = new TargetPostProcessingController();
    const scene = makeScene();
    const state = resolveVisualStateAtTime(scene, 0);
    const targetSnapshot = createDefaultLightingSnapshot();
    targetSnapshot.postProcessingTargets.hero = {
      ...DEFAULT_POST_PROCESSING_SNAPSHOT,
      adjContrast: 1.25,
    };
    const hasCompositeFilter = () => Boolean(characterContainer.filters?.some(
      (filter) => Boolean((filter as any).__visualCompositeOwnedFilter),
    ));
    const hasTargetFilter = () => Boolean(characterContainer.filters?.some(
      (filter) => Boolean((filter as any)[TARGET_POST_PROCESSING_OWNER]),
    ));

    objectCompositeRuntimeController.clearAll(scene);
    objectCompositeRuntimeController.apply(scene, state, 0);
    targetController.applySnapshot(targetSnapshot);
    expect(hasCompositeFilter()).toBe(true);
    expect(hasTargetFilter()).toBe(true);

    objectCompositeRuntimeController.clearAll(scene);
    expect(hasCompositeFilter()).toBe(false);
    expect(hasTargetFilter()).toBe(true);

    objectCompositeRuntimeController.apply(scene, state, 1);
    expect(hasCompositeFilter()).toBe(true);
    expect(hasTargetFilter()).toBe(true);

    targetController.applySnapshot(createDefaultLightingSnapshot());
    expect(hasCompositeFilter()).toBe(true);
    expect(hasTargetFilter()).toBe(false);

    targetController.applySnapshot(targetSnapshot);
    expect(hasCompositeFilter()).toBe(true);
    expect(hasTargetFilter()).toBe(true);

    targetController.clear();
    objectCompositeRuntimeController.clearAll(scene);
  });

  it('eases into the first real background sample after a neutral fallback instead of jumping', async () => {
    const { objectCompositeRuntimeController } = await import('../engine/visual-runtime/ObjectCompositeRuntimeController');

    const scene: SceneScript = {
      sceneId: 'late-sample-fallback',
      meta: { title: 'Late Sample Fallback' },
      visual: {
        visualTargets: {
          hero: {
            targetType: 'character',
            objectCompositeBaseline: {
              integration: { recipeId: 'builtin:integration-soft' },
            },
          },
        },
      },
      timeline: [],
    };
    const state = resolveVisualStateAtTime(scene, 0);

    const probePixels = new Uint8ClampedArray(64 * 36 * 4);
    for (let y = 0; y < 36; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        const index = (y * 64 + x) * 4;
        const warm = x >= 32;
        probePixels[index] = warm ? 0xf1 : 0x1a;
        probePixels[index + 1] = warm ? 0xd3 : 0x24;
        probePixels[index + 2] = warm ? 0x9a : 0x38;
        probePixels[index + 3] = 0xff;
      }
    }
    const fakeContext = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: probePixels })),
    };
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => fakeContext,
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName, options);
    }) as typeof document.createElement);

    const backgroundSprite: any = new PIXI.Sprite();
    Object.defineProperty(backgroundSprite, 'texture', {
      configurable: true,
      value: {
        baseTexture: {
          uid: 'late-sample-source',
          resource: {
            source: { width: 8, height: 4 },
          },
        },
        textureCacheIds: ['late-sample-source'],
      },
    });
    backgroundSprite.getBounds = () => new PIXI.Rectangle(0, 0, 1000, 1000);
    backgroundSprite.getLocalBounds = () => new PIXI.Rectangle(0, 0, 100, 100);
    backgroundSamplingTarget = null;

    try {
      objectCompositeRuntimeController.clearAll(scene);
      objectCompositeRuntimeController.invalidateEnvironmentSamples();

      objectCompositeRuntimeController.apply(scene, state, 100);
      const neutralColor = (characterContainer.filters?.find((filter) =>
        typeof (filter as any).color === 'number' &&
        typeof (filter as any).alpha === 'number' &&
        'colorStops' in (filter as any)
      ) as any)?.color as number | undefined;

      backgroundSamplingTarget = backgroundSprite;
      objectCompositeRuntimeController.apply(scene, state, 100.1);
      const sampledColor = (characterContainer.filters?.find((filter) =>
        typeof (filter as any).color === 'number' &&
        typeof (filter as any).alpha === 'number' &&
        'colorStops' in (filter as any)
      ) as any)?.color as number | undefined;

      expect(neutralColor).toBeDefined();
      expect(sampledColor).toBeDefined();
      expect(Math.abs(((sampledColor! >> 16) & 0xff) - ((neutralColor! >> 16) & 0xff))).toBeLessThan(12);
      expect(Math.abs(((sampledColor! >> 8) & 0xff) - ((neutralColor! >> 8) & 0xff))).toBeLessThan(12);
      expect(Math.abs((sampledColor! & 0xff) - (neutralColor! & 0xff))).toBeLessThan(12);
    } finally {
      createElementSpy.mockRestore();
    }
  });
});
