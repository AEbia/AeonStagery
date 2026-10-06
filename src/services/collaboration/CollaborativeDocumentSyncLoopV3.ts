import type {
  CollaborationConnectionStatus,
  CollaborativeSceneStateV3,
} from '../../api/types/collaboration';
import type { SceneDocumentV5 } from '../../api/types/semantic-scene';
import type { DocumentStore } from '../../ui/store/DocumentStore';
import type { CollaborativeClientPortV3 } from './CollaborativeClientPortV3';
import { CollaborativeLocalCommitPipelineV3 } from './CollaborativeLocalCommitPipelineV3';
import type { CollaborativeRemoteApplyPipelineV3 } from './CollaborativeRemoteApplyPipelineV3';
import { filterTombstonedCollaborativeRecordsV3 } from './CollaborativeStateTransactionPlannerV3';
import { CollaborationRemoteStateRejectedError } from './CollaborationErrors';

export interface CollaborativeDocumentSyncLoopV3Options {
  documentStore?: DocumentStore;
  getSceneDocument?: () => SceneDocumentV5 | null;
  subscribeLocal?: (listener: () => void) => () => void;
  client: CollaborativeClientPortV3;
  localCommitPipeline: CollaborativeLocalCommitPipelineV3;
  remoteApplyPipeline: CollaborativeRemoteApplyPipelineV3;
  getStatus: () => CollaborationConnectionStatus;
  setStatus: (status: CollaborationConnectionStatus) => void;
  notifyError: (error: unknown) => void;
  onRemoteStateRejected?: (error: CollaborationRemoteStateRejectedError) => void;
  onSynchronizedState?: () => void;
  onInitialDocumentApplied?: () => void;
}

export class CollaborativeDocumentSyncLoopV3 {
  private unsubscribeRemote: (() => void) | null = null;
  private unsubscribeLocal: (() => void) | null = null;
  private remoteApplyQueue: Promise<void> = Promise.resolve();
  private localPublishQueue: Promise<void> = Promise.resolve();
  private applyingRemote = false;
  private remoteApplyFailed = false;
  private lastRemoteState: CollaborativeSceneStateV3 | null = null;
  private lastRemoteStateSignature = '';
  private lastPublishedDocument = '';
  private initialDocumentApplied = false;

  constructor(private readonly options: CollaborativeDocumentSyncLoopV3Options) {}

  start(): void {
    if (!this.unsubscribeRemote) {
      this.unsubscribeRemote = this.options.client.subscribe((state) => {
        if (!state) return;
        return this.synchronizeRemote(state);
      });
    }
    if (!this.unsubscribeLocal) {
      if (this.options.subscribeLocal) {
        this.unsubscribeLocal = this.options.subscribeLocal(() => this.scheduleLocalPublish());
      } else if (this.options.documentStore) {
        this.unsubscribeLocal = this.options.documentStore.subscribe(() => this.scheduleLocalPublish());
      }
    }
  }

  synchronizeRemote(
    state: CollaborativeSceneStateV3,
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
    if (this.applyingRemote || this.remoteApplyFailed || this.options.getStatus() !== 'connected') {
      return Promise.resolve();
    }
    const document = this.getLocalDocument();
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

  private getLocalDocument(): SceneDocumentV5 | null {
    if (this.options.getSceneDocument) {
      return this.options.getSceneDocument();
    }
    if (this.options.documentStore) {
      const snap = (this.options.documentStore as any).getSceneDocumentV5Snapshot?.()
        ?? this.options.documentStore.getCurrentSceneDocumentSnapshot();
      return (snap && snap.schemaVersion === 5) ? snap as SceneDocumentV5 : null;
    }
    return null;
  }

  private async applyRemote(
    state: CollaborativeSceneStateV3,
    options: { prepareAssets?: boolean; requireServerSceneAgreement?: boolean },
  ): Promise<void> {
    const filtered = filterTombstonedCollaborativeRecordsV3(state);
    const remoteStateSignature = JSON.stringify(filtered);
    if (remoteStateSignature === this.lastRemoteStateSignature) return;
    this.applyingRemote = true;
    try {
      const applyOptions = {
        ...options,
        requireServerSceneAgreement: options.requireServerSceneAgreement ?? this.lastRemoteState === null,
        onDocumentApplied: () => {
          if (this.initialDocumentApplied) return;
          this.initialDocumentApplied = true;
          this.options.onInitialDocumentApplied?.();
        },
      };
      const document = await this.options.remoteApplyPipeline.applyWithPreparation(
        filtered,
        this.lastRemoteState,
        applyOptions,
      );
      this.lastRemoteState = filtered;
      this.lastRemoteStateSignature = remoteStateSignature;
      this.lastPublishedDocument = JSON.stringify(document);
      this.remoteApplyFailed = false;
      this.options.onSynchronizedState?.();
    } catch (error) {
      // Keep transport status independent, but don't publish the still-local
      // document against a newer remote state. A later successful remote apply
      // moves the publish baseline forward and releases this gate.
      this.remoteApplyFailed = true;
      if (error instanceof CollaborationRemoteStateRejectedError) {
        this.options.onRemoteStateRejected?.(error);
      } else {
        this.options.notifyError(error);
      }
    } finally {
      this.applyingRemote = false;
    }
  }
}
