import {
  SCENE_SCHEMA_VERSION,
  type DialogueCompanion,
  type CurrentSceneDocument,
  type CurrentSceneMeta,
  type SceneStatement,
  type StatementFamily,
  type StatementParamsByFamily,
} from '../../api/types/semantic-scene';
import type { SceneVisualBlock } from '../../api/types/visual';
import { SceneDocumentCodec, sceneDocumentCodec } from './SceneDocumentCodec';
import {
  SceneStatementDefinitionRegistry,
  sceneStatementDefinitionRegistry,
} from './SceneStatementDefinitionRegistry';

export type SceneStatementIdGenerator = (prefix: string) => string;

export type SceneStatementCreationDraft = {
  readonly [Family in StatementFamily]: {
    readonly id?: string;
    readonly time?: number;
    readonly type: Family;
    readonly params: StatementParamsByFamily[Family];
    readonly companions?: readonly DialogueCompanionCreationDraft[];
  };
}[StatementFamily];

export type DialogueCompanionCreationDraft = {
  readonly [Family in StatementFamily]: {
    readonly id?: string;
    readonly anchor?: 'start' | 'end';
    readonly offset?: number;
    readonly type: Family;
    readonly params: StatementParamsByFamily[Family];
  };
}[StatementFamily];

export interface SceneDocumentCreationInput {
  readonly sceneId?: string;
  readonly meta: CurrentSceneMeta;
  readonly visual?: SceneVisualBlock;
  readonly statements?: readonly SceneStatementCreationDraft[];
}

export interface InsertStatementOptions {
  readonly placement?: 'time' | 'append';
  readonly beforeStatementId?: string;
  readonly afterStatementId?: string;
}

export interface DuplicateStatementOptions {
  readonly timeOffsetSeconds?: number;
  readonly placement?: InsertStatementOptions['placement'];
}

export interface SceneStatementFactoryOptions {
  readonly idGenerator?: SceneStatementIdGenerator;
  readonly codec?: SceneDocumentCodec;
  readonly registry?: SceneStatementDefinitionRegistry;
}

const FAMILY_ID_PREFIX: Record<StatementFamily, string> = {
  dialogue: 'dlg',
  dialogueVisibility: 'dlg_visibility',
  characterPresence: 'char_presence',
  characterTransform: 'char_transform',
  characterPerformance: 'char_perf',
  camera: 'camera',
  environmentLayer: 'env',
  visualStyle: 'visual_style',
  filterAdd: 'filter_add',
  filterChange: 'filter_change',
  filterReset: 'filter_reset',
  lighting: 'lighting',
  audio: 'audio',
  graphicLayer: 'graphic',
  customAnimation: 'custom_anim',
};

export class SceneStatementFactory {
  private readonly idGenerator: SceneStatementIdGenerator;
  private readonly codec: SceneDocumentCodec;
  private readonly registry: SceneStatementDefinitionRegistry;

  constructor(options: SceneStatementFactoryOptions = {}) {
    this.idGenerator = options.idGenerator ?? defaultIdGenerator;
    this.codec = options.codec ?? sceneDocumentCodec;
    this.registry = options.registry ?? sceneStatementDefinitionRegistry;
  }

  createDocument(input: SceneDocumentCreationInput): CurrentSceneDocument {
    const sceneId = input.sceneId ?? this.claimGeneratedId('scene', new Set());
    const usedStatementIds = new Set<string>();
    const statements = (input.statements ?? []).map((draft) =>
      this.materializeStatement(draft, usedStatementIds),
    );

    return this.codec.parseAndValidate({
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId,
      meta: cloneJson(input.meta),
      ...(input.visual ? { visual: cloneJson(input.visual) } : {}),
      statements,
    });
  }

  createStatement(
    draft: SceneStatementCreationDraft,
    existingStatementIds: Iterable<string> = [],
  ): SceneStatement {
    const usedStatementIds = new Set(existingStatementIds);
    return this.materializeStatement(draft, usedStatementIds);
  }

  insertStatement(
    document: CurrentSceneDocument,
    draft: SceneStatementCreationDraft,
    options: InsertStatementOptions = {},
  ): CurrentSceneDocument {
    const usedStatementIds = new Set(document.statements.map((statement) => statement.id));
    const statement = this.materializeStatement(draft, usedStatementIds);
    const statements = [...document.statements];
    const insertIndex = this.resolveInsertIndex(statements, statement, options);
    statements.splice(insertIndex, 0, statement);
    return this.validateNextDocument({
      ...document,
      statements,
    });
  }

  duplicateStatement(
    document: CurrentSceneDocument,
    statementId: string,
    options: DuplicateStatementOptions = {},
  ): CurrentSceneDocument {
    const statement = document.statements.find((candidate) => candidate.id === statementId);
    if (!statement) throw new Error(`Cannot duplicate missing statement "${statementId}"`);
    const draft = {
      ...cloneJson(statement),
      id: undefined,
      time: statement.time + (options.timeOffsetSeconds ?? 0),
    } as SceneStatementCreationDraft;
    return this.insertStatement(document, draft, { placement: options.placement ?? 'time' });
  }

  appendDialogueCompanion(
    document: CurrentSceneDocument,
    statementId: string,
    draft: DialogueCompanionCreationDraft,
  ): CurrentSceneDocument {
    const statement = document.statements.find((candidate) => candidate.id === statementId);
    if (!statement) throw new Error(`Cannot append companion to missing statement "${statementId}"`);
    if (statement.type !== 'dialogue') {
      throw new Error(`Only dialogue statements can own companions: ${statementId}`);
    }

    const usedCompanionIds = new Set((statement.companions ?? []).map((companion) => companion.id));
    const companion = this.materializeCompanion(draft, usedCompanionIds);
    return this.validateNextDocument({
      ...document,
      statements: document.statements.map((candidate) =>
        candidate.id === statementId
          ? {
              ...candidate,
              companions: [...(candidate.companions ?? []), companion],
            }
          : candidate,
      ),
    });
  }

  withExplicitDuration(document: CurrentSceneDocument, durationSeconds: number | undefined): CurrentSceneDocument {
    const nextMeta = { ...document.meta };
    if (durationSeconds === undefined) {
      delete nextMeta.durationSeconds;
    } else {
      nextMeta.durationSeconds = durationSeconds;
    }
    return this.validateNextDocument({
      ...document,
      meta: nextMeta,
    });
  }

  private materializeStatement(
    draft: SceneStatementCreationDraft,
    usedStatementIds: Set<string>,
  ): SceneStatement {
    const id = this.claimId(draft.id, FAMILY_ID_PREFIX[draft.type], usedStatementIds);
    const companionIds = new Set<string>();
    const companions = draft.companions?.map((companion) =>
      this.materializeCompanion(companion, companionIds),
    );
    return compact({
      id,
      time: draft.time ?? 0,
      type: draft.type,
      params: cloneJson(draft.params),
      companions,
    }) as SceneStatement;
  }

  private materializeCompanion(
    draft: DialogueCompanionCreationDraft,
    usedCompanionIds: Set<string>,
  ): DialogueCompanion {
    return {
      id: this.claimId(draft.id, `cmp_${FAMILY_ID_PREFIX[draft.type]}`, usedCompanionIds),
      anchor: draft.anchor ?? 'start',
      offset: draft.offset ?? 0,
      type: draft.type,
      params: cloneJson(draft.params),
    } as DialogueCompanion;
  }

  private claimId(explicitId: string | undefined, prefix: string, usedIds: Set<string>): string {
    if (explicitId !== undefined) {
      if (usedIds.has(explicitId)) throw new Error(`Duplicate id "${explicitId}"`);
      usedIds.add(explicitId);
      return explicitId;
    }
    return this.claimGeneratedId(prefix, usedIds);
  }

  private claimGeneratedId(prefix: string, usedIds: Set<string>): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = this.idGenerator(prefix);
      if (!usedIds.has(id)) {
        usedIds.add(id);
        return id;
      }
    }
    throw new Error(`Could not generate a unique id for prefix "${prefix}"`);
  }

  private resolveInsertIndex(
    statements: readonly SceneStatement[],
    statement: SceneStatement,
    options: InsertStatementOptions,
  ): number {
    if (options.beforeStatementId && options.afterStatementId) {
      throw new Error('Cannot insert a statement both before and after another statement');
    }
    if (options.beforeStatementId) {
      const index = statements.findIndex((candidate) => candidate.id === options.beforeStatementId);
      if (index === -1) throw new Error(`Cannot insert before missing statement "${options.beforeStatementId}"`);
      return index;
    }
    if (options.afterStatementId) {
      const index = statements.findIndex((candidate) => candidate.id === options.afterStatementId);
      if (index === -1) throw new Error(`Cannot insert after missing statement "${options.afterStatementId}"`);
      return index + 1;
    }
    if (options.placement === 'append') return statements.length;
    const firstLaterIndex = statements.findIndex((candidate) => candidate.time > statement.time);
    return firstLaterIndex === -1 ? statements.length : firstLaterIndex;
  }

  private validateNextDocument(document: CurrentSceneDocument): CurrentSceneDocument {
    return this.codec.parseAndValidate({
      ...document,
      meta: this.syncExplicitDuration(document),
    });
  }

  private syncExplicitDuration(document: CurrentSceneDocument): CurrentSceneMeta {
    if (document.meta.durationSeconds === undefined) return cloneJson(document.meta);
    return {
      ...cloneJson(document.meta),
      durationSeconds: Math.max(document.meta.durationSeconds, this.computeSceneEnd(document)),
    };
  }

  /** 场景内全部语句 + 伴随语句的实际末尾(秒),不含显式场景时长。 */
  public computeSceneEnd(document: CurrentSceneDocument): number {
    let end = 0;
    for (const statement of document.statements) {
      const statementExtent = this.registry.temporalExtent(statement);
      end = Math.max(end, statement.time + statementExtent);
      for (const companion of statement.companions ?? []) {
        const companionTime =
          statement.time +
          (companion.anchor === 'end' ? statementExtent : 0) +
          companion.offset;
        const companionAsStatement = {
          id: companion.id,
          time: companionTime,
          type: companion.type,
          params: companion.params,
        } as SceneStatement;
        end = Math.max(end, companionTime + this.registry.temporalExtent(companionAsStatement));
      }
    }
    return end;
  }
}

export const sceneStatementFactory = new SceneStatementFactory();

function defaultIdGenerator(prefix: string): string {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}_${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function compact<T extends Record<string, unknown>>(record: T): T {
  const next = { ...record };
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key];
  }
  return next;
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
