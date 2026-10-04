/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import {
  SCENE_SCHEMA_VERSION,
  type CurrentSceneDocument,
} from '../api/types/semantic-scene';
import {
  RuntimeAssetPreparer,
  sceneDocumentCodec,
  sceneStatementCompiler,
  validateLensFilterStatements,
  validateSemanticSceneStructure,
} from '../services/semantic-scene';
import { preparedSceneToRuntimeTimelineScene } from '../engine/PreparedRuntimeScene';
import { createPreparedFrameCaptureVisualRuntime } from '../engine/export/PreparedFrameCaptureVisualRuntime';
import {
  resolveVisualLightingOverlayAtTime,
} from '../engine/visual-runtime/VisualRuntimeResolver';
import type { VisualTimelineScene } from '../services/visual-authoring/VisualStateResolver';

function makeDocument(
  statements: CurrentSceneDocument['statements'],
  visual?: CurrentSceneDocument['visual'],
): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'lens-filter-contracts',
    meta: { title: 'Lens filter contracts' },
    ...(visual ? { visual } : {}),
    statements,
  };
}

function makeRuntimeDocument(): CurrentSceneDocument {
  return makeDocument(
    [
      {
        id: 'filter-add-optics',
        time: 0,
        type: 'filterAdd',
        params: {
          recipeId: 'builtin:soft-bloom-rgb',
          durationSeconds: 1,
        },
      },
      {
        id: 'filter-change-atmosphere',
        time: 1,
        type: 'filterChange',
        params: {
          fromRecipeId: 'builtin:soft-bloom-rgb',
          recipeId: 'builtin:haze-godray',
          durationSeconds: 1,
        },
      },
      {
        id: 'filter-reset',
        time: 2,
        type: 'filterReset',
        params: { durationSeconds: 0.5 },
      },
    ],
    {
      segments: {
        'segment:opening': {
          lensStyleBaseline: {
            grade: { recipeId: 'builtin:cinematic-cold' },
          },
        },
      },
    },
  );
}

describe('v3 lens filter source contracts', () => {
  it('accepts filterAdd, filterChange, and filterReset and derives runtime categories', () => {
    const document = sceneDocumentCodec.parseAndValidate(makeDocument([
      {
        id: 'add-grade',
        time: 0,
        type: 'filterAdd',
        params: { recipeId: 'builtin:default-grade', durationSeconds: 0.6 },
      },
      {
        id: 'change-atmosphere',
        time: 1,
        type: 'filterChange',
        params: {
          fromRecipeId: 'builtin:default-grade',
          recipeId: 'builtin:haze-godray',
          durationSeconds: 0.6,
        },
      },
      {
        id: 'reset-all',
        time: 2,
        type: 'filterReset',
        params: { durationSeconds: 0.4 },
      },
    ]));

    expect(document.statements.map((statement) => statement.type)).toEqual([
      'filterAdd',
      'filterChange',
      'filterReset',
    ]);

    const compiled = sceneStatementCompiler.compile(document);
    expect(compiled.actions.map((action) => action.action)).toEqual([
      'addLensFilter',
      'changeLensFilter',
      'resetLensFilters',
    ]);
    expect(compiled.actions[0].params).toMatchObject({
      category: 'grade',
      recipeId: 'builtin:default-grade',
      duration: 0.6,
    });
    expect(compiled.actions[1].params).toMatchObject({
      fromCategory: 'grade',
      category: 'atmosphere',
      fromRecipeId: 'builtin:default-grade',
      recipeId: 'builtin:haze-godray',
    });
    expect(compiled.actions[2].params).toEqual({ duration: 0.4 });
  });

  it('strictly rejects older documents and lens-scoped visualStyle source', () => {
    expect(() => sceneDocumentCodec.parseAndValidate({
      ...makeDocument([]),
      schemaVersion: 2,
    } as never)).toThrow(/Unsupported scene schema version.*older scene schemas must be migrated offline/i);

    expect(() => sceneDocumentCodec.parseAndValidate(makeDocument([
      {
        id: 'legacy-lens-style',
        time: 0,
        type: 'visualStyle',
        params: {
          scope: 'lens',
          slot: 'grade',
          mode: 'set',
          recipeId: 'builtin:default-grade',
        } as never,
      },
    ]))).toThrow(/Lens visualStyle is not supported.*filterAdd\/filterChange\/filterReset/);

    expect(() => sceneDocumentCodec.parseAndValidate(makeDocument([
      {
        id: 'category-in-source',
        time: 0,
        type: 'filterAdd',
        params: {
          recipeId: 'builtin:default-grade',
          category: 'grade',
        } as never,
      },
    ]))).toThrow(/Unknown field .*params\.category/);
  });
});

describe('lens filter semantic validation', () => {
  it('reports duplicate add categories, missing current filters, and target conflicts', () => {
    const document = makeDocument([
      {
        id: 'add-grade',
        time: 0,
        type: 'filterAdd',
        params: { recipeId: 'builtin:default-grade' },
      },
      {
        id: 'duplicate-grade',
        time: 1,
        type: 'filterAdd',
        params: { recipeId: 'builtin:cinematic-grade' },
      },
      {
        id: 'add-atmosphere',
        time: 2,
        type: 'filterAdd',
        params: { recipeId: 'builtin:haze-godray' },
      },
      {
        id: 'missing-current',
        time: 3,
        type: 'filterChange',
        params: {
          fromRecipeId: 'builtin:film-grain',
          recipeId: 'builtin:soft-bloom-rgb',
        },
      },
      {
        id: 'target-conflict',
        time: 4,
        type: 'filterChange',
        params: {
          fromRecipeId: 'builtin:default-grade',
          recipeId: 'builtin:haze-godray',
        },
      },
    ]);

    const issues = validateLensFilterStatements(document);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ statementId: 'duplicate-grade', message: expect.stringContaining('已有滤镜') }),
      expect.objectContaining({ statementId: 'missing-current', message: expect.stringContaining('当前滤镜不存在') }),
      expect.objectContaining({ statementId: 'target-conflict', message: expect.stringContaining('已有其他滤镜') }),
    ]));
    expect(validateSemanticSceneStructure(document)).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionId: 'target-conflict', severity: 'error' }),
    ]));
  });
});

describe('lens filter runtime parity', () => {
  it('resolves transition start, middle, end, seek, and reset baseline deterministically', () => {
    const source = sceneDocumentCodec.parseAndValidate(makeRuntimeDocument());
    const compiled = sceneStatementCompiler.compile(source);
    const scene: VisualTimelineScene = {
      meta: compiled.meta,
      visual: compiled.visual,
      timeline: compiled.actions,
    };

    const addStart = resolveVisualLightingOverlayAtTime(scene, 0);
    const addMiddle = resolveVisualLightingOverlayAtTime(scene, 0.5);
    const addEnd = resolveVisualLightingOverlayAtTime(scene, 1);
    expect(addStart?.postProcessing.bloomBloomScale ?? 0).toBe(0);
    expect(addMiddle?.postProcessing.bloomBloomScale ?? 0).toBeGreaterThan(0);
    expect(addMiddle?.postProcessing.bloomBloomScale ?? 0).toBeLessThan(addEnd?.postProcessing.bloomBloomScale ?? 0);

    const changeStart = resolveVisualLightingOverlayAtTime(scene, 1);
    const changeMiddle = resolveVisualLightingOverlayAtTime(scene, 1.5);
    const changeEnd = resolveVisualLightingOverlayAtTime(scene, 2);
    expect(changeStart?.postProcessing.rgbSplitX ?? 0).toBeGreaterThan(0);
    expect(changeMiddle?.postProcessing.rgbSplitX ?? 0).toBeGreaterThan(0);
    expect(changeMiddle?.postProcessing.godrayGain ?? 0).toBeGreaterThan(0);
    expect(changeEnd?.postProcessing.godrayGain ?? 0).toBeGreaterThan(0);

    const baseline = resolveVisualLightingOverlayAtTime(scene, -1);
    const resetMiddle = resolveVisualLightingOverlayAtTime(scene, 2.25);
    const resetEnd = resolveVisualLightingOverlayAtTime(scene, 2.5);
    expect(resetMiddle?.postProcessing.godrayGain ?? 0).toBeGreaterThan(0);
    expect(resetMiddle?.postProcessing.godrayGain ?? 0).toBeLessThan(changeEnd?.postProcessing.godrayGain ?? 0);
    expect(resetEnd).toEqual(baseline);

    const beforeSeek = resolveVisualLightingOverlayAtTime(scene, 1.5);
    resolveVisualLightingOverlayAtTime(scene, 2.5);
    const afterSeek = resolveVisualLightingOverlayAtTime(scene, 1.5);
    expect(afterSeek).toEqual(beforeSeek);
  });

  it('uses the same visual resolver for prepared preview and export capture', async () => {
    const source = sceneDocumentCodec.parseAndValidate(makeRuntimeDocument());
    const compiled = sceneStatementCompiler.compile(source);
    const prepared = await new RuntimeAssetPreparer((asset) => asset).prepare(compiled);
    const runtimeScene = preparedSceneToRuntimeTimelineScene(prepared) as unknown as VisualTimelineScene;
    const captureRuntime = createPreparedFrameCaptureVisualRuntime(prepared);

    for (const time of [0, 0.5, 1.5, 2.25, 2.5]) {
      expect(captureRuntime.resolveLightingOverlayAtTime(time)).toEqual(
        resolveVisualLightingOverlayAtTime(runtimeScene, time),
      );
    }
  });
});
