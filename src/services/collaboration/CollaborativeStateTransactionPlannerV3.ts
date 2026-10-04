import type { CollaborativeSceneStateV3 } from '../../api/types/collaboration';
import type {
  CollaborativeCompanionChanges,
  CollaborativeStatementChanges,
} from './CollaborativeYDocStore';
import {
  addCollaborativeTombstonesForDeletedRecordsV3,
  filterTombstonedCollaborativeRecordsV3,
} from './CollaborativeStateTombstonesV2';
import { jsonEquals } from './CollaborativeJson';

export {
  addCollaborativeTombstonesForDeletedRecordsV3,
  filterTombstonedCollaborativeRecordsV3,
} from './CollaborativeStateTombstonesV2';

export interface CollaborativeStateTransactionCapabilitiesV3 {
  statements: boolean;
  companions: boolean;
}

export type CollaborativeStateTransactionPlanV3 =
  | { kind: 'noop'; state: CollaborativeSceneStateV3 }
  | { kind: 'entity'; entity: 'statements'; changes: CollaborativeStatementChanges; state: CollaborativeSceneStateV3 }
  | { kind: 'entity'; entity: 'companions'; changes: CollaborativeCompanionChanges; state: CollaborativeSceneStateV3 }
  | { kind: 'full'; state: CollaborativeSceneStateV3; reason: string };

export interface CollaborativeStateTransactionPlanOptionsV3 {
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
  previousState: CollaborativeSceneStateV3,
  nextState: CollaborativeSceneStateV3,
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

export function deriveCollaborativeStatementChangesV3(
  previousState: CollaborativeSceneStateV3,
  nextState: CollaborativeSceneStateV3,
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
  previousState: CollaborativeSceneStateV3,
  nextState: CollaborativeSceneStateV3,
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

export function deriveCollaborativeCompanionChangesV3(
  previousState: CollaborativeSceneStateV3,
  nextState: CollaborativeSceneStateV3,
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

function fullPlanV3(
  previousState: CollaborativeSceneStateV3,
  nextState: CollaborativeSceneStateV3,
  reason: string,
  deletedAt?: string,
): CollaborativeStateTransactionPlanV3 {
  return {
    kind: 'full',
    reason,
    state: filterTombstonedCollaborativeRecordsV3(
      addCollaborativeTombstonesForDeletedRecordsV3(previousState, nextState, deletedAt),
    ),
  };
}

export function planCollaborativeStateTransactionV3(
  previousState: CollaborativeSceneStateV3,
  nextState: CollaborativeSceneStateV3,
  capabilities: CollaborativeStateTransactionCapabilitiesV3,
  options: CollaborativeStateTransactionPlanOptionsV3 = {},
): CollaborativeStateTransactionPlanV3 {
  const previous = filterTombstonedCollaborativeRecordsV3(previousState);
  const next = filterTombstonedCollaborativeRecordsV3(nextState);

  if (jsonEquals(previous, next)) {
    return { kind: 'noop', state: next };
  }

  const statementChanges = deriveCollaborativeStatementChangesV3(previous, next);
  if (statementChanges && hasStatementChanges(statementChanges)) {
    return capabilities.statements
      ? { kind: 'entity', entity: 'statements', changes: statementChanges, state: next }
      : fullPlanV3(previous, next, 'missing-statements-capability', options.deletedAt);
  }

  const companionChanges = deriveCollaborativeCompanionChangesV3(previous, next);
  if (companionChanges && hasCompanionChanges(companionChanges)) {
    return capabilities.companions
      ? { kind: 'entity', entity: 'companions', changes: companionChanges, state: next }
      : fullPlanV3(previous, next, 'missing-companions-capability', options.deletedAt);
  }

  return fullPlanV3(previous, next, 'cross-entity-or-scene-change', options.deletedAt);
}
