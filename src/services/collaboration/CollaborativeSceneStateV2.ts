import {
  COLLABORATION_SCHEMA_VERSION_V2,
  type CollaborativeAssetManifest,
  type CollaborativeCompanionGroup,
  type CollaborativeCompanionId,
  type CollaborativeCompanionRecord,
  type CollaborativeSceneStateV2,
  type CollaborativeStatementId,
  type CollaborativeStatementRecord,
  type CollaborativeTombstoneRecord,
  type CollaborativeTombstonesV2,
} from '../../api/types/collaboration';
import type { SceneMarker } from '../../api/types/scene-common';
import {
  SCENE_SCHEMA_VERSION_V4,
  assertHistoricalSceneDocumentV4,
  type DialogueCompanion,
  type HistoricalSceneDocumentV4,
  type HistoricalSceneMetaV4,
  type SceneStatement,
} from '../../api/types/semantic-scene';
import {
  deriveSceneDocumentCanonicalOrder,
  getSceneDocumentCanonicalOrder,
  sceneDocumentCodec,
  validateV4Stage,
  withSceneDocumentCanonicalOrder,
} from '../semantic-scene';

export interface CollaborativeSceneV2SeedOptions {
  collaborationProjectId: string;
  roomId: string;
  /** Existing collaborative order to preserve across local document refreshes. */
  canonicalStatementOrder?: readonly CollaborativeStatementId[];
  assets?: CollaborativeAssetManifest;
  tombstones?: CollaborativeTombstonesV2;
}

export function createCollaborativeSceneStateV2FromDocument(
  document: HistoricalSceneDocumentV4,
  options: CollaborativeSceneV2SeedOptions,
): CollaborativeSceneStateV2 {
  assertHistoricalSceneDocumentV4(document);
  const documentCanonicalOrder = getSceneDocumentCanonicalOrder(document);
  const source = sceneDocumentCodec.parseAndValidate(document);
  const statementsById: Record<CollaborativeStatementId, CollaborativeStatementRecord> = {};
  const statementOrder = deriveSceneDocumentCanonicalOrder(
    source,
    options.canonicalStatementOrder ?? documentCanonicalOrder,
  ) as CollaborativeStatementId[];
  const companionGroupsByStatementId: Record<CollaborativeStatementId, CollaborativeCompanionGroup> = {};

  source.statements.forEach((statement, index) => {
    if (!statement.id) {
      throw new Error(`Cannot seed collaborative scene v2: statement at index ${index} has no id`);
    }
    const { companions, ...statementRecord } = cloneJson(statement) as SceneStatement & {
      companions?: DialogueCompanion[];
    };
    statementsById[statement.id] = statementRecord as CollaborativeStatementRecord;
    if (companions?.length) {
      const companionsById: Record<CollaborativeCompanionId, CollaborativeCompanionRecord> = {};
      const companionOrder: CollaborativeCompanionId[] = [];
      companions.forEach((companion, companionIndex) => {
        if (!companion.id) {
          throw new Error(
            `Cannot seed collaborative scene v2: companion at ${statement.id}[${companionIndex}] has no id`,
          );
        }
        companionsById[companion.id] = cloneJson(companion) as CollaborativeCompanionRecord;
        companionOrder.push(companion.id);
      });
      companionGroupsByStatementId[statement.id] = { companionsById, companionOrder };
    }
  });

  const markersById: Record<string, SceneMarker> = {};
  source.meta.markers?.forEach((marker, index) => {
    if (!marker.markerId) {
      throw new Error(`Cannot seed collaborative scene v2: marker at index ${index} has no markerId`);
    }
    markersById[marker.markerId] = cloneJson(marker);
  });

  return {
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V4,
    collaborationProjectId: options.collaborationProjectId,
    roomId: options.roomId,
    sceneId: source.sceneId,
    meta: omitMarkers(source.meta),
    statementsById,
    statementOrder,
    ...(Object.keys(companionGroupsByStatementId).length > 0 ? { companionGroupsByStatementId } : {}),
    ...(Object.keys(markersById).length > 0 ? { markersById } : {}),
    ...(source.visual ? { visual: cloneJson(source.visual) } : {}),
    ...(options.assets ? { assets: cloneJson(options.assets) } : {}),
    ...(options.tombstones ? { tombstones: cloneJson(options.tombstones) } : {}),
  };
}

export function materializeCollaborativeSceneDocumentV4(state: CollaborativeSceneStateV2): HistoricalSceneDocumentV4 {
  assertVersion(state);
  const liveStatementIds = liveIds(Object.keys(state.statementsById), state.tombstones?.statements);
  assertExactOrder('statementOrder', state.statementOrder, liveStatementIds);
  assertNoDanglingCompanionGroups(state, liveStatementIds);

  const statementOrderIndex = new Map(state.statementOrder.map((id, index) => [id, index]));
  const statements = Object.values(state.statementsById)
    .filter((statement) => liveStatementIds.has(statement.id))
    .sort((a, b) => (
      a.time - b.time ||
      (statementOrderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (statementOrderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
      a.id.localeCompare(b.id)
    ))
    .map((statement) => materializeStatement(statement, state));

  const markers = materializeMarkers(state);
  const document: HistoricalSceneDocumentV4 = {
    schemaVersion: SCENE_SCHEMA_VERSION_V4,
    sceneId: state.sceneId,
    meta: {
      ...cloneJson(state.meta),
      ...(markers ? { markers } : {}),
    },
    ...(state.visual ? { visual: cloneJson(state.visual) } : {}),
    statements,
  };
  validateV4Stage(document, sceneDocumentCodec);
  return withSceneDocumentCanonicalOrder(document, state.statementOrder);
}

function materializeStatement(
  statement: CollaborativeStatementRecord,
  state: CollaborativeSceneStateV2,
): SceneStatement {
  const group = state.companionGroupsByStatementId?.[statement.id];
  if (!group) return cloneJson(statement) as SceneStatement;

  const liveCompanionIds = liveIds(
    Object.keys(group.companionsById),
    state.tombstones?.companions?.[statement.id],
  );
  assertExactOrder(`companionOrder[${statement.id}]`, group.companionOrder, liveCompanionIds);

  return compact({
    ...cloneJson(statement),
    companions: group.companionOrder
      .filter((companionId) => liveCompanionIds.has(companionId))
      .map((companionId) => cloneJson(group.companionsById[companionId])),
  }) as SceneStatement;
}

function materializeMarkers(state: CollaborativeSceneStateV2): SceneMarker[] | undefined {
  const markers = Object.values(state.markersById ?? {})
    .filter((marker) => !isTombstoned(marker.markerId, state.tombstones?.markers))
    .map((marker) => cloneJson(marker))
    .sort((a, b) => a.time - b.time || a.markerId.localeCompare(b.markerId));

  return markers.length > 0 ? markers : undefined;
}

function assertVersion(state: CollaborativeSceneStateV2): void {
  if (state.schemaVersion !== COLLABORATION_SCHEMA_VERSION_V2) {
    throw new Error(`Expected collaboration schema version ${COLLABORATION_SCHEMA_VERSION_V2}`);
  }
  if (state.sceneSchemaVersion !== SCENE_SCHEMA_VERSION_V4) {
    throw new Error(`Expected historical scene schema version ${SCENE_SCHEMA_VERSION_V4}`);
  }
}

function assertNoDanglingCompanionGroups(
  state: CollaborativeSceneStateV2,
  liveStatementIds: ReadonlySet<string>,
): void {
  for (const statementId of Object.keys(state.companionGroupsByStatementId ?? {})) {
    if (!liveStatementIds.has(statementId)) {
      throw new Error(`Dangling companion group for missing statement "${statementId}"`);
    }
  }
}

function assertExactOrder(label: string, order: readonly string[], liveIdSet: ReadonlySet<string>): void {
  const seen = new Set<string>();
  for (const id of order) {
    if (seen.has(id)) throw new Error(`Duplicate id "${id}" in ${label}`);
    seen.add(id);
    if (!liveIdSet.has(id)) throw new Error(`Dangling id "${id}" in ${label}`);
  }
  for (const id of liveIdSet) {
    if (!seen.has(id)) throw new Error(`Missing id "${id}" in ${label}`);
  }
}

function liveIds(
  ids: readonly string[],
  tombstones: Record<string, CollaborativeTombstoneRecord> | undefined,
): ReadonlySet<string> {
  return new Set(ids.filter((id) => !isTombstoned(id, tombstones)));
}

function isTombstoned(
  id: string | undefined,
  tombstones: Record<string, CollaborativeTombstoneRecord> | undefined,
): boolean {
  return !!id && !!tombstones?.[id];
}

function omitMarkers(meta: HistoricalSceneMetaV4): Omit<HistoricalSceneMetaV4, 'markers'> {
  const { markers: _markers, ...rest } = meta;
  return cloneJson(rest);
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
