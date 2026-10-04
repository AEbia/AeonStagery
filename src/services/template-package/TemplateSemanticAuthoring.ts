import {
  AUTHORING_SCHEMA_VERSION,
  type AuthoringOrigin,
  type AuthoringScope,
  type SemanticAuthorIntent,
} from '../../api/types/authoring';
import {
  SCENE_SCHEMA_VERSION_V5,
  type DialogueCompanionDraft,
  type SceneStatement,
  type SceneStatementDraft,
  type StatementFamily,
} from '../../api/types/semantic-scene';
import { sceneStatementDefinitionRegistry } from '../semantic-scene';
import type { TemplateAuthoringCombo, TemplateAuthoringComboPayload } from './TemplatePackageManifest';

export interface TemplateSemanticAuthoringInput {
  anchorTime: number;
  correlationId: string;
  origin?: AuthoringOrigin;
  scope?: AuthoringScope;
}

export interface TemplateAuthoringPreview {
  intent: SemanticAuthorIntent;
  statements: SceneStatementDraft[];
  rootCount: number;
  companionCount: number;
  summaryLines: string[];
}

export function buildTemplateAuthoringPreview(
  combo: Pick<TemplateAuthoringCombo, 'payload'>,
  input: TemplateSemanticAuthoringInput,
): TemplateAuthoringPreview | null {
  if (!combo.payload) return null;
  const intent = payloadToSemanticIntent(combo.payload, input);
  const statements = intent.kind === 'insert-statement'
    ? [intent.statement]
    : intent.kind === 'insert-script-segment'
      ? intent.statements
      : [];
  const companionCount = statements.reduce(
    (count, statement) => count + (statement.companions?.length ?? 0),
    0,
  );
  return {
    intent,
    statements,
    rootCount: statements.length,
    companionCount,
    summaryLines: statements.map((statement) => {
      const relativeTime = statement.time ?? 0;
      const companionLabel = statement.companions?.length
        ? `, ${statement.companions.length} companions`
        : '';
      return `${statement.type} at +${relativeTime}s${companionLabel}`;
    }),
  };
}

export function templateAuthoringComboToSemanticIntent(
  combo: Pick<TemplateAuthoringCombo, 'payload'>,
  input: TemplateSemanticAuthoringInput,
): SemanticAuthorIntent | null {
  return buildTemplateAuthoringPreview(combo, input)?.intent ?? null;
}

export function payloadToSemanticIntent(
  payload: TemplateAuthoringComboPayload,
  input: TemplateSemanticAuthoringInput,
): SemanticAuthorIntent {
  const base = {
    version: AUTHORING_SCHEMA_VERSION,
    correlationId: input.correlationId,
    origin: input.origin ?? 'template-config',
    ...(input.scope ? { scope: input.scope } : {}),
  } as const;

  switch (payload.kind) {
    case 'statementPreset':
      return {
        ...base,
        kind: 'insert-statement',
        anchorTime: input.anchorTime,
        statement: applyScopePlaceholders(
          parseTemplateStatementDraft(payload.statement, 'payload.statement'),
          input.scope,
        ),
      };
    case 'dialoguePreset':
      return {
        ...base,
        kind: 'insert-statement',
        anchorTime: input.anchorTime,
        statement: applyScopePlaceholders(parseTemplateDialoguePreset(payload), input.scope),
      };
    case 'timelineFragment':
      return {
        ...base,
        kind: 'insert-script-segment',
        anchorTime: input.anchorTime,
        statements: payload.statements.map((statement, index) =>
          applyScopePlaceholders(
            parseTemplateStatementDraft(statement, `payload.statements[${index}]`),
            input.scope,
          ),
        ),
      };
  }
}

function applyScopePlaceholders(
  draft: SceneStatementDraft,
  scope: AuthoringScope | undefined,
): SceneStatementDraft {
  if (!scope || scope.kind === 'none') return draft;
  const charId = scope.charId;
  const isBlankMenuTrack = scope.kind === 'inferred-character' && scope.source === 'blank-menu-track';
  const replaced = replaceCharacterPlaceholder(draft, charId) as SceneStatementDraft;

  if (replaced.params && typeof replaced.params === 'object') {
    const params = { ...replaced.params } as Record<string, unknown>;
    if (replaced.type === 'characterPresence' || replaced.type === 'characterTransform') {
      if (!params.id || params.id === '$character' || isBlankMenuTrack) {
        params.id = charId;
      }
    } else if (replaced.type === 'characterPerformance') {
      if (!params.target || params.target === '$character' || isBlankMenuTrack) {
        params.target = charId;
      }
    } else if (replaced.type === 'dialogue') {
      if (!params.speakerId || params.speakerId === '$character' || isBlankMenuTrack) {
        params.speakerId = charId;
      }
      if (!params.speaker || params.speaker === '$character' || isBlankMenuTrack) {
        params.speaker = charId;
      }
    } else if (replaced.type === 'visualStyle' && params.scope === 'object') {
      if (!params.target || params.target === '$character' || isBlankMenuTrack) {
        params.target = charId;
      }
    }
    replaced.params = params;
  }

  if (replaced.companions && Array.isArray(replaced.companions)) {
    replaced.companions = replaced.companions.map((companion) => {
      const c = { ...companion };
      if (c.params && typeof c.params === 'object') {
        const cParams = { ...c.params } as Record<string, unknown>;
        if (c.type === 'characterPresence' || c.type === 'characterTransform') {
          if (!cParams.id || cParams.id === '$character' || isBlankMenuTrack) {
            cParams.id = charId;
          }
        } else if (c.type === 'characterPerformance') {
          if (!cParams.target || cParams.target === '$character' || isBlankMenuTrack) {
            cParams.target = charId;
          }
        } else if (c.type === 'visualStyle' && cParams.scope === 'object') {
          if (!cParams.target || cParams.target === '$character' || isBlankMenuTrack) {
            cParams.target = charId;
          }
        }
        c.params = cParams;
      }
      return c;
    });
  }

  return replaced;
}

function replaceCharacterPlaceholder(value: unknown, charId: string): unknown {
  if (value === '$character') return charId;
  if (Array.isArray(value)) return value.map((item) => replaceCharacterPlaceholder(item, charId));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, nested]) => [key, replaceCharacterPlaceholder(nested, charId)]),
    );
  }
  return value;
}

export function parseTemplateDialoguePreset(payload: Extract<TemplateAuthoringComboPayload, { kind: 'dialoguePreset' }>): SceneStatementDraft {
  const dialogue = parseTemplateStatementDraft(payload.dialogue, 'payload.dialogue');
  if (dialogue.type !== 'dialogue') {
    throw new Error(`dialoguePreset payload.dialogue must be a dialogue statement, got "${dialogue.type}"`);
  }
  return {
    ...dialogue,
    companions: (payload.companions ?? []).map((companion, index) =>
      parseTemplateCompanionDraft(companion, `payload.companions[${index}]`),
    ),
  };
}

export function parseTemplateStatementDraft(input: unknown, path: string): SceneStatementDraft {
  const record = expectRecord(input, path);
  assertNoLegacyStatementShape(record, path);
  expectKeys(record, path, ['id', 'time', 'type', 'params', 'companions', 'sceneSchemaVersion']);
  const type = expectStatementFamily(record.type, `${path}.type`);
  const sceneSchemaVersion = optionalSceneSchemaVersion(record.sceneSchemaVersion, `${path}.sceneSchemaVersion`);
  const draft = compact({
    id: optionalString(record.id, `${path}.id`),
    time: optionalNonNegativeNumber(record.time, `${path}.time`),
    type,
    params: sceneStatementDefinitionRegistry.parseParams(type, record.params, `${path}.params`),
    companions: parseOptionalCompanions(record.companions, `${path}.companions`, type),
    ...(sceneSchemaVersion !== undefined ? { sceneSchemaVersion } : {}),
  });
  return draft as SceneStatementDraft;
}

export const validateTemplateStatementDraft = parseTemplateStatementDraft;

export function parseTemplateCompanionDraft(input: unknown, path: string): DialogueCompanionDraft {
  const record = expectRecord(input, path);
  assertNoLegacyStatementShape(record, path);
  expectKeys(record, path, ['id', 'anchor', 'offset', 'type', 'params', 'sceneSchemaVersion']);
  const type = expectStatementFamily(record.type, `${path}.type`);
  const sceneSchemaVersion = optionalSceneSchemaVersion(record.sceneSchemaVersion, `${path}.sceneSchemaVersion`);
  const companion = compact({
    id: optionalString(record.id, `${path}.id`),
    anchor: optionalAnchor(record.anchor, `${path}.anchor`) ?? 'start',
    offset: optionalFiniteNumber(record.offset, `${path}.offset`) ?? 0,
    type,
    params: sceneStatementDefinitionRegistry.parseParams(type, record.params, `${path}.params`),
    ...(sceneSchemaVersion !== undefined ? { sceneSchemaVersion } : {}),
  }) as DialogueCompanionDraft;
  const attachableProbe = {
    type: companion.type,
    params: companion.params,
  } as Pick<SceneStatement, 'type' | 'params'>;
  if (!sceneStatementDefinitionRegistry.isAttachableToDialogue(attachableProbe)) {
    throw new Error(`Statement family ${type} is not attachable to dialogue at ${path}`);
  }
  return companion;
}

export const validateTemplateCompanionDraft = parseTemplateCompanionDraft;

function assertNoLegacyStatementShape(record: Record<string, unknown>, path: string): void {
  const legacyKeys = ['actionsById', 'timeline', 'action', 'ActionType', 'actions', 'actionType'];
  for (const key of legacyKeys) {
    if (key in record) {
      throw new Error(`Legacy action-based property "${key}" is not supported in statement draft at ${path}`);
    }
  }
}

function expectKeys(record: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw new Error(`Unexpected property "${key}" at ${path}`);
    }
  }
}

function optionalSceneSchemaVersion(input: unknown, path: string): 4 | 5 | undefined {
  if (input === undefined) return undefined;
  if (input !== 4 && input !== SCENE_SCHEMA_VERSION_V5) {
    throw new Error(`Invalid sceneSchemaVersion at ${path}: expected 4 or 5, got ${String(input)}`);
  }
  return input;
}

function parseOptionalCompanions(
  input: unknown,
  path: string,
  parentType: StatementFamily,
): DialogueCompanionDraft[] | undefined {
  if (input === undefined) return undefined;
  if (parentType !== 'dialogue') {
    throw new Error(`Only dialogue statement drafts can declare companions at ${path}`);
  }
  if (!Array.isArray(input)) throw new Error(`Expected array at ${path}`);
  return input.map((companion, index) => parseTemplateCompanionDraft(companion, `${path}[${index}]`));
}

function expectStatementFamily(input: unknown, path: string): StatementFamily {
  if (typeof input !== 'string' || !sceneStatementDefinitionRegistry.has(input)) {
    throw new Error(`Unknown statement family at ${path}: "${String(input)}"`);
  }
  return input;
}

function expectRecord(input: unknown, path: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`Expected object at ${path}`);
  }
  return input as Record<string, unknown>;
}

function optionalString(input: unknown, path: string): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error(`Expected non-empty string at ${path}`);
  }
  return input;
}

function optionalFiniteNumber(input: unknown, path: string): number | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new Error(`Expected finite number at ${path}`);
  }
  return input;
}

function optionalNonNegativeNumber(input: unknown, path: string): number | undefined {
  const value = optionalFiniteNumber(input, path);
  if (value !== undefined && value < 0) {
    throw new Error(`Expected non-negative number at ${path}`);
  }
  return value;
}

function optionalAnchor(input: unknown, path: string): 'start' | 'end' | undefined {
  if (input === undefined) return undefined;
  if (input !== 'start' && input !== 'end') {
    throw new Error(`Invalid value at ${path}: "${String(input)}". Expected start, end`);
  }
  return input;
}

function compact<T extends Record<string, unknown>>(record: T): T {
  const next = { ...record };
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key];
  }
  return next;
}
