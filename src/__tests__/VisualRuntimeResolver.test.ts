import { describe, expect, it } from 'vitest';
import type { LooseTimelineScene as SceneScript } from './fixtures/TimelineTestTypes';
import { resolveVisualLightingOverlayAtTime } from '../engine/visual-runtime/VisualRuntimeResolver';
import type { VisualTimelineScene } from '../services/visual-authoring/VisualStateResolver';

function makeScene(): SceneScript {
  return {
    sceneId: 'scene',
    meta: {
      title: 'Visual Runtime',
      markers: [
        { markerId: 'cut-1', time: 3, label: 'Cut 1', role: 'lens-boundary' },
      ],
    },
    visual: {
      recipeOverlay: {
        'scene:storm-grade': {
          stack: 'lens',
          slot: 'grade',
          extendsRecipeId: 'builtin:cinematic-cold',
          payload: {
            contrast: 1.22,
            saturation: 0.94,
          },
        },
        'scene:mist-atmosphere': {
          stack: 'lens',
          slot: 'atmosphere',
          extendsRecipeId: 'builtin:haze-godray',
          payload: {
            godrayGain: 0.2,
          },
        },
      },
      segments: {
        'segment:opening': {
          lensStyleBaseline: {
            grade: { recipeId: 'builtin:cinematic-cold' },
          },
        },
      },
    },
    timeline: [
      {
        action: 'addLensFilter',
        time: 0.5,
        params: { category: 'optics', recipeId: 'builtin:soft-bloom-rgb', duration: 0.6 },
      },
      {
        action: 'changeLensFilter',
        time: 1.2,
        params: {
          fromCategory: 'grade',
          fromRecipeId: 'scene:storm-grade',
          category: 'atmosphere',
          recipeId: 'scene:mist-atmosphere',
          intensity: 0.7,
          warmth: 0.4,
          blend: 0.5,
          contamination: 0.3,
          duration: 3,
        },
      },
      {
        action: 'addLensFilter',
        time: 0.25,
        params: { category: 'texture', recipeId: 'builtin:film-grain', duration: 0.6 },
      },
      {
        action: 'addLensFilter',
        time: 0.1,
        params: { category: 'grade', recipeId: 'scene:storm-grade', duration: 0.6 },
      },
    ],
  };
}

describe('VisualRuntimeResolver', () => {
  it('maps resolved lens state into a lighting overlay', () => {
    const overlay = resolveVisualLightingOverlayAtTime(makeScene(), 2);

    expect(overlay).not.toBeNull();
    expect(overlay?.adjustment.adjContrast).toBeGreaterThan(1.15);
    expect(overlay?.adjustment.adjBlue).toBeGreaterThan(1);
    expect(overlay?.postProcessing.bloomBloomScale).toBeGreaterThan(0.08);
    expect(overlay?.postProcessing.bloomBloomScale).toBeLessThan(0.55);
    expect(overlay?.postProcessing.rgbSplitX).toBeGreaterThan(0.18);
    expect(overlay?.postProcessing.godrayGain).toBeGreaterThan(0.03);
    expect(overlay?.overlays.some(entry => entry.mode === 'screen')).toBe(true);
  });

  it('keeps the default atmosphere recipe subtle enough to avoid overexposure', () => {
    const scene: SceneScript = {
      sceneId: 'subtle-atmosphere',
      meta: { title: 'Subtle Atmosphere' },
      timeline: [
        {
          action: 'addLensFilter',
          time: 0,
          params: { category: 'optics', recipeId: 'builtin:soft-bloom-rgb', duration: 0.6 },
        },
      ],
    };

    const overlay = resolveVisualLightingOverlayAtTime(scene, 0.6);

    expect(overlay).not.toBeNull();
    expect(overlay?.postProcessing.bloomBloomScale).toBeGreaterThan(0.05);
    expect(overlay?.postProcessing.bloomBloomScale).toBeLessThanOrEqual(0.16);
    expect(overlay?.postProcessing.bloomBrightness).toBeLessThan(1.02);
    expect(overlay?.postProcessing.rgbSplitX).toBeLessThanOrEqual(0.32);
    expect(overlay?.overlays).toHaveLength(0);
  });

  it('accepts a prepared visual scene shape without a legacy SceneScript projection', () => {
    const preparedAction = {
      id: 'runtime:addLensFilter:1',
      time: 0,
      action: 'addLensFilter',
      params: { category: 'optics', recipeId: 'builtin:soft-bloom-rgb', duration: 0.6 },
      source: { statementId: 'stmt-1', outputKey: 'visual' },
    } as const;
    const scene: VisualTimelineScene = {
      meta: { title: 'Prepared Visual Runtime' },
      timeline: [preparedAction],
    };

    const overlay = resolveVisualLightingOverlayAtTime(scene, 0.6);

    expect(overlay).not.toBeNull();
    expect(overlay?.postProcessing.bloomBloomScale).toBeGreaterThan(0.05);
    expect(overlay?.postProcessing.rgbSplitX).toBeGreaterThan(0);
  });

  it('returns null when the scene has no visual runtime directives', () => {
    const scene: SceneScript = {
      sceneId: 'plain',
      meta: { title: 'Plain' },
      timeline: [],
    };

    expect(resolveVisualLightingOverlayAtTime(scene, 1)).toBeNull();
  });
});
