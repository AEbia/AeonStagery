import type { SemanticScenePatchV1 } from './semantic-scene-patch';
import type { AiProseCharacterBindingPlanV1 } from './ai-prose-authoring';

/**
 * Versioned optional-enhancement checkpoint state persisted inside the AI
 * prose draft session (ADR-0022). Only typed results are kept — never full
 * prompts, raw LLM/provider responses, whole candidate scenes, internal
 * statement/companion UUIDs or a persistent line map.
 */
export const AI_PROSE_ENHANCEMENT_STATE_VERSION = 1 as const;

export type AiProseEnhancementStateVersion = typeof AI_PROSE_ENHANCEMENT_STATE_VERSION;

export type AiProseEnhancementStageKind = 'performance' | 'cinematic';

export type AiProseEnhancementUnitStatusV1 =
  | 'idle'
  | 'running'
  | 'succeeded'
  | 'retryableFailed'
  | 'failed';

export type AiProseEnhancementStageStatusV1 =
  | 'idle'
  | 'running'
  | 'succeeded'
  | 'retryableFailed'
  | 'failed';

export interface AiProseEnhancementUsageV1 {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
}

export interface AiProseEnhancementDiagnosticV1 {
  code: string;
  message: string;
}

export interface AiProseEnhancementUnitCheckpointV1 {
  /** Stable processing-unit key (narrative segment or technical split). */
  key: string;
  stage: AiProseEnhancementStageKind;
  status: AiProseEnhancementUnitStatusV1;
  /** Locally validated SemanticScenePatchV1 (absent until succeeded). */
  patch?: SemanticScenePatchV1;
  diagnostics?: readonly AiProseEnhancementDiagnosticV1[];
  attemptCount: number;
  policyVersion: string;
  processorVersion: string;
  inputFingerprint?: string;
  /** Informative token usage, never required for replay. */
  usage?: AiProseEnhancementUsageV1;
  /** Informative generation model name only. */
  modelName?: string;
  /**
   * Read-only line-view context budget the unit's input fingerprint was
   * computed with. Persisted so restore replay recomputes the fingerprint
   * with the same budget regardless of the runtime configuration.
   */
  lineViewContextChars?: number;
}

export interface AiProseEnhancementStageCheckpointV1 {
  stage: AiProseEnhancementStageKind;
  status: AiProseEnhancementStageStatusV1;
  units: readonly AiProseEnhancementUnitCheckpointV1[];
  diagnostics?: readonly AiProseEnhancementDiagnosticV1[];
}

export interface AiProseEnhancementStateV1 {
  version: AiProseEnhancementStateVersion;
  /** Deterministic baseline fingerprint (source, revision, segmentation, characters, anchor). */
  baseFingerprint: string;
  /** Binding plan snapshot used for this enhancement run; restore re-checks it. */
  characterBindingPlan?: AiProseCharacterBindingPlanV1;
  /**
   * DocumentStore version the enhancement run authored line locators against.
   * Absent = unbound (backward compatible); when present, apply/restore refuse
   * the stale results after any scene edit.
   */
  boundDocumentVersion?: number;
  performance?: AiProseEnhancementStageCheckpointV1;
  cinematic?: AiProseEnhancementStageCheckpointV1;
}
