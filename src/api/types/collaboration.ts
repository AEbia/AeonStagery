import type { ResourceImportKind } from './project';
import type { SceneMarker } from './scene-common';
import {
  SCENE_SCHEMA_VERSION_V4,
  SCENE_SCHEMA_VERSION_V5,
  type DialogueCompanion,
  type HistoricalSceneMetaV4,
  type SceneMetaV5,
  type SceneStatement,
} from './semantic-scene';
import type { RecipeId, SceneVisualBlock, SegmentId, VisualTargetId } from './visual';

export const COLLABORATION_SCHEMA_VERSION_V2 = 2;
export const COLLABORATION_SCHEMA_VERSION_V3 = 3;

export type CollaborationConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'reconnecting'
  | 'connected'
  | 'offline'
  | 'seeding'
  | 'error';

export type CollaborationProjectId = string;
export type CollaborationSceneRoomId = string;
export type CollaborationClientId = string;
export type CollaborativeStatementId = string;
export type CollaborativeCompanionId = string;
export type CollaborativeAssetId = string;
export type ContentHash = string;
export type ProjectRelativeAssetPath = string;

export interface CollaborationIdentity {
  clientId: CollaborationClientId;
  displayName: string;
}

export interface CollaborationPointerPresence {
  surface: 'timeline';
  time: number;
  trackId?: string;
}

export type CollaborationEditingTargetV2 =
  | { kind: 'statement'; statementId: CollaborativeStatementId }
  | { kind: 'companion'; statementId: CollaborativeStatementId; companionId: CollaborativeCompanionId }
  | { kind: 'marker'; id: string }
  | { kind: 'visualTarget'; id: VisualTargetId }
  | { kind: 'segment'; id: SegmentId }
  | { kind: 'asset'; id: CollaborativeAssetId }
  | { kind: 'scene' };

export interface CollaborationPresencePatchV2 {
  selectedStatementIds: CollaborativeStatementId[];
  editingTarget?: CollaborationEditingTargetV2 | null;
  playheadTime?: number;
  pointer?: CollaborationPointerPresence | null;
}

export interface CollaborationPresencePeerV2 extends CollaborationIdentity, CollaborationPresencePatchV2 {
  pingMs?: number;
}

export type CollaborationPresencePatchV3 = CollaborationPresencePatchV2;
export type CollaborationPresencePeerV3 = CollaborationPresencePeerV2;

export type CollaborationPresenceClientMessageV2 = CollaborationPresencePatchV2 & {
  type: 'presence:update';
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V2;
};

export type CollaborationPresenceServerMessageV2 =
  | {
    type: 'presence:snapshot';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V2;
    peers: CollaborationPresencePeerV2[];
  }
  | {
    type: 'presence:update';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V2;
    peer: CollaborationPresencePeerV2;
  }
  | {
    type: 'presence:remove';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V2;
    clientId: CollaborationClientId;
  };

/**
 * Scoped custom-motion edit lease (ADR-0028). The lease covers the whole
 * characterPerformance source entity; top-level statements use statement.id
 * and dialogue companions use the parent statement id + companion id.
 */
export type CollaborationLeaseTargetV2 =
  | { kind: 'statement'; statementId: CollaborativeStatementId }
  | { kind: 'companion'; statementId: CollaborativeStatementId; companionId: CollaborativeCompanionId };

export type CollaborationLeaseTargetV3 = CollaborationLeaseTargetV2;

export type CollaborationLeaseClientMessageV2 =
  | {
    type: 'lease:acquire';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V2;
    requestId: string;
    target: CollaborationLeaseTargetV2;
  }
  | {
    type: 'lease:renew';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V2;
    requestId: string;
    target: CollaborationLeaseTargetV2;
  }
  | {
    type: 'lease:release';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V2;
    requestId: string;
    target: CollaborationLeaseTargetV2;
  };

export type CollaborationLeaseServerMessageV2 =
  | {
    type: 'lease:acquired';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V2;
    requestId: string;
    target: CollaborationLeaseTargetV2;
  }
  | {
    type: 'lease:denied';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V2;
    requestId: string;
    target: CollaborationLeaseTargetV2;
    heldByClientId: CollaborationClientId;
  }
  | {
    type: 'lease:released';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V2;
    target: CollaborationLeaseTargetV2;
  };

export type CollaborationPresenceClientMessageV3 = CollaborationPresencePatchV2 & {
  type: 'presence:update';
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3;
};

export type CollaborationPresenceServerMessageV3 =
  | {
    type: 'presence:snapshot';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3;
    peers: CollaborationPresencePeerV2[];
  }
  | {
    type: 'presence:update';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3;
    peer: CollaborationPresencePeerV2;
  }
  | {
    type: 'presence:remove';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3;
    clientId: CollaborationClientId;
  };

export type CollaborationLeaseClientMessageV3 =
  | {
    type: 'lease:acquire';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3;
    requestId: string;
    target: CollaborationLeaseTargetV2;
  }
  | {
    type: 'lease:renew';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3;
    requestId: string;
    target: CollaborationLeaseTargetV2;
  }
  | {
    type: 'lease:release';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3;
    requestId: string;
    target: CollaborationLeaseTargetV2;
  };

export type CollaborationLeaseServerMessageV3 =
  | {
    type: 'lease:acquired';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3;
    requestId: string;
    target: CollaborationLeaseTargetV2;
  }
  | {
    type: 'lease:denied';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3;
    requestId: string;
    target: CollaborationLeaseTargetV2;
    heldByClientId: CollaborationClientId;
  }
  | {
    type: 'lease:released';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3;
    target: CollaborationLeaseTargetV2;
  };

export type CollaborativeSceneMetaV4 = Omit<HistoricalSceneMetaV4, 'markers'>;
export type CollaborativeSceneMetaV5 = Omit<SceneMetaV5, 'markers'>;

export type CollaborativeAssetKind =
  | 'live2d-bundle'
  | 'background-image'
  | 'audio-file'
  | 'image-file'
  | 'animation-file'
  | 'generic-file';

export interface CollaborativeAssetFileEntry {
  relativePath: ProjectRelativeAssetPath;
  contentHash: ContentHash;
  sizeBytes: number;
  mimeType?: string;
}

export interface CollaborativeAssetManifestEntry {
  assetId: CollaborativeAssetId;
  kind: CollaborativeAssetKind;
  importKind: ResourceImportKind;
  projectRelativePath: ProjectRelativeAssetPath;
  entrypointPath: ProjectRelativeAssetPath;
  contentHash: ContentHash;
  files: CollaborativeAssetFileEntry[];
  createdAt: string;
}

export type CollaborativeAssetManifest = Record<ProjectRelativeAssetPath, CollaborativeAssetManifestEntry>;

export interface CollaborativeTombstoneRecord {
  id: string;
  deletedAt: string;
  deletedBy?: CollaborationClientId;
}

export interface CollaborativeTombstonesV2 {
  statements?: Record<CollaborativeStatementId, CollaborativeTombstoneRecord>;
  companions?: Record<CollaborativeStatementId, Record<CollaborativeCompanionId, CollaborativeTombstoneRecord>>;
  markers?: Record<string, CollaborativeTombstoneRecord>;
  visualTargets?: Record<VisualTargetId, CollaborativeTombstoneRecord>;
  segments?: Record<SegmentId, CollaborativeTombstoneRecord>;
  recipeOverlay?: Record<RecipeId, CollaborativeTombstoneRecord>;
  assets?: Record<CollaborativeAssetId, CollaborativeTombstoneRecord>;
}

export type CollaborativeTombstonesV3 = CollaborativeTombstonesV2;

export type CollaborativeStatementRecord = Omit<SceneStatement, 'companions'> & {
  id: CollaborativeStatementId;
};

export type CollaborativeCompanionRecord = DialogueCompanion & {
  id: CollaborativeCompanionId;
};

export interface CollaborativeCompanionGroup {
  companionsById: Record<CollaborativeCompanionId, CollaborativeCompanionRecord>;
  companionOrder: CollaborativeCompanionId[];
}

export interface CollaborativeSceneStateV2 {
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V2;
  /** Collaboration v2 is permanently paired with the historical scene-v4 contract. */
  sceneSchemaVersion: typeof SCENE_SCHEMA_VERSION_V4;
  collaborationProjectId: CollaborationProjectId;
  roomId: CollaborationSceneRoomId;
  sceneId: string;
  meta: CollaborativeSceneMetaV4;
  statementsById: Record<CollaborativeStatementId, CollaborativeStatementRecord>;
  statementOrder: CollaborativeStatementId[];
  companionGroupsByStatementId?: Record<CollaborativeStatementId, CollaborativeCompanionGroup>;
  markersById?: Record<string, SceneMarker>;
  visual?: SceneVisualBlock;
  assets?: CollaborativeAssetManifest;
  tombstones?: CollaborativeTombstonesV2;
}

export interface CollaborativeSceneStateV3 {
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3;
  /** Collaboration v3 is paired exclusively with the canonical scene-v5 contract. */
  sceneSchemaVersion: typeof SCENE_SCHEMA_VERSION_V5;
  collaborationProjectId: CollaborationProjectId;
  roomId: CollaborationSceneRoomId;
  sceneId: string;
  meta: CollaborativeSceneMetaV5;
  statementsById: Record<CollaborativeStatementId, CollaborativeStatementRecord>;
  statementOrder: CollaborativeStatementId[];
  companionGroupsByStatementId?: Record<CollaborativeStatementId, CollaborativeCompanionGroup>;
  markersById?: Record<string, SceneMarker>;
  visual?: SceneVisualBlock;
  assets?: CollaborativeAssetManifest;
  tombstones?: CollaborativeTombstonesV3;
}

export function isCollaborativeSceneStateV2(value: unknown): value is CollaborativeSceneStateV2 {
  return !!value
    && typeof value === 'object'
    && (value as any).schemaVersion === COLLABORATION_SCHEMA_VERSION_V2
    && (value as any).sceneSchemaVersion === SCENE_SCHEMA_VERSION_V4;
}

export function assertCollaborativeSceneStateV2(value: unknown): asserts value is CollaborativeSceneStateV2 {
  if (!isCollaborativeSceneStateV2(value)) {
    throw new Error(`Expected collaboration state schema version ${COLLABORATION_SCHEMA_VERSION_V2}`);
  }
}

export function isCollaborativeSceneStateV3(value: unknown): value is CollaborativeSceneStateV3 {
  return !!value
    && typeof value === 'object'
    && (value as any).schemaVersion === COLLABORATION_SCHEMA_VERSION_V3
    && (value as any).sceneSchemaVersion === SCENE_SCHEMA_VERSION_V5;
}

export function assertCollaborativeSceneStateV3(value: unknown): asserts value is CollaborativeSceneStateV3 {
  if (!isCollaborativeSceneStateV3(value)) {
    throw new Error(`Expected collaboration state schema version ${COLLABORATION_SCHEMA_VERSION_V3}`);
  }
}

export interface CollaborationServerStatus {
  running: boolean;
  host: string;
  port: number;
  dataDir: string;
  localUrl: string;
  lanUrls: string[];
  accessToken?: string;
  connectionPassword?: string;
  inviteUrls?: string[];
  assetRoot: string;
  hasState: boolean;
}
