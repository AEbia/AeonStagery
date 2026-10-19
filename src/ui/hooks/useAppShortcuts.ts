import { DEFAULT_VIDEO_FORMAT } from '../../api/types/video-format';
import { useCallback } from 'react';
import type { BootstrapContext } from '../../engine/Bootstrapper';
import type { CollaborationConnectionStatus } from '../../api/types/collaboration';
import { eventBus } from '../../api/events';
import { isCollaborationUndoDisabled } from '../context/AppContext';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { showToast } from '../Toast';
import type { useEditorState } from '../store/storeHooks';

export function useAppShortcuts({
  contextValue, collaborationStatus, initialized, hasLoadedScene, showProjectHome,
  handleStageReset, handleSave, handleOpenProject, setShowExport,
}: {
  contextValue: BootstrapContext;
  collaborationStatus: CollaborationConnectionStatus;
  initialized: boolean;
  hasLoadedScene: boolean;
  showProjectHome: boolean;
  handleStageReset: () => void;
  handleSave: ReturnType<typeof useEditorState>['handleSave'];
  handleOpenProject: () => Promise<void>;
  setShowExport: (open: boolean) => void;
}) {
  const handlePlayPause = useCallback(() => {
    if (showProjectHome || !hasLoadedScene) return;
    const playback = contextValue.adapters.playback;
    if (contextValue.stores.playback.playing) {
      playback.pause();
    } else {
      playback.play();
    }
  }, [contextValue, hasLoadedScene, showProjectHome]);

  const handleFrameStep = useCallback((dir: 1 | -1) => {
    if (showProjectHome || !hasLoadedScene) return;
    const playback = contextValue.adapters.playback;
    const t = playback.getCurrentTime();
    const fps = contextValue.services.projectWorkspace?.getCurrentProject()?.metadata.videoFormat?.fps ?? DEFAULT_VIDEO_FORMAT.fps;
    playback.seek(Math.max(0, Math.min(playback.getDuration(), t + dir / fps)));
  }, [contextValue, hasLoadedScene, showProjectHome]);

  const handleUndo = useCallback(() => {
    if (isCollaborationUndoDisabled(collaborationStatus)) {
      showToast('协作模式暂不支持撤销', 'info');
      return;
    }
    void contextValue.services.semanticAuthoring.undo();
  }, [collaborationStatus, contextValue]);

  const handleRedo = useCallback(() => {
    if (isCollaborationUndoDisabled(collaborationStatus)) {
      showToast('协作模式暂不支持重做', 'info');
      return;
    }
    void contextValue.services.semanticAuthoring.redo();
  }, [collaborationStatus, contextValue]);

  const handleShortcutSave = async () => {
    if (!hasLoadedScene) return;
    const result = await handleSave();
    if (result?.success) {
      showToast('剧本保存成功！', 'success');
    }
  };

  useKeyboardShortcuts({
    initialized,
    onPlayPause: handlePlayPause,
    onStageReset: handleStageReset,
    onFrameStep: handleFrameStep,
    onSave: () => { void handleShortcutSave(); },
    onOpenProject: () => { void handleOpenProject(); },
    onExport: () => { if (!showProjectHome) setShowExport(true); },
    onOpenShortcutSettings: () => { void eventBus.emit('ui:openSettings', { tab: 'shortcuts' }); },
    onUndo: handleUndo,
    onRedo: handleRedo,
  });
}
