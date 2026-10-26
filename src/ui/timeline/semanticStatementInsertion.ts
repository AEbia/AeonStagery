import { type LightingTarget, lightingTargetKey, resolveLightingTarget } from '../../api/types/lighting-target';
import type {
  AuthoringOrigin,
  AuthoringScope,
  InsertStatementAuthorIntent,
  SemanticAuthorReceipt,
} from '../../api/types/authoring';
import { AUTHORING_SCHEMA_VERSION } from '../../api/types/authoring';
import type { SceneMeta } from '../../api/types/scene-common';
import type { CurrentSceneDocument, DialogueImagePresentation } from '../../api/types/semantic-scene';
import type { SemanticAuthoringApplicationService } from '../../services/timeline-authoring/SemanticAuthoringApplicationService';
import type { ReadonlyDocumentStore } from '../store/DocumentStore';
import {
  createSemanticTimelineCorrelationId,
} from './semanticTimelineEditing';
import { selectCreatedTimelineStatements } from './semanticTimelineCommands';
import {
  createSemanticStatementDraftForBlock,
  getSemanticStatementBlock,
  NON_INSERTABLE_SEMANTIC_STATEMENT_BLOCK_IDS,
  SEMANTIC_STATEMENT_BLOCKS,
} from './semanticStatementBlocks';
import {
  insertLifecycleEndFromMenu,
  type LifecycleEndAuthoringMetadata,
} from './insertLifecycleEndCommand';
import { resolveLifecycleTargetBinding } from './lifecycleTargetBinding';
import { buildLifecyclePairTable, type LifecyclePairTable } from './lifecyclePairing';
import { resolveActiveLensFiltersAtTime } from '../../services/semantic-scene/LensFilterStatementValidator';

export interface SemanticStatementLibraryInsertOptions {
  readonly blockId: string;
  readonly document: CurrentSceneDocument | null;
  readonly sceneMeta: SceneMeta;
  readonly anchorTime: number;
  readonly origin: AuthoringOrigin;
  readonly scope: AuthoringScope;
  readonly lightingTarget?: LightingTarget;
  readonly preferredLifecycleStartStatementIds?: ReadonlySet<string>;
  readonly correlationPrefix?: string;
  readonly lifecycleEndCorrelationPrefix?: string;
  readonly lifecycleTargetBindingCorrelationPrefix?: string;
  readonly dialoguePresentation?: DialogueImagePresentation;
  readonly dialogueTemplate?: 'glass' | 'minimal' | 'classic';
  readonly beforeStatementId?: string;
}

export type SemanticStatementLibraryInsertResult =
  | { readonly kind: 'intent'; readonly intent: InsertStatementAuthorIntent }
  | { readonly kind: 'warning'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message?: string };

export function buildSemanticStatementLibraryInsert(
  options: SemanticStatementLibraryInsertOptions,
): SemanticStatementLibraryInsertResult {
  return resolveSemanticStatementLibraryInsert(options);
}

function resolveSemanticStatementLibraryInsert(
  options: SemanticStatementLibraryInsertOptions,
  lifecycleTable?: LifecyclePairTable,
): SemanticStatementLibraryInsertResult {
  const {
    blockId,
    document,
    sceneMeta,
    anchorTime,
    origin,
    scope,
    preferredLifecycleStartStatementIds: selectedStarts = new Set<string>(),
    correlationPrefix = 'statement_library_insert',
    lifecycleEndCorrelationPrefix,
    lifecycleTargetBindingCorrelationPrefix,
  } = options;
  if (NON_INSERTABLE_SEMANTIC_STATEMENT_BLOCK_IDS.has(blockId)) {
    return { kind: 'unavailable' };
  }
  const endCorrelationPrefix = lifecycleEndCorrelationPrefix
    ?? `${correlationPrefix}_lifecycle_end`;
  const targetBindingCorrelationPrefix = lifecycleTargetBindingCorrelationPrefix
    ?? `${correlationPrefix}_lifecycle_target_binding`;
  const currentFilterId = document
    ? resolveActiveLensFiltersAtTime(document, anchorTime)[0]?.recipeId
    : undefined;
  const charId = scope.kind === 'character' || scope.kind === 'inferred-character' ? scope.charId : null;
  const lightingTarget = options.lightingTarget ?? (charId ? { kind: 'character' as const, id: charId } : undefined);
  const characterIds = new Set((document?.meta.characters ?? sceneMeta.characters ?? []).map((character) => character.id));
  const preferredLifecycleStartStatementIds = new Set([...selectedStarts].filter((id) => {
    const statement = document?.statements.find((candidate) => candidate.id === id);
    if (!lightingTarget || statement?.type !== 'lighting') return true;
    const { effect } = statement.params;
    if (effect !== 'blur' && effect !== 'post') return true;
    const rowTarget = resolveLightingTarget(lightingTarget, effect, characterIds);
    // Individual environment layers share the row whose default target is the whole group.
    if (rowTarget.kind === 'group' && rowTarget.group === 'environmentLayers'
      && resolveLightingTarget(statement.params.target, effect, characterIds).kind === 'environmentLayer') return true;
    return lightingTargetKey(statement.params.target, effect, characterIds) === lightingTargetKey(lightingTarget, effect, characterIds);
  }));
  const draftInput = {
    sceneMeta,
    charId,
    ...(charId ? { stateTarget: charId } : {}),
    lightingTarget,
    ...(currentFilterId ? { currentFilterId } : {}),
    ...(options.dialoguePresentation ? { dialoguePresentation: options.dialoguePresentation } : {}),
    ...(options.dialogueTemplate ? { dialogueTemplate: options.dialogueTemplate } : {}),
  };

  if (document) {
    const table = lifecycleTable ?? buildLifecyclePairTable(document);
    const endResult = insertLifecycleEndFromMenu(
      document,
      blockId,
      anchorTime,
      draftInput,
      {
        correlationId: createSemanticTimelineCorrelationId(endCorrelationPrefix),
        origin,
      } satisfies LifecycleEndAuthoringMetadata,
      preferredLifecycleStartStatementIds,
      table,
    );
    if (endResult.ok) return { kind: 'intent', intent: endResult.intent };
    if (endResult.reason === 'stale') {
      return { kind: 'warning', message: endResult.message };
    }

    const dependencyCommand = resolveLifecycleTargetBinding(
      document,
      blockId,
      anchorTime,
      draftInput,
      preferredLifecycleStartStatementIds,
      table,
    );
    if (dependencyCommand) {
      return {
        kind: 'intent',
        intent: {
          version: AUTHORING_SCHEMA_VERSION,
          correlationId: createSemanticTimelineCorrelationId(targetBindingCorrelationPrefix),
          origin,
          scope,
          kind: 'insert-statement',
          anchorTime,
          ...(dependencyCommand.beforeStatementId
            ? { beforeStatementId: dependencyCommand.beforeStatementId }
            : options.beforeStatementId
              ? { beforeStatementId: options.beforeStatementId }
              : {}),
          statement: dependencyCommand.statement,
        },
      };
    }
  }

  const blockMeta = getSemanticStatementBlock(blockId);
  if (document && blockMeta?.stateSpanDependencyCommand) {
    return { kind: 'warning', message: '此处没有可变化的匹配生命周期' };
  }
  if (blockMeta?.lifecycleEndCommand) {
    return { kind: 'warning', message: '此处没有可结束的匹配生命周期' };
  }

  const statement = createSemanticStatementDraftForBlock(blockId, draftInput);
  if (!statement) {
    return {
      kind: 'unavailable',
      // @deprecated Kept only for callers replaying the removed filter entry.
      ...(blockId === 'filter.change' ? { message: '当前时间没有可变化的镜头滤镜' } : {}),
    };
  }

  return {
    kind: 'intent',
    intent: {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: createSemanticTimelineCorrelationId(correlationPrefix),
      origin,
      scope,
      kind: 'insert-statement',
      anchorTime,
      ...(options.beforeStatementId ? { beforeStatementId: options.beforeStatementId } : {}),
      statement,
    },
  };
}

/** Availability and insertion cross the same seam and resolve the same authoring context. */
export function prepareSemanticStatementLibraryMenu(
  options: Omit<SemanticStatementLibraryInsertOptions, 'blockId'>,
) {
  const lifecycleTable = options.document ? buildLifecyclePairTable(options.document) : undefined;
  const results = new Map<string, SemanticStatementLibraryInsertResult>();
  const resolve = (blockId: string): SemanticStatementLibraryInsertResult => {
    const cached = results.get(blockId);
    if (cached) return cached;
    const result = resolveSemanticStatementLibraryInsert({ ...options, blockId }, lifecycleTable);
    results.set(blockId, result);
    return result;
  };
  const available = (command: 'lifecycleEndCommand' | 'stateSpanDependencyCommand'): ReadonlySet<string> => {
    const ids = new Set<string>();
    if (options.document) {
      for (const block of SEMANTIC_STATEMENT_BLOCKS) {
        if (block[command] && resolve(block.id).kind === 'intent') ids.add(block.id);
      }
    }
    return ids;
  };
  return {
    resolve,
    get availableLifecycleEndCommandIds() { return available('lifecycleEndCommand'); },
    get availableLifecycleTargetBindingCommandIds() { return available('stateSpanDependencyCommand'); },
  };
}

export async function submitSemanticStatementLibraryInsert(options: {
  readonly semanticAuthoring: Pick<SemanticAuthoringApplicationService, 'author'>;
  readonly documentStore: Pick<ReadonlyDocumentStore, 'getCompiledSceneSnapshot'>
    & Partial<Pick<ReadonlyDocumentStore, 'getCurrentSceneDocumentSnapshot'>>;
  readonly intent: InsertStatementAuthorIntent;
  readonly onSelect: (ids: string[]) => void;
}): Promise<SemanticAuthorReceipt> {
  const receipt = await options.semanticAuthoring.author(options.intent);
  const nextSelected = selectCreatedTimelineStatements(
    options.documentStore,
    receipt.createdStatementIds,
  );
  const selectedIds = Object.keys(nextSelected);
  if (selectedIds.length > 0) options.onSelect(selectedIds);
  return receipt;
}
