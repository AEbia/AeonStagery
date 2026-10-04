import type {
  CollaborativeCompanionGroup,
  CollaborativeSceneStateV2,
  CollaborativeSceneStateV3,
  CollaborativeStatementRecord,
  CollaborativeTombstoneRecord,
  CollaborativeTombstonesV2,
  CollaborativeTombstonesV3,
} from '../../api/types/collaboration';
import type { SceneVisualBlock } from '../../api/types/visual';

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function filterRecordMapByTombstones<T>(
  records: Record<string, T> | undefined,
  tombstones: Record<string, CollaborativeTombstoneRecord> | undefined,
): Record<string, T> | undefined {
  if (!records) return undefined;
  const entries = Object.entries(records)
    .filter(([id]) => !tombstones?.[id])
    .map(([id, record]) => [id, cloneJson(record)] as const);
  return entries.length > 0 ? Object.fromEntries(entries) as Record<string, T> : undefined;
}

function filterVisualByTombstones(
  visual: SceneVisualBlock | undefined,
  tombstones: CollaborativeTombstonesV2 | undefined,
): SceneVisualBlock | undefined {
  if (!visual) return undefined;
  const next: SceneVisualBlock = {};
  const visualTargets = filterRecordMapByTombstones(visual.visualTargets, tombstones?.visualTargets);
  const segments = filterRecordMapByTombstones(visual.segments, tombstones?.segments);
  const recipeOverlay = filterRecordMapByTombstones(visual.recipeOverlay, tombstones?.recipeOverlay);

  if (visualTargets) next.visualTargets = visualTargets;
  if (segments) next.segments = segments;
  if (recipeOverlay) next.recipeOverlay = recipeOverlay;

  return Object.keys(next).length > 0 ? next : undefined;
}

function filterCompanionGroupsByTombstones(
  groups: Record<string, CollaborativeCompanionGroup> | undefined,
  liveStatementsById: Record<string, CollaborativeStatementRecord>,
  tombstones: CollaborativeTombstonesV2 | undefined,
): Record<string, CollaborativeCompanionGroup> | undefined {
  if (!groups) return undefined;
  const next: Record<string, CollaborativeCompanionGroup> = {};

  Object.entries(groups).forEach(([statementId, group]) => {
    if (!liveStatementsById[statementId]) return;
    const companionTombstones = tombstones?.companions?.[statementId];
    const companionsById = filterRecordMapByTombstones(group.companionsById, companionTombstones) ?? {};
    const companionOrder = group.companionOrder
      .filter((companionId) => !companionTombstones?.[companionId]);

    if (Object.keys(companionsById).length > 0 || companionOrder.length > 0) {
      next[statementId] = { companionsById, companionOrder };
    }
  });

  return Object.keys(next).length > 0 ? next : undefined;
}

export function filterTombstonedCollaborativeRecordsV2(
  state: CollaborativeSceneStateV2,
): CollaborativeSceneStateV2 {
  const tombstones = state.tombstones;
  if (!tombstones) return state;

  const statementsById = filterRecordMapByTombstones(
    state.statementsById,
    tombstones.statements,
  ) ?? {};
  const statementOrder = state.statementOrder.filter((statementId) => !tombstones.statements?.[statementId]);
  const companionGroupsByStatementId = filterCompanionGroupsByTombstones(
    state.companionGroupsByStatementId,
    statementsById,
    tombstones,
  );
  const markersById = filterRecordMapByTombstones(state.markersById, tombstones.markers);
  const visual = filterVisualByTombstones(state.visual, tombstones);
  const assets = filterRecordMapByTombstones(state.assets, tombstones.assets);
  const {
    companionGroupsByStatementId: _companionGroupsByStatementId,
    markersById: _markersById,
    visual: _visual,
    assets: _assets,
    ...base
  } = state;

  return {
    ...base,
    statementsById,
    statementOrder,
    ...(companionGroupsByStatementId ? { companionGroupsByStatementId } : {}),
    ...(markersById ? { markersById } : {}),
    ...(visual ? { visual } : {}),
    ...(assets ? { assets } : {}),
  };
}

function deletedRecordIds(
  previousRecords: Record<string, unknown> | undefined,
  nextRecords: Record<string, unknown> | undefined,
): string[] {
  return Object.keys(previousRecords ?? {})
    .filter((id) => !nextRecords?.[id]);
}

function addDeletedIdsToTombstoneSection(
  tombstones: CollaborativeTombstonesV2,
  sectionKey: Exclude<keyof CollaborativeTombstonesV2, 'companions'>,
  ids: string[],
  deletedAt: string,
): boolean {
  if (ids.length === 0) return false;
  const section = {
    ...((tombstones[sectionKey] as Record<string, CollaborativeTombstoneRecord> | undefined) ?? {}),
  };
  let changed = false;
  for (const id of ids) {
    if (section[id]) continue;
    section[id] = { id, deletedAt };
    changed = true;
  }
  if (!changed) return false;
  (tombstones as Record<string, unknown>)[sectionKey] = section;
  return true;
}

function addDeletedCompanionsToTombstones(
  tombstones: CollaborativeTombstonesV2,
  previousState: CollaborativeSceneStateV2,
  nextState: CollaborativeSceneStateV2,
  deletedAt: string,
): boolean {
  const companionTombstones = cloneJson(tombstones.companions ?? {});
  let changed = false;

  for (const [statementId, previousGroup] of Object.entries(previousState.companionGroupsByStatementId ?? {})) {
    const nextGroup = nextState.companionGroupsByStatementId?.[statementId];
    const deletedCompanionIds = deletedRecordIds(previousGroup.companionsById, nextGroup?.companionsById);
    if (deletedCompanionIds.length === 0) continue;

    const section = { ...(companionTombstones[statementId] ?? {}) };
    let sectionChanged = false;
    for (const companionId of deletedCompanionIds) {
      if (section[companionId]) continue;
      section[companionId] = { id: companionId, deletedAt };
      sectionChanged = true;
    }
    if (sectionChanged) {
      companionTombstones[statementId] = section;
      changed = true;
    }
  }

  if (changed) tombstones.companions = companionTombstones;
  return changed;
}

export function addCollaborativeTombstonesForDeletedRecordsV2(
  previousState: CollaborativeSceneStateV2,
  nextState: CollaborativeSceneStateV2,
  deletedAt = new Date().toISOString(),
): CollaborativeSceneStateV2 {
  const tombstones: CollaborativeTombstonesV2 = cloneJson(nextState.tombstones ?? {});
  let changed = false;

  changed = addDeletedIdsToTombstoneSection(
    tombstones,
    'statements',
    deletedRecordIds(previousState.statementsById, nextState.statementsById),
    deletedAt,
  ) || changed;
  changed = addDeletedCompanionsToTombstones(
    tombstones,
    previousState,
    nextState,
    deletedAt,
  ) || changed;
  changed = addDeletedIdsToTombstoneSection(
    tombstones,
    'markers',
    deletedRecordIds(previousState.markersById, nextState.markersById),
    deletedAt,
  ) || changed;
  changed = addDeletedIdsToTombstoneSection(
    tombstones,
    'visualTargets',
    deletedRecordIds(previousState.visual?.visualTargets, nextState.visual?.visualTargets),
    deletedAt,
  ) || changed;
  changed = addDeletedIdsToTombstoneSection(
    tombstones,
    'segments',
    deletedRecordIds(previousState.visual?.segments, nextState.visual?.segments),
    deletedAt,
  ) || changed;
  changed = addDeletedIdsToTombstoneSection(
    tombstones,
    'recipeOverlay',
    deletedRecordIds(previousState.visual?.recipeOverlay, nextState.visual?.recipeOverlay),
    deletedAt,
  ) || changed;
  changed = addDeletedIdsToTombstoneSection(
    tombstones,
    'assets',
    deletedRecordIds(previousState.assets, nextState.assets),
    deletedAt,
  ) || changed;

  return changed ? { ...nextState, tombstones } : nextState;
}

export function filterTombstonedCollaborativeRecordsV3(
  state: CollaborativeSceneStateV3,
): CollaborativeSceneStateV3 {
  const tombstones = state.tombstones;
  if (!tombstones) return state;

  const statementsById = filterRecordMapByTombstones(
    state.statementsById,
    tombstones.statements,
  ) ?? {};
  const statementOrder = state.statementOrder.filter((statementId) => !tombstones.statements?.[statementId]);
  const companionGroupsByStatementId = filterCompanionGroupsByTombstones(
    state.companionGroupsByStatementId,
    statementsById,
    tombstones,
  );
  const markersById = filterRecordMapByTombstones(state.markersById, tombstones.markers);
  const visual = filterVisualByTombstones(state.visual, tombstones);
  const assets = filterRecordMapByTombstones(state.assets, tombstones.assets);
  const {
    companionGroupsByStatementId: _companionGroupsByStatementId,
    markersById: _markersById,
    visual: _visual,
    assets: _assets,
    ...base
  } = state;

  return {
    ...base,
    statementsById,
    statementOrder,
    ...(companionGroupsByStatementId ? { companionGroupsByStatementId } : {}),
    ...(markersById ? { markersById } : {}),
    ...(visual ? { visual } : {}),
    ...(assets ? { assets } : {}),
  };
}

export function addCollaborativeTombstonesForDeletedRecordsV3(
  previousState: CollaborativeSceneStateV3,
  nextState: CollaborativeSceneStateV3,
  deletedAt = new Date().toISOString(),
): CollaborativeSceneStateV3 {
  const tombstones: CollaborativeTombstonesV3 = cloneJson(nextState.tombstones ?? {});
  let changed = false;

  changed = addDeletedIdsToTombstoneSection(
    tombstones,
    'statements',
    deletedRecordIds(previousState.statementsById, nextState.statementsById),
    deletedAt,
  ) || changed;
  changed = addDeletedCompanionsToTombstones(
    tombstones,
    previousState as any,
    nextState as any,
    deletedAt,
  ) || changed;
  changed = addDeletedIdsToTombstoneSection(
    tombstones,
    'markers',
    deletedRecordIds(previousState.markersById, nextState.markersById),
    deletedAt,
  ) || changed;
  changed = addDeletedIdsToTombstoneSection(
    tombstones,
    'visualTargets',
    deletedRecordIds(previousState.visual?.visualTargets, nextState.visual?.visualTargets),
    deletedAt,
  ) || changed;
  changed = addDeletedIdsToTombstoneSection(
    tombstones,
    'segments',
    deletedRecordIds(previousState.visual?.segments, nextState.visual?.segments),
    deletedAt,
  ) || changed;
  changed = addDeletedIdsToTombstoneSection(
    tombstones,
    'recipeOverlay',
    deletedRecordIds(previousState.visual?.recipeOverlay, nextState.visual?.recipeOverlay),
    deletedAt,
  ) || changed;
  changed = addDeletedIdsToTombstoneSection(
    tombstones,
    'assets',
    deletedRecordIds(previousState.assets, nextState.assets),
    deletedAt,
  ) || changed;

  return changed ? { ...nextState, tombstones } : nextState;
}
