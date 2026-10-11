import { useCallback, useRef, useState } from 'react';
import type { CollaborationConnectionStatus, CollaborationIdentity, CollaborationPresencePatchV2, CollaborationPresencePeerV2 } from '../../api/types/collaboration';
import type { CustomMotionEditLeaseGate } from '../../services/timeline-authoring/CustomMotionEditLeaseGate';

/** Keeps provider presence stable while the session publisher is replaced. */
export function useAppCollaborationState() {
  const [collaborationStatus, setCollaborationStatus] = useState<CollaborationConnectionStatus>('disconnected');
  const [collaborationSelf, setCollaborationSelf] = useState<CollaborationIdentity | null>(null);
  const [collaborationPeers, setCollaborationPeers] = useState<CollaborationPresencePeerV2[]>([]);
  const [customMotionEditLeaseGate, setCustomMotionEditLeaseGate] = useState<CustomMotionEditLeaseGate | null>(null);
  const collaborationPresencePublisherRef = useRef<(patch?: Partial<CollaborationPresencePatchV2>) => void>(() => {});
  const publishCollaborationPresence = useCallback((patch?: Partial<CollaborationPresencePatchV2>) => {
    collaborationPresencePublisherRef.current(patch);
  }, []);
  const setCollaborationPresencePublisher = useCallback((
    publisher: ((patch?: Partial<CollaborationPresencePatchV2>) => void) | null,
  ) => {
    collaborationPresencePublisherRef.current = publisher ?? (() => {});
  }, []);

  return {
    collaboration: {
      status: collaborationStatus, self: collaborationSelf, peers: collaborationPeers,
      publishPresence: publishCollaborationPresence, customMotionEditLeaseGate,
    },
    sessionBindings: {
      status: collaborationStatus, peers: collaborationPeers,
      onStatusChange: setCollaborationStatus, onSelfChange: setCollaborationSelf,
      onPeersChange: setCollaborationPeers,
      onPresencePublisherChange: setCollaborationPresencePublisher,
      onLeaseGateChange: setCustomMotionEditLeaseGate,
    },
  };
}
