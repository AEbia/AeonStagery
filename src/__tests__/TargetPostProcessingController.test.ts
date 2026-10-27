import { SCENE_SCHEMA_VERSION } from '../api/types/semantic-scene';
import { sceneDocumentCodec, sceneStatementCompiler } from '../services/semantic-scene';
/** @vitest-environment jsdom */
import * as PIXI from 'pixi.js';
import { AdvancedBloomFilter } from 'pixi-filters';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BLEND_MODES } from '../api/types/blend-mode';
import type { LightingSnapshot } from '../engine/LightingSnapshot';
import { createDefaultLightingSnapshot, DEFAULT_POST_PROCESSING_SNAPSHOT, deriveLightingSnapshotAtTime } from '../engine/LightingSnapshot';
import type { RuntimeTimelineAction } from '../engine/RuntimeTimelineScene';
import { live2DManager } from '../engine/Live2DManager';
import { BLEND_MODE_SHADER_INDEX } from '../engine/visual-runtime/blendModeShader';
import { buildLightingTargetOptions } from '../ui/timeline/LightingTargetPicker';

const state = vi.hoisted(() => ({
  hero: null as PIXI.Container | null,
  environments: new Map<string, PIXI.Container>(),
  groups: new Map<string, PIXI.Container>(),
}));

vi.mock('../engine/StageManager', () => ({
  stageManager: {
    getEnvironmentLayerContainer: vi.fn((id: string) => state.environments.get(id) ?? null),
    getLayer: vi.fn((name: string) => state.groups.get(name) ?? null),
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
    blurTargets: {},
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
    state.environments.clear();
    state.groups.clear();
    vi.mocked(live2DManager.canApplyContainerFilters).mockReturnValue(true);
  });

  it('applies post-processing to all environment layers and resets that group independently', () => {
    const environmentGroup = new PIXI.Container();
    const background = new PIXI.Container();
    const fog = new PIXI.Container();
    const hero = new PIXI.Container();
    environmentGroup.addChild(background, fog);
    state.groups.set('background', environmentGroup);
    state.environments.set('fog', fog);
    state.hero = hero;
    const snapshot = createDefaultLightingSnapshot();
    snapshot.postProcessingTargets['group:environmentLayers'] = { ...DEFAULT_POST_PROCESSING_SNAPSHOT, adjContrast: 1.2 };
    snapshot.blurTargets.fog = 4;
    targetPostProcessingController.applySnapshot(snapshot);
    expect(environmentGroup.filters).toHaveLength(1);
    expect(fog.filters?.[0]).toBeInstanceOf(PIXI.BlurFilter);
    expect(hero.filters ?? null).toBeNull();
    expect(background.filters ?? null).toBeNull();
    snapshot.postProcessingTargets = {};
    targetPostProcessingController.applySnapshot(snapshot);
    expect(environmentGroup.filters).toBeNull();
    expect(fog.filters).toHaveLength(1);
  });

  it('applies post-processing to the character group without filtering environments', () => {
    const characters = new PIXI.Container();
    const environments = new PIXI.Container();
    state.groups.set('characters', characters);
    state.groups.set('background', environments);
    const snapshot = createDefaultLightingSnapshot();
    snapshot.postProcessingTargets['group:characters'] = { ...DEFAULT_POST_PROCESSING_SNAPSHOT, adjSaturation: 0.5 };
    targetPostProcessingController.applySnapshot(snapshot);
    expect(characters.filters).toHaveLength(1);
    expect(environments.filters ?? null).toBeNull();
  });

  it('keeps character and environment blur independent and preserves other filters on reset', () => {
    const hero = new PIXI.Container();
    const fog = new PIXI.Container();
    const external = new PIXI.ColorMatrixFilter();
    hero.filters = [external];
    state.hero = hero;
    state.environments.set('fog', fog);
    const snapshot = createDefaultLightingSnapshot();
    snapshot.blurTargets = { hero: 4, fog: 9 };
    snapshot.postProcessingTargets.hero = { ...DEFAULT_POST_PROCESSING_SNAPSHOT, adjContrast: 1.3 };
    targetPostProcessingController.applySnapshot(snapshot);
    const blur = (hero.filters as PIXI.Filter[]).find((filter) => filter instanceof PIXI.BlurFilter);
    const fogBlur = (fog.filters as PIXI.Filter[]).find((filter) => filter instanceof PIXI.BlurFilter);
    expect(blur?.strength).toBe(4);
    expect(fogBlur?.strength).toBe(9);
    snapshot.blurTargets.hero = 7;
    targetPostProcessingController.applySnapshot(snapshot);
    expect(hero.filters).toContain(blur);
    expect(blur?.strength).toBe(7);
    snapshot.blurTargets.hero = 0;
    targetPostProcessingController.applySnapshot(snapshot);
    expect(hero.filters).toContain(external);
    expect(hero.filters).not.toContain(blur);
    expect(hero.filters).toHaveLength(2);
    expect(fog.filters).toContain(fogBlur);
    expect(fogBlur?.strength).toBe(9);
    targetPostProcessingController.applySnapshot(createDefaultLightingSnapshot());
    expect(hero.filters).toEqual([external]);
    expect(fog.filters).toBeNull();
  });

  it('combines explicit background blur with post-processing addressed by its legacy ID', () => {
    const background = new PIXI.Container();
    state.environments.set('background', background);
    const snapshot = createDefaultLightingSnapshot();
    snapshot.blurTargets['environmentLayer:background'] = 5;
    snapshot.postProcessingTargets.background = { ...DEFAULT_POST_PROCESSING_SNAPSHOT, bloomBloomScale: 0.4 };
    targetPostProcessingController.applySnapshot(snapshot);
    expect((background.filters as PIXI.Filter[]).find((filter) => filter instanceof PIXI.BlurFilter)?.strength).toBe(5);
    expect((background.filters as PIXI.Filter[]).find((filter) => filter instanceof AdvancedBloomFilter)?.bloomScale).toBe(0.4);
    snapshot.blurTargets = {};
    targetPostProcessingController.applySnapshot(snapshot);
    expect(background.filters).toHaveLength(1);
    expect(background.filters?.[0]).toBeInstanceOf(AdvancedBloomFilter);
  });

  it('applies pending effects after entrance and clears the previous container after replacement', () => {
    const snapshot = createDefaultLightingSnapshot();
    snapshot.blurTargets.fog = 6;
    snapshot.postProcessingTargets.fog = { ...DEFAULT_POST_PROCESSING_SNAPSHOT, adjContrast: 1.2 };
    targetPostProcessingController.applySnapshot(snapshot);
    const fog = new PIXI.Container();
    state.environments.set('fog', fog);
    targetPostProcessingController.reconcilePendingTargets();
    expect(fog.filters).toHaveLength(2);
    state.environments.delete('fog');
    targetPostProcessingController.applySnapshot(snapshot);
    expect(fog.filters).toBeNull();
    const replacement = new PIXI.Container();
    state.environments.set('fog', replacement);
    targetPostProcessingController.reconcilePendingTargets();
    expect(replacement.filters).toHaveLength(2);
    targetPostProcessingController.clearAll();
    expect(replacement.filters).toBeNull();
  });

  it('waits for character filter readiness and cancels pending effects when seeking before them', () => {
    const hero = new PIXI.Container();
    state.hero = hero;
    vi.mocked(live2DManager.canApplyContainerFilters).mockReturnValue(false);
    const snapshot = createDefaultLightingSnapshot();
    snapshot.blurTargets.hero = 5;
    targetPostProcessingController.applySnapshot(snapshot);
    expect(hero.filters ?? null).toBeNull();
    vi.mocked(live2DManager.canApplyContainerFilters).mockReturnValue(true);
    targetPostProcessingController.reconcilePendingTargets();
    expect(hero.filters).toHaveLength(1);
    state.hero = null;
    targetPostProcessingController.applySnapshot(snapshot);
    targetPostProcessingController.applySnapshot(createDefaultLightingSnapshot());
    state.hero = hero;
    targetPostProcessingController.reconcilePendingTargets();
    expect(hero.filters).toBeNull();
  });

  it('resolves explicit role references when a character and environment layer share an ID', () => {
    state.hero = new PIXI.Container();
    const layer = new PIXI.Container();
    state.environments.set('hero', layer);
    const snapshot = createDefaultLightingSnapshot();
    snapshot.blurTargets = { 'character:hero': 3, 'environmentLayer:hero': 8 };
    targetPostProcessingController.applySnapshot(snapshot);
    expect((state.hero.filters as PIXI.BlurFilter[])[0].strength).toBe(3);
    expect((layer.filters as PIXI.BlurFilter[])[0].strength).toBe(8);
  });

  it.each(['raw', 'picker'] as const)('keeps colliding %s targets independent through entrance, transitions and reset', (targetSource) => {
    const options = buildLightingTargetOptions(undefined, ['hero'], ['hero'], 'blur');
    const characterTarget = targetSource === 'raw'
      ? 'hero'
      : options.find((option) => option.targetKind === 'character')?.target;
    const layerTarget = options.find((option) => option.targetKind === 'environmentLayer' && option.label === 'hero')?.target;
    if (!characterTarget || !layerTarget) throw new Error('Missing picker target');
    const document = sceneDocumentCodec.parseAndValidate({
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'colliding-lighting-targets',
      meta: { title: 'Colliding targets', characters: [{ id: 'hero', name: 'Hero' }] },
      statements: [
        { id: 'layer', type: 'environmentLayer', time: 0, params: { mode: 'set', layerId: 'hero', file: 'hero.png', durationSeconds: 0 } },
        { id: 'layer-blur', type: 'lighting', time: 0, params: { effect: 'blur', mode: 'set', target: layerTarget, intensity: 8, durationSeconds: 0 } },
        { id: 'character-blur', type: 'lighting', time: 0, params: { effect: 'blur', mode: 'set', target: characterTarget, intensity: 6, durationSeconds: 0 } },
        { id: 'entrance', type: 'characterPresence', time: 1, params: { mode: 'enter', id: 'hero', model: 'hero.model.json', durationSeconds: 0 } },
        { id: 'change', type: 'lighting', time: 2, params: { effect: 'blur', mode: 'modulate', target: 'hero', intensity: 10, durationSeconds: 2 } },
        { id: 'reset', type: 'lighting', time: 5, params: { effect: 'blur', mode: 'reset', target: characterTarget, durationSeconds: 2 } },
      ],
    });
    const timeline: RuntimeTimelineAction[] = sceneStatementCompiler.compile(document).actions.map((action) => ({ ...action, _id: action.id }));
    const layer = new PIXI.Container();
    state.environments.set('hero', layer);
    vi.mocked(live2DManager.hasCharacter).mockReturnValueOnce(false);
    targetPostProcessingController.applySnapshot(deriveLightingSnapshotAtTime(0, timeline));
    expect((layer.filters as PIXI.BlurFilter[])[0].strength).toBe(8);

    const hero = new PIXI.Container();
    state.hero = hero;
    targetPostProcessingController.reconcilePendingTargets();
    expect((hero.filters as PIXI.BlurFilter[])[0].strength).toBe(6);
    for (const [time, intensity] of [[3, 8], [6, 5], [0, 6]]) {
      targetPostProcessingController.applySnapshot(deriveLightingSnapshotAtTime(time, timeline));
      expect((hero.filters as PIXI.BlurFilter[])[0].strength).toBe(intensity);
      expect((layer.filters as PIXI.BlurFilter[])[0].strength).toBe(8);
    }
    targetPostProcessingController.applySnapshot(deriveLightingSnapshotAtTime(7, timeline));
    expect(hero.filters).toBeNull();
    expect((layer.filters as PIXI.BlurFilter[])[0].strength).toBe(8);
  });

  it('updates bloom radius on its existing filter and clears the neutral target state', () => {
    const hero = new PIXI.Container();
    state.hero = hero;
    const snapshot = snapshotForMode('normal');
    snapshot.postProcessingTargets.hero = {
      ...DEFAULT_POST_PROCESSING_SNAPSHOT,
      bloomBloomScale: 0.6,
      bloomThreshold: 0,
      bloomBlur: 20,
    };
    targetPostProcessingController.applySnapshot(snapshot);
    const bloom = (hero.filters as PIXI.Filter[]).find((filter) => filter instanceof AdvancedBloomFilter);
    expect(bloom).toMatchObject({ bloomScale: 0.6, threshold: 0, blur: 20 });

    snapshot.postProcessingTargets.hero.bloomBlur = 0;
    targetPostProcessingController.applySnapshot(snapshot);
    expect(hero.filters).toContain(bloom);
    expect(bloom).toHaveProperty('blur', 0);

    snapshot.postProcessingTargets.hero = { ...DEFAULT_POST_PROCESSING_SNAPSHOT, bloomBrightness: 0.8 };
    targetPostProcessingController.applySnapshot(snapshot);
    expect(hero.filters).toContain(bloom);
    expect(bloom).toMatchObject({ bloomScale: 0, brightness: 0.8, blur: 8 });

    snapshot.postProcessingTargets.hero = { ...DEFAULT_POST_PROCESSING_SNAPSHOT };
    targetPostProcessingController.applySnapshot(snapshot);
    expect(hero.filters).toBeNull();
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
