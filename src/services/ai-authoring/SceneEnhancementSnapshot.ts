import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import type { SemanticScenePatchV1 } from '../../api/types/semantic-scene-patch';
import type { AiProseTokenUsage } from './AiProseContracts';

/**
 * Formal scene enhancement run binding (ADR-0022).
 * Preview is bound to exact DocumentStore version; any version change invalidates
 * the whole unapplied preview — no field-level 3-way merge.
 */

export type SceneEnhancementPhaseV1 =
  | 'idle'
  | 'segmenting'
  | 'performance'
  | 'cinematic'
  | 'preview_ready'
  | 'failed'
  | 'no_changes';

export interface SceneEnhancementVersionBindingV1 {
  /** Renderer scene session epoch; changes when active scene switches. */
  readonly sceneSessionEpoch: number;
  /** Exact DocumentStore version at generation time. */
  readonly documentVersion: number;
}

export interface ResolvedEnhancementSegmentationV1 {
  readonly binding: SceneEnhancementVersionBindingV1;
  /** Ordered narrative segment keys stable for this run. */
  readonly segmentKeys: readonly string[];
  /** Inclusive group-index ranges or opaque host keys for narrative boundaries. */
  readonly narrativeBoundaries: readonly {
    readonly key: string;
    readonly startGroupIndex: number;
    readonly endGroupIndexExclusive: number;
  }[];
  readonly source: 'user_timepoints' | 'semantic_segmentation' | 'single_segment' | 'empty_scene';
}

export interface SceneEnhancementUnitCheckpointSummaryV1 {
  readonly key: string;
  readonly status: 'idle' | 'running' | 'succeeded' | 'retryableFailed' | 'failed';
  readonly attemptCount: number;
  readonly inputFingerprint?: string;
  readonly diagnostics?: readonly { readonly code: string; readonly message: string }[];
  /** Validated unit patch — persisted with the draft checkpoint for restore replay. */
  readonly patch?: SemanticScenePatchV1;
  readonly policyVersion?: string;
  readonly processorVersion?: string;
  readonly modelName?: string;
  readonly usage?: AiProseTokenUsage;
  /** Line-view context budget the unit input was built with (persisted for replay). */
  readonly lineViewContextChars?: number;
}

export interface SceneEnhancementStageResultV1 {
  readonly stage: 'performance' | 'cinematic';
  readonly status: 'idle' | 'running' | 'succeeded' | 'retryableFailed' | 'failed';
  readonly patch?: SemanticScenePatchV1;
  /** Ordered patches retain fixed-line-view boundaries across processing units. */
  readonly unitPatches?: readonly SemanticScenePatchV1[];
  readonly diagnostics?: readonly { readonly code: string; readonly message: string }[];
  readonly policyVersion?: string;
  readonly processorVersion?: string;
  /** Processing-unit checkpoints for UI / retry (not full prompt payloads). */
  readonly units?: readonly SceneEnhancementUnitCheckpointSummaryV1[];
}

/**
 * In-memory formal scene enhancement snapshot. Not persisted across process restarts.
 */
export interface SceneEnhancementSnapshotV1 {
  readonly binding: SceneEnhancementVersionBindingV1;
  readonly phase: SceneEnhancementPhaseV1;
  readonly segmentation?: ResolvedEnhancementSegmentationV1;
  readonly performance?: SceneEnhancementStageResultV1;
  readonly cinematic?: SceneEnhancementStageResultV1;
  /** Combined preview patch when ready (performance only or performance+cinematic). */
  readonly previewPatch?: SemanticScenePatchV1;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type SceneEnhancementInvalidationReasonV1 =
  | 'document_version_changed'
  | 'scene_session_epoch_changed'
  | 'segmentation_changed'
  | 'active_scene_switched'
  | 'renderer_reset'
  | 'explicit_discard';

export interface SceneEnhancementValidityV1 {
  readonly valid: boolean;
  readonly reason?: SceneEnhancementInvalidationReasonV1;
}

export function createSceneEnhancementSnapshot(input: {
  readonly sceneSessionEpoch: number;
  readonly documentVersion: number;
  readonly phase?: SceneEnhancementPhaseV1;
  readonly nowMs?: number;
}): SceneEnhancementSnapshotV1 {
  const now = input.nowMs ?? Date.now();
  return {
    binding: {
      sceneSessionEpoch: input.sceneSessionEpoch,
      documentVersion: input.documentVersion,
    },
    phase: input.phase ?? 'idle',
    createdAtMs: now,
    updatedAtMs: now,
  };
}

/**
 * Whole-preview invalidation check. Any document version or session epoch mismatch
 * invalidates the entire snapshot — no partial field merge.
 */
export function checkSceneEnhancementSnapshotValidity(
  snapshot: SceneEnhancementSnapshotV1,
  current: SceneEnhancementVersionBindingV1,
): SceneEnhancementValidityV1 {
  if (snapshot.binding.sceneSessionEpoch !== current.sceneSessionEpoch) {
    return { valid: false, reason: 'scene_session_epoch_changed' };
  }
  if (snapshot.binding.documentVersion !== current.documentVersion) {
    return { valid: false, reason: 'document_version_changed' };
  }
  return { valid: true };
}

export function isSceneEnhancementSnapshotValid(
  snapshot: SceneEnhancementSnapshotV1,
  current: SceneEnhancementVersionBindingV1,
): boolean {
  return checkSceneEnhancementSnapshotValidity(snapshot, current).valid;
}

/**
 * Bind resolved narrative segmentation to the same version binding as the run.
 * Performance and cinematic stages share this result; technical splits must not rewrite it.
 */
export function bindEnhancementSegmentation(input: {
  readonly binding: SceneEnhancementVersionBindingV1;
  readonly segmentKeys: readonly string[];
  readonly narrativeBoundaries: ResolvedEnhancementSegmentationV1['narrativeBoundaries'];
  readonly source: ResolvedEnhancementSegmentationV1['source'];
}): ResolvedEnhancementSegmentationV1 {
  return {
    binding: input.binding,
    segmentKeys: [...input.segmentKeys],
    narrativeBoundaries: input.narrativeBoundaries.map((boundary) => ({ ...boundary })),
    source: input.source,
  };
}

export function withSceneEnhancementPhase(
  snapshot: SceneEnhancementSnapshotV1,
  phase: SceneEnhancementPhaseV1,
  nowMs?: number,
): SceneEnhancementSnapshotV1 {
  return {
    ...snapshot,
    phase,
    updatedAtMs: nowMs ?? Date.now(),
  };
}

export function withSceneEnhancementStageResult(
  snapshot: SceneEnhancementSnapshotV1,
  result: SceneEnhancementStageResultV1,
  nowMs?: number,
): SceneEnhancementSnapshotV1 {
  const next: SceneEnhancementSnapshotV1 = {
    ...snapshot,
    updatedAtMs: nowMs ?? Date.now(),
  };
  if (result.stage === 'performance') {
    return { ...next, performance: result };
  }
  return { ...next, cinematic: result };
}

export function withSceneEnhancementPreviewPatch(
  snapshot: SceneEnhancementSnapshotV1,
  previewPatch: SemanticScenePatchV1,
  nowMs?: number,
): SceneEnhancementSnapshotV1 {
  return {
    ...snapshot,
    previewPatch,
    phase: 'preview_ready',
    updatedAtMs: nowMs ?? Date.now(),
  };
}

/**
 * Empty formal scene fast-path: no model calls, no empty preview, no history.
 */
export function createEmptySceneNoChangesSnapshot(input: {
  readonly sceneSessionEpoch: number;
  readonly documentVersion: number;
  readonly nowMs?: number;
}): SceneEnhancementSnapshotV1 {
  const now = input.nowMs ?? Date.now();
  return {
    binding: {
      sceneSessionEpoch: input.sceneSessionEpoch,
      documentVersion: input.documentVersion,
    },
    phase: 'no_changes',
    segmentation: {
      binding: {
        sceneSessionEpoch: input.sceneSessionEpoch,
        documentVersion: input.documentVersion,
      },
      segmentKeys: [],
      narrativeBoundaries: [],
      source: 'empty_scene',
    },
    createdAtMs: now,
    updatedAtMs: now,
  };
}

export function isEmptySceneDocument(document: CurrentSceneDocument): boolean {
  return document.statements.length === 0;
}

/**
 * In-memory store for the active formal enhancement run.
 * Discarded on active-scene switch, any authoring, renderer refresh, or process exit.
 */
export class SceneEnhancementSnapshotStore {
  private snapshot: SceneEnhancementSnapshotV1 | null = null;

  get(): SceneEnhancementSnapshotV1 | null {
    return this.snapshot;
  }

  set(snapshot: SceneEnhancementSnapshotV1): void {
    this.snapshot = snapshot;
  }

  /**
   * Return the snapshot only when still bound to the current version; otherwise discard.
   */
  getIfValid(current: SceneEnhancementVersionBindingV1): SceneEnhancementSnapshotV1 | null {
    if (!this.snapshot) return null;
    if (!isSceneEnhancementSnapshotValid(this.snapshot, current)) {
      this.snapshot = null;
      return null;
    }
    return this.snapshot;
  }

  discard(_reason?: SceneEnhancementInvalidationReasonV1): void {
    this.snapshot = null;
  }

  /**
   * Invalidate when document version or session epoch advances.
   * Returns true if a snapshot was present and cleared.
   */
  invalidateIfStale(current: SceneEnhancementVersionBindingV1): boolean {
    if (!this.snapshot) return false;
    if (isSceneEnhancementSnapshotValid(this.snapshot, current)) return false;
    this.snapshot = null;
    return true;
  }
}
