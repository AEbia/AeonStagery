import type { CollaborativeSceneStateV2 } from '../../api/types/collaboration';
import type {
  CollaborativeCompanionChanges,
  CollaborativeStatementChanges,
} from './CollaborativeYDocStore';
import {
  addCollaborativeTombstonesForDeletedRecordsV2,
  filterTombstonedCollaborativeRecordsV2,
} from './CollaborativeStateTombstonesV2';
import { jsonEquals } from './CollaborativeJson';

export {
  addCollaborativeTombstonesForDeletedRecordsV2,
  filterTombstonedCollaborativeRecordsV2,
} from './CollaborativeStateTombstonesV2';

export interface CollaborativeStateTransactionCapabilitiesV2 {
  statements: boolean;
  companions: boolean;
}

export type CollaborativeStateTransactionPlanV2 =
  | { kind: 'noop'; state: CollaborativeSceneStateV2 }
  | { kind: 'entity'; entity: 'statements'; changes: CollaborativeStatementChanges; state: CollaborativeSceneStateV2 }
  | { kind: 'entity'; entity: 'companions'; changes: CollaborativeCompanionChanges; state: CollaborativeSceneStateV2 }
  | { kind: 'full'; state: CollaborativeSceneStateV2; reason: string };

export interface CollaborativeStateTransactionPlanOptionsV2 {
  deletedAt?: string;
}

function hasStatementChanges(changes: CollaborativeStatementChanges): boolean {
  return (
    Object.keys(changes.upsertStatements ?? {}).length > 0 ||
    (changes.deleteStatementIds?.length ?? 0) > 0 ||
    !!changes.statementOrder
  );
}

function hasCompanionChanges(changes: CollaborativeCompanionChanges): boolean {
  return (
    Object.keys(changes.upsertCompanions ?? {}).length > 0 ||
    (changes.deleteCompanionIds?.length ?? 0) > 0 ||
    !!changes.companionOrder
  );
}

function baseSceneFactsMatch(
  previousState: CollaborativeSceneStateV2,
  nextState: CollaborativeSceneStateV2,
): boolean {
  return (
    previousState.schemaVersion === nextState.schemaVersion &&
    previousState.sceneSchemaVersion === nextState.sceneSchemaVersion &&
    previousState.collaborationProjectId === nextState.collaborationProjectId &&
    previousState.roomId === nextState.roomId &&
    previousState.sceneId === nextState.sceneId &&
    jsonEquals(previousState.meta, nextState.meta) &&
    jsonEquals(previousState.markersById, nextState.markersById) &&
    jsonEquals(previousState.visual, nextState.visual) &&
    jsonEquals(previousState.assets, nextState.assets) &&
    jsonEquals(previousState.tombstones, nextState.tombstones)
  );
}

export function deriveCollaborativeStatementChangesV2(
  previousState: CollaborativeSceneStateV2,
  nextState: CollaborativeSceneStateV2,
): CollaborativeStatementChanges | null {
  if (!baseSceneFactsMatch(previousState, nextState)) {
    return null;
  }

  const upsertStatements: NonNullable<CollaborativeStatementChanges['upsertStatements']> = {};
  for (const [statementId, nextStatement] of Object.entries(nextState.statementsById)) {
    if (!jsonEquals(previousState.statementsById[statementId], nextStatement)) {
      upsertStatements[statementId] = nextStatement;
    }
  }

  const deleteStatementIds = Object.keys(previousState.statementsById)
    .filter((statementId) => !nextState.statementsById[statementId]);
  const statementOrder = jsonEquals(previousState.statementOrder, nextState.statementOrder)
    ? undefined
    : nextState.statementOrder;

  if (!companionGroupsOnlyRemovedForDeletedStatements(previousState, nextState, deleteStatementIds)) {
    return null;
  }

  return {
    ...(Object.keys(upsertStatements).length > 0 ? { upsertStatements } : {}),
    ...(deleteStatementIds.length > 0 ? { deleteStatementIds } : {}),
    ...(statementOrder ? { statementOrder } : {}),
  };
}

function companionGroupsOnlyRemovedForDeletedStatements(
  previousState: CollaborativeSceneStateV2,
  nextState: CollaborativeSceneStateV2,
  deleteStatementIds: readonly string[],
): boolean {
  const deletedStatements = new Set(deleteStatementIds);
  const previousGroups = previousState.companionGroupsByStatementId ?? {};
  const nextGroups = nextState.companionGroupsByStatementId ?? {};
  const statementIds = new Set([
    ...Object.keys(previousGroups),
    ...Object.keys(nextGroups),
  ]);

  for (const statementId of statementIds) {
    if (deletedStatements.has(statementId)) {
      if (nextGroups[statementId]) return false;
      continue;
    }
    if (!jsonEquals(previousGroups[statementId], nextGroups[statementId])) {
      return false;
    }
  }

  return true;
}

export function deriveCollaborativeCompanionChangesV2(
  previousState: CollaborativeSceneStateV2,
  nextState: CollaborativeSceneStateV2,
): CollaborativeCompanionChanges | null {
  if (
    !baseSceneFactsMatch(previousState, nextState) ||
    !jsonEquals(previousState.statementsById, nextState.statementsById) ||
    !jsonEquals(previousState.statementOrder, nextState.statementOrder)
  ) {
    return null;
  }

  const previousGroups = previousState.companionGroupsByStatementId ?? {};
  const nextGroups = nextState.companionGroupsByStatementId ?? {};
  const changedStatementIds = Array.from(new Set([
    ...Object.keys(previousGroups),
    ...Object.keys(nextGroups),
  ])).filter((statementId) => !jsonEquals(previousGroups[statementId], nextGroups[statementId]));

  if (changedStatementIds.length !== 1) return null;

  const statementId = changedStatementIds[0];
  const previousGroup = previousGroups[statementId] ?? { companionsById: {}, companionOrder: [] };
  const nextGroup = nextGroups[statementId] ?? { companionsById: {}, companionOrder: [] };
  const upsertCompanions: NonNullable<CollaborativeCompanionChanges['upsertCompanions']> = {};

  for (const [companionId, nextCompanion] of Object.entries(nextGroup.companionsById)) {
    if (!jsonEquals(previousGroup.companionsById[companionId], nextCompanion)) {
      upsertCompanions[companionId] = nextCompanion;
    }
  }

  const deleteCompanionIds = Object.keys(previousGroup.companionsById)
    .filter((companionId) => !nextGroup.companionsById[companionId]);
  const companionOrder = jsonEquals(previousGroup.companionOrder, nextGroup.companionOrder)
    ? undefined
    : nextGroup.companionOrder;

  return {
    statementId,
    ...(Object.keys(upsertCompanions).length > 0 ? { upsertCompanions } : {}),
    ...(deleteCompanionIds.length > 0 ? { deleteCompanionIds } : {}),
    ...(companionOrder ? { companionOrder } : {}),
  };
}

function fullPlanV2(
  previousState: CollaborativeSceneStateV2,
  nextState: CollaborativeSceneStateV2,
  reason: string,
  deletedAt?: string,
): CollaborativeStateTransactionPlanV2 {
  return {
    kind: 'full',
    reason,
    state: filterTombstonedCollaborativeRecordsV2(
      addCollaborativeTombstonesForDeletedRecordsV2(previousState, nextState, deletedAt),
    ),
  };
}

export function planCollaborativeStateTransactionV2(
  previousState: CollaborativeSceneStateV2,
  nextState: CollaborativeSceneStateV2,
  capabilities: CollaborativeStateTransactionCapabilitiesV2,
  options: CollaborativeStateTransactionPlanOptionsV2 = {},
): CollaborativeStateTransactionPlanV2 {
  const previous = filterTombstonedCollaborativeRecordsV2(previousState);
  const next = filterTombstonedCollaborativeRecordsV2(nextState);

  if (jsonEquals(previous, next)) {
    return { kind: 'noop', state: next };
  }

  const statementChanges = deriveCollaborativeStatementChangesV2(previous, next);
  if (statementChanges && hasStatementChanges(statementChanges)) {
    return capabilities.statements
      ? { kind: 'entity', entity: 'statements', changes: statementChanges, state: next }
      : fullPlanV2(previous, next, 'missing-statements-capability', options.deletedAt);
  }

  const companionChanges = deriveCollaborativeCompanionChangesV2(previous, next);
  if (companionChanges && hasCompanionChanges(companionChanges)) {
    return capabilities.companions
      ? { kind: 'entity', entity: 'companions', changes: companionChanges, state: next }
      : fullPlanV2(previous, next, 'missing-companions-capability', options.deletedAt);
  }

  return fullPlanV2(previous, next, 'cross-entity-or-scene-change', options.deletedAt);
}
