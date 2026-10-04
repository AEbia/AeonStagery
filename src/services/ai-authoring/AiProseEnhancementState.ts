import {
  AI_PROSE_ENHANCEMENT_STATE_VERSION,
  type AiProseEnhancementStateV1,
  type AiProseEnhancementStageCheckpointV1,
  type AiProseEnhancementStageKind,
  type AiProseEnhancementStageStatusV1,
  type AiProseEnhancementUnitCheckpointV1,
} from '../../api/types/ai-prose-enhancement';
import type { DraftSession } from './AiProseDraftSession';

/**
 * Deterministic fingerprint of the draft baseline an enhancement run is bound
 * to. Any change (source text, revision, segmentation plan, confirmed main
 * characters, anchor or reading config) invalidates persisted enhancement
 * checkpoints without requiring a full scene copy.
 */
export function createAiProseEnhancementBaseFingerprint(
  draft: Pick<
    DraftSession,
    | 'sourceText'
    | 'sourceRevision'
    | 'segmentation'
    | 'confirmedMainCharacters'
    | 'mainCharactersConfirmed'
    | 'anchorTime'
    | 'targetBatchSize'
    | 'scriptReadingSpeed'
  >,
): string {
  const payload = JSON.stringify({
    sourceText: draft.sourceText,
    sourceRevision: draft.sourceRevision,
    segmentationFingerprint: draft.segmentation.planFingerprint,
    confirmedMainCharacters: draft.confirmedMainCharacters,
    mainCharactersConfirmed: draft.mainCharactersConfirmed,
    anchorTime: draft.anchorTime,
    targetBatchSize: draft.targetBatchSize,
    scriptReadingSpeed: draft.scriptReadingSpeed,
  });
  let hash = 2166136261;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const mixed = (hash ^ payload.length) >>> 0;
  return `${hash.toString(16).padStart(8, '0')}${mixed.toString(16).padStart(8, '0')}`;
}

/** True when the state's baseline fingerprint matches the current draft. */
export function enhancementStateMatchesBaseline(
  state: AiProseEnhancementStateV1,
  draft: Parameters<typeof createAiProseEnhancementBaseFingerprint>[0],
): boolean {
  return state.baseFingerprint === createAiProseEnhancementBaseFingerprint(draft);
}

export function createEmptyEnhancementStageCheckpoint(
  stage: AiProseEnhancementStageKind,
): AiProseEnhancementStageCheckpointV1 {
  return { stage, status: 'idle', units: [] };
}

export function createEmptyEnhancementState(
  draft: Parameters<typeof createAiProseEnhancementBaseFingerprint>[0],
): AiProseEnhancementStateV1 {
  return {
    version: AI_PROSE_ENHANCEMENT_STATE_VERSION,
    baseFingerprint: createAiProseEnhancementBaseFingerprint(draft),
  };
}

export function cloneEnhancementState(
  state: AiProseEnhancementStateV1,
): AiProseEnhancementStateV1 {
  return JSON.parse(JSON.stringify(state)) as AiProseEnhancementStateV1;
}

export function withEnhancementStageCheckpoint(
  state: AiProseEnhancementStateV1,
  checkpoint: AiProseEnhancementStageCheckpointV1,
): AiProseEnhancementStateV1 {
  return {
    ...state,
    [checkpoint.stage]: checkpoint,
  };
}

/**
 * Bind an enhancement run to the DocumentStore version it authored line
 * locators against. Absence keeps the state unbound (backward compatible).
 */
export function withEnhancementBoundDocumentVersion(
  state: AiProseEnhancementStateV1,
  version: number,
): AiProseEnhancementStateV1 {
  return { ...state, boundDocumentVersion: version };
}

/**
 * Normalize a persisted stage checkpoint for restore: a stage whose persisted
 * status is `running` (all units finished or none yet) or that still holds
 * `running` units becomes `retryableFailed` with an `interrupted` diagnostic —
 * a running stage can never survive a process restart. Succeeded units and
 * their patches stay intact.
 */
export function normalizeRestoredStageCheckpoint(
  checkpoint: AiProseEnhancementStageCheckpointV1,
): AiProseEnhancementStageCheckpointV1 {
  const units = checkpoint.units.map(normalizeRestoredUnit);
  const interrupted = checkpoint.status === 'running'
    || checkpoint.units.some((unit) => unit.status === 'running');
  const status: AiProseEnhancementStageStatusV1 = interrupted
    ? 'retryableFailed'
    : checkpoint.status;
  if (!interrupted) return { ...checkpoint, status, units };
  return {
    ...checkpoint,
    status,
    units,
    diagnostics: [
      ...(checkpoint.diagnostics ?? []).filter((item) => item.code !== 'interrupted'),
      { code: 'interrupted', message: 'Enhancement stage was interrupted and restarted' },
    ],
  };
}

function normalizeRestoredUnit(
  unit: AiProseEnhancementUnitCheckpointV1,
): AiProseEnhancementUnitCheckpointV1 {
  if (unit.status !== 'running') return unit;
  return {
    ...unit,
    status: 'retryableFailed',
    patch: undefined,
    diagnostics: [
      ...(unit.diagnostics ?? []),
      { code: 'interrupted', message: 'Enhancement unit was interrupted and restarted' },
    ],
  };
}
