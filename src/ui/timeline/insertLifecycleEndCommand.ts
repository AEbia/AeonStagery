import {
  AUTHORING_SCHEMA_VERSION,
  type AuthoringOrigin,
  type InsertStatementAuthorIntent,
  type SemanticAuthorIntent,
} from '../../api/types/authoring';
import type { CurrentSceneDocument, SceneStatement, SceneStatementDraft } from '../../api/types/semantic-scene';
import { sceneStatementDefinitionRegistry } from '../../services/semantic-scene';
import {
  NON_INSERTABLE_SEMANTIC_STATEMENT_BLOCK_IDS,
  SEMANTIC_STATEMENT_BLOCKS,
  getSemanticStatementBlock,
  type SemanticStatementBlockDraftInput,
} from './semanticStatementBlocks';
import {
  buildLifecyclePairTable,
  listEndableLifecyclesAt,
  resolvePreferredLifecycleBoundaryInsertionOrderAt,
  resolveLifecyclePair,
  type LifecycleEndInsertionOrderContext,
  type LifecyclePairRecord,
  type LifecyclePairTable,
} from './lifecyclePairing';

export interface LifecycleEndAuthoringMetadata {
  readonly correlationId: string;
  readonly origin: AuthoringOrigin;
}

export interface ResolveLifecycleEndCommandResult {
  readonly targetStart: LifecyclePairRecord;
  readonly startStatement: SceneStatement;
  readonly endTemplate: SceneStatementDraft;
  readonly beforeStatementId?: string;
}

export interface ResolveLifecycleEndCommandOptions {
  readonly insertionOrder?: LifecycleEndInsertionOrderContext;
}

export type InsertLifecycleEndResult =
  | { readonly ok: true; readonly intent: InsertStatementAuthorIntent }
  | { readonly ok: false; readonly reason: 'stale' | 'not-found' | 'ambiguous' | 'invalid-draft'; readonly message: string };

function draftInputForStart(
  input: SemanticStatementBlockDraftInput,
  startStatement: SceneStatement,
  forceStartTarget = false,
): SemanticStatementBlockDraftInput {
  const params = startStatement.params as Record<string, unknown>;
  const nextInput = { ...input };
  const forceCharacterId = (id: string) => {
    nextInput.charId = id;
    const sceneMeta = nextInput.sceneMeta;
    if (sceneMeta && !sceneMeta.characters?.some((character) => character.id === id)) {
      nextInput.sceneMeta = {
        ...sceneMeta,
        characters: [...(sceneMeta.characters ?? []), { id, name: id }],
      };
    }
  };

  if (forceStartTarget || nextInput.charId == null) {
    if (startStatement.type === 'characterPresence' && typeof params.id === 'string') {
      forceCharacterId(params.id);
    } else if (
      startStatement.type === 'visualStyle'
      && params.scope === 'object'
      && typeof params.target === 'string'
    ) {
      forceCharacterId(params.target);
    }
  }

  if (
    (forceStartTarget || nextInput.stateTarget === undefined)
    && startStatement.type === 'lighting'
    && typeof params.target === 'string'
  ) {
    nextInput.stateTarget = params.target;
  }

  return nextInput;
}

function buildEndDraftFromTemplate(
  blockId: string,
  startStatement: SceneStatement,
  input: SemanticStatementBlockDraftInput,
): SceneStatementDraft | undefined {
  const block = getSemanticStatementBlock(blockId);
  if (!block?.lifecycleEndCommand) return undefined;

  const template = block.createDraft(draftInputForStart(input, startStatement));
  const templateParams = (template?.params ?? {}) as Readonly<Record<string, unknown>>;
  const templateLifecycle = template
    ? sceneStatementDefinitionRegistry.timelineLifecyclePresentation(template)
    : undefined;

  // Prefer template transition defaults when present; registry materialize fills target fields.
  const transitionField = templateLifecycle?.definition.transitionDurationFields?.end;
  const transitionDurationSeconds = transitionField && typeof templateParams[transitionField] === 'number'
    ? Math.max(0, templateParams[transitionField] as number)
    : templateLifecycle?.transitionDurationSeconds ?? 0;

  return sceneStatementDefinitionRegistry.materializeLifecycleEndDraft(
    startStatement,
    transitionDurationSeconds,
    templateParams,
  );
}

function beforeStatementIdForTarget(
  target: LifecyclePairRecord,
): string | undefined {
  return target.supersededAt?.statementId;
}

export function resolveLifecycleEndCommand(
  document: CurrentSceneDocument,
  blockId: string,
  atTime: number,
  input: SemanticStatementBlockDraftInput,
  preferredStartStatementIds: ReadonlySet<string> = new Set(),
  table: LifecyclePairTable = buildLifecyclePairTable(document),
  options: ResolveLifecycleEndCommandOptions = {},
): ResolveLifecycleEndCommandResult | undefined {
  if (NON_INSERTABLE_SEMANTIC_STATEMENT_BLOCK_IDS.has(blockId)) return undefined;
  const block = getSemanticStatementBlock(blockId);
  const command = block?.lifecycleEndCommand;
  if (!block || !command) return undefined;

  const insertionOrder = options.insertionOrder
    ?? resolvePreferredLifecycleBoundaryInsertionOrderAt(table, preferredStartStatementIds, atTime);
  const endable = listEndableLifecyclesAt(table, atTime, {
    ...(insertionOrder ? { insertionOrder } : {}),
  }).filter((record) => (
    record.typeKey === command.presentationTypeKey
  ));

  const preferred = endable.filter((record) => preferredStartStatementIds.has(record.statementId));
  let candidates = preferred.length > 0 ? preferred : endable;

  if (command.match === 'draft-state-key') {
    // Build the probe against each candidate start so preferred starts do not inherit
    // a stale editor-selected target, while sibling visual reset commands stay exact.
    let sawResolvableStateKey = false;
    const byKey = candidates.filter((record) => {
      const startStatement = document.statements.find((statement) => statement.id === record.statementId);
      if (!startStatement) return false;
      const probeDraft = block.createDraft(draftInputForStart(
        input,
        startStatement,
        preferredStartStatementIds.has(record.statementId),
      ));
      const probeLifecycle = probeDraft
        ? sceneStatementDefinitionRegistry.timelineLifecyclePresentation(probeDraft)
        : undefined;
      if (!probeLifecycle?.stateKey) return true;
      sawResolvableStateKey = true;
      return record.stateKey === probeLifecycle.stateKey;
    });
    if (sawResolvableStateKey) candidates = byKey;
  }

  if (candidates.length === 0) return undefined;
  if (candidates.length > 1 && preferred.length === 0 && command.match !== 'unique-active') {
    // Prefer unique-active strictness only when match says so; otherwise still ambiguous.
  }
  if (candidates.length > 1) return undefined;

  const targetStart = candidates[0];
  const startStatement = document.statements.find((statement) => statement.id === targetStart.statementId);
  if (!startStatement) return undefined;

  const endTemplate = buildEndDraftFromTemplate(blockId, startStatement, input);
  if (!endTemplate) return undefined;

  const endLifecycle = sceneStatementDefinitionRegistry.timelineLifecyclePresentation(endTemplate);
  if (!endLifecycle || endLifecycle.boundary !== 'end') return undefined;
  if (endLifecycle.definition.presentationTypeKey !== command.presentationTypeKey) return undefined;

  return {
    targetStart,
    startStatement,
    endTemplate,
    ...(beforeStatementIdForTarget(targetStart)
      ? { beforeStatementId: beforeStatementIdForTarget(targetStart) }
      : {}),
  };
}

export function listAvailableLifecycleEndCommandIds(
  document: CurrentSceneDocument,
  atTime: number,
  input: SemanticStatementBlockDraftInput,
  preferredStartStatementIds: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  const table = buildLifecyclePairTable(document);
  const available = new Set<string>();
  for (const block of SEMANTIC_STATEMENT_BLOCKS) {
    if (!block.lifecycleEndCommand) continue;
    if (resolveLifecycleEndCommand(
      document,
      block.id,
      atTime,
      input,
      preferredStartStatementIds,
      table,
    )) {
      available.add(block.id);
    }
  }
  return available;
}

/**
 * Internal helper: emit existing insert-statement intent only.
 * Re-resolves endability against the current document (stale menu protection).
 * Does not move existing ends (plan D13).
 */
export function insertLifecycleEndCommand(
  document: CurrentSceneDocument,
  args: {
    readonly targetStartStatementId: string;
    readonly time: number;
    readonly blockId: string;
    readonly input?: SemanticStatementBlockDraftInput;
    readonly metadata: LifecycleEndAuthoringMetadata;
  },
): InsertLifecycleEndResult {
  if (NON_INSERTABLE_SEMANTIC_STATEMENT_BLOCK_IDS.has(args.blockId)) {
    return { ok: false, reason: 'invalid-draft', message: '该语句仅保留旧场景兼容，不能新建' };
  }
  const table = buildLifecyclePairTable(document);
  const target = resolveLifecyclePair(table, args.targetStartStatementId);
  if (!target || target.role !== 'start') {
    return { ok: false, reason: 'not-found', message: '找不到要结束的生命周期开始语句' };
  }

  const beforeStatementId = beforeStatementIdForTarget(target);
  const endable = listEndableLifecyclesAt(table, args.time, {
    ...(beforeStatementId ? { insertionOrder: { beforeStatementId } } : {}),
  });
  if (!endable.some((record) => record.statementId === args.targetStartStatementId)) {
    return {
      ok: false,
      reason: 'stale',
      message: '该生命周期已结束或不可在此时结束',
    };
  }

  const startStatement = document.statements.find((statement) => statement.id === args.targetStartStatementId);
  if (!startStatement) {
    return { ok: false, reason: 'not-found', message: '找不到要结束的生命周期开始语句' };
  }

  const block = getSemanticStatementBlock(args.blockId);
  if (!block?.lifecycleEndCommand) {
    return { ok: false, reason: 'invalid-draft', message: `未知结束命令: ${args.blockId}` };
  }
  if (block.lifecycleEndCommand.presentationTypeKey !== target.typeKey) {
    return { ok: false, reason: 'invalid-draft', message: '结束命令与生命周期类型不匹配' };
  }

  const endTemplate = buildEndDraftFromTemplate(
    args.blockId,
    startStatement,
    args.input ?? {},
  );
  if (!endTemplate) {
    return { ok: false, reason: 'invalid-draft', message: '无法生成结束语句草稿' };
  }

  const intent: InsertStatementAuthorIntent = {
    version: AUTHORING_SCHEMA_VERSION,
    correlationId: args.metadata.correlationId,
    origin: args.metadata.origin,
    kind: 'insert-statement',
    anchorTime: args.time,
    ...(beforeStatementId
      ? { beforeStatementId }
      : {}),
    statement: endTemplate,
  };

  return { ok: true, intent };
}

/** Convenience: resolve then insert in one shot for menu clicks. */
export function insertLifecycleEndFromMenu(
  document: CurrentSceneDocument,
  blockId: string,
  atTime: number,
  input: SemanticStatementBlockDraftInput,
  metadata: LifecycleEndAuthoringMetadata,
  preferredStartStatementIds: ReadonlySet<string> = new Set(),
): InsertLifecycleEndResult {
  const resolved = resolveLifecycleEndCommand(
    document,
    blockId,
    atTime,
    input,
    preferredStartStatementIds,
  );
  if (!resolved) {
    return {
      ok: false,
      reason: 'not-found',
      message: '此处没有可结束的匹配生命周期',
    };
  }
  return insertLifecycleEndCommand(document, {
    targetStartStatementId: resolved.targetStart.statementId,
    time: atTime,
    blockId,
    input,
    metadata,
  });
}

export type { SemanticAuthorIntent };
