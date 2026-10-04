import type {
  CollaborationConnectionStatus,
  CollaborationPresencePatchV2,
  CollaborationPresenceServerMessageV3,
  CollaborativeAssetManifest,
} from '../../api/types/collaboration';
import {
  assertSceneDocumentV5,
  type SceneDocumentV5,
} from '../../api/types/semantic-scene';
import type { DocumentStore } from '../../ui/store/DocumentStore';
import type { SemanticDocumentCoordinator } from '../document/SemanticDocumentCoordinator';
import type { CollaborativeClientPortV3 } from './CollaborativeClientPortV3';
import {
  CollaborativeDocumentSyncLoopV3,
} from './CollaborativeDocumentSyncLoopV3';
import {
  CollaborativeLocalCommitPipelineV3,
  type PrepareCollaborativeLocalStateV3,
} from './CollaborativeLocalCommitPipelineV3';
import { CollaborativeRemoteApplyPipelineV3 } from './CollaborativeRemoteApplyPipelineV3';
import { createCollaborativeSceneStateV3FromDocument } from './CollaborativeSceneStateV3';
import { validateCanonicalV5CollaborationAdmission } from './CollaborativeSceneAdmissionGate';

export interface CollaborativeDocumentLayerV3Options {
  documentStore?: DocumentStore;
  getSceneDocument?: () => SceneDocumentV5 | null;
  subscribeLocal?: (listener: () => void) => () => void;
  coordinator?: SemanticDocumentCoordinator | { applyDocument: (document: any, path?: string) => Promise<unknown> };
  applyDocument?: (document: SceneDocumentV5, path?: string) => Promise<unknown> | unknown;
  client: CollaborativeClientPortV3;
  collaborationProjectId: string;
  roomId: string;
  initialAssets?: CollaborativeAssetManifest;
  prepareLocalState?: PrepareCollaborativeLocalStateV3;
  beforeApplyState?: ConstructorParameters<typeof CollaborativeRemoteApplyPipelineV3>[0]['beforeApplyState'];
  getApplyScenePath?: ConstructorParameters<typeof CollaborativeRemoteApplyPipelineV3>[0]['getApplyScenePath'];
  afterApplyState?: ConstructorParameters<typeof CollaborativeRemoteApplyPipelineV3>[0]['afterApplyState'];
  onStatusChange?: (status: CollaborationConnectionStatus) => void;
  onError?: (error: unknown) => void;
  onSynchronizedState?: () => void;
  allowSeed?: boolean;
  prepareSeedState?: (
    document: SceneDocumentV5,
  ) => Promise<{ document: SceneDocumentV5; assets?: CollaborativeAssetManifest } | undefined> | { document: SceneDocumentV5; assets?: CollaborativeAssetManifest } | undefined;
}

export class CollaborativeDocumentLayerV3 {
  private status: CollaborationConnectionStatus = 'disconnected';
  private readonly syncLoop: CollaborativeDocumentSyncLoopV3;
  private readonly unsubscribes: Array<() => void> = [];

  constructor(private readonly options: CollaborativeDocumentLayerV3Options) {
    const remoteApplyPipeline = new CollaborativeRemoteApplyPipelineV3({
      coordinator: options.coordinator,
      applyDocument: options.applyDocument,
      beforeApplyState: options.beforeApplyState,
      getApplyScenePath: options.getApplyScenePath,
      afterApplyState: options.afterApplyState,
    });
    this.syncLoop = new CollaborativeDocumentSyncLoopV3({
      documentStore: options.documentStore,
      getSceneDocument: options.getSceneDocument,
      subscribeLocal: options.subscribeLocal,
      client: options.client,
      localCommitPipeline: new CollaborativeLocalCommitPipelineV3({
        prepareLocalState: options.prepareLocalState,
      }),
      remoteApplyPipeline,
      getStatus: () => this.status,
      setStatus: (status) => this.setStatus(status),
      notifyError: (error) => options.onError?.(error),
      onRemoteStateRejected: (error) => {
        this.setStatus('error');
        options.client.rejectRemoteState?.(error);
        options.onError?.(error);
      },
      onSynchronizedState: options.onSynchronizedState,
    });
  }

  async connect(): Promise<void> {
    this.setStatus('connecting');
    try {
      const remote = await this.options.client.join();
      if (!remote) {
        if (this.options.allowSeed === false) {
          throw new Error('Collaboration room does not exist');
        }
        const rawDocument = this.getLocalDocument();
        if (!rawDocument) {
          throw new Error('Collaboration v3 requires a canonical scene v5 document');
        }
        assertSceneDocumentV5(rawDocument);
        const admission = validateCanonicalV5CollaborationAdmission(rawDocument);
        if (!admission.ok) {
          throw new Error(`Cannot seed collaborative scene v3: ${admission.reason}`);
        }
        const document = admission.document;

        this.setStatus('seeding');
        const prepared = await this.options.prepareSeedState?.(document);
        await this.options.client.seed(createCollaborativeSceneStateV3FromDocument(prepared?.document ?? document, {
          collaborationProjectId: this.options.collaborationProjectId,
          roomId: this.options.roomId,
          assets: prepared?.assets ?? this.options.initialAssets,
        }));
        const seeded = this.options.client.getState();
        if (seeded) {
          await this.syncLoop.synchronizeRemote(seeded, {
            prepareAssets: false,
            requireServerSceneAgreement: false,
          });
        }
      } else {
        await this.syncLoop.synchronizeRemote(remote);
      }
      this.syncLoop.start();
      const subscribeRealtimeStatus = this.options.client.subscribeRealtimeStatus;
      this.unsubscribes.push(
        subscribeRealtimeStatus
          ? this.options.client.subscribeRealtimeStatus!((status) => {
            this.setStatus(status);
            if (status === 'connected') this.syncLoop.scheduleLocalPublish(false);
          })
          : this.options.client.subscribeRealtimeConnection?.((connected) => {
            this.setStatus(connected ? 'connected' : 'offline');
            if (connected) this.syncLoop.scheduleLocalPublish(false);
          }) ?? (() => undefined),
        this.options.client.subscribeErrors?.((error) => {
          this.setStatus('error');
          this.options.onError?.(error);
        }) ?? (() => undefined),
      );
      await this.options.client.connectRealtime?.();
      if (!subscribeRealtimeStatus) {
        this.setStatus(this.options.client.isRealtimeConnected?.() ? 'connected' : 'offline');
      }
    } catch (error) {
      this.syncLoop.dispose();
      this.setStatus('error');
      this.options.onError?.(error);
      throw error;
    }
  }

  dispose(): void {
    this.syncLoop.dispose();
    this.unsubscribes.splice(0).forEach((unsubscribe) => unsubscribe());
    this.options.client.dispose?.();
    this.setStatus('disconnected');
  }

  getStatus(): CollaborationConnectionStatus { return this.status; }

  updatePresence(patch: CollaborationPresencePatchV2): void {
    this.options.client.updatePresence?.(patch);
  }

  subscribePresence(listener: (message: CollaborationPresenceServerMessageV3) => void): () => void {
    return this.options.client.subscribePresence?.(listener) ?? (() => undefined);
  }

  publishCurrentSceneNow(forcePrepareLocalState = true): Promise<void> {
    return this.syncLoop.scheduleLocalPublish(forcePrepareLocalState);
  }

  private getLocalDocument(): SceneDocumentV5 | null {
    if (this.options.getSceneDocument) {
      return this.options.getSceneDocument();
    }
    if (this.options.documentStore) {
      const snap = this.options.documentStore.getCurrentSceneDocumentSnapshot();
      return (snap && snap.schemaVersion === 5) ? snap as SceneDocumentV5 : null;
    }
    return null;
  }

  private setStatus(status: CollaborationConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatusChange?.(status);
  }
}
