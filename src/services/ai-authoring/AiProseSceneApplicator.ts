import type { SemanticAuthorReceipt } from '../../api/types/authoring';
import {
  AI_PROSE_DRAFT_SCHEMA_VERSION,
  type AiProseDraftSession,
  type AiProseTimedStatement,
} from '../../api/types/ai-prose-authoring';
import type { CurrentSceneDocument, DialogueCompanion, DialogueParams, SceneStatement } from '../../api/types/semantic-scene';
import type { SemanticScenePatchV1 } from '../../api/types/semantic-scene-patch';
import {
  buildAiProseDeterministicPreview,
  splitAiProseNormalizationTasks,
} from './AiProseDeterministicCompiler';
import {
  SceneDocumentCodec,
  SceneStatementCompiler,
  SceneStatementFactory,
  sceneDocumentCodec,
  sceneStatementCompiler,
  validateSemanticSceneStructure,
  getSceneDocumentCanonicalOrder,
  withSceneDocumentCanonicalOrder,
  type SceneStatementIdGenerator,
} from '../semantic-scene';
import { createSemanticAuthorReceipt } from '../timeline-authoring/SemanticAuthoringReceipt';
import { applyDraft } from './AiProseDraftSession';
import { materializePerformancePlaceholders, stableCharacterId } from './CharacterBindingPlan';
import {
  applyEnhancementStagePlan,
  type EnhancementStagePlanV1,
} from './FormalEnhancementApply';

export const AI_PROSE_APPLIED_ARCHIVE_VERSION = 1 as const;

export type AiProseCharacterIdGenerator = (
  name: string,
  usedIds: ReadonlySet<string>,
) => string;

/**
 * Raised when the persisted character binding plan or the "exactly one
 * performance placeholder per target dialogue" invariant conflicts with the
 * latest formal scene at apply time. The apply transaction is refused and the
 * user must return to the character binding step (no silent re-bind, no
 * partial application).
 */
export class AiProseApplyBindingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiProseApplyBindingConflictError';
    this.code = 'binding-conflict';
  }

  readonly code: 'binding-conflict';
}

export interface AiProseSceneApplicationReceipt {
  readonly sessionId: string;
  readonly sceneId: string;
  readonly createdCharacterIds: readonly string[];
  readonly characterBindings: Readonly<Record<string, string>>;
  readonly createdStatementIds: readonly string[];
  readonly timeRange: {
    readonly start: number;
    readonly end: number;
  };
  readonly semanticReceipt: SemanticAuthorReceipt;
}

export interface AiProseAppliedArchive {
  readonly version: typeof AI_PROSE_APPLIED_ARCHIVE_VERSION;
  readonly status: 'applied';
  readonly sessionId: string;
  readonly sceneId: string;
  readonly appliedAt: string;
  readonly receipt: AiProseSceneApplicationReceipt;
}

export interface AiProseCompositeCommitInput {
  readonly previousDocument: CurrentSceneDocument;
  readonly document: CurrentSceneDocument;
  readonly draft: AiProseDraftSession;
  readonly appliedDraft: AiProseDraftSession;
  readonly archive: AiProseAppliedArchive;
}

export type AiProseCompositeCommit = (
  input: AiProseCompositeCommitInput,
) => void | Promise<void>;

export interface AiProseSceneApplicatorOptions {
  readonly commitApplied: AiProseCompositeCommit;
  readonly now?: () => string;
  readonly characterIdGenerator?: AiProseCharacterIdGenerator;
  readonly statementIdGenerator?: SceneStatementIdGenerator;
  readonly factory?: SceneStatementFactory;
  readonly codec?: SceneDocumentCodec;
  readonly compiler?: SceneStatementCompiler;
}

export interface AiProseSceneApplicationResult {
  readonly document: CurrentSceneDocument;
  readonly receipt: AiProseSceneApplicationReceipt;
  readonly archive: AiProseAppliedArchive;
  readonly appliedDraft: AiProseDraftSession;
}

type SceneCharacter = NonNullable<CurrentSceneDocument['meta']['characters']>[number];

const sharedApplyGuards = new WeakMap<object, Map<string, 'in-flight' | 'applied'>>();

export class AiProseSceneApplicator {
  private readonly commitApplied: AiProseCompositeCommit;
  private readonly now: () => string;
  private readonly characterIdGenerator: AiProseCharacterIdGenerator;
  private readonly factory: SceneStatementFactory;
  private readonly codec: SceneDocumentCodec;
  private readonly compiler: SceneStatementCompiler;
  private readonly appliedSessionIds = new Set<string>();
  private readonly inFlightSessionIds = new Set<string>();
  private readonly sharedGuard: Map<string, 'in-flight' | 'applied'>;

  constructor(options: AiProseSceneApplicatorOptions) {
    if (!options.commitApplied) {
      throw new Error('An AI prose commitApplied composite seam is required');
    }
    this.commitApplied = options.commitApplied;
    this.now = options.now ?? (() => new Date().toISOString());
    this.characterIdGenerator = options.characterIdGenerator ?? stableCharacterId;
    this.factory = options.factory ?? (options.statementIdGenerator
      ? new SceneStatementFactory({ idGenerator: options.statementIdGenerator })
      : new SceneStatementFactory());
    this.codec = options.codec ?? sceneDocumentCodec;
    this.compiler = options.compiler ?? sceneStatementCompiler;
    this.sharedGuard = getSharedApplyGuard(options.commitApplied);
  }

  async apply(
    draft: AiProseDraftSession,
    document: CurrentSceneDocument,
    options: {
      /**
       * Ordered enhancement stages authored against the final apply baseline
       * (existing formal statements + draft dialogues + performance placeholders).
       * Preferred over flat enhancementPatch.
       */
      readonly enhancementStagePlan?: EnhancementStagePlanV1;
      /** @deprecated Prefer enhancementStagePlan — flat ops are single-base only. */
      readonly enhancementPatch?: SemanticScenePatchV1;
    } = {},
  ): Promise<AiProseSceneApplicationResult> {
    assertDraftCanApply(draft, document);
    this.claimApply(draft.sessionId);
    try {
      const prepared = this.prepareDocument(draft, document, options);
      const appliedAt = this.now();
      const archive: AiProseAppliedArchive = {
        version: AI_PROSE_APPLIED_ARCHIVE_VERSION,
        status: 'applied',
        sessionId: draft.sessionId,
        sceneId: draft.sceneId,
        appliedAt,
        receipt: prepared.receipt,
      };
      const appliedDraft = applyDraft(draft, prepared.receipt.semanticReceipt, {
        appliedAt,
        now: appliedAt,
      });

      await this.commitApplied({
        previousDocument: document,
        document: prepared.document,
        draft: appliedDraft,
        appliedDraft,
        archive,
      });

      this.appliedSessionIds.add(draft.sessionId);
      this.sharedGuard.set(draft.sessionId, 'applied');
      return {
        document: prepared.document,
        receipt: prepared.receipt,
        archive,
        appliedDraft,
      };
    } catch (error) {
      this.sharedGuard.delete(draft.sessionId);
      throw error;
    } finally {
      this.inFlightSessionIds.delete(draft.sessionId);
    }
  }

  private claimApply(sessionId: string): void {
    if (this.appliedSessionIds.has(sessionId)
      || this.inFlightSessionIds.has(sessionId)
      || this.sharedGuard.has(sessionId)) {
      throw new Error(`AI prose draft has already applied or is being applied: ${sessionId}`);
    }
    this.inFlightSessionIds.add(sessionId);
    this.sharedGuard.set(sessionId, 'in-flight');
  }

  private prepareDocument(
    draft: AiProseDraftSession,
    document: CurrentSceneDocument,
    options: {
      readonly enhancementStagePlan?: EnhancementStagePlanV1;
      readonly enhancementPatch?: SemanticScenePatchV1;
    } = {},
  ): { document: CurrentSceneDocument; receipt: AiProseSceneApplicationReceipt } {
    const binding = bindConfirmedCharacters(
      document,
      draft.confirmedMainCharacters,
      draft.characterBindings,
      this.characterIdGenerator,
    );
    // ADR-0022: re-validate the persisted binding plan against the latest
    // formal scene before any write. Conflicts refuse the transaction and
    // return the user to the character binding step.
    assertBindingPlanConsistent(
      draft.characterBindingPlan,
      document,
      draft.confirmedMainCharacters,
      draft.characterBindings,
    );
    const usedStatementIds = new Set(document.statements.map((statement) => statement.id));
    const createdStatements = draft.preview!.statements.map((previewStatement) => {
      const params = dialogueParamsForPreview(previewStatement, binding.characterBindings, draft.confirmedMainCharacters);
      const statement = this.factory.createStatement({
        type: 'dialogue',
        time: previewStatement.time,
        params,
      }, usedStatementIds);
      usedStatementIds.add(statement.id);
      return statement;
    });
    const createdStatementIds = createdStatements.map((statement) => statement.id);
    const createdStatementIdSet = new Set(createdStatementIds);
    const insertedTimeRange = statementTimeRange(createdStatements);
    const statements = [...document.statements, ...createdStatements]
      .map((statement, index) => ({ statement, index }))
      .sort((left, right) => left.statement.time - right.statement.time || left.index - right.index)
      .map(({ statement }) => statement);
    const rawDocument: CurrentSceneDocument = {
      ...document,
      meta: {
        ...document.meta,
        ...(document.meta.durationSeconds !== undefined
          ? { durationSeconds: Math.max(document.meta.durationSeconds, insertedTimeRange.end) }
          : {}),
        ...(binding.characters ? { characters: binding.characters } : {}),
      },
      statements,
    };
    // ADR-0022: placeholders only ever attach to the dialogues created by this
    // draft (no backfill of pre-existing formal dialogues), then optional
    // staged enhancements apply against that same created-only baseline.
    const withCreatedPlaceholders = materializePerformancePlaceholders(rawDocument, {
      targetStatementIds: createdStatementIdSet,
    });
    let withPlaceholders: CurrentSceneDocument;
    if (options.enhancementStagePlan && options.enhancementStagePlan.stages.length > 0) {
      withPlaceholders = applyEnhancementStagePlan(withCreatedPlaceholders, options.enhancementStagePlan, {
        materializePlaceholders: false,
      }).candidate;
    } else {
      withPlaceholders = withCreatedPlaceholders;
      const enhancementPatch = options.enhancementPatch;
      if (enhancementPatch && enhancementPatch.operations.length > 0) {
        withPlaceholders = applyEnhancementStagePlan(withPlaceholders, {
          version: 1,
          stages: [{ stage: 'performance', patch: enhancementPatch }],
        }, { materializePlaceholders: false }).candidate;
      }
    }
    const parsed = this.codec.parseAndValidate(withPlaceholders);
    const canonicalOrder = getSceneDocumentCanonicalOrder(document);
    const validated = canonicalOrder
      ? withSceneDocumentCanonicalOrder(parsed, canonicalOrder)
      : parsed;
    const semanticIssues = validateSemanticSceneStructure(validated);
    const semanticErrors = semanticIssues.filter((issue) => issue.severity === 'error');
    if (semanticErrors.length > 0) {
      throw new Error(`AI prose scene failed semantic validation: ${semanticErrors.map((issue) => issue.message).join('; ')}`);
    }
    this.compiler.compile(validated);

    // ADR-0022: explicit re-check that every target dialogue has exactly one
    // performance placeholder on the final candidate — never assumed from
    // construction time alone. Violations refuse the transaction.
    assertPerformancePlaceholderInvariant(validated, createdStatementIds, binding.characterBindings);
    const committedStatements = createdStatementIds.map((statementId) => {
      const statement = validated.statements.find((candidate) => candidate.id === statementId);
      if (!statement) throw new Error(`Created statement is missing after validation: ${statementId}`);
      return statement;
    });
    const timeRange = statementTimeRange(committedStatements);
    const semanticReceipt = createSemanticAuthorReceipt({
      correlationId: draft.sessionId,
      intentType: 'insert-script-segment',
      origin: 'ai-script-panel',
      historyDescriptor: {
        key: 'timeline.author.insertScriptSegment',
        args: { count: committedStatements.length },
        fallbackLabel: 'AI prose scene application',
      },
      resolvedScope: { kind: 'none' },
      createdStatements: committedStatements,
      timeRange,
    });
    return {
      document: validated,
      receipt: {
        sessionId: draft.sessionId,
        sceneId: draft.sceneId,
        createdCharacterIds: binding.createdCharacterIds,
        characterBindings: binding.characterBindings,
        createdStatementIds,
        timeRange,
        semanticReceipt,
      },
    };
  }
}

export async function applyAiProseDraftToScene(
  draft: AiProseDraftSession,
  document: CurrentSceneDocument,
  options: AiProseSceneApplicatorOptions,
): Promise<AiProseSceneApplicationResult> {
  return new AiProseSceneApplicator(options).apply(draft, document);
}

export async function applyAiProseDraftToCurrentSceneDocument(
  document: CurrentSceneDocument,
  draft: AiProseDraftSession,
  options: AiProseSceneApplicatorOptions,
): Promise<AiProseSceneApplicationResult> {
  return new AiProseSceneApplicator(options).apply(draft, document);
}

function getSharedApplyGuard(owner: object): Map<string, 'in-flight' | 'applied'> {
  const existing = sharedApplyGuards.get(owner);
  if (existing) return existing;
  const created = new Map<string, 'in-flight' | 'applied'>();
  sharedApplyGuards.set(owner, created);
  return created;
}

function assertDraftCanApply(
  draft: AiProseDraftSession,
  document: CurrentSceneDocument,
): void {
  if (!draft || typeof draft !== 'object') throw new Error('AI prose draft is invalid');
  if (draft.schemaVersion !== AI_PROSE_DRAFT_SCHEMA_VERSION) {
    throw new Error(`Unsupported AI prose draft schema version: ${String(draft.schemaVersion)}`);
  }
  if (draft.status !== 'active') throw new Error(`AI prose draft is not active: ${draft.status}`);
  if (draft.appliedAt !== undefined || draft.receipt !== undefined) {
    throw new Error('Active AI prose draft contains applied archive fields');
  }
  if (!isNonEmptyString(draft.sessionId) || !isNonEmptyString(draft.sceneId)) {
    throw new Error('AI prose draft identity is invalid');
  }
  if (draft.sceneId !== document.sceneId) throw new Error('AI prose draft scene does not match target scene');
  if (draft.anchorMode !== 'zero' && draft.anchorMode !== 'playhead') {
    throw new Error('AI prose draft anchor mode is invalid');
  }
  if (!isNonNegativeFiniteNumber(draft.anchorTime)) throw new Error('AI prose draft anchor time is invalid');
  if (draft.anchorMode === 'zero' && draft.anchorTime !== 0) {
    throw new Error('Zero-anchored AI prose draft must have anchorTime 0');
  }
  if (!isPositiveFiniteNumber(draft.scriptReadingSpeed)) {
    throw new Error('AI prose draft script reading speed is invalid');
  }
  if (draft.mainCharactersConfirmed !== true) throw new Error('AI prose main characters have not been confirmed');
  if (!Array.isArray(draft.confirmedMainCharacters)) {
    throw new Error('AI prose confirmed main characters are invalid');
  }
  const names = new Set<string>();
  draft.confirmedMainCharacters.forEach((name) => {
    if (!isNonEmptyString(name) || names.has(name)) throw new Error('AI prose confirmed main characters are invalid');
    names.add(name);
  });
  if (!isRecord(draft.characterBindings)) throw new Error('AI prose character bindings are invalid');
  for (const [name, id] of Object.entries(draft.characterBindings)) {
    if (!names.has(name) || !isNonEmptyString(id)) throw new Error('AI prose character bindings are invalid');
  }
  assertSucceededStage(draft.segmentation?.status, 'segmentation');
  assertCompletedCharacterExtraction(draft.characterExtraction?.status);
  if (!Array.isArray(draft.normalization) || draft.normalization.length === 0) {
    throw new Error('AI prose normalization is incomplete');
  }
  for (const task of draft.normalization) {
    assertSucceededStage(task.status, 'normalization');
    if (!Number.isInteger(task.segmentIndex) || task.segmentIndex < 0 || !Array.isArray(task.statements)) {
      throw new Error('AI prose normalization is invalid');
    }
    for (const statement of task.statements) {
      if (!isString(statement.speaker) || !isNonEmptyString(statement.text)) {
        throw new Error('AI prose normalization is invalid');
      }
    }
  }
  if (!Array.isArray(draft.rhythm)) throw new Error('AI prose rhythm is invalid');
  for (const task of draft.rhythm) {
    assertSucceededStage(task.status, 'rhythm');
    if (!Number.isInteger(task.segmentIndex) || task.segmentIndex < 0
      || !Array.isArray(task.gapSeconds)
      || task.gapSeconds.some((gap) => !isPositiveFiniteNumber(gap))) {
      throw new Error('AI prose rhythm is invalid');
    }
  }
  if (!draft.preview || typeof draft.preview !== 'object' || Array.isArray(draft.preview)) {
    throw new Error('AI prose draft has no successful preview');
  }
  if (draft.preview.anchorTime !== draft.anchorTime
    || !isNonNegativeFiniteNumber(draft.preview.durationSeconds)
    || !Array.isArray(draft.preview.statements)
    || draft.preview.statements.length === 0) {
    throw new Error('AI prose preview is invalid');
  }
  const expectedStatements = splitAiProseNormalizationTasks(draft.normalization);
  if (expectedStatements.length !== draft.preview.statements.length) {
    throw new Error('AI prose preview does not match normalized statements');
  }
  const expectedPreview = buildAiProseDeterministicPreview(
    draft.normalization,
    draft.rhythm,
    draft.anchorTime,
    { scriptReadingSpeed: draft.scriptReadingSpeed },
  );
  assertDeterministicPreviewMatches(draft.preview, expectedPreview);
}

function assertDeterministicPreviewMatches(
  actual: NonNullable<AiProseDraftSession['preview']>,
  expected: NonNullable<AiProseDraftSession['preview']>,
): void {
  if (!nearlyEqual(actual.anchorTime, expected.anchorTime)
    || !nearlyEqual(actual.durationSeconds, expected.durationSeconds)
    || actual.statements.length !== expected.statements.length) {
    throw new Error('AI prose preview failed deterministic validation');
  }

  actual.statements.forEach((statement, index) => {
    const expectedStatement = expected.statements[index];
    if (!expectedStatement
      || statement.segmentIndex !== expectedStatement.segmentIndex
      || statement.statementIndex !== expectedStatement.statementIndex
      || statement.speaker !== expectedStatement.speaker
      || statement.text !== expectedStatement.text
      || !nearlyEqual(statement.time, expectedStatement.time)
      || !nearlyEqual(statement.durationSeconds, expectedStatement.durationSeconds)
      || !nearlyEqual(statement.gapSecondsToNext, expectedStatement.gapSecondsToNext)) {
      throw new Error('AI prose preview failed deterministic validation');
    }
  });
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9;
}

function assertSucceededStage(status: unknown, stage: string): void {
  if (status !== 'succeeded') throw new Error(`AI prose ${stage} is incomplete`);
}

function assertCompletedCharacterExtraction(status: unknown): void {
  if (status !== 'succeeded' && status !== 'failed') {
    throw new Error('AI prose character extraction is incomplete');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function bindConfirmedCharacters(
  document: CurrentSceneDocument,
  names: readonly string[],
  requestedBindings: Readonly<Record<string, string>>,
  idGenerator: AiProseCharacterIdGenerator,
): {
  characters: SceneCharacter[] | undefined;
  createdCharacterIds: string[];
  characterBindings: Record<string, string>;
} {
  const existing = document.meta.characters ?? [];
  const characters = [...existing];
  const usedIds = new Set(existing.map((character) => character.id));
  const createdCharacterIds: string[] = [];
  const characterBindings: Record<string, string> = {};

  for (const name of names) {
    const matches = existing.filter((character) => character.name === name);
    if (matches.length > 1) {
      const selectedId = requestedBindings[name];
      if (!selectedId || !matches.some((character) => character.id === selectedId)) {
        throw new Error(`AI prose character binding is unresolved for duplicate name "${name}"`);
      }
      characterBindings[name] = selectedId;
      continue;
    }
    if (matches.length === 1) {
      characterBindings[name] = matches[0].id;
      continue;
    }

    const id = idGenerator(name, usedIds);
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error(`AI prose character id generator returned an invalid id for "${name}"`);
    }
    if (usedIds.has(id)) throw new Error(`AI prose character id generator returned duplicate id "${id}"`);
    usedIds.add(id);
    characters.push({ id, name });
    createdCharacterIds.push(id);
    characterBindings[name] = id;
  }

  return {
    characters: names.length > 0 || document.meta.characters !== undefined ? characters : undefined,
    createdCharacterIds,
    characterBindings,
  };
}

function dialogueParamsForPreview(
  previewStatement: AiProseTimedStatement,
  characterBindings: Readonly<Record<string, string>>,
  confirmedMainCharacters: readonly string[],
): DialogueParams {
  if (previewStatement.speaker === '') {
    return {
      text: previewStatement.text,
      durationSeconds: previewStatement.durationSeconds,
    };
  }
  const params: DialogueParams = {
    speaker: previewStatement.speaker,
    text: previewStatement.text,
    durationSeconds: previewStatement.durationSeconds,
  };
  if (confirmedMainCharacters.includes(previewStatement.speaker)) {
    params.speakerId = characterBindings[previewStatement.speaker];
  }
  return params;
}

function statementTimeRange(statements: readonly SceneStatement[]): { start: number; end: number } {
  return {
    start: Math.min(...statements.map((statement) => statement.time)),
    end: stableNumber(Math.max(...statements.map((statement) => {
      if (statement.type !== 'dialogue') throw new Error(`Created statement is not dialogue: ${statement.id}`);
      return statement.time + statement.params.durationSeconds;
    }))),
  };
}

function stableNumber(value: number): number {
  return Math.round(value * 1e10) / 1e10;
}

/**
 * Re-validate the persisted character binding plan against the latest formal
 * scene (ADR-0022). Conflicts (role set or binding changes) refuse the apply
 * transaction — the host never silently re-binds. Preallocated ids must still
 * be what the shared generator produces over the current scene's used ids;
 * user disambiguation entries must still match the draft's requested binding.
 */
function assertBindingPlanConsistent(
  plan: AiProseDraftSession['characterBindingPlan'],
  document: CurrentSceneDocument,
  confirmedNames: readonly string[],
  requestedBindings: Readonly<Record<string, string>>,
): void {
  if (!plan) return;
  if (plan.status !== 'ready') {
    throw new AiProseApplyBindingConflictError(
      '角色绑定计划存在歧义，请回到角色绑定步骤完成选择后再应用。',
    );
  }
  const characters = document.meta.characters ?? [];
  const byId = new Map(characters.map((character) => [character.id, character]));

  for (const name of confirmedNames) {
    const entry = plan.bindings[name];
    if (!entry) {
      throw new AiProseApplyBindingConflictError(
        `缺少主要人物 "${name}" 的角色绑定，请回到角色绑定步骤重新生成计划。`,
      );
    }
    const matches = characters.filter((character) => character.name === name);
    switch (entry.source) {
      case 'existing_unique':
        if (matches.length !== 1 || matches[0]!.id !== entry.speakerId) {
          throw new AiProseApplyBindingConflictError(
            `主要人物 "${name}" 在当前 scene 中的唯一同名角色与绑定计划不一致，请回到角色绑定步骤。`,
          );
        }
        break;
      case 'user_disambiguation':
        // The draft's requested binding must still be the plan's choice and
        // still resolve to a scene character; otherwise the user changed the
        // choice without regenerating the plan (no silent re-bind).
        if (requestedBindings[name] !== entry.speakerId
          || !matches.some((character) => character.id === entry.speakerId)) {
          throw new AiProseApplyBindingConflictError(
            `主要人物 "${name}" 的重名选择已失效，请回到角色绑定步骤重新选择。`,
          );
        }
        break;
      case 'preallocated': {
        const occupant = byId.get(entry.speakerId);
        if (occupant) {
          if (occupant.name !== name) {
            throw new AiProseApplyBindingConflictError(
              `预分配角色号 "${entry.speakerId}" 已被其他角色占用，请回到角色绑定步骤。`,
            );
          }
          break;
        }
        // The preallocated id is free: the apply-time binder will regenerate it
        // over the current used ids — it must reproduce the plan's speakerId.
        const regenerated = stableCharacterId(
          name,
          new Set(characters.map((character) => character.id)),
        );
        if (regenerated !== entry.speakerId) {
          throw new AiProseApplyBindingConflictError(
            `主要人物 "${name}" 的预分配角色号将重新生成，请回到角色绑定步骤。`,
          );
        }
        break;
      }
    }
  }
}

/**
 * Re-verify the "exactly one performance placeholder per target dialogue"
 * invariant on the final apply candidate. Only the dialogues created by this
 * draft are target dialogues; narration and temporary speakers are excluded.
 */
function assertPerformancePlaceholderInvariant(
  document: CurrentSceneDocument,
  createdStatementIds: readonly string[],
  characterBindings: Readonly<Record<string, string>>,
): void {
  const createdIds = new Set(createdStatementIds);
  const boundIds = new Set(Object.values(characterBindings));
  for (const statement of document.statements) {
    if (statement.type !== 'dialogue' || !createdIds.has(statement.id)) continue;
    const speakerId = readString(statement.params.speakerId);
    if (!speakerId || !boundIds.has(speakerId)) continue;
    const placeholders = (statement.companions ?? []).filter(isPlaceholderCompanion);
    if (placeholders.length !== 1) {
      throw new AiProseApplyBindingConflictError(
        `对白 "${speakerId}" 的角色表演占位数量为 ${placeholders.length}（应为恰好 1 枚），请回到角色绑定步骤重新生成。`,
      );
    }
  }
}

/**
 * The speaker performance slot of a dialogue: target $speaker, anchored at
 * start. It counts as the ADR-0022 placeholder whether its motion is still the
 * exact empty string (placeholder) or has been filled by enhancement — the
 * invariant is that the slot exists exactly once.
 */
function isPlaceholderCompanion(companion: DialogueCompanion): boolean {
  if (companion.type !== 'characterPerformance') return false;
  const params = companion.params as { target?: unknown };
  return params.target === '$speaker'
    && companion.anchor === 'start'
    && companion.offset === 0;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
