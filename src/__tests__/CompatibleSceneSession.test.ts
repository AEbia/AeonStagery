import { describe, expect, it } from 'vitest';
import type { SceneDocumentV5 } from '../api/types/semantic-scene';
import { CompatibleSceneSession } from '../services/semantic-scene';

function makeScene(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 5,
    sceneId: 'scene-compatible-v5',
    meta: { title: 'Compatible scene' },
    statements: [],
    ...overrides,
  };
}

describe('CompatibleSceneSession', () => {
  it('preserves representative unknown fields through a typed edit and save', () => {
    const source = makeScene({
      futureRoot: { retained: true },
      meta: {
        title: 'Compatible scene',
        futureMeta: 'retained',
      },
      statements: [{
        id: 'dialogue-1',
        time: 0,
        type: 'dialogue',
        futureStatement: 41,
        params: {
          text: 'Before edit',
          durationSeconds: 2,
          futureParams: { retained: true },
        },
        companions: [{
          id: 'camera-1',
          anchor: 'start',
          offset: 0,
          type: 'camera',
          futureCompanion: 'retained',
          params: {
            mode: 'focus',
            target: 'hero',
            zoom: {
              kind: 'absolute',
              value: 1.2,
              futureNestedField: 'retained',
            },
            futureCompanionParams: true,
          },
        }],
      }],
    });

    const outcome = CompatibleSceneSession.open(source);
    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') throw new Error('Expected scene to be ready');

    expect(outcome.session.projection).not.toHaveProperty('futureRoot');
    expect(outcome.session.projection.meta).not.toHaveProperty('futureMeta');
    expect(outcome.session.projection.statements[0]).not.toHaveProperty('futureStatement');
    expect(outcome.session.projection.statements[0].params).not.toHaveProperty('futureParams');

    const statement = outcome.session.projection.statements[0];
    if (statement.type !== 'dialogue') throw new Error('Expected dialogue projection');
    const edited: SceneDocumentV5 = {
      ...outcome.session.projection,
      statements: [{
        ...statement,
        params: { ...statement.params, text: 'After edit' },
      }],
    };
    outcome.session.applyTypedEdit(edited);

    expect(outcome.session.serialize()).toEqual({
      ...source,
      statements: [{
        ...(source.statements as Array<Record<string, unknown>>)[0],
        params: {
          ...((source.statements as Array<Record<string, unknown>>)[0].params as Record<string, unknown>),
          text: 'After edit',
        },
      }],
    });
  });

  it('keeps unknown visual fields out of the projection and preserves them through typed edits', () => {
    const knownSegments = {
      opening: {
        boundaryRef: { startMarkerId: 'opening-marker' },
        lensStyleBaseline: {
          grade: {
            recipeId: 'grade-recipe',
            semanticOverride: { warmth: 0.2 },
          },
        },
        lensEnvironmentOverride: {
          environmentColor: '#334455',
          primaryLightDirection: 'left',
        },
        adjustedCompositeByTarget: {
          hero: {
            integration: { recipeId: 'integration-recipe' },
          },
        },
      },
    };
    const knownRecipeOverlay = {
      'lens:atmosphere': {
        stack: 'lens',
        slot: 'atmosphere',
        label: 'Atmosphere',
        payload: {
          bloomScale: 0.5,
          overlays: [{ color: '#112233', intensity: 0.3, mode: 'screen' }],
        },
      },
      'composite:grounding': {
        stack: 'composite',
        slot: 'grounding',
        payload: {
          adjustment: { contrast: 0.1 },
          colorOverlay: { alpha: 0.2, color: '#000000', mode: 'soft-light' },
          blur: 1,
          rgbSplit: { x: 1, y: 2 },
          shadow: { alpha: 0.4, blur: 3, color: 0, distance: 2, rotation: 45 },
        },
      },
    };
    const source = makeScene({
      visual: {
        futureVisual: { retained: true },
        visualTargets: {
          hero: {
            targetType: 'character',
            futureTarget: 'retained',
            objectCompositeBaseline: {
              grounding: {
                recipeId: 'grounding-recipe',
                futureSlotState: 'retained',
                semanticOverride: {
                  intensity: 0.4,
                  futureSemanticOverride: 'retained',
                },
                advancedOverride: {
                  pluginOwnedValue: { retained: true },
                },
              },
            },
          },
        },
        segments: knownSegments,
        recipeOverlay: knownRecipeOverlay,
      },
    });

    const outcome = CompatibleSceneSession.open(source);
    if (outcome.status !== 'ready') throw new Error('Expected scene to be ready');
    const visual = outcome.session.projection.visual as Record<string, unknown>;
    const target = (visual.visualTargets as Record<string, Record<string, unknown>>).hero;
    const slot = (target.objectCompositeBaseline as Record<string, Record<string, unknown>>).grounding;

    expect(visual).not.toHaveProperty('futureVisual');
    expect(target).not.toHaveProperty('futureTarget');
    expect(slot).not.toHaveProperty('futureSlotState');
    expect(slot.semanticOverride).not.toHaveProperty('futureSemanticOverride');
    expect(slot.advancedOverride).toHaveProperty('pluginOwnedValue');
    expect(outcome.session.projection.visual?.segments).toEqual(knownSegments);
    expect(outcome.session.projection.visual?.recipeOverlay).toEqual(knownRecipeOverlay);
    const projectedTarget = outcome.session.projection.visual?.visualTargets?.hero;
    if (!projectedTarget) throw new Error('Expected projected visual target');

    outcome.session.applyTypedEdit({
      ...outcome.session.projection,
      visual: {
        ...outcome.session.projection.visual,
        visualTargets: {
          ...outcome.session.projection.visual?.visualTargets,
          hero: {
            ...projectedTarget,
            targetEnvironmentOverride: { warmthBias: 0.25 },
          },
        },
      },
    });

    expect(outcome.session.serialize()).toMatchObject({
      visual: {
        futureVisual: { retained: true },
        visualTargets: {
          hero: {
            futureTarget: 'retained',
            targetEnvironmentOverride: { warmthBias: 0.25 },
            objectCompositeBaseline: {
              grounding: {
                futureSlotState: 'retained',
                semanticOverride: { futureSemanticOverride: 'retained' },
                advancedOverride: { pluginOwnedValue: { retained: true } },
              },
            },
          },
        },
      },
    });
  });

  it('returns compatibility outcomes for unsupported and malformed sources', () => {
    expect(CompatibleSceneSession.open(makeScene()).status).toBe('ready');
    expect(CompatibleSceneSession.open(makeScene({ schemaVersion: 6 }))).toMatchObject({
      status: 'incompatible',
      issue: {
        code: 'unsupported_schema_epoch',
        path: 'scene.schemaVersion',
      },
    });
    expect(CompatibleSceneSession.open(makeScene({ schemaVersion: 2 }))).toMatchObject({
      status: 'incompatible',
      issue: {
        code: 'unsupported_schema_epoch',
        path: 'scene.schemaVersion',
        message: expect.stringContaining('offline migration'),
      },
    });
    expect(CompatibleSceneSession.open(makeScene({ schemaVersion: 1 }))).toMatchObject({
      status: 'incompatible',
      issue: {
        code: 'unsupported_schema_epoch',
        path: 'scene.schemaVersion',
        message: expect.stringContaining('offline migration'),
      },
    });
    expect(CompatibleSceneSession.open(makeScene({
      statements: [{ id: 'future', time: 0, type: 'futureFamily', params: {} }],
    }))).toMatchObject({
      status: 'incompatible',
      issue: { code: 'unknown_discriminator', path: 'scene.statements[0].type' },
    });
    expect(CompatibleSceneSession.open(makeScene({
      statements: [{ id: 'future-mode', time: 0, type: 'camera', params: { mode: 'orbit' } }],
    }))).toMatchObject({
      status: 'incompatible',
      issue: { code: 'unknown_discriminator', path: 'scene.statements[0].params.mode' },
    });
    expect(CompatibleSceneSession.open(makeScene({
      visual: {
        visualTargets: {
          future: { targetType: 'volumetric-character' },
        },
      },
    }))).toMatchObject({
      status: 'incompatible',
      issue: { code: 'unknown_discriminator', path: 'scene.visual.visualTargets.future.targetType' },
    });
    expect(CompatibleSceneSession.open(makeScene({
      statements: [{
        id: 'malformed',
        time: 0,
        type: 'dialogue',
        params: { text: 'Malformed', durationSeconds: 'later' },
      }],
    }))).toMatchObject({
      status: 'invalid',
      issue: { code: 'malformed_scene' },
    });
  });

  it('returns migration_required for v4 and v3 sources with executable migration plans', () => {
    const v4Source = {
      schemaVersion: 4,
      sceneId: 'v4-scene',
      meta: { title: 'V4 Scene' },
      statements: [
        {
          id: 'dialogue-1',
          time: 0,
          type: 'dialogue',
          params: { text: 'Hello v4', durationSeconds: 2 },
        },
      ],
    };

    const v4Outcome = CompatibleSceneSession.open(v4Source);
    expect(v4Outcome.status).toBe('migration_required');
    if (v4Outcome.status !== 'migration_required') throw new Error('Expected migration_required for v4');
    expect(v4Outcome.plan.sourceEpoch).toBe(4);
    expect(v4Outcome.plan.targetEpoch).toBe(5);
    expect(v4Outcome.plan.stages).toEqual(['v4_to_v5']);
    const v4Migrated = v4Outcome.plan.migrate();
    expect(v4Migrated.session.projection.schemaVersion).toBe(5);
    expect((v4Migrated.document as Record<string, unknown>).schemaVersion).toBe(5);

    const v3Source = {
      schemaVersion: 3,
      sceneId: 'v3-scene',
      meta: { title: 'V3 Scene', durationSeconds: 5 },
      statements: [
        {
          id: 'dialogue-1',
          time: 0,
          type: 'dialogue',
          params: { text: 'Hello v3', durationSeconds: 2 },
        },
        {
          id: 'clip-1',
          time: 1,
          type: 'live2dParameterClip',
          params: { durationSeconds: 2 },
        },
      ],
    };

    const v3Outcome = CompatibleSceneSession.open(v3Source);
    expect(v3Outcome.status).toBe('migration_required');
    if (v3Outcome.status !== 'migration_required') throw new Error('Expected migration_required for v3');
    expect(v3Outcome.plan.sourceEpoch).toBe(3);
    expect(v3Outcome.plan.targetEpoch).toBe(5);
    expect(v3Outcome.plan.stages).toEqual(['v3_to_v4', 'v4_to_v5']);
    expect(v3Outcome.plan.warnings.length).toBeGreaterThan(0);
    const v3Migrated = v3Outcome.plan.migrate();
    expect(v3Migrated.session.projection.schemaVersion).toBe(5);
    expect((v3Migrated.document as Record<string, unknown>).schemaVersion).toBe(5);
  });

  it('writes newly authored constructs in their minimum canonical form', () => {
    const outcome = CompatibleSceneSession.open(makeScene());
    if (outcome.status !== 'ready') throw new Error('Expected scene to be ready');

    outcome.session.applyTypedEdit({
      ...outcome.session.projection,
      statements: [{
        id: 'dialogue-new',
        time: 0,
        type: 'dialogue',
        params: { text: 'New line', durationSeconds: 1 },
      }],
    });

    expect(outcome.session.serialize()).toEqual(makeScene({
      statements: [{
        id: 'dialogue-new',
        time: 0,
        type: 'dialogue',
        params: { text: 'New line', durationSeconds: 1 },
      }],
    }));
  });

  it('preserves unknown params when known diagnostic placeholders are normalized', () => {
    const source = makeScene({
      statements: [{
        id: 'overlay-remove',
        time: 0,
        type: 'lighting',
        params: {
          effect: 'overlay',
          mode: 'remove',
          futureLightingField: 'retained',
        },
      }],
    });

    const outcome = CompatibleSceneSession.open(source);
    if (outcome.status !== 'ready') throw new Error('Expected scene to be ready');

    expect(outcome.session.projection.statements[0].params).toMatchObject({ id: '' });
    expect(outcome.session.serialize()).toEqual({
      ...source,
      statements: [{
        ...(source.statements as Array<Record<string, unknown>>)[0],
        params: {
          ...((source.statements as Array<Record<string, unknown>>)[0].params as Record<string, unknown>),
          id: '',
        },
      }],
    });
  });

  it('keeps unknown fields with their owners across edits, moves, reorders, and deletion', () => {
    const source = makeScene({
      statements: [{
        id: 'dialogue-1',
        time: 0,
        type: 'dialogue',
        futureStatement: 'first-owner',
        params: {
          text: 'First',
          durationSeconds: 1,
          futureParams: 'first-params',
        },
      }, {
        id: 'dialogue-2',
        time: 2,
        type: 'dialogue',
        futureStatement: 'second-owner',
        params: {
          text: 'Second',
          durationSeconds: 1,
          futureParams: 'second-params',
        },
      }],
    });
    const outcome = CompatibleSceneSession.open(source);
    if (outcome.status !== 'ready') throw new Error('Expected scene to be ready');
    const [first, second] = outcome.session.projection.statements;
    if (first.type !== 'dialogue' || second.type !== 'dialogue') {
      throw new Error('Expected dialogue projections');
    }

    outcome.session.applyTypedEdit({
      ...outcome.session.projection,
      statements: [{ ...second, time: 4 }, {
        ...first,
        time: 1,
        params: { ...first.params, text: 'First edited' },
      }],
    });

    expect(outcome.session.serialize()).toMatchObject({
      statements: [{
        id: 'dialogue-2',
        time: 4,
        futureStatement: 'second-owner',
        params: { futureParams: 'second-params' },
      }, {
        id: 'dialogue-1',
        time: 1,
        futureStatement: 'first-owner',
        params: { text: 'First edited', futureParams: 'first-params' },
      }],
    });

    outcome.session.applyTypedEdit({
      ...outcome.session.projection,
      statements: outcome.session.projection.statements.filter(({ id }) => id !== 'dialogue-2'),
    });

    expect(outcome.session.serialize()).toMatchObject({
      statements: [{
        id: 'dialogue-1',
        futureStatement: 'first-owner',
        params: { futureParams: 'first-params' },
      }],
    });
  });

  it('does not shift unknown fields when unkeyed nested items are inserted or reordered', () => {
    const source = makeScene({
      statements: [{
        id: 'camera-path',
        time: 0,
        type: 'camera',
        params: {
          mode: 'path',
          keyframes: [{
            time: 0,
            position: [0, 0],
            futureOwner: 'first',
          }, {
            time: 1,
            position: [1, 1],
            futureOwner: 'second',
          }],
        },
      }],
    });
    const outcome = CompatibleSceneSession.open(source);
    if (outcome.status !== 'ready') throw new Error('Expected scene to be ready');
    const statement = outcome.session.projection.statements[0];
    if (statement.type !== 'camera' || statement.params.mode !== 'path') {
      throw new Error('Expected camera path projection');
    }

    outcome.session.applyTypedEdit({
      ...outcome.session.projection,
      statements: [{
        ...statement,
        params: {
          ...statement.params,
          keyframes: [
            { time: -1, position: [-1, -1] },
            ...statement.params.keyframes.map((keyframe) => ({ ...keyframe })),
          ],
        },
      }],
    });

    let serializedKeyframes = ((outcome.session.serialize() as {
      statements: Array<{ params: { keyframes: Array<Record<string, unknown>> } }>;
    }).statements[0].params.keyframes);
    expect(serializedKeyframes).toEqual([
      { time: -1, position: [-1, -1] },
      { time: 0, position: [0, 0], futureOwner: 'first' },
      { time: 1, position: [1, 1], futureOwner: 'second' },
    ]);

    const updatedStatement = outcome.session.projection.statements[0];
    if (updatedStatement.type !== 'camera' || updatedStatement.params.mode !== 'path') {
      throw new Error('Expected updated camera path projection');
    }
    const [inserted, first, second] = updatedStatement.params.keyframes;
    outcome.session.applyTypedEdit({
      ...outcome.session.projection,
      statements: [{
        ...updatedStatement,
        params: {
          ...updatedStatement.params,
          keyframes: [{ ...second }, { ...inserted }, { ...first }],
        },
      }],
    });

    serializedKeyframes = ((outcome.session.serialize() as {
      statements: Array<{ params: { keyframes: Array<Record<string, unknown>> } }>;
    }).statements[0].params.keyframes);
    expect(serializedKeyframes).toEqual([
      { time: 1, position: [1, 1], futureOwner: 'second' },
      { time: -1, position: [-1, -1] },
      { time: 0, position: [0, 0], futureOwner: 'first' },
    ]);
  });

  it('copies unknown fields only when a typed edit declares duplicated entity ownership', () => {
    const source = makeScene({
      statements: [{
        id: 'dialogue-1',
        time: 0,
        type: 'dialogue',
        futureStatement: { retained: true },
        params: {
          text: 'Original',
          durationSeconds: 1,
          futureParams: { retained: true },
        },
        companions: [{
          id: 'camera-1',
          anchor: 'start',
          offset: 0,
          type: 'camera',
          futureCompanion: 'retained',
          params: {
            mode: 'focus',
            target: 'hero',
            futureCompanionParams: 'retained',
          },
        }],
      }],
    });
    const outcome = CompatibleSceneSession.open(source);
    if (outcome.status !== 'ready') throw new Error('Expected scene to be ready');
    const original = outcome.session.projection.statements[0];
    if (original.type !== 'dialogue') throw new Error('Expected dialogue projection');

    outcome.session.applyTypedEdit({
      ...outcome.session.projection,
      statements: [original, {
        ...original,
        id: 'dialogue-copy',
        time: 3,
        params: { ...original.params, text: 'Copied' },
      }, {
        ...original,
        id: 'dialogue-new',
        time: 6,
        params: { ...original.params, text: 'New' },
      }],
    }, {
      duplicateSources: { 'dialogue-copy': 'dialogue-1' },
    });

    expect(outcome.session.serialize()).toMatchObject({
      statements: [expect.anything(), {
        id: 'dialogue-copy',
        time: 3,
        futureStatement: { retained: true },
        params: { text: 'Copied', futureParams: { retained: true } },
        companions: [{
          id: 'camera-1',
          futureCompanion: 'retained',
          params: { futureCompanionParams: 'retained' },
        }],
      }, {
        id: 'dialogue-new',
        time: 6,
        params: { text: 'New' },
      }],
    });
    const serializedStatements = (outcome.session.serialize() as {
      statements: Array<Record<string, unknown>>;
    }).statements;
    expect(serializedStatements[2]).not.toHaveProperty('futureStatement');
    expect(serializedStatements[2].params).not.toHaveProperty('futureParams');
    expect((serializedStatements[2].companions as Array<Record<string, unknown>>)[0])
      .not.toHaveProperty('futureCompanion');
  });

  it('drops the previous family opaque subtree when an entity changes family', () => {
    const source = makeScene({
      statements: [{
        id: 'statement-1',
        time: 0,
        type: 'dialogue',
        futureDialogueField: 'remove-with-family',
        params: {
          text: 'Before replacement',
          durationSeconds: 1,
          futureDialogueParams: 'remove-with-family',
        },
      }],
    });
    const outcome = CompatibleSceneSession.open(source);
    if (outcome.status !== 'ready') throw new Error('Expected scene to be ready');

    outcome.session.applyTypedEdit({
      ...outcome.session.projection,
      statements: [{
        id: 'statement-1',
        time: 0,
        type: 'camera',
        params: { mode: 'focus', target: 'hero' },
      }],
    });

    expect(outcome.session.serialize()).toEqual(makeScene({
      statements: [{
        id: 'statement-1',
        time: 0,
        type: 'camera',
        params: { mode: 'focus', target: 'hero' },
      }],
    }));
  });

  it('drops the previous opaque subtree when a recognized construct changes shape', () => {
    const source = makeScene({
      statements: [{
        id: 'camera-1',
        time: 0,
        type: 'camera',
        params: {
          mode: 'focus',
          target: 'hero',
          futureFocusField: 'remove-with-shape',
        },
      }],
    });
    const outcome = CompatibleSceneSession.open(source);
    if (outcome.status !== 'ready') throw new Error('Expected scene to be ready');
    const statement = outcome.session.projection.statements[0];
    if (statement.type !== 'camera') throw new Error('Expected camera projection');

    outcome.session.applyTypedEdit({
      ...outcome.session.projection,
      statements: [{
        ...statement,
        params: { mode: 'reset' },
      }],
    });

    expect(outcome.session.serialize()).toEqual(makeScene({
      statements: [{
        id: 'camera-1',
        time: 0,
        type: 'camera',
        params: { mode: 'reset' },
      }],
    }));
  });

  it('undoes and redoes Compatibility Source and Typed Projection as one state', () => {
    const source = makeScene({
      futureRoot: 'retained',
      statements: [{
        id: 'dialogue-1',
        time: 0,
        type: 'dialogue',
        params: { text: 'Before', durationSeconds: 1 },
      }],
    });
    const outcome = CompatibleSceneSession.open(source);
    if (outcome.status !== 'ready') throw new Error('Expected scene to be ready');
    const statement = outcome.session.projection.statements[0];
    if (statement.type !== 'dialogue') throw new Error('Expected dialogue projection');

    outcome.session.applyTypedEdit({
      ...outcome.session.projection,
      statements: [{
        ...statement,
        params: { ...statement.params, text: 'After' },
      }],
    });
    expect(outcome.session.canUndo).toBe(true);
    expect(outcome.session.undo()).toBe(true);
    expect(outcome.session.projection.statements[0].params).toMatchObject({ text: 'Before' });
    expect(outcome.session.serialize()).toEqual(source);

    expect(outcome.session.canRedo).toBe(true);
    expect(outcome.session.redo()).toBe(true);
    expect(outcome.session.projection.statements[0].params).toMatchObject({ text: 'After' });
    expect(outcome.session.serialize()).toMatchObject({
      futureRoot: 'retained',
      statements: [{ params: { text: 'After' } }],
    });
  });

  it('treats Raw Script replacement as complete source replacement', () => {
    const source = makeScene({
      futureRoot: 'remove-by-raw-replacement',
      statements: [{
        id: 'dialogue-1',
        time: 0,
        type: 'dialogue',
        params: {
          text: 'Original',
          durationSeconds: 1,
          futureParams: 'remove-by-raw-replacement',
        },
      }],
    });
    const replacement = makeScene({
      meta: { title: 'Raw replacement' },
      statements: [{
        id: 'dialogue-raw',
        time: 0,
        type: 'dialogue',
        params: { text: 'Raw text', durationSeconds: 1 },
      }],
    });
    const outcome = CompatibleSceneSession.open(source);
    if (outcome.status !== 'ready') throw new Error('Expected scene to be ready');

    expect(outcome.session.replaceSource({ ...replacement, schemaVersion: 6 })).toMatchObject({
      status: 'incompatible',
      issue: { code: 'unsupported_schema_epoch' },
    });
    expect(outcome.session.serialize()).toEqual(source);
    expect(outcome.session.canUndo).toBe(false);

    expect(outcome.session.replaceSource(replacement).status).toBe('ready');
    expect(outcome.session.serialize()).toEqual(replacement);
    expect(outcome.session.undo()).toBe(true);
    expect(outcome.session.serialize()).toEqual(source);
    expect(outcome.session.redo()).toBe(true);

    const rawStatement = outcome.session.projection.statements[0];
    if (rawStatement.type !== 'dialogue') throw new Error('Expected dialogue projection');
    outcome.session.applyTypedEdit({
      ...outcome.session.projection,
      statements: [{
        ...rawStatement,
        params: { ...rawStatement.params, text: 'Typed after raw' },
      }],
    });

    expect(outcome.session.serialize()).toEqual(makeScene({
      meta: { title: 'Raw replacement' },
      statements: [{
        id: 'dialogue-raw',
        time: 0,
        type: 'dialogue',
        params: { text: 'Typed after raw', durationSeconds: 1 },
      }],
    }));
  });
});
