import { AUTHORING_SCHEMA_VERSION, type SemanticAuthorIntent, type SemanticAuthorReceipt, type SemanticAuthoringLocator } from '../../api/types/authoring';
import type { CurrentSceneDocument, DialogueCompanion, SceneStatement, SceneStatementDraft } from '../../api/types/semantic-scene';
import type { AuthoringOrigin } from '../../api/types/authoring';
import type { SemanticAuthoringApplicationService } from '../../services/timeline-authoring/SemanticAuthoringApplicationService';
import type { ReadonlyDocumentStore } from '../store/DocumentStore';
import {
  buildSemanticCopyBufferForTimelineActions,
  buildSemanticDeleteTimelineIntents,
  buildSemanticDuplicateTimelineIntent,
  buildSemanticPasteTimelineIntent,
  buildSemanticTimelineParamUpdateIntent,
  createSemanticTimelineCorrelationId,
  defaultDialogueStatementDraft,
  locatorForTimelineAction,
  selectCompiledActionsForStatements,
} from './semanticTimelineEditing';
import { buildSemanticTimelineReadModel } from './semanticTimelineReadModel';

type CommandStore = Pick<ReadonlyDocumentStore, 'getCurrentSceneDocumentSnapshot' | 'getCompiledSceneSnapshot'>;
export type SourceParamPatch = Readonly<Record<string, unknown>>
  | ((params: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>);

/** A full form edits only fields changed from its displayed snapshot. */
function sourceParamsPatch(before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>) {
  const patch: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) patch[key] = after[key];
  }
  return patch;
}

/** Select one display row per created root, including roots without runtime actions. */
export function selectCreatedTimelineStatements(
  store: Pick<CommandStore, 'getCompiledSceneSnapshot'> & Partial<CommandStore>,
  statementIds: readonly string[],
): Record<string, boolean> {
  const document = store.getCurrentSceneDocumentSnapshot?.();
  const compiled = store.getCompiledSceneSnapshot();
  if (!document) return selectCompiledActionsForStatements(compiled, statementIds);
  const wanted = new Set(statementIds);
  return Object.fromEntries(buildSemanticTimelineReadModel(document, compiled)
    .filter((item) => item.locator.kind === 'statement' && wanted.has(item.statementId))
    .map((item) => [item.id, true]));
}

export function createSemanticTimelineCommands(options: {
  store: CommandStore;
  authoring: Pick<SemanticAuthoringApplicationService, 'author' | 'authorTransaction'> | undefined;
  blockOffline: () => boolean;
  select: (ids: Record<string, boolean>) => void;
  onError?: (error: unknown) => void;
}) {
  const { store, authoring, select } = options;
  async function run(
    commit: (service: NonNullable<typeof authoring>) => Promise<SemanticAuthorReceipt> | undefined,
    selection: 'created' | 'clear' | 'keep',
  ) {
    if (options.blockOffline() || !authoring) return;
    try {
      const pending = commit(authoring);
      if (!pending) return;
      const receipt = await pending;
      if (selection === 'clear') select({});
      if (!receipt) return;
      if (selection === 'created') {
        const ids = selectCreatedTimelineStatements(store, receipt.createdStatementIds);
        if (Object.keys(ids).length) select(ids);
      }
      return receipt;
    } catch (error) {
      if (!options.onError) throw error;
      options.onError(error);
      return undefined;
    }
  }

  const commands = {
    insert: (intent: SemanticAuthorIntent) => run((service) => service.author(intent), 'created'),
    addDialogue: (time: number) => run((service) => {
      const document = store.getCurrentSceneDocumentSnapshot();
      if (!document) return;
      return service.author({
        version: AUTHORING_SCHEMA_VERSION,
        correlationId: createSemanticTimelineCorrelationId('timeline_add'),
        origin: 'timeline-editor',
        kind: 'insert-statement',
        anchorTime: Math.max(0, Math.round(time * 10) / 10),
        statement: defaultDialogueStatementDraft(document),
      });
    }, 'created'),
    duplicate: (ids: readonly string[]) => run((service) => {
      const intent = buildSemanticDuplicateTimelineIntent(store, ids);
      return intent ? service.author(intent) : undefined;
    }, 'created'),
    paste: (buffer: readonly SceneStatementDraft[], time: number,
      origin: AuthoringOrigin = 'timeline-editor') => run((service) => {
      const intent = buildSemanticPasteTimelineIntent(buffer, time, createSemanticTimelineCorrelationId('timeline_paste'), origin);
      return intent ? service.author(intent) : undefined;
    }, 'created'),
    delete: (ids: readonly string[]) => run((service) => {
      const intents = buildSemanticDeleteTimelineIntents(store, ids);
      return intents.length ? service.authorTransaction(intents) : undefined;
    }, 'clear'),
    copy: (ids: readonly string[]) => buildSemanticCopyBufferForTimelineActions(store, ids),
    updateSourceParams: (id: string | SemanticAuthoringLocator, patch: SourceParamPatch, replace = false) => {
      const locator = typeof id === 'string' ? locatorForTimelineAction(store, id) : id;
      if (!locator) return Promise.resolve(undefined);
      return run((service) => service.authorTransaction((document) => {
        const statement = document.statements.find((candidate) => candidate.id === locator.statementId);
        const source = locator.kind === 'companion'
          ? statement?.companions?.find((candidate) => candidate.id === locator.companionId)
          : statement;
        if (!source) throw new Error('语句已不存在');
        const sourceParams = source.params as Record<string, unknown>;
        const changes = typeof patch === 'function' ? patch(sourceParams) : patch;
        const params: Record<string, unknown> = replace ? { ...changes } : { ...sourceParams, ...changes };
        for (const key of Object.keys(params)) if (params[key] === undefined) delete params[key];
        const base = { version: AUTHORING_SCHEMA_VERSION, correlationId: createSemanticTimelineCorrelationId('timeline_source_param'), origin: 'timeline-editor' as const };
        return [locator.kind === 'companion'
          ? { ...base, kind: 'update-dialogue-companion', locator, patch: { params } as Partial<DialogueCompanion> }
          : { ...base, kind: 'update-statement', statementId: locator.statementId, patch: { params } as Partial<SceneStatement> }];
      }), 'keep');
    },
    updateTimelineParams: (id: string, patch: Readonly<Record<string, unknown>>) => run((service) => (
      service.authorTransaction((document: CurrentSceneDocument) => {
        const intent = buildSemanticTimelineParamUpdateIntent({
          getCurrentSceneDocumentSnapshot: () => document,
          getCompiledSceneSnapshot: () => store.getCompiledSceneSnapshot(),
        }, id, patch);
        if (!intent) throw new Error('语句已不存在');
        return [intent];
      })
    ), 'keep'),
  };
  return {
    ...commands,
    replaceSourceParams: (id: string | SemanticAuthoringLocator, params: Readonly<Record<string, unknown>>,
      displayedParams: Readonly<Record<string, unknown>>) => (
      commands.updateSourceParams(id, sourceParamsPatch(displayedParams, params))
    ),
  };
}
