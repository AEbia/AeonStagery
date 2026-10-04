import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import {
  CINEMATIC_STAGE_POLICY_V1,
  CINEMATIC_STAGE_POLICY_VERSION,
  PERFORMANCE_ALLOWED_PATHS,
  PERFORMANCE_STAGE_POLICY_V1,
  PERFORMANCE_STAGE_POLICY_VERSION,
  getEnhancementStagePolicy,
  isCinematicCompanionFamily,
  isPerformanceCompanionFamily,
  isPerformanceRootFamily,
} from '../services/ai-authoring/CinematicEnhancementPolicy';
import {
  SemanticScenePatchError,
  applySemanticScenePatch,
} from '../services/semantic-scene/SemanticScenePatch';
import { SceneStatementFactory } from '../services/semantic-scene/SceneStatementFactory';

function factory(): SceneStatementFactory {
  let n = 0;
  return new SceneStatementFactory({
    idGenerator: (prefix) => `${prefix}_${n++}`,
  });
}

function document(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'policy_scene',
    meta: {
      title: 'Policy',
      durationSeconds: 10,
      characters: [{ id: 'tomori', name: 'Tomori' }],
    },
    statements: [
      {
        id: 'dlg_1',
        time: 0,
        type: 'dialogue',
        params: {
          speakerId: 'tomori',
          text: 'Hello',
          durationSeconds: 2,
        },
        companions: [
          {
            id: 'perf_1',
            anchor: 'start',
            offset: 0,
            type: 'characterPerformance',
            params: { target: '$speaker', motion: { kind: 'resource', key: 'tomori/smile01' } },
          },
        ],
      },
      {
        id: 'cam_1',
        time: 1,
        type: 'camera',
        params: { mode: 'reset', durationSeconds: 0.3 },
      },
    ],
  };
}

/** Same document with an extra camera companion: lines 1 dlg_1, 2 perf_1, 3 cam_cmp, 4 cam_1. */
function documentWithCameraCompanion(): CurrentSceneDocument {
  return {
    ...document(),
    statements: document().statements.map((statement) => statement.id !== 'dlg_1'
      ? statement
      : {
          ...statement,
          companions: [
            ...(statement.companions ?? []),
            {
              id: 'cam_cmp',
              anchor: 'start',
              offset: 0.1,
              type: 'camera',
              params: { mode: 'focus', target: '$speaker', durationSeconds: 0.2 },
            },
          ],
        }),
  };
}

describe('Enhancement stage policies', () => {
  it('exposes stable policy versions and data-driven allow lists', () => {
    expect(PERFORMANCE_STAGE_POLICY_VERSION).toContain('performance');
    expect(CINEMATIC_STAGE_POLICY_VERSION).toContain('cinematic');
    expect(getEnhancementStagePolicy('performance')).toBe(PERFORMANCE_STAGE_POLICY_V1);
    expect(getEnhancementStagePolicy('cinematic')).toBe(CINEMATIC_STAGE_POLICY_V1);
    expect(PERFORMANCE_STAGE_POLICY_V1.allowedOperations).toEqual([
      'insertStatement',
      'insertCompanion',
      'updateStatement',
      'updateCompanion',
    ]);
    expect(CINEMATIC_STAGE_POLICY_V1.allowedOperations).toContain('deleteLine');
    expect(CINEMATIC_STAGE_POLICY_V1.allowedOperations).toContain('moveLine');
    expect(CINEMATIC_STAGE_POLICY_V1.allowedOperations).not.toContain('reorderCompanions');
  });

  it('excludes removed characterPerformance fields from the performance allowlist', () => {
    expect(PERFORMANCE_ALLOWED_PATHS).not.toContain('params.loop');
    expect(PERFORMANCE_ALLOWED_PATHS).not.toContain('params.priority');
    // v4 keeps params.durationSeconds on characterTransform, so the family-blind
    // shared allowlist must retain it even though characterPerformance dropped it.
    expect(PERFORMANCE_ALLOWED_PATHS).toContain('params.durationSeconds');
  });

  it('classifies performance and cinematic companion families', () => {
    expect(isPerformanceRootFamily('characterPerformance')).toBe(true);
    expect(isPerformanceRootFamily('characterTransform')).toBe(true);
    expect(isPerformanceCompanionFamily('characterPerformance')).toBe(true);
    expect(isPerformanceCompanionFamily('characterTransform')).toBe(false);
    expect(isCinematicCompanionFamily('camera')).toBe(true);
    expect(isCinematicCompanionFamily('visualStyle')).toBe(true);
    expect(isCinematicCompanionFamily('lighting')).toBe(false);
  });

  it('allows performance fill of empty motion under performance policy', () => {
    const base = document();
    const placeholder = base.statements[0]!.companions![0]!;
    (placeholder as { params: { motion: string } }).params = {
      ...placeholder.params,
      motion: '',
    };
    const result = applySemanticScenePatch(
      base,
      {
        version: 1,
        operations: [
          {
            kind: 'updateCompanion',
            line: 2,
            patch: { params: { motion: 'tomori/nf01' } },
          },
        ],
      },
      { policy: PERFORMANCE_STAGE_POLICY_V1, factory: factory(), validateCandidate: false },
    );
    expect(result.status).toBe('changed');
    const companion = result.candidate.statements[0]?.companions?.[0];
    expect(companion?.params).toMatchObject({ motion: { kind: 'resource', key: 'tomori/nf01' } });
  });

  it('rejects deleteLine under performance policy', () => {
    expect(() => applySemanticScenePatch(
      document(),
      { version: 1, operations: [{ kind: 'deleteLine', line: 2 }] },
      { policy: PERFORMANCE_STAGE_POLICY_V1, factory: factory() },
    )).toThrow(SemanticScenePatchError);

    try {
      applySemanticScenePatch(
        document(),
        { version: 1, operations: [{ kind: 'deleteLine', line: 2 }] },
        { policy: PERFORMANCE_STAGE_POLICY_V1, factory: factory() },
      );
    } catch (error) {
      expect((error as SemanticScenePatchError).code).toBe('forbidden_operation');
    }
  });

  it('rejects a performance patch writing removed params.loop at codec validation', () => {
    // Stage policy path rules are prefix-based (params.* is covered by the
    // `params` entry), so the strict current codec is the enforcement point that
    // rejects fields dropped from CharacterPerformanceParams.
    try {
      applySemanticScenePatch(
        document(),
        {
          version: 1,
          operations: [
            {
              kind: 'updateCompanion',
              line: 2,
              patch: { params: { loop: true } },
            },
          ],
        },
        { policy: PERFORMANCE_STAGE_POLICY_V1, factory: factory() },
      );
      expect.unreachable('params.loop must be rejected by the v4 strict codec');
    } catch (error) {
      expect((error as SemanticScenePatchError).code).toBe('schema_validation_failed');
      expect((error as SemanticScenePatchError).message).toContain('params.loop');
      expect((error as SemanticScenePatchError).message).toContain(
        'Allowed fields: target, motion, expression, lookAt, blink',
      );
    }
  });

  it('rejects non-performance families under performance policy', () => {
    expect(() => applySemanticScenePatch(
      document(),
      {
        version: 1,
        operations: [
          {
            kind: 'insertStatement',
            time: 2,
            statement: {
              type: 'camera',
              params: { mode: 'reset', durationSeconds: 0.2 },
            },
          },
        ],
      },
      { policy: PERFORMANCE_STAGE_POLICY_V1, factory: factory() },
    )).toThrow(/family/i);
  });

  it('allows cinematic delete/move of camera roots', () => {
    const result = applySemanticScenePatch(
      document(),
      {
        version: 1,
        operations: [
          { kind: 'moveLine', line: 3, time: 4 },
        ],
      },
      { policy: CINEMATIC_STAGE_POLICY_V1, factory: factory() },
    );
    expect(result.status).toBe('changed');
    expect(result.candidate.statements.find((s) => s.id === 'cam_1')?.time).toBe(4);
  });

  it('rejects reorderCompanions under cinematic policy', () => {
    expect(() => applySemanticScenePatch(
      document(),
      {
        version: 1,
        operations: [
          { kind: 'reorderCompanions', parentLine: 1, orderedLines: [2] },
        ],
      },
      { policy: CINEMATIC_STAGE_POLICY_V1, factory: factory() },
    )).toThrow(SemanticScenePatchError);
  });

  it('rejects family replacement via type path on cinematic updates', () => {
    expect(() => applySemanticScenePatch(
      document(),
      {
        version: 1,
        operations: [
          {
            kind: 'updateStatement',
            line: 3,
            patch: {
              type: 'lighting',
              params: { mode: 'reset' },
            },
          },
        ],
      },
      { policy: CINEMATIC_STAGE_POLICY_V1, factory: factory() },
    )).toThrow(SemanticScenePatchError);
  });

  it('rejects a lighting dialogue companion under the cinematic companion whitelist', () => {
    try {
      applySemanticScenePatch(
        document(),
        {
          version: 1,
          operations: [{
            kind: 'insertCompanion',
            parentLine: 1,
            companion: {
              anchor: 'start',
              offset: 0,
              type: 'lighting',
              params: { mode: 'reset', durationSeconds: 0.3 },
            },
          }],
        },
        { policy: CINEMATIC_STAGE_POLICY_V1, factory: factory() },
      );
      expect.unreachable('lighting companion must be rejected');
    } catch (error) {
      expect((error as SemanticScenePatchError).code).toBe('forbidden_family');
      expect((error as SemanticScenePatchError).message).toContain(
        'Companion family "lighting" is not allowed by stage policy',
      );
    }
  });

  it('rejects deprecated filter families under cinematic policy', () => {
    for (const family of ['filterAdd', 'filterChange', 'filterReset'] as const) {
      expect(() => applySemanticScenePatch(
        document(),
        {
          version: 1,
          operations: [{
            kind: 'insertStatement',
            time: 1,
            statement: {
              type: family,
              params: (family === 'filterReset' ? {} : { recipeId: 'lens:warm' }) as any,
            },
          }],
        },
        { policy: CINEMATIC_STAGE_POLICY_V1, factory: factory() },
      )).toThrow(new RegExp(`Statement family "${family}" is not allowed by stage policy`));
    }
  });

  it('rejects a filterAdd dialogue companion under the cinematic family whitelist', () => {
    expect(() => applySemanticScenePatch(
      document(),
      {
        version: 1,
        operations: [{
          kind: 'insertCompanion',
          parentLine: 1,
          companion: {
            anchor: 'start',
            offset: 0,
            type: 'filterAdd',
            params: { recipeId: 'lens:warm', durationSeconds: 0.3 } as any,
          },
        }],
      },
      { policy: CINEMATIC_STAGE_POLICY_V1, factory: factory() },
    )).toThrow(/Statement family "filterAdd" is not allowed by stage policy/);
  });

  it('allows a camera dialogue companion under the cinematic companion whitelist', () => {
    const result = applySemanticScenePatch(
      document(),
      {
        version: 1,
        operations: [{
          kind: 'insertCompanion',
          parentLine: 1,
          companion: {
            anchor: 'start',
            offset: 0,
            type: 'camera',
            params: { mode: 'focus', target: 'tomori', durationSeconds: 0.1 },
          },
        }],
      },
      { policy: CINEMATIC_STAGE_POLICY_V1, factory: factory() },
    );
    expect(result.status).toBe('changed');
    expect(result.candidate.statements[0]?.companions?.some(
      (companion) => companion.type === 'camera',
    )).toBe(true);
  });

  it('rejects updateCompanion family replacement to a non-whitelisted companion family', () => {
    try {
      applySemanticScenePatch(
        documentWithCameraCompanion(),
        {
          version: 1,
          operations: [{
            kind: 'updateCompanion',
            line: 3,
            patch: {
              type: 'lighting',
              params: { effect: 'preset', preset: 'warm', durationSeconds: 0.3 },
            },
          }],
        },
        { policy: CINEMATIC_STAGE_POLICY_V1, factory: factory() },
      );
      expect.unreachable('companion family replacement must be rejected');
    } catch (error) {
      expect((error as SemanticScenePatchError).code).toBe('forbidden_family');
      expect((error as SemanticScenePatchError).message).toContain(
        'Companion family "lighting" is not allowed by stage policy',
      );
    }
  });

  it('allows an in-place camera companion update under the cinematic companion whitelist', () => {
    const result = applySemanticScenePatch(
      documentWithCameraCompanion(),
      {
        version: 1,
        operations: [{
          kind: 'updateCompanion',
          line: 3,
          patch: { params: { durationSeconds: 0.4 } },
        }],
      },
      { policy: CINEMATIC_STAGE_POLICY_V1, factory: factory() },
    );
    expect(result.status).toBe('changed');
    expect(result.candidate.statements[0]?.companions?.[1]?.params).toMatchObject({
      durationSeconds: 0.4,
    });
  });
});
