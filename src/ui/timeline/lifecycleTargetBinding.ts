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
  listActiveLifecycleWindowsAt,
  resolvePreferredLifecycleBoundaryInsertionOrderAt,
  type LifecycleEndInsertionOrderContext,
  type LifecyclePairRecord,
  type LifecyclePairTable,
} from './lifecyclePairing';

export interface ResolvedLifecycleTargetBinding {
  readonly targetStart: LifecyclePairRecord;
  readonly startStatement: SceneStatement;
  readonly statement: SceneStatementDraft;
  readonly beforeStatementId?: string;
}

export interface ResolveLifecycleTargetBindingOptions {
  readonly insertionOrder?: LifecycleEndInsertionOrderContext;
}

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

/**
 * Contextual target binding for transform/modulate-style inserts.
 * Uses active lifecycle windows (including paired until peer end).
 * No ownership, cascade, or interval enforcement.
 */
export function resolveLifecycleTargetBinding(
  document: CurrentSceneDocument,
  blockId: string,
  atTime: number,
  input: SemanticStatementBlockDraftInput,
  preferredStartStatementIds: ReadonlySet<string> = new Set(),
  table: LifecyclePairTable = buildLifecyclePairTable(document),
  options: ResolveLifecycleTargetBindingOptions = {},
): ResolvedLifecycleTargetBinding | undefined {
  if (NON_INSERTABLE_SEMANTIC_STATEMENT_BLOCK_IDS.has(blockId)) return undefined;
  const block = getSemanticStatementBlock(blockId);
  const command = block?.stateSpanDependencyCommand;
  if (!block || !command) return undefined;
  if (!Number.isFinite(atTime) || atTime < 0) return undefined;

  const insertionOrder = options.insertionOrder
    ?? resolvePreferredLifecycleBoundaryInsertionOrderAt(table, preferredStartStatementIds, atTime);
  let candidates = listActiveLifecycleWindowsAt(table, atTime, {
    ...(insertionOrder ? { insertionOrder } : {}),
  }).filter((record) => (
    record.typeKey === command.presentationTypeKey
  ));

  const preferred = candidates.filter((record) => preferredStartStatementIds.has(record.statementId));
  if (preferred.length > 0) {
    candidates = preferred;
  }

  let sawResolvableStateKey = false;
  const byKey = candidates.filter((record) => {
    const startStatement = document.statements.find((statement) => statement.id === record.statementId);
    if (!startStatement) return false;
    const draft = block.createDraft(draftInputForStart(
      input,
      startStatement,
      preferredStartStatementIds.has(record.statementId),
    ));
    const draftDependency = draft
      ? sceneStatementDefinitionRegistry.timelineStateSpanDependency(draft)
      : undefined;
    if (!draftDependency?.stateKey || draftDependency.presentationTypeKey !== command.presentationTypeKey) return true;
    sawResolvableStateKey = true;
    return record.stateKey === draftDependency.stateKey;
  });
  if (sawResolvableStateKey) {
    candidates = byKey;
  }

  if (candidates.length !== 1) return undefined;

  const targetStart = candidates[0];
  const startStatement = document.statements.find((statement) => statement.id === targetStart.statementId);
  if (!startStatement) return undefined;

  const statement = sceneStatementDefinitionRegistry.materializeStateSpanDependencyDraft(
    startStatement,
    command.statementType,
    command.presentationTypeKey,
    command.paramsTemplate,
  );

  // Order anchor only when inserting at the same time as peer end / supersession boundary.
  let beforeStatementId: string | undefined;
  if (targetStart.status === 'paired' && targetStart.peerId) {
    const peer = table.byStatementId.get(targetStart.peerId);
    if (peer && atTime === peer.time) beforeStatementId = peer.statementId;
  } else if (targetStart.supersededAt && atTime === targetStart.supersededAt.time) {
    beforeStatementId = targetStart.supersededAt.statementId;
  }

  return {
    targetStart,
    startStatement,
    statement,
    ...(beforeStatementId ? { beforeStatementId } : {}),
  };
}

export function listAvailableLifecycleTargetBindingCommandIds(
  document: CurrentSceneDocument,
  atTime: number,
  input: SemanticStatementBlockDraftInput,
  preferredStartStatementIds: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  const table = buildLifecyclePairTable(document);
  const available = new Set<string>();
  for (const block of SEMANTIC_STATEMENT_BLOCKS) {
    if (!block.stateSpanDependencyCommand) continue;
    if (resolveLifecycleTargetBinding(
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

// Compatibility aliases used by existing menu wiring until Task 5/8 renames call sites.
export function resolveStateSpanDependencyCommand(
  document: CurrentSceneDocument,
  blockId: string,
  atTime: number,
  input: SemanticStatementBlockDraftInput,
  preferredStartStatementIds: ReadonlySet<string> = new Set(),
) {
  const resolved = resolveLifecycleTargetBinding(
    document,
    blockId,
    atTime,
    input,
    preferredStartStatementIds,
  );
  if (!resolved) {
    throw new Error(`播放头处没有可添加的活动生命周期目标`);
  }
  return {
    span: {
      startStatement: resolved.startStatement,
      locator: {
        presentationTypeKey: resolved.targetStart.typeKey,
        stateKey: resolved.targetStart.stateKey,
        startStatementId: resolved.targetStart.statementId,
      },
    },
    statement: resolved.statement,
    ...(resolved.beforeStatementId ? { beforeStatementId: resolved.beforeStatementId } : {}),
  };
}

export function listAvailableStateSpanDependencyCommandIds(
  document: CurrentSceneDocument,
  atTime: number,
  input: SemanticStatementBlockDraftInput,
  preferredStartStatementIds: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  return listAvailableLifecycleTargetBindingCommandIds(
    document,
    atTime,
    input,
    preferredStartStatementIds,
  );
}
