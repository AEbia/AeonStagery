import { describe, expect, it, vi } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import { SEMANTIC_SCENE_PATCH_VERSION } from '../api/types/semantic-scene-patch';
import { FormalEnhancementOrchestrator } from '../services/ai-authoring/FormalEnhancementOrchestrator';
import { resolveEnhancementStagePlan } from '../services/ai-authoring/FormalEnhancementApply';
import type { AiProseLlmService } from '../services/ai-authoring/AiProseLlmService';
import type { AiProseSegmentationPlan } from '../services/ai-authoring/AiProseSegmentation';
import {
  createSceneEnhancementSnapshot,
  withSceneEnhancementStageResult,
} from '../services/ai-authoring/SceneEnhancementSnapshot';
import { beginFormalEnhancementRun, buildSingleSegmentSegmentation, buildFormalStatementGroups } from '../services/ai-authoring/FormalSceneEnhancementHost';
import { buildCharacterBindingPlan, materializePerformancePlaceholders, projectDraftSemanticScene } from '../services/ai-authoring/CharacterBindingPlan';
import { PERFORMANCE_STAGE_POLICY_V1 } from '../services/ai-authoring/CinematicEnhancementPolicy';
import type { EnhancementProcessorRunner } from '../services/ai-authoring/EnhancementProcessorRunner';
import { SemanticSceneLineView } from '../services/semantic-scene/SemanticSceneLineView';

function makeLongDocument(): CurrentSceneDocument {
  const statements = Array.from({ length: 4 }, (_, index) => ({
    id: `d${index}`,
    time: index * 2,
    type: 'dialogue' as const,
    params: {
      speakerId: 'c1',
      speaker: 'Alice',
      // Long enough that targetBatchSize forces multi-segment.
      text: `${'甲'.repeat(80)}句${index + 1}。`,
      durationSeconds: 1,
    },
  }));
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene-1',
    meta: {
      title: 'Test',
      characters: [{ id: 'c1', name: 'Alice' }],
    },
    statements,
  };
}

describe('FormalEnhancementOrchestrator.resolveAutoSegmentation', () => {
  it('sends real speaker/text story lines to the segmentation model, not char-count stubs', async () => {
    const document = makeLongDocument();
    let capturedPlan: AiProseSegmentationPlan | undefined;
    const segment = vi.fn(async (plan: AiProseSegmentationPlan) => {
      capturedPlan = plan;
      // Single cut after first group line → 2 segments.
      const firstBoundary = plan.candidates[0];
      return {
        status: 'succeeded' as const,
        value: {
          boundaryIds: firstBoundary ? [firstBoundary.id] : [],
          segments: [],
        },
        correctionUsed: false,
      };
    });

    const orchestrator = new FormalEnhancementOrchestrator({
      llm: { segment } as unknown as AiProseLlmService,
    });

    const result = await orchestrator.resolveAutoSegmentation({
      document,
      targetBatchSize: 100,
    });

    expect(result.ok).toBe(true);
    expect(segment).toHaveBeenCalledTimes(1);
    expect(capturedPlan).toBeTruthy();
    // Real dialogue content must appear — not "G0 text:NN" stubs.
    expect(capturedPlan!.sourceText).toContain('句1');
    expect(capturedPlan!.sourceText).toContain('Alice');
    expect(capturedPlan!.sourceText).not.toMatch(/G\d+ text:/);
    expect(capturedPlan!.numberedSource).not.toMatch(/G\d+ text:/);
    // One physical line per statement group so boundaries stay group-atomic.
    expect(capturedPlan!.lines).toHaveLength(4);
  });

  it('replays performance onto cinematic base with performance policy and surfaces unit checkpoints', async () => {
    const document = materializePerformancePlaceholders({
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
    });

    const performancePatch = {
      version: SEMANTIC_SCENE_PATCH_VERSION,
      operations: [{
        kind: 'updateCompanion' as const,
        line: 2,
        patch: { params: { motion: 'wave' } },
      }],
    };

    const enhanceCinematic = vi.fn(async () => ({
      status: 'succeeded' as const,
      value: { version: SEMANTIC_SCENE_PATCH_VERSION, operations: [] },
      correctionUsed: false,
    }));

    const orchestrator = new FormalEnhancementOrchestrator({
      llm: {
        enhancePerformance: vi.fn(),
        enhanceCinematic,
      } as unknown as AiProseLlmService,
      modelCapabilities: {
        hasModelConfigured: () => true,
        motionsForCharacter: () => ['wave'],
        expressionsForCharacter: () => [],
      },
    });

    const groups = buildFormalStatementGroups(document);
    let snapshot = beginFormalEnhancementRun({
      binding: { sceneSessionEpoch: 1, documentVersion: 1 },
      document,
      segmentation: buildSingleSegmentSegmentation(groups),
    });
    snapshot = withSceneEnhancementStageResult(snapshot, {
      stage: 'performance',
      status: 'succeeded',
      patch: performancePatch,
    });

    const next = await orchestrator.runCinematic({
      snapshot,
      document,
    });

    expect(enhanceCinematic).toHaveBeenCalledTimes(1);
    // Stage result carries unit checkpoints for UI.
    expect(next.cinematic?.units?.length).toBeGreaterThan(0);
    expect(next.phase).toBe('preview_ready');
  });

  it('fails cinematic setup when performance patch cannot be replayed under performance policy', async () => {
    const document = materializePerformancePlaceholders({
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
    });

    // deleteLine is forbidden by performance policy — replay must not swallow.
    const illegalPerformancePatch = {
      version: SEMANTIC_SCENE_PATCH_VERSION,
      operations: [{
        kind: 'deleteLine' as const,
        line: 1,
      }],
    };

    const enhanceCinematic = vi.fn();
    const orchestrator = new FormalEnhancementOrchestrator({
      llm: {
        enhancePerformance: vi.fn(),
        enhanceCinematic,
      } as unknown as AiProseLlmService,
    });

    const groups = buildFormalStatementGroups(document);
    let snapshot = beginFormalEnhancementRun({
      binding: { sceneSessionEpoch: 1, documentVersion: 1 },
      document,
      segmentation: buildSingleSegmentSegmentation(groups),
    });
    snapshot = withSceneEnhancementStageResult(snapshot, {
      stage: 'performance',
      status: 'succeeded',
      patch: illegalPerformancePatch,
    });

    const next = await orchestrator.runCinematic({
      snapshot,
      document,
    });

    expect(enhanceCinematic).not.toHaveBeenCalled();
    expect(next.phase).toBe('failed');
    expect(next.cinematic?.status).toBe('failed');
    expect(next.cinematic?.diagnostics?.some((item) => item.code === 'performance_replay_failed')).toBe(true);
    void PERFORMANCE_STAGE_POLICY_V1;
    void createSceneEnhancementSnapshot;
  });

  it('does not run cinematic or expose a partial performance patch after a failed performance stage', async () => {
    const document = materializePerformancePlaceholders({
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
    });
    const partialPerformancePatch = {
      version: SEMANTIC_SCENE_PATCH_VERSION,
      operations: [{
        kind: 'updateCompanion' as const,
        line: 2,
        patch: { params: { motion: 'wave' } },
      }],
    };
    const enhanceCinematic = vi.fn();
    const orchestrator = new FormalEnhancementOrchestrator({
      llm: {
        enhancePerformance: vi.fn(),
        enhanceCinematic,
      } as unknown as AiProseLlmService,
    });

    const groups = buildFormalStatementGroups(document);
    let snapshot = beginFormalEnhancementRun({
      binding: { sceneSessionEpoch: 1, documentVersion: 1 },
      document,
      segmentation: buildSingleSegmentSegmentation(groups),
    });
    snapshot = withSceneEnhancementStageResult(snapshot, {
      stage: 'performance',
      status: 'retryableFailed',
      patch: partialPerformancePatch,
    });

    const next = await orchestrator.runCinematic({
      snapshot,
      document,
    });

    expect(enhanceCinematic).not.toHaveBeenCalled();
    expect(next.phase).toBe('failed');
    expect(next.previewPatch).toBeUndefined();
    expect(next.cinematic?.diagnostics?.some((item) => item.code === 'performance_stage_incomplete')).toBe(true);
  });
});

describe('FormalEnhancementOrchestrator performance re-run after cinematic', () => {
  function makePerformancePatch() {
    return {
      version: SEMANTIC_SCENE_PATCH_VERSION,
      operations: [{
        kind: 'updateCompanion' as const,
        line: 2,
        patch: { params: { motion: 'wave' } },
      }],
    };
  }

  function makeCinematicPatch() {
    return {
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
  }

  function makeDocument(): CurrentSceneDocument {
    return materializePerformancePlaceholders({
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
    });
  }

  function makeOrchestrator(performancePatches: unknown[]) {
    const enhancePerformance = vi.fn(async () => ({
      status: 'succeeded' as const,
      value: performancePatches.shift(),
      correctionUsed: false,
    }));
    const enhanceCinematic = vi.fn(async () => ({
      status: 'succeeded' as const,
      value: makeCinematicPatch(),
      correctionUsed: false,
    }));
    const orchestrator = new FormalEnhancementOrchestrator({
      llm: { enhancePerformance, enhanceCinematic } as unknown as AiProseLlmService,
      modelCapabilities: {
        hasModelConfigured: () => true,
        motionsForCharacter: () => ['wave'],
        expressionsForCharacter: () => [],
      },
    });
    return { orchestrator, enhancePerformance, enhanceCinematic };
  }

  it('clears the stale cinematic stage when performance is re-run after a successful cinematic', async () => {
    const document = makeDocument();
    const secondPatch = makePerformancePatch();
    const { orchestrator } = makeOrchestrator([makePerformancePatch(), secondPatch]);

    const groups = buildFormalStatementGroups(document);
    let snap = beginFormalEnhancementRun({
      binding: { sceneSessionEpoch: 1, documentVersion: 1 },
      document,
      segmentation: buildSingleSegmentSegmentation(groups),
    });

    snap = await orchestrator.runPerformance({
      snapshot: snap,
      document,
      binding: { sceneSessionEpoch: 1, documentVersion: 1 },
    });
    expect(snap.performance?.status).toBe('succeeded');

    snap = await orchestrator.runCinematic({ snapshot: snap, document });
    expect(snap.cinematic?.status).toBe('succeeded');
    expect(snap.phase).toBe('preview_ready');

    snap = await orchestrator.runPerformance({
      snapshot: snap,
      document,
      binding: { sceneSessionEpoch: 1, documentVersion: 1 },
    });

    expect(snap.cinematic).toBeUndefined();
    expect(snap.performance?.status).toBe('succeeded');
    expect(snap.previewPatch?.operations).toEqual(secondPatch.operations);
    const plan = resolveEnhancementStagePlan(snap);
    expect(plan?.stages.map((stage) => stage.stage)).toEqual(['performance']);
    expect(plan?.stages[0]?.patch.operations).toHaveLength(1);
  });

  it('keeps the cinematic stage when performance is not re-run', async () => {
    const document = makeDocument();
    const { orchestrator } = makeOrchestrator([makePerformancePatch()]);

    const groups = buildFormalStatementGroups(document);
    let snap = beginFormalEnhancementRun({
      binding: { sceneSessionEpoch: 1, documentVersion: 1 },
      document,
      segmentation: buildSingleSegmentSegmentation(groups),
    });

    snap = await orchestrator.runPerformance({
      snapshot: snap,
      document,
      binding: { sceneSessionEpoch: 1, documentVersion: 1 },
    });
    snap = await orchestrator.runCinematic({ snapshot: snap, document });

    expect(snap.performance?.status).toBe('succeeded');
    expect(snap.cinematic?.status).toBe('succeeded');
    expect(snap.phase).toBe('preview_ready');
    const plan = resolveEnhancementStagePlan(snap);
    expect(plan?.stages.map((stage) => stage.stage)).toEqual(['performance', 'cinematic']);
  });
});

describe('FormalEnhancementOrchestrator created-only placeholder baseline', () => {
  const emptyPatch = { version: SEMANTIC_SCENE_PATCH_VERSION, operations: [] };
  const createdPlaceholderFillPatch = {
    version: SEMANTIC_SCENE_PATCH_VERSION,
    operations: [{
      kind: 'updateCompanion' as const,
      line: 3,
      patch: { params: { motion: 'wave' } },
    }],
  };

  function makeFormalDocument(): CurrentSceneDocument {
    return {
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
  }

  function makeProjection(): { document: CurrentSceneDocument; projected: CurrentSceneDocument } {
    const document = makeFormalDocument();
    const plan = buildCharacterBindingPlan({
      document,
      confirmedMainCharacters: ['Alice'],
      requestedBindings: {},
    });
    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') throw new Error('binding plan must be ready');
    const projected = projectDraftSemanticScene({
      baseDocument: document,
      plan,
      confirmedMainCharacters: ['Alice'],
      previewStatements: [{
        speaker: 'Alice',
        text: '草稿台词。',
        time: 4,
        durationSeconds: 1,
      }],
    });
    return { document, projected };
  }

  function makeCapturingRunner(
    captured: { document?: CurrentSceneDocument },
    candidate: CurrentSceneDocument,
  ): EnhancementProcessorRunner {
    const runner = {
      runPerformance: async () => ({
        stage: 'performance' as const,
        status: 'succeeded' as const,
        patch: createdPlaceholderFillPatch,
        unitPatches: [createdPlaceholderFillPatch],
        candidate,
        units: [],
        diagnostics: [],
        policyVersion: 'policy/v1',
        processorVersion: 'processor/v1',
      }),
      runCinematic: async (input: { document: CurrentSceneDocument }) => {
        captured.document = input.document;
        return {
          stage: 'cinematic' as const,
          status: 'succeeded' as const,
          patch: emptyPatch,
          unitPatches: [],
          candidate: input.document,
          units: [],
          diagnostics: [],
          policyVersion: 'policy/v1',
          processorVersion: 'processor/v1',
        };
      },
    } as unknown as EnhancementProcessorRunner;
    return runner;
  }

  it('keeps the cinematic base on the created-only placeholder baseline when target statement ids are given', async () => {
    const { document, projected } = makeProjection();
    const formalStatementIds = new Set(document.statements.map((statement) => statement.id));
    const createdStatementIds = new Set(
      projected.statements
        .filter((statement) => !formalStatementIds.has(statement.id))
        .map((statement) => statement.id),
    );
    const captured: { document?: CurrentSceneDocument } = {};
    const orchestrator = new FormalEnhancementOrchestrator({
      llm: {} as unknown as AiProseLlmService,
      runnerFactory: () => makeCapturingRunner(captured, projected),
    });

    const groups = buildFormalStatementGroups(projected);
    let snap = beginFormalEnhancementRun({
      binding: { sceneSessionEpoch: 1, documentVersion: 1 },
      document: projected,
      segmentation: buildSingleSegmentSegmentation(groups),
    });
    snap = await orchestrator.runPerformance({
      snapshot: snap,
      document: projected,
      binding: { sceneSessionEpoch: 1, documentVersion: 1 },
      ensurePlaceholders: false,
      placeholderTargetStatementIds: createdStatementIds,
    });
    expect(snap.performance?.status).toBe('succeeded');

    snap = await orchestrator.runCinematic({
      snapshot: snap,
      document: projected,
      placeholderTargetStatementIds: createdStatementIds,
    });
    expect(snap.cinematic?.status).toBe('succeeded');
    expect(captured.document).toBeDefined();

    const formal = captured.document!.statements.find((statement) => statement.id === 'd0');
    expect(formal?.type).toBe('dialogue');
    if (formal?.type === 'dialogue') {
      // The pre-existing bound dialogue must NOT be backfilled with a placeholder.
      expect(formal.companions ?? []).toHaveLength(0);
    }
    const created = captured.document!.statements.find((statement) => statement.id !== 'd0');
    expect(created?.type).toBe('dialogue');
    if (created?.type === 'dialogue') {
      expect(created.companions).toHaveLength(1);
      expect(created.companions?.[0]?.params).toMatchObject({ motion: { kind: 'resource', key: 'wave' } });
    }
    // Line numbering matches the created-only baseline (2 statements + 1 companion).
    expect(new SemanticSceneLineView(captured.document!).internalLines().length).toBe(3);
  });

  it('keeps whole-document placeholder materialization when no target statement ids are given', async () => {
    const document = makeFormalDocument();
    const wholeDocFillPatch = {
      version: SEMANTIC_SCENE_PATCH_VERSION,
      operations: [{
        kind: 'updateCompanion' as const,
        line: 2,
        patch: { params: { motion: 'wave' } },
      }],
    };
    const captured: { document?: CurrentSceneDocument } = {};
    const runner = {
      runPerformance: async () => ({
        stage: 'performance' as const,
        status: 'succeeded' as const,
        patch: wholeDocFillPatch,
        unitPatches: [wholeDocFillPatch],
        candidate: document,
        units: [],
        diagnostics: [],
        policyVersion: 'policy/v1',
        processorVersion: 'processor/v1',
      }),
      runCinematic: async (input: { document: CurrentSceneDocument }) => {
        captured.document = input.document;
        return {
          stage: 'cinematic' as const,
          status: 'succeeded' as const,
          patch: emptyPatch,
          unitPatches: [],
          candidate: input.document,
          units: [],
          diagnostics: [],
          policyVersion: 'policy/v1',
          processorVersion: 'processor/v1',
        };
      },
    } as unknown as EnhancementProcessorRunner;
    const orchestrator = new FormalEnhancementOrchestrator({
      llm: {} as unknown as AiProseLlmService,
      runnerFactory: () => runner,
    });

    const groups = buildFormalStatementGroups(document);
    let snap = beginFormalEnhancementRun({
      binding: { sceneSessionEpoch: 1, documentVersion: 1 },
      document,
      segmentation: buildSingleSegmentSegmentation(groups),
    });
    snap = await orchestrator.runPerformance({
      snapshot: snap,
      document,
      binding: { sceneSessionEpoch: 1, documentVersion: 1 },
    });
    snap = await orchestrator.runCinematic({ snapshot: snap, document });

    expect(snap.cinematic?.status).toBe('succeeded');
    expect(captured.document).toBeDefined();
    const formal = captured.document!.statements.find((statement) => statement.id === 'd0');
    expect(formal?.type).toBe('dialogue');
    if (formal?.type === 'dialogue') {
      // Formal path keeps whole-document materialization: pre-existing dialogue
      // is backfilled on the cinematic base.
      expect(formal.companions).toHaveLength(1);
      expect(formal.companions?.[0]?.params).toMatchObject({ motion: { kind: 'resource', key: 'wave' } });
    }
    expect(new SemanticSceneLineView(captured.document!).internalLines().length).toBe(2);
  });
});
