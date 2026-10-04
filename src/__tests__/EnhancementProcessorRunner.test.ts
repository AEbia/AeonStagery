import { describe, expect, it, vi } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import { SEMANTIC_SCENE_PATCH_VERSION } from '../api/types/semantic-scene-patch';
import { EnhancementProcessorRunner } from '../services/ai-authoring/EnhancementProcessorRunner';
import {
  enhancementStageCheckpointFromSnapshot,
  replayEnhancementState,
} from '../services/ai-authoring/AiProseEnhancementRestore';
import { buildEnhancementUnitInputFingerprint } from '../services/ai-authoring/EnhancementUnitInput';
import { buildFormalStatementGroups } from '../services/ai-authoring/FormalSceneEnhancementHost';
import { expandSegmentationToProcessingUnits } from '../services/ai-authoring/EnhancementScope';
import type { AiProseLlmService } from '../services/ai-authoring/AiProseLlmService';
import { buildCharacterBindingPlan, materializePerformancePlaceholders, projectDraftSemanticScene } from '../services/ai-authoring/CharacterBindingPlan';
import { AiProseRequestBudget } from '../services/ai-authoring/AiProseRequestBudget';
import { applyEnhancementStagePlan } from '../services/ai-authoring/FormalEnhancementApply';
import {
  StaticPerformanceProfileProvider,
  parsePerformanceProfileDocument,
  type PerformanceCapabilityCatalogV1,
} from '../services/ai-authoring/performance';

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
          text: '第一句。',
          durationSeconds: 1,
        },
      },
      {
        id: 'd1',
        time: 2,
        type: 'dialogue',
        params: {
          speakerId: 'c1',
          speaker: 'Alice',
          text: '第二句。',
          durationSeconds: 1,
        },
      },
    ],
  });
}

describe('EnhancementProcessorRunner', () => {
  it('runs performance units and merges empty operations as no_changes', async () => {
    const document = makeDocument();
    const enhancePerformance = vi.fn(async () => ({
      status: 'succeeded' as const,
      value: { version: SEMANTIC_SCENE_PATCH_VERSION, operations: [] },
      correctionUsed: false,
    }));
    const llm = {
      enhancePerformance,
      enhanceCinematic: vi.fn(),
    } as unknown as AiProseLlmService;

    const runner = new EnhancementProcessorRunner({
      llm,
      modelCapabilities: {
        hasModelConfigured: () => true,
        motionsForCharacter: () => ['idle', 'wave'],
        expressionsForCharacter: () => ['smile'],
      },
    });

    const result = await runner.runPerformance({
      document,
      segmentation: {
        segmentKeys: ['seg-0'],
        narrativeBoundaries: [{
          key: 'seg-0',
          startGroupIndex: 0,
          endGroupIndexExclusive: 2,
        }],
      },
    });

    expect(enhancePerformance).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('no_changes');
    expect(result.patch.operations).toHaveLength(0);
    expect(result.units[0]?.status).toBe('succeeded');
    expect(result.units[0]?.inputFingerprint).toMatch(/^[a-f0-9]{16,}$/);
  });

  it('stores a unit fingerprint identical to the shared pure builder for the same inputs', async () => {
    const document = makeDocument();
    const modelCapabilities = {
      hasModelConfigured: () => true,
      motionsForCharacter: () => ['idle', 'wave'],
      expressionsForCharacter: () => ['smile'],
    };
    const enhancePerformance = vi.fn(async () => ({
      status: 'succeeded' as const,
      value: { version: SEMANTIC_SCENE_PATCH_VERSION, operations: [] },
      correctionUsed: false,
    }));
    const llm = {
      enhancePerformance,
      enhanceCinematic: vi.fn(),
    } as unknown as AiProseLlmService;

    const runner = new EnhancementProcessorRunner({
      llm,
      modelCapabilities,
    });

    const result = await runner.runPerformance({
      document,
      segmentation: {
        segmentKeys: ['seg-0'],
        narrativeBoundaries: [{
          key: 'seg-0',
          startGroupIndex: 0,
          endGroupIndexExclusive: 2,
        }],
      },
    });

    const stored = result.units[0]!.inputFingerprint;
    expect(stored).toBeTruthy();

    const groups = buildFormalStatementGroups(document);
    const plan = expandSegmentationToProcessingUnits({
      groups,
      segmentation: {
        narrativeBoundaries: [{ key: 'seg-0', startGroupIndex: 0, endGroupIndexExclusive: 2 }],
      },
      maxVisibleCharsPerUnit: 6000,
    });
    expect(plan.status).toBe('ok');
    if (plan.status !== 'ok') return;

    const recomputed = buildEnhancementUnitInputFingerprint({
      document,
      stage: 'performance',
      unit: plan.units[0]!,
      unitIndex: 0,
      totalUnits: plan.units.length,
      modelCapabilities,
    });

    expect(recomputed).toBe(stored);
  });

  it('accepts a monotonic performance fill of empty motion placeholder', async () => {
    const document = makeDocument();
    const dialogueLine = 1; // root dialogue
    const companionLine = 2; // placeholder companion

    const enhancePerformance = vi.fn(async () => ({
      status: 'succeeded' as const,
      value: {
        version: SEMANTIC_SCENE_PATCH_VERSION,
        operations: [{
          kind: 'updateCompanion' as const,
          line: companionLine,
          patch: {
            params: { motion: 'wave' },
          },
        }],
      },
      correctionUsed: false,
    }));

    const runner = new EnhancementProcessorRunner({
      llm: { enhancePerformance, enhanceCinematic: vi.fn() } as unknown as AiProseLlmService,
      modelCapabilities: {
        hasModelConfigured: () => true,
        motionsForCharacter: () => ['wave'],
        expressionsForCharacter: () => [],
      },
    });

    const result = await runner.runPerformance({
      document,
      segmentation: {
        segmentKeys: ['seg-0'],
        narrativeBoundaries: [{
          key: 'seg-0',
          startGroupIndex: 0,
          endGroupIndexExclusive: 1,
        }],
      },
    });

    expect(result.status).toBe('succeeded');
    expect(result.patch.operations).toHaveLength(1);
    const alice = result.candidate.statements.find((statement) => statement.id === 'd0');
    expect(alice?.type).toBe('dialogue');
    if (alice?.type === 'dialogue') {
      expect(alice.companions?.[0]?.params).toMatchObject({ motion: { kind: 'resource', key: 'wave' } });
    }
    void dialogueLine;
  });

  it('keeps successful performance unit patches when another unit fails', async () => {
    const document = makeDocument();
    // Two narrative units → two processing units; first succeeds, second fails.
    const enhancePerformance = vi.fn(async (input: { unitKey: string }) => {
      if (input.unitKey.includes('#t1') || input.unitKey.endsWith('1') || input.unitKey === 'seg-1') {
        return {
          status: 'failed' as const,
          error: { code: 'invalid-ai-response', message: 'unit failed' },
          correctionUsed: false,
        };
      }
      // Fill first dialogue placeholder (line 2 on full doc; unit 0 only has d0 → lines 1-2).
      return {
        status: 'succeeded' as const,
        value: {
          version: SEMANTIC_SCENE_PATCH_VERSION,
          operations: [{
            kind: 'updateCompanion' as const,
            line: 2,
            patch: { params: { motion: 'wave' } },
          }],
        },
        correctionUsed: false,
      };
    });

    const runner = new EnhancementProcessorRunner({
      llm: { enhancePerformance, enhanceCinematic: vi.fn() } as unknown as AiProseLlmService,
      modelCapabilities: {
        hasModelConfigured: () => true,
        motionsForCharacter: () => ['wave'],
        expressionsForCharacter: () => [],
      },
      maxVisibleCharsPerUnit: 6000,
    });

    const result = await runner.runPerformance({
      document,
      segmentation: {
        segmentKeys: ['seg-0', 'seg-1'],
        narrativeBoundaries: [
          { key: 'seg-0', startGroupIndex: 0, endGroupIndexExclusive: 1 },
          { key: 'seg-1', startGroupIndex: 1, endGroupIndexExclusive: 2 },
        ],
      },
      concurrency: 2,
    });

    expect(enhancePerformance).toHaveBeenCalledTimes(2);
    expect(result.units.some((unit) => unit.status === 'succeeded')).toBe(true);
    expect(result.units.some((unit) => unit.status === 'retryableFailed' || unit.status === 'failed')).toBe(true);
    // Successful window retained — not wiped to EMPTY_PATCH.
    expect(result.patch.operations.length).toBeGreaterThan(0);
    const first = result.candidate.statements.find((statement) => statement.id === 'd0');
    expect(first?.type).toBe('dialogue');
    if (first?.type === 'dialogue') {
      expect(first.companions?.[0]?.params).toMatchObject({ motion: { kind: 'resource', key: 'wave' } });
    }
    // Stage reports retryable so host can retry only the failed window.
    expect(result.status).toBe('retryableFailed');
  });

  it('rebases later concurrent unit locators after an earlier structural insert', async () => {
    const document = makeDocument();
    const enhancePerformance = vi.fn(async (input: { unitKey: string }) => {
      if (input.unitKey.includes('seg-0')) {
        return {
          status: 'succeeded' as const,
          value: {
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
                  durationSeconds: 0.1,
                },
              },
            }],
          },
          correctionUsed: false,
        };
      }
      return {
        status: 'succeeded' as const,
        value: {
          version: SEMANTIC_SCENE_PATCH_VERSION,
          operations: [{
            kind: 'updateCompanion' as const,
            // d1's companion in the original line view; it shifts after seg-0 inserts.
            line: 4,
            patch: { params: { motion: 'wave' } },
          }],
        },
        correctionUsed: false,
      };
    });

    const runner = new EnhancementProcessorRunner({
      llm: { enhancePerformance, enhanceCinematic: vi.fn() } as unknown as AiProseLlmService,
      modelCapabilities: {
        hasModelConfigured: () => true,
        motionsForCharacter: () => ['wave'],
        expressionsForCharacter: () => [],
      },
    });

    const result = await runner.runPerformance({
      document,
      segmentation: {
        segmentKeys: ['seg-0', 'seg-1'],
        narrativeBoundaries: [
          { key: 'seg-0', startGroupIndex: 0, endGroupIndexExclusive: 1 },
          { key: 'seg-1', startGroupIndex: 1, endGroupIndexExclusive: 2 },
        ],
      },
      concurrency: 2,
    });

    expect(result.status).toBe('succeeded');
    expect(result.candidate.statements.some((statement) => statement.type === 'characterTransform')).toBe(true);
    const second = result.candidate.statements.find((statement) => statement.id === 'd1');
    expect(second?.type).toBe('dialogue');
    if (second?.type === 'dialogue') {
      expect(second.companions?.[0]?.params).toMatchObject({ motion: { kind: 'resource', key: 'wave' } });
    }

    // The persisted stage patch must replay from the original base as well.
    const replayed = applyEnhancementStagePlan(document, {
      version: 1,
      stages: result.unitPatches.map((patch) => ({ stage: 'performance' as const, patch })),
    }).candidate;
    const replayedSecond = replayed.statements.find((statement) => statement.id === 'd1');
    expect(replayedSecond?.type).toBe('dialogue');
    if (replayedSecond?.type === 'dialogue') {
      expect(replayedSecond.companions?.[0]?.params).toMatchObject({ motion: { kind: 'resource', key: 'wave' } });
    }
  });

  it('persists base-authored unit patches and rebases them when restoring replay after a structural insert', async () => {
    const document = makeDocument();
    const enhancePerformance = vi.fn(async (input: { unitKey: string }) => {
      if (input.unitKey.includes('seg-0')) {
        return {
          status: 'succeeded' as const,
          value: {
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
                  durationSeconds: 0.1,
                },
              },
            }],
          },
          correctionUsed: false,
        };
      }
      return {
        status: 'succeeded' as const,
        value: {
          version: SEMANTIC_SCENE_PATCH_VERSION,
          operations: [{
            kind: 'updateCompanion' as const,
            // d1's companion in the original line view; it shifts after seg-0 inserts.
            line: 4,
            patch: { params: { motion: 'wave' } },
          }],
        },
        correctionUsed: false,
      };
    });

    const runner = new EnhancementProcessorRunner({
      llm: { enhancePerformance, enhanceCinematic: vi.fn() } as unknown as AiProseLlmService,
      modelCapabilities: {
        hasModelConfigured: () => true,
        motionsForCharacter: () => ['wave'],
        expressionsForCharacter: () => [],
      },
    });

    const result = await runner.runPerformance({
      document,
      segmentation: {
        segmentKeys: ['seg-0', 'seg-1'],
        narrativeBoundaries: [
          { key: 'seg-0', startGroupIndex: 0, endGroupIndexExclusive: 1 },
          { key: 'seg-1', startGroupIndex: 1, endGroupIndexExclusive: 2 },
        ],
      },
      concurrency: 2,
    });
    if (result.status !== 'succeeded') throw new Error('stage must succeed');

    // Persisted unit checkpoints always carry the ORIGINAL base-authored patch
    // (line 4, authored against the unit base snapshot). The in-memory
    // unitPatches list stays rebased (line 5) — that is the live apply path.
    expect(result.units[1]?.patch?.operations).toEqual([
      expect.objectContaining({ line: 4 }),
    ]);
    expect(result.unitPatches[1]?.operations).toEqual([
      expect.objectContaining({ line: 5 }),
    ]);

    // Persist the stage result as a checkpoint, then restore-replay from the
    // deterministic baseline: replay rebases each performance patch itself, so
    // the replayed candidate equals the runner's in-memory candidate.
    const checkpoint = enhancementStageCheckpointFromSnapshot('performance', {
      stage: result.stage,
      status: result.status,
      units: result.units,
      diagnostics: result.diagnostics,
      patch: result.patch,
      unitPatches: result.unitPatches,
      policyVersion: result.policyVersion,
      processorVersion: result.processorVersion,
    });
    const state = {
      version: 1 as const,
      baseFingerprint: 'baseline-fp',
      performance: checkpoint,
    };
    const { state: replayedState, candidate } = replayEnhancementState({ document, state });

    expect(replayedState.performance?.units.every((unit) => unit.status === 'succeeded')).toBe(true);
    expect(replayedState.performance?.units.some(
      (unit) => unit.diagnostics?.some((diagnostic) => diagnostic.code === 'replay_failed'),
    ) ?? false).toBe(false);
    const second = candidate.statements.find((statement) => statement.id === 'd1');
    expect(second?.type).toBe('dialogue');
    if (second?.type === 'dialogue') {
      expect(second.companions?.[0]?.params).toMatchObject({ motion: { kind: 'resource', key: 'wave' } });
    }
    // The replayed candidate equals the runner's in-memory candidate modulo the
    // randomly generated statement id (ids are minted at apply time, not
    // carried in the patch).
    const normalize = (statements: CurrentSceneDocument['statements']) => (
      statements.map((statement, index) => ({ ...statement, id: `${statement.type}-${index}` }))
    );
    expect(normalize(candidate.statements)).toEqual(normalize(result.candidate.statements));
  });

  it('persists a unit whose fold violates monotonic completion as retryableFailed without its patch', async () => {
    const document = makeDocument();
    // Two narrative boundaries covering the same core group: both units may
    // write d0's placeholder; the later fold then violates monotonic completion
    // against the rolling candidate and the stage drops that patch.
    const enhancePerformance = vi.fn(async (input: { unitKey: string }) => {
      const motion = input.unitKey.includes('seg-0') ? 'wave' : 'dance';
      return {
        status: 'succeeded' as const,
        value: {
          version: SEMANTIC_SCENE_PATCH_VERSION,
          operations: [{
            kind: 'updateCompanion' as const,
            line: 2,
            patch: { params: { motion } },
          }],
        },
        correctionUsed: false,
      };
    });

    const runner = new EnhancementProcessorRunner({
      llm: { enhancePerformance, enhanceCinematic: vi.fn() } as unknown as AiProseLlmService,
      modelCapabilities: {
        hasModelConfigured: () => true,
        motionsForCharacter: () => ['wave', 'dance'],
        expressionsForCharacter: () => [],
      },
    });

    const result = await runner.runPerformance({
      document,
      segmentation: {
        segmentKeys: ['seg-0', 'seg-1'],
        narrativeBoundaries: [
          { key: 'seg-0', startGroupIndex: 0, endGroupIndexExclusive: 1 },
          { key: 'seg-1', startGroupIndex: 0, endGroupIndexExclusive: 2 },
        ],
      },
      concurrency: 2,
    });

    if (result.status !== 'retryableFailed') throw new Error('stage must be retryable');
    const checkpoint = enhancementStageCheckpointFromSnapshot('performance', {
      stage: result.stage,
      status: result.status,
      units: result.units,
      diagnostics: result.diagnostics,
      patch: result.patch,
      unitPatches: result.unitPatches,
      policyVersion: result.policyVersion,
      processorVersion: result.processorVersion,
    });
    const seg1 = checkpoint.units.find((unit) => unit.key === 'seg-1');
    expect(seg1?.status).toBe('retryableFailed');
    expect(seg1?.patch).toBeUndefined();
    const seg0 = checkpoint.units.find((unit) => unit.key === 'seg-0');
    expect(seg0?.status).toBe('succeeded');
  });

  it('replays an all-succeeded concurrent run identically to the in-memory candidate', async () => {
    const document = makeDocument();
    const enhancePerformance = vi.fn(async (input: { unitKey: string }) => {
      const line = input.unitKey.includes('seg-0') ? 2 : 4;
      return {
        status: 'succeeded' as const,
        value: {
          version: SEMANTIC_SCENE_PATCH_VERSION,
          operations: [{
            kind: 'updateCompanion' as const,
            line,
            patch: { params: { motion: 'wave' } },
          }],
        },
        correctionUsed: false,
      };
    });

    const runner = new EnhancementProcessorRunner({
      llm: { enhancePerformance, enhanceCinematic: vi.fn() } as unknown as AiProseLlmService,
      modelCapabilities: {
        hasModelConfigured: () => true,
        motionsForCharacter: () => ['wave'],
        expressionsForCharacter: () => [],
      },
    });

    const result = await runner.runPerformance({
      document,
      segmentation: {
        segmentKeys: ['seg-0', 'seg-1'],
        narrativeBoundaries: [
          { key: 'seg-0', startGroupIndex: 0, endGroupIndexExclusive: 1 },
          { key: 'seg-1', startGroupIndex: 1, endGroupIndexExclusive: 2 },
        ],
      },
      concurrency: 2,
    });
    if (result.status !== 'succeeded') throw new Error('stage must succeed');

    const checkpoint = enhancementStageCheckpointFromSnapshot('performance', {
      stage: result.stage,
      status: result.status,
      units: result.units,
      diagnostics: result.diagnostics,
      patch: result.patch,
      unitPatches: result.unitPatches,
      policyVersion: result.policyVersion,
      processorVersion: result.processorVersion,
    });
    const { state: replayedState, candidate } = replayEnhancementState({
      document,
      state: { version: 1 as const, baseFingerprint: 'baseline-fp', performance: checkpoint },
    });
    expect(replayedState.performance?.units.every((unit) => unit.status === 'succeeded')).toBe(true);
    expect(candidate.statements).toEqual(result.candidate.statements);
  });

  it('caps performance unit workers by request budget capacity', async () => {
    const document = makeDocument();
    let inFlight = 0;
    let maxInFlight = 0;
    const enhancePerformance = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return {
        status: 'succeeded' as const,
        value: { version: SEMANTIC_SCENE_PATCH_VERSION, operations: [] },
        correctionUsed: false,
      };
    });

    const runner = new EnhancementProcessorRunner({
      llm: { enhancePerformance, enhanceCinematic: vi.fn() } as unknown as AiProseLlmService,
      modelCapabilities: {
        hasModelConfigured: () => true,
        motionsForCharacter: () => ['wave'],
        expressionsForCharacter: () => [],
      },
      requestBudget: new AiProseRequestBudget(1),
    });

    await runner.runPerformance({
      document,
      segmentation: {
        segmentKeys: ['seg-0', 'seg-1'],
        narrativeBoundaries: [
          { key: 'seg-0', startGroupIndex: 0, endGroupIndexExclusive: 1 },
          { key: 'seg-1', startGroupIndex: 1, endGroupIndexExclusive: 2 },
        ],
      },
      // Caller asks for 4, but budget capacity is 1.
      concurrency: 4,
    });

    expect(enhancePerformance).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
  });

  it('requests one host-gate correction when the first patch violates stage scope', async () => {
    const document = makeDocument();
    let calls = 0;
    const enhancePerformance = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        // Line 4 is the second dialogue — outside unit that only covers group 0.
        return {
          status: 'succeeded' as const,
          value: {
            version: SEMANTIC_SCENE_PATCH_VERSION,
            operations: [{
              kind: 'updateCompanion' as const,
              line: 4,
              patch: { params: { motion: 'wave' } },
            }],
          },
          correctionUsed: false,
        };
      }
      return {
        status: 'succeeded' as const,
        value: {
          version: SEMANTIC_SCENE_PATCH_VERSION,
          operations: [{
            kind: 'updateCompanion' as const,
            line: 2,
            patch: { params: { motion: 'wave' } },
          }],
        },
        correctionUsed: true,
      };
    });

    const correctEnhancementPatch = vi.fn(async () => ({
      status: 'succeeded' as const,
      value: {
        version: SEMANTIC_SCENE_PATCH_VERSION,
        operations: [{
          kind: 'updateCompanion' as const,
          line: 2,
          patch: { params: { motion: 'wave' } },
        }],
      },
      correctionUsed: true,
    }));

    const runner = new EnhancementProcessorRunner({
      llm: {
        enhancePerformance,
        enhanceCinematic: vi.fn(),
        correctEnhancementPatch,
      } as unknown as AiProseLlmService,
      modelCapabilities: {
        hasModelConfigured: () => true,
        motionsForCharacter: () => ['wave'],
        expressionsForCharacter: () => [],
      },
    });

    const result = await runner.runPerformance({
      document,
      segmentation: {
        segmentKeys: ['seg-0'],
        narrativeBoundaries: [{
          key: 'seg-0',
          startGroupIndex: 0,
          endGroupIndexExclusive: 1,
        }],
      },
    });

    expect(enhancePerformance).toHaveBeenCalledTimes(1);
    expect(correctEnhancementPatch).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('succeeded');
    expect(result.units[0]?.attemptCount).toBe(2);
    const alice = result.candidate.statements.find((statement) => statement.id === 'd0');
    expect(alice?.type).toBe('dialogue');
    if (alice?.type === 'dialogue') {
      expect(alice.companions?.[0]?.params).toMatchObject({ motion: { kind: 'resource', key: 'wave' } });
    }
  });

  it('records performance_capabilities_unavailable warning when a character has no configured model', async () => {
    const document = makeDocument();
    const enhancePerformance = vi.fn(async () => ({
      status: 'succeeded' as const,
      value: { version: SEMANTIC_SCENE_PATCH_VERSION, operations: [] },
      correctionUsed: false,
    }));

    const runner = new EnhancementProcessorRunner({
      llm: { enhancePerformance, enhanceCinematic: vi.fn() } as unknown as AiProseLlmService,
      modelCapabilities: {
        hasModelConfigured: () => false,
        motionsForCharacter: () => [],
        expressionsForCharacter: () => [],
      },
    });

    const result = await runner.runPerformance({
      document,
      segmentation: {
        segmentKeys: ['seg-0'],
        narrativeBoundaries: [{
          key: 'seg-0',
          startGroupIndex: 0,
          endGroupIndexExclusive: 2,
        }],
      },
    });

    // Field-level degrade must NOT fail the unit or the stage.
    expect(result.status).toBe('no_changes');
    expect(result.units[0]?.status).toBe('succeeded');
    // Warning reaches the unit checkpoint and the stage run diagnostics.
    expect(result.units[0]?.diagnostics?.some(
      (diagnostic) => diagnostic.code === 'performance_capabilities_unavailable',
    )).toBe(true);
    expect(result.diagnostics.some(
      (diagnostic) => diagnostic.code === 'performance_capabilities_unavailable'
        && diagnostic.message.includes('c1'),
    )).toBe(true);
  });

  it('does not emit performance_capabilities_unavailable when a model is configured but capabilities are missing', async () => {
    const document = makeDocument();
    const enhancePerformance = vi.fn(async () => ({
      status: 'succeeded' as const,
      value: { version: SEMANTIC_SCENE_PATCH_VERSION, operations: [] },
      correctionUsed: false,
    }));

    const runner = new EnhancementProcessorRunner({
      llm: { enhancePerformance, enhanceCinematic: vi.fn() } as unknown as AiProseLlmService,
      modelCapabilities: {
        hasModelConfigured: () => true,
        motionsForCharacter: () => [],
        expressionsForCharacter: () => [],
        capabilitiesReadyForCharacter: () => false,
        capabilityErrorForCharacter: () => 'model file unreadable',
      },
    });

    const result = await runner.runPerformance({
      document,
      segmentation: {
        segmentKeys: ['seg-0'],
        narrativeBoundaries: [{
          key: 'seg-0',
          startGroupIndex: 0,
          endGroupIndexExclusive: 2,
        }],
      },
    });

    // No model is NOT the problem here — a configured-but-unreadable model is a
    // strict resource error handled by the resource gate, not a degrade warning.
    expect(result.diagnostics.some(
      (diagnostic) => diagnostic.code === 'performance_capabilities_unavailable',
    )).toBe(false);
    expect(result.units[0]?.diagnostics?.some(
      (diagnostic) => diagnostic.code === 'performance_capabilities_unavailable',
    ) ?? false).toBe(false);
  });

  it('includes binding-plan preallocated characters in the performance catalog with model motions', async () => {
    const document = makeDocument();
    const plan = buildCharacterBindingPlan({
      document,
      confirmedMainCharacters: ['Alice', 'Bob'],
      requestedBindings: {},
    });
    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') return;
    const bobId = plan.bindings.Bob!.speakerId;

    const projected = projectDraftSemanticScene({
      baseDocument: document,
      plan,
      confirmedMainCharacters: ['Alice', 'Bob'],
      previewStatements: [
        {
          speaker: 'Bob',
          text: 'Bob 的台词。',
          time: 4,
          durationSeconds: 1,
        },
      ],
    });

    let capturedCatalog: PerformanceCapabilityCatalogV1 | undefined;
    const enhancePerformance = vi.fn(async (input: { catalog: PerformanceCapabilityCatalogV1 }) => {
      capturedCatalog = input.catalog;
      return {
        status: 'succeeded' as const,
        value: { version: SEMANTIC_SCENE_PATCH_VERSION, operations: [] },
        correctionUsed: false,
      };
    });
    const runner = new EnhancementProcessorRunner({
      llm: { enhancePerformance, enhanceCinematic: vi.fn() } as unknown as AiProseLlmService,
      modelCapabilities: {
        hasModelConfigured: (characterId) => characterId === 'c1' || characterId === bobId,
        motionsForCharacter: (characterId) => (characterId === bobId ? ['bob/wave01'] : ['idle']),
        expressionsForCharacter: () => [],
      },
    });

    const groups = buildFormalStatementGroups(projected);
    const result = await runner.runPerformance({
      document: projected,
      segmentation: {
        segmentKeys: ['seg-0'],
        narrativeBoundaries: [{
          key: 'seg-0',
          startGroupIndex: 0,
          endGroupIndexExclusive: groups.length,
        }],
      },
    });

    expect(result.status).toBe('no_changes');
    expect(enhancePerformance).toHaveBeenCalledTimes(1);
    expect(capturedCatalog).toBeTruthy();
    const bob = capturedCatalog?.characters.find((character) => character.characterId === bobId);
    expect(bob).toMatchObject({ name: 'Bob' });
    expect(bob?.motions).toEqual(['bob/wave01']);
    expect(bob?.fieldLevelDegrade).toBe(false);
    expect(capturedCatalog?.lookAtTargets).toContain(bobId);
    expect(capturedCatalog?.reactionTargets).toContain(bobId);
  });

  it('pauses a performance unit on ambiguous profile identity before any model call', async () => {
    const document = makeDocument();
    const provider = new StaticPerformanceProfileProvider({
      sources: [
        {
          profile: parsePerformanceProfileDocument({
            schemaVersion: 1,
            id: 'a.performance',
            name: 'A',
            characters: [{
              id: 'alice-a',
              aliases: ['Alice'],
              motions: [{ key: 'a/x' }],
            }],
          }),
          priority: 10,
        },
        {
          profile: parsePerformanceProfileDocument({
            schemaVersion: 1,
            id: 'b.performance',
            name: 'B',
            characters: [{
              id: 'alice-b',
              aliases: ['Alice'],
              motions: [{ key: 'b/x' }],
            }],
          }),
          priority: 10,
        },
      ],
    });
    const enhancePerformance = vi.fn();
    const runner = new EnhancementProcessorRunner({
      llm: { enhancePerformance, enhanceCinematic: vi.fn() } as unknown as AiProseLlmService,
      modelCapabilities: {
        hasModelConfigured: () => true,
        motionsForCharacter: () => ['a/x'],
        expressionsForCharacter: () => [],
      },
      profileProvider: provider,
    });

    const result = await runner.runPerformance({
      document,
      segmentation: {
        segmentKeys: ['seg-0'],
        narrativeBoundaries: [{
          key: 'seg-0',
          startGroupIndex: 0,
          endGroupIndexExclusive: 2,
        }],
      },
    });

    expect(enhancePerformance).not.toHaveBeenCalled();
    expect(result.units[0]?.status).toBe('retryableFailed');
    expect(result.units[0]?.diagnostics?.some(
      (diagnostic) => diagnostic.code === 'ambiguous_identity',
    )).toBe(true);
    expect(result.diagnostics.some(
      (diagnostic) => diagnostic.code === 'ambiguous_identity',
    )).toBe(true);
  });

  it('fails a performance unit before the model call when a configured model is not ready', async () => {
    const document = makeDocument();
    const enhancePerformance = vi.fn();
    const runner = new EnhancementProcessorRunner({
      llm: { enhancePerformance, enhanceCinematic: vi.fn() } as unknown as AiProseLlmService,
      modelCapabilities: {
        hasModelConfigured: () => true,
        motionsForCharacter: () => [],
        expressionsForCharacter: () => [],
        capabilitiesReadyForCharacter: () => false,
        capabilityErrorForCharacter: () => 'model file unreadable',
      },
    });

    const result = await runner.runPerformance({
      document,
      segmentation: {
        segmentKeys: ['seg-0'],
        narrativeBoundaries: [{
          key: 'seg-0',
          startGroupIndex: 0,
          endGroupIndexExclusive: 2,
        }],
      },
    });

    expect(enhancePerformance).not.toHaveBeenCalled();
    expect(result.units[0]?.status).toBe('retryableFailed');
    expect(result.units[0]?.diagnostics?.some(
      (diagnostic) => diagnostic.code === 'performance_resource_unavailable',
    )).toBe(true);
    expect(result.units[0]?.diagnostics?.some(
      (diagnostic) => diagnostic.message.includes('model file unreadable'),
    )).toBe(true);
    expect(result.status).toBe('retryableFailed');
  });

  it('keeps running a performance unit when ports lack capability readiness methods', async () => {
    const document = makeDocument();
    const enhancePerformance = vi.fn(async () => ({
      status: 'succeeded' as const,
      value: { version: SEMANTIC_SCENE_PATCH_VERSION, operations: [] },
      correctionUsed: false,
    }));
    const runner = new EnhancementProcessorRunner({
      llm: { enhancePerformance, enhanceCinematic: vi.fn() } as unknown as AiProseLlmService,
      modelCapabilities: {
        hasModelConfigured: () => true,
        motionsForCharacter: () => ['wave'],
        expressionsForCharacter: () => [],
      },
    });

    const result = await runner.runPerformance({
      document,
      segmentation: {
        segmentKeys: ['seg-0'],
        narrativeBoundaries: [{
          key: 'seg-0',
          startGroupIndex: 0,
          endGroupIndexExclusive: 2,
        }],
      },
    });

    expect(enhancePerformance).toHaveBeenCalledTimes(1);
    expect(result.units[0]?.status).toBe('succeeded');
  });

  it('fails a performance unit when the model returns a motion outside the catalog', async () => {
    const document = makeDocument();
    const enhancePerformance = vi.fn(async () => ({
      status: 'succeeded' as const,
      value: {
        version: SEMANTIC_SCENE_PATCH_VERSION,
        operations: [{
          kind: 'updateCompanion' as const,
          line: 2,
          patch: { params: { motion: 'not/in-catalog' } },
        }],
      },
      correctionUsed: false,
    }));
    const correctEnhancementPatch = vi.fn(async () => ({
      status: 'failed' as const,
      error: { code: 'correction-failed', message: 'correction refused' },
      correctionUsed: false,
    }));

    const runner = new EnhancementProcessorRunner({
      llm: {
        enhancePerformance,
        enhanceCinematic: vi.fn(),
        correctEnhancementPatch,
      } as unknown as AiProseLlmService,
      modelCapabilities: {
        hasModelConfigured: () => true,
        motionsForCharacter: () => ['wave'],
        expressionsForCharacter: () => [],
        capabilitiesReadyForCharacter: () => true,
      },
    });

    const result = await runner.runPerformance({
      document,
      segmentation: {
        segmentKeys: ['seg-0'],
        narrativeBoundaries: [{
          key: 'seg-0',
          startGroupIndex: 0,
          endGroupIndexExclusive: 1,
        }],
      },
    });

    expect(result.units[0]?.status).toBe('retryableFailed');
    expect(result.units[0]?.diagnostics?.some(
      (diagnostic) => diagnostic.code === 'motion_unavailable',
    )).toBe(true);
    expect(correctEnhancementPatch).toHaveBeenCalledTimes(1);
    // The invalid patch is not persisted as a success.
    expect(result.status).toBe('retryableFailed');
    expect(result.patch.operations).toHaveLength(0);
    const alice = result.candidate.statements.find((statement) => statement.id === 'd0');
    expect(alice?.type).toBe('dialogue');
    if (alice?.type === 'dialogue') {
      expect(alice.companions?.[0]?.params).not.toMatchObject({ motion: { kind: 'resource', key: 'not/in-catalog' } });
    }
  });

  it('accepts in-catalog motions unchanged through the resource gate', async () => {
    const document = makeDocument();
    const enhancePerformance = vi.fn(async () => ({
      status: 'succeeded' as const,
      value: {
        version: SEMANTIC_SCENE_PATCH_VERSION,
        operations: [{
          kind: 'updateCompanion' as const,
          line: 2,
          patch: { params: { motion: 'wave' } },
        }],
      },
      correctionUsed: false,
    }));

    const runner = new EnhancementProcessorRunner({
      llm: { enhancePerformance, enhanceCinematic: vi.fn() } as unknown as AiProseLlmService,
      modelCapabilities: {
        hasModelConfigured: () => true,
        motionsForCharacter: () => ['wave'],
        expressionsForCharacter: () => [],
        capabilitiesReadyForCharacter: () => true,
      },
    });

    const result = await runner.runPerformance({
      document,
      segmentation: {
        segmentKeys: ['seg-0'],
        narrativeBoundaries: [{
          key: 'seg-0',
          startGroupIndex: 0,
          endGroupIndexExclusive: 1,
        }],
      },
    });

    expect(result.status).toBe('succeeded');
    expect(result.units[0]?.status).toBe('succeeded');
    const alice = result.candidate.statements.find((statement) => statement.id === 'd0');
    expect(alice?.type).toBe('dialogue');
    if (alice?.type === 'dialogue') {
      expect(alice.companions?.[0]?.params).toMatchObject({ motion: { kind: 'resource', key: 'wave' } });
    }
  });

  it('only exposes profile data intersected with model keys in the performance catalog', async () => {
    const document = makeDocument();
    const provider = new StaticPerformanceProfileProvider({
      sources: [{
        profile: parsePerformanceProfileDocument({
          schemaVersion: 1,
          id: 'demo.performance',
          name: 'Demo',
          characters: [{
            id: 'c1',
            aliases: ['Alice'],
            motions: [
              { key: 'alice/wave01', description: '挥手' },
              { key: 'alice/dance01', description: '跳舞' },
            ],
          }],
        }),
        priority: 1,
      }],
    });
    let capturedCatalog: PerformanceCapabilityCatalogV1 | undefined;
    const enhancePerformance = vi.fn(async (input: { catalog: PerformanceCapabilityCatalogV1 }) => {
      capturedCatalog = input.catalog;
      return {
        status: 'succeeded' as const,
        value: { version: SEMANTIC_SCENE_PATCH_VERSION, operations: [] },
        correctionUsed: false,
      };
    });
    const runner = new EnhancementProcessorRunner({
      llm: { enhancePerformance, enhanceCinematic: vi.fn() } as unknown as AiProseLlmService,
      modelCapabilities: {
        hasModelConfigured: () => true,
        motionsForCharacter: () => ['alice/wave01', 'unlisted/extra'],
        expressionsForCharacter: () => [],
      },
      profileProvider: provider,
    });

    const result = await runner.runPerformance({
      document,
      segmentation: {
        segmentKeys: ['seg-0'],
        narrativeBoundaries: [{
          key: 'seg-0',
          startGroupIndex: 0,
          endGroupIndexExclusive: 2,
        }],
      },
    });

    expect(result.status).toBe('no_changes');
    const character = capturedCatalog?.characters[0];
    expect(character?.characterId).toBe('c1');
    // Model keys stay whole; only profile descriptions for matching keys enter.
    expect(character?.motions).toEqual(['alice/wave01', 'unlisted/extra']);
    expect(character?.profile?.motions.map((motion) => motion.key)).toEqual(['alice/wave01']);
    const serialized = JSON.stringify(capturedCatalog);
    expect(serialized).toContain('挥手');
    expect(serialized).not.toContain('跳舞');
  });

  it('gives no profile data to field-level-degrade characters in the catalog', async () => {
    const document = makeDocument();
    const provider = new StaticPerformanceProfileProvider({
      sources: [{
        profile: parsePerformanceProfileDocument({
          schemaVersion: 1,
          id: 'demo.performance',
          name: 'Demo',
          characters: [{
            id: 'c1',
            aliases: ['Alice'],
            motions: [{ key: 'alice/wave01', description: '挥手' }],
          }],
        }),
        priority: 1,
      }],
    });
    let capturedCatalog: PerformanceCapabilityCatalogV1 | undefined;
    const enhancePerformance = vi.fn(async (input: { catalog: PerformanceCapabilityCatalogV1 }) => {
      capturedCatalog = input.catalog;
      return {
        status: 'succeeded' as const,
        value: { version: SEMANTIC_SCENE_PATCH_VERSION, operations: [] },
        correctionUsed: false,
      };
    });
    const runner = new EnhancementProcessorRunner({
      llm: { enhancePerformance, enhanceCinematic: vi.fn() } as unknown as AiProseLlmService,
      modelCapabilities: {
        hasModelConfigured: () => false,
        motionsForCharacter: () => [],
        expressionsForCharacter: () => [],
      },
      profileProvider: provider,
    });

    await runner.runPerformance({
      document,
      segmentation: {
        segmentKeys: ['seg-0'],
        narrativeBoundaries: [{
          key: 'seg-0',
          startGroupIndex: 0,
          endGroupIndexExclusive: 2,
        }],
      },
    });

    const character = capturedCatalog?.characters[0];
    expect(character?.fieldLevelDegrade).toBe(true);
    expect(character?.motions).toEqual([]);
    expect(character?.profile).toBeUndefined();
    expect(character?.intersectedProfile).toBeUndefined();
  });

  it('reports every completed unit exactly once through onUnitComplete in concurrent performance runs', async () => {
    const document = makeDocument();
    const onUnitComplete = vi.fn();
    const onStageStarted = vi.fn();
    const enhancePerformance = vi.fn(async () => ({
      status: 'succeeded' as const,
      value: { version: SEMANTIC_SCENE_PATCH_VERSION, operations: [] },
      correctionUsed: false,
    }));

    const runner = new EnhancementProcessorRunner({
      llm: { enhancePerformance, enhanceCinematic: vi.fn() } as unknown as AiProseLlmService,
      modelCapabilities: {
        hasModelConfigured: () => true,
        motionsForCharacter: () => [],
        expressionsForCharacter: () => [],
      },
      onUnitComplete,
      onStageStarted,
    });

    await runner.runPerformance({
      document,
      segmentation: {
        segmentKeys: ['seg-0', 'seg-1'],
        narrativeBoundaries: [
          { key: 'seg-0', startGroupIndex: 0, endGroupIndexExclusive: 1 },
          { key: 'seg-1', startGroupIndex: 1, endGroupIndexExclusive: 2 },
        ],
      },
      concurrency: 2,
    });

    expect(onStageStarted).toHaveBeenCalledTimes(1);
    expect(onStageStarted).toHaveBeenCalledWith('performance');
    expect(onUnitComplete).toHaveBeenCalledTimes(2);
    const unitIndexes = onUnitComplete.mock.calls.map((call) => call[1]).sort();
    expect(unitIndexes).toEqual([0, 1]);
    const totalUnits = onUnitComplete.mock.calls.map((call) => call[2]);
    expect(totalUnits).toEqual([2, 2]);
    const keys = onUnitComplete.mock.calls.map((call) => call[0].key).sort();
    expect(keys).toEqual(['seg-0', 'seg-1']);
    const statuses = onUnitComplete.mock.calls.map((call) => call[0].status);
    expect(statuses).toEqual(['succeeded', 'succeeded']);
  });

  it('reports every completed unit exactly once through onUnitComplete in serial cinematic runs', async () => {
    const document = makeDocument();
    const onUnitComplete = vi.fn();
    const onStageStarted = vi.fn();
    const enhanceCinematic = vi.fn(async () => ({
      status: 'succeeded' as const,
      value: { version: SEMANTIC_SCENE_PATCH_VERSION, operations: [] },
      correctionUsed: false,
    }));

    const runner = new EnhancementProcessorRunner({
      llm: { enhancePerformance: vi.fn(), enhanceCinematic } as unknown as AiProseLlmService,
      modelCapabilities: {
        hasModelConfigured: () => true,
        motionsForCharacter: () => [],
        expressionsForCharacter: () => [],
      },
      onUnitComplete,
      onStageStarted,
    });

    await runner.runCinematic({
      document,
      segmentation: {
        segmentKeys: ['seg-0', 'seg-1'],
        narrativeBoundaries: [
          { key: 'seg-0', startGroupIndex: 0, endGroupIndexExclusive: 1 },
          { key: 'seg-1', startGroupIndex: 1, endGroupIndexExclusive: 2 },
        ],
      },
    });

    expect(onStageStarted).toHaveBeenCalledTimes(1);
    expect(onStageStarted).toHaveBeenCalledWith('cinematic');
    expect(onUnitComplete).toHaveBeenCalledTimes(2);
    const unitIndexes = onUnitComplete.mock.calls.map((call) => call[1]);
    expect(unitIndexes).toEqual([0, 1]);
    const totalUnits = onUnitComplete.mock.calls.map((call) => call[2]);
    expect(totalUnits).toEqual([2, 2]);
    const keys = onUnitComplete.mock.calls.map((call) => call[0].key).sort();
    expect(keys).toEqual(['seg-0', 'seg-1']);
  });

  it('scopes the model line view to the unit core plus bounded read-only context', async () => {
    const lineText = '她站在窗边，望着远处的霓虹灯闪烁不定，心里反复回想刚才那段对话。'.repeat(12);
    const dialogueCount = 40;
    const longDocument = materializePerformancePlaceholders({
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'scene-long',
      meta: {
        title: 'Long',
        characters: [{ id: 'c1', name: '林夏' }],
      },
      statements: Array.from({ length: dialogueCount }, (_, i) => ({
        id: `d${i}`,
        time: i * 2,
        type: 'dialogue' as const,
        params: {
          speakerId: 'c1',
          speaker: '林夏',
          text: lineText,
          durationSeconds: 1,
        },
      })),
    });

    const inputs: Array<{
      unitKey: string;
      lineView: { lines: Array<{ line: number; access: string; parentLine?: number }> };
    }> = [];
    const enhancePerformance = vi.fn(async (input: { unitKey: string; lineView: unknown }) => {
      inputs.push(input as never);
      return {
        status: 'succeeded' as const,
        value: { version: SEMANTIC_SCENE_PATCH_VERSION, operations: [] },
        correctionUsed: false,
      };
    });

    const runner = new EnhancementProcessorRunner({
      llm: { enhancePerformance, enhanceCinematic: vi.fn() } as unknown as AiProseLlmService,
      modelCapabilities: {
        hasModelConfigured: () => true,
        motionsForCharacter: () => ['idle'],
        expressionsForCharacter: () => [],
      },
      maxVisibleCharsPerUnit: 6000,
    });

    const result = await runner.runPerformance({
      document: longDocument,
      segmentation: {
        segmentKeys: ['seg-0'],
        narrativeBoundaries: [{
          key: 'seg-0',
          startGroupIndex: 0,
          endGroupIndexExclusive: dialogueCount,
        }],
      },
    });

    expect(result.status).toBe('no_changes');
    expect(enhancePerformance.mock.calls.length).toBeGreaterThan(1);
    const fullLineCount = dialogueCount * 2;
    for (const input of inputs) {
      const lines = input.lineView.lines;
      expect(lines.length).toBeLessThan(fullLineCount);
      expect(lines.some((line) => line.access === 'writable')).toBe(true);
      expect(lines.some((line) => line.access === 'read-only')).toBe(true);
      expect(lines.every((line) => !('label' in line) && !('iconKey' in line))).toBe(true);
      // Read-only context respects the configured budget on the emitted payload.
      const contextChars = lines
        .filter((line) => line.access === 'read-only')
        .reduce((sum, line) => sum + JSON.stringify(line).length, 0);
      expect(contextChars).toBeLessThanOrEqual(6000);
      // The projection never emits a companion without its parent root.
      const parentLines = new Set(lines.map((line) => line.line));
      for (const line of lines) {
        if ('parentLine' in line && line.parentLine !== undefined) {
          expect(parentLines.has(line.parentLine)).toBe(true);
        }
      }
    }
    // The first unit never sees the scene tail (bounded context, not full scene).
    const firstUnit = inputs.find((input) => input.unitKey.includes('seg-0#t0'));
    expect(firstUnit).toBeDefined();
    expect(firstUnit!.lineView.lines.every((line) => line.line < fullLineCount * 0.9)).toBe(true);
  });
});
