import type {
  CollaborationPresencePatchV2,
  CollaborationPresenceServerMessageV2,
  CollaborativeSceneStateV2,
} from '../../api/types/collaboration';
import type {
  CollaborativeCompanionChanges,
  CollaborativeStatementChanges,
} from './CollaborativeYDocStore';

export interface CollaborativeClientPortV2 {
  join(): Promise<CollaborativeSceneStateV2 | null>;
  seed(state: CollaborativeSceneStateV2): Promise<void>;
  getState(): CollaborativeSceneStateV2 | null;
  publishState(state: CollaborativeSceneStateV2): Promise<void> | void;
  publishStatementChanges?(changes: CollaborativeStatementChanges): Promise<void> | void;
  publishCompanionChanges?(changes: CollaborativeCompanionChanges): Promise<void> | void;
  subscribe(listener: (state: CollaborativeSceneStateV2 | null) => void): () => void;
  subscribeRealtimeConnection?(listener: (isConnected: boolean) => void): () => void;
  subscribeErrors?(listener: (error: Error) => void): () => void;
  subscribePresence?(listener: (message: CollaborationPresenceServerMessageV2) => void): () => void;
  updatePresence?(patch: CollaborationPresencePatchV2): void;
  connectRealtime?(): Promise<void> | void;
  isRealtimeConnected?(): boolean;
  dispose?(): void;
}
