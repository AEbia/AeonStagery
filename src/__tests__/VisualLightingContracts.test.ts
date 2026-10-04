import { describe, expect, it } from 'vitest';
import {
  sceneDocumentCodec,
  sceneStatementCompiler,
  sceneStatementDefinitionRegistry,
  sceneStatementFactory,
} from '../services/semantic-scene';
import { resolveVisualStateAtTime } from '../services/visual-authoring/VisualStateResolver';
import { deriveLightingSnapshotAtTime, normalizeLightingSnapshot } from '../engine/LightingSnapshot';
import { resolveVisualLightingOverlayAtTime } from '../engine/visual-runtime/VisualRuntimeResolver';
import type { VisualStyleParams } from '../api/types/semantic-scene';
import { BLEND_MODES } from '../api/types/blend-mode';
import { projectKnownSceneVisualBlock } from '../services/semantic-scene/SceneVisualKnownProjection';

const EXPECTED_BLEND_MODES = [
  'normal', 'multiply', 'screen', 'darken', 'lighten', 'overlay', 'soft-light', 'hard-light',
] as const;

function parseLighting(params: Record<string, unknown>) {
  return sceneStatementDefinitionRegistry.parseParams('lighting', params, 'test.lighting.params');
}

function parseVisual(params: Record<string, unknown>) {
  return sceneStatementDefinitionRegistry.parseParams('visualStyle', params, 'test.visual.params');
}

function makeDocument(statements: unknown[], visual?: unknown) {
  return sceneDocumentCodec.parseAndValidate({
    schemaVersion: 4,
    sceneId: 'visual-lighting-contracts',
    meta: {
      title: 'Visual lighting contracts',
      characters: [{ id: 'hero', name: 'Hero', model: 'figure/hero/model.json' }],
    },
    ...(visual ? { visual } : {}),
    statements,
  });
}

describe('visual and lighting source contracts', () => {
  it('accepts every common blend mode in visual integration and lighting overlay fields', () => {
    expect(BLEND_MODES).toEqual(EXPECTED_BLEND_MODES);

    for (const blendMode of EXPECTED_BLEND_MODES) {
      expect(parseVisual({
        scope: 'object',
        target: 'hero',
        slot: 'integration',
        mode: 'set',
        recipeId: 'builtin:integration-soft',
        colorBlendMode: blendMode,
      })).toMatchObject({ colorBlendMode: blendMode });

      expect(parseLighting({
        effect: 'overlay',
        mode: 'set',
        id: 'overlay-a',
        blendMode,
      })).toMatchObject({ blendMode });

      expect(parseLighting({
        effect: 'post',
        mode: 'set',
        overlayColor: '#abcdef',
        overlayBlendMode: blendMode,
      })).toMatchObject({ overlayBlendMode: blendMode });
    }
  });

  it('projects every common blend mode from composite and lens recipe payloads', () => {
    for (const mode of EXPECTED_BLEND_MODES) {
      const compositeId = `scene:composite-${mode}`;
      const lensId = `scene:lens-${mode}`;
      const visual = projectKnownSceneVisualBlock({
        recipeOverlay: {
          [compositeId]: {
            stack: 'composite',
            slot: 'integration',
            payload: { colorOverlay: { color: '#abcdef', alpha: 0.4, mode } },
          },
          [lensId]: {
            stack: 'lens',
            slot: 'atmosphere',
            payload: { overlays: [{ color: '#abcdef', intensity: 0.4, mode }] },
          },
        },
      });

      expect((visual.recipeOverlay as any)?.[compositeId]?.payload?.colorOverlay?.mode).toBe(mode);
      expect((visual.recipeOverlay as any)?.[lensId]?.payload?.overlays?.[0]?.mode).toBe(mode);
    }
  });

  it('preserves every blend mode while normalizing lighting snapshots', () => {
    for (const mode of EXPECTED_BLEND_MODES) {
      const snapshot = normalizeLightingSnapshot({
        preset: { name: 'normal', intensity: 0 },
        blur: { global: 0, background: 0, characters: 0 },
        postProcessing: {
          overlayColor: '#abcdef',
          overlayBlendMode: mode,
          overlayIntensity: 0.4,
        },
        colorOverlays: [{ id: 'overlay-a', color: '#abcdef', mode, alpha: 0.4 }],
        pointLights: [],
        visualOverlay: null,
      } as any);

      expect(snapshot.postProcessing.overlayBlendMode).toBe(mode);
      expect(snapshot.colorOverlays[0]?.mode).toBe(mode);
    }
  });

  it('accepts every legal lighting effect and mode combination', () => {
    const cases = [
      { effect: 'preset', mode: 'set', preset: 'warm', intensity: 0.8 },
      { effect: 'preset', mode: 'modulate', preset: 'night', intensity: 0.4 },
      { effect: 'preset', mode: 'reset' },
      { effect: 'blur', mode: 'set', target: 'background', intensity: 4 },
      { effect: 'blur', mode: 'modulate', target: 'characters', intensity: 2 },
      { effect: 'blur', mode: 'reset', target: 'global' },
      { effect: 'godrays', mode: 'set', intensity: 0.5, angle: 30, lacunarity: 2 },
      { effect: 'godrays', mode: 'modulate', intensity: 0.8, angle: 45, lacunarity: 2.5 },
      { effect: 'godrays', mode: 'reset' },
      { effect: 'post', mode: 'set', bloomBloomScale: 1.2, adjGamma: 1.1 },
      { effect: 'post', mode: 'modulate', rgbSplitX: 0.2, adjContrast: 1.2 },
      { effect: 'post', mode: 'reset', target: 'panorama' },
      { effect: 'overlay', mode: 'set', id: 'overlay-a', color: '#112233', blendMode: 'screen', intensity: 0.4 },
      { effect: 'overlay', mode: 'modulate', id: 'overlay-a', intensity: 0.7 },
      { effect: 'overlay', mode: 'remove', id: 'overlay-a' },
      { effect: 'overlay', mode: 'clear' },
      { effect: 'pointLight', mode: 'set', id: 'point-a', x: 0.5, y: 0.4, radius: 240, intensity: 0.8 },
      { effect: 'pointLight', mode: 'modulate', id: 'point-a', x: 0.6, y: 0.3, intensity: 0.5 },
      { effect: 'pointLight', mode: 'remove', id: 'point-a' },
      { effect: 'pointLight', mode: 'clear' },
    ];

    for (const params of cases) {
      expect(parseLighting(params)).toMatchObject(params);
    }
  });

  it('supports targeted post fields and canonicalizes omitted targets in compiled actions', () => {
    expect(parseLighting({
      effect: 'post',
      mode: 'set',
      target: 'hero',
      overlayColor: '#112233',
      overlayBlendMode: 'screen',
      overlayIntensity: 0.4,
    })).toMatchObject({
      target: 'hero',
      overlayColor: '#112233',
      overlayBlendMode: 'screen',
      overlayIntensity: 0.4,
    });
    expect(parseLighting({ effect: 'post', mode: 'reset', target: 'hero' })).toMatchObject({
      effect: 'post',
      mode: 'reset',
      target: 'hero',
    });
    expect(() => parseLighting({
      effect: 'post',
      mode: 'reset',
      target: 'hero',
      overlayColor: '#ffffff',
    })).toThrow();

    const document = makeDocument([
      {
        id: 'post-panorama',
        time: 0,
        type: 'lighting',
        params: { effect: 'post', mode: 'set', adjGamma: 1.1 },
      },
      {
        id: 'post-character',
        time: 1,
        type: 'lighting',
        params: { effect: 'post', mode: 'modulate', target: 'hero', adjContrast: 1.2 },
      },
      {
        id: 'post-character-reset',
        time: 2,
        type: 'lighting',
        params: { effect: 'post', mode: 'reset', target: 'hero' },
      },
    ]);
    expect(sceneStatementCompiler.compile(document).actions.map((action) => action.params)).toEqual([
      { target: 'panorama', adjGamma: 1.1 },
      { target: 'hero', adjContrast: 1.2 },
      { target: 'hero' },
    ]);
  });

  it('pairs post lifecycle spans by target, including omitted panorama targets', () => {
    const omittedStart = {
      type: 'lighting' as const,
      params: parseLighting({ effect: 'post', mode: 'set', adjGamma: 1.1 }),
    };
    const explicitPanoramaStart = {
      type: 'lighting' as const,
      params: parseLighting({ effect: 'post', mode: 'set', target: 'panorama', adjGamma: 1.1 }),
    };
    const characterStart = {
      type: 'lighting' as const,
      params: parseLighting({ effect: 'post', mode: 'set', target: 'hero', adjGamma: 1.1 }),
    };
    const omittedLifecycle = sceneStatementDefinitionRegistry.timelineLifecyclePresentation(omittedStart);
    const explicitLifecycle = sceneStatementDefinitionRegistry.timelineLifecyclePresentation(explicitPanoramaStart);
    const characterLifecycle = sceneStatementDefinitionRegistry.timelineLifecyclePresentation(characterStart);
    expect(omittedLifecycle?.stateKey).toBe(explicitLifecycle?.stateKey);
    expect(characterLifecycle?.stateKey).not.toBe(omittedLifecycle?.stateKey);

    const omittedModulate = {
      type: 'lighting' as const,
      params: parseLighting({ effect: 'post', mode: 'modulate', adjContrast: 1.2 }),
    };
    expect(sceneStatementDefinitionRegistry.timelineStateSpanDependency(omittedModulate)?.stateKey)
      .toBe(omittedLifecycle?.stateKey);
  });

  it('rejects illegal lighting modes, missing IDs, and setting fields on reset/remove', () => {
    const cases = [
      { effect: 'preset', mode: 'remove' },
      { effect: 'blur', mode: 'reset', intensity: 1 },
      { effect: 'godrays', mode: 'reset', angle: 30 },
      { effect: 'post', mode: 'reset', bloomBloomScale: 1 },
      { effect: 'overlay', mode: 'set', color: '#112233' },
      { effect: 'overlay', mode: 'remove', id: 'overlay-a', color: '#112233' },
      { effect: 'pointLight', mode: 'set', x: 0.5, y: 0.5 },
      { effect: 'pointLight', mode: 'remove', id: 'point-a', radius: 240 },
      { effect: 'pointLight', mode: 'clear', id: 'point-a' },
    ];

    for (const params of cases) {
      expect(() => parseLighting(params)).toThrow();
    }
  });

  it('keeps visual reset and modulate source contracts strict', () => {
    expect(() => parseVisual({
      scope: 'object',
      target: 'hero',
      slot: 'integration',
      mode: 'set',
      intensity: 0.8,
    })).toThrow(/recipeId/);

    expect(() => parseVisual({
      scope: 'object',
      target: 'hero',
      slot: 'integration',
      mode: 'modulate',
      recipeId: 'builtin:integration-soft',
    })).toThrow(/recipeId/);

    expect(() => parseVisual({
      scope: 'object',
      target: 'hero',
      slot: 'integration',
      mode: 'reset',
      semanticOverride: { intensity: 0.5 },
    })).toThrow();
  });

  it('keeps brightness integration-only and bounded to a centered delta', () => {
    expect(parseVisual({
      scope: 'object',
      target: 'hero',
      slot: 'integration',
      mode: 'set',
      recipeId: 'builtin:integration-soft',
      brightness: 0.35,
      semanticOverride: { brightness: -0.4 },
    })).toMatchObject({ brightness: 0.35, semanticOverride: { brightness: -0.4 } });

    for (const slot of ['grounding', 'accent', 'distortion', 'rim-light']) {
      expect(() => parseVisual({
        scope: 'object',
        target: 'hero',
        slot,
        mode: slot === 'rim-light' ? 'modulate' : 'set',
        ...(slot === 'rim-light' ? {} : { recipeId: `builtin:${slot}` }),
        brightness: 0.35,
      })).toThrow(/brightness/);

      expect(() => parseVisual({
        scope: 'object',
        target: 'hero',
        slot,
        mode: slot === 'rim-light' ? 'modulate' : 'set',
        ...(slot === 'rim-light' ? {} : { recipeId: `builtin:${slot}` }),
        semanticOverride: { brightness: 0.35 },
      })).toThrow(/brightness/);
    }

    expect(() => parseVisual({
      scope: 'object',
      target: 'hero',
      slot: 'integration',
      mode: 'modulate',
      brightness: 1.01,
    })).toThrow(/between -1 and 1/);
    expect(() => parseVisual({
      scope: 'object',
      target: 'hero',
      slot: 'integration',
      mode: 'modulate',
      semanticOverride: { brightness: -1.01 },
    })).toThrow(/between -1 and 1/);
  });

  it('preserves semanticOverride objects and typed fields through authoring, codec, compiler, and resolver', () => {
    const statement = sceneStatementFactory.createStatement({
      id: 'visual-semantic-override',
      time: 0,
      type: 'visualStyle',
      params: {
        scope: 'object',
        target: 'hero',
        slot: 'integration',
        mode: 'set',
        recipeId: 'builtin:integration-soft',
        colorStops: ['#112233', '#223344', '#334455', '#445566'],
        durationSeconds: 0.75,
        semanticOverride: {
          intensity: 0.35,
          color: '#abcdef',
          colorStops: ['#abcdef', '#bcdefa'],
          colorBlendMode: 'overlay',
        },
      },
    }, []);
    const document = sceneStatementFactory.createDocument({
      sceneId: 'visual-semantic-override',
      meta: {
        title: 'Visual semantic override',
        characters: [{ id: 'hero', name: 'Hero', model: 'figure/hero/model.json' }],
      },
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
      statements: [statement],
    });
    const compiled = sceneStatementCompiler.compile(document);
    const authoredParams = document.statements[0].params as VisualStyleParams;

    expect(authoredParams.semanticOverride).toEqual({
      intensity: 0.35,
      color: '#abcdef',
      colorStops: ['#abcdef', '#bcdefa'],
      colorBlendMode: 'overlay',
    });
    expect(compiled.actions[0].params).toMatchObject({
      duration: 0.75,
      colorStops: ['#112233', '#223344', '#334455', '#445566'],
      semanticOverride: {
        intensity: 0.35,
        color: '#abcdef',
        colorStops: ['#abcdef', '#bcdefa'],
        colorBlendMode: 'overlay',
      },
    });
    expect(typeof compiled.actions[0].params.duration).toBe('number');
    expect(Array.isArray(compiled.actions[0].params.colorStops)).toBe(true);
    expect(typeof compiled.actions[0].params.semanticOverride).toBe('object');

    const resolved = resolveVisualStateAtTime({
      sceneId: document.sceneId,
      meta: document.meta,
      visual: document.visual,
      timeline: compiled.actions,
    } as any, 0);
    expect(resolved.compositeTargets.hero?.slots.integration?.latched?.semanticOverride).toEqual({
      intensity: 0.35,
      color: '#abcdef',
      colorStops: ['#abcdef', '#bcdefa'],
      colorBlendMode: 'overlay',
    });
  });

  it('clears latched recipes and active modulation back to the object baseline on reset', () => {
    const document = makeDocument([
      {
        id: 'visual-set',
        time: 0,
        type: 'visualStyle',
        params: {
          scope: 'object',
          target: 'hero',
          slot: 'integration',
          mode: 'set',
          recipeId: 'project:hero-integration',
          intensity: 0.8,
        },
      },
      {
        id: 'visual-modulate',
        time: 0.5,
        type: 'visualStyle',
        params: {
          scope: 'object',
          target: 'hero',
          slot: 'integration',
          mode: 'modulate',
          intensity: 0.3,
          durationSeconds: 1,
        },
      },
      {
        id: 'visual-reset',
        time: 2,
        type: 'visualStyle',
        params: {
          scope: 'object',
          target: 'hero',
          slot: 'integration',
          mode: 'reset',
          durationSeconds: 0.4,
        },
      },
    ], {
      visualTargets: {
        hero: {
          targetType: 'character',
          objectCompositeBaseline: {
            integration: { recipeId: 'builtin:integration-soft' },
          },
        },
      },
    });
    const compiled = sceneStatementCompiler.compile(document);
    const scene = { ...document, timeline: compiled.actions } as any;

    const active = resolveVisualStateAtTime(scene, 1);
    expect(active.compositeTargets.hero?.slots.integration?.latched?.recipeId).toBe('project:hero-integration');
    expect(active.compositeTargets.hero?.slots.integration?.modulation?.intensity).toBe(0.3);

    const reset = resolveVisualStateAtTime(scene, 3);
    expect(reset.compositeTargets.hero?.slots.integration).toEqual({
      baseline: { recipeId: 'builtin:integration-soft' },
    });
  });

  it('returns the fixed neutral empty slot state when reset has no baseline', () => {
    const document = makeDocument([
      {
        id: 'visual-set-no-baseline',
        time: 0,
        type: 'visualStyle',
        params: {
          scope: 'object',
          target: 'hero',
          slot: 'grounding',
          mode: 'set',
          recipeId: 'project:temporary-grounding',
        },
      },
      {
        id: 'visual-reset-no-baseline',
        time: 1,
        type: 'visualStyle',
        params: {
          scope: 'object',
          target: 'hero',
          slot: 'grounding',
          mode: 'reset',
        },
      },
    ]);
    const compiled = sceneStatementCompiler.compile(document);
    const resolved = resolveVisualStateAtTime({ ...document, timeline: compiled.actions } as any, 2);

    expect(resolved.compositeTargets.hero?.slots.grounding).toEqual({});
  });

  it('lowers normalized point-light coordinates into runtime pixels while preserving pixel input', () => {
    const document = makeDocument([
      {
        id: 'normalized-point',
        time: 0,
        type: 'lighting',
        params: {
          effect: 'pointLight',
          mode: 'set',
          id: 'point-normalized',
          x: 0.4,
          y: 0.3,
          radius: 120,
        },
      },
      {
        id: 'pixel-point',
        time: 1,
        type: 'lighting',
        params: {
          effect: 'pointLight',
          mode: 'set',
          id: 'point-pixel',
          x: 768,
          y: 324,
          radius: 120,
        },
      },
    ]);
    const actions = sceneStatementCompiler.compile(document).actions;

    expect(actions[0].params).toMatchObject({ x: 768, y: 324 });
    expect(actions[1].params).toMatchObject({ x: 768, y: 324 });
  });

  it('maintains collection lighting state by ID and consumes advanced fields in snapshots', () => {
    const timeline = [
      {
        action: 'setPostProcessing',
        time: 0,
        params: {
          bloomThreshold: 0.8,
          bloomBloomScale: 1.2,
          bloomBrightness: 1.1,
          rgbSplitX: 0.15,
          rgbSplitY: -0.1,
          adjGamma: 1.1,
          adjContrast: 1.2,
          adjSaturation: 0.9,
          adjBrightness: 1.05,
          adjRed: 1,
          adjGreen: 0.95,
          adjBlue: 1.1,
          duration: 0,
        },
      },
      {
        action: 'setGodrays',
        time: 0,
        params: { intensity: 0.6, angle: 40, lacunarity: 2.4, duration: 0 },
      },
      {
        action: 'addColorOverlay',
        time: 0,
        params: { id: 'overlay-a', color: '#112233', mode: 'multiply', intensity: 0.4, duration: 0 },
      },
      {
        action: 'addColorOverlay',
        time: 0,
        params: { id: 'overlay-b', color: '#445566', mode: 'screen', intensity: 0.5, duration: 0 },
      },
      {
        action: 'addColorOverlay',
        time: 1,
        params: { id: 'overlay-a', color: '#abcdef', mode: 'screen', duration: 0 },
      },
      {
        action: 'removeColorOverlay',
        time: 2,
        params: { id: 'overlay-b', duration: 0 },
      },
      {
        action: 'addPointLight',
        time: 0,
        params: { id: 'point-a', x: 400, y: 300, color: '#ffffff', radius: 180, intensity: 0.8, duration: 0 },
      },
      {
        action: 'addPointLight',
        time: 0,
        params: { id: 'point-b', x: 900, y: 500, color: '#ff0000', radius: 220, intensity: 0.6, duration: 0 },
      },
      {
        action: 'addPointLight',
        time: 1,
        params: { id: 'point-a', x: 700, y: 420, color: '#00ff00', duration: 0 },
      },
      {
        action: 'removePointLight',
        time: 2,
        params: { id: 'point-b', duration: 0 },
      },
      {
        action: 'clearColorOverlays',
        time: 3,
        params: { duration: 0 },
      },
      {
        action: 'clearPointLights',
        time: 3,
        params: { duration: 0 },
      },
    ] as any;

    const atOne = deriveLightingSnapshotAtTime(1, timeline);
    expect(atOne.postProcessing).toMatchObject({
      bloomBloomScale: 1.2,
      rgbSplitX: 0.15,
      adjGamma: 1.1,
      adjBlue: 1.1,
      godrayGain: 0.6,
      godrayLacunarity: 2.4,
      godrayAngle: 40,
    });
    expect(atOne.colorOverlays.map((entry) => entry.id)).toEqual(['overlay-a', 'overlay-b']);
    expect(atOne.colorOverlays.find((entry) => entry.id === 'overlay-a')).toMatchObject({
      color: '#abcdef',
      mode: 'screen',
      alpha: 0.4,
    });
    expect(atOne.pointLights.map((entry) => entry.id)).toEqual(['point-a', 'point-b']);
    expect(atOne.pointLights.find((entry) => entry.id === 'point-a')).toMatchObject({
      x: 700,
      y: 420,
      radius: 180,
      alpha: 0.8,
    });

    const afterRemove = deriveLightingSnapshotAtTime(2.5, timeline);
    expect(afterRemove.colorOverlays.map((entry) => entry.id)).toEqual(['overlay-a']);
    expect(afterRemove.pointLights.map((entry) => entry.id)).toEqual(['point-a']);

    const afterClear = deriveLightingSnapshotAtTime(4, timeline);
    expect(afterClear.colorOverlays).toEqual([]);
    expect(afterClear.pointLights).toEqual([]);
  });

  it('derives standalone godray state without requiring a point-light resource', () => {
    const snapshot = deriveLightingSnapshotAtTime(1, [
      {
        action: 'setGodrays',
        time: 0,
        params: { intensity: 0.45, angle: 36, lacunarity: 2.1, duration: 0 },
      },
    ] as any);

    expect(snapshot.postProcessing).toMatchObject({
      godrayGain: 0.45,
      godrayAngle: 36,
      godrayLacunarity: 2.1,
    });
    expect(snapshot.pointLights).toEqual([]);
  });

  it('normalizes legacy partial lighting snapshots before runtime application', () => {
    const snapshot = normalizeLightingSnapshot({
      preset: { name: 'night', intensity: 0.8 },
      blur: { global: 2 },
      postProcessing: { godrayGain: 0.4, godrayAngle: 38 },
      colorOverlays: [{ color: '#112233', mode: 'screen', alpha: 0.3 }],
      pointLights: [{ x: 640, y: 360, color: '#abcdef', radius: 120, alpha: 0.7 }],
    } as any);

    expect(snapshot.blur).toEqual({ global: 2, background: 0, characters: 0 });
    expect(snapshot.postProcessing).toMatchObject({
      bloomThreshold: 0.5,
      bloomBloomScale: 0,
      godrayGain: 0.4,
      godrayLacunarity: 2.5,
      godrayAngle: 38,
      adjGamma: 1,
    });
    expect(snapshot.colorOverlays[0]).toMatchObject({
      id: 'legacy-overlay-0',
      color: '#112233',
      mode: 'screen',
      alpha: 0.3,
    });
    expect(snapshot.pointLights[0]).toMatchObject({
      id: 'legacy-point-light-0',
      x: 640,
      y: 360,
      radius: 120,
      alpha: 0.7,
    });
  });

  it('activates godray-only scene atmosphere recipes without a bloom threshold', () => {
    const scene = {
      sceneId: 'godray-only-atmosphere',
      meta: { title: 'Godray-only atmosphere' },
      visual: {
        recipeOverlay: {
          'scene:godray-only': {
            stack: 'lens',
            slot: 'atmosphere',
            payload: { godrayGain: 0.18, godrayAngle: 37 },
          },
        },
      },
      timeline: [
        {
          action: 'addLensFilter',
          time: 0,
          params: { category: 'atmosphere', recipeId: 'scene:godray-only', duration: 0 },
        },
      ],
    } as any;

    const overlay = resolveVisualLightingOverlayAtTime(scene, 1);

    expect(overlay?.postProcessing).toMatchObject({
      godrayGain: 0.18,
      godrayAngle: 37,
    });
  });
});
