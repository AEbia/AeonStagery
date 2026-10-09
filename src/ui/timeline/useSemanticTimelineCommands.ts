import { useMemo, useCallback, useRef } from 'react';
import { useCollaborationStatus, useDocumentStore, useSemanticAuthoringService } from '../context/AppContext';
import { deriveCollaborationStatusUx } from '../../services/collaboration/CollaborationStatusUxModel';
import { showToast } from '../Toast';
import { createSemanticTimelineCommands } from './semanticTimelineCommands';

export function useSemanticTimelineCommands(select: (ids: Record<string, boolean>) => void) {
  const store = useDocumentStore();
  const authoring = useSemanticAuthoringService();
  const status = useCollaborationStatus();
  const statusRef = useRef(status);
  statusRef.current = status;
  const blockOffline = useCallback(() => {
    const currentStatus = statusRef.current;
    if (currentStatus !== 'offline' && currentStatus !== 'reconnecting') return false;
    showToast(deriveCollaborationStatusUx({ status: currentStatus }).offlineEditMessage
      ?? '共享编辑已暂停；请重新加入后才能编辑。', 'warning');
    return true;
  }, []);
  return useMemo(() => createSemanticTimelineCommands({
    store, authoring, blockOffline, select,
    onError: (error) => showToast(error instanceof Error ? error.message : '无法修改语句', 'warning'),
  }), [store, authoring, blockOffline, select]);
}
