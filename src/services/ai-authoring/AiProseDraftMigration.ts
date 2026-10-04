import {
  AI_PROSE_DRAFT_SCHEMA_VERSION,
  DEFAULT_AI_TARGET_BATCH_SIZE,
  DEFAULT_SCRIPT_READING_SPEED,
  type AiProseBoundaryCandidate,
  type AiProseCharacterExtractionState,
  type AiProseCanonicalStatement,
  type AiProseCharacterBindingEntryV1,
  type AiProseCharacterBindingPlanV1,
  type AiProseDraftSession,
  type AiProseNormalizationTask,
  type AiProsePreview,
  type AiProseRhythmTask,
  type AiProseSegmentationState,
  type AiProseStorySegment,
  type AiProseTaskError,
  type AiProseTaskStatus,
  type AiProseTimedStatement,
} from '../../api/types/ai-prose-authoring';
import {
  AI_PROSE_ENHANCEMENT_STATE_VERSION,
  type AiProseEnhancementDiagnosticV1,
  type AiProseEnhancementStageCheckpointV1,
  type AiProseEnhancementStateV1,
  type AiProseEnhancementUnitCheckpointV1,
} from '../../api/types/ai-prose-enhancement';
import { createAiProseSegmentationFingerprintFromState } from './AiProseSegmentation';
import { parseSemanticScenePatch } from '../semantic-scene/SemanticScenePatch';

const CURRENT_SCHEMA_VERSION = AI_PROSE_DRAFT_SCHEMA_VERSION;
const LEGACY_SCHEMA_VERSION = 0;
const PREVIOUS_SCHEMA_VERSION = 2;
const STATUS_VALUES = new Set<AiProseTaskStatus>(['idle', 'running', 'succeeded', 'failed']);

export type AiProseDraftMigrationErrorCode =
  | 'future-schema'
  | 'unsupported-schema'
  | 'invalid-structure';

export class AiProseDraftMigrationError extends Error {
  constructor(
    message: string,
    readonly code: AiProseDraftMigrationErrorCode,
    readonly path?: string,
  ) {
    super(message);
    this.name = 'AiProseDraftMigrationError';
  }
}

export function migrateDraft(input: unknown): AiProseDraftSession {
  const root = expectRecord(input, 'draft');
  const version = expectSchemaVersion(root.schemaVersion);

  if (version > CURRENT_SCHEMA_VERSION) {
    throw new AiProseDraftMigrationError(
      `Draft schema version ${version} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
      'future-schema',
      'draft.schemaVersion',
    );
  }
  if (version === LEGACY_SCHEMA_VERSION) return migrateLegacyDraft(root);
  if (version === 1) return migrateV1Draft(root);
  if (version === PREVIOUS_SCHEMA_VERSION) return migratePreviousDraft(root);
  if (version !== CURRENT_SCHEMA_VERSION) {
    throw new AiProseDraftMigrationError(
      `Draft schema version ${version} is not supported`,
      'unsupported-schema',
      'draft.schemaVersion',
    );
  }
  return parseCurrentDraft(root);
}

export const migrateAiProseDraft = migrateDraft;

export function isSafeDraftPathSegment(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/**
 * Enhancement unit keys live only inside the checkpoint JSON (map keys); they
 * never form file paths, so technical-split keys like `seg-0#t1` are allowed.
 */
function isSafeEnhancementUnitKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_#-]{1,128}$/.test(value);
}

function migrateLegacyDraft(root: JsonRecord): AiProseDraftSession {
  const normalized: JsonRecord = { ...root };
  delete normalized.mainCharacters;
  normalized.schemaVersion = CURRENT_SCHEMA_VERSION;
  setLegacyDefault(normalized, 'sourceRevision', 0);
  setLegacyDefault(normalized, 'targetBatchSize', DEFAULT_AI_TARGET_BATCH_SIZE);
  setLegacyDefault(normalized, 'scriptReadingSpeed', DEFAULT_SCRIPT_READING_SPEED);
  setLegacyDefault(normalized, 'segmentation', createEmptySegmentation());
  setLegacyDefault(normalized, 'characterExtraction', createEmptyCharacterExtraction());
  if (!Object.prototype.hasOwnProperty.call(normalized, 'confirmedMainCharacters')) {
    normalized.confirmedMainCharacters = Object.prototype.hasOwnProperty.call(root, 'mainCharacters')
      ? root.mainCharacters
      : [];
  }
  setLegacyDefault(normalized, 'mainCharactersConfirmed', false);
  setLegacyDefault(normalized, 'normalization', []);
  setLegacyDefault(normalized, 'rhythm', []);
  setLegacyDefault(normalized, 'preview', null);
  setLegacyDefault(normalized, 'characterBindings', {});
  if (normalized.anchorMode === 'zero' && !Object.prototype.hasOwnProperty.call(normalized, 'anchorTime')) {
    normalized.anchorTime = 0;
  }
  ensurePlanFingerprint(normalized);
  return parseCurrentDraft(normalized);
}

function migrateV1Draft(root: JsonRecord): AiProseDraftSession {
  const normalized: JsonRecord = { ...root, schemaVersion: CURRENT_SCHEMA_VERSION };
  setLegacyDefault(normalized, 'scriptReadingSpeed', DEFAULT_SCRIPT_READING_SPEED);
  ensurePlanFingerprint(normalized);
  return parseCurrentDraft(normalized);
}

function migratePreviousDraft(root: JsonRecord): AiProseDraftSession {
  // v2 → v3 is purely additive: the new plan and enhancement slots are
  // uninitialized (absent) — no binding conclusions are invented, and an old
  // active draft entering the binding/enhancement step still generates a plan.
  const normalized: JsonRecord = { ...root, schemaVersion: CURRENT_SCHEMA_VERSION };
  return parseCurrentDraft(normalized);
}

function parseCurrentDraft(root: JsonRecord): AiProseDraftSession {
  expectKeys(root, [
    'schemaVersion',
    'sessionId',
    'sceneId',
    'sourceText',
    'sourceRevision',
    'anchorMode',
    'anchorTime',
    'targetBatchSize',
    'scriptReadingSpeed',
    'status',
    'createdAt',
    'updatedAt',
    'segmentation',
    'characterExtraction',
    'confirmedMainCharacters',
    'mainCharactersConfirmed',
    'normalization',
    'rhythm',
    'preview',
    'characterBindings',
    'appliedAt',
    'receipt',
    'characterBindingPlan',
    'enhancement',
  ], 'draft', ['appliedAt', 'receipt', 'characterBindingPlan', 'enhancement']);

  if (root.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw invalid('draft.schemaVersion', `Expected schemaVersion ${CURRENT_SCHEMA_VERSION}`);
  }
  const sessionId = expectString(root.sessionId, 'draft.sessionId');
  const sceneId = expectString(root.sceneId, 'draft.sceneId');
  if (!isSafeDraftPathSegment(sessionId)) invalid('draft.sessionId', 'Must be a safe single path segment');
  if (!isSafeDraftPathSegment(sceneId)) invalid('draft.sceneId', 'Must be a safe single path segment');

  const sourceText = expectString(root.sourceText, 'draft.sourceText', true);
  const sourceRevision = expectIntegerAtLeast(root.sourceRevision, 'draft.sourceRevision', 0);
  const anchorMode = expectOneOf(root.anchorMode, 'draft.anchorMode', ['zero', 'playhead'] as const);
  const anchorTime = expectFiniteAtLeast(root.anchorTime, 'draft.anchorTime', 0);
  if (anchorMode === 'zero' && anchorTime !== 0) {
    invalid('draft.anchorTime', 'Zero anchored drafts must use anchorTime 0');
  }
  const targetBatchSize = expectFiniteGreaterThan(root.targetBatchSize, 'draft.targetBatchSize', 0);
  const scriptReadingSpeed = expectFiniteGreaterThan(root.scriptReadingSpeed, 'draft.scriptReadingSpeed', 0);
  const status = expectOneOf(root.status, 'draft.status', ['active', 'applied'] as const);
  const createdAt = expectString(root.createdAt, 'draft.createdAt');
  const updatedAt = expectString(root.updatedAt, 'draft.updatedAt');
  const segmentation = parseSegmentation(root.segmentation, 'draft.segmentation');
  const characterExtraction = parseCharacterExtraction(root.characterExtraction, 'draft.characterExtraction');
  const confirmedMainCharacters = parseStringList(root.confirmedMainCharacters, 'draft.confirmedMainCharacters');
  const mainCharactersConfirmed = expectBoolean(root.mainCharactersConfirmed, 'draft.mainCharactersConfirmed');
  const normalization = parseNormalization(root.normalization, 'draft.normalization');
  const rhythm = parseRhythm(root.rhythm, 'draft.rhythm');
  const preview = root.preview === null ? null : parsePreview(root.preview, 'draft.preview');
  const characterBindings = parseBindings(root.characterBindings, 'draft.characterBindings');
  const appliedAt = root.appliedAt === undefined
    ? undefined
    : expectString(root.appliedAt, 'draft.appliedAt');
  const receipt = root.receipt === undefined ? undefined : parseReceipt(root.receipt, 'draft.receipt');
  const characterBindingPlan = root.characterBindingPlan === undefined
    ? undefined
    : parseCharacterBindingPlan(root.characterBindingPlan, 'draft.characterBindingPlan');
  const enhancement = root.enhancement === undefined
    ? undefined
    : parseEnhancementState(root.enhancement, 'draft.enhancement');

  if (status === 'applied' && (!appliedAt || !receipt)) {
    invalid('draft', 'Applied drafts must contain appliedAt and receipt');
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    sessionId,
    sceneId,
    sourceText,
    sourceRevision,
    anchorMode,
    anchorTime,
    targetBatchSize,
    scriptReadingSpeed,
    status,
    createdAt,
    updatedAt,
    segmentation,
    characterExtraction,
    confirmedMainCharacters,
    mainCharactersConfirmed,
    normalization,
    rhythm,
    preview,
    characterBindings,
    ...(appliedAt === undefined ? {} : { appliedAt }),
    ...(receipt === undefined ? {} : { receipt }),
    ...(characterBindingPlan === undefined ? {} : { characterBindingPlan }),
    ...(enhancement === undefined ? {} : { enhancement }),
  };
}

function parseSegmentation(input: unknown, path: string): AiProseSegmentationState {
  const root = expectRecord(input, path);
  expectKeys(root, ['status', 'planFingerprint', 'targetSegmentCount', 'candidates', 'boundaryIds', 'segments', 'error'], path, ['error']);
  const boundaryIds = parseStringList(root.boundaryIds, `${path}.boundaryIds`);
  if (new Set(boundaryIds).size !== boundaryIds.length) invalid(`${path}.boundaryIds`, 'Values must be unique');
  return {
    status: parseTaskStatus(root.status, `${path}.status`),
    planFingerprint: expectString(root.planFingerprint, `${path}.planFingerprint`, true),
    targetSegmentCount: expectIntegerAtLeast(root.targetSegmentCount, `${path}.targetSegmentCount`, 1),
    candidates: parseCandidates(root.candidates, `${path}.candidates`),
    boundaryIds,
    segments: parseSegments(root.segments, `${path}.segments`),
    ...parseOptionalError(root.error, `${path}.error`),
  };
}

function parseCandidates(input: unknown, path: string): AiProseBoundaryCandidate[] {
  if (!Array.isArray(input)) invalid(path, 'Expected an array');
  return input.map((item, index) => {
    const root = expectRecord(item, `${path}[${index}]`);
    expectKeys(root, ['id', 'kind', 'lineNumber', 'position'], `${path}[${index}]`);
    return {
      id: expectString(root.id, `${path}[${index}].id`),
      kind: expectOneOf(root.kind, `${path}[${index}].kind`, ['line', 'long-line-sentence'] as const),
      lineNumber: expectIntegerAtLeast(root.lineNumber, `${path}[${index}].lineNumber`, 1),
      position: expectIntegerAtLeast(root.position, `${path}[${index}].position`, 0),
    };
  });
}

function parseSegments(input: unknown, path: string): AiProseStorySegment[] {
  if (!Array.isArray(input)) invalid(path, 'Expected an array');
  return input.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const root = expectRecord(item, itemPath);
    expectKeys(root, ['index', 'startOffset', 'endOffset', 'sourceText', 'startBoundaryId', 'endBoundaryId'], itemPath, [
      'startBoundaryId',
      'endBoundaryId',
    ]);
    const startOffset = expectIntegerAtLeast(root.startOffset, `${itemPath}.startOffset`, 0);
    const endOffset = expectIntegerAtLeast(root.endOffset, `${itemPath}.endOffset`, startOffset);
    return {
      index: expectIntegerAtLeast(root.index, `${itemPath}.index`, 0),
      startOffset,
      endOffset,
      sourceText: expectString(root.sourceText, `${itemPath}.sourceText`, true),
      ...optionalString(root.startBoundaryId, `${itemPath}.startBoundaryId`),
      ...optionalString(root.endBoundaryId, `${itemPath}.endBoundaryId`),
    };
  });
}

function parseCharacterExtraction(input: unknown, path: string): AiProseCharacterExtractionState {
  const root = expectRecord(input, path);
  expectKeys(root, ['status', 'suggestedNames', 'error'], path, ['error']);
  const suggestedNames = parseStringList(root.suggestedNames, `${path}.suggestedNames`);
  if (new Set(suggestedNames).size !== suggestedNames.length) invalid(`${path}.suggestedNames`, 'Values must be unique');
  return {
    status: parseTaskStatus(root.status, `${path}.status`),
    suggestedNames,
    ...parseOptionalError(root.error, `${path}.error`),
  };
}

function parseNormalization(input: unknown, path: string): AiProseNormalizationTask[] {
  if (!Array.isArray(input)) invalid(path, 'Expected an array');
  const seen = new Set<number>();
  return input.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const root = expectRecord(item, itemPath);
    expectKeys(root, ['segmentIndex', 'status', 'statements', 'error'], itemPath, ['error']);
    const segmentIndex = expectIntegerAtLeast(root.segmentIndex, `${itemPath}.segmentIndex`, 0);
    if (seen.has(segmentIndex)) invalid(`${itemPath}.segmentIndex`, 'Segment indexes must be unique');
    seen.add(segmentIndex);
    return {
      segmentIndex,
      status: parseTaskStatus(root.status, `${itemPath}.status`),
      statements: parseCanonicalStatements(root.statements, `${itemPath}.statements`),
      ...parseOptionalError(root.error, `${itemPath}.error`),
    };
  });
}

function parseRhythm(input: unknown, path: string): AiProseRhythmTask[] {
  if (!Array.isArray(input)) invalid(path, 'Expected an array');
  const seen = new Set<number>();
  return input.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const root = expectRecord(item, itemPath);
    expectKeys(root, ['segmentIndex', 'status', 'gapSeconds', 'usedFallback', 'error'], itemPath, ['usedFallback', 'error']);
    const segmentIndex = expectIntegerAtLeast(root.segmentIndex, `${itemPath}.segmentIndex`, 0);
    if (seen.has(segmentIndex)) invalid(`${itemPath}.segmentIndex`, 'Segment indexes must be unique');
    seen.add(segmentIndex);
    if (!Array.isArray(root.gapSeconds)) invalid(`${itemPath}.gapSeconds`, 'Expected an array');
    const gapSeconds = root.gapSeconds.map((value, gapIndex) => (
      expectFiniteGreaterThan(value, `${itemPath}.gapSeconds[${gapIndex}]`, 0)
    ));
    return {
      segmentIndex,
      status: parseTaskStatus(root.status, `${itemPath}.status`),
      gapSeconds,
      ...optionalBoolean(root.usedFallback, `${itemPath}.usedFallback`),
      ...parseOptionalError(root.error, `${itemPath}.error`),
    };
  });
}

function parseCanonicalStatements(input: unknown, path: string): AiProseCanonicalStatement[] {
  if (!Array.isArray(input)) invalid(path, 'Expected an array');
  return input.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const root = expectRecord(item, itemPath);
    expectKeys(root, ['speaker', 'text'], itemPath);
    return {
      speaker: expectString(root.speaker, `${itemPath}.speaker`, true),
      text: expectString(root.text, `${itemPath}.text`),
    };
  });
}

function parsePreview(input: unknown, path: string): AiProsePreview {
  const root = expectRecord(input, path);
  expectKeys(root, ['statements', 'anchorTime', 'durationSeconds'], path);
  return {
    statements: parseTimedStatements(root.statements, `${path}.statements`),
    anchorTime: expectFiniteAtLeast(root.anchorTime, `${path}.anchorTime`, 0),
    durationSeconds: expectFiniteAtLeast(root.durationSeconds, `${path}.durationSeconds`, 0),
  };
}

function parseTimedStatements(input: unknown, path: string): AiProseTimedStatement[] {
  if (!Array.isArray(input)) invalid(path, 'Expected an array');
  return input.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const root = expectRecord(item, itemPath);
    expectKeys(root, [
      'speaker',
      'text',
      'segmentIndex',
      'statementIndex',
      'time',
      'durationSeconds',
      'gapSecondsToNext',
    ], itemPath);
    return {
      speaker: expectString(root.speaker, `${itemPath}.speaker`, true),
      text: expectString(root.text, `${itemPath}.text`),
      segmentIndex: expectIntegerAtLeast(root.segmentIndex, `${itemPath}.segmentIndex`, 0),
      statementIndex: expectIntegerAtLeast(root.statementIndex, `${itemPath}.statementIndex`, 0),
      time: expectFiniteAtLeast(root.time, `${itemPath}.time`, 0),
      durationSeconds: expectFiniteAtLeast(root.durationSeconds, `${itemPath}.durationSeconds`, 0),
      gapSecondsToNext: expectFiniteAtLeast(root.gapSecondsToNext, `${itemPath}.gapSecondsToNext`, 0),
    };
  });
}

function parseBindings(input: unknown, path: string): Record<string, string> {
  const root = expectRecord(input, path);
  return Object.fromEntries(Object.entries(root).map(([name, value]) => [
    name,
    expectString(value, `${path}.${name}`),
  ]));
}

function parseCharacterBindingPlan(input: unknown, path: string): AiProseCharacterBindingPlanV1 {
  const root = expectRecord(input, path);
  expectKeys(root, ['status', 'bindings', 'preallocatedCharacterIds', 'ambiguous'], path, ['ambiguous']);
  const status = expectOneOf(root.status, `${path}.status`, ['ready', 'ambiguous'] as const);
  const bindingsRoot = expectRecord(root.bindings, `${path}.bindings`);
  const bindings: Record<string, AiProseCharacterBindingEntryV1> = {};
  for (const [name, rawEntry] of Object.entries(bindingsRoot)) {
    const entryPath = `${path}.bindings.${name}`;
    const entry = expectRecord(rawEntry, entryPath);
    expectKeys(entry, ['name', 'speakerId', 'source'], entryPath);
    const entryName = expectString(entry.name, `${entryPath}.name`);
    if (entryName !== name) invalid(`${entryPath}.name`, 'Must match the binding key');
    bindings[name] = {
      name: entryName,
      speakerId: expectString(entry.speakerId, `${entryPath}.speakerId`),
      source: expectOneOf(entry.source, `${entryPath}.source`, [
        'existing_unique',
        'preallocated',
        'user_disambiguation',
      ] as const),
    };
  }
  const preallocatedCharacterIds = parseStringList(root.preallocatedCharacterIds, `${path}.preallocatedCharacterIds`);
  if (new Set(preallocatedCharacterIds).size !== preallocatedCharacterIds.length) {
    invalid(`${path}.preallocatedCharacterIds`, 'Values must be unique');
  }
  if (status === 'ready') {
    if (root.ambiguous !== undefined && root.ambiguous !== null) {
      invalid(`${path}.ambiguous`, 'Ready plans must not carry ambiguity entries');
    }
    return { status, bindings, preallocatedCharacterIds };
  }
  const ambiguous = (expectArray(root.ambiguous, `${path}.ambiguous`)).map((item, index) => {
    const itemPath = `${path}.ambiguous[${index}]`;
    const record = expectRecord(item, itemPath);
    expectKeys(record, ['name', 'candidateIds'], itemPath);
    return {
      name: expectString(record.name, `${itemPath}.name`),
      candidateIds: parseStringList(record.candidateIds, `${itemPath}.candidateIds`),
    };
  });
  if (ambiguous.length === 0) invalid(`${path}.ambiguous`, 'Ambiguous plans must list at least one ambiguity');
  return { status, bindings, ambiguous, preallocatedCharacterIds };
}

function parseEnhancementState(input: unknown, path: string): AiProseEnhancementStateV1 | undefined {
  try {
    const root = expectRecord(input, path);
    expectKeys(root, ['version', 'baseFingerprint', 'characterBindingPlan', 'boundDocumentVersion', 'performance', 'cinematic'], path, [
      'characterBindingPlan',
      'boundDocumentVersion',
      'performance',
      'cinematic',
    ]);
    const version = expectIntegerAtLeast(root.version, `${path}.version`, 1);
    if (version !== AI_PROSE_ENHANCEMENT_STATE_VERSION) {
      invalid(`${path}.version`, `Unsupported enhancement state version ${version}`);
    }
    const result: AiProseEnhancementStateV1 = {
      version,
      baseFingerprint: expectString(root.baseFingerprint, `${path}.baseFingerprint`, true),
    };
    if (root.boundDocumentVersion !== undefined) {
      result.boundDocumentVersion = expectIntegerAtLeast(
        root.boundDocumentVersion,
        `${path}.boundDocumentVersion`,
        0,
      );
    }
    if (root.characterBindingPlan !== undefined) {
      result.characterBindingPlan = parseCharacterBindingPlan(
        root.characterBindingPlan,
        `${path}.characterBindingPlan`,
      );
    }
    if (root.performance !== undefined) {
      const parsed = parseEnhancementStageCheckpoint(root.performance, `${path}.performance`);
      if (parsed !== undefined) result.performance = parsed;
    }
    if (root.cinematic !== undefined) {
      const parsed = parseEnhancementStageCheckpoint(root.cinematic, `${path}.cinematic`);
      if (parsed !== undefined) result.cinematic = parsed;
    }
    return result;
  } catch {
    return undefined;
  }
}

function parseEnhancementStageCheckpoint(
  input: unknown,
  path: string,
): AiProseEnhancementStageCheckpointV1 | undefined {
  try {
    const root = expectRecord(input, path);
    expectKeys(root, ['stage', 'status', 'units', 'diagnostics'], path, ['diagnostics']);
    const stage = expectOneOf(root.stage, `${path}.stage`, ['performance', 'cinematic'] as const);
    const status = expectOneOf(root.status, `${path}.status`, [
      'idle',
      'running',
      'succeeded',
      'retryableFailed',
      'failed',
    ] as const);
    const units = (expectArray(root.units, `${path}.units`)).map((item, index) => (
      parseEnhancementUnitCheckpoint(item, `${path}.units[${index}]`, stage, index)
    ));
    return {
      stage,
      status,
      units,
      ...(root.diagnostics === undefined
        ? {}
        : { diagnostics: parseEnhancementDiagnostics(root.diagnostics, `${path}.diagnostics`) }),
    };
  } catch {
    return undefined;
  }
}

function parseEnhancementUnitCheckpoint(
  input: unknown,
  path: string,
  expectedStage: 'performance' | 'cinematic',
  unitIndex: number,
): AiProseEnhancementUnitCheckpointV1 {
  let envelope: { root: JsonRecord; key: string } | undefined;
  try {
    const root = expectRecord(input, path);
    expectKeys(root, [
      'key',
      'stage',
      'status',
      'patch',
      'diagnostics',
      'attemptCount',
      'policyVersion',
      'processorVersion',
      'inputFingerprint',
      'usage',
      'modelName',
      'lineViewContextChars',
    ], path, ['patch', 'diagnostics', 'inputFingerprint', 'usage', 'modelName', 'lineViewContextChars']);
    const stage = expectOneOf(root.stage, `${path}.stage`, ['performance', 'cinematic'] as const);
    if (stage !== expectedStage) invalid(`${path}.stage`, 'Must match the enclosing stage checkpoint');
    const key = expectString(root.key, `${path}.key`);
    if (!isSafeEnhancementUnitKey(key)) invalid(`${path}.key`, 'Must be a safe unit key');
    envelope = { root, key };
  } catch (cause) {
    return invalidUnitCheckpoint(unitIndex, expectedStage, cause);
  }

  const result: AiProseEnhancementUnitCheckpointV1 = {
    key: envelope.key,
    stage: expectedStage,
    status: 'retryableFailed',
    attemptCount: 1,
    policyVersion: '',
    processorVersion: '',
  };
  try {
    result.status = expectOneOf(envelope.root.status, `${path}.status`, [
      'idle',
      'running',
      'succeeded',
      'retryableFailed',
      'failed',
    ] as const);
    result.attemptCount = expectIntegerAtLeast(envelope.root.attemptCount, `${path}.attemptCount`, 1);
    result.policyVersion = expectString(envelope.root.policyVersion, `${path}.policyVersion`);
    result.processorVersion = expectString(envelope.root.processorVersion, `${path}.processorVersion`);
    if (envelope.root.patch !== undefined) {
      result.patch = parseSemanticScenePatch(envelope.root.patch);
    }
    if (envelope.root.diagnostics !== undefined) {
      result.diagnostics = parseEnhancementDiagnostics(envelope.root.diagnostics, `${path}.diagnostics`);
    }
    if (envelope.root.inputFingerprint !== undefined) {
      result.inputFingerprint = expectString(envelope.root.inputFingerprint, `${path}.inputFingerprint`, true);
    }
    if (envelope.root.usage !== undefined) {
      const usagePath = `${path}.usage`;
      const usage = expectRecord(envelope.root.usage, usagePath);
      expectKeys(usage, ['inputTokens', 'outputTokens', 'totalTokens'], usagePath, ['totalTokens']);
      result.usage = {
        inputTokens: expectIntegerAtLeast(usage.inputTokens, `${usagePath}.inputTokens`, 0),
        outputTokens: expectIntegerAtLeast(usage.outputTokens, `${usagePath}.outputTokens`, 0),
        ...(usage.totalTokens === undefined
          ? {}
          : { totalTokens: expectIntegerAtLeast(usage.totalTokens, `${usagePath}.totalTokens`, 0) }),
      };
    }
    if (envelope.root.modelName !== undefined) {
      result.modelName = expectString(envelope.root.modelName, `${path}.modelName`, true);
    }
    if (envelope.root.lineViewContextChars !== undefined) {
      result.lineViewContextChars = expectIntegerAtLeast(
        envelope.root.lineViewContextChars,
        `${path}.lineViewContextChars`,
        1,
      );
    }
    return result;
  } catch (cause) {
    return {
      ...result,
      status: 'retryableFailed',
      patch: undefined,
      diagnostics: [{
        code: 'invalid_checkpoint',
        message: cause instanceof Error ? cause.message : String(cause),
      }],
    };
  }
}

function invalidUnitCheckpoint(
  unitIndex: number,
  stage: 'performance' | 'cinematic',
  cause: unknown,
): AiProseEnhancementUnitCheckpointV1 {
  return {
    key: `invalid-${unitIndex}`,
    stage,
    status: 'retryableFailed',
    patch: undefined,
    attemptCount: 1,
    policyVersion: '',
    processorVersion: '',
    diagnostics: [{
      code: 'invalid_checkpoint',
      message: cause instanceof Error ? cause.message : String(cause),
    }],
  };
}

function parseEnhancementDiagnostics(
  input: unknown,
  path: string,
): readonly AiProseEnhancementDiagnosticV1[] {
  return (expectArray(input, path)).map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = expectRecord(item, itemPath);
    expectKeys(record, ['code', 'message'], itemPath);
    return {
      code: expectString(record.code, `${itemPath}.code`),
      message: expectString(record.message, `${itemPath}.message`),
    };
  });
}

function expectArray(input: unknown, path: string): unknown[] {
  if (!Array.isArray(input)) invalid(path, 'Expected an array');
  return input;
}

function parseReceipt(input: unknown, path: string): AiProseDraftSession['receipt'] {
  const root = expectRecord(input, path);
  expectKeys(root, [
    'version',
    'correlationId',
    'intentType',
    'origin',
    'historyDescriptor',
    'warnings',
    'resolvedScope',
    'createdStatementIds',
    'updatedStatementIds',
    'deletedStatementIds',
    'createdCompanionLocators',
    'updatedCompanionLocators',
    'deletedCompanionLocators',
    'createdMarkerIds',
    'deletedMarkerIds',
    'createdMarkers',
    'deletedMarkers',
    'sideEffects',
    'timeRange',
  ], path, ['timeRange']);
  if (typeof root.version !== 'number' || !Number.isFinite(root.version)) invalid(`${path}.version`, 'Expected a finite number');
  expectString(root.correlationId, `${path}.correlationId`);
  expectString(root.intentType, `${path}.intentType`);
  expectString(root.origin, `${path}.origin`);
  expectRecord(root.historyDescriptor, `${path}.historyDescriptor`);
  if (!Array.isArray(root.warnings)) invalid(`${path}.warnings`, 'Expected an array');
  expectRecord(root.resolvedScope, `${path}.resolvedScope`);
  for (const key of [
    'createdStatementIds',
    'updatedStatementIds',
    'deletedStatementIds',
    'createdCompanionLocators',
    'updatedCompanionLocators',
    'deletedCompanionLocators',
    'createdMarkerIds',
    'deletedMarkerIds',
    'createdMarkers',
    'deletedMarkers',
    'sideEffects',
  ]) {
    if (!Array.isArray(root[key])) invalid(`${path}.${key}`, 'Expected an array');
  }
  if (root.timeRange !== undefined) expectRecord(root.timeRange, `${path}.timeRange`);
  return cloneJson(root) as AiProseDraftSession['receipt'];
}

function parseTaskStatus(value: unknown, path: string): AiProseTaskStatus {
  if (typeof value !== 'string' || !STATUS_VALUES.has(value as AiProseTaskStatus)) {
    invalid(path, 'Expected an AI prose task status');
  }
  return value as AiProseTaskStatus;
}

function parseStringList(input: unknown, path: string): string[] {
  if (!Array.isArray(input)) invalid(path, 'Expected an array');
  return input.map((value, index) => expectString(value, `${path}[${index}]`));
}

function parseOptionalError(input: unknown, path: string): { error?: AiProseTaskError } {
  if (input === undefined) return {};
  const root = expectRecord(input, path);
  expectKeys(root, ['code', 'message', 'details'], path, ['details']);
  const details = root.details === undefined ? undefined : expectRecord(root.details, `${path}.details`);
  return {
    error: {
      code: expectString(root.code, `${path}.code`),
      message: expectString(root.message, `${path}.message`),
      ...(details === undefined ? {} : { details: cloneJson(details) }),
    },
  };
}

function optionalString(input: unknown, path: string): { [key: string]: string } {
  if (input === undefined) return {};
  return { [path.slice(path.lastIndexOf('.') + 1)]: expectString(input, path) };
}

function optionalBoolean(input: unknown, path: string): { usedFallback?: boolean } {
  return input === undefined ? {} : { usedFallback: expectBoolean(input, path) };
}

function expectRecord(input: unknown, path: string): JsonRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid(path, 'Expected an object');
  return input as JsonRecord;
}

function expectKeys(
  root: JsonRecord,
  required: readonly string[],
  path: string,
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const optionalSet = new Set(optional);
  const missing = required.filter((key) => (
    !optionalSet.has(key) && !Object.prototype.hasOwnProperty.call(root, key)
  ));
  const unknown = Object.keys(root).filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    const detail = [
      ...(missing.length > 0 ? [`missing ${missing.join(', ')}`] : []),
      ...(unknown.length > 0 ? [`unknown ${unknown.join(', ')}`] : []),
    ].join('; ');
    invalid(path, detail);
  }
}

function expectSchemaVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    invalid('draft.schemaVersion', 'Expected a non-negative integer');
  }
  return value;
}

function expectString(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) invalid(path, 'Expected a string');
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(path, 'Expected a boolean');
  return value;
}

function expectIntegerAtLeast(value: unknown, path: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    invalid(path, `Expected an integer >= ${minimum}`);
  }
  return value;
}

function expectFiniteAtLeast(value: unknown, path: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    invalid(path, `Expected a finite number >= ${minimum}`);
  }
  return value;
}

function expectFiniteGreaterThan(value: unknown, path: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= minimum) {
    invalid(path, `Expected a finite number > ${minimum}`);
  }
  return value;
}

function expectOneOf<T extends readonly string[]>(value: unknown, path: string, values: T): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) invalid(path, `Expected one of ${values.join(', ')}`);
  return value as T[number];
}

function invalid(path: string, message: string): never {
  throw new AiProseDraftMigrationError(`Invalid draft structure at ${path}: ${message}`, 'invalid-structure', path);
}

function createEmptySegmentation(): AiProseSegmentationState {
  return { status: 'idle', planFingerprint: '', targetSegmentCount: 1, candidates: [], boundaryIds: [], segments: [] };
}

function createEmptyCharacterExtraction(): AiProseCharacterExtractionState {
  return { status: 'idle', suggestedNames: [] };
}

function setLegacyDefault(root: JsonRecord, key: string, value: unknown): void {
  if (!Object.prototype.hasOwnProperty.call(root, key)) root[key] = value;
}

function ensurePlanFingerprint(root: JsonRecord): void {
  const segmentation = root.segmentation;
  if (!segmentation || typeof segmentation !== 'object' || Array.isArray(segmentation)) return;
  if (Object.prototype.hasOwnProperty.call(segmentation, 'planFingerprint')) return;
  if (
    typeof root.sourceText === 'string'
    && typeof root.targetBatchSize === 'number'
    && typeof segmentation.targetSegmentCount === 'number'
    && Array.isArray(segmentation.candidates)
    && Array.isArray(segmentation.boundaryIds)
    && Array.isArray(segmentation.segments)
  ) {
    segmentation.planFingerprint = createAiProseSegmentationFingerprintFromState(
      root.sourceText,
      root.targetBatchSize,
      segmentation,
    );
    return;
  }
  segmentation.planFingerprint = '';
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type JsonRecord = Record<string, any>;
