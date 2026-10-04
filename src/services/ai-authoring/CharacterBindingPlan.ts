import type {
  DialogueCompanion,
  DialogueParams,
  CurrentSceneDocument,
  SceneStatement,
} from '../../api/types/semantic-scene';
import type {
  AiProseCharacterBindingAmbiguityV1,
  AiProseCharacterBindingEntryV1,
  AiProseCharacterBindingPlanV1,
  AiProseCharacterBindingSourceV1,
} from '../../api/types/ai-prose-authoring';
import {
  SceneStatementFactory,
  sceneDocumentCodec,
  type SceneStatementIdGenerator,
} from '../semantic-scene';

export type CharacterBindingSourceV1 = AiProseCharacterBindingSourceV1;

export type CharacterBindingEntryV1 = AiProseCharacterBindingEntryV1;

export type CharacterBindingAmbiguityV1 = AiProseCharacterBindingAmbiguityV1;

/** Persisted plan shape shared with the draft session (schema v3+). */
export type CharacterBindingPlanV1 = AiProseCharacterBindingPlanV1;

export type CharacterIdGenerator = (
  name: string,
  usedIds: ReadonlySet<string>,
) => string;

export interface BuildCharacterBindingPlanInput {
  readonly document: CurrentSceneDocument;
  readonly confirmedMainCharacters: readonly string[];
  readonly requestedBindings?: Readonly<Record<string, string>>;
  readonly characterIdGenerator?: CharacterIdGenerator;
}

export interface DraftPreviewStatementV1 {
  readonly speaker: string;
  readonly text: string;
  readonly time: number;
  readonly durationSeconds: number;
}

export interface ProjectDraftSemanticSceneInput {
  readonly baseDocument: CurrentSceneDocument;
  readonly plan: Extract<CharacterBindingPlanV1, { status: 'ready' }>;
  readonly confirmedMainCharacters: readonly string[];
  readonly previewStatements: readonly DraftPreviewStatementV1[];
  readonly statementIdGenerator?: SceneStatementIdGenerator;
  /** When false, skip codec validation (unit tests only). Defaults to true. */
  readonly validate?: boolean;
}

type SceneCharacter = NonNullable<CurrentSceneDocument['meta']['characters']>[number];

const PERFORMANCE_PLACEHOLDER_PARAMS = Object.freeze({
  target: '$speaker',
  motion: '',
});

export function buildCharacterBindingPlan(
  input: BuildCharacterBindingPlanInput,
): CharacterBindingPlanV1 {
  const names = normalizeConfirmedNames(input.confirmedMainCharacters);
  const requested = input.requestedBindings ?? {};
  const existing = input.document.meta.characters ?? [];
  const usedIds = new Set(existing.map((character) => character.id));
  const idGenerator = input.characterIdGenerator ?? stableCharacterId;
  const bindings: Record<string, CharacterBindingEntryV1> = {};
  const ambiguous: CharacterBindingAmbiguityV1[] = [];
  const preallocatedCharacterIds: string[] = [];

  for (const name of names) {
    const matches = existing.filter((character) => character.name === name);
    if (matches.length > 1) {
      const selectedId = requested[name];
      if (selectedId && matches.some((character) => character.id === selectedId)) {
        bindings[name] = {
          name,
          speakerId: selectedId,
          source: 'user_disambiguation',
        };
        continue;
      }
      ambiguous.push({
        name,
        candidateIds: matches.map((character) => character.id),
      });
      continue;
    }

    if (matches.length === 1) {
      bindings[name] = {
        name,
        speakerId: matches[0].id,
        source: 'existing_unique',
      };
      continue;
    }

    const speakerId = claimGeneratedId(name, usedIds, idGenerator);
    usedIds.add(speakerId);
    preallocatedCharacterIds.push(speakerId);
    bindings[name] = {
      name,
      speakerId,
      source: 'preallocated',
    };
  }

  if (ambiguous.length > 0) {
    return {
      status: 'ambiguous',
      bindings,
      ambiguous,
      preallocatedCharacterIds,
    };
  }

  return {
    status: 'ready',
    bindings,
    preallocatedCharacterIds,
  };
}

/**
 * Ensure every target dialogue with a stable speakerId has exactly one
 * empty-motion characterPerformance companion (anchor start / offset 0 /
 * target $speaker). Narration and temporary speakers without speakerId are
 * left untouched. Idempotent: does not append a second placeholder when one
 * already exists. When `targetStatementIds` is given, only dialogues whose
 * statement id is in the set are targets (ADR-0022: apply never backfills
 * pre-existing formal dialogues — only the dialogues created by the draft).
 */
export function materializePerformancePlaceholders(
  document: CurrentSceneDocument,
  options: {
    readonly idGenerator?: SceneStatementIdGenerator;
    readonly targetStatementIds?: ReadonlySet<string>;
  } = {},
): CurrentSceneDocument {
  const factory = new SceneStatementFactory({
    idGenerator: options.idGenerator,
  });
  let changed = false;
  const statements = document.statements.map((statement) => {
    if (statement.type !== 'dialogue') return statement;
    if (options.targetStatementIds && !options.targetStatementIds.has(statement.id)) return statement;
    const speakerId = statement.params.speakerId;
    if (typeof speakerId !== 'string' || speakerId.trim() === '') return statement;

    const companions = statement.companions ?? [];
    if (hasPerformancePlaceholder(companions)) return statement;

    const usedCompanionIds = new Set(companions.map((companion) => companion.id));
    const placeholder = factory.createStatement({
      type: 'characterPerformance',
      time: 0,
      params: { ...PERFORMANCE_PLACEHOLDER_PARAMS },
    }, usedCompanionIds);
    // createStatement yields a root statement; re-shape as companion draft fields.
    const companion: DialogueCompanion = {
      id: placeholder.id.startsWith('cmp_')
        ? placeholder.id
        : `cmp_${placeholder.id}`,
      anchor: 'start',
      offset: 0,
      type: 'characterPerformance',
      params: { ...PERFORMANCE_PLACEHOLDER_PARAMS },
    };
    // Ensure companion id uniqueness against existing companions.
    if (usedCompanionIds.has(companion.id)) {
      let suffix = 2;
      let candidate = `${companion.id}_${suffix}`;
      while (usedCompanionIds.has(candidate)) {
        suffix += 1;
        candidate = `${companion.id}_${suffix}`;
      }
      companion.id = candidate;
    }

    changed = true;
    return {
      ...statement,
      companions: [...companions, companion],
    };
  });

  if (!changed) return document;
  return sceneDocumentCodec.parseAndValidate({
    ...document,
    statements,
  });
}

/**
 * Build a non-writing draft semantic scene projection for optional enhancement.
 * Preallocated characters enter the projected meta character directory (in
 * memory only) so capability catalogs can address them; the formal SceneMeta
 * is not mutated until formal apply.
 */
export function projectDraftSemanticScene(
  input: ProjectDraftSemanticSceneInput,
): CurrentSceneDocument {
  if (input.plan.status !== 'ready') {
    throw new Error('Draft semantic projection requires a ready character binding plan');
  }

  const factory = new SceneStatementFactory({
    idGenerator: input.statementIdGenerator,
  });
  const usedIds = new Set(input.baseDocument.statements.map((statement) => statement.id));
  const confirmed = new Set(input.confirmedMainCharacters);
  const statements: SceneStatement[] = input.previewStatements.map((preview) => {
    const params = dialogueParamsForPreview(preview, input.plan, confirmed);
    const statement = factory.createStatement({
      type: 'dialogue',
      time: preview.time,
      params,
    }, usedIds);
    usedIds.add(statement.id);
    return statement;
  });

  const raw: CurrentSceneDocument = {
    ...input.baseDocument,
    // In-memory projection only: binding-plan preallocated characters join the
    // projected character directory so performance/cinematic catalogs can
    // address them by id/name; the formal SceneMeta stays untouched until apply.
    meta: {
      ...input.baseDocument.meta,
      ...(input.plan.preallocatedCharacterIds.length > 0
        ? { characters: [
            ...(input.baseDocument.meta.characters ?? []),
            ...preallocatedCharacterEntries(input.plan),
          ] }
        : {}),
    },
    statements: [...input.baseDocument.statements, ...statements]
      .map((statement, index) => ({ statement, index }))
      .sort((left, right) => left.statement.time - right.statement.time || left.index - right.index)
      .map(({ statement }) => statement),
  };

  // ADR-0022: placeholders target only the draft-created dialogues so the
  // projection baseline matches the apply-time baseline (pre-existing formal
  // dialogues are never backfilled by the AI prose apply path).
  const withPlaceholders = materializePerformancePlaceholders(raw, {
    idGenerator: input.statementIdGenerator,
    targetStatementIds: new Set(statements.map((statement) => statement.id)),
  });

  if (input.validate === false) return withPlaceholders;
  return sceneDocumentCodec.parseAndValidate(withPlaceholders);
}

/**
 * Apply a ready binding plan onto formal SceneMeta characters at apply time.
 * Preallocated entries become real characters; existing ids are reused.
 */
export function materializeCharactersFromBindingPlan(
  document: CurrentSceneDocument,
  plan: Extract<CharacterBindingPlanV1, { status: 'ready' }>,
): {
  readonly characters: SceneCharacter[];
  readonly createdCharacterIds: readonly string[];
  readonly characterBindings: Readonly<Record<string, string>>;
} {
  const existing = document.meta.characters ?? [];
  const byId = new Map(existing.map((character) => [character.id, character] as const));
  const characters = [...existing];
  const createdCharacterIds: string[] = [];
  const characterBindings: Record<string, string> = {};

  for (const entry of Object.values(plan.bindings)) {
    characterBindings[entry.name] = entry.speakerId;
    if (byId.has(entry.speakerId)) continue;
    const created: SceneCharacter = { id: entry.speakerId, name: entry.name };
    characters.push(created);
    byId.set(entry.speakerId, created);
    createdCharacterIds.push(entry.speakerId);
  }

  return { characters, createdCharacterIds, characterBindings };
}

export function characterBindingsRecordFromPlan(
  plan: CharacterBindingPlanV1,
): Record<string, string> {
  const record: Record<string, string> = {};
  for (const entry of Object.values(plan.bindings)) {
    record[entry.name] = entry.speakerId;
  }
  return record;
}

function preallocatedCharacterEntries(
  plan: Extract<CharacterBindingPlanV1, { status: 'ready' }>,
): SceneCharacter[] {
  const nameBySpeakerId = new Map(
    Object.values(plan.bindings).map((entry) => [entry.speakerId, entry.name] as const),
  );
  return plan.preallocatedCharacterIds
    .filter((speakerId) => nameBySpeakerId.has(speakerId))
    .map((speakerId) => ({ id: speakerId, name: nameBySpeakerId.get(speakerId)! }));
}

function hasPerformancePlaceholder(companions: readonly DialogueCompanion[]): boolean {  return companions.some((companion) => {
    if (companion.type !== 'characterPerformance') return false;
    const params = companion.params as { target?: unknown; motion?: unknown };
    // Exact empty-string motion is the ADR-0022 placeholder; missing motion with
    // other filled fields is a real performance companion, not a placeholder.
    return params.target === '$speaker'
      && params.motion === ''
      && companion.anchor === 'start'
      && companion.offset === 0;
  });
}

function dialogueParamsForPreview(
  preview: DraftPreviewStatementV1,
  plan: Extract<CharacterBindingPlanV1, { status: 'ready' }>,
  confirmedMainCharacters: ReadonlySet<string>,
): DialogueParams {
  if (preview.speaker === '') {
    return {
      text: preview.text,
      durationSeconds: preview.durationSeconds,
    };
  }
  const params: DialogueParams = {
    speaker: preview.speaker,
    text: preview.text,
    durationSeconds: preview.durationSeconds,
  };
  if (confirmedMainCharacters.has(preview.speaker)) {
    const binding = plan.bindings[preview.speaker];
    if (!binding) {
      throw new Error(`Missing character binding for confirmed speaker "${preview.speaker}"`);
    }
    params.speakerId = binding.speakerId;
  }
  return params;
}

function normalizeConfirmedNames(names: readonly string[]): string[] {
  if (!Array.isArray(names)) {
    throw new Error('confirmedMainCharacters must be an array');
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error('confirmedMainCharacters contains an invalid name');
    }
    if (seen.has(name)) {
      throw new Error(`confirmedMainCharacters contains duplicate name "${name}"`);
    }
    seen.add(name);
    result.push(name);
  }
  return result;
}

function claimGeneratedId(
  name: string,
  usedIds: ReadonlySet<string>,
  idGenerator: CharacterIdGenerator,
): string {
  const id = idGenerator(name, usedIds);
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error(`Character id generator returned an invalid id for "${name}"`);
  }
  if (usedIds.has(id)) {
    throw new Error(`Character id generator returned duplicate id "${id}"`);
  }
  return id;
}

/**
 * Stable FNV-1a character id (`char_xxxxxxxx`) shared by the plan builder, the
 * apply-time binder and the apply-time plan re-validation. Drift between
 * copies would silently re-bind characters on apply (ADR-0022).
 */
export function stableCharacterId(name: string, usedIds: ReadonlySet<string>): string {
  let hash = 2166136261;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const base = `char_${hash.toString(16).padStart(8, '0')}`;
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}
