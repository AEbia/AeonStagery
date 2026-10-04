import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import type {
  AiProseEnhancementStageCheckpointV1,
  AiProseEnhancementStageKind,
  AiProseEnhancementStateV1,
  AiProseEnhancementUnitCheckpointV1,
} from '../../api/types/ai-prose-enhancement';
import type { AiProseCharacterBindingPlanV1 } from '../../api/types/ai-prose-authoring';
import type { SceneEnhancementStageResultV1 } from './SceneEnhancementSnapshot';
import {
  normalizeRestoredStageCheckpoint,
} from './AiProseEnhancementState';
import {
  applyEnhancementStagePlan,
  combineStageUnitPatches,
  type EnhancementStagePlanV1,
} from './FormalEnhancementApply';
import { getEnhancementStagePolicyVersion } from './CinematicEnhancementPolicy';
import {
  buildEnhancementUnitInputFingerprint,
  DEFAULT_LINE_VIEW_CONTEXT_CHARS,
  PERFORMANCE_PROCESSOR_VERSION,
  CINEMATIC_PROCESSOR_VERSION,
} from './EnhancementUnitInput';
import type { ModelCapabilityPort } from './EnhancementProcessorRunner';
import { rebasePatchLineLocators } from './EnhancementProcessorRunner';
import type { PerformanceProfileProvider } from './performance';
import type { CinematicCapabilityPort } from './CinematicCapabilityCatalog';
import {
  buildFormalStatementGroups,
  buildSingleSegmentSegmentation,
} from './FormalSceneEnhancementHost';
import {
  DEFAULT_MAX_VISIBLE_CHARS_PER_UNIT,
  expandSegmentationToProcessingUnits,
  type TechnicalSplitUnitV1,
} from './EnhancementScope';

export const ENHANCEMENT_STAGE_ORDER: readonly AiProseEnhancementStageKind[] = [
  'performance',
  'cinematic',
];

export interface CurrentEnhancementVersionsV1 {
  readonly policyVersions: Readonly<Record<AiProseEnhancementStageKind, string>>;
  readonly processorVersions: Readonly<Record<AiProseEnhancementStageKind, string>>;
}

export function getCurrentEnhancementVersions(): CurrentEnhancementVersionsV1 {
  return {
    policyVersions: {
      performance: getEnhancementStagePolicyVersion('performance'),
      cinematic: getEnhancementStagePolicyVersion('cinematic'),
    },
    processorVersions: {
      performance: PERFORMANCE_PROCESSOR_VERSION,
      cinematic: CINEMATIC_PROCESSOR_VERSION,
    },
  };
}

/**
 * Incremental stage checkpoint wiring for the workbench: on stage start it
 * persists a `running` checkpoint with no units, and after each unit it
 * re-persists the stage with the completed units accumulated in `unitIndex`
 * order (stable scene order), so a crash mid-stage keeps finished units.
 */
export function createIncrementalStageCheckpointPersister(input: {
  readonly persist: (
    stage: AiProseEnhancementStageKind,
    checkpoint: AiProseEnhancementStageCheckpointV1,
  ) => void;
}): {
  readonly onStageStarted: (stage: AiProseEnhancementStageKind) => void;
  readonly onUnitComplete: (
    unit: AiProseEnhancementUnitCheckpointV1,
    unitIndex: number,
    totalUnits: number,
  ) => void;
} {
  const unitsByStage = new Map<
    AiProseEnhancementStageKind,
    Map<number, AiProseEnhancementUnitCheckpointV1>
  >();
  return {
    onStageStarted(stage) {
      unitsByStage.set(stage, new Map());
      input.persist(stage, { stage, status: 'running', units: [] });
    },
    onUnitComplete(unit, unitIndex) {
      const slots = unitsByStage.get(unit.stage);
      if (!slots) return;
      slots.set(unitIndex, unit);
      const units = [...slots.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([, completed]) => completed);
      input.persist(unit.stage, { stage: unit.stage, status: 'running', units });
    },
  };
}

/**
 * Map a snapshot stage result (orchestrator output) to a persisted checkpoint.
 * Summaries already carry the validated per-unit patches and producer metadata.
 */
export function enhancementStageCheckpointFromSnapshot(
  stage: AiProseEnhancementStageKind,
  result: SceneEnhancementStageResultV1,
): AiProseEnhancementStageCheckpointV1 {
  return {
    stage,
    status: result.status === 'idle' || result.status === 'running'
      ? 'running'
      : result.status,
    units: (result.units ?? []).map((unit) => ({
      key: unit.key,
      stage,
      status: unit.status,
      ...(unit.patch ? { patch: unit.patch } : {}),
      ...(unit.diagnostics ? { diagnostics: unit.diagnostics } : {}),
      attemptCount: unit.attemptCount,
      policyVersion: unit.policyVersion ?? result.policyVersion ?? '',
      processorVersion: unit.processorVersion ?? result.processorVersion ?? '',
      ...(unit.inputFingerprint ? { inputFingerprint: unit.inputFingerprint } : {}),
      ...(unit.modelName ? { modelName: unit.modelName } : {}),
      ...(unit.usage ? { usage: unit.usage } : {}),
      ...(unit.lineViewContextChars ? { lineViewContextChars: unit.lineViewContextChars } : {}),
    })),
    ...(result.diagnostics && result.diagnostics.length > 0
      ? { diagnostics: result.diagnostics }
      : {}),
  };
}

/**
 * Invalidate a unit: drop its patch and record why. The unit keeps its key and
 * versions so a later rerun can compare against current versions.
 */
export function invalidateEnhancementUnit(
  unit: AiProseEnhancementUnitCheckpointV1,
  reason: string,
): AiProseEnhancementUnitCheckpointV1 {
  return {
    ...unit,
    status: 'retryableFailed',
    patch: undefined,
    diagnostics: [
      ...(unit.diagnostics ?? []).filter((item) => item.code !== reason),
      { code: reason, message: reasonMessage(reason, unit) },
    ],
  };
}

function reasonMessage(reason: string, unit: AiProseEnhancementUnitCheckpointV1): string {
  switch (reason) {
    case 'baseline_changed':
      return 'Enhancement baseline changed; unit must be regenerated';
    case 'binding_plan_changed':
      return 'Character binding plan changed; unit must be regenerated';
    case 'policy_version_changed':
      return `Stage policy version changed (stored ${unit.policyVersion}); unit must be regenerated`;
    case 'processor_version_changed':
      return `Processor version changed (stored ${unit.processorVersion}); unit must be regenerated`;
    case 'replay_failed':
      return 'Unit patch no longer applies to the current baseline';
    case 'downstream_invalidated':
      return 'An upstream unit was regenerated; downstream result invalidated';
    default:
      return 'Unit must be regenerated';
  }
}

function invalidateStage(
  checkpoint: AiProseEnhancementStageCheckpointV1,
  reason: string,
): AiProseEnhancementStageCheckpointV1 {
  const units = checkpoint.units.map((unit) => invalidateEnhancementUnit(unit, reason));
  return { ...checkpoint, units, status: 'retryableFailed' };
}

/**
 * Apply restore-time invalidation rules to a persisted state:
 * 1. leftover `running` units become retryableFailed(interrupted);
 * 2. a baseline fingerprint or binding-plan mismatch invalidates every unit;
 * 3. processor / policy version changes invalidate the affected stage's units
 *    and everything downstream of them;
 * 4. any invalidated performance result invalidates the whole cinematic stage.
 * A changed model alone never invalidates a still-valid result.
 */
export function restoreEnhancementState(input: {
  readonly state: AiProseEnhancementStateV1;
  readonly baseFingerprint: string;
  readonly currentBindingPlan?: AiProseCharacterBindingPlanV1;
  readonly current?: CurrentEnhancementVersionsV1;
}): AiProseEnhancementStateV1 {
  const current = input.current ?? getCurrentEnhancementVersions();
  let next: AiProseEnhancementStateV1 = {
    ...input.state,
    performance: input.state.performance
      ? normalizeRestoredStageCheckpoint(input.state.performance)
      : undefined,
    cinematic: input.state.cinematic
      ? normalizeRestoredStageCheckpoint(input.state.cinematic)
      : undefined,
  };

  const baselineMismatch = input.state.baseFingerprint !== input.baseFingerprint;
  const planMismatch = bindingPlansDiffer(
    input.state.characterBindingPlan,
    input.currentBindingPlan,
  );
  const globalReason = baselineMismatch
    ? 'baseline_changed'
    : planMismatch
      ? 'binding_plan_changed'
      : undefined;

  const performanceInvalidated = globalReason !== undefined;
  if (globalReason) {
    next = {
      ...next,
      performance: next.performance
        ? invalidateStage(next.performance, globalReason)
        : next.performance,
      cinematic: next.cinematic
        ? invalidateStage(next.cinematic, globalReason)
        : next.cinematic,
    };
  }

  const invalidateVersionedUnits = (
    checkpoint: AiProseEnhancementStageCheckpointV1 | undefined,
    stage: AiProseEnhancementStageKind,
  ): AiProseEnhancementStageCheckpointV1 | undefined => {
    if (!checkpoint) return checkpoint;
    const changed = checkpoint.units.filter((unit) => {
      if (unit.status === 'succeeded') {
        if (unit.processorVersion !== current.processorVersions[stage]) return true;
        if (unit.policyVersion !== current.policyVersions[stage]) return true;
      }
      return false;
    });
    if (changed.length === 0) return checkpoint;
    const units = checkpoint.units.map((unit) => {
      if (unit.processorVersion !== current.processorVersions[stage]) {
        return invalidateEnhancementUnit(unit, 'processor_version_changed');
      }
      if (unit.policyVersion !== current.policyVersions[stage]) {
        return invalidateEnhancementUnit(unit, 'policy_version_changed');
      }
      return unit;
    });
    return { ...checkpoint, units, status: 'retryableFailed' };
  };

  const performance = invalidateVersionedUnits(next.performance, 'performance');
  let cinematic = invalidateVersionedUnits(next.cinematic, 'cinematic');

  if (performanceInvalidated || hasInvalidUnits(performance)) {
    cinematic = cinematic ? invalidateStage(cinematic, 'downstream_invalidated') : cinematic;
  }

  return {
    ...next,
    performance,
    cinematic,
  };
}

function bindingPlansDiffer(
  left: AiProseCharacterBindingPlanV1 | undefined,
  right: AiProseCharacterBindingPlanV1 | undefined,
): boolean {
  return JSON.stringify(left) !== JSON.stringify(right);
}

function hasInvalidUnits(checkpoint: AiProseEnhancementStageCheckpointV1 | undefined): boolean {
  return !!checkpoint && checkpoint.units.some((unit) => unit.status === 'retryableFailed');
}

/**
 * Invalidate a stage's results (e.g. user reruns the stage) plus every later
 * stage. Ordering follows ENHANCEMENT_STAGE_ORDER (performance → cinematic).
 */
export function invalidateEnhancementFromStage(
  state: AiProseEnhancementStateV1,
  stage: AiProseEnhancementStageKind,
): AiProseEnhancementStateV1 {
  let next = { ...state };
  const rerunIndex = ENHANCEMENT_STAGE_ORDER.indexOf(stage);
  for (let index = rerunIndex; index < ENHANCEMENT_STAGE_ORDER.length; index += 1) {
    const key = ENHANCEMENT_STAGE_ORDER[index]!;
    const checkpoint = next[key];
    if (!checkpoint) continue;
    next = {
      ...next,
      [key]: invalidateStage(
        checkpoint,
        index === rerunIndex ? 'explicit_rerun' : 'downstream_invalidated',
      ),
    };
  }
  return next;
}

/**
 * Optional capability ports for restore-time fingerprint recomputation. A unit
 * whose recomputation needs a missing port skips fingerprint verification (its
 * patch is still replayed as before). The draft restore path passes the same
 * ports the processor runner used at run time.
 */
export interface EnhancementReplayPortsV1 {
  readonly modelCapabilities?: ModelCapabilityPort;
  readonly profileProvider?: PerformanceProfileProvider | null;
  readonly cinematicCapabilities?: CinematicCapabilityPort;
}

/**
 * Rebuild the deterministic single-segment processing-unit plan the draft
 * enhancement path authored against (workbench always locks one narrative
 * segment, optionally split for request budget). Returns the units keyed by
 * their stable processing-unit key, or null when the current projection no
 * longer yields a comparable plan (verification is then skipped).
 */
function rebuildDraftProcessingUnits(
  document: CurrentSceneDocument,
): Map<string, TechnicalSplitUnitV1> | null {
  try {
    const groups = buildFormalStatementGroups(document);
    const segmentation = buildSingleSegmentSegmentation(groups);
    const plan = expandSegmentationToProcessingUnits({
      groups,
      segmentation,
      maxVisibleCharsPerUnit: DEFAULT_MAX_VISIBLE_CHARS_PER_UNIT,
    });
    if (plan.status !== 'ok') return null;
    return new Map(plan.units.map((unit) => [unit.key, unit]));
  } catch {
    return null;
  }
}

/**
 * Recompute the unit's input fingerprint against the given reference document
 * and compare with the stored fingerprint. Returns false when the stored
 * fingerprint is missing verification support (no port), the unit no longer
 * resolves in the current projection, or the recomputed fingerprint differs.
 */
function verifyReplayedUnitFingerprint(input: {
  readonly unit: AiProseEnhancementUnitCheckpointV1;
  readonly stage: AiProseEnhancementStageKind;
  readonly reference: CurrentSceneDocument;
  readonly originalGroups: ReturnType<typeof buildFormalStatementGroups>;
  readonly unitIndex: number;
  readonly totalUnits: number;
  readonly ports: EnhancementReplayPortsV1;
  readonly unitsByKey: Map<string, TechnicalSplitUnitV1> | null;
}): boolean {
  const stored = input.unit.inputFingerprint;
  if (stored === undefined) return true;
  if (!input.unitsByKey) return true;
  if (input.stage === 'performance' && input.ports.modelCapabilities === undefined) return true;
  if (input.stage === 'cinematic' && input.ports.cinematicCapabilities === undefined) return true;

  const unit = input.unitsByKey.get(input.unit.key);
  if (!unit) return false;

  try {
    const recomputed = buildEnhancementUnitInputFingerprint({
      document: input.reference,
      stage: input.stage,
      unit,
      unitIndex: input.unitIndex,
      totalUnits: input.totalUnits,
      modelCapabilities: input.ports.modelCapabilities,
      profileProvider: input.ports.profileProvider,
      cinematicCapabilities: input.ports.cinematicCapabilities,
      rescopeByTime: input.stage === 'cinematic',
      originalGroups: input.stage === 'cinematic' ? input.originalGroups : undefined,
      maxLineViewContextChars: input.unit.lineViewContextChars
        ?? DEFAULT_LINE_VIEW_CONTEXT_CHARS,
    });
    return recomputed === stored;
  } catch {
    return false;
  }
}

/**
 * Rebuild the current candidate scene from the deterministic baseline by
 * replaying every still-succeeded unit patch in stable order (performance
 * first, then cinematic). Before applying a unit's patch its stored input
 * fingerprint is recomputed against the unit's authored reference (the
 * original baseline for performance units, the rolling candidate for
 * cinematic units, mirroring the runner's concurrent/serial modes); a mismatch
 * invalidates the unit with `replay_failed` together with its downstream
 * results and skips the patch. Units without a stored fingerprint or whose
 * recomputation lacks a capability port are replayed without verification.
 * Returns the updated state and the replayed candidate (equal to the baseline
 * when nothing succeeded).
 */
export function replayEnhancementState(input: {
  readonly document: CurrentSceneDocument;
  readonly state: AiProseEnhancementStateV1;
  readonly ports?: EnhancementReplayPortsV1;
}): { readonly state: AiProseEnhancementStateV1; readonly candidate: CurrentSceneDocument } {
  const ports = input.ports ?? {};
  const unitsByKey = rebuildDraftProcessingUnits(input.document);
  const originalGroups = buildFormalStatementGroups(input.document);

  let next = input.state;
  let candidate = input.document;

  for (const stage of ENHANCEMENT_STAGE_ORDER) {
    const checkpoint = next[stage];
    if (!checkpoint) continue;
    const allUnits = checkpoint.units;

    for (let index = 0; index < allUnits.length; index += 1) {
      const unit = allUnits[index]!;
      if (unit.status !== 'succeeded' || !unit.patch || unit.patch.operations.length === 0) {
        continue;
      }

      const reference = stage === 'performance' ? input.document : candidate;
      const verified = verifyReplayedUnitFingerprint({
        unit,
        stage,
        reference,
        originalGroups,
        unitIndex: index,
        totalUnits: allUnits.length,
        ports,
        unitsByKey,
      });

      if (!verified) {
        // Invalidate the mismatched unit, then its stage and every later stage.
        const units = checkpoint.units.map((checkpointUnit) => (
          checkpointUnit.patch === unit.patch
            ? invalidateEnhancementUnit(checkpointUnit, 'replay_failed')
            : checkpointUnit
        ));
        next = { ...next, [stage]: { ...checkpoint, units, status: 'retryableFailed' } };
        next = invalidateEnhancementFromStage(next, stage);
        continue;
      }

      try {
        // Persisted patches are always base-authored; performance patches are
        // rebased here onto the rolling candidate (mirroring the runner's
        // concurrent fold). A rebase failure means the unit's authored lines no
        // longer resolve and falls into the replay_failed invalidation path.
        const patch = stage === 'performance'
          ? rebasePatchLineLocators(input.document, candidate, unit.patch)
          : unit.patch;
        const result = applyEnhancementStagePlan(candidate, {
          version: 1,
          stages: [{ stage, patch }],
        }, { materializePlaceholders: false });
        candidate = result.candidate;
      } catch {
        // Patch no longer applies: same invalidation path as a fingerprint mismatch.
        const units = checkpoint.units.map((checkpointUnit) => (
          checkpointUnit.patch === unit.patch
            ? invalidateEnhancementUnit(checkpointUnit, 'replay_failed')
            : checkpointUnit
        ));
        next = { ...next, [stage]: { ...checkpoint, units, status: 'retryableFailed' } };
        next = invalidateEnhancementFromStage(next, stage);
      }
    }
  }

  return { state: next, candidate };
}

/** Build an apply-ready stage plan from the still-succeeded units of a state. */
export function enhancementStagePlanFromState(
  state: AiProseEnhancementStateV1,
): EnhancementStagePlanV1 {
  const performanceUnits = (state.performance?.units ?? [])
    .filter((unit) => unit.status === 'succeeded' && unit.patch && unit.patch.operations.length > 0)
    .map((unit) => unit.patch!);
  const cinematicUnits = (state.cinematic?.units ?? [])
    .filter((unit) => unit.status === 'succeeded' && unit.patch && unit.patch.operations.length > 0)
    .map((unit) => unit.patch!);
  return combineStageUnitPatches(
    performanceUnits.length > 0 ? performanceUnits : undefined,
    cinematicUnits.length > 0 ? cinematicUnits : undefined,
  );
}
