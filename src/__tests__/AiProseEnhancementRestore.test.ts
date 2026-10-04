import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import type {
  AiProseEnhancementStageCheckpointV1,
  AiProseEnhancementStateV1,
} from '../api/types/ai-prose-enhancement';
import type { AiProseCharacterBindingPlanV1 } from '../api/types/ai-prose-authoring';
import {
  createIncrementalStageCheckpointPersister,
  enhancementStagePlanFromState,
  invalidateEnhancementFromStage,
  replayEnhancementState,
  restoreEnhancementState,
  type CurrentEnhancementVersionsV1,
} from '../services/ai-authoring/AiProseEnhancementRestore';
import {
  createAiProseEnhancementBaseFingerprint,
  createEmptyEnhancementState,
  normalizeRestoredStageCheckpoint,
  withEnhancementBoundDocumentVersion,
} from '../services/ai-authoring/AiProseEnhancementState';
import { createDraft, confirmMainCharacters, replaceEnhancementState } from '../services/ai-authoring/AiProseDraftSession';
import { migrateAiProseDraft } from '../services/ai-authoring/AiProseDraftMigration';
import { materializePerformancePlaceholders, buildCharacterBindingPlan, projectDraftSemanticScene } from '../services/ai-authoring/CharacterBindingPlan';
import { buildEnhancementUnitInputFingerprint } from '../services/ai-authoring/EnhancementUnitInput';
import { buildFormalStatementGroups } from '../services/ai-authoring/FormalSceneEnhancementHost';
import { expandSegmentationToProcessingUnits, type TechnicalSplitUnitV1 } from '../services/ai-authoring/EnhancementScope';

const CURRENT: CurrentEnhancementVersionsV1 = {
  policyVersions: {
    performance: 'performance-stage-policy/v1',
    cinematic: 'cinematic-stage-policy/v2',
  },
  processorVersions: {
    performance: 'performance-processor/v2',
    cinematic: 'cinematic-processor/v2',
  },
};

function makeState(overrides: Partial<AiProseEnhancementStateV1> = {}): AiProseEnhancementStateV1 {
  return {
    version: 1,
    baseFingerprint: 'baseline-fp',
    ...overrides,
  };
}

function succeededUnit(overrides: Record<string, unknown> = {}) {
  return {
    key: 'seg-0',
    stage: 'performance' as const,
    status: 'succeeded' as const,
    attemptCount: 1,
    policyVersion: CURRENT.policyVersions.performance,
    processorVersion: CURRENT.processorVersions.performance,
    inputFingerprint: 'unit-fp',
    patch: { version: 1 as const, operations: [] },
    ...overrides,
  };
}

function performanceStage(units: unknown[] = []): AiProseEnhancementStageCheckpointV1 {
  return {
    stage: 'performance',
    status: units.length > 0 ? 'succeeded' : 'idle',
    units: units as AiProseEnhancementStageCheckpointV1['units'],
  };
}

function cinematicStage(units: unknown[] = []): AiProseEnhancementStageCheckpointV1 {
  return {
    stage: 'cinematic',
    status: units.length > 0 ? 'succeeded' : 'idle',
    units: units as AiProseEnhancementStageCheckpointV1['units'],
  };
}

describe('normalizeRestoredStageCheckpoint', () => {
  it('maps a stage persisted as running with no running units to retryableFailed interrupted', () => {
    const patch = { version: 1 as const, operations: [] };
    const normalized = normalizeRestoredStageCheckpoint({
      stage: 'performance',
      status: 'running',
      units: [succeededUnit({ key: 'seg-0', status: 'succeeded', patch })],
    });

    expect(normalized.status).toBe('retryableFailed');
    expect(normalized.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'interrupted' }),
    );
    expect(normalized.units[0]).toMatchObject({
      key: 'seg-0',
      status: 'succeeded',
      patch,
    });
  });

  it('keeps unit-level normalization when a running stage also has a running unit', () => {
    const normalized = normalizeRestoredStageCheckpoint({
      stage: 'performance',
      status: 'running',
      units: [
        succeededUnit({ key: 'seg-0', status: 'succeeded' }),
        succeededUnit({ key: 'seg-1', status: 'running' }),
      ],
    });

    expect(normalized.status).toBe('retryableFailed');
    expect(normalized.units[1]).toMatchObject({
      status: 'retryableFailed',
      patch: undefined,
    });
    expect(normalized.units[1]?.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'interrupted' }),
    );
  });
});

describe('restoreEnhancementState', () => {
  it('normalizes leftover running units to retryableFailed(interrupted)', () => {
    const state = makeState({
      performance: performanceStage([
        succeededUnit({ key: 'seg-0', status: 'succeeded' }),
        succeededUnit({ key: 'seg-1', status: 'running' }),
      ]),
    });
    const restored = restoreEnhancementState({
      state,
      baseFingerprint: 'baseline-fp',
      current: CURRENT,
    });
    expect(restored.performance?.units[1]).toMatchObject({
      status: 'retryableFailed',
      patch: undefined,
    });
    expect(restored.performance?.units[1]?.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'interrupted' }),
    );
    expect(restored.performance?.status).toBe('retryableFailed');
  });

  it('invalidates every unit when the baseline fingerprint changed', () => {
    const state = makeState({
      performance: performanceStage([
        succeededUnit({ status: 'succeeded' }),
      ]),
      cinematic: cinematicStage([
        {
          key: 'seg-0',
          stage: 'cinematic',
          status: 'succeeded',
          attemptCount: 1,
          policyVersion: CURRENT.policyVersions.cinematic,
          processorVersion: CURRENT.processorVersions.cinematic,
          patch: { version: 1, operations: [] },
        },
      ]),
    });
    const restored = restoreEnhancementState({
      state,
      baseFingerprint: 'different-fp',
      current: CURRENT,
    });
    expect(restored.performance?.units[0]?.status).toBe('retryableFailed');
    expect(restored.performance?.units[0]?.diagnostics?.[0]?.code).toBe('baseline_changed');
    expect(restored.cinematic?.units[0]?.status).toBe('retryableFailed');
  });

  it('invalidates units when the persisted binding plan differs from the current one', () => {
    const plan: AiProseCharacterBindingPlanV1 = {
      status: 'ready',
      bindings: {
        素世: { name: '素世', speakerId: 'soyo', source: 'existing_unique' },
      },
      preallocatedCharacterIds: [],
    };
    const state = makeState({
      characterBindingPlan: plan,
      performance: performanceStage([succeededUnit({ status: 'succeeded' })]),
    });
    const restored = restoreEnhancementState({
      state,
      baseFingerprint: 'baseline-fp',
      currentBindingPlan: {
        status: 'ready',
        bindings: {
          素世: { name: '素世', speakerId: 'soyo2', source: 'preallocated' },
        },
        preallocatedCharacterIds: ['soyo2'],
      },
      current: CURRENT,
    });
    expect(restored.performance?.units[0]?.diagnostics?.[0]?.code).toBe('binding_plan_changed');
  });

  it('invalidates the affected stage and its downstream on processor version change', () => {
    const state = makeState({
      performance: performanceStage([
        succeededUnit({ status: 'succeeded' }),
      ]),
      cinematic: cinematicStage([
        {
          key: 'seg-0',
          stage: 'cinematic',
          status: 'succeeded',
          attemptCount: 1,
          policyVersion: CURRENT.policyVersions.cinematic,
          processorVersion: 'cinematic-processor/v0',
          patch: { version: 1, operations: [] },
        },
      ]),
    });
    const restored = restoreEnhancementState({
      state,
      baseFingerprint: 'baseline-fp',
      current: CURRENT,
    });
    // Cinematic unit invalidated by its own processor change.
    expect(restored.cinematic?.units[0]?.diagnostics?.[0]?.code).toBe('processor_version_changed');
  });

  it('keeps valid results when only the model changed (same versions)', () => {
    const state = makeState({
      performance: performanceStage([
        succeededUnit({
          status: 'succeeded',
          modelName: 'old-model',
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      ]),
    });
    const restored = restoreEnhancementState({
      state,
      baseFingerprint: 'baseline-fp',
      current: CURRENT,
    });
    expect(restored.performance?.units[0]?.status).toBe('succeeded');
    expect(restored.performance?.units[0]?.modelName).toBe('old-model');
  });

  it('invalidates downstream cinematic results when performance is invalid', () => {
    const state = makeState({
      performance: performanceStage([succeededUnit({ status: 'retryableFailed' })]),
      cinematic: cinematicStage([
        {
          key: 'seg-0',
          stage: 'cinematic',
          status: 'succeeded',
          attemptCount: 1,
          policyVersion: CURRENT.policyVersions.cinematic,
          processorVersion: CURRENT.processorVersions.cinematic,
          patch: { version: 1, operations: [] },
        },
      ]),
    });
    const restored = restoreEnhancementState({
      state,
      baseFingerprint: 'baseline-fp',
      current: CURRENT,
    });
    expect(restored.cinematic?.units[0]?.status).toBe('retryableFailed');
    expect(restored.cinematic?.units[0]?.diagnostics?.[0]?.code).toBe('downstream_invalidated');
  });

  it('invalidates downstream cinematic results when a performance unit carries invalid_checkpoint', () => {
    const state = makeState({
      performance: performanceStage([
        succeededUnit({
          key: 'seg-0',
          status: 'retryableFailed',
          patch: undefined,
          diagnostics: [{
            code: 'invalid_checkpoint',
            message: 'Invalid semantic scene patch at draft.enhancement.performance.units[0].patch',
          }],
        }),
      ]),
      cinematic: cinematicStage([
        {
          key: 'seg-0',
          stage: 'cinematic',
          status: 'succeeded',
          attemptCount: 1,
          policyVersion: CURRENT.policyVersions.cinematic,
          processorVersion: CURRENT.processorVersions.cinematic,
          patch: { version: 1, operations: [] },
        },
      ]),
    });
    const restored = restoreEnhancementState({
      state,
      baseFingerprint: 'baseline-fp',
      current: CURRENT,
    });
    expect(restored.performance?.units[0]?.status).toBe('retryableFailed');
    expect(restored.performance?.units[0]?.diagnostics?.[0]?.code).toBe('invalid_checkpoint');
    expect(restored.cinematic?.units[0]?.status).toBe('retryableFailed');
    expect(restored.cinematic?.units[0]?.diagnostics?.[0]?.code).toBe('downstream_invalidated');
  });
});

describe('invalidateEnhancementFromStage', () => {
  it('invalidates the stage and everything after it in order', () => {
    const state = makeState({
      performance: performanceStage([succeededUnit({ status: 'succeeded' })]),
      cinematic: cinematicStage([
        {
          key: 'seg-0',
          stage: 'cinematic',
          status: 'succeeded',
          attemptCount: 1,
          policyVersion: CURRENT.policyVersions.cinematic,
          processorVersion: CURRENT.processorVersions.cinematic,
          patch: { version: 1, operations: [] },
        },
      ]),
    });
    const invalidated = invalidateEnhancementFromStage(state, 'performance');
    expect(invalidated.performance?.units[0]?.status).toBe('retryableFailed');
    expect(invalidated.performance?.units[0]?.diagnostics?.[0]?.code).toBe('explicit_rerun');
    expect(invalidated.cinematic?.units[0]?.status).toBe('retryableFailed');
    expect(invalidated.cinematic?.units[0]?.diagnostics?.[0]?.code).toBe('downstream_invalidated');
  });
});

describe('replayEnhancementState', () => {
  it('replays succeeded patches onto the deterministic baseline in stable order', () => {
    const document = makeDocument();
    const lineView = new SemanticSceneLineView(document);
    const dialogueLine = lineView.internalLines().find((line) => line.kind === 'statement')!.line;

    const state = makeState({
      performance: performanceStage([
        succeededUnit({
          key: 'seg-0',
          status: 'succeeded',
          patch: {
            version: 1,
            operations: [{
              kind: 'insertCompanion',
              parentLine: dialogueLine,
              companion: {
                anchor: 'start',
                offset: 0,
                type: 'characterPerformance',
                params: { target: '$speaker', motion: 'wave' },
              },
            }],
          },
        }),
      ]),
    });

    const { state: replayedState, candidate } = replayEnhancementState({ document, state });
    expect(replayedState.performance?.units[0]?.status).toBe('succeeded');
    const dialogue = candidate.statements.find((statement) => statement.type === 'dialogue');
    expect(dialogue?.companions?.length).toBe(2);
  });

  it('invalidates a unit whose patch no longer applies and its downstream', () => {
    const document = makeDocument();
    const state = makeState({
      performance: performanceStage([
        succeededUnit({
          key: 'seg-0',
          status: 'succeeded',
          patch: {
            version: 1,
            operations: [{
              kind: 'deleteLine',
              line: 9999,
            }],
          },
        }),
      ]),
      cinematic: cinematicStage([
        {
          key: 'seg-0',
          stage: 'cinematic',
          status: 'succeeded',
          attemptCount: 1,
          policyVersion: CURRENT.policyVersions.cinematic,
          processorVersion: CURRENT.processorVersions.cinematic,
          patch: { version: 1, operations: [] },
        },
      ]),
    });

    const { state: replayedState } = replayEnhancementState({ document, state });
    expect(replayedState.performance?.units[0]?.status).toBe('retryableFailed');
    expect(replayedState.performance?.units[0]?.diagnostics?.[0]?.code).toBe('replay_failed');
    expect(replayedState.cinematic?.units[0]?.status).toBe('retryableFailed');
    expect(replayedState.cinematic?.units[0]?.diagnostics?.[0]?.code).toBe('downstream_invalidated');
  });

  it('replays a performance unit against the created-only projection without backfilling pre-existing dialogues', () => {
    const formalDocument: CurrentSceneDocument = {
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
          text: '既有台词。',
          durationSeconds: 1,
        },
      }],
    };
    const plan = buildCharacterBindingPlan({
      document: formalDocument,
      confirmedMainCharacters: ['Alice'],
      requestedBindings: {},
    });
    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') throw new Error('binding plan must be ready');
    const projected = projectDraftSemanticScene({
      baseDocument: formalDocument,
      plan,
      confirmedMainCharacters: ['Alice'],
      previewStatements: [{
        speaker: 'Alice',
        text: '草稿台词。',
        time: 4,
        durationSeconds: 1,
      }],
    });
    // Created-only baseline lines: 1 = d0, 2 = created dialogue, 3 = created placeholder.
    const createdLine = new SemanticSceneLineView(projected)
      .internalLines()
      .find((line) => line.kind === 'companion')!.line;
    expect(createdLine).toBe(3);

    const state = makeState({
      performance: performanceStage([
        succeededUnit({
          key: 'seg-0',
          status: 'succeeded',
          patch: {
            version: 1,
            operations: [{
              kind: 'updateCompanion',
              line: createdLine,
              patch: { params: { motion: 'wave' } },
            }],
          },
        }),
      ]),
    });

    const { state: replayed, candidate } = replayEnhancementState({ document: projected, state });
    expect(replayed.performance?.units[0]?.status).toBe('succeeded');
    expect(replayed.performance?.units[0]?.diagnostics?.some(
      (diagnostic) => diagnostic.code === 'replay_failed',
    ) ?? false).toBe(false);

    const formal = candidate.statements.find((statement) => statement.id === 'd0');
    expect(formal?.type).toBe('dialogue');
    if (formal?.type === 'dialogue') {
      // The pre-existing bound dialogue is never backfilled on replay.
      expect(formal.companions ?? []).toHaveLength(0);
    }
    const created = candidate.statements.find((statement) => statement.id !== 'd0');
    expect(created?.type).toBe('dialogue');
    if (created?.type === 'dialogue') {
      expect(created.companions).toHaveLength(1);
      expect(created.companions?.[0]?.params).toMatchObject({ motion: { kind: 'resource', key: 'wave' } });
    }
  });
});

describe('replayEnhancementState fingerprint verification', () => {
  const modelCapabilities = {
    hasModelConfigured: () => true,
    motionsForCharacter: () => ['idle', 'wave'],
    expressionsForCharacter: () => ['smile'],
  };

  function singleUnit(document: CurrentSceneDocument): TechnicalSplitUnitV1 {
    const groups = buildFormalStatementGroups(document);
    const plan = expandSegmentationToProcessingUnits({
      groups,
      segmentation: {
        narrativeBoundaries: [{ key: 'seg-0', startGroupIndex: 0, endGroupIndexExclusive: groups.length }],
      },
      maxVisibleCharsPerUnit: 6000,
    });
    if (plan.status !== 'ok') throw new Error(plan.message);
    return plan.units[0]!;
  }

  function fingerprintFor(document: CurrentSceneDocument): string {
    const unit = singleUnit(document);
    return buildEnhancementUnitInputFingerprint({
      document,
      stage: 'performance',
      unit,
      unitIndex: 0,
      totalUnits: 1,
      modelCapabilities,
    });
  }

  function editedTextDocument(): CurrentSceneDocument {
    const document = makeDocument();
    return {
      ...document,
      statements: document.statements.map((statement) => (
        statement.type === 'dialogue'
          ? { ...statement, params: { ...statement.params, text: '你好，世界！' } }
          : statement
      )),
    };
  }

  function companionLine(document: CurrentSceneDocument): number {
    return new SemanticSceneLineView(document)
      .internalLines()
      .find((line) => line.kind === 'companion')!.line;
  }

  function waveFillPatch(line: number) {
    return {
      version: 1,
      operations: [{
        kind: 'updateCompanion',
        line,
        patch: { params: { motion: 'wave' } },
      }],
    };
  }

  it('invalidates a unit whose stored input fingerprint no longer matches the edited baseline and its downstream', () => {
    const document = makeDocument();
    const edited = editedTextDocument();
    // Line locators are identical after a text-only edit, so the patch would
    // still apply — only the input fingerprint can detect the drift.
    const state = makeState({
      performance: performanceStage([
        succeededUnit({
          key: 'seg-0',
          status: 'succeeded',
          inputFingerprint: fingerprintFor(document),
          patch: waveFillPatch(companionLine(document)),
        }),
      ]),
      cinematic: cinematicStage([
        {
          key: 'seg-0',
          stage: 'cinematic',
          status: 'succeeded',
          attemptCount: 1,
          policyVersion: CURRENT.policyVersions.cinematic,
          processorVersion: CURRENT.processorVersions.cinematic,
          patch: { version: 1, operations: [] },
        },
      ]),
    });

    const { state: replayed, candidate } = replayEnhancementState({
      document: edited,
      state,
      ports: { modelCapabilities },
    });

    expect(replayed.performance?.units[0]?.status).toBe('retryableFailed');
    expect(replayed.performance?.units[0]?.diagnostics?.[0]?.code).toBe('replay_failed');
    const dialogue = candidate.statements.find((statement) => statement.id === 'd0');
    expect(dialogue?.type).toBe('dialogue');
    if (dialogue?.type === 'dialogue') {
      expect(dialogue.companions?.[0]?.params).not.toMatchObject({ motion: { kind: 'resource', key: 'wave' } });
    }
    expect(replayed.cinematic?.units[0]?.status).toBe('retryableFailed');
    expect(replayed.cinematic?.units[0]?.diagnostics?.[0]?.code).toBe('downstream_invalidated');
  });

  it('applies every patch without invalidation when the baseline is unchanged', () => {
    const document = makeDocument();
    const state = makeState({
      performance: performanceStage([
        succeededUnit({
          key: 'seg-0',
          status: 'succeeded',
          inputFingerprint: fingerprintFor(document),
          patch: waveFillPatch(companionLine(document)),
        }),
      ]),
    });

    const { state: replayed, candidate } = replayEnhancementState({
      document,
      state,
      ports: { modelCapabilities },
    });

    expect(replayed.performance?.units[0]?.status).toBe('succeeded');
    const dialogue = candidate.statements.find((statement) => statement.id === 'd0');
    expect(dialogue?.type).toBe('dialogue');
    if (dialogue?.type === 'dialogue') {
      expect(dialogue.companions?.[0]?.params).toMatchObject({ motion: { kind: 'resource', key: 'wave' } });
    }
  });

  it('skips fingerprint verification when no capability ports are provided', () => {
    const document = makeDocument();
    const edited = editedTextDocument();
    const state = makeState({
      performance: performanceStage([
        succeededUnit({
          key: 'seg-0',
          status: 'succeeded',
          inputFingerprint: fingerprintFor(document),
          patch: waveFillPatch(companionLine(document)),
        }),
      ]),
    });

    const { state: replayed, candidate } = replayEnhancementState({
      document: edited,
      state,
    });
    expect(replayed.performance?.units[0]?.status).toBe('succeeded');
    const dialogue = candidate.statements.find((statement) => statement.id === 'd0');
    expect(dialogue?.type).toBe('dialogue');
    if (dialogue?.type === 'dialogue') {
      expect(dialogue.companions?.[0]?.params).toMatchObject({ motion: { kind: 'resource', key: 'wave' } });
    }
  });

  function budgetSensitiveState(document: CurrentSceneDocument, budget: number, persistBudget: boolean): AiProseEnhancementStateV1 {
    const totalUnits = unitCount(document);
    const unit = unitAt(document, 0);
    const fingerprint = buildEnhancementUnitInputFingerprint({
      document,
      stage: 'performance',
      unit,
      unitIndex: 0,
      totalUnits,
      modelCapabilities,
      maxLineViewContextChars: budget,
    });
    const units = Array.from({ length: totalUnits }, (_, index) => (
      index === 0
        ? succeededUnit({
            key: unit.key,
            status: 'succeeded',
            inputFingerprint: fingerprint,
            ...(persistBudget ? { lineViewContextChars: budget } : {}),
            patch: waveFillPatch(companionLine(document)),
          })
        : succeededUnit({ key: unitAt(document, index).key, status: 'idle' })
    ));
    return makeState({ performance: performanceStage(units) });
  }

  it('replays a unit whose fingerprint used a persisted non-default line view budget', () => {
    // Two+ units: the first unit's line view carries read-only context whose
    // extent depends on the context budget, so 6000 vs 12000 yield different
    // fingerprints. The persisted budget must make replay match.
    const document = multiUnitDocument();
    const state = budgetSensitiveState(document, 12000, true);

    const { state: replayed, candidate } = replayEnhancementState({
      document,
      state,
      ports: { modelCapabilities },
    });
    expect(replayed.performance?.units[0]?.status).toBe('succeeded');
    const dialogue = candidate.statements.find((statement) => statement.id === 'd0');
    expect(dialogue?.type).toBe('dialogue');
    if (dialogue?.type === 'dialogue') {
      expect(dialogue.companions?.[0]?.params).toMatchObject({ motion: { kind: 'resource', key: 'wave' } });
    }
  });

  it('invalidates a non-default-budget fingerprint when the budget was not persisted', () => {
    const document = multiUnitDocument();
    const state = budgetSensitiveState(document, 12000, false);

    const { state: replayed } = replayEnhancementState({
      document,
      state,
      ports: { modelCapabilities },
    });
    expect(replayed.performance?.units[0]?.status).toBe('retryableFailed');
    expect(replayed.performance?.units[0]?.diagnostics?.[0]?.code).toBe('replay_failed');
  });
});

function multiUnitDocument(): CurrentSceneDocument {
  const lineText = '她站在窗边，望着远处的霓虹灯闪烁不定，心里反复回想刚才那段对话。'.repeat(12);
  return materializePerformancePlaceholders({
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene-long',
    meta: {
      title: 'Long',
      characters: [{ id: 'c1', name: 'Alice' }],
    },
    statements: Array.from({ length: 40 }, (_, i) => ({
      id: `d${i}`,
      time: i * 2,
      type: 'dialogue' as const,
      params: {
        speakerId: 'c1',
        speaker: 'Alice',
        text: lineText,
        durationSeconds: 1,
      },
    })),
  });
}

function unitCount(document: CurrentSceneDocument): number {
  const groups = buildFormalStatementGroups(document);
  const plan = expandSegmentationToProcessingUnits({
    groups,
    segmentation: {
      narrativeBoundaries: [{ key: 'seg-0', startGroupIndex: 0, endGroupIndexExclusive: groups.length }],
    },
    maxVisibleCharsPerUnit: 6000,
  });
  if (plan.status !== 'ok') throw new Error(plan.message);
  return plan.units.length;
}

function unitAt(document: CurrentSceneDocument, index: number): TechnicalSplitUnitV1 {
  const groups = buildFormalStatementGroups(document);
  const plan = expandSegmentationToProcessingUnits({
    groups,
    segmentation: {
      narrativeBoundaries: [{ key: 'seg-0', startGroupIndex: 0, endGroupIndexExclusive: groups.length }],
    },
    maxVisibleCharsPerUnit: 6000,
  });
  if (plan.status !== 'ok') throw new Error(plan.message);
  return plan.units[index]!;
}

describe('enhancementStagePlanFromState', () => {
  it('builds an apply plan from succeeded units only', () => {
    const state = makeState({
      performance: performanceStage([
        succeededUnit({ status: 'succeeded' }),
        succeededUnit({ status: 'retryableFailed' }),
      ]),
      cinematic: cinematicStage([
        {
          key: 'seg-0',
          stage: 'cinematic',
          status: 'succeeded',
          attemptCount: 1,
          policyVersion: CURRENT.policyVersions.cinematic,
          processorVersion: CURRENT.processorVersions.cinematic,
          patch: {
            version: 1,
            operations: [{
              kind: 'insertStatement',
              time: 3,
              statement: {
                type: 'camera',
                params: {},
              },
            }],
          },
        },
      ]),
    });
    const plan = enhancementStagePlanFromState(state);
    expect(plan.stages.map((stage) => stage.stage)).toEqual(['cinematic']);
    expect(plan.stages[0]?.patch.operations.length).toBe(1);
  });
});

describe('createIncrementalStageCheckpointPersister', () => {
  it('persists a running checkpoint with empty units on stage start and accumulates units in unitIndex order', () => {
    const persisted: Array<[string, AiProseEnhancementStageCheckpointV1]> = [];
    const hooks = createIncrementalStageCheckpointPersister({
      persist: (stage, checkpoint) => persisted.push([stage, checkpoint]),
    });

    hooks.onStageStarted('performance');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toEqual([
      'performance',
      { stage: 'performance', status: 'running', units: [] },
    ]);

    // Concurrent runs may complete out of unitIndex order.
    hooks.onUnitComplete(succeededUnit({ key: 'seg-1' }), 1, 2);
    hooks.onUnitComplete(succeededUnit({ key: 'seg-0' }), 0, 2);

    expect(persisted).toHaveLength(3);
    const partial = persisted[2]![1];
    expect(partial.status).toBe('running');
    expect(partial.stage).toBe('performance');
    expect(partial.units.map((unit) => unit.key)).toEqual(['seg-0', 'seg-1']);
  });

  it('keeps accumulation per stage and resets when a new stage starts', () => {
    const persisted: Array<[string, AiProseEnhancementStageCheckpointV1]> = [];
    const hooks = createIncrementalStageCheckpointPersister({
      persist: (stage, checkpoint) => persisted.push([stage, checkpoint]),
    });

    hooks.onStageStarted('performance');
    hooks.onUnitComplete(succeededUnit({ key: 'seg-0' }), 0, 1);
    hooks.onStageStarted('cinematic');

    expect(persisted[2]).toEqual([
      'cinematic',
      { stage: 'cinematic', status: 'running', units: [] },
    ]);
    hooks.onUnitComplete(succeededUnit({ key: 'cin-0', stage: 'cinematic' }), 0, 1);
    expect(persisted[3]![1].units.map((unit) => unit.key)).toEqual(['cin-0']);
  });
});

describe('createAiProseEnhancementBaseFingerprint', () => {
  it('is stable per baseline and changes when the segmentation plan changes', () => {
    const draft = () => {
      let next = createDraft({
        sceneId: 'scene-1',
        sessionId: 'fp',
        sourceText: '正文',
        anchorMode: 'zero',
      });
      next = confirmMainCharacters(next, ['素世']);
      return next;
    };
    const fp = createAiProseEnhancementBaseFingerprint(draft());
    expect(fp).toBe(createAiProseEnhancementBaseFingerprint(draft()));
    const changed = {
      ...draft(),
      segmentation: {
        ...draft().segmentation,
        planFingerprint: 'other-plan',
      },
    };
    expect(createAiProseEnhancementBaseFingerprint(changed)).not.toBe(fp);
  });
});

describe('boundDocumentVersion binding', () => {
  function boundDraft(version: number) {
    let draft = createDraft({
      sceneId: 'scene-1',
      sessionId: 'binding',
      sourceText: '正文',
      anchorMode: 'zero',
    });
    draft = confirmMainCharacters(draft, ['素世']);
    return replaceEnhancementState(
      draft,
      withEnhancementBoundDocumentVersion(createEmptyEnhancementState(draft), version),
    );
  }

  it('binds an optional document version onto the enhancement state', () => {
    const draft = boundDraft(7);
    expect(draft.enhancement?.boundDocumentVersion).toBe(7);
  });

  it('round-trips boundDocumentVersion through draft checkpoint persistence', () => {
    const draft = boundDraft(12);
    const migrated = migrateAiProseDraft(JSON.parse(JSON.stringify(draft)));
    expect(migrated.enhancement?.boundDocumentVersion).toBe(12);
  });

  it('keeps legacy enhancement states without a binding parseable', () => {
    let draft = createDraft({
      sceneId: 'scene-1',
      sessionId: 'binding-legacy',
      sourceText: '正文',
      anchorMode: 'zero',
    });
    draft = confirmMainCharacters(draft, ['素世']);
    draft = replaceEnhancementState(draft, createEmptyEnhancementState(draft));
    const migrated = migrateAiProseDraft(JSON.parse(JSON.stringify(draft)));
    expect(migrated.enhancement?.boundDocumentVersion).toBeUndefined();
  });
});

import { SemanticSceneLineView } from '../services/semantic-scene/SemanticSceneLineView';

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
