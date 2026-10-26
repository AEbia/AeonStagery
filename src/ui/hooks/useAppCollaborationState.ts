import { useCallback, useRef, useState } from 'react';
import type { CollaborationConnectionStatus, CollaborationIdentity, CollaborationPresencePatchV3, CollaborationPresencePeerV3 } from '../../api/types/collaboration';

/** Keeps provider presence stable while the session publisher is replaced. */
export function useAppCollaborationState() {
  const [collaborationStatus, setCollaborationStatus] = useState<CollaborationConnectionStatus>('disconnected');
  const [collaborationSelf, setCollaborationSelf] = useState<CollaborationIdentity | null>(null);
  const [collaborationPeers, setCollaborationPeers] = useState<CollaborationPresencePeerV3[]>([]);
  const collaborationPresencePublisherRef = useRef<(patch?: Partial<CollaborationPresencePatchV3>) => void>(() => {});
  const publishCollaborationPresence = useCallback((patch?: Partial<CollaborationPresencePatchV3>) => {
    collaborationPresencePublisherRef.current(patch);
  }, []);
  const setCollaborationPresencePublisher = useCallback((
    publisher: ((patch?: Partial<CollaborationPresencePatchV3>) => void) | null,
  ) => {
    collaborationPresencePublisherRef.current = publisher ?? (() => {});
  }, []);

  return {
    collaboration: {
      status: collaborationStatus, self: collaborationSelf, peers: collaborationPeers,
      publishPresence: publishCollaborationPresence,
    },
    sessionBindings: {
      status: collaborationStatus, peers: collaborationPeers,
      onStatusChange: setCollaborationStatus, onSelfChange: setCollaborationSelf,
      onPeersChange: setCollaborationPeers,
      onPresencePublisherChange: setCollaborationPresencePublisher,
    },
  };
}
