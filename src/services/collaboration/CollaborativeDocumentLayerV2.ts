import type {
  CollaborationConnectionStatus,
  CollaborationPresencePatchV2,
  CollaborationPresenceServerMessageV2,
  CollaborativeAssetManifest,
} from '../../api/types/collaboration';
import type { DocumentStore } from '../../ui/store/DocumentStore';
import type { SemanticDocumentCoordinator } from '../document/SemanticDocumentCoordinator';
import type { CollaborativeClientPortV2 } from './CollaborativeClientPortV2';
import {
  CollaborativeDocumentSyncLoopV2,
} from './CollaborativeDocumentSyncLoopV2';
import {
  CollaborativeLocalCommitPipelineV2,
  type PrepareCollaborativeLocalStateV2,
} from './CollaborativeLocalCommitPipelineV2';
import { CollaborativeRemoteApplyPipelineV2 } from './CollaborativeRemoteApplyPipelineV2';
import { createCollaborativeSceneStateV2FromDocument } from './CollaborativeSceneStateV2';

export interface CollaborativeDocumentLayerV2Options {
  documentStore: DocumentStore;
  coordinator: SemanticDocumentCoordinator;
  client: CollaborativeClientPortV2;
  collaborationProjectId: string;
  roomId: string;
  initialAssets?: CollaborativeAssetManifest;
  prepareLocalState?: PrepareCollaborativeLocalStateV2;
  beforeApplyState?: ConstructorParameters<typeof CollaborativeRemoteApplyPipelineV2>[0]['beforeApplyState'];
  getApplyScenePath?: ConstructorParameters<typeof CollaborativeRemoteApplyPipelineV2>[0]['getApplyScenePath'];
  afterApplyState?: ConstructorParameters<typeof CollaborativeRemoteApplyPipelineV2>[0]['afterApplyState'];
  onStatusChange?: (status: CollaborationConnectionStatus) => void;
  onError?: (error: unknown) => void;
  onSynchronizedState?: () => void;
  allowSeed?: boolean;
  prepareSeedState?: (
    document: import('../../api/types/semantic-scene').HistoricalSceneDocumentV4,
  ) => Promise<{ document: import('../../api/types/semantic-scene').HistoricalSceneDocumentV4; assets?: CollaborativeAssetManifest } | undefined>;
}

export class CollaborativeDocumentLayerV2 {
  private status: CollaborationConnectionStatus = 'disconnected';
  private readonly syncLoop: CollaborativeDocumentSyncLoopV2;
  private readonly unsubscribes: Array<() => void> = [];

  constructor(private readonly options: CollaborativeDocumentLayerV2Options) {
    const remoteApplyPipeline = new CollaborativeRemoteApplyPipelineV2({
      coordinator: options.coordinator,
      beforeApplyState: options.beforeApplyState,
      getApplyScenePath: options.getApplyScenePath,
      afterApplyState: options.afterApplyState,
    });
    this.syncLoop = new CollaborativeDocumentSyncLoopV2({
      documentStore: options.documentStore,
      client: options.client,
      localCommitPipeline: new CollaborativeLocalCommitPipelineV2({
        prepareLocalState: options.prepareLocalState,
      }),
      remoteApplyPipeline,
      getStatus: () => this.status,
      setStatus: (status) => this.setStatus(status),
      notifyError: (error) => options.onError?.(error),
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
        const document = this.options.documentStore.getHistoricalSceneDocumentV4Snapshot();
        if (!document) throw new Error('Collaboration v2 requires a historical scene v4 document');
        this.setStatus('seeding');
        const prepared = await this.options.prepareSeedState?.(document);
        await this.options.client.seed(createCollaborativeSceneStateV2FromDocument(prepared?.document ?? document, {
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
      this.unsubscribes.push(
        this.options.client.subscribeRealtimeConnection?.((connected) => {
          this.setStatus(connected ? 'connected' : 'offline');
          if (connected) this.syncLoop.scheduleLocalPublish(false);
        }) ?? (() => undefined),
        this.options.client.subscribeErrors?.((error) => {
          this.setStatus('error');
          this.options.onError?.(error);
        }) ?? (() => undefined),
      );
      // connectRealtime resolves once the attempt has been dispatched, so the
      // connection status below reflects that attempt rather than racing it.
      await this.options.client.connectRealtime?.();
      this.setStatus(this.options.client.isRealtimeConnected?.() ? 'connected' : 'offline');
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

  subscribePresence(listener: (message: CollaborationPresenceServerMessageV2) => void): () => void {
    return this.options.client.subscribePresence?.(listener) ?? (() => undefined);
  }

  publishCurrentSceneNow(forcePrepareLocalState = true): Promise<void> {
    return this.syncLoop.scheduleLocalPublish(forcePrepareLocalState);
  }

  private setStatus(status: CollaborationConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatusChange?.(status);
  }
}
