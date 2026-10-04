import * as Y from 'yjs';
import type {
  CollaborativeAssetManifestEntry,
  CollaborativeCompanionGroup,
  CollaborativeCompanionRecord,
  CollaborativeSceneMetaV4,
  CollaborativeSceneMetaV5,
  CollaborativeSceneStateV2,
  CollaborativeSceneStateV3,
  CollaborativeStatementRecord,
  CollaborativeTombstoneRecord,
  CollaborativeTombstonesV2,
} from '../../api/types/collaboration';
import {
  COLLABORATION_SCHEMA_VERSION_V2,
  COLLABORATION_SCHEMA_VERSION_V3,
} from '../../api/types/collaboration';
import type { SceneMarker } from '../../api/types/scene-common';
import {
  SCENE_SCHEMA_VERSION_V4,
  SCENE_SCHEMA_VERSION_V5,
} from '../../api/types/semantic-scene';
import type { SceneVisualBlock, SegmentVisualRecord, StyleRecipeRecord, VisualTargetRecord } from '../../api/types/visual';
import {
  filterTombstonedCollaborativeRecordsV2,
  filterTombstonedCollaborativeRecordsV3,
} from './CollaborativeStateTombstonesV2';

export const COLLABORATIVE_SCENE_ROOT = 'collaborativeScene';

export interface CollaborativeStatementChanges {
  upsertStatements?: Record<string, CollaborativeStatementRecord>;
  deleteStatementIds?: string[];
  statementOrder?: string[];
  deletedAt?: string;
  deletedBy?: string;
}

export interface CollaborativeCompanionChanges {
  statementId: string;
  upsertCompanions?: Record<string, CollaborativeCompanionRecord>;
  deleteCompanionIds?: string[];
  companionOrder?: string[];
  deletedAt?: string;
  deletedBy?: string;
}

export interface CollaborativeMarkerChanges {
  upsertMarkers?: Record<string, SceneMarker>;
  deleteMarkerIds?: string[];
  deletedAt?: string;
  deletedBy?: string;
}

export interface CollaborativeVisualTargetChanges {
  upsertVisualTargets?: Record<string, VisualTargetRecord>;
  deleteVisualTargetIds?: string[];
  deletedAt?: string;
  deletedBy?: string;
}

export interface CollaborativeSegmentChanges {
  upsertSegments?: Record<string, SegmentVisualRecord>;
  deleteSegmentIds?: string[];
  deletedAt?: string;
  deletedBy?: string;
}

export interface CollaborativeRecipeOverlayChanges {
  upsertRecipeOverlay?: Record<string, StyleRecipeRecord>;
  deleteRecipeIds?: string[];
  deletedAt?: string;
  deletedBy?: string;
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function clearMap(map: Y.Map<unknown>): void {
  Array.from(map.keys()).forEach((key) => map.delete(key));
}

function replaceArray<T>(array: Y.Array<T>, values: T[]): void {
  if (array.length > 0) array.delete(0, array.length);
  if (values.length > 0) array.insert(0, values);
}

function createRecordMap<T>(records: Record<string, T>): Y.Map<T> {
  const map = new Y.Map<T>();
  Object.entries(records).forEach(([key, value]) => {
    map.set(key, cloneJson(value));
  });
  return map;
}

function createVisualMap(visual: SceneVisualBlock): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  if (visual.visualTargets) map.set('visualTargets', createRecordMap(visual.visualTargets));
  if (visual.segments) map.set('segments', createRecordMap(visual.segments));
  if (visual.recipeOverlay) map.set('recipeOverlay', createRecordMap(visual.recipeOverlay));
  return map;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readYMapEntries<T>(map: Y.Map<T>): Record<string, T> {
  const records: Record<string, T> = {};
  map.forEach((entry, id) => {
    records[id] = cloneJson(entry as T);
  });
  return records;
}

function getOrCreateRecordMap<T>(root: Y.Map<unknown>, key: string): Y.Map<T> {
  const existing = root.get(key);
  if (existing instanceof Y.Map) return existing as Y.Map<T>;
  const map = new Y.Map<T>();
  root.set(key, map);
  return map;
}

function getOrCreateStringArray(root: Y.Map<unknown>, key: string): Y.Array<string> {
  const existing = root.get(key);
  if (existing instanceof Y.Array) return existing as Y.Array<string>;
  const array = new Y.Array<string>();
  root.set(key, array);
  return array;
}

function getOrCreateVisualMap(root: Y.Map<unknown>): Y.Map<unknown> {
  const existing = root.get('visual');
  if (existing instanceof Y.Map) return existing;
  const map = isRecord(existing)
    ? createVisualMap(existing as SceneVisualBlock)
    : new Y.Map<unknown>();
  root.set('visual', map);
  return map;
}

function getOrCreateVisualSectionMap<T>(
  visual: Y.Map<unknown>,
  key: keyof SceneVisualBlock,
): Y.Map<T> {
  const existing = visual.get(key);
  if (existing instanceof Y.Map) return existing as Y.Map<T>;
  const map = isRecord(existing)
    ? createRecordMap(existing as Record<string, T>)
    : new Y.Map<T>();
  visual.set(key, map);
  return map;
}

function createCompanionGroupMap(group: CollaborativeCompanionGroup): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set('companionsById', createRecordMap<CollaborativeCompanionRecord>(group.companionsById));
  // Use Y.Array.from for fresh arrays: it stores preliminary content and is
  // integrated when the parent map is attached, avoiding premature access.
  map.set('companionOrder', Y.Array.from(group.companionOrder));
  return map;
}

function createCompanionGroupsMap(
  groups: Record<string, CollaborativeCompanionGroup>,
): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  Object.entries(groups).forEach(([statementId, group]) => {
    map.set(statementId, createCompanionGroupMap(group));
  });
  return map;
}

function createCompanionTombstonesMap(
  companions: NonNullable<CollaborativeTombstonesV2['companions']>,
): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  Object.entries(companions).forEach(([statementId, tombstones]) => {
    map.set(statementId, createRecordMap(tombstones));
  });
  return map;
}

function createTombstonesMapV2(tombstones: CollaborativeTombstonesV2): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  if (tombstones.statements) map.set('statements', createRecordMap(tombstones.statements));
  if (tombstones.companions) map.set('companions', createCompanionTombstonesMap(tombstones.companions));
  if (tombstones.markers) map.set('markers', createRecordMap(tombstones.markers));
  if (tombstones.visualTargets) map.set('visualTargets', createRecordMap(tombstones.visualTargets));
  if (tombstones.segments) map.set('segments', createRecordMap(tombstones.segments));
  if (tombstones.recipeOverlay) map.set('recipeOverlay', createRecordMap(tombstones.recipeOverlay));
  if (tombstones.assets) map.set('assets', createRecordMap(tombstones.assets));
  return map;
}

function getOrCreateTombstonesMap(root: Y.Map<unknown>): Y.Map<unknown> {
  const existing = root.get('tombstones');
  if (existing instanceof Y.Map) return existing;
  const map = isRecord(existing)
    ? createTombstonesMapV2(existing as CollaborativeTombstonesV2)
    : new Y.Map<unknown>();
  root.set('tombstones', map);
  return map;
}

function getOrCreateTombstoneSectionMap(
  tombstones: Y.Map<unknown>,
  key: string,
): Y.Map<CollaborativeTombstoneRecord> {
  const existing = tombstones.get(key);
  if (existing instanceof Y.Map) return existing as Y.Map<CollaborativeTombstoneRecord>;
  const map = isRecord(existing)
    ? createRecordMap(existing as Record<string, CollaborativeTombstoneRecord>)
    : new Y.Map<CollaborativeTombstoneRecord>();
  tombstones.set(key, map);
  return map;
}

function readExistingTombstoneSection(
  root: Y.Map<unknown>,
  key: string,
): Record<string, CollaborativeTombstoneRecord> | Y.Map<CollaborativeTombstoneRecord> | undefined {
  const tombstones = root.get('tombstones');
  if (tombstones instanceof Y.Map) {
    const section = tombstones.get(key);
    if (section instanceof Y.Map) return section as Y.Map<CollaborativeTombstoneRecord>;
    return readTombstoneSection(section);
  }
  return readTombstoneSection((tombstones as Record<string, unknown> | undefined)?.[key]);
}

function hasTombstone(
  section: Record<string, CollaborativeTombstoneRecord> | Y.Map<CollaborativeTombstoneRecord> | undefined,
  id: string,
): boolean {
  return section instanceof Y.Map ? section.has(id) : !!section?.[id];
}

interface CollaborativeEntityYDocChanges<TRecord> {
  upsertRecords?: Record<string, TRecord>;
  deleteIds?: string[];
  deletedAt?: string;
  deletedBy?: string;
}

interface CollaborativeEntityYDocWriter<TRecord> extends CollaborativeEntityYDocChanges<TRecord> {
  records: Y.Map<TRecord>;
  tombstoneKey: keyof CollaborativeTombstonesV2;
  normalizeRecord?: (id: string, record: TRecord) => TRecord;
}

interface CollaborativeRootEntityDescriptor<TRecord> {
  recordKey: string;
  tombstoneKey: keyof CollaborativeTombstonesV2;
  getRecords(root: Y.Map<unknown>): Y.Map<TRecord>;
  normalizeRecord?: (id: string, record: TRecord) => TRecord;
}

interface CollaborativeVisualEntityDescriptor<TRecord> {
  visualKey: keyof SceneVisualBlock;
  tombstoneKey: keyof CollaborativeTombstonesV2;
  getRecords(root: Y.Map<unknown>): Y.Map<TRecord>;
}

const collaborativeMarkerDescriptor: CollaborativeRootEntityDescriptor<SceneMarker> = {
  recordKey: 'markersById',
  tombstoneKey: 'markers',
  getRecords: (root) => getOrCreateRecordMap<SceneMarker>(root, 'markersById'),
  normalizeRecord: (markerId, marker) => ({ ...marker, markerId }),
};

const collaborativeVisualTargetDescriptor: CollaborativeVisualEntityDescriptor<VisualTargetRecord> = {
  visualKey: 'visualTargets',
  tombstoneKey: 'visualTargets',
  getRecords: (root) => getOrCreateVisualSectionMap<VisualTargetRecord>(
    getOrCreateVisualMap(root),
    'visualTargets',
  ),
};

const collaborativeSegmentDescriptor: CollaborativeVisualEntityDescriptor<SegmentVisualRecord> = {
  visualKey: 'segments',
  tombstoneKey: 'segments',
  getRecords: (root) => getOrCreateVisualSectionMap<SegmentVisualRecord>(
    getOrCreateVisualMap(root),
    'segments',
  ),
};

const collaborativeRecipeOverlayDescriptor: CollaborativeVisualEntityDescriptor<StyleRecipeRecord> = {
  visualKey: 'recipeOverlay',
  tombstoneKey: 'recipeOverlay',
  getRecords: (root) => getOrCreateVisualSectionMap<StyleRecipeRecord>(
    getOrCreateVisualMap(root),
    'recipeOverlay',
  ),
};

function writeCollaborativeEntityChangesToYDoc<TRecord>(
  root: Y.Map<unknown>,
  writer: CollaborativeEntityYDocWriter<TRecord>,
): void {
  const tombstones = writer.deleteIds?.length
    ? getOrCreateTombstoneSectionMap(getOrCreateTombstonesMap(root), writer.tombstoneKey)
    : readExistingTombstoneSection(root, writer.tombstoneKey);

  for (const id of writer.deleteIds ?? []) {
    writer.records.delete(id);
    if (tombstones instanceof Y.Map && !tombstones.has(id)) {
      tombstones.set(id, {
        id,
        deletedAt: writer.deletedAt ?? new Date().toISOString(),
        ...(writer.deletedBy ? { deletedBy: writer.deletedBy } : {}),
      });
    }
  }

  for (const [id, record] of Object.entries(writer.upsertRecords ?? {})) {
    if (hasTombstone(tombstones, id)) continue;
    writer.records.set(id, cloneJson(writer.normalizeRecord?.(id, record) ?? record));
  }
}

function readRecordMap<T>(root: Y.Map<unknown>, key: string): Record<string, T> {
  const value = root.get(key);
  if (!(value instanceof Y.Map)) return {};
  return readYMapEntries(value);
}

function readRecordMapValue<T>(value: unknown): Record<string, T> {
  if (value instanceof Y.Map) return readYMapEntries<T>(value);
  if (isRecord(value)) return cloneJson(value as Record<string, T>);
  return {};
}

function readStringArray(root: Y.Map<unknown>, key: string): string[] {
  return readStringArrayValue(root.get(key));
}

function readStringArrayValue(value: unknown): string[] {
  if (value instanceof Y.Array) {
    return value.toArray().filter((entry): entry is string => typeof entry === 'string');
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

function readTombstoneSection(value: unknown): Record<string, CollaborativeTombstoneRecord> | undefined {
  if (value instanceof Y.Map) {
    const records = readYMapEntries<CollaborativeTombstoneRecord>(value);
    return Object.keys(records).length > 0 ? records : undefined;
  }
  if (isRecord(value)) {
    const records = cloneJson(value as Record<string, CollaborativeTombstoneRecord>);
    return Object.keys(records).length > 0 ? records : undefined;
  }
  return undefined;
}

function readCompanionTombstones(value: unknown): CollaborativeTombstonesV2['companions'] | undefined {
  if (!value) return undefined;
  if (!isRecord(value) && !(value instanceof Y.Map)) return undefined;

  const companions: NonNullable<CollaborativeTombstonesV2['companions']> = {};
  if (value instanceof Y.Map) {
    value.forEach((entry, statementId) => {
      const tombstones = readTombstoneSection(entry);
      if (tombstones) companions[statementId] = tombstones;
    });
  } else {
    Object.entries(value).forEach(([statementId, entry]) => {
      const tombstones = readTombstoneSection(entry);
      if (tombstones) companions[statementId] = tombstones;
    });
  }

  return Object.keys(companions).length > 0 ? companions : undefined;
}

function readTombstonesV2(root: Y.Map<unknown>): CollaborativeTombstonesV2 | undefined {
  const value = root.get('tombstones');
  if (!value) return undefined;
  if (!isRecord(value) && !(value instanceof Y.Map)) return undefined;

  const tombstones: CollaborativeTombstonesV2 = {};
  const getSection = (key: keyof CollaborativeTombstonesV2): unknown => (
    value instanceof Y.Map ? value.get(key) : value[key]
  );

  const statements = readTombstoneSection(getSection('statements'));
  const companions = readCompanionTombstones(getSection('companions'));
  const markers = readTombstoneSection(getSection('markers'));
  const visualTargets = readTombstoneSection(getSection('visualTargets'));
  const segments = readTombstoneSection(getSection('segments'));
  const recipeOverlay = readTombstoneSection(getSection('recipeOverlay'));
  const assets = readTombstoneSection(getSection('assets'));

  if (statements) tombstones.statements = statements;
  if (companions) tombstones.companions = companions;
  if (markers) tombstones.markers = markers;
  if (visualTargets) tombstones.visualTargets = visualTargets;
  if (segments) tombstones.segments = segments;
  if (recipeOverlay) tombstones.recipeOverlay = recipeOverlay;
  if (assets) tombstones.assets = assets;

  return Object.keys(tombstones).length > 0 ? tombstones : undefined;
}

function readVisualSection<T>(value: unknown): Record<string, T> | undefined {
  if (value instanceof Y.Map) {
    const records = readYMapEntries<T>(value);
    return Object.keys(records).length > 0 ? records : undefined;
  }
  if (isRecord(value)) {
    const records = cloneJson(value as Record<string, T>);
    return Object.keys(records).length > 0 ? records : undefined;
  }
  return undefined;
}

function readVisual(root: Y.Map<unknown>): SceneVisualBlock | undefined {
  const value = root.get('visual');
  if (!value) return undefined;
  if (!(value instanceof Y.Map)) {
    return isRecord(value) ? cloneJson(value as SceneVisualBlock) : undefined;
  }

  const visual: SceneVisualBlock = {};
  const visualTargets = readVisualSection<VisualTargetRecord>(value.get('visualTargets'));
  const segments = readVisualSection<SegmentVisualRecord>(value.get('segments'));
  const recipeOverlay = readVisualSection<StyleRecipeRecord>(value.get('recipeOverlay'));

  if (visualTargets) visual.visualTargets = visualTargets;
  if (segments) visual.segments = segments;
  if (recipeOverlay) visual.recipeOverlay = recipeOverlay;

  return Object.keys(visual).length > 0 ? visual : undefined;
}

function getOrCreateCompanionGroupsYMap(root: Y.Map<unknown>): Y.Map<unknown> {
  const existing = root.get('companionGroupsByStatementId');
  if (existing instanceof Y.Map) return existing;
  const map = isRecord(existing)
    ? createCompanionGroupsMap(existing as Record<string, CollaborativeCompanionGroup>)
    : new Y.Map<unknown>();
  root.set('companionGroupsByStatementId', map);
  return map;
}

function getOrCreateCompanionGroupYMap(
  groups: Y.Map<unknown>,
  statementId: string,
): Y.Map<unknown> {
  const existing = groups.get(statementId);
  if (existing instanceof Y.Map) return existing;
  const map = isRecord(existing)
    ? createCompanionGroupMap(existing as unknown as CollaborativeCompanionGroup)
    : createCompanionGroupMap({ companionsById: {}, companionOrder: [] });
  groups.set(statementId, map);
  return map;
}

function getOrCreateGroupCompanionsYMap(
  group: Y.Map<unknown>,
): Y.Map<CollaborativeCompanionRecord> {
  const existing = group.get('companionsById');
  if (existing instanceof Y.Map) return existing as Y.Map<CollaborativeCompanionRecord>;
  const map = isRecord(existing)
    ? createRecordMap(existing as Record<string, CollaborativeCompanionRecord>)
    : new Y.Map<CollaborativeCompanionRecord>();
  group.set('companionsById', map);
  return map;
}

function getOrCreateGroupCompanionOrderYArray(group: Y.Map<unknown>): Y.Array<string> {
  const existing = group.get('companionOrder');
  if (existing instanceof Y.Array) return existing as Y.Array<string>;
  const array = new Y.Array<string>();
  group.set('companionOrder', array);
  replaceArray(array, readStringArrayValue(existing));
  return array;
}

function getOrCreateV2CompanionTombstonesMap(
  root: Y.Map<unknown>,
  statementId: string,
): Y.Map<CollaborativeTombstoneRecord> {
  const tombstones = getOrCreateTombstonesMap(root);
  const existingCompanions = tombstones.get('companions');
  const companions = existingCompanions instanceof Y.Map
    ? existingCompanions as Y.Map<unknown>
    : createCompanionTombstonesMap(
      isRecord(existingCompanions)
        ? existingCompanions as NonNullable<CollaborativeTombstonesV2['companions']>
        : {},
    );
  if (!(existingCompanions instanceof Y.Map)) tombstones.set('companions', companions);

  const existingSection = companions.get(statementId);
  if (existingSection instanceof Y.Map) return existingSection as Y.Map<CollaborativeTombstoneRecord>;
  const section = isRecord(existingSection)
    ? createRecordMap(existingSection as Record<string, CollaborativeTombstoneRecord>)
    : new Y.Map<CollaborativeTombstoneRecord>();
  companions.set(statementId, section);
  return section;
}

function readExistingV2CompanionTombstoneSection(
  root: Y.Map<unknown>,
  statementId: string,
): Record<string, CollaborativeTombstoneRecord> | Y.Map<CollaborativeTombstoneRecord> | undefined {
  const tombstones = root.get('tombstones');
  const companionTombstones = tombstones instanceof Y.Map
    ? tombstones.get('companions')
    : (tombstones as CollaborativeTombstonesV2 | undefined)?.companions;

  if (companionTombstones instanceof Y.Map) {
    const section = companionTombstones.get(statementId);
    if (section instanceof Y.Map) return section as Y.Map<CollaborativeTombstoneRecord>;
    return readTombstoneSection(section);
  }

  return readTombstoneSection(companionTombstones?.[statementId]);
}

function setTombstoneIfMissing(
  tombstones: Y.Map<CollaborativeTombstoneRecord>,
  id: string,
  deletedAt: string | undefined,
  deletedBy: string | undefined,
): void {
  if (tombstones.has(id)) return;
  tombstones.set(id, {
    id,
    deletedAt: deletedAt ?? new Date().toISOString(),
    ...(deletedBy ? { deletedBy } : {}),
  });
}

function readCompanionGroups(root: Y.Map<unknown>): Record<string, CollaborativeCompanionGroup> | undefined {
  const value = root.get('companionGroupsByStatementId');
  if (!value) return undefined;

  if (!(value instanceof Y.Map)) {
    return isRecord(value)
      ? cloneJson(value as Record<string, CollaborativeCompanionGroup>)
      : undefined;
  }

  const groups: Record<string, CollaborativeCompanionGroup> = {};
  value.forEach((entry, statementId) => {
    if (entry instanceof Y.Map) {
      groups[statementId] = {
        companionsById: readRecordMapValue<CollaborativeCompanionRecord>(entry.get('companionsById')),
        companionOrder: readStringArrayValue(entry.get('companionOrder')),
      };
      return;
    }

    if (isRecord(entry)) {
      groups[statementId] = cloneJson(entry as unknown as CollaborativeCompanionGroup);
    }
  });

  return Object.keys(groups).length > 0 ? groups : undefined;
}

export function writeCollaborativeStateV2ToYDoc(
  doc: Y.Doc,
  state: CollaborativeSceneStateV2,
  origin = 'seed',
): void {
  const filteredState = filterTombstonedCollaborativeRecordsV2(state);
  doc.transact(() => {
    const root = doc.getMap<unknown>(COLLABORATIVE_SCENE_ROOT);
    clearMap(root);

    root.set('schemaVersion', filteredState.schemaVersion);
    root.set('sceneSchemaVersion', filteredState.sceneSchemaVersion);
    root.set('collaborationProjectId', filteredState.collaborationProjectId);
    root.set('roomId', filteredState.roomId);
    root.set('sceneId', filteredState.sceneId);
    root.set('meta', cloneJson(filteredState.meta));
    if (filteredState.visual) root.set('visual', createVisualMap(filteredState.visual));
    if (filteredState.tombstones) root.set('tombstones', createTombstonesMapV2(filteredState.tombstones));

    root.set('statementsById', createRecordMap<CollaborativeStatementRecord>(filteredState.statementsById));

    root.set('statementOrder', Y.Array.from(filteredState.statementOrder));

    if (filteredState.companionGroupsByStatementId) {
      root.set(
        'companionGroupsByStatementId',
        createCompanionGroupsMap(filteredState.companionGroupsByStatementId),
      );
    }
    root.set('markersById', createRecordMap<SceneMarker>(filteredState.markersById ?? {}));
    root.set('assets', createRecordMap<CollaborativeAssetManifestEntry>(filteredState.assets ?? {}));
  }, origin);
}

export function writeCollaborativeStateV3ToYDoc(
  doc: Y.Doc,
  state: CollaborativeSceneStateV3,
  origin = 'seed',
): void {
  const filteredState = filterTombstonedCollaborativeRecordsV3(state);
  doc.transact(() => {
    const root = doc.getMap<unknown>(COLLABORATIVE_SCENE_ROOT);
    clearMap(root);

    root.set('schemaVersion', filteredState.schemaVersion);
    root.set('sceneSchemaVersion', filteredState.sceneSchemaVersion);
    root.set('collaborationProjectId', filteredState.collaborationProjectId);
    root.set('roomId', filteredState.roomId);
    root.set('sceneId', filteredState.sceneId);
    root.set('meta', cloneJson(filteredState.meta));
    if (filteredState.visual) root.set('visual', createVisualMap(filteredState.visual));
    if (filteredState.tombstones) root.set('tombstones', createTombstonesMapV2(filteredState.tombstones));

    root.set('statementsById', createRecordMap<CollaborativeStatementRecord>(filteredState.statementsById));

    root.set('statementOrder', Y.Array.from(filteredState.statementOrder));

    if (filteredState.companionGroupsByStatementId) {
      root.set(
        'companionGroupsByStatementId',
        createCompanionGroupsMap(filteredState.companionGroupsByStatementId),
      );
    }
    root.set('markersById', createRecordMap<SceneMarker>(filteredState.markersById ?? {}));
    root.set('assets', createRecordMap<CollaborativeAssetManifestEntry>(filteredState.assets ?? {}));
  }, origin);
}

export function writeCollaborativeStatementChangesV2ToYDoc(
  doc: Y.Doc,
  changes: CollaborativeStatementChanges,
  origin = 'local',
): void {
  doc.transact(() => {
    const root = doc.getMap<unknown>(COLLABORATIVE_SCENE_ROOT);
    const statements = getOrCreateRecordMap<CollaborativeStatementRecord>(root, 'statementsById');
    const statementTombstones = changes.deleteStatementIds?.length
      ? getOrCreateTombstoneSectionMap(getOrCreateTombstonesMap(root), 'statements')
      : readExistingTombstoneSection(root, 'statements');
    const companionGroups = root.get('companionGroupsByStatementId') instanceof Y.Map
      ? root.get('companionGroupsByStatementId') as Y.Map<unknown>
      : undefined;

    for (const statementId of changes.deleteStatementIds ?? []) {
      statements.delete(statementId);
      if (statementTombstones instanceof Y.Map) {
        setTombstoneIfMissing(statementTombstones, statementId, changes.deletedAt, changes.deletedBy);
      }

      const group = companionGroups?.get(statementId);
      if (group instanceof Y.Map) {
        const companionsById = readRecordMapValue<CollaborativeCompanionRecord>(group.get('companionsById'));
        const companionTombstones = getOrCreateV2CompanionTombstonesMap(root, statementId);
        Object.keys(companionsById).forEach((companionId) => {
          setTombstoneIfMissing(companionTombstones, companionId, changes.deletedAt, changes.deletedBy);
        });
      }
      companionGroups?.delete(statementId);
    }

    for (const [statementId, statement] of Object.entries(changes.upsertStatements ?? {})) {
      if (hasTombstone(statementTombstones, statementId)) continue;
      statements.set(statementId, cloneJson({ ...statement, id: statementId }));
    }

    if (changes.statementOrder) {
      replaceArray(getOrCreateStringArray(root, 'statementOrder'), changes.statementOrder);
    }
  }, origin);
}

export function writeCollaborativeCompanionChangesV2ToYDoc(
  doc: Y.Doc,
  changes: CollaborativeCompanionChanges,
  origin = 'local',
): void {
  doc.transact(() => {
    const root = doc.getMap<unknown>(COLLABORATIVE_SCENE_ROOT);
    const statementTombstones = readExistingTombstoneSection(root, 'statements');
    if (hasTombstone(statementTombstones, changes.statementId)) return;

    const group = getOrCreateCompanionGroupYMap(
      getOrCreateCompanionGroupsYMap(root),
      changes.statementId,
    );
    const companionsById = getOrCreateGroupCompanionsYMap(group);
    const companionTombstones = changes.deleteCompanionIds?.length
      ? getOrCreateV2CompanionTombstonesMap(root, changes.statementId)
      : readExistingV2CompanionTombstoneSection(root, changes.statementId);

    for (const companionId of changes.deleteCompanionIds ?? []) {
      companionsById.delete(companionId);
      if (companionTombstones instanceof Y.Map) {
        setTombstoneIfMissing(companionTombstones, companionId, changes.deletedAt, changes.deletedBy);
      }
    }

    for (const [companionId, companion] of Object.entries(changes.upsertCompanions ?? {})) {
      if (hasTombstone(companionTombstones, companionId)) continue;
      companionsById.set(companionId, cloneJson({ ...companion, id: companionId }));
    }

    if (changes.companionOrder) {
      replaceArray(getOrCreateGroupCompanionOrderYArray(group), changes.companionOrder);
    }
  }, origin);
}

export function writeCollaborativeMarkerChangesToYDoc(
  doc: Y.Doc,
  changes: CollaborativeMarkerChanges,
  origin = 'local',
): void {
  doc.transact(() => {
    const root = doc.getMap<unknown>(COLLABORATIVE_SCENE_ROOT);
    writeCollaborativeEntityChangesToYDoc(root, {
      records: collaborativeMarkerDescriptor.getRecords(root),
      tombstoneKey: collaborativeMarkerDescriptor.tombstoneKey,
      upsertRecords: changes.upsertMarkers,
      deleteIds: changes.deleteMarkerIds,
      deletedAt: changes.deletedAt,
      deletedBy: changes.deletedBy,
      normalizeRecord: collaborativeMarkerDescriptor.normalizeRecord,
    });
  }, origin);
}

export function writeCollaborativeVisualTargetChangesToYDoc(
  doc: Y.Doc,
  changes: CollaborativeVisualTargetChanges,
  origin = 'local',
): void {
  doc.transact(() => {
    const root = doc.getMap<unknown>(COLLABORATIVE_SCENE_ROOT);
    writeCollaborativeEntityChangesToYDoc(root, {
      records: collaborativeVisualTargetDescriptor.getRecords(root),
      tombstoneKey: collaborativeVisualTargetDescriptor.tombstoneKey,
      upsertRecords: changes.upsertVisualTargets,
      deleteIds: changes.deleteVisualTargetIds,
      deletedAt: changes.deletedAt,
      deletedBy: changes.deletedBy,
    });
  }, origin);
}

export function writeCollaborativeSegmentChangesToYDoc(
  doc: Y.Doc,
  changes: CollaborativeSegmentChanges,
  origin = 'local',
): void {
  doc.transact(() => {
    const root = doc.getMap<unknown>(COLLABORATIVE_SCENE_ROOT);
    writeCollaborativeEntityChangesToYDoc(root, {
      records: collaborativeSegmentDescriptor.getRecords(root),
      tombstoneKey: collaborativeSegmentDescriptor.tombstoneKey,
      upsertRecords: changes.upsertSegments,
      deleteIds: changes.deleteSegmentIds,
      deletedAt: changes.deletedAt,
      deletedBy: changes.deletedBy,
    });
  }, origin);
}

export function writeCollaborativeRecipeOverlayChangesToYDoc(
  doc: Y.Doc,
  changes: CollaborativeRecipeOverlayChanges,
  origin = 'local',
): void {
  doc.transact(() => {
    const root = doc.getMap<unknown>(COLLABORATIVE_SCENE_ROOT);
    writeCollaborativeEntityChangesToYDoc(root, {
      records: collaborativeRecipeOverlayDescriptor.getRecords(root),
      tombstoneKey: collaborativeRecipeOverlayDescriptor.tombstoneKey,
      upsertRecords: changes.upsertRecipeOverlay,
      deleteIds: changes.deleteRecipeIds,
      deletedAt: changes.deletedAt,
      deletedBy: changes.deletedBy,
    });
  }, origin);
}

export function readCollaborativeStateV2FromYDoc(doc: Y.Doc): CollaborativeSceneStateV2 | null {
  const root = doc.getMap<unknown>(COLLABORATIVE_SCENE_ROOT);
  const schemaVersion = root.get('schemaVersion');
  const sceneSchemaVersion = root.get('sceneSchemaVersion');
  const collaborationProjectId = root.get('collaborationProjectId');
  const roomId = root.get('roomId');
  const sceneId = root.get('sceneId');
  const meta = root.get('meta') as CollaborativeSceneMetaV4 | undefined;

  if (
    schemaVersion !== COLLABORATION_SCHEMA_VERSION_V2 ||
    sceneSchemaVersion !== SCENE_SCHEMA_VERSION_V4 ||
    typeof collaborationProjectId !== 'string' ||
    typeof roomId !== 'string' ||
    typeof sceneId !== 'string' ||
    !meta
  ) {
    return null;
  }

  const companionGroupsByStatementId = readCompanionGroups(root);
  const markersById = readRecordMap<SceneMarker>(root, 'markersById');
  const visual = readVisual(root);
  const assets = readRecordMap<CollaborativeAssetManifestEntry>(root, 'assets');
  const tombstones = readTombstonesV2(root);

  return filterTombstonedCollaborativeRecordsV2({
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V4,
    collaborationProjectId,
    roomId,
    sceneId,
    meta: cloneJson(meta),
    statementsById: readRecordMap<CollaborativeStatementRecord>(root, 'statementsById'),
    statementOrder: readStringArray(root, 'statementOrder'),
    ...(companionGroupsByStatementId ? { companionGroupsByStatementId } : {}),
    ...(Object.keys(markersById).length > 0 ? { markersById } : {}),
    ...(visual ? { visual: cloneJson(visual) } : {}),
    ...(Object.keys(assets).length > 0 ? { assets } : {}),
    ...(tombstones ? { tombstones: cloneJson(tombstones) } : {}),
  });
}

export function hasCollaborativeStateV2(doc: Y.Doc): boolean {
  return readCollaborativeStateV2FromYDoc(doc) !== null;
}

export function readCollaborativeStateV3FromYDoc(doc: Y.Doc): CollaborativeSceneStateV3 | null {
  const root = doc.getMap<unknown>(COLLABORATIVE_SCENE_ROOT);
  const schemaVersion = root.get('schemaVersion');
  const sceneSchemaVersion = root.get('sceneSchemaVersion');
  const collaborationProjectId = root.get('collaborationProjectId');
  const roomId = root.get('roomId');
  const sceneId = root.get('sceneId');
  const meta = root.get('meta') as CollaborativeSceneMetaV5 | undefined;

  if (
    schemaVersion !== COLLABORATION_SCHEMA_VERSION_V3 ||
    sceneSchemaVersion !== SCENE_SCHEMA_VERSION_V5 ||
    typeof collaborationProjectId !== 'string' ||
    typeof roomId !== 'string' ||
    typeof sceneId !== 'string' ||
    !meta
  ) {
    return null;
  }

  const companionGroupsByStatementId = readCompanionGroups(root);
  const markersById = readRecordMap<SceneMarker>(root, 'markersById');
  const visual = readVisual(root);
  const assets = readRecordMap<CollaborativeAssetManifestEntry>(root, 'assets');
  const tombstones = readTombstonesV2(root);

  return filterTombstonedCollaborativeRecordsV3({
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V5,
    collaborationProjectId,
    roomId,
    sceneId,
    meta: cloneJson(meta),
    statementsById: readRecordMap<CollaborativeStatementRecord>(root, 'statementsById'),
    statementOrder: readStringArray(root, 'statementOrder'),
    ...(companionGroupsByStatementId ? { companionGroupsByStatementId } : {}),
    ...(Object.keys(markersById).length > 0 ? { markersById } : {}),
    ...(visual ? { visual: cloneJson(visual) } : {}),
    ...(Object.keys(assets).length > 0 ? { assets } : {}),
    ...(tombstones ? { tombstones: cloneJson(tombstones) } : {}),
  });
}

export function hasCollaborativeStateV3(doc: Y.Doc): boolean {
  return readCollaborativeStateV3FromYDoc(doc) !== null;
}

export function readCollaborativeSchemaVersions(doc: Y.Doc): {
  schemaVersion: number | null;
  sceneSchemaVersion: number | null;
} {
  const root = doc.getMap<unknown>(COLLABORATIVE_SCENE_ROOT);
  const schemaVersion = root.get('schemaVersion');
  const sceneSchemaVersion = root.get('sceneSchemaVersion');

  return {
    schemaVersion: typeof schemaVersion === 'number' ? schemaVersion : null,
    sceneSchemaVersion: typeof sceneSchemaVersion === 'number' ? sceneSchemaVersion : null,
  };
}
