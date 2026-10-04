import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';
import { BLEND_MODES } from '../api/types/blend-mode';

const pixiMocks = vi.hoisted(() => {
  class MockGraphics {
    alpha = 0;
    blendMode: number | null = null;
    parent: any = null;
    destroyed = false;
    beginFill() {}
    drawRect() {}
    endFill() {}
    destroy() {
      this.destroyed = true;
    }
  }

  class MockSprite {
    alpha = 0;
    blendMode: number | null = null;
    parent: any = null;
    destroyed = false;
    x = 0;
    y = 0;
    width = 0;
    height = 0;
    tint = 0;
    anchor = { set() {} };
    constructor(_texture?: unknown) {}
    destroy() {
      this.destroyed = true;
    }
  }

  class MockColorMatrixFilter {
    enabled = false;
    reset() {}
    saturate() {}
    brightness() {}
    contrast() {}
  }

  class MockBlurFilter {
    enabled = false;
    blur = 0;
  }

  class MockGenericFilter {
    enabled = false;
    threshold = 0;
    bloomScale = 0;
    brightness = 1;
    red: [number, number] = [0, 0];
    blue: [number, number] = [0, 0];
    gamma = 1;
    contrast = 1;
    saturation = 1;
    constructor(init?: Record<string, unknown>) {
      Object.assign(this, init);
    }
  }

  class MockRectangle {
    constructor(
      public x = 0,
      public y = 0,
      public width = 0,
      public height = 0,
    ) {}
  }

  return {
    MockGraphics,
    MockSprite,
    MockColorMatrixFilter,
    MockBlurFilter,
    MockGenericFilter,
    MockRectangle,
  };
});

function createLayer() {
  const layer = {
    children: [] as any[],
    filters: [] as any[],
    addChild: vi.fn((child: any) => {
      child.parent = layer;
      layer.children.push(child);
    }),
    removeChild: vi.fn((child: any) => {
      layer.children = layer.children.filter((entry) => entry !== child);
      if (child.parent === layer) {
        child.parent = null;
      }
    }),
  };
  return layer;
}

let layerProxy: ReturnType<typeof createLayer>;
let effectsLayer: ReturnType<typeof createLayer>;
let backgroundLayer: ReturnType<typeof createLayer>;
let charactersLayer: ReturnType<typeof createLayer>;
let sceneContainer: ReturnType<typeof createLayer> & { filterArea: any };
let originalDocument: Document | undefined;

vi.mock('pixi.js', () => ({
  Graphics: pixiMocks.MockGraphics,
  Sprite: pixiMocks.MockSprite,
  Texture: {
    from: vi.fn(() => ({})),
  },
  BLEND_MODES: {
    MULTIPLY: 1,
    SCREEN: 2,
    ADD: 3,
  },
  ColorMatrixFilter: pixiMocks.MockColorMatrixFilter,
  BlurFilter: pixiMocks.MockBlurFilter,
  Rectangle: pixiMocks.MockRectangle,
  Filter: class MockFilter {},
  GlProgram: { from: () => ({}) },
}));

vi.mock('pixi.js/advanced-blend-modes', () => ({}));

vi.mock('pixi-filters', () => ({
  GodrayFilter: pixiMocks.MockGenericFilter,
  AdvancedBloomFilter: pixiMocks.MockGenericFilter,
  AdjustmentFilter: pixiMocks.MockGenericFilter,
  RGBSplitFilter: pixiMocks.MockGenericFilter,
}));

vi.mock('../engine/StageManager', () => ({
  stageManager: {
    getSceneContainer: vi.fn(() => sceneContainer),
    getWidth: vi.fn(() => 1920),
    getHeight: vi.fn(() => 1080),
    getLayer: vi.fn((name: string) => {
      if (name === 'overlay') return layerProxy;
      if (name === 'effects') return effectsLayer;
      if (name === 'background') return backgroundLayer;
      if (name === 'characters') return charactersLayer;
      return layerProxy;
    }),
  },
}));

vi.mock('../engine/Live2DManager', () => ({
  live2DManager: {
    hasActiveFilterWarmup: vi.fn(() => false),
  },
}));

import { lightingSystem } from '../engine/LightingSystem';

describe('LightingSystem transient effect rebuilds', () => {
  beforeEach(() => {
    layerProxy = createLayer();
    effectsLayer = createLayer();
    backgroundLayer = createLayer();
    charactersLayer = createLayer();
    sceneContainer = Object.assign(createLayer(), { filterArea: null });
    originalDocument = globalThis.document;
    (globalThis as any).document = {
      createElement: vi.fn(() => ({
        width: 0,
        height: 0,
        getContext: () => ({
          createRadialGradient: () => ({
            addColorStop() {},
          }),
          fillStyle: null,
          fillRect() {},
        }),
      })),
    };
    gsap.globalTimeline.pause(0);
    lightingSystem.reset();
  });

  afterEach(() => {
    lightingSystem.reset();
    gsap.globalTimeline.clear();
    gsap.globalTimeline.play(0);
    if (originalDocument === undefined) {
      delete (globalThis as any).document;
    } else {
      globalThis.document = originalDocument;
    }
  });

  it('uses the complete stage-sized scene bounds for godray coverage', () => {
    lightingSystem.init();

    expect(sceneContainer.filterArea).toMatchObject({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
  });

  it('keeps the panorama overlay inside the scene container', () => {
    lightingSystem.init();
    lightingSystem.applySnapshot({
      preset: { name: 'normal', intensity: 0 },
      presetWeights: {} as any,
      blur: { global: 0, background: 0, characters: 0 },
      postProcessing: {
        bloomThreshold: 0.5,
        bloomBloomScale: 0,
        bloomBrightness: 1,
        rgbSplitX: 0,
        rgbSplitY: 0,
        godrayGain: 0,
        godrayLacunarity: 2.5,
        godrayAngle: 30,
        adjGamma: 1,
        adjContrast: 1,
        adjSaturation: 1,
        adjBrightness: 1,
        adjRed: 1,
        adjGreen: 1,
        adjBlue: 1,
        overlayColor: '#112233',
        overlayBlendMode: 'multiply',
        overlayIntensity: 0.6,
      },
      postProcessingTargets: {},
      colorOverlays: [],
      pointLights: [],
      visualOverlay: null,
    });

    const panoramaOverlay = sceneContainer.children.find(
      (child: any) => child.name === 'panorama-post-processing-overlay',
    );
    expect(panoramaOverlay).toBeDefined();
    expect(panoramaOverlay.parent).toBe(sceneContainer);
    // The legacy UI overlay layer is a separate sibling and must not receive
    // the panorama fill (otherwise subtitles/UI would be tinted in export).
    expect(layerProxy.children).toHaveLength(0);
  });

  it('activates standalone godrays through reconciliation without point lights', () => {
    lightingSystem.init();
    lightingSystem.reconcile(0, [
      {
        action: 'setGodrays',
        time: 0,
        params: { intensity: 0.6, angle: 42, lacunarity: 2.2, duration: 0 },
      },
    ] as any);

    const godrayFilter = sceneContainer.filters[2];
    expect(godrayFilter).toMatchObject({
      enabled: true,
      gain: 0.6,
      angle: 42,
      lacunarity: 2.2,
    });
    expect(effectsLayer.children).toHaveLength(0);
  });

  it('keeps authored IDs isolated from lazy legacy point-light allocations', () => {
    const legacyTween = lightingSystem.addPointLight(120, 160, '#00ffff', 80, 0.5, 1);

    lightingSystem.reconcile(0, [
      {
        action: 'addPointLight',
        time: 0,
        params: {
          id: 'runtime-point-light-1',
          x: 760,
          y: 420,
          color: '#ff0000',
          radius: 140,
          intensity: 0.8,
          duration: 0,
        },
      },
    ] as any);

    const authoredLight = effectsLayer.children[0];
    legacyTween.progress(1);

    expect(effectsLayer.children).toHaveLength(2);
    expect(authoredLight).toMatchObject({ x: 760, y: 420, tint: 0xff0000 });
    expect(authoredLight.destroyed).toBe(false);
    expect(effectsLayer.children[1]).toMatchObject({ x: 120, y: 160, tint: 0x00ffff });
    expect(effectsLayer.children[1]).not.toBe(authoredLight);

    legacyTween.kill();
  });

  it('recreates color overlays after reset without requiring a manual reselection seek', () => {
    const tween = lightingSystem.addColorOverlay('#112233', 'multiply', 0.6, 1);

    expect(layerProxy.addChild).not.toHaveBeenCalled();

    tween.progress(0.5);
    expect(layerProxy.addChild).toHaveBeenCalledTimes(1);
    const firstOverlay = layerProxy.children[0];
    expect(firstOverlay.alpha).toBeCloseTo(0.3, 3);

    lightingSystem.reset();
    expect(firstOverlay.destroyed).toBe(true);

    tween.progress(1);
    expect(layerProxy.addChild).toHaveBeenCalledTimes(2);
    const rebuiltOverlay = layerProxy.children[0];
    expect(rebuiltOverlay).not.toBe(firstOverlay);
    expect(rebuiltOverlay.alpha).toBeCloseTo(0.6, 3);

    tween.kill();
  });

  it('recreates point lights after reset so later playback still shows them', () => {
    const tween = lightingSystem.addPointLight(400, 300, '#ffffff', 240, 0.75, 1);

    expect(effectsLayer.addChild).not.toHaveBeenCalled();

    tween.progress(0.5);
    expect(effectsLayer.addChild).toHaveBeenCalledTimes(1);
    const firstLight = effectsLayer.children[0];
    expect(firstLight.alpha).toBeGreaterThan(0);
    expect(firstLight.alpha).toBeLessThan(0.75);

    lightingSystem.reset();
    expect(firstLight.destroyed).toBe(true);

    tween.progress(1);
    expect(effectsLayer.addChild).toHaveBeenCalledTimes(2);
    const rebuiltLight = effectsLayer.children[0];
    expect(rebuiltLight).not.toBe(firstLight);
    expect(rebuiltLight.alpha).toBeCloseTo(0.75, 3);

    tween.kill();
  });

  it('removes active color overlays immediately when removeColorOverlay runs', () => {
    const addTween = lightingSystem.addColorOverlay('#224466', 'multiply', 0.8, 0);
    addTween.progress(1);

    expect(layerProxy.children).toHaveLength(1);
    const overlay = layerProxy.children[0];
    expect(overlay.alpha).toBeCloseTo(0.8, 3);

    const removeTimeline = lightingSystem.removeColorOverlays(0);
    removeTimeline.progress(1);

    expect(layerProxy.children).toHaveLength(0);
    expect(overlay.destroyed).toBe(true);

    addTween.kill();
    removeTimeline.kill();
  });

  it('reconcile keeps overlays removed after a removeColorOverlay action', () => {
    lightingSystem.reconcile(2, [
      {
        action: 'addColorOverlay',
        time: 0,
        params: { color: '#000000', mode: 'multiply', intensity: 0.7, duration: 0 },
      },
      {
        action: 'removeColorOverlay',
        time: 1,
        params: { duration: 0 },
      },
    ]);

    expect(layerProxy.children).toHaveLength(0);
  });

  it('passes every common blend mode to Pixi for visual and authored color overlays', () => {
    for (const mode of BLEND_MODES) {
      lightingSystem.applyVisualOverlay({
        adjustment: {
          adjBrightness: 1,
          adjBlue: 1,
          adjContrast: 1,
          adjGreen: 1,
          adjRed: 1,
          adjSaturation: 1,
        },
        overlays: [{ color: '#abcdef', intensity: 0.4, mode }],
        postProcessing: {
          bloomBloomScale: 0,
          bloomBrightness: 1,
          bloomThreshold: 0.5,
          godrayAngle: 30,
          godrayGain: 0,
          rgbSplitX: 0,
          rgbSplitY: 0,
        },
      });
      expect(layerProxy.children.at(-1)?.blendMode).toBe(mode);

      lightingSystem.reconcile(0, [{
        action: 'addColorOverlay',
        time: 0,
        params: { id: `overlay-${mode}`, color: '#abcdef', mode, intensity: 0.4, duration: 0 },
      }] as any);
      expect(layerProxy.children.some((child) => child.blendMode === mode)).toBe(true);
      lightingSystem.reset();
    }
  });

  it('reconciles point lights by stable ID and preserves unrelated resources', () => {
    const initialTimeline = [
      {
        action: 'addPointLight',
        time: 0,
        params: { id: 'point-a', x: 300, y: 240, color: '#ffffff', radius: 180, intensity: 0.8, duration: 0 },
      },
      {
        action: 'addPointLight',
        time: 0,
        params: { id: 'point-b', x: 900, y: 500, color: '#ff0000', radius: 220, intensity: 0.6, duration: 0 },
      },
    ];

    lightingSystem.reconcile(0, initialTimeline as any);
    const firstLight = effectsLayer.children[0];
    const secondLight = effectsLayer.children[1];

    lightingSystem.reconcile(1, [
      ...initialTimeline,
      {
        action: 'addPointLight',
        time: 1,
        params: { id: 'point-a', x: 420, y: 300, color: '#00ff00', radius: 200, duration: 0 },
      },
      {
        action: 'setPostProcessing',
        time: 1,
        params: { bloomBloomScale: 0.3, duration: 0 },
      },
    ] as any);

    expect(effectsLayer.children).toHaveLength(2);
    expect(effectsLayer.children[0]).toBe(firstLight);
    expect(effectsLayer.children[1]).toBe(secondLight);
    expect(firstLight).toMatchObject({ x: 420, y: 300, width: 400, height: 400, tint: 0x00ff00 });
    expect(secondLight.destroyed).toBe(false);

    lightingSystem.reconcile(2, [
      ...initialTimeline,
      {
        action: 'addPointLight',
        time: 1,
        params: { id: 'point-a', x: 420, y: 300, color: '#00ff00', radius: 200, duration: 0 },
      },
      {
        action: 'removePointLight',
        time: 2,
        params: { id: 'point-a', duration: 0 },
      },
    ] as any);

    expect(firstLight.destroyed).toBe(true);
    expect(secondLight.destroyed).toBe(false);
    expect(effectsLayer.children).toEqual([secondLight]);
  });

  it('preserves standalone godray state and filter identity while point lights change', () => {
    const initialTimeline = [
      {
        action: 'setGodrays',
        time: 0,
        params: { intensity: 0.6, angle: 42, lacunarity: 2.2, duration: 0 },
      },
      {
        action: 'addPointLight',
        time: 0,
        params: { id: 'point-a', x: 300, y: 240, color: '#ffffff', radius: 180, intensity: 0.8, duration: 0 },
      },
    ];

    lightingSystem.init();
    lightingSystem.reconcile(0, initialTimeline as any);
    const godrayFilter = sceneContainer.filters[2];
    const firstLight = effectsLayer.children[0];

    lightingSystem.reconcile(1, [
      ...initialTimeline,
      {
        action: 'addPointLight',
        time: 1,
        params: { id: 'point-a', x: 420, y: 300, color: '#00ff00', radius: 200, duration: 0 },
      },
    ] as any);

    expect(sceneContainer.filters[2]).toBe(godrayFilter);
    expect(godrayFilter).toMatchObject({ enabled: true, gain: 0.6, angle: 42, lacunarity: 2.2 });
    expect(effectsLayer.children[0]).toBe(firstLight);
    expect(firstLight).toMatchObject({ x: 420, y: 300, tint: 0x00ff00 });

    lightingSystem.reconcile(2, [
      ...initialTimeline,
      {
        action: 'removePointLight',
        time: 2,
        params: { id: 'point-a', duration: 0 },
      },
    ] as any);

    expect(firstLight.destroyed).toBe(true);
    expect(effectsLayer.children).toHaveLength(0);
    expect(sceneContainer.filters[2]).toBe(godrayFilter);
    expect(godrayFilter).toMatchObject({ enabled: true, gain: 0.6, angle: 42, lacunarity: 2.2 });
  });

  it('deriveLightingSnapshotAtTime keeps clear actions in the same state model', () => {
    const snapshot = lightingSystem.deriveLightingSnapshotAtTime(2, [
      {
        action: 'setLighting',
        time: 0,
        params: { preset: 'night', intensity: 0.8, duration: 0 },
      },
      {
        action: 'resetLighting',
        time: 1,
        params: { duration: 0 },
      },
      {
        action: 'addPointLight',
        time: 0,
        params: { x: 400, y: 300, color: '#ffffff', radius: 240, intensity: 0.75, duration: 0 },
      },
      {
        action: 'clearPointLights',
        time: 1,
        params: { duration: 0 },
      },
    ] as any);

    expect(snapshot.preset.name).toBe('normal');
    expect(snapshot.pointLights).toHaveLength(0);
  });

  it('deriveLightingSnapshotAtTime is stable even when timeline actions are not pre-sorted', () => {
    const snapshot = lightingSystem.deriveLightingSnapshotAtTime(2, [
      {
        action: 'resetLighting',
        time: 1,
        params: { duration: 0 },
      },
      {
        action: 'clearColorOverlays',
        time: 1,
        params: { duration: 0 },
      },
      {
        action: 'setLighting',
        time: 0,
        params: { preset: 'night', intensity: 0.8, duration: 0 },
      },
      {
        action: 'addColorOverlay',
        time: 0,
        params: { color: '#000000', mode: 'multiply', intensity: 0.7, duration: 0 },
      },
    ] as any);

    expect(snapshot.preset.name).toBe('normal');
    expect(snapshot.colorOverlays).toHaveLength(0);
  });
});
