import type {
  CollaborationConnectionStatus,
  CollaborationIdentity,
  CollaborativeAssetManifest,
} from '../../api/types/collaboration';
import type { DocumentStore } from '../../ui/store/DocumentStore';
import type { SemanticDocumentCoordinator } from '../document/SemanticDocumentCoordinator';
import type { CompatibleSceneSession } from '../semantic-scene/CompatibleSceneSession';
import { CollaborationClientV2, type CollaborationClientV2Options } from './CollaborationClientV2';
import {
  CollaborativeDocumentLayerV2,
  type CollaborativeDocumentLayerV2Options,
} from './CollaborativeDocumentLayerV2';
import type { CollaborativeClientPortV2 } from './CollaborativeClientPortV2';
import {
  CollaborativeSceneAdmissionGate,
} from './CollaborativeSceneAdmissionGate';

export interface CollaborativeSessionStartInputV2 {
  endpoint: string;
  identity: CollaborationIdentity;
  collaborationProjectId: string;
  roomId: string;
  documentStore: DocumentStore;
  coordinator: SemanticDocumentCoordinator;
  initialAssets?: CollaborativeAssetManifest;
  clientOptions?: Omit<CollaborationClientV2Options, 'endpoint' | 'identity'>;
  client?: CollaborativeClientPortV2;
  prepareLocalState?: CollaborativeDocumentLayerV2Options['prepareLocalState'];
  beforeApplyState?: CollaborativeDocumentLayerV2Options['beforeApplyState'];
  getApplyScenePath?: CollaborativeDocumentLayerV2Options['getApplyScenePath'];
  afterApplyState?: CollaborativeDocumentLayerV2Options['afterApplyState'];
  prepareSeedState?: CollaborativeDocumentLayerV2Options['prepareSeedState'];
  onStatusChange?: (status: CollaborationConnectionStatus) => void;
  onError?: (error: unknown) => void;
  onSynchronizedState?: () => void;
  allowSeed?: boolean;
  admissionGate?: CollaborativeSceneAdmissionGate;
  compatibleSceneSession?: CompatibleSceneSession;
  sceneDocument?: unknown;
  enforceCanonicalV5Admission?: boolean;
}

export type CollaborativeSessionStartInput = CollaborativeSessionStartInputV2;

export class CollaborativeSessionOrchestratorV2 {
  private layer: CollaborativeDocumentLayerV2 | null = null;
  private readonly defaultAdmissionGate: CollaborativeSceneAdmissionGate;

  constructor(admissionGate: CollaborativeSceneAdmissionGate = new CollaborativeSceneAdmissionGate()) {
    this.defaultAdmissionGate = admissionGate;
  }

  async start(input: CollaborativeSessionStartInputV2): Promise<CollaborativeDocumentLayerV2> {
    if (input.enforceCanonicalV5Admission || input.admissionGate || input.compatibleSceneSession) {
      const gate = input.admissionGate ?? this.defaultAdmissionGate;
      const target = input.compatibleSceneSession
        ?? input.sceneDocument
        ?? input.documentStore.getCurrentSceneDocumentSnapshot();
      gate.assertAdmission(target);
    }

    this.stop();
    const client = input.client ?? new CollaborationClientV2({
      ...input.clientOptions,
      endpoint: input.endpoint,
      identity: input.identity,
    });
    const layer = new CollaborativeDocumentLayerV2({
      documentStore: input.documentStore,
      coordinator: input.coordinator,
      client,
      collaborationProjectId: input.collaborationProjectId,
      roomId: input.roomId,
      initialAssets: input.initialAssets,
      prepareLocalState: input.prepareLocalState,
      beforeApplyState: input.beforeApplyState,
      getApplyScenePath: input.getApplyScenePath,
      afterApplyState: input.afterApplyState,
      prepareSeedState: input.prepareSeedState,
      onStatusChange: input.onStatusChange,
      onError: input.onError,
      onSynchronizedState: input.onSynchronizedState,
      allowSeed: input.allowSeed,
    });
    this.layer = layer;
    try {
      await layer.connect();
      return layer;
    } catch (error) {
      if (this.layer === layer) this.layer = null;
      layer.dispose();
      throw error;
    }
  }

  stop(): void {
    this.layer?.dispose();
    this.layer = null;
  }

  get activeLayer(): CollaborativeDocumentLayerV2 | null {
    return this.layer;
  }
}

export const CollaborativeSessionOrchestrator = CollaborativeSessionOrchestratorV2;
