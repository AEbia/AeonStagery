import type {
  CollaborationConnectionStatus,
  CollaborationIdentity,
  CollaborativeAssetManifest,
} from '../../api/types/collaboration';
import type { SceneDocumentV5 } from '../../api/types/semantic-scene';
import type { DocumentStore } from '../../ui/store/DocumentStore';
import type { SemanticDocumentCoordinator } from '../document/SemanticDocumentCoordinator';
import type { CompatibleSceneSession } from '../semantic-scene/CompatibleSceneSession';
import { CollaborationClientV3, type CollaborationClientV3Options } from './CollaborationClientV3';
import {
  CollaborativeDocumentLayerV3,
  type CollaborativeDocumentLayerV3Options,
} from './CollaborativeDocumentLayerV3';
import type { CollaborativeClientPortV3 } from './CollaborativeClientPortV3';
import {
  CollaborativeSceneAdmissionGate,
} from './CollaborativeSceneAdmissionGate';

export interface CollaborativeSessionStartInputV3 {
  endpoint: string;
  identity: CollaborationIdentity;
  collaborationProjectId: string;
  roomId: string;
  documentStore?: DocumentStore;
  getSceneDocument?: () => SceneDocumentV5 | null;
  subscribeLocal?: (listener: () => void) => () => void;
  coordinator?: SemanticDocumentCoordinator | { applyDocument: (document: any, path?: string) => Promise<unknown> };
  applyDocument?: (document: SceneDocumentV5, path?: string) => Promise<unknown> | unknown;
  initialAssets?: CollaborativeAssetManifest;
  clientOptions?: Omit<CollaborationClientV3Options, 'endpoint' | 'identity'>;
  client?: CollaborativeClientPortV3;
  prepareLocalState?: CollaborativeDocumentLayerV3Options['prepareLocalState'];
  beforeApplyState?: CollaborativeDocumentLayerV3Options['beforeApplyState'];
  getApplyScenePath?: CollaborativeDocumentLayerV3Options['getApplyScenePath'];
  afterApplyState?: CollaborativeDocumentLayerV3Options['afterApplyState'];
  prepareSeedState?: CollaborativeDocumentLayerV3Options['prepareSeedState'];
  onStatusChange?: (status: CollaborationConnectionStatus) => void;
  onError?: (error: unknown) => void;
  onSynchronizedState?: () => void;
  allowSeed?: boolean;
  admissionGate?: CollaborativeSceneAdmissionGate;
  compatibleSceneSession?: CompatibleSceneSession;
  sceneDocument?: unknown;
}

export class CollaborativeSessionOrchestratorV3 {
  private layer: CollaborativeDocumentLayerV3 | null = null;
  private readonly defaultAdmissionGate: CollaborativeSceneAdmissionGate;

  constructor(admissionGate: CollaborativeSceneAdmissionGate = new CollaborativeSceneAdmissionGate()) {
    this.defaultAdmissionGate = admissionGate;
  }

  async start(input: CollaborativeSessionStartInputV3): Promise<CollaborativeDocumentLayerV3> {
    const gate = input.admissionGate ?? this.defaultAdmissionGate;
    const target = input.compatibleSceneSession
      ?? input.sceneDocument
      ?? input.getSceneDocument?.()
      ?? input.documentStore?.getCurrentSceneDocumentSnapshot();
    if (target) {
      gate.assertAdmission(target);
    }

    this.stop();
    const client = input.client ?? new CollaborationClientV3({
      ...input.clientOptions,
      endpoint: input.endpoint,
      identity: input.identity,
    });
    const layer = new CollaborativeDocumentLayerV3({
      documentStore: input.documentStore,
      getSceneDocument: input.getSceneDocument,
      subscribeLocal: input.subscribeLocal,
      coordinator: input.coordinator,
      applyDocument: input.applyDocument,
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

  get activeLayer(): CollaborativeDocumentLayerV3 | null {
    return this.layer;
  }
}
