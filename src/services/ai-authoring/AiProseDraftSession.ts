import {
  AI_PROSE_DRAFT_SCHEMA_VERSION,
  DEFAULT_AI_TARGET_BATCH_SIZE,
  DEFAULT_SCRIPT_READING_SPEED,
  type AiProseCharacterBindingPlanV1,
  type AiProseDraftCreationOptions,
  type AiProseDraftSession as AiProseDraftSessionModel,
  type AiProseCharacterExtractionState,
  type AiProseNormalizationTask,
  type AiProsePreview,
  type AiProseRhythmTask,
  type AiProseSegmentationState,
} from '../../api/types/ai-prose-authoring';
import type { AiProseEnhancementStateV1 } from '../../api/types/ai-prose-enhancement';
import type { SemanticAuthorReceipt } from '../../api/types/authoring';

export type DraftSession = AiProseDraftSessionModel;

export type AiProseDraftSessionErrorCode =
  | 'invalid-input'
  | 'read-only';

export class AiProseDraftSessionError extends Error {
  constructor(
    message: string,
    readonly code: AiProseDraftSessionErrorCode,
  ) {
    super(message);
    this.name = 'AiProseDraftSessionError';
  }
}

export interface DraftSessionUpdateOptions {
  now?: string;
}

export interface ApplyDraftOptions extends DraftSessionUpdateOptions {
  appliedAt?: string;
}

export function createDraft(options: AiProseDraftCreationOptions): DraftSession {
  assertSafeDraftPathSegment(options.sceneId, 'sceneId');
  const sessionId = options.sessionId ?? createSessionId();
  assertSafeDraftPathSegment(sessionId, 'sessionId');
  if (typeof options.sourceText !== 'string') {
    throw new AiProseDraftSessionError('sourceText must be a string', 'invalid-input');
  }
  if (options.anchorMode !== 'zero' && options.anchorMode !== 'playhead') {
    throw new AiProseDraftSessionError('anchorMode must be zero or playhead', 'invalid-input');
  }

  const anchorTime = options.anchorMode === 'zero'
    ? 0
    : validatePlayheadTime(options.playheadTime);
  const targetBatchSize = options.targetBatchSize ?? DEFAULT_AI_TARGET_BATCH_SIZE;
  if (!Number.isFinite(targetBatchSize) || targetBatchSize <= 0) {
    throw new AiProseDraftSessionError(
      'targetBatchSize must be a positive finite number',
      'invalid-input',
    );
  }
  const scriptReadingSpeed = options.scriptReadingSpeed ?? DEFAULT_SCRIPT_READING_SPEED;
  validateScriptReadingSpeed(scriptReadingSpeed);
  const now = options.now ?? new Date().toISOString();

  return {
    schemaVersion: AI_PROSE_DRAFT_SCHEMA_VERSION,
    sessionId,
    sceneId: options.sceneId,
    sourceText: options.sourceText,
    sourceRevision: 0,
    anchorMode: options.anchorMode,
    anchorTime,
    targetBatchSize,
    scriptReadingSpeed,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    segmentation: {
      status: 'idle',
      planFingerprint: '',
      targetSegmentCount: 1,
      candidates: [],
      boundaryIds: [],
      segments: [],
    },
    characterExtraction: {
      status: 'idle',
      suggestedNames: [],
    },
    confirmedMainCharacters: [],
    mainCharactersConfirmed: false,
    normalization: [],
    rhythm: [],
    preview: null,
    characterBindings: {},
  };
}

export function assertSafeDraftPathSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new AiProseDraftSessionError(
      `${label} must be a safe single path segment`,
      'invalid-input',
    );
  }
}

export function updateSourceText(
  draft: DraftSession,
  sourceText: string,
  options: DraftSessionUpdateOptions = {},
): DraftSession {
  assertMutable(draft);
  if (typeof sourceText !== 'string') {
    throw new AiProseDraftSessionError('sourceText must be a string', 'invalid-input');
  }
  if (sourceText === draft.sourceText) return cloneDraft(draft);

  const next = cloneDraft(draft);
  next.sourceText = sourceText;
  next.sourceRevision += 1;
  next.segmentation = createEmptySegmentationState();
  next.characterExtraction = createEmptyCharacterExtractionState();
  next.confirmedMainCharacters = [];
  next.mainCharactersConfirmed = false;
  next.normalization = [];
  next.rhythm = [];
  next.preview = null;
  next.characterBindings = {};
  next.characterBindingPlan = undefined;
  next.enhancement = undefined;
  next.updatedAt = resolveNow(options.now);
  return next;
}

export function updateMainCharacters(
  draft: DraftSession,
  names: readonly string[],
  options: DraftSessionUpdateOptions = {},
): DraftSession {
  assertMutable(draft);
  const nextNames = validateMainCharacterNames(names);
  if (sameStringList(draft.confirmedMainCharacters, nextNames)) return cloneDraft(draft);

  const next = cloneDraft(draft);
  next.confirmedMainCharacters = nextNames;
  next.mainCharactersConfirmed = false;
  next.normalization = [];
  next.rhythm = [];
  next.preview = null;
  next.characterBindings = {};
  next.characterBindingPlan = undefined;
  next.enhancement = undefined;
  next.updatedAt = resolveNow(options.now);
  return next;
}

export function confirmMainCharacters(
  draft: DraftSession,
  names: readonly string[] = draft.confirmedMainCharacters,
  options: DraftSessionUpdateOptions = {},
): DraftSession {
  const nextNames = validateMainCharacterNames(names);
  const next = sameStringList(draft.confirmedMainCharacters, nextNames)
    ? cloneDraft(draft)
    : updateMainCharacters(draft, nextNames, options);
  assertMutable(next);
  next.confirmedMainCharacters = nextNames;
  next.mainCharactersConfirmed = true;
  next.updatedAt = resolveNow(options.now);
  return next;
}

export function replaceSegmentation(
  draft: DraftSession,
  segmentation: AiProseSegmentationState,
  options: DraftSessionUpdateOptions = {},
): DraftSession {
  return replaceStage(draft, (next) => {
    next.segmentation = cloneJson(segmentation);
    clearNormalizationAndDownstream(next);
  }, options);
}

export function replaceCharacterExtraction(
  draft: DraftSession,
  characterExtraction: AiProseCharacterExtractionState,
  options: DraftSessionUpdateOptions = {},
): DraftSession {
  return replaceStage(draft, (next) => {
    next.characterExtraction = cloneJson(characterExtraction);
    clearNormalizationAndDownstream(next);
  }, options);
}

export function replaceNormalization(
  draft: DraftSession,
  normalization: readonly AiProseNormalizationTask[],
  options: DraftSessionUpdateOptions = {},
): DraftSession {
  return replaceStage(draft, (next) => {
    next.normalization = cloneJson([...normalization]);
    clearRhythmAndPreview(next);
  }, options);
}

export function updateNormalizationTask(
  draft: DraftSession,
  task: AiProseNormalizationTask,
  options: DraftSessionUpdateOptions = {},
): DraftSession {
  return replaceStage(draft, (next) => {
    const existingIndex = next.normalization.findIndex((candidate) => candidate.segmentIndex === task.segmentIndex);
    if (existingIndex === -1) next.normalization.push(cloneJson(task));
    else next.normalization[existingIndex] = cloneJson(task);
    next.normalization.sort((left, right) => left.segmentIndex - right.segmentIndex);
    clearRhythmAndPreview(next);
  }, options);
}

export function replaceRhythm(
  draft: DraftSession,
  rhythm: readonly AiProseRhythmTask[],
  options: DraftSessionUpdateOptions = {},
): DraftSession {
  return replaceStage(draft, (next) => {
    next.rhythm = cloneJson([...rhythm]);
    next.preview = null;
  }, options);
}

export function updateRhythmTask(
  draft: DraftSession,
  task: AiProseRhythmTask,
  options: DraftSessionUpdateOptions = {},
): DraftSession {
  return replaceStage(draft, (next) => {
    const existingIndex = next.rhythm.findIndex((candidate) => candidate.segmentIndex === task.segmentIndex);
    if (existingIndex === -1) next.rhythm.push(cloneJson(task));
    else next.rhythm[existingIndex] = cloneJson(task);
    next.rhythm.sort((left, right) => left.segmentIndex - right.segmentIndex);
    next.preview = null;
  }, options);
}

export function replacePreview(
  draft: DraftSession,
  preview: AiProsePreview | null,
  options: DraftSessionUpdateOptions = {},
): DraftSession {
  return replaceStage(draft, (next) => { next.preview = cloneJson(preview); }, options);
}

export function applyDraft(
  draft: DraftSession,
  receipt: SemanticAuthorReceipt,
  options: ApplyDraftOptions = {},
): DraftSession {
  assertMutable(draft);
  if (!receipt || typeof receipt !== 'object') {
    throw new AiProseDraftSessionError('A semantic authoring receipt is required', 'invalid-input');
  }
  const next = cloneDraft(draft);
  next.status = 'applied';
  next.appliedAt = options.appliedAt ?? resolveNow(options.now);
  next.receipt = cloneJson(receipt);
  next.updatedAt = resolveNow(options.now);
  return next;
}

export function setCharacterBinding(
  draft: DraftSession,
  characterName: string,
  characterId: string,
  options: DraftSessionUpdateOptions = {},
): DraftSession {
  assertMutable(draft);
  if (
    typeof characterName !== 'string'
    || typeof characterId !== 'string'
    || !characterName.trim()
    || !characterId.trim()
  ) {
    throw new AiProseDraftSessionError(
      'Character binding name and id must be non-empty strings',
      'invalid-input',
    );
  }
  return replaceStage(draft, (next) => {
    next.characterBindings[characterName] = characterId;
    // A user-selected disambiguation is authoritative input for the plan;
    // any persisted plan and enhancement results must be re-generated.
    next.characterBindingPlan = undefined;
    next.enhancement = undefined;
  }, options);
}

/**
 * Persist the character binding plan as a session fact (schema v3+).
 * Updating the plan invalidates any previously generated enhancement
 * checkpoints because their binding snapshot no longer matches.
 */
export function setCharacterBindingPlan(
  draft: DraftSession,
  plan: AiProseCharacterBindingPlanV1,
  options: DraftSessionUpdateOptions = {},
): DraftSession {
  assertMutable(draft);
  if (!plan || typeof plan !== 'object' || (plan.status !== 'ready' && plan.status !== 'ambiguous')) {
    throw new AiProseDraftSessionError('Character binding plan is invalid', 'invalid-input');
  }
  return replaceStage(draft, (next) => {
    next.characterBindingPlan = cloneJson(plan);
    next.enhancement = undefined;
  }, options);
}

/**
 * Persist the optional-enhancement checkpoint state into the draft.
 * Absent enhancement state means enhancement has not started.
 */
export function replaceEnhancementState(
  draft: DraftSession,
  state: AiProseEnhancementStateV1,
  options: DraftSessionUpdateOptions = {},
): DraftSession {
  assertMutable(draft);
  if (!state || typeof state !== 'object' || typeof state.baseFingerprint !== 'string') {
    throw new AiProseDraftSessionError('Enhancement state is invalid', 'invalid-input');
  }
  return replaceStage(draft, (next) => {
    next.enhancement = cloneJson(state);
  }, options);
}

export function clearEnhancementState(
  draft: DraftSession,
  options: DraftSessionUpdateOptions = {},
): DraftSession {
  assertMutable(draft);
  if (draft.enhancement === undefined) return cloneDraft(draft);
  return replaceStage(draft, (next) => {
    next.enhancement = undefined;
  }, options);
}

export interface DuplicateDraftOptions extends DraftSessionUpdateOptions {
  sessionId?: string;
}

/**
 * Copy an applied archive into a fresh active session. Everything reusable is
 * preserved (source text, main characters, segmentation plan, per-segment
 * results, rhythm and timing preview, binding plan and enhancement
 * checkpoints); only the applied archive fields are stripped so the copy can
 * be re-applied after optional regeneration.
 */
export function duplicateAppliedDraft(
  draft: DraftSession,
  options: DuplicateDraftOptions = {},
): DraftSession {
  if (!draft || typeof draft !== 'object') {
    throw new AiProseDraftSessionError('Applied draft session is invalid', 'invalid-input');
  }
  if (draft.status !== 'applied') {
    throw new AiProseDraftSessionError(
      'Only applied draft archives can be duplicated into a new session',
      'invalid-input',
    );
  }
  const sessionId = options.sessionId ?? createSessionId();
  assertSafeDraftPathSegment(sessionId, 'sessionId');
  const now = resolveNow(options.now);
  const next: DraftSession = cloneDraft(draft);
  next.sessionId = sessionId;
  next.status = 'active';
  next.createdAt = now;
  next.updatedAt = now;
  next.appliedAt = undefined;
  next.receipt = undefined;
  return next;
}

export function updateScriptReadingSpeed(
  draft: DraftSession,
  scriptReadingSpeed: number,
  options: DraftSessionUpdateOptions = {},
): DraftSession {
  assertMutable(draft);
  validateScriptReadingSpeed(scriptReadingSpeed);
  const next = cloneDraft(draft);
  next.scriptReadingSpeed = scriptReadingSpeed;
  next.updatedAt = resolveNow(options.now);
  return next;
}

export function updateTargetBatchSize(
  draft: DraftSession,
  targetBatchSize: number,
  options: DraftSessionUpdateOptions = {},
): DraftSession {
  assertMutable(draft);
  if (!Number.isFinite(targetBatchSize) || targetBatchSize <= 0) {
    throw new AiProseDraftSessionError(
      'targetBatchSize must be a positive finite number',
      'invalid-input',
    );
  }
  if (draft.targetBatchSize === targetBatchSize) return cloneDraft(draft);

  const next = cloneDraft(draft);
  next.targetBatchSize = targetBatchSize;
  next.segmentation = createEmptySegmentationState();
  next.characterExtraction = createEmptyCharacterExtractionState();
  next.confirmedMainCharacters = [];
  next.mainCharactersConfirmed = false;
  next.normalization = [];
  next.rhythm = [];
  next.preview = null;
  next.characterBindings = {};
  next.characterBindingPlan = undefined;
  next.enhancement = undefined;
  next.updatedAt = resolveNow(options.now);
  return next;
}

function replaceStage(
  draft: DraftSession,
  apply: (next: DraftSession) => void,
  options: DraftSessionUpdateOptions,
): DraftSession {
  assertMutable(draft);
  const next = cloneDraft(draft);
  apply(next);
  next.updatedAt = resolveNow(options.now);
  return next;
}

function clearNormalizationAndDownstream(next: DraftSession): void {
  next.normalization = [];
  next.rhythm = [];
  next.preview = null;
  // Segmentation / extraction changes alter the enhancement baseline fingerprint.
  next.enhancement = undefined;
}

function clearRhythmAndPreview(next: DraftSession): void {
  next.rhythm = [];
  next.preview = null;
  next.enhancement = undefined;
}

function assertMutable(draft: DraftSession): void {
  if (draft.status === 'applied') {
    throw new AiProseDraftSessionError('Applied draft sessions are read-only', 'read-only');
  }
}

function createEmptySegmentationState(): AiProseSegmentationState {
  return {
    status: 'idle',
    planFingerprint: '',
    targetSegmentCount: 1,
    candidates: [],
    boundaryIds: [],
    segments: [],
  };
}

function createEmptyCharacterExtractionState(): AiProseCharacterExtractionState {
  return { status: 'idle', suggestedNames: [] };
}

function validateMainCharacterNames(names: readonly string[]): string[] {
  if (!Array.isArray(names)) {
    throw new AiProseDraftSessionError('Main characters must be an array', 'invalid-input');
  }
  const seen = new Set<string>();
  return names.map((name) => {
    if (typeof name !== 'string' || !name.trim()) {
      throw new AiProseDraftSessionError('Main character names must be non-empty strings', 'invalid-input');
    }
    if (seen.has(name)) {
      throw new AiProseDraftSessionError(`Duplicate main character name: ${name}`, 'invalid-input');
    }
    seen.add(name);
    return name;
  });
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function resolveNow(now: string | undefined): string {
  return now ?? new Date().toISOString();
}

function cloneDraft(draft: DraftSession): DraftSession {
  return cloneJson(draft);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validatePlayheadTime(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new AiProseDraftSessionError(
      'playheadTime must be a non-negative finite number',
      'invalid-input',
    );
  }
  return value;
}

function validateScriptReadingSpeed(value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new AiProseDraftSessionError(
      'scriptReadingSpeed must be a positive finite number',
      'invalid-input',
    );
  }
}

function createSessionId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export const createAiProseDraftSession = createDraft;
export const setSourceText = updateSourceText;
export const setMainCharacters = updateMainCharacters;
export const markApplied = applyDraft;
export const updateSegmentation = replaceSegmentation;
export const updateCharacterExtraction = replaceCharacterExtraction;
export const updateNormalization = replaceNormalization;
export const updateRhythm = replaceRhythm;
export const updatePreview = replacePreview;
export const setScriptReadingSpeed = updateScriptReadingSpeed;
export const duplicateAppliedArchive = duplicateAppliedDraft;
