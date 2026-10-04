import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import type { SemanticScenePatchV1 } from '../../api/types/semantic-scene-patch';
import type { AiProseLlmCompletionOptions } from './AiProseContracts';
import type { AiProseLlmService } from './AiProseLlmService';
import {
  buildFormalStatementGroups,
} from './FormalSceneEnhancementHost';
import { materializePerformancePlaceholders } from './CharacterBindingPlan';
import {
  EnhancementProcessorRunner,
  type EnhancementProcessorRunnerOptions,
  type EnhancementUnitCheckpointV1,
  type ModelCapabilityPort,
} from './EnhancementProcessorRunner';
import {
  applyEnhancementStagePlan,
  combineStageUnitPatches,
  flattenEnhancementStagePlan,
} from './FormalEnhancementApply';
import {
  withSceneEnhancementPhase,
  withSceneEnhancementPreviewPatch,
  withSceneEnhancementStageResult,
  type ResolvedEnhancementSegmentationV1,
  type SceneEnhancementSnapshotV1,
  type SceneEnhancementUnitCheckpointSummaryV1,
  type SceneEnhancementVersionBindingV1,
} from './SceneEnhancementSnapshot';
import type { PerformanceProfileProvider } from './performance';
import {
  createAiProseSegmentationPlan,
  validateAiProseBoundarySelection,
} from './AiProseSegmentation';
import { visibleCharacterCount } from './AiProseTextMetrics';
import type { AiProseRequestBudget } from './AiProseRequestBudget';
import type { CinematicCapabilityPort } from './CinematicCapabilityCatalog';

export interface FormalEnhancementOrchestratorOptions {
  readonly llm: AiProseLlmService;
  readonly profileProvider?: PerformanceProfileProvider | null;
  readonly modelCapabilities?: ModelCapabilityPort;
  readonly cinematicCapabilities?: CinematicCapabilityPort;
  readonly maxVisibleCharsPerUnit?: number;
  readonly requestBudget?: AiProseRequestBudget;
  readonly runnerFactory?: (options: EnhancementProcessorRunnerOptions) => EnhancementProcessorRunner;
}

export class FormalEnhancementOrchestrator {
  private readonly llm: AiProseLlmService;
  private readonly runner: EnhancementProcessorRunner;

  constructor(options: FormalEnhancementOrchestratorOptions) {
    this.llm = options.llm;
    this.runner = (options.runnerFactory ?? ((opts) => new EnhancementProcessorRunner(opts)))({
      llm: options.llm,
      profileProvider: options.profileProvider,
      modelCapabilities: options.modelCapabilities,
      cinematicCapabilities: options.cinematicCapabilities,
      maxVisibleCharsPerUnit: options.maxVisibleCharsPerUnit,
      requestBudget: options.requestBudget,
    });
  }

  /**
   * Auto multi-segment via shared semantic segmentation LLM over formal story projection.
   * targetSegmentCount === 1 or no speaker/text → single segment without model.
   */
  async resolveAutoSegmentation(input: {
    readonly document: CurrentSceneDocument;
    readonly targetBatchSize: number;
    readonly llmOptions?: AiProseLlmCompletionOptions;
  }): Promise<
    | { ok: true; segmentation: Omit<ResolvedEnhancementSegmentationV1, 'binding'> }
    | { ok: false; message: string }
  > {
    const groups = buildFormalStatementGroups(input.document);
    if (groups.length === 0) {
      return {
        ok: true,
        segmentation: {
          segmentKeys: [],
          narrativeBoundaries: [],
          source: 'empty_scene',
        },
      };
    }

    const speakerTextVisibleChars = groups.reduce(
      (sum, group) => sum + (group.hasSpeakerText ? group.visibleChars : 0),
      0,
    );
    const candidateBoundaryCount = Math.max(0, groups.length - 1);
    const requestedTarget = Math.max(
      1,
      Math.round(speakerTextVisibleChars / Math.max(1, input.targetBatchSize)),
    );
    const effectiveTarget = Math.min(requestedTarget, candidateBoundaryCount + 1);

    if (effectiveTarget <= 1 || speakerTextVisibleChars === 0) {
      return {
        ok: true,
        segmentation: {
          segmentKeys: ['seg-0'],
          narrativeBoundaries: [{
            key: 'seg-0',
            startGroupIndex: 0,
            endGroupIndexExclusive: groups.length,
          }],
          source: 'single_segment',
        },
      };
    }

    // One physical line per statement group with real speaker/text so the model
    // can cut on narrative meaning. Only line-end candidates are kept so groups
    // stay atomic (no mid-group sentence cuts).
    const sourceText = projectFormalGroupsAsSegmentationSource(input.document, groups);
    const adjustedBatch = Math.max(
      1,
      Math.round(visibleCharacterCount(sourceText) / effectiveTarget),
    );
    const adjustedPlan = createAiProseSegmentationPlan(sourceText, adjustedBatch);
    const forcedPlan = {
      ...adjustedPlan,
      targetSegmentCount: effectiveTarget,
      candidates: adjustedPlan.candidates.filter((candidate) => candidate.kind === 'line'),
    };

    const result = await this.llm.segment(forcedPlan, input.llmOptions);
    if (result.status === 'failed') {
      return {
        ok: false,
        message: result.error.message,
      };
    }

    try {
      const validated = validateAiProseBoundarySelection(forcedPlan, {
        boundaryIds: result.value.boundaryIds,
      });
      const cuts = [
        0,
        ...validated.boundaryIds.map((id) => {
          const candidate = forcedPlan.candidates.find((item) => item.id === id);
          if (!candidate) throw new Error(`Unknown boundary ${id}`);
          // lineNumber is 1-based line index in synthetic source = group index + 1 after that line
          return candidate.lineNumber; // boundary after line N → group index N
        }),
        groups.length,
      ];
      // lineNumber after line k means cut before group k (0-based group index = lineNumber)
      const uniqueCuts = [...new Set(cuts)].sort((a, b) => a - b);
      if (uniqueCuts[0] !== 0) uniqueCuts.unshift(0);
      if (uniqueCuts[uniqueCuts.length - 1] !== groups.length) uniqueCuts.push(groups.length);

      const narrativeBoundaries = [];
      const segmentKeys = [];
      for (let i = 0; i < uniqueCuts.length - 1; i += 1) {
        const startGroupIndex = uniqueCuts[i]!;
        const endGroupIndexExclusive = uniqueCuts[i + 1]!;
        if (startGroupIndex >= endGroupIndexExclusive) {
          return { ok: false, message: '语义分段产生了空段。' };
        }
        if (endGroupIndexExclusive > groups.length) {
          return { ok: false, message: '语义分段越界。' };
        }
        const key = `seg-${i}`;
        segmentKeys.push(key);
        narrativeBoundaries.push({ key, startGroupIndex, endGroupIndexExclusive });
      }

      return {
        ok: true,
        segmentation: {
          segmentKeys,
          narrativeBoundaries,
          source: 'semantic_segmentation',
        },
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async runPerformance(input: {
    readonly snapshot: SceneEnhancementSnapshotV1;
    readonly document: CurrentSceneDocument;
    readonly binding: SceneEnhancementVersionBindingV1;
    readonly llmOptions?: AiProseLlmCompletionOptions;
    readonly ensurePlaceholders?: boolean;
    /** Restrict placeholder materialization to these statements (draft-created-only baseline). */
    readonly placeholderTargetStatementIds?: ReadonlySet<string>;
  }): Promise<SceneEnhancementSnapshotV1> {
    if (!input.snapshot.segmentation) {
      throw new Error('Performance stage requires locked segmentation');
    }

    let working = input.document;
    if (input.ensurePlaceholders !== false) {
      working = input.placeholderTargetStatementIds
        ? materializePerformancePlaceholders(working, {
          targetStatementIds: input.placeholderTargetStatementIds,
        })
        : materializePerformancePlaceholders(working);
    }

    let snapshot = withSceneEnhancementPhase(input.snapshot, 'performance');
    // A performance re-run invalidates any earlier cinematic result: that patch
    // was authored against the previous performance candidate and could hit
    // wrong statements once the new candidate lands. The apply path and the UI
    // must never combine a fresh performance result with a stale cinematic one.
    snapshot = { ...snapshot, cinematic: undefined };
    snapshot = withSceneEnhancementStageResult(snapshot, {
      stage: 'performance',
      status: 'running',
    });

    const result = await this.runner.runPerformance({
      document: working,
      segmentation: input.snapshot.segmentation,
      llmOptions: input.llmOptions,
    });

    snapshot = withSceneEnhancementStageResult(snapshot, {
      stage: 'performance',
      status: result.status === 'succeeded' || result.status === 'no_changes'
        ? 'succeeded'
        : result.status === 'retryableFailed'
          ? 'retryableFailed'
          : 'failed',
      patch: result.patch,
      unitPatches: result.unitPatches,
      diagnostics: result.diagnostics,
      policyVersion: result.policyVersion,
      processorVersion: result.processorVersion,
      units: summarizeUnitCheckpoints(result.units),
    });

    if (result.status === 'succeeded' || result.status === 'no_changes') {
      // Preview can be performance-only until cinematic runs.
      snapshot = withSceneEnhancementPreviewPatch(snapshot, result.patch);
      snapshot = withSceneEnhancementPhase(snapshot, 'preview_ready');
    } else {
      // No valid preview: the performance re-run failed and the cinematic
      // result it replaced was invalidated above.
      snapshot = withSceneEnhancementPhase({ ...snapshot, previewPatch: undefined }, 'failed');
    }

    return snapshot;
  }

  async runCinematic(input: {
    readonly snapshot: SceneEnhancementSnapshotV1;
    readonly document: CurrentSceneDocument;
    /** Document already including performance candidate when performance succeeded. */
    readonly performanceCandidate?: CurrentSceneDocument;
    readonly llmOptions?: AiProseLlmCompletionOptions;
    /** Restrict placeholder materialization to these statements (draft-created-only baseline). */
    readonly placeholderTargetStatementIds?: ReadonlySet<string>;
  }): Promise<SceneEnhancementSnapshotV1> {
    if (!input.snapshot.segmentation) {
      throw new Error('Cinematic stage requires locked segmentation');
    }

    if (input.snapshot.performance && input.snapshot.performance.status !== 'succeeded') {
      return withSceneEnhancementStageResult(
        {
          ...withSceneEnhancementPhase(input.snapshot, 'failed'),
          previewPatch: undefined,
        },
        {
          stage: 'cinematic',
          status: 'failed',
          diagnostics: [{
            code: 'performance_stage_incomplete',
            message: '表演阶段未成功完成，不能继续电影感增强或应用部分结果。',
          }],
        },
      );
    }

    let baseDocument = input.performanceCandidate ?? input.document;
    if (input.snapshot.performance?.status === 'succeeded' && input.snapshot.performance.patch) {
      if (!input.performanceCandidate) {
        try {
          const working = input.placeholderTargetStatementIds
            ? materializePerformancePlaceholders(input.document, {
              targetStatementIds: input.placeholderTargetStatementIds,
            })
            : materializePerformancePlaceholders(input.document);
          // The working baseline is already materialized above; never re-run
          // whole-document materialization inside the stage replay (it would
          // backfill pre-existing dialogues and shift every line).
          baseDocument = applyEnhancementStagePlan(working, combineStageUnitPatches(
            stagePatches(input.snapshot.performance),
            undefined,
          ), input.placeholderTargetStatementIds
            ? { materializePlaceholders: false }
            : undefined).candidate;
        } catch (error) {
          return withSceneEnhancementStageResult(
            withSceneEnhancementPhase(input.snapshot, 'failed'),
            {
              stage: 'cinematic',
              status: 'failed',
              diagnostics: [{
                code: 'performance_replay_failed',
                message: error instanceof Error ? error.message : String(error),
              }],
            },
          );
        }
      }
    } else {
      baseDocument = input.placeholderTargetStatementIds
        ? materializePerformancePlaceholders(baseDocument, {
          targetStatementIds: input.placeholderTargetStatementIds,
        })
        : materializePerformancePlaceholders(baseDocument);
    }

    let snapshot = withSceneEnhancementPhase(input.snapshot, 'cinematic');
    snapshot = withSceneEnhancementStageResult(snapshot, {
      stage: 'cinematic',
      status: 'running',
    });

    const result = await this.runner.runCinematic({
      document: baseDocument,
      segmentation: input.snapshot.segmentation,
      llmOptions: input.llmOptions,
    });

    snapshot = withSceneEnhancementStageResult(snapshot, {
      stage: 'cinematic',
      status: result.status === 'succeeded' || result.status === 'no_changes'
        ? 'succeeded'
        : result.status === 'retryableFailed'
          ? 'retryableFailed'
          : 'failed',
      patch: result.patch,
      unitPatches: result.unitPatches,
      diagnostics: result.diagnostics,
      policyVersion: result.policyVersion,
      processorVersion: result.processorVersion,
      units: summarizeUnitCheckpoints(result.units),
    });

    if (result.status === 'succeeded' || result.status === 'no_changes') {
      const plan = combineStageUnitPatches(
        stagePatches(input.snapshot.performance),
        result.unitPatches,
      );
      // Flat preview is display-only; apply resolves via stage patches on the snapshot.
      snapshot = withSceneEnhancementPreviewPatch(snapshot, flattenEnhancementStagePlan(plan));
      snapshot = withSceneEnhancementPhase(snapshot, 'preview_ready');
    } else if (input.snapshot.performance?.status === 'succeeded' && input.snapshot.performance.patch) {
      // Keep performance preview if available; allow performance-only apply.
      snapshot = withSceneEnhancementPreviewPatch(
        withSceneEnhancementPhase(snapshot, 'preview_ready'),
        input.snapshot.performance.patch,
      );
      snapshot = withSceneEnhancementStageResult(snapshot, {
        stage: 'cinematic',
        status: result.status === 'retryableFailed' ? 'retryableFailed' : 'failed',
        patch: result.patch,
        unitPatches: result.unitPatches,
        diagnostics: result.diagnostics,
        policyVersion: result.policyVersion,
        processorVersion: result.processorVersion,
        units: summarizeUnitCheckpoints(result.units),
      });
    } else {
      snapshot = withSceneEnhancementPhase(snapshot, 'failed');
    }

    return snapshot;
  }
}

function stagePatches(
  stage: { readonly patch?: SemanticScenePatchV1; readonly unitPatches?: readonly SemanticScenePatchV1[] } | undefined,
): readonly SemanticScenePatchV1[] | undefined {
  if (stage?.unitPatches) return stage.unitPatches;
  return stage?.patch ? [stage.patch] : undefined;
}

function summarizeUnitCheckpoints(
  units: readonly EnhancementUnitCheckpointV1[],
): readonly SceneEnhancementUnitCheckpointSummaryV1[] {
  return units.map((unit) => ({
    key: unit.key,
    status: unit.status,
    attemptCount: unit.attemptCount,
    ...(unit.inputFingerprint ? { inputFingerprint: unit.inputFingerprint } : {}),
    ...(unit.diagnostics ? { diagnostics: unit.diagnostics } : {}),
    ...(unit.patch ? { patch: unit.patch } : {}),
    ...(unit.policyVersion ? { policyVersion: unit.policyVersion } : {}),
    ...(unit.processorVersion ? { processorVersion: unit.processorVersion } : {}),
    ...(unit.modelName ? { modelName: unit.modelName } : {}),
    ...(unit.usage ? { usage: unit.usage } : {}),
    ...(unit.lineViewContextChars ? { lineViewContextChars: unit.lineViewContextChars } : {}),
  }));
}

export function emptySemanticPatch(): SemanticScenePatchV1 {
  return { version: 1, operations: [] };
}

/**
 * Project each formal statement group to one source line for semantic segmentation.
 * Dialogue groups include speaker labels and text; non-text groups use a stable marker.
 * Newlines inside dialogue are flattened so one group stays one physical line.
 */
export function projectFormalGroupsAsSegmentationSource(
  document: CurrentSceneDocument,
  groups: ReturnType<typeof buildFormalStatementGroups>,
): string {
  const byTime = new Map<number, CurrentSceneDocument['statements']>();
  for (const statement of document.statements) {
    const bucket = byTime.get(statement.time) ?? [];
    bucket.push(statement);
    byTime.set(statement.time, bucket);
  }

  return groups.map((group) => {
    const roots = byTime.get(group.time) ?? [];
    const parts: string[] = [];
    for (const statement of roots) {
      if (statement.type !== 'dialogue') continue;
      const text = typeof statement.params.text === 'string' ? statement.params.text : '';
      if (!text) continue;
      const speaker = typeof statement.params.speaker === 'string' && statement.params.speaker
        ? statement.params.speaker
        : typeof statement.params.speakerId === 'string'
          ? statement.params.speakerId
          : '';
      const flat = text.replace(/\r\n|\r|\n/g, ' ').trim();
      parts.push(speaker ? `${speaker}: ${flat}` : flat);
    }
    if (parts.length === 0) {
      return group.hasSpeakerText ? '[empty-text]' : '[non-text]';
    }
    return parts.join(' / ');
  }).join('\n');
}
