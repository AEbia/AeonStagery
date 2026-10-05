import type {
  CollaborationConnectionStatus,
  CollaborationLeaseServerMessageV3,
  CollaborationLeaseTargetV2,
  CollaborationPresencePatchV2,
  CollaborationPresenceServerMessageV3,
  CollaborativeSceneStateV3,
} from '../../api/types/collaboration';
import type {
  CollaborativeCompanionChanges,
  CollaborativeMarkerChanges,
  CollaborativeRecipeOverlayChanges,
  CollaborativeSegmentChanges,
  CollaborativeStatementChanges,
  CollaborativeVisualTargetChanges,
} from './CollaborativeYDocStore';

export interface CollaborativeClientPortV3 {
  join(): Promise<CollaborativeSceneStateV3 | null>;
  seed(state: CollaborativeSceneStateV3): Promise<void>;
  getState(): CollaborativeSceneStateV3 | null;
  publishState(state: CollaborativeSceneStateV3): Promise<void> | void;
  publishStatementChanges?(changes: CollaborativeStatementChanges): Promise<void> | void;
  publishCompanionChanges?(changes: CollaborativeCompanionChanges): Promise<void> | void;
  publishMarkerChanges?(changes: CollaborativeMarkerChanges): Promise<void> | void;
  publishVisualTargetChanges?(changes: CollaborativeVisualTargetChanges): Promise<void> | void;
  publishSegmentChanges?(changes: CollaborativeSegmentChanges): Promise<void> | void;
  publishRecipeOverlayChanges?(changes: CollaborativeRecipeOverlayChanges): Promise<void> | void;
  subscribe(listener: (state: CollaborativeSceneStateV3 | null) => void | Promise<void>): () => void;
  subscribeRealtimeConnection?(listener: (isConnected: boolean) => void): () => void;
  subscribeRealtimeStatus?(listener: (status: CollaborationConnectionStatus) => void): () => void;
  subscribeErrors?(listener: (error: Error) => void): () => void;
  subscribePresence?(listener: (message: CollaborationPresenceServerMessageV3) => void): () => void;
  subscribeLease?(listener: (message: CollaborationLeaseServerMessageV3) => void): () => void;
  updatePresence?(patch: CollaborationPresencePatchV2): void;
  acquireLease?(requestId: string, target: CollaborationLeaseTargetV2): void;
  renewLease?(requestId: string, target: CollaborationLeaseTargetV2): void;
  releaseLease?(requestId: string, target: CollaborationLeaseTargetV2): void;
  /**
   * Opens the realtime channel. Resolves once the connection attempt has been
   * dispatched or has failed — never by rejecting, so callers can await it
   * without attaching error handling. Errors surface through
   * {@link subscribeErrors}, and {@link isRealtimeConnected} is meaningful for
   * the attempt's initial outcome once this promise settles.
   */
  connectRealtime?(): Promise<void>;
  /** Discards the current socket and starts a fresh attempt; see {@link connectRealtime}. */
  reconnectRealtime?(): Promise<void>;
  rejectRemoteState?(error: Error): void;
  isRealtimeConnected?(): boolean;
  dispose?(): void;
}
