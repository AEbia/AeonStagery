import type { ResourceImportKind } from './project';
import type { SceneMarker } from './scene-common';
import {
  SCENE_SCHEMA_VERSION_V5,
  type DialogueCompanion,
  type SceneMetaV5,
  type SceneStatement,
} from './semantic-scene';
import type { RecipeId, SceneVisualBlock, SegmentId, VisualTargetId } from './visual';

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

export type CollaborationEditingTargetV3 =
  | { kind: 'statement'; statementId: CollaborativeStatementId }
  | { kind: 'companion'; statementId: CollaborativeStatementId; companionId: CollaborativeCompanionId }
  | { kind: 'marker'; id: string }
  | { kind: 'visualTarget'; id: VisualTargetId }
  | { kind: 'segment'; id: SegmentId }
  | { kind: 'asset'; id: CollaborativeAssetId }
  | { kind: 'scene' };

export interface CollaborationPresencePatchV3 {
  selectedStatementIds: CollaborativeStatementId[];
  editingTarget?: CollaborationEditingTargetV3 | null;
  playheadTime?: number;
  pointer?: CollaborationPointerPresence | null;
}

export interface CollaborationPresencePeerV3 extends CollaborationIdentity, CollaborationPresencePatchV3 {
  pingMs?: number;
}

/**
 * Scoped custom-motion edit lease (ADR-0028). The lease covers the whole
 * characterPerformance source entity; top-level statements use statement.id
 * and dialogue companions use the parent statement id + companion id.
 */
export type CollaborationLeaseTargetV3 =
  | { kind: 'statement'; statementId: CollaborativeStatementId }
  | { kind: 'companion'; statementId: CollaborativeStatementId; companionId: CollaborativeCompanionId };

export type CollaborationPresenceClientMessageV3 = CollaborationPresencePatchV3 & {
  type: 'presence:update';
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3;
};

export type CollaborationPresenceServerMessageV3 =
  | {
    type: 'presence:snapshot';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3;
    peers: CollaborationPresencePeerV3[];
  }
  | {
    type: 'presence:update';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3;
    peer: CollaborationPresencePeerV3;
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
    target: CollaborationLeaseTargetV3;
  }
  | {
    type: 'lease:renew';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3;
    requestId: string;
    target: CollaborationLeaseTargetV3;
  }
  | {
    type: 'lease:release';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3;
    requestId: string;
    target: CollaborationLeaseTargetV3;
  };

export type CollaborationLeaseServerMessageV3 =
  | {
    type: 'lease:acquired';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3;
    requestId: string;
    target: CollaborationLeaseTargetV3;
  }
  | {
    type: 'lease:denied';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3;
    requestId: string;
    target: CollaborationLeaseTargetV3;
    heldByClientId: CollaborationClientId;
  }
  | {
    type: 'lease:released';
    schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3;
    target: CollaborationLeaseTargetV3;
  };
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

export interface CollaborativeTombstonesV3 {
  statements?: Record<CollaborativeStatementId, CollaborativeTombstoneRecord>;
  companions?: Record<CollaborativeStatementId, Record<CollaborativeCompanionId, CollaborativeTombstoneRecord>>;
  markers?: Record<string, CollaborativeTombstoneRecord>;
  visualTargets?: Record<VisualTargetId, CollaborativeTombstoneRecord>;
  segments?: Record<SegmentId, CollaborativeTombstoneRecord>;
  recipeOverlay?: Record<RecipeId, CollaborativeTombstoneRecord>;
  assets?: Record<CollaborativeAssetId, CollaborativeTombstoneRecord>;
}

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

export function isCollaborativeSceneStateV3(value: unknown): value is CollaborativeSceneStateV3 {
  return !!value
    && typeof value === 'object'
    && 'schemaVersion' in value && value.schemaVersion === COLLABORATION_SCHEMA_VERSION_V3
    && 'sceneSchemaVersion' in value && value.sceneSchemaVersion === SCENE_SCHEMA_VERSION_V5;
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
