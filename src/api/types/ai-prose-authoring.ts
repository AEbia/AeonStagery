import type { SemanticAuthorReceipt } from './authoring';
import type { AiProseEnhancementStateV1 } from './ai-prose-enhancement';

export const AI_PROSE_DRAFT_SCHEMA_VERSION = 3 as const;
export const DEFAULT_AI_TARGET_BATCH_SIZE = 3000;
export const DEFAULT_MAX_CONCURRENT_AI_REQUESTS = 2;
export const DEFAULT_AI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_AI_MODEL = 'gpt-4o-mini';
export const AI_PROSE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AiProseEffort = typeof AI_PROSE_EFFORTS[number];
export const DEFAULT_AI_EFFORT: AiProseEffort = 'medium';
export const SCRIPT_READING_SPEED_RANGE = {
  min: 1,
  max: 20,
  step: 0.5,
} as const;
export const DEFAULT_SCRIPT_READING_SPEED = 9;
export const DEFAULT_STORY_SEGMENT_GAP_SECONDS = 0.5;
export const DEFAULT_BASELINE_GAP_SECONDS = 0.35;
export const MIN_RHYTHM_GAP_SECONDS = 0.25;
export const MAX_RHYTHM_GAP_SECONDS = 0.75;
export const AI_PROSE_BLOCK_TARGET_VISIBLE_CHARACTERS = 90;

export const AI_PROSE_STAGES = [
  'segmentation',
  'characterExtraction',
  'normalization',
  'rhythm',
  'acting',
  'cinematic',
] as const;
export type AiProseStage = typeof AI_PROSE_STAGES[number];

/** Core prose-normalization stages (exclude optional enhancement). */
export const AI_PROSE_CORE_STAGES = [
  'segmentation',
  'characterExtraction',
  'normalization',
  'rhythm',
] as const satisfies readonly AiProseStage[];

/** Optional performance / cinematic enhancement stages. */
export const AI_PROSE_ENHANCEMENT_STAGES = [
  'acting',
  'cinematic',
] as const satisfies readonly AiProseStage[];

export type AiProseTaskStatus = 'idle' | 'running' | 'succeeded' | 'failed';
export type AiProseDraftStatus = 'active' | 'applied';
export type AiProseAnchorMode = 'zero' | 'playhead';

export interface AiProseTaskError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface AiProseCanonicalStatement {
  speaker: string;
  text: string;
}

export type AiProseBoundaryKind = 'line' | 'long-line-sentence';

export interface AiProseBoundaryCandidate {
  id: string;
  kind: AiProseBoundaryKind;
  lineNumber: number;
  position: number;
}

export interface AiProseStorySegment {
  index: number;
  startOffset: number;
  endOffset: number;
  sourceText: string;
  startBoundaryId?: string;
  endBoundaryId?: string;
}

export interface AiProseSegmentationState {
  status: AiProseTaskStatus;
  planFingerprint: string;
  targetSegmentCount: number;
  candidates: AiProseBoundaryCandidate[];
  boundaryIds: string[];
  segments: AiProseStorySegment[];
  error?: AiProseTaskError;
}

export interface AiProseCharacterExtractionState {
  status: AiProseTaskStatus;
  suggestedNames: string[];
  error?: AiProseTaskError;
}

export interface AiProseNormalizationTask {
  segmentIndex: number;
  status: AiProseTaskStatus;
  statements: AiProseCanonicalStatement[];
  error?: AiProseTaskError;
}

export interface AiProseRhythmTask {
  segmentIndex: number;
  status: AiProseTaskStatus;
  gapSeconds: number[];
  usedFallback?: boolean;
  error?: AiProseTaskError;
}

export interface AiProseTimedStatement extends AiProseCanonicalStatement {
  segmentIndex: number;
  statementIndex: number;
  time: number;
  durationSeconds: number;
  gapSecondsToNext: number;
}

export interface AiProsePreview {
  statements: AiProseTimedStatement[];
  anchorTime: number;
  durationSeconds: number;
}

export interface AiProseDraftSession {
  schemaVersion: typeof AI_PROSE_DRAFT_SCHEMA_VERSION;
  sessionId: string;
  sceneId: string;
  sourceText: string;
  sourceRevision: number;
  anchorMode: AiProseAnchorMode;
  anchorTime: number;
  targetBatchSize: number;
  scriptReadingSpeed: number;
  status: AiProseDraftStatus;
  createdAt: string;
  updatedAt: string;
  segmentation: AiProseSegmentationState;
  characterExtraction: AiProseCharacterExtractionState;
  confirmedMainCharacters: string[];
  mainCharactersConfirmed: boolean;
  normalization: AiProseNormalizationTask[];
  rhythm: AiProseRhythmTask[];
  preview: AiProsePreview | null;
  characterBindings: Record<string, string>;
  /**
   * Persisted character binding plan (v3+). Absent until the host generates
   * a plan for binding/enhancement; never guessed by migration or load.
   */
  characterBindingPlan?: AiProseCharacterBindingPlanV1;
  /**
   * Persisted optional enhancement checkpoint state (v3+). Absent / unset
   * means enhancement has not started for this draft.
   */
  enhancement?: AiProseEnhancementStateV1;
  appliedAt?: string;
  receipt?: SemanticAuthorReceipt;
}

/**
 * Persisted JSON shape of the character binding plan (ADR-0022). Reuses the
 * same-domain keys as `CharacterBindingPlanV1` in the ai-authoring service so
 * service values can be stored and restored without re-generation.
 */
export type AiProseCharacterBindingSourceV1 =
  | 'existing_unique'
  | 'preallocated'
  | 'user_disambiguation';

export interface AiProseCharacterBindingEntryV1 {
  name: string;
  speakerId: string;
  source: AiProseCharacterBindingSourceV1;
}

export interface AiProseCharacterBindingAmbiguityV1 {
  name: string;
  candidateIds: string[];
}

export type AiProseCharacterBindingPlanV1 =
  | {
      status: 'ready';
      bindings: Record<string, AiProseCharacterBindingEntryV1>;
      preallocatedCharacterIds: string[];
      ambiguous?: never;
    }
  | {
      status: 'ambiguous';
      bindings: Record<string, AiProseCharacterBindingEntryV1>;
      ambiguous: AiProseCharacterBindingAmbiguityV1[];
      preallocatedCharacterIds: string[];
    };

export interface AiProseProviderConfig {
  endpoint: string;
  defaultModel: string;
  modelOverrides?: Partial<Record<AiProseStage, string>>;
  /** Optional project-agent model; unset inherits defaultModel. */
  projectAgentModel?: string;
  jsonOutputSupported?: boolean;
}

export interface AiProseRequestSettings {
  targetBatchSize: number;
  maxConcurrentAiRequests: number;
  effort?: AiProseEffort;
}

export interface AiProseStageModelConfig {
  /** The ADR-0022 stage this resolved model serves (ADR-0022 probe threading). */
  stage: AiProseStage;
  endpoint: string;
  model: string;
  jsonOutputSupported: boolean;
}

export interface AiProseCapabilityProbeRequest {
  endpoint: string;
  model: string;
  /**
   * Stage the probe exercises. Legacy renderers omit it; the main process
   * defaults to `segmentation`.
   */
  stage?: AiProseStage;
}

export interface AiProseModelCapabilities {
  jsonOutputSupported: boolean;
  /** Provider/model metadata only; absent when the provider does not report it. */
  contextWindow?: number;
}

export interface AiProseModelMetadata {
  /** Provider/model metadata only; absent when the provider does not report it. */
  contextWindow?: number;
}

export interface AiProseModelListResult {
  success: boolean;
  models: string[];
  /** Optional metadata keyed by the model id returned in `models`. */
  modelMetadata?: Record<string, AiProseModelMetadata>;
  error?: string;
}

export interface AiProseModelCapabilityState extends AiProseModelCapabilities {
  endpoint: string;
  model: string;
}

export interface AiProseCapabilityProbe {
  probe(request: AiProseCapabilityProbeRequest): Promise<AiProseModelCapabilities>;
}

export interface AiProseCredentialStatus {
  configured: boolean;
}

export interface AiProseCredentialPort {
  getStatus(): AiProseCredentialStatus;
  setCredential(value: string): void;
  clearCredential(): void;
}

export interface AiProseDraftCreationOptions {
  sceneId: string;
  sessionId?: string;
  sourceText: string;
  anchorMode: AiProseAnchorMode;
  playheadTime?: number;
  targetBatchSize?: number;
  scriptReadingSpeed?: number;
  now?: string;
}
