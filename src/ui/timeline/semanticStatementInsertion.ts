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
  selectCompiledActionsForStatements,
} from './semanticTimelineEditing';
import {
  createSemanticStatementDraftForBlock,
  getSemanticStatementBlock,
  NON_INSERTABLE_SEMANTIC_STATEMENT_BLOCK_IDS,
} from './semanticStatementBlocks';
import {
  insertLifecycleEndFromMenu,
  type LifecycleEndAuthoringMetadata,
} from './insertLifecycleEndCommand';
import { resolveLifecycleTargetBinding } from './lifecycleTargetBinding';
import { resolveActiveLensFiltersAtTime } from '../../services/semantic-scene/LensFilterStatementValidator';

export interface SemanticStatementLibraryInsertOptions {
  readonly blockId: string;
  readonly document: CurrentSceneDocument | null;
  readonly sceneMeta: SceneMeta;
  readonly anchorTime: number;
  readonly origin: AuthoringOrigin;
  readonly scope: AuthoringScope;
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
  const {
    blockId,
    document,
    sceneMeta,
    anchorTime,
    origin,
    scope,
    preferredLifecycleStartStatementIds = new Set<string>(),
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
  const draftInput = {
    sceneMeta,
    charId: scope.kind === 'character' || scope.kind === 'inferred-character' ? scope.charId : null,
    ...(scope.kind === 'character' || scope.kind === 'inferred-character'
      ? { stateTarget: scope.charId }
      : {}),
    ...(currentFilterId ? { currentFilterId } : {}),
    ...(options.dialoguePresentation ? { dialoguePresentation: options.dialoguePresentation } : {}),
    ...(options.dialogueTemplate ? { dialogueTemplate: options.dialogueTemplate } : {}),
  };

  if (document) {
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

export async function submitSemanticStatementLibraryInsert(options: {
  readonly semanticAuthoring: Pick<SemanticAuthoringApplicationService, 'author'>;
  readonly documentStore: Pick<ReadonlyDocumentStore, 'getCompiledSceneSnapshot'>;
  readonly intent: InsertStatementAuthorIntent;
  readonly onSelect: (ids: string[]) => void;
}): Promise<SemanticAuthorReceipt> {
  const receipt = await options.semanticAuthoring.author(options.intent);
  const nextSelected = selectCompiledActionsForStatements(
    options.documentStore.getCompiledSceneSnapshot(),
    receipt.createdStatementIds,
  );
  const selectedIds = Object.keys(nextSelected);
  if (selectedIds.length > 0) options.onSelect(selectedIds);
  return receipt;
}
