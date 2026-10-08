import type { SemanticAuthoringLocator } from '../../api/types/authoring';
import type {
  CompiledAction,
  CompiledScene,
  DialogueCompanion,
  CurrentSceneDocument,
  SceneStatement,
  StatementCategory,
  StatementFamily,
} from '../../api/types/semantic-scene';
import { sceneStatementDefinitionRegistry } from '../../services/semantic-scene';
import { createLifecycleStatementOrderMap } from './lifecyclePairing';
import type { TimelineAction } from './semanticTimelineTypes';

export interface SemanticTimelineLifecycleBoundaryPresentation {
  readonly presentationTypeKey: string;
  readonly boundary: 'start' | 'end';
}

export interface SemanticTimelineReadModelItem {
  readonly id: string;
  readonly locator: SemanticAuthoringLocator;
  readonly statementId: string;
  readonly companionId?: string;
  /** Display id of the owning root statement when this item is a companion. */
  readonly parentItemId?: string;
  /** Companion timing facts retained for timeline relationship presentation. */
  readonly companionAnchor?: DialogueCompanion['anchor'];
  readonly companionOffsetSeconds?: number;
  readonly time: number;
  readonly durationSeconds: number;
  readonly source: SceneStatement | DialogueCompanion;
  readonly lifecycleBoundaryPresentation?: SemanticTimelineLifecycleBoundaryPresentation;
  /** Runtime-shaped data retained only for existing timeline interaction components. */
  readonly displayAction: TimelineAction;
}

interface SortableSemanticTimelineReadModelItem extends SemanticTimelineReadModelItem {
  readonly statementOrder: number;
  readonly companionOrder: number;
}

type CompiledActionIndex = Map<string, Map<string | undefined, CompiledAction>>;

export function buildSemanticTimelineReadModel(
  document: CurrentSceneDocument | null,
  compiled: CompiledScene | null,
): SemanticTimelineReadModelItem[] {
  if (!document) return [];

  const compiledActions: CompiledActionIndex = new Map();
  for (const action of compiled?.actions ?? []) {
    const { statementId, companionId } = action.source;
    let byCompanion = compiledActions.get(statementId);
    if (!byCompanion) {
      byCompanion = new Map();
      compiledActions.set(statementId, byCompanion);
    }
    // A source can lower to several runtime actions; preserve the first one.
    if (!byCompanion.has(companionId)) byCompanion.set(companionId, action);
  }
  const items: SortableSemanticTimelineReadModelItem[] = [];
  const statementOrderByStatementId = createLifecycleStatementOrderMap(document);
  for (const statement of document.statements) {
    const statementOrder = statementOrderByStatementId.get(statement.id)!;
    addItem(items, statement, compiledActions, statementOrder, -1);
    for (const [companionOrder, companion] of (statement.companions ?? []).entries()) {
      addItem(
        items,
        companion,
        compiledActions,
        statementOrder,
        companionOrder,
        statement,
      );
    }
  }
  const sorted = items.sort(compareReadModelItems);
  const rootIdByStatementId = new Map(
    sorted
      .filter((item) => item.locator.kind === 'statement')
      .map((item) => [item.statementId, item.id]),
  );
  return sorted.map((item) => toReadModelItem(item, rootIdByStatementId));
}

function addItem(
  items: SortableSemanticTimelineReadModelItem[],
  source: SceneStatement | DialogueCompanion,
  compiledActions: CompiledActionIndex,
  statementOrder: number,
  companionOrder: number,
  parent?: SceneStatement,
): void {
  const statementId = parent?.id ?? source.id;
  const companionId = parent ? source.id : undefined;
  const locator: SemanticAuthoringLocator = parent
    ? { kind: 'companion', statementId, companionId: source.id }
    : { kind: 'statement', statementId };
  const sourceStatement = parent ?? source as SceneStatement;
  const time = parent
    ? parent.time
      + ((source as DialogueCompanion).anchor === 'end'
        ? sceneStatementDefinitionRegistry.temporalExtent(parent)
        : 0)
      + (source as DialogueCompanion).offset
    : (source as SceneStatement).time;
  const durationSeconds = sceneStatementDefinitionRegistry.temporalExtent(source as SceneStatement);
  const compiledAction = compiledActions.get(statementId)?.get(companionId);
  const semanticDisplay = getSemanticTimelineDisplay(source);
  const lifecycle = sceneStatementDefinitionRegistry.timelineLifecyclePresentation(source);
  const lifecycleBoundaryPresentation = lifecycle
    ? {
        presentationTypeKey: lifecycle.definition.presentationTypeKey,
        boundary: lifecycle.boundary,
      }
    : undefined;
  const sourceParams = source.params as Record<string, any>;
  const displayAction: TimelineAction = compiledAction
    ? {
        _id: compiledAction.id,
        statementId,
        companionId,
        time: compiledAction.time,
        action: compiledAction.action,
        params: compiledAction.params,
        sourceParams,
        ...semanticDisplay,
      }
    : {
        _id: source.id,
        statementId,
        companionId,
        time,
        action: source.type,
        params: sourceParams,
        sourceParams,
        ...semanticDisplay,
      };

  // ADR-0022: an uncompiled $speaker characterPerformance placeholder carries
  // no runtime action, so the compiler never resolves its target. Resolve the
  // parent dialogue speakerId here for timeline track placement and lists.
  // The resolution also survives the performance stage filling the empty
  // motion (target stays the literal $speaker token), so surfaces reading the
  // raw source target keep seeing the auto-bound character.
  if (
    parent
    && source.type === 'characterPerformance'
    && sourceParams.target === '$speaker'
  ) {
    const parentSpeakerId = (parent.params as { readonly speakerId?: string }).speakerId;
    if (parentSpeakerId) displayAction.resolvedSpeakerId = parentSpeakerId;
  }

  items.push({
    id: displayAction._id ?? locatorKey(locator),
    locator,
    statementId,
    ...(companionId ? { companionId } : {}),
    ...(parent
      ? {
          companionAnchor: (source as DialogueCompanion).anchor,
          companionOffsetSeconds: (source as DialogueCompanion).offset,
        }
      : {}),
    time,
    durationSeconds,
    source: parent ? source : sourceStatement,
    ...(lifecycleBoundaryPresentation ? { lifecycleBoundaryPresentation } : {}),
    displayAction,
    statementOrder,
    companionOrder,
  });
}

function compareReadModelItems(
  left: SortableSemanticTimelineReadModelItem,
  right: SortableSemanticTimelineReadModelItem,
): number {
  return left.time - right.time
    || left.statementOrder - right.statementOrder
    || left.companionOrder - right.companionOrder
    || left.id.localeCompare(right.id);
}

function toReadModelItem(
  item: SortableSemanticTimelineReadModelItem,
  rootIdByStatementId: ReadonlyMap<string, string>,
): SemanticTimelineReadModelItem {
  return {
    id: item.id,
    locator: item.locator,
    statementId: item.statementId,
    ...(item.companionId ? { companionId: item.companionId } : {}),
    ...(item.companionId
      ? {
          parentItemId: rootIdByStatementId.get(item.statementId),
          ...(item.companionAnchor ? { companionAnchor: item.companionAnchor } : {}),
          ...(item.companionOffsetSeconds !== undefined
            ? { companionOffsetSeconds: item.companionOffsetSeconds }
            : {}),
        }
      : {}),
    time: item.time,
    durationSeconds: item.durationSeconds,
    source: item.source,
    ...(item.lifecycleBoundaryPresentation
      ? { lifecycleBoundaryPresentation: item.lifecycleBoundaryPresentation }
      : {}),
    displayAction: item.displayAction,
  };
}

function locatorKey(locator: SemanticAuthoringLocator): string {
  return locator.kind === 'companion'
    ? `${locator.statementId}:companion:${locator.companionId}`
    : `statement:${locator.statementId}`;
}

function getSemanticTimelineDisplay(source: SceneStatement | DialogueCompanion): {
  semanticType: StatementFamily;
  semanticCategory: StatementCategory;
  semanticLabel: string;
  semanticIconKey: string;
} {
  const definition = sceneStatementDefinitionRegistry.get(source.type);
  const presentation = sceneStatementDefinitionRegistry.timelinePresentation(source);
  return {
    semanticType: source.type,
    semanticCategory: definition.category,
    semanticLabel: presentation.label,
    semanticIconKey: presentation.iconKey,
  };
}
