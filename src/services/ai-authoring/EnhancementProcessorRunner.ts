import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import type {
  SemanticScenePatchV1,
  SemanticScenePatchIssueV1,
  SemanticSceneOperationV1,
} from '../../api/types/semantic-scene-patch';
import { SEMANTIC_SCENE_PATCH_VERSION } from '../../api/types/semantic-scene-patch';
import {
  applySemanticScenePatch,
  type SemanticSceneStagePolicyV1,
} from '../semantic-scene/SemanticScenePatch';
import { SemanticSceneLineView } from '../semantic-scene/SemanticSceneLineView';
import type { AiProseLlmService, AiProseLlmResult } from './AiProseLlmService';
import type { AiProseLlmCompletionOptions, AiProseLlmProgress, AiProseTokenUsage } from './AiProseContracts';
import {
  getEnhancementStagePolicy,
  getEnhancementStagePolicyVersion,
  type EnhancementStageKind,
} from './CinematicEnhancementPolicy';
import {
  buildFormalStatementGroups,
  type FormalStatementGroupV1,
} from './FormalSceneEnhancementHost';
import type { ResolvedEnhancementSegmentationV1 } from './SceneEnhancementSnapshot';
import {
  assertEnhancementStageScope,
  DEFAULT_MAX_VISIBLE_CHARS_PER_UNIT,
  expandSegmentationToProcessingUnits,
  type TechnicalSplitUnitV1,
} from './EnhancementScope';
import {
  projectCinematicLineView,
  projectFormalSceneStoryText,
  projectPerformanceLineView,
} from './SceneLineProjection';
import {
  assertMonotonicPerformanceCompletion,
  collectPerformanceStatementSnapshots,
} from './performance/PerformanceCompletionGate';
import { validatePerformanceResourceCapabilities } from './PerformanceCapabilityGate';
import type { PerformanceProfileProvider } from './performance';
import {
  buildCinematicCapabilityCatalog,
  type CinematicCapabilityPort,
} from './CinematicCapabilityCatalog';
import type { AiProseRequestBudget } from './AiProseRequestBudget';
import {
  buildCinematicEnhancementPrompt,
  buildPerformanceEnhancementPrompt,
} from './EnhancementPrompts';
import {
  buildEnhancementUnitInputFingerprint,
  buildPerformanceCapabilityCatalogForDocument,
  CINEMATIC_PROCESSOR_VERSION,
  DEFAULT_MODEL_CAPABILITIES,
  PERFORMANCE_PROCESSOR_VERSION,
  resolveEnhancementUnitScope,
  scopeUnitLineViewFilter,
} from './EnhancementUnitInput';

export { PERFORMANCE_PROCESSOR_VERSION, CINEMATIC_PROCESSOR_VERSION, fingerprintEnhancementUnitInput } from './EnhancementUnitInput';

export type EnhancementUnitStatusV1 =
  | 'idle'
  | 'running'
  | 'succeeded'
  | 'retryableFailed'
  | 'failed';

export interface EnhancementUnitCheckpointV1 {
  readonly key: string;
  readonly stage: EnhancementStageKind;
  readonly status: EnhancementUnitStatusV1;
  readonly patch?: SemanticScenePatchV1;
  readonly diagnostics?: readonly { readonly code: string; readonly message: string }[];
  readonly attemptCount: number;
  readonly policyVersion: string;
  readonly processorVersion: string;
  readonly inputFingerprint?: string;
  /** Informative generation model name captured from provider progress. */
  readonly modelName?: string;
  /** Informative token usage captured from provider progress. */
  readonly usage?: AiProseTokenUsage;
  /**
   * Read-only line-view context budget used when this unit's input was built.
   * Persisted with the checkpoint so restore replay recomputes the fingerprint
   * with the same budget even when a caller configured a custom value.
   */
  readonly lineViewContextChars?: number;
}

export interface EnhancementStageRunResultV1 {
  readonly stage: EnhancementStageKind;
  readonly status: 'succeeded' | 'retryableFailed' | 'failed' | 'no_changes';
  readonly patch: SemanticScenePatchV1;
  /** Ordered per-unit patches. Each resolves against the prior unit candidate. */
  readonly unitPatches: readonly SemanticScenePatchV1[];
  readonly candidate: CurrentSceneDocument;
  readonly units: readonly EnhancementUnitCheckpointV1[];
  readonly diagnostics: readonly { readonly code: string; readonly message: string }[];
  readonly policyVersion: string;
  readonly processorVersion: string;
}

export interface ModelCapabilityPort {
  readonly motionsForCharacter: (characterId: string) => readonly string[];
  readonly expressionsForCharacter: (characterId: string) => readonly string[];
  readonly hasModelConfigured: (characterId: string) => boolean;
  /** Optional host signal for strict final resource validation. */
  readonly capabilitiesReadyForCharacter?: (characterId: string) => boolean;
  readonly capabilityErrorForCharacter?: (characterId: string) => string | undefined;
}

export interface EnhancementProcessorRunnerOptions {
  readonly llm: AiProseLlmService;
  readonly profileProvider?: PerformanceProfileProvider | null;
  readonly modelCapabilities?: ModelCapabilityPort;
  readonly cinematicCapabilities?: CinematicCapabilityPort;
  /** Soft visible-char budget for technical splits. Defaults to 6000. */
  readonly maxVisibleCharsPerUnit?: number;
  readonly requestBudget?: AiProseRequestBudget;
  /** Invoked exactly once per finished unit with its final checkpoint. */
  readonly onUnitComplete?: (unit: EnhancementUnitCheckpointV1, unitIndex: number, totalUnits: number) => void;
  /** Invoked once, before the first unit of a stage runs. */
  readonly onStageStarted?: (stage: EnhancementStageKind) => void;
  /** Invoked once a stage's processing units are planned, before the first unit runs. */
  readonly onStagePlanned?: (stage: EnhancementStageKind, units: readonly TechnicalSplitUnitV1[]) => void;
}

const EMPTY_PATCH: SemanticScenePatchV1 = {
  version: SEMANTIC_SCENE_PATCH_VERSION,
  operations: [],
};

export class EnhancementProcessorRunner {
  private readonly llm: AiProseLlmService;
  private readonly profileProvider: PerformanceProfileProvider | null;
  private readonly modelCapabilities: ModelCapabilityPort;
  private readonly cinematicCapabilities: CinematicCapabilityPort | null;
  private readonly maxVisibleCharsPerUnit: number;
  private readonly requestBudget: AiProseRequestBudget | null;
  private readonly onUnitComplete: EnhancementProcessorRunnerOptions['onUnitComplete'];
  private readonly onStageStarted: EnhancementProcessorRunnerOptions['onStageStarted'];
  private readonly onStagePlanned: EnhancementProcessorRunnerOptions['onStagePlanned'];

  constructor(options: EnhancementProcessorRunnerOptions) {
    this.llm = options.llm;
    this.profileProvider = options.profileProvider ?? null;
    this.modelCapabilities = options.modelCapabilities ?? DEFAULT_MODEL_CAPABILITIES;    this.cinematicCapabilities = options.cinematicCapabilities ?? null;
    this.maxVisibleCharsPerUnit = options.maxVisibleCharsPerUnit ?? DEFAULT_MAX_VISIBLE_CHARS_PER_UNIT;
    this.requestBudget = options.requestBudget ?? null;
    this.onUnitComplete = options.onUnitComplete;
    this.onStageStarted = options.onStageStarted;
    this.onStagePlanned = options.onStagePlanned;
  }

  async runPerformance(input: {
    readonly document: CurrentSceneDocument;
    readonly segmentation: Pick<ResolvedEnhancementSegmentationV1, 'narrativeBoundaries' | 'segmentKeys'>;
    readonly llmOptions?: AiProseLlmCompletionOptions;
    /** Limited concurrency for performance windows. Defaults to 2, capped by request budget. */
    readonly concurrency?: number;
  }): Promise<EnhancementStageRunResultV1> {
    const requested = input.concurrency ?? 2;
    const budgetCap = this.requestBudget?.maxConcurrentRequests;
    const concurrency = budgetCap !== undefined
      ? Math.max(1, Math.min(requested, budgetCap))
      : Math.max(1, requested);
    return this.runStage({
      stage: 'performance',
      document: input.document,
      segmentation: input.segmentation,
      llmOptions: input.llmOptions,
      concurrency,
      serial: false,
    });
  }

  async runCinematic(input: {
    readonly document: CurrentSceneDocument;
    readonly segmentation: Pick<ResolvedEnhancementSegmentationV1, 'narrativeBoundaries' | 'segmentKeys'>;
    readonly llmOptions?: AiProseLlmCompletionOptions;
  }): Promise<EnhancementStageRunResultV1> {
    return this.runStage({
      stage: 'cinematic',
      document: input.document,
      segmentation: input.segmentation,
      llmOptions: input.llmOptions,
      concurrency: 1,
      serial: true,
    });
  }

  private async runStage(input: {
    readonly stage: EnhancementStageKind;
    readonly document: CurrentSceneDocument;
    readonly segmentation: Pick<ResolvedEnhancementSegmentationV1, 'narrativeBoundaries' | 'segmentKeys'>;
    readonly llmOptions?: AiProseLlmCompletionOptions;
    readonly concurrency: number;
    readonly serial: boolean;
  }): Promise<EnhancementStageRunResultV1> {
    const policy = getEnhancementStagePolicy(input.stage);
    const policyVersion = getEnhancementStagePolicyVersion(input.stage);
    const processorVersion = input.stage === 'performance'
      ? PERFORMANCE_PROCESSOR_VERSION
      : CINEMATIC_PROCESSOR_VERSION;
    const groups = buildFormalStatementGroups(input.document);
    const splitPlan = expandSegmentationToProcessingUnits({
      groups,
      segmentation: input.segmentation,
      maxVisibleCharsPerUnit: this.maxVisibleCharsPerUnit,
    });

    if (splitPlan.status === 'processing_unit_too_large') {
      return {
        stage: input.stage,
        status: 'failed',
        patch: EMPTY_PATCH,
        unitPatches: [],
        candidate: input.document,
        units: [],
        diagnostics: [{
          code: 'processing_unit_too_large',
          message: splitPlan.message,
        }],
        policyVersion,
        processorVersion,
      };
    }

    if (splitPlan.units.length === 0) {
      return {
        stage: input.stage,
        status: 'no_changes',
        patch: EMPTY_PATCH,
        unitPatches: [],
        candidate: input.document,
        units: [],
        diagnostics: [],
        policyVersion,
        processorVersion,
      };
    }

    if (input.serial) {
      return this.runSerial({
        stage: input.stage,
        document: input.document,
        groups,
        units: splitPlan.units,
        policy,
        policyVersion,
        processorVersion,
        llmOptions: input.llmOptions,
      });
    }

    return this.runConcurrent({
      stage: input.stage,
      document: input.document,
      groups,
      units: splitPlan.units,
      policy,
      policyVersion,
      processorVersion,
      concurrency: input.concurrency,
      llmOptions: input.llmOptions,
    });
  }

  private async runConcurrent(input: {
    readonly stage: EnhancementStageKind;
    readonly document: CurrentSceneDocument;
    readonly groups: readonly FormalStatementGroupV1[];
    readonly units: readonly TechnicalSplitUnitV1[];
    readonly policy: SemanticSceneStagePolicyV1;
    readonly policyVersion: string;
    readonly processorVersion: string;
    readonly concurrency: number;
    readonly llmOptions?: AiProseLlmCompletionOptions;
  }): Promise<EnhancementStageRunResultV1> {
    // Performance: each unit patches the base document independently, then merge ops in order.
    this.onStagePlanned?.(input.stage, input.units);
    this.onStageStarted?.(input.stage);
    const unitResults: EnhancementUnitCheckpointV1[] = new Array(input.units.length);
    let cursor = 0;
    const workers = Array.from(
      { length: Math.max(1, Math.min(input.concurrency, input.units.length)) },
      async () => {
        while (true) {
          const index = cursor;
          cursor += 1;
          if (index >= input.units.length) return;
          const unit = input.units[index]!;
          unitResults[index] = await this.runUnitOnDocument({
            stage: input.stage,
            document: input.document,
            groups: input.groups,
            unit,
            unitIndex: index,
            totalUnits: input.units.length,
            policy: input.policy,
            policyVersion: input.policyVersion,
            processorVersion: input.processorVersion,
            llmOptions: input.llmOptions,
          });
          this.onUnitComplete?.(unitResults[index]!, index, input.units.length);
        }
      },
    );
    await Promise.all(workers);

    const diagnostics: { code: string; message: string }[] = [];
    let failed = false;
    let retryable = false;

    // Merge successful unit patches in scene order onto a rolling candidate so
    // later units' line numbers stay valid only when they were authored on the
    // same base (content-only updates). Structural inserts within a unit stay
    // local to that unit's dry-run; cross-unit insert hazards are avoided by
    // applying each unit patch independently against the original base and
    // folding only when apply succeeds — failed units are skipped, successes kept.
    let candidate = input.document;
    const retainedOperations: Array<SemanticScenePatchV1['operations'][number]> = [];
    const retainedUnitPatches: SemanticScenePatchV1[] = [];

    for (let index = 0; index < unitResults.length; index += 1) {
      const unit = unitResults[index]!;
      if (unit.diagnostics) diagnostics.push(...unit.diagnostics);
      if (unit.status === 'retryableFailed') {
        retryable = true;
        continue;
      }
      if (unit.status === 'failed') {
        failed = true;
        continue;
      }
      if (unit.status !== 'succeeded' || !unit.patch || unit.patch.operations.length === 0) {
        continue;
      }

      try {
        // Each concurrent unit was authored against the original base snapshot.
        // Re-apply against the original base first for isolation, then merge the
        // resulting ops onto the rolling candidate via sequential re-apply of the
        // unit's own ops (same base coords → safe for content-only fills across
        // non-overlapping writable windows).
        const unitApplied = applySemanticScenePatch(input.document, unit.patch, {
          policy: input.policy,
        });
        if (input.stage === 'performance') {
          const mono = assertMonotonicPerformanceCompletion({
            base: collectPerformanceStatementSnapshots(input.document),
            candidate: collectPerformanceStatementSnapshots(unitApplied.candidate),
          });
          if (mono.length > 0) {
            retryable = true;
            diagnostics.push(...mono.map((item) => ({ code: item.code, message: item.message })));
            unitResults[index] = droppedUnitCheckpoint(unit, mono.map((item) => ({
              code: item.code,
              message: item.message,
            })));
            continue;
          }
        }
        // Fold onto the rolling candidate after rebasing public line locators by
        // stable host-owned statement/companion identities. Concurrent units
        // author against the original line view, while earlier structural
        // inserts may already have shifted those lines in the candidate.
        const rebasedPatch = rebasePatchLineLocators(
          input.document,
          candidate,
          unit.patch,
        );
        const folded = applySemanticScenePatch(candidate, rebasedPatch, {
          policy: input.policy,
        });
        if (input.stage === 'performance') {
          const monoFold = assertMonotonicPerformanceCompletion({
            base: collectPerformanceStatementSnapshots(candidate),
            candidate: collectPerformanceStatementSnapshots(folded.candidate),
          });
          if (monoFold.length > 0) {
            retryable = true;
            diagnostics.push(...monoFold.map((item) => ({
              code: item.code,
              message: item.message,
            })));
            unitResults[index] = droppedUnitCheckpoint(unit, monoFold.map((item) => ({
              code: item.code,
              message: item.message,
            })));
            continue;
          }
        }
        candidate = folded.candidate;
        retainedOperations.push(...rebasedPatch.operations);
        retainedUnitPatches.push(rebasedPatch);
        // Persisted unit checkpoints keep the ORIGINAL base-authored patch;
        // restore replay rebases performance patches itself against the
        // deterministic baseline (persisted patches are always base-authored).
      } catch (error) {
        retryable = true;
        const diagnostic = {
          code: 'patch_apply_failed',
          message: error instanceof Error ? error.message : String(error),
        };
        diagnostics.push(diagnostic);
        // The stage rejected this unit's patch; never persist it as succeeded.
        unitResults[index] = droppedUnitCheckpoint(unit, [diagnostic]);
      }
    }

    const patch: SemanticScenePatchV1 = {
      version: SEMANTIC_SCENE_PATCH_VERSION,
      operations: retainedOperations,
    };

    const status = failed && retainedOperations.length === 0
      ? 'failed'
      : (failed || retryable)
        ? 'retryableFailed'
        : retainedOperations.length === 0
          ? 'no_changes'
          : 'succeeded';

    return {
      stage: input.stage,
      status,
      // Retain successful unit patches even when the stage is retryableFailed.
      patch,
      unitPatches: retainedUnitPatches,
      candidate: retainedOperations.length > 0 || status === 'no_changes' ? candidate : input.document,
      units: unitResults,
      diagnostics,
      policyVersion: input.policyVersion,
      processorVersion: input.processorVersion,
    };
  }

  private async runSerial(input: {
    readonly stage: EnhancementStageKind;
    readonly document: CurrentSceneDocument;
    readonly groups: readonly FormalStatementGroupV1[];
    readonly units: readonly TechnicalSplitUnitV1[];
    readonly policy: SemanticSceneStagePolicyV1;
    readonly policyVersion: string;
    readonly processorVersion: string;
    readonly llmOptions?: AiProseLlmCompletionOptions;
  }): Promise<EnhancementStageRunResultV1> {
    let candidate = input.document;
    const accumulated: Array<SemanticScenePatchV1['operations'][number]> = [];
    const unitPatches: SemanticScenePatchV1[] = [];
    const unitResults: EnhancementUnitCheckpointV1[] = [];
    const diagnostics: { code: string; message: string }[] = [];

    this.onStagePlanned?.(input.stage, input.units);
    this.onStageStarted?.(input.stage);
    for (let index = 0; index < input.units.length; index += 1) {
      const unit = input.units[index]!;
      const result = await this.runUnitOnDocument({
        stage: input.stage,
        document: candidate,
        groups: buildFormalStatementGroups(candidate),
        unit,
        unitIndex: index,
        totalUnits: input.units.length,
        policy: input.policy,
        policyVersion: input.policyVersion,
        processorVersion: input.processorVersion,
        llmOptions: input.llmOptions,
        // After prior merges, group indices may drift; re-scope by unit time window on current groups.
        rescopeByTime: true,
        originalGroups: input.groups,
      });
      unitResults.push(result);
      this.onUnitComplete?.(result, index, input.units.length);
      if (result.diagnostics) diagnostics.push(...result.diagnostics);

      if (result.status !== 'succeeded') {
        return {
          stage: input.stage,
          status: result.status === 'retryableFailed' ? 'retryableFailed' : 'failed',
          patch: {
            version: SEMANTIC_SCENE_PATCH_VERSION,
            operations: accumulated,
          },
          unitPatches,
          candidate,
          units: unitResults,
          diagnostics,
          policyVersion: input.policyVersion,
          processorVersion: input.processorVersion,
        };
      }

      if (result.patch && result.patch.operations.length > 0) {
        try {
          const applied = applySemanticScenePatch(candidate, result.patch, {
            policy: input.policy,
          });
          candidate = applied.candidate;
          accumulated.push(...result.patch.operations);
          unitPatches.push(result.patch);
        } catch (error) {
          diagnostics.push({
            code: 'patch_apply_failed',
            message: error instanceof Error ? error.message : String(error),
          });
          return {
            stage: input.stage,
            status: 'retryableFailed',
            patch: {
              version: SEMANTIC_SCENE_PATCH_VERSION,
              operations: accumulated,
            },
            unitPatches,
            candidate,
            units: unitResults,
            diagnostics,
            policyVersion: input.policyVersion,
            processorVersion: input.processorVersion,
          };
        }
      }
    }

    const patch: SemanticScenePatchV1 = {
      version: SEMANTIC_SCENE_PATCH_VERSION,
      operations: accumulated,
    };

    return {
      stage: input.stage,
      status: accumulated.length === 0 ? 'no_changes' : 'succeeded',
      patch,
      unitPatches,
      candidate,
      units: unitResults,
      diagnostics,
      policyVersion: input.policyVersion,
      processorVersion: input.processorVersion,
    };
  }

  private async runUnitOnDocument(input: {
    readonly stage: EnhancementStageKind;
    readonly document: CurrentSceneDocument;
    readonly groups: readonly FormalStatementGroupV1[];
    readonly unit: TechnicalSplitUnitV1;
    readonly unitIndex: number;
    readonly totalUnits: number;
    readonly policy: SemanticSceneStagePolicyV1;
    readonly policyVersion: string;
    readonly processorVersion: string;
    readonly llmOptions?: AiProseLlmCompletionOptions;
    readonly rescopeByTime?: boolean;
    readonly originalGroups?: readonly FormalStatementGroupV1[];
  }): Promise<EnhancementUnitCheckpointV1> {
    try {
      const scope = resolveEnhancementUnitScope({
        document: input.document,
        groups: input.groups,
        unit: input.unit,
        unitIndex: input.unitIndex,
        totalUnits: input.totalUnits,
        rescopeByTime: input.rescopeByTime,
        originalGroups: input.originalGroups,
      });
      const lineViewHost = new SemanticSceneLineView(input.document);
      const storyText = projectFormalSceneStoryText(input.document, {
        lineFilter: scope.writableRootLines,
      });
      const lineFilter = scopeUnitLineViewFilter({
        document: input.document,
        scope,
        stage: input.stage,
        maxContextChars: this.maxVisibleCharsPerUnit,
      });
      const compactLineView = input.stage === 'performance'
        ? projectPerformanceLineView(input.document, {
          writableLines: scope.writableLines,
          lineFilter,
        })
        : projectCinematicLineView(input.document, {
          writableLines: scope.writableLines,
          lineFilter,
        });

      const promptInput = {
        storyText,
        lineView: compactLineView,
        unitKey: input.unit.key,
      };
      const inputFingerprint = buildEnhancementUnitInputFingerprint({
        document: input.document,
        stage: input.stage,
        unit: input.unit,
        unitIndex: input.unitIndex,
        totalUnits: input.totalUnits,
        modelCapabilities: this.modelCapabilities,
        profileProvider: this.profileProvider,
        cinematicCapabilities: this.cinematicCapabilities ?? undefined,
        rescopeByTime: input.rescopeByTime,
        originalGroups: input.originalGroups,
        maxLineViewContextChars: this.maxVisibleCharsPerUnit,
      });
      let originalUserPrompt: string;
      let llmResult: AiProseLlmResult<SemanticScenePatchV1>;
      // Structured field-level degrade warnings (e.g. performance_capabilities_unavailable)
      // surface on the unit checkpoint and stage result without failing the unit.
      const catalogWarnings: { code: string; message: string }[] = [];
      // Capture provider progress facts (model name, token usage) per unit so
      // checkpoints persist informational producer metadata without raw responses.
      let producerUsage: AiProseTokenUsage | undefined;
      let producerModelName: string | undefined;
      const llmOptions = input.llmOptions
        ? {
            ...input.llmOptions,
            onProgress: (progress: AiProseLlmProgress) => {
              if (progress.model) producerModelName = progress.model;
              producerUsage = {
                inputTokens: progress.inputTokens,
                outputTokens: progress.outputTokens,
                ...(progress.inputTokensSource === 'provider'
                  && progress.outputTokensSource === 'provider'
                  ? { totalTokens: progress.inputTokens + progress.outputTokens }
                  : {}),
              };
              input.llmOptions?.onProgress?.(progress);
            },
          }
        : undefined;
      if (input.stage === 'performance') {
        const catalog = buildPerformanceCapabilityCatalogForDocument({
          document: input.document,
          modelCapabilities: this.modelCapabilities,
          profileProvider: this.profileProvider,
        });
        catalogWarnings.push(...catalog.diagnostics.map((item) => ({
          code: item.code,
          message: item.message,
        })));
        // Ambiguous profile identity pauses the acting unit before any model
        // call; the generic strategy must not run while the host cannot decide
        // which specialized profile applies (ADR-0022).
        const ambiguous = catalog.diagnostics.find(
          (item) => item.code === 'ambiguous_identity',
        );
        // A configured but unreadable model is a strict resource error: the
        // unit cannot be treated as "no motion capability" (ADR-0022).
        const resourceBlockers = collectPerformanceResourceDiagnostics(
          input.document,
          this.modelCapabilities,
        );
        const blocking = ambiguous
          ? [{ code: ambiguous.code, message: ambiguous.message }]
          : resourceBlockers.map((item) => ({ code: item.code, message: item.message }));
        if (blocking.length > 0) {
          return {
            key: input.unit.key,
            stage: input.stage,
            status: 'retryableFailed',
            attemptCount: 1,
            policyVersion: input.policyVersion,
            processorVersion: input.processorVersion,
            inputFingerprint,
            diagnostics: blocking,
          };
        }
        const prompt = buildPerformanceEnhancementPrompt({ ...promptInput, catalog });
        originalUserPrompt = prompt.userPrompt;
        llmResult = await this.llm.enhancePerformance({
          ...promptInput,
          catalog,
        }, llmOptions);
      } else {
        const catalog = buildCinematicCapabilityCatalog({
          document: input.document,
          unitStartTime: scope.coreStartTime,
          capabilities: this.cinematicCapabilities ?? undefined,
        });
        const prompt = buildCinematicEnhancementPrompt({ ...promptInput, catalog });
        originalUserPrompt = prompt.userPrompt;
        llmResult = await this.llm.enhanceCinematic({
          ...promptInput,
          catalog,
        }, llmOptions);
      }

      const base: EnhancementUnitCheckpointV1 = {
        key: input.unit.key,
        stage: input.stage,
        status: 'running',
        attemptCount: 1,
        policyVersion: input.policyVersion,
        processorVersion: input.processorVersion,
        inputFingerprint,
        ...(producerModelName ? { modelName: producerModelName } : {}),
        ...(producerUsage ? { usage: producerUsage } : {}),
        lineViewContextChars: this.maxVisibleCharsPerUnit,
      };

      if (llmResult.status === 'failed') {
        return {
          ...base,
          status: 'retryableFailed',
          diagnostics: [
            ...catalogWarnings,
            {
              code: llmResult.error.code,
              message: llmResult.error.message,
            },
          ],
          attemptCount: llmResult.correctionUsed ? 2 : 1,
        };
      }

      let patch = llmResult.value;
      let attemptCount = llmResult.correctionUsed ? 2 : 1;
      let hostGateCorrected = false;

      const validateHostGates = (candidatePatch: SemanticScenePatchV1): {
        ok: true;
      } | {
        ok: false;
        diagnostics: readonly { readonly code: string; readonly message: string }[];
      } => {
        const scopeCheck = assertEnhancementStageScope({
          patch: candidatePatch,
          scope,
          lineView: lineViewHost,
        });
        if (!scopeCheck.ok) {
          return {
            ok: false,
            diagnostics: scopeCheck.issues.map((issue) => ({
              code: issue.code,
              message: issue.message,
            })),
          };
        }
        try {
          const applied = applySemanticScenePatch(input.document, candidatePatch, {
            policy: input.policy,
          });
          if (input.stage === 'performance' && candidatePatch.operations.length > 0) {
            const mono = assertMonotonicPerformanceCompletion({
              base: collectPerformanceStatementSnapshots(input.document),
              candidate: collectPerformanceStatementSnapshots(applied.candidate),
            });
            if (mono.length > 0) {
              return {
                ok: false,
                diagnostics: mono.map((item) => ({
                  code: item.code,
                  message: item.message,
                })),
              };
            }
            // Motion/expression keys must come from the model's actual
            // capability catalog; a model returning out-of-catalog keys is a
            // resource violation, not an empty legal capability set.
            const resource = validatePerformanceResourceCapabilities(
              applied.candidate,
              this.modelCapabilities,
            );
            if (resource.length > 0) {
              return {
                ok: false,
                diagnostics: resource.map((item) => ({
                  code: item.code,
                  message: item.message,
                })),
              };
            }
          }
        } catch (error) {
          return {
            ok: false,
            diagnostics: [{
              code: 'unit_patch_invalid',
              message: error instanceof Error ? error.message : String(error),
            }],
          };
        }
        return { ok: true };
      };

      let gate = validateHostGates(patch);
      if (!gate.ok && typeof this.llm.correctEnhancementPatch === 'function') {
        const corrected = await this.llm.correctEnhancementPatch({
          stage: input.stage === 'performance' ? 'acting' : 'cinematic',
          originalUserPrompt,
          invalidPatch: patch,
          failures: gate.diagnostics.map((item) => ({
            code: item.code,
            message: item.message,
          })),
        }, input.llmOptions);
        hostGateCorrected = true;
        attemptCount = Math.max(attemptCount, 2);
        if (corrected.status === 'failed') {
          return {
            ...base,
            status: 'retryableFailed',
            diagnostics: [
              ...catalogWarnings,
              ...gate.diagnostics,
              {
                code: corrected.error.code,
                message: corrected.error.message,
              },
            ],
            attemptCount,
          };
        }
        patch = corrected.value;
        gate = validateHostGates(patch);
      }

      if (!gate.ok) {
        return {
          ...base,
          status: 'retryableFailed',
          diagnostics: [...catalogWarnings, ...gate.diagnostics],
          attemptCount: hostGateCorrected ? Math.max(attemptCount, 2) : attemptCount,
        };
      }

      return {
        ...base,
        status: 'succeeded',
        patch,
        attemptCount: hostGateCorrected ? Math.max(attemptCount, 2) : attemptCount,
        ...(catalogWarnings.length > 0 ? { diagnostics: catalogWarnings } : {}),
      };
    } catch (error) {
      return {
        key: input.unit.key,
        stage: input.stage,
        status: 'retryableFailed',
        attemptCount: 1,
        policyVersion: input.policyVersion,
        processorVersion: input.processorVersion,
        diagnostics: [{
          code: 'unit_runner_error',
          message: error instanceof Error ? error.message : String(error),
        }],
      };
    }
  }
}

export function mergeEnhancementPatches(
  patches: readonly SemanticScenePatchV1[],
): SemanticScenePatchV1 {
  const operations: Array<SemanticScenePatchV1['operations'][number]> = [];
  for (const patch of patches) {
    operations.push(...patch.operations);
  }
  return {
    version: SEMANTIC_SCENE_PATCH_VERSION,
    operations,
  };
}

export function issuesFromUnknown(error: unknown): SemanticScenePatchIssueV1[] {
  if (error && typeof error === 'object' && 'issues' in error) {
    const issues = (error as { issues: unknown }).issues;
    if (Array.isArray(issues)) return issues as SemanticScenePatchIssueV1[];
  }
  return [{
    code: 'invalid_arguments',
    message: error instanceof Error ? error.message : String(error),
  }];
}

/**
 * Strict resource diagnostics for characters with a configured model whose
 * capabilities could not be read or parsed. Empty when the port lacks the
 * optional readiness methods (existing behavior is preserved).
 */
function collectPerformanceResourceDiagnostics(
  document: CurrentSceneDocument,
  capabilities: ModelCapabilityPort,
): readonly { readonly code: string; readonly message: string; readonly characterId?: string }[] {
  if (typeof capabilities.capabilitiesReadyForCharacter !== 'function') return [];
  const diagnostics: { code: string; message: string; characterId?: string }[] = [];
  for (const character of document.meta.characters ?? []) {
    if (!capabilities.hasModelConfigured(character.id)) continue;
    if (capabilities.capabilitiesReadyForCharacter(character.id)) continue;
    diagnostics.push({
      code: 'performance_resource_unavailable',
      message: capabilities.capabilityErrorForCharacter?.(character.id)
        ?? `Model capabilities for "${character.id}" are unavailable`,
      characterId: character.id,
    });
  }
  return diagnostics;
}


function droppedUnitCheckpoint(
  unit: EnhancementUnitCheckpointV1,
  additionalDiagnostics: readonly { readonly code: string; readonly message: string }[],
): EnhancementUnitCheckpointV1 {
  return {
    ...unit,
    status: 'retryableFailed',
    patch: undefined,
    diagnostics: [
      ...(unit.diagnostics ?? []),
      ...additionalDiagnostics,
    ],
  };
}

/**
 * Map a patch's public line locators from the `baseDocument` coordinate system
 * to the `candidateDocument` coordinate system by stable statement/companion
 * identity. Throws when a line no longer resolves in the candidate.
 */
export function rebasePatchLineLocators(
  baseDocument: CurrentSceneDocument,
  candidateDocument: CurrentSceneDocument,
  patch: SemanticScenePatchV1,
): SemanticScenePatchV1 {
  const baseView = new SemanticSceneLineView(baseDocument);
  const candidateView = new SemanticSceneLineView(candidateDocument);

  const rebaseLine = (line: number, field: string): number => {
    const source = baseView.resolveInternal(line);
    if (!source) {
      throw new Error(`${field} ${line} is not present in the unit base snapshot`);
    }
    const target = candidateView.internalLines().find((resolved) => (
      resolved.kind === source.kind
      && resolved.statementId === source.statementId
      && resolved.companionId === source.companionId
    ));
    if (!target) {
      throw new Error(`${field} ${line} no longer resolves in the rolling candidate`);
    }
    return target.line;
  };

  return {
    ...patch,
    operations: patch.operations.map((operation) => {
      const kind = operation.kind ?? operation.op ?? operation.operation;
      switch (kind) {
        case 'insertStatement': {
          const op = operation as Extract<SemanticSceneOperationV1, { time: number; statement: unknown }>;
          return {
            ...op,
            ...(op.beforeLine !== undefined
              ? { beforeLine: rebaseLine(op.beforeLine, 'beforeLine') }
              : {}),
          };
        }
        case 'insertCompanion': {
          const op = operation as Extract<SemanticSceneOperationV1, { parentLine: number; companion: unknown }>;
          return {
            ...op,
            parentLine: rebaseLine(op.parentLine, 'parentLine'),
            ...(op.beforeLine !== undefined
              ? { beforeLine: rebaseLine(op.beforeLine, 'beforeLine') }
              : {}),
          };
        }
        case 'updateStatement':
        case 'updateCompanion':
        case 'deleteLine':
        case 'moveLine': {
          const op = operation as Extract<SemanticSceneOperationV1, { line: number }>;
          return {
            ...op,
            line: rebaseLine(op.line, 'line'),
          };
        }
        case 'reorderCompanions': {
          const op = operation as Extract<SemanticSceneOperationV1, { parentLine: number; orderedLines: readonly number[] }>;
          return {
            ...op,
            parentLine: rebaseLine(op.parentLine, 'parentLine'),
            orderedLines: op.orderedLines.map((line) => rebaseLine(line, 'orderedLine')),
          };
        }
        default:
          return operation;
      }
    }),
  };
}
