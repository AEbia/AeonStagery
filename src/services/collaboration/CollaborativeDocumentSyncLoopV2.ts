import type {
  CollaborationConnectionStatus,
  CollaborativeSceneStateV2,
} from '../../api/types/collaboration';
import type { DocumentStore } from '../../ui/store/DocumentStore';
import type { CollaborativeClientPortV2 } from './CollaborativeClientPortV2';
import { CollaborativeLocalCommitPipelineV2 } from './CollaborativeLocalCommitPipelineV2';
import type { CollaborativeRemoteApplyPipelineV2 } from './CollaborativeRemoteApplyPipelineV2';
import { filterTombstonedCollaborativeRecordsV2 } from './CollaborativeStateTransactionPlannerV2';

export interface CollaborativeDocumentSyncLoopV2Options {
  documentStore: DocumentStore;
  client: CollaborativeClientPortV2;
  localCommitPipeline: CollaborativeLocalCommitPipelineV2;
  remoteApplyPipeline: CollaborativeRemoteApplyPipelineV2;
  getStatus: () => CollaborationConnectionStatus;
  setStatus: (status: CollaborationConnectionStatus) => void;
  notifyError: (error: unknown) => void;
  onSynchronizedState?: () => void;
}

export class CollaborativeDocumentSyncLoopV2 {
  private unsubscribeRemote: (() => void) | null = null;
  private unsubscribeLocal: (() => void) | null = null;
  private remoteApplyQueue: Promise<void> = Promise.resolve();
  private localPublishQueue: Promise<void> = Promise.resolve();
  private applyingRemote = false;
  private lastRemoteState: CollaborativeSceneStateV2 | null = null;
  private lastRemoteStateSignature = '';
  private lastPublishedDocument = '';

  constructor(private readonly options: CollaborativeDocumentSyncLoopV2Options) {}

  start(): void {
    if (!this.unsubscribeRemote) {
      this.unsubscribeRemote = this.options.client.subscribe((state) => {
        if (!state) return;
        void this.synchronizeRemote(state);
      });
    }
    if (!this.unsubscribeLocal) {
      this.unsubscribeLocal = this.options.documentStore.subscribe(() => this.scheduleLocalPublish());
    }
  }

  synchronizeRemote(
    state: CollaborativeSceneStateV2,
    options: { prepareAssets?: boolean; requireServerSceneAgreement?: boolean } = {},
  ): Promise<void> {
    this.remoteApplyQueue = this.remoteApplyQueue
      .catch(() => undefined)
      .then(() => this.applyRemote(state, options));
    return this.remoteApplyQueue;
  }

  dispose(): void {
    this.unsubscribeRemote?.();
    this.unsubscribeLocal?.();
    this.unsubscribeRemote = null;
    this.unsubscribeLocal = null;
  }

  scheduleLocalPublish(forcePrepareLocalState = false): Promise<void> {
    if (this.applyingRemote || this.options.getStatus() !== 'connected') return Promise.resolve();
    const document = this.options.documentStore.getHistoricalSceneDocumentV4Snapshot();
    const latestState = this.options.client.getState();
    if (!document || !latestState) return Promise.resolve();
    const signature = JSON.stringify(document);
    if (!forcePrepareLocalState && signature === this.lastPublishedDocument) return Promise.resolve();

    this.localPublishQueue = this.localPublishQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.options.localCommitPipeline.commit({
            document,
            latestState: this.options.client.getState() ?? latestState,
            publisher: this.options.client,
            forcePrepareLocalState,
          });
          this.lastPublishedDocument = signature;
        } catch (error) {
          this.options.notifyError(error);
        }
      });
    return this.localPublishQueue;
  }

  private async applyRemote(
    state: CollaborativeSceneStateV2,
    options: { prepareAssets?: boolean; requireServerSceneAgreement?: boolean },
  ): Promise<void> {
    const filtered = filterTombstonedCollaborativeRecordsV2(state);
    const remoteStateSignature = JSON.stringify(filtered);
    if (remoteStateSignature === this.lastRemoteStateSignature) return;
    this.applyingRemote = true;
    try {
      const applyOptions = {
        ...options,
        requireServerSceneAgreement: options.requireServerSceneAgreement ?? this.lastRemoteState === null,
      };
      const document = await this.options.remoteApplyPipeline.applyWithPreparation(
        filtered,
        this.lastRemoteState,
        applyOptions,
      );
      this.lastRemoteState = filtered;
      this.lastRemoteStateSignature = remoteStateSignature;
      this.lastPublishedDocument = JSON.stringify(document);
      this.options.onSynchronizedState?.();
    } catch (error) {
      this.options.setStatus('error');
      this.options.notifyError(error);
    } finally {
      this.applyingRemote = false;
    }
  }
}
