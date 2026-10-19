// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { Live2DCharacterGeometry } from '../engine/Live2DCharacterGeometry';
import { RimLightFilter } from '../engine/RimLightFilter';
import { DEFAULT_POST_PROCESSING_SNAPSHOT, deriveLightingSnapshotAtTime } from '../engine/LightingSnapshot';

vi.mock('../engine/StageManager', () => ({
  stageManager: {
    getSceneContainer: () => scene,
    getLayer: (name: string) => name === 'characters' ? characters : background,
    getWidth: () => 1920,
    getHeight: () => 1080,
  },
}));
vi.mock('../engine/Live2DManager', () => ({
  live2DManager: {
    hasCharacter: (id: string) => id === 'character',
    getContainer: () => characters,
  },
}));

const scene = new PIXI.Container();
const characters = new PIXI.Container();
const background = new PIXI.Container();

// Exercise Pixi's actual choice of intermediate render density without a GPU.
// Keep its private API boundary local to this regression test.
interface FilterAllocation {
  filters: readonly PIXI.Filter[];
  bounds: PIXI.Bounds;
  resolution: number;
  skip: boolean;
}
interface FilterAllocationSystem {
  _pushFilterData(): FilterAllocation;
  _calculateFilterBounds(
    data: FilterAllocation, viewport: PIXI.Rectangle, antialias: boolean,
    resolution: number, paddingMultiplier: number,
  ): void;
}

function getRenderDensity(filters: readonly PIXI.Filter[], resolution: number): number {
  const system = new PIXI.FilterSystem({ type: PIXI.RendererType.WEBGL } as PIXI.WebGLRenderer);
  try {
    const allocation = system as unknown as FilterAllocationSystem;
    const data = allocation._pushFilterData();
    data.filters = filters;
    data.bounds.addFrame(0, 0, 1920, 1080);
    allocation._calculateFilterBounds(
      data, new PIXI.Rectangle(0, 0, 1920 * resolution, 1080 * resolution),
      true, resolution, 0,
    );
    expect(data.skip).toBe(false);
    return data.resolution;
  } finally {
    system.destroy();
  }
}

afterEach(() => {
  scene.filters = null;
  characters.filters = null;
  background.filters = null;
});

describe('stage intermediate rendering density', () => {
  it('keeps scene lighting at 4K density instead of rasterizing it at 1080p', async () => {
    const { lightingSystem } = await import('../engine/LightingSystem');
    lightingSystem.init();
    const filters = scene.filters;
    expect(filters?.length).toBeGreaterThan(0);
    for (const resolution of [2, 1, 0.5, 2]) {
      expect(getRenderDensity(filters!, resolution)).toBe(resolution);
      // Effects enabled later must also follow the render target.
      for (const filter of [...filters!, ...characters.filters!, ...background.filters!]) {
        const enabled = filter.enabled;
        filter.enabled = true;
        expect(getRenderDensity([filter], resolution)).toBe(resolution);
        filter.enabled = enabled;
      }
    }
  });

  it('keeps a fading Live2D character sharp with a rim light at 4K density', () => {
    const container = new PIXI.Container();
    const geometry = new Live2DCharacterGeometry(
      new Map(), new Map(), () => container, () => null, () => null,
    );
    const rim = new RimLightFilter({ distance: 8, alpha: 1 });
    container.filters = [rim];
    geometry.applyProxyTransform('character', { opacity: 0.5, scale: 1 });
    expect(container.filters).toHaveLength(2);
    for (const resolution of [2, 1, 0.5, 2]) {
      expect(getRenderDensity(container.filters!, resolution)).toBe(resolution);
    }
    container.destroy();
  });

  it('keeps filters created by targeted post-processing at the current render density', async () => {
    const { default: TargetPostProcessingController } = await import('../engine/visual-runtime/TargetPostProcessingController');
    const controller = new TargetPostProcessingController();
    const snapshot = deriveLightingSnapshotAtTime(0, []);
    snapshot.postProcessingTargets.character = {
      ...DEFAULT_POST_PROCESSING_SNAPSHOT,
      adjGamma: 1.2, bloomBloomScale: 0.4, godrayGain: 0.3,
      rgbSplitX: 2, overlayIntensity: 0.2,
    };
    controller.applySnapshot(snapshot);
    expect(characters.filters).toHaveLength(5);
    const filters = characters.filters!;
    for (const resolution of [2, 0.5, 2]) {
      controller.applySnapshot(snapshot);
      expect(characters.filters).toEqual(filters);
      expect(getRenderDensity(characters.filters!, resolution)).toBe(resolution);
    }
    controller.clear();
  });
});
