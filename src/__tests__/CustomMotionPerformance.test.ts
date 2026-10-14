import { describe, expect, it, vi } from 'vitest';
import type { CharacterMotionOutput, CurrentSceneDocument, CustomMotionKeyframe } from '../api/types/semantic-scene';
import { SCENE_SCHEMA_VERSION } from '../api/types/semantic-scene';
import { evaluateCustomMotionRuntime } from '../engine/live2d/customMotionRuntime';
import { DocumentStore } from '../ui/store/DocumentStore';
import { sceneDocumentCodec } from '../services/semantic-scene/SceneDocumentCodec';
import { getSceneDocumentCanonicalOrder } from '../services/semantic-scene/SceneDocumentCanonicalOrder';
import { customMotionFingerprint } from '../services/timeline-authoring/customMotionKeyframeEdits';
import { solveBezierTime } from '../engine/live2d/customMotion';
import { SceneDocumentCodec } from '../services/semantic-scene/SceneDocumentCodec';
import { SemanticScenePipeline } from '../services/semantic-scene/SemanticScenePipeline';
import { RuntimeAssetPreparer } from '../services/semantic-scene/RuntimeAssetPreparer';

describe('large custom motion work bounds', () => {
  it('prepares immutable inline motion trees once and shares them with runtime', async () => {
    const codec = new SceneDocumentCodec();
    const parse = vi.spyOn(codec, 'parseAndValidate');
    const resolveAsset = vi.fn((source: string) => source);
    const motion = {
      kind: 'custom' as const, durationSeconds: 2, fadeInSeconds: 0.5, derivedFrom: { key: 'source' },
      tracks: [{ parameterId: 'ParamAngleX', keyframes: [{ time: 0, value: 0, segment: { type: 'linear' as const } }, { time: 2, value: 1 }] }],
    };
    const input = {
      schemaVersion: SCENE_SCHEMA_VERSION, sceneId: 'inline-scene', meta: { title: 'Inline' },
      statements: [{ id: 'motion', time: 0, type: 'characterPerformance' as const, params: { target: 'actor', motion } }],
    };
    const pipeline = new SemanticScenePipeline({ codec, resolveAsset });
    const bundle = await pipeline.processDocument(input);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(bundle.prepared.actions[0].params.motion).toBe(bundle.compiled.actions[0].params.motion);
    expect(bundle.compiled.actions[0].params.motion).not.toBe(motion);
    expect(resolveAsset).not.toHaveBeenCalled();
    motion.tracks[0].keyframes[0].value = 99;
    expect(bundle.prepared.actions[0].params.motion).toMatchObject({ tracks: [{ keyframes: [{ value: 0 }, { value: 1 }] }] });

    const prepareSource = vi.fn((document: CurrentSceneDocument) => ({ ...document, meta: { ...document.meta, title: 'Ready' } }));
    parse.mockClear();
    await new SemanticScenePipeline({ codec, resolveAsset, prepareSource }).processDocument(input);
    expect(parse).toHaveBeenCalledTimes(2);

    const nested = { ...bundle.compiled, actions: [{ ...bundle.compiled.actions[0],
      params: { data: { file: 'asset.png', values: [1, 2] } },
      assetSlots: [{ path: 'params.data.file', kind: 'generic' as const }],
    }] };
    const prepared = await new RuntimeAssetPreparer(source => `runtime://${source}`).prepare(nested);
    expect(prepared.actions[0].params.data).toEqual({ file: { source: 'asset.png', runtimeUri: 'runtime://asset.png' }, values: [1, 2] });
    expect(nested.actions[0].params.data.file).toBe('asset.png');
    expect(Object.isFrozen(nested.actions[0].params.data.values)).toBe(false);
  });

  it('serves frozen scene views without a document parse or copy and replaces them on writes', () => {
    const store = new DocumentStore();
    const makeDocument = (title: string) => ({
      schemaVersion: SCENE_SCHEMA_VERSION, sceneId: 'large-scene', meta: { title },
      statements: Array.from({ length: 100 }, (_, index) => ({
        id: `line-${index}`, time: index, type: 'dialogue' as const,
        params: { text: 'A line', durationSeconds: 1 },
      })),
    });
    expect(store.getCurrentSceneDocumentView()).toBeNull();
    store._replaceCurrentSceneDocumentSnapshot(makeDocument('First'));
    const save = vi.spyOn(sceneDocumentCodec, 'prepareForSave');
    try {
      const first = store.getCurrentSceneDocumentView()!;
      for (let repeat = 0; repeat < 100; repeat++) expect(store.getCurrentSceneDocumentView()).toBe(first);
      expect(save).not.toHaveBeenCalled();
      expect(Object.isFrozen(first.statements[0].params)).toBe(true);
      expect(getSceneDocumentCanonicalOrder(first)).toEqual(first.statements.map(statement => statement.id));
      store._replaceCurrentSceneDocumentSnapshot(makeDocument('Second'));
      expect(store.getCurrentSceneDocumentView()).not.toBe(first);
      expect(first.meta.title).toBe('First');
      expect(store.getCurrentSceneDocumentView()?.meta.title).toBe('Second');
      store._clearCurrentSceneDocumentSnapshot();
      expect(store.getCurrentSceneDocumentView()).toBeNull();
    } finally { save.mockRestore(); }
  });

  it('does not rescan immutable dense keys on each fade frame', () => {
    let valueReads = 0;
    const keyframes: CustomMotionKeyframe[] = Array.from({ length: 457 }, (_, index) => Object.freeze({
      time: index / 60,
      get value() { valueReads++; return index / 456; },
      ...(index < 456 ? { segment: Object.freeze({ type: 'linear' as const }) } : {}),
    }));
    const motion: Extract<CharacterMotionOutput, { kind: 'custom' }> = Object.freeze({
      kind: 'custom', durationSeconds: 7.6, fadeInSeconds: 1, derivedFrom: Object.freeze({ key: 'dense' }),
      tracks: Object.freeze([Object.freeze({ parameterId: 'ParamAngleX', keyframes: Object.freeze(keyframes) })]),
    });
    const handoff = { values: {} };
    evaluateCustomMotionRuntime(motion, 0, 0.2, handoff);
    valueReads = 0;
    for (let repeat = 0; repeat < 10; repeat++) evaluateCustomMotionRuntime(motion, 0, 0.2, handoff);
    expect(valueReads).toBeLessThan(50);
  });

  it('invalidates fades and fingerprints when descendants of a shallow-frozen motion change', () => {
    const point = { time: 0, value: 1, segment: { type: 'linear' as const } };
    const motion: Extract<CharacterMotionOutput, { kind: 'custom' }> = Object.freeze({
      kind: 'custom', durationSeconds: 2, fadeInSeconds: 1, derivedFrom: { key: 'mutable' },
      tracks: [{ parameterId: 'ParamAngleX', keyframes: [point, { time: 2, value: 1 }] }],
    });
    const handoff = { values: { ParamAngleX: 0 } };
    const before = evaluateCustomMotionRuntime(motion, 0, 0.2, handoff).values.ParamAngleX;
    const fingerprint = customMotionFingerprint(motion);
    point.value = 20;
    expect(customMotionFingerprint(motion)).not.toBe(fingerprint);
    expect(evaluateCustomMotionRuntime(motion, 0, 0.2, handoff).values.ParamAngleX).toBeGreaterThan(before!);
  });

  it('preserves restricted and unrestricted Bezier time coordinates including flat derivatives', () => {
    const current = { time: 10, value: 0 };
    const next = { time: 12, value: 1 };
    const cubic = (t: number, p1: number, p2: number) => (1 - t) ** 3 * 10
      + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * 12;
    for (const [p1, p2] of [[10 + 2 / 3, 10 + 4 / 3], [10, 10], [12, 12], [10.01, 11.8]]) {
      for (const progress of [0.001, 0.1, 0.25, 0.5, 0.9, 0.999]) {
        const target = cubic(progress, p1, p2);
        const solved = solveBezierTime(current, { time: p1, value: 0 }, { time: p2, value: 1 }, next, target);
        expect(cubic(solved, p1, p2)).toBeCloseTo(target, 8);
      }
    }
  });
});
