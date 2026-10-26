import type { LightingTarget } from '../api/types/lighting-target';
import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION, type LightingParams } from '../api/types/semantic-scene';
import {
  sceneDocumentCodec,
  sceneStatementCompiler,
  sceneStatementDefinitionRegistry,
  validateSemanticSceneStructure,
} from '../services/semantic-scene';
import { createDefaultLightingSnapshot, deriveLightingSnapshotAtTime, normalizeLightingSnapshot } from '../engine/LightingSnapshot';
import { createSemanticStatementDraftForBlock } from '../ui/timeline/semanticStatementBlocks';
import { buildLifecyclePairTable, resolveLifecyclePair } from '../ui/timeline/lifecyclePairing';
import { resolveLifecycleTargetBinding } from '../ui/timeline/lifecycleTargetBinding';

function makeDocument(effects: readonly { time: number; params: LightingParams }[]) {
  return sceneDocumentCodec.parseAndValidate({
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'flexible-lighting-targets',
    meta: { title: 'Flexible lighting targets', characters: [{ id: 'hero', name: '主角' }] },
    statements: [
      { id: 'fog-layer', time: 0, type: 'environmentLayer', params: { mode: 'set', layerId: 'fog', label: '前景雾', file: 'fog.png' } },
      ...effects.map((effect, index) => ({ id: `effect-${index}`, type: 'lighting', ...effect })),
    ],
  });
}

describe('flexible lighting targets', () => {
  it.each(['character', 'environmentLayer'] as const)('resolves the raw blur target all as a %s ID without resetting other objects', (kind) => {
    const source = makeDocument([
      { time: 0, params: { effect: 'blur', mode: 'set', target: 'fog', intensity: 6, durationSeconds: 0 } },
      { time: 0, params: { effect: 'blur', mode: 'set', target: 'all', intensity: 8, durationSeconds: 0 } },
      { time: 1, params: { effect: 'blur', mode: 'modulate', target: 'all', intensity: 12, durationSeconds: 2 } },
      { time: 4, params: { effect: 'blur', mode: 'reset', target: 'all', durationSeconds: 2 } },
    ]);
    const document = sceneDocumentCodec.parseAndValidate({
      ...source,
      meta: {
        ...source.meta,
        characters: kind === 'character' ? [{ id: 'all', name: 'All' }] : [],
      },
      statements: [
        { id: 'all-layer', time: 0, type: 'environmentLayer', params: { mode: 'set', layerId: 'all', file: 'all.png' } },
        ...source.statements,
      ],
    });
    expect(validateSemanticSceneStructure(document).filter((issue) => issue.code?.includes('lighting'))).toEqual([]);
    const timeline = sceneStatementCompiler.compile(document).actions.map((action) => ({ ...action, _id: action.id }));
    for (const [time, intensity] of [[0, 8], [2, 10], [5, 6], [6, 0]]) {
      const snapshot = deriveLightingSnapshotAtTime(time, timeline);
      expect(snapshot.blurTargets).toEqual({ 'environmentLayer:fog': 6, [`${kind}:all`]: intensity });
      expect(snapshot.blur).toEqual({ global: 0, background: 0, characters: 0 });
    }
  });

  describe.each(['blur', 'post'] as const)('%s target aliases', (effect) => {
    const aliases: readonly (readonly [LightingTarget, LightingTarget])[] = [
      ['hero', { kind: 'character', id: 'hero' }],
      [{ kind: 'character', id: 'hero' }, 'hero'],
      ['fog', { kind: 'environmentLayer', id: 'fog' }],
      [{ kind: 'environmentLayer', id: 'fog' }, 'fog'],
      ...(effect === 'blur' ? [
        ['characters', { kind: 'group', group: 'characters' }],
        [{ kind: 'group', group: 'characters' }, 'characters'],
        ['background', { kind: 'group', group: 'environmentLayers' }],
        [{ kind: 'group', group: 'environmentLayers' }, 'background'],
      ] as const : [
        ['background', { kind: 'environmentLayer', id: 'background' }],
        [{ kind: 'environmentLayer', id: 'background' }, 'background'],
      ] as const),
    ];
    function makeResetDocument(first: LightingTarget, second: LightingTarget) {
      return makeDocument([
        { time: 0, params: { effect, mode: 'set', target: first, durationSeconds: 0 } },
        { time: 1, params: { effect, mode: 'reset', target: second, durationSeconds: 0 } },
      ]);
    }

    it.each(aliases)('validates a set on %s followed by a reset on %s', (first, second) => {
      const document = makeResetDocument(first, second);
      expect(validateSemanticSceneStructure(document).filter((issue) => issue.code?.includes('lighting'))).toEqual([]);
    });

    it.each(aliases)('pairs a set on %s with a reset on %s', (first, second) => {
      const table = buildLifecyclePairTable(makeResetDocument(first, second));
      expect(resolveLifecyclePair(table, 'effect-0')).toMatchObject({ status: 'paired', peerId: 'effect-1' });
      expect(resolveLifecyclePair(table, 'effect-1')).toMatchObject({ status: 'paired', peerId: 'effect-0' });
    });

    it.each(aliases)('binds a change on %s to its active span through %s', (first, second) => {
      const document = makeResetDocument(first, second);
      const binding = resolveLifecycleTargetBinding(document, `lighting.modulate-${effect}`, 0.5, {
        sceneMeta: document.meta,
        lightingTarget: second,
      });
      expect(binding?.targetStart.statementId).toBe('effect-0');
      expect(binding?.statement).toMatchObject({ type: 'lighting', params: { effect, mode: 'modulate', target: first } });
    });
  });

  it.each([
    ['characters', { kind: 'group', group: 'characters' }, 'characters'],
    [{ kind: 'group', group: 'characters' }, 'characters', 'characters'],
    ['background', { kind: 'group', group: 'environmentLayers' }, 'background'],
    [{ kind: 'group', group: 'environmentLayers' }, 'background', 'background'],
  ] as const)('shares group blur transitions and resets across %s and %s', (first, second, channel) => {
    const document = makeDocument([
      { time: 0, params: { effect: 'blur', mode: 'set', target: first, intensity: 8, durationSeconds: 0 } },
      { time: 1, params: { effect: 'blur', mode: 'modulate', target: second, intensity: 12, durationSeconds: 2 } },
      { time: 4, params: { effect: 'blur', mode: 'reset', target: second, durationSeconds: 2 } },
    ]);
    const timeline = sceneStatementCompiler.compile(document).actions.map((action) => ({ ...action, _id: action.id }));
    for (const [time, intensity] of [[0, 8], [2, 10], [5, 6], [6, 0]]) {
      const snapshot = deriveLightingSnapshotAtTime(time, timeline);
      expect(snapshot.blur[channel]).toBe(intensity);
      expect(snapshot.blurTargets).toEqual({});
    }
  });

  it.each(['blur', 'post'] as const)('keeps %s on a character separate from an environment layer with the same ID', (effect) => {
    const source = makeDocument([
      { time: 0, params: { effect, mode: 'set', target: 'hero', durationSeconds: 0 } },
      { time: 0, params: { effect, mode: 'set', target: { kind: 'environmentLayer', id: 'hero' }, durationSeconds: 0 } },
      { time: 1, params: { effect, mode: 'reset', target: { kind: 'character', id: 'hero' }, durationSeconds: 0 } },
      { time: 2, params: { effect, mode: 'reset', target: { kind: 'environmentLayer', id: 'hero' }, durationSeconds: 0 } },
    ]);
    const document = sceneDocumentCodec.parseAndValidate({
      ...source,
      statements: [
        { id: 'hero-layer', time: 0, type: 'environmentLayer', params: { mode: 'set', layerId: 'hero', file: 'hero.png' } },
        ...source.statements,
      ],
    });
    expect(validateSemanticSceneStructure(document).filter((issue) => issue.code?.includes('lighting'))).toEqual([]);
    const table = buildLifecyclePairTable(document);
    expect(resolveLifecyclePair(table, 'effect-0')).toMatchObject({ status: 'paired', peerId: 'effect-2' });
    expect(resolveLifecyclePair(table, 'effect-1')).toMatchObject({ status: 'paired', peerId: 'effect-3' });
    const binding = resolveLifecycleTargetBinding(document, `lighting.modulate-${effect}`, 0.5, {
      sceneMeta: document.meta,
      lightingTarget: { kind: 'environmentLayer', id: 'hero' },
    });
    expect(binding?.targetStart.statementId).toBe('effect-1');
  });

  it.each([
    ['hero', { kind: 'character', id: 'hero' }],
    ['fog', { kind: 'environmentLayer', id: 'fog' }],
  ] as const)('resets the latest blur value when %s and %s refer to the same object', (raw, explicit) => {
    const document = makeDocument([
      { time: 0, params: { effect: 'blur', mode: 'set', target: raw, intensity: 8, durationSeconds: 0 } },
      { time: 1, params: { effect: 'blur', mode: 'set', target: explicit, intensity: 6, durationSeconds: 0 } },
      { time: 2, params: { effect: 'blur', mode: 'reset', target: raw, durationSeconds: 0 } },
    ]);
    const timeline = sceneStatementCompiler.compile(document).actions.map((action) => ({ ...action, _id: action.id }));
    expect(Object.values(deriveLightingSnapshotAtTime(1, timeline).blurTargets)).toEqual([6]);
    expect(Object.values(deriveLightingSnapshotAtTime(2, timeline).blurTargets)).toEqual([0]);
  });

  it.each(['blur', 'post'] as const)('retains %s for a declared character without an entrance when an environment layer shares its ID', (effect) => {
    const source = makeDocument([
      { time: 0, params: { mode: 'set', target: 'hero', ...(effect === 'blur' ? { effect, intensity: 8 } : { effect, adjContrast: 2 }), durationSeconds: 0 } },
      { time: 1, params: { mode: 'modulate', target: { kind: 'character', id: 'hero' }, ...(effect === 'blur' ? { effect, intensity: 12 } : { effect, adjContrast: 4 }), durationSeconds: 2 } },
      { time: 4, params: { effect, mode: 'reset', target: 'hero', durationSeconds: 2 } },
    ]);
    const document = sceneDocumentCodec.parseAndValidate({
      ...source,
      statements: [
        { id: 'hero-layer', time: 0, type: 'environmentLayer', params: { mode: 'set', layerId: 'hero', file: 'hero.png' } },
        ...source.statements,
      ],
    });
    const timeline = sceneStatementCompiler.compile(document).actions.map((action) => ({ ...action, _id: action.id }));
    for (const [time, intensity, adjContrast] of [[0, 8, 2], [2, 10, 3], [5, 6, 2.5], [6, 0, 1]]) {
      const snapshot = deriveLightingSnapshotAtTime(time, timeline);
      if (effect === 'blur') {
        expect(snapshot.blurTargets).toEqual({ 'character:hero': intensity });
      } else {
        expect(snapshot.postProcessingTargets).toEqual({ 'character:hero': expect.objectContaining({ adjContrast }) });
      }
    }
  });

  it.each([
    ['hero', { kind: 'character', id: 'hero' }],
    [{ kind: 'character', id: 'hero' }, 'hero'],
    ['fog', { kind: 'environmentLayer', id: 'fog' }],
    [{ kind: 'environmentLayer', id: 'fog' }, 'fog'],
  ] as const)('continues blur transitions and resets across aliases %s and %s', (first, second) => {
    const document = makeDocument([
      { time: 0, params: { effect: 'blur', mode: 'set', target: first, intensity: 8, durationSeconds: 0 } },
      { time: 1, params: { effect: 'blur', mode: 'modulate', target: second, intensity: 12, durationSeconds: 2 } },
      { time: 4, params: { effect: 'blur', mode: 'reset', target: first, durationSeconds: 2 } },
    ]);
    const timeline = sceneStatementCompiler.compile(document).actions.map((action) => ({ ...action, _id: action.id }));
    for (const [time, intensity] of [[2, 10], [5, 6], [6, 0], [0, 8]]) {
      expect(Object.values(deriveLightingSnapshotAtTime(time, timeline).blurTargets)).toEqual([intensity]);
    }
  });

  it.each([
    ['hero', { kind: 'character', id: 'hero' }],
    [{ kind: 'character', id: 'hero' }, 'hero'],
    ['fog', { kind: 'environmentLayer', id: 'fog' }],
    [{ kind: 'environmentLayer', id: 'fog' }, 'fog'],
    ['background', { kind: 'environmentLayer', id: 'background' }],
  ] as const)('shares post-processing transitions and resets across aliases %s and %s', (first, second) => {
    const document = makeDocument([
      { time: 0, params: { effect: 'post', mode: 'set', target: first, adjContrast: 2, adjSaturation: 0.5, durationSeconds: 0 } },
      { time: 1, params: { effect: 'post', mode: 'modulate', target: second, adjContrast: 4, durationSeconds: 2 } },
      { time: 4, params: { effect: 'post', mode: 'reset', target: first, durationSeconds: 2 } },
    ]);
    const timeline = sceneStatementCompiler.compile(document).actions.map((action) => ({ ...action, _id: action.id }));
    for (const [time, adjContrast, adjSaturation] of [[2, 3, 0.5], [5, 2.5, 0.75], [6, 1, 1], [0, 2, 0.5]]) {
      expect(Object.values(deriveLightingSnapshotAtTime(time, timeline).postProcessingTargets))
        .toEqual([expect.objectContaining({ adjContrast, adjSaturation })]);
    }
  });

  it('round-trips and transitions group post-processing independently of individual layers', () => {
    const document = makeDocument([
      { time: 0, params: { effect: 'post', mode: 'set', target: { kind: 'group', group: 'environmentLayers' }, adjContrast: 1.2, durationSeconds: 0 } },
      { time: 0, params: { effect: 'post', mode: 'set', target: { kind: 'group', group: 'characters' }, adjSaturation: 0.7, durationSeconds: 0 } },
      { time: 0, params: { effect: 'post', mode: 'set', target: 'fog', adjContrast: 1.8, durationSeconds: 0 } },
      { time: 1, params: { effect: 'post', mode: 'modulate', target: { kind: 'group', group: 'environmentLayers' }, adjContrast: 1.6, durationSeconds: 2 } },
      { time: 4, params: { effect: 'post', mode: 'reset', target: { kind: 'group', group: 'environmentLayers' }, durationSeconds: 2 } },
    ]);
    const reloaded = sceneDocumentCodec.parseAndValidate(JSON.parse(JSON.stringify(sceneDocumentCodec.prepareForSave(document))));
    expect(validateSemanticSceneStructure(reloaded).filter((issue) => issue.code?.includes('lighting'))).toEqual([]);
    const timeline = sceneStatementCompiler.compile(reloaded).actions.map((action) => ({ ...action, _id: action.id }));
    expect(deriveLightingSnapshotAtTime(2, timeline).postProcessingTargets['group:environmentLayers'].adjContrast).toBeCloseTo(1.4);
    const resetting = deriveLightingSnapshotAtTime(5, timeline);
    expect(resetting.postProcessingTargets['group:environmentLayers'].adjContrast).toBeCloseTo(1.3);
    expect(resetting.postProcessingTargets['group:characters'].adjSaturation).toBe(0.7);
    expect(resetting.postProcessingTargets['environmentLayer:fog'].adjContrast).toBe(1.8);
  });

  it('round-trips per-object blur and reconstructs independent transitions and resets at any time', () => {
    const document = makeDocument([
      { time: 0, params: { effect: 'blur', mode: 'set', target: 'global', intensity: 2, durationSeconds: 0 } },
      { time: 0, params: { effect: 'blur', mode: 'set', target: 'hero', intensity: 8, durationSeconds: 0 } },
      { time: 0, params: { effect: 'blur', mode: 'set', target: 'fog', intensity: 6, durationSeconds: 0 } },
      { time: 0, params: { effect: 'post', mode: 'set', target: 'fog', adjContrast: 1.3, durationSeconds: 0 } },
      { time: 1, params: { effect: 'blur', mode: 'modulate', target: 'hero', intensity: 12, durationSeconds: 2 } },
      { time: 4, params: { effect: 'blur', mode: 'reset', target: 'hero', durationSeconds: 2 } },
    ]);
    const saved = sceneDocumentCodec.prepareForSave(document);
    const reloaded = sceneDocumentCodec.parseAndValidate(JSON.parse(JSON.stringify(saved)));
    expect(reloaded.statements).toEqual(document.statements);
    const timeline = sceneStatementCompiler.compile(reloaded).actions.map((action) => ({ ...action, _id: action.id }));
    for (const [time, hero] of [[2, 10], [5, 6], [6, 0], [0, 8], [3, 12]]) {
      const snapshot = deriveLightingSnapshotAtTime(time, timeline);
      expect(snapshot.blurTargets).toEqual({ 'character:hero': hero, 'environmentLayer:fog': 6 });
      expect(snapshot.blur).toEqual({ global: 2, background: 0, characters: 0 });
      expect(snapshot.postProcessingTargets['environmentLayer:fog'].adjContrast).toBe(1.3);
    }
    expect(validateSemanticSceneStructure(reloaded).filter((issue) => issue.code?.includes('lighting'))).toEqual([]);
  });

  it('preserves legacy group blur and resets all object channels for a legacy untargeted reset', () => {
    const document = makeDocument([
      { time: 0, params: { effect: 'blur', mode: 'set', target: 'background', intensity: 3 } },
      { time: 0, params: { effect: 'blur', mode: 'set', target: 'characters', intensity: 4 } },
      { time: 0, params: { effect: 'blur', mode: 'set', target: { kind: 'environmentLayer', id: 'background' }, intensity: 5 } },
      { time: 0, params: { effect: 'blur', mode: 'set', target: 'hero', intensity: 7 } },
      { time: 1, params: { effect: 'blur', mode: 'reset', durationSeconds: 2 } },
    ]);
    const timeline = sceneStatementCompiler.compile(document).actions.map((action) => ({ ...action, _id: action.id }));
    expect(deriveLightingSnapshotAtTime(0, timeline).blur).toEqual({ global: 0, background: 3, characters: 4 });
    expect(deriveLightingSnapshotAtTime(2, timeline).blurTargets).toEqual({ 'environmentLayer:background': 2.5, 'character:hero': 3.5 });
    expect(deriveLightingSnapshotAtTime(3, timeline).blur).toEqual({ global: 0, background: 0, characters: 0 });
    expect(deriveLightingSnapshotAtTime(3, timeline).blurTargets).toEqual({ 'environmentLayer:background': 0, 'character:hero': 0 });
  });

  it('accepts explicit role references and diagnoses missing blur and post targets', () => {
    const document = makeDocument([
      { time: 0, params: { effect: 'blur', mode: 'set', target: { kind: 'character', id: 'hero' }, intensity: 3 } },
      { time: 0, params: { effect: 'blur', mode: 'set', target: { kind: 'environmentLayer', id: 'background' }, intensity: 4 } },
      { time: 0, params: { effect: 'post', mode: 'set', target: { kind: 'environmentLayer', id: 'fog' }, adjGamma: 1.2 } },
      { time: 1, params: { effect: 'blur', mode: 'set', target: 'missing', intensity: 4 } },
      { time: 1, params: { effect: 'post', mode: 'set', target: { kind: 'environmentLayer', id: 'missing' }, adjGamma: 1.2 } },
    ]);
    expect(validateSemanticSceneStructure(document).filter((issue) => issue.code?.includes('target-unknown')).map((issue) => issue.code))
      .toEqual(['semantic.lighting.blur.target-unknown', 'semantic.lighting.post.target-unknown']);
  });

  it('pairs default blur spans and retains arbitrary targets in change/reset drafts', () => {
    const implicit = { type: 'lighting' as const, params: { effect: 'blur' as const, mode: 'set' as const } };
    const explicit = { type: 'lighting' as const, params: { ...implicit.params, target: 'global' } };
    expect(sceneStatementDefinitionRegistry.timelineLifecyclePresentation(implicit)?.stateKey)
      .toBe(sceneStatementDefinitionRegistry.timelineLifecyclePresentation(explicit)?.stateKey);
    for (const target of ['hero', 'fog', 'environmentLayer:background']) {
      for (const block of ['lighting.blur', 'lighting.modulate-blur', 'lighting.reset-blur']) {
        expect(createSemanticStatementDraftForBlock(block, { stateTarget: target })).toMatchObject({ params: { target } });
      }
    }
  });

  it('normalizes object blur without retaining negative or non-finite intensities', () => {
    const snapshot = createDefaultLightingSnapshot();
    snapshot.blurTargets = { hero: 4, fog: -2, invalid: Number.NaN };
    expect(normalizeLightingSnapshot(snapshot).blurTargets).toEqual({ hero: 4, fog: 0, invalid: 0 });
    const legacy = { ...snapshot };
    Reflect.deleteProperty(legacy, 'blurTargets');
    expect(normalizeLightingSnapshot(legacy).blurTargets).toEqual({});
  });
});
