/** @vitest-environment jsdom */
import * as PIXI from 'pixi.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BLEND_MODES } from '../api/types/blend-mode';
import type { LightingSnapshot } from '../engine/LightingSnapshot';
import { DEFAULT_POST_PROCESSING_SNAPSHOT } from '../engine/LightingSnapshot';
import { BLEND_MODE_SHADER_INDEX } from '../engine/visual-runtime/blendModeShader';

const state = vi.hoisted(() => ({
  hero: null as any,
}));

vi.mock('../engine/StageManager', () => ({
  stageManager: {
    getEnvironmentLayerContainer: vi.fn(() => null),
  },
}));

vi.mock('../engine/Live2DManager', () => ({
  live2DManager: {
    hasCharacter: vi.fn((id: string) => id === 'hero'),
    canApplyContainerFilters: vi.fn(() => true),
    getContainer: vi.fn(() => state.hero),
  },
}));

import { targetPostProcessingController } from '../engine/visual-runtime/TargetPostProcessingController';

function snapshotForMode(mode: (typeof BLEND_MODES)[number]): LightingSnapshot {
  return {
    preset: { name: 'normal', intensity: 0 },
    presetWeights: {} as LightingSnapshot['presetWeights'],
    blur: { global: 0, background: 0, characters: 0 },
    postProcessing: DEFAULT_POST_PROCESSING_SNAPSHOT,
    postProcessingTargets: {
      hero: {
        ...DEFAULT_POST_PROCESSING_SNAPSHOT,
        overlayColor: '#abcdef',
        overlayBlendMode: mode,
        overlayIntensity: 0.4,
      },
    },
    colorOverlays: [],
    pointLights: [],
    visualOverlay: null,
  };
}

describe('target post-processing blend mode seam', () => {
  afterEach(() => {
    targetPostProcessingController.clearAll();
    state.hero = null;
  });

  it('applies each mode to its owned target filter while retaining external filters', () => {
    state.hero = new PIXI.Container();
    const externalFilter = new PIXI.ColorMatrixFilter();
    state.hero.filters = [externalFilter];
    let firstBlendFilter: PIXI.Filter | undefined;

    for (const mode of BLEND_MODES) {
      targetPostProcessingController.applySnapshot(snapshotForMode(mode));

      const filters = state.hero.filters as PIXI.Filter[];
      const blendFilter = filters.find((filter) => typeof (filter as any).overlayIntensity === 'number');
      expect(filters).toContain(externalFilter);
      expect(blendFilter).toBeDefined();
      expect((blendFilter as any).overlayBlendMode).toBe(mode);
      expect((blendFilter as any).uniforms.blendMode).toBe(BLEND_MODE_SHADER_INDEX[mode]);
      if (!firstBlendFilter) firstBlendFilter = blendFilter;
      else expect(blendFilter).toBe(firstBlendFilter);
    }

    targetPostProcessingController.clearAll();
    expect(state.hero.filters).toEqual([externalFilter]);
  });
});
