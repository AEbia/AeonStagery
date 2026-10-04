import { describe, expect, it, vi } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import { SEMANTIC_SCENE_PATCH_VERSION } from '../api/types/semantic-scene-patch';
import {
  applyEnhancementStagePlan,
  applyFormalEnhancementPreview,
  collectEnhancementPerformanceMotions,
  combineStagePatches,
  flattenEnhancementStagePlan,
} from '../services/ai-authoring/FormalEnhancementApply';
import {
  createSceneEnhancementSnapshot,
  withSceneEnhancementPreviewPatch,
  withSceneEnhancementStageResult,
} from '../services/ai-authoring/SceneEnhancementSnapshot';
import { materializePerformancePlaceholders } from '../services/ai-authoring/CharacterBindingPlan';
import { SemanticSceneLineView } from '../services/semantic-scene/SemanticSceneLineView';
import { applySemanticScenePatch } from '../services/semantic-scene/SemanticScenePatch';

function makeDocument(): CurrentSceneDocument {
  return materializePerformancePlaceholders({
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene-1',
    meta: {
      title: 'Test',
      characters: [{ id: 'c1', name: 'Alice' }],
    },
    statements: [
      {
        id: 'd0',
        time: 0,
        type: 'dialogue',
        params: {
          speakerId: 'c1',
          speaker: 'Alice',
          text: '你好。',
          durationSeconds: 1,
        },
      },
    ],
  });
}

describe('applyFormalEnhancementPreview', () => {
  it('commits a valid preview patch once and refuses empty patches', async () => {
    const document = makeDocument();
    const companionLine = 2;
    let snapshot = createSceneEnhancementSnapshot({
      sceneSessionEpoch: 1,
      documentVersion: 7,
    });
    snapshot = withSceneEnhancementPreviewPatch(snapshot, {
      version: SEMANTIC_SCENE_PATCH_VERSION,
      operations: [{
        kind: 'updateCompanion',
        line: companionLine,
        patch: { params: { motion: 'wave' } },
      }],
    });

    const commitCandidate = vi.fn(async ({ candidate }) => candidate);
    const result = await applyFormalEnhancementPreview({
      snapshot,
      document,
      binding: { sceneSessionEpoch: 1, documentVersion: 7 },
      ports: { commitCandidate },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.operationCount).toBe(1);
    expect(commitCandidate).toHaveBeenCalledTimes(1);
    const alice = result.document.statements[0];
    expect(alice?.type).toBe('dialogue');
    if (alice?.type === 'dialogue') {
      expect(alice.companions?.[0]?.params).toMatchObject({ motion: { kind: 'resource', key: 'wave' } });
    }

    const empty = await applyFormalEnhancementPreview({
      snapshot: withSceneEnhancementPreviewPatch(snapshot, {
        version: SEMANTIC_SCENE_PATCH_VERSION,
        operations: [],
      }),
      document,
      binding: { sceneSessionEpoch: 1, documentVersion: 7 },
      ports: { commitCandidate },
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe('empty_patch');
  });

  it('refuses apply when document version drifts', async () => {
    const document = makeDocument();
    let snapshot = createSceneEnhancementSnapshot({
      sceneSessionEpoch: 1,
      documentVersion: 3,
    });
    snapshot = withSceneEnhancementPreviewPatch(snapshot, {
      version: SEMANTIC_SCENE_PATCH_VERSION,
      operations: [{
        kind: 'updateCompanion',
        line: 2,
        patch: { params: { motion: 'wave' } },
      }],
    });

    const result = await applyFormalEnhancementPreview({
      snapshot,
      document,
      binding: { sceneSessionEpoch: 1, documentVersion: 4 },
      ports: { commitCandidate: async ({ candidate }) => candidate },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('snapshot_invalid');
  });

  it('materializes empty-motion performance placeholders before resolving preview line patches', async () => {
    const document: CurrentSceneDocument = {
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'scene-1',
      meta: {
        title: 'Test',
        characters: [{ id: 'c1', name: 'Alice' }],
      },
      statements: [
        {
          id: 'd0',
          time: 0,
          type: 'dialogue',
          params: {
            speakerId: 'c1',
            speaker: 'Alice',
            text: '你好。',
            durationSeconds: 1,
          },
        },
      ],
    };
    expect(document.statements[0]?.type === 'dialogue'
      ? (document.statements[0].companions ?? []).length
      : -1).toBe(0);

    let snapshot = createSceneEnhancementSnapshot({
      sceneSessionEpoch: 1,
      documentVersion: 9,
    });
    snapshot = withSceneEnhancementPreviewPatch(snapshot, {
      version: SEMANTIC_SCENE_PATCH_VERSION,
      operations: [{
        kind: 'updateCompanion',
        line: 2,
        patch: { params: { motion: 'wave' } },
      }],
    });

    const commitCandidate = vi.fn(async ({ candidate }) => candidate);
    const result = await applyFormalEnhancementPreview({
      snapshot,
      document,
      binding: { sceneSessionEpoch: 1, documentVersion: 9 },
      ports: { commitCandidate },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const alice = result.document.statements[0];
    expect(alice?.type).toBe('dialogue');
    if (alice?.type !== 'dialogue') return;
    expect(alice.companions).toHaveLength(1);
    expect(alice.companions?.[0]?.params).toMatchObject({
      target: '$speaker',
      motion: { kind: 'resource', key: 'wave' },
    });
    expect(commitCandidate).toHaveBeenCalledTimes(1);
  });

  it('applies performance then cinematic on successive candidates so post-performance lines resolve', async () => {
    const baseline = materializePerformancePlaceholders({
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'scene-1',
      meta: {
        title: 'Test',
        characters: [{ id: 'c1', name: 'Alice' }],
      },
      statements: [
        {
          id: 'd0',
          time: 0,
          type: 'dialogue',
          params: {
            speakerId: 'c1',
            speaker: 'Alice',
            text: '你好。',
            durationSeconds: 1,
          },
        },
      ],
    });

    const performancePatch = {
      version: SEMANTIC_SCENE_PATCH_VERSION,
      operations: [{
        kind: 'insertStatement' as const,
        time: 0,
        beforeLine: 1,
        statement: {
          type: 'characterTransform' as const,
          params: {
            id: 'c1',
            position: [0, 0] as [number, number],
            durationSeconds: 0.3,
          },
        },
      }],
    };

    const afterPerformance = applySemanticScenePatch(baseline, performancePatch).candidate;
    const postPerfView = new SemanticSceneLineView(afterPerformance);
    const dialogueLine = postPerfView.lines.find(
      (line) => line.kind === 'statement' && line.type === 'dialogue',
    );
    expect(dialogueLine?.line).toBe(2);

    const cinematicPatch = {
      version: SEMANTIC_SCENE_PATCH_VERSION,
      operations: [{
        kind: 'insertCompanion' as const,
        parentLine: dialogueLine!.line,
        companion: {
          anchor: 'start' as const,
          offset: 0,
          type: 'camera' as const,
          params: {
            mode: 'focus' as const,
            target: 'c1',
            durationSeconds: 0.5,
          },
        },
      }],
    };

    const liveDocument: CurrentSceneDocument = {
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'scene-1',
      meta: {
        title: 'Test',
        characters: [{ id: 'c1', name: 'Alice' }],
      },
      statements: [
        {
          id: 'd0',
          time: 0,
          type: 'dialogue',
          params: {
            speakerId: 'c1',
            speaker: 'Alice',
            text: '你好。',
            durationSeconds: 1,
          },
        },
      ],
    };

    let snapshot = createSceneEnhancementSnapshot({
      sceneSessionEpoch: 1,
      documentVersion: 11,
    });
    snapshot = withSceneEnhancementStageResult(snapshot, {
      stage: 'performance',
      status: 'succeeded',
      patch: performancePatch,
    });
    snapshot = withSceneEnhancementStageResult(snapshot, {
      stage: 'cinematic',
      status: 'succeeded',
      patch: cinematicPatch,
    });
    const plan = combineStagePatches(performancePatch, cinematicPatch);
    snapshot = withSceneEnhancementPreviewPatch(snapshot, flattenEnhancementStagePlan(plan));

    const result = await applyFormalEnhancementPreview({
      snapshot,
      document: liveDocument,
      binding: { sceneSessionEpoch: 1, documentVersion: 11 },
      ports: { commitCandidate: async ({ candidate }) => candidate },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.statements.some((s) => s.type === 'characterTransform')).toBe(true);
    const dialogue = result.document.statements.find((s) => s.id === 'd0');
    expect(dialogue?.type).toBe('dialogue');
    if (dialogue?.type === 'dialogue') {
      expect(dialogue.companions?.some((c) => c.type === 'camera')).toBe(true);
    }

    // Flat concat against original baseline must not be how stages are applied.
    expect(() => applySemanticScenePatch(
      materializePerformancePlaceholders(liveDocument),
      flattenEnhancementStagePlan(plan),
    )).toThrow();
  });

  it('rejects apply when the optional resource validation port reports errors', async () => {
    const document = makeDocument();
    let snapshot = createSceneEnhancementSnapshot({
      sceneSessionEpoch: 1,
      documentVersion: 12,
    });
    snapshot = withSceneEnhancementPreviewPatch(snapshot, {
      version: SEMANTIC_SCENE_PATCH_VERSION,
      operations: [{
        kind: 'updateCompanion',
        line: 2,
        patch: { params: { motion: 'wave' } },
      }],
    });

    const result = await applyFormalEnhancementPreview({
      snapshot,
      document,
      binding: { sceneSessionEpoch: 1, documentVersion: 12 },
      ports: {
        commitCandidate: async ({ candidate }) => candidate,
        validateResources: async () => [{
          gate: 'resource',
          severity: 'error',
          code: 'resource_missing',
          message: 'motion wave is not available on model',
        }],
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('resource_validation_failed');
      expect(result.message).toMatch(/wave|resource/i);
    }
  });

  it('enforces the performance stage policy during final apply', async () => {
    const document = makeDocument();
    let snapshot = createSceneEnhancementSnapshot({
      sceneSessionEpoch: 1,
      documentVersion: 13,
    });
    snapshot = withSceneEnhancementPreviewPatch(snapshot, {
      version: SEMANTIC_SCENE_PATCH_VERSION,
      operations: [{
        kind: 'deleteLine',
        line: 1,
      }],
    });

    const commitCandidate = vi.fn(async ({ candidate }: { candidate: CurrentSceneDocument }) => candidate);
    const result = await applyFormalEnhancementPreview({
      snapshot,
      document,
      binding: { sceneSessionEpoch: 1, documentVersion: 13 },
      ports: { commitCandidate },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('apply_failed');
    expect(commitCandidate).not.toHaveBeenCalled();
  });
});

describe('applyEnhancementStagePlan', () => {
  it('does not materialize performance placeholders for a cinematic-only plan', () => {
    const document: CurrentSceneDocument = {
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'scene-1',
      meta: {
        title: 'Test',
        characters: [{ id: 'c1', name: 'Alice' }],
      },
      statements: [{
        id: 'd0',
        time: 0,
        type: 'dialogue',
        params: {
          speakerId: 'c1',
          speaker: 'Alice',
          text: '你好。',
          durationSeconds: 1,
        },
      }],
    };
    const cinematicPatch = {
      version: SEMANTIC_SCENE_PATCH_VERSION,
      operations: [{
        kind: 'insertCompanion' as const,
        parentLine: 1,
        companion: {
          anchor: 'start' as const,
          offset: 0,
          type: 'camera' as const,
          params: {
            mode: 'focus' as const,
            target: 'c1',
            durationSeconds: 0.5,
          },
        },
      }],
    };

    const { candidate } = applyEnhancementStagePlan(
      document,
      combineStagePatches(undefined, cinematicPatch),
    );

    expect(candidate.statements.some((statement) => statement.type === 'characterPerformance')).toBe(false);
    const dialogue = candidate.statements[0];
    expect(dialogue?.type).toBe('dialogue');
    if (dialogue?.type === 'dialogue') {
      expect(dialogue.companions).toHaveLength(1);
      expect(dialogue.companions?.[0]?.type).toBe('camera');
    }
  });

  it('replays stages sequentially without concatenating line ops onto one base', () => {
    const document = makeDocument();
    const performancePatch = {
      version: SEMANTIC_SCENE_PATCH_VERSION,
      operations: [{
        kind: 'insertStatement' as const,
        time: 0,
        beforeLine: 1,
        statement: {
          type: 'characterTransform' as const,
          params: {
            id: 'c1',
            position: [0.2, 0.5] as [number, number],
            durationSeconds: 0.2,
          },
        },
      }],
    };
    const afterPerf = applySemanticScenePatch(document, performancePatch).candidate;
    const dialogueLine = new SemanticSceneLineView(afterPerf).lines.find(
      (line) => line.kind === 'statement' && line.type === 'dialogue',
    )!.line;

    const cinematicPatch = {
      version: SEMANTIC_SCENE_PATCH_VERSION,
      operations: [{
        kind: 'insertCompanion' as const,
        parentLine: dialogueLine,
        companion: {
          anchor: 'start' as const,
          offset: 0,
          type: 'camera' as const,
          params: {
            mode: 'focus' as const,
            target: 'c1',
            durationSeconds: 0.4,
          },
        },
      }],
    };

    const plan = combineStagePatches(performancePatch, cinematicPatch);
    const { candidate, operationCount } = applyEnhancementStagePlan(document, plan, {
      materializePlaceholders: false,
    });
    expect(operationCount).toBe(2);
    expect(candidate.statements.some((s) => s.type === 'characterTransform')).toBe(true);
    const dialogue = candidate.statements.find((s) => s.id === 'd0');
    expect(dialogue?.type).toBe('dialogue');
    if (dialogue?.type === 'dialogue') {
      expect(dialogue.companions?.some((c) => c.type === 'camera')).toBe(true);
    }
  });
});

describe('collectEnhancementPerformanceMotions', () => {
  it('collects non-empty characterPerformance motions from the performance stage only', () => {
    const plan = combineStagePatches(
      {
        version: SEMANTIC_SCENE_PATCH_VERSION,
        operations: [
          {
            kind: 'updateCompanion' as const,
            line: 2,
            patch: {
              type: 'characterPerformance' as const,
              params: { motion: 'angry01' },
            },
          },
          {
            kind: 'updateCompanion' as const,
            line: 4,
            patch: {
              type: 'characterPerformance' as const,
              params: { motion: '' },
            },
          },
        ],
      },
      {
        version: SEMANTIC_SCENE_PATCH_VERSION,
        operations: [{
          kind: 'insertCompanion' as const,
          parentLine: 1,
          companion: {
            anchor: 'start' as const,
            offset: 0,
            type: 'camera' as const,
            params: { mode: 'focus' as const, target: 'c1' },
          },
        }],
      },
    );

    expect(collectEnhancementPerformanceMotions(plan)).toEqual({
      motionCount: 1,
      motions: ['angry01'],
    });
  });

  it('deduplicates motion keys and counts insertCompanion motions', () => {
    const plan = {
      version: 1 as const,
      stages: [{
        stage: 'performance' as const,
        patch: {
          version: SEMANTIC_SCENE_PATCH_VERSION,
          operations: [
            {
              kind: 'insertCompanion' as const,
              parentLine: 1,
              companion: {
                anchor: 'start' as const,
                offset: 0,
                type: 'characterPerformance' as const,
                params: { target: '$speaker', motion: 'idle' },
              },
            },
            {
              kind: 'updateCompanion' as const,
              line: 3,
              patch: {
                type: 'characterPerformance' as const,
                params: { motion: 'idle' },
              },
            },
            {
              kind: 'updateCompanion' as const,
              line: 5,
              patch: {
                type: 'characterPerformance' as const,
                params: { motion: 'smile' },
              },
            },
          ],
        },
      }],
    };

    expect(collectEnhancementPerformanceMotions(plan)).toEqual({
      motionCount: 3,
      motions: ['idle', 'smile'],
    });
  });
});
