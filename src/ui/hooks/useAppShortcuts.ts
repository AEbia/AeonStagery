import { useCallback, useMemo } from 'react';
import type { BootstrapContext } from '../../engine/Bootstrapper';
import type { CollaborationConnectionStatus } from '../../api/types/collaboration';
import { eventBus } from '../../api/events';
import { isCollaborationUndoDisabled } from '../context/AppContext';
import { useSettings } from '../SettingsStore';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { formatShortcutBinding, getEffectiveShortcutBindings } from '../shortcuts/shortcutUtils';
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
  const { settings } = useSettings();
  const saveShortcutTitle = useMemo(() => {
    const [binding] = getEffectiveShortcutBindings(settings.keyboardShortcuts, 'app.save');
    const suffix = binding ? ` (${formatShortcutBinding(binding)})` : '';
    return `保存场景${suffix}`;
  }, [settings.keyboardShortcuts]);

  const handlePlayPause = useCallback(() => {
    const playback = contextValue.adapters.playback;
    if (contextValue.stores.playback.playing) {
      playback.pause();
    } else {
      playback.play();
    }
  }, [contextValue]);

  const handleFrameStep = useCallback((dir: 1 | -1) => {
    const playback = contextValue.adapters.playback;
    const t = playback.getCurrentTime();
    playback.seek(Math.max(0, t + dir * (1 / 60)));
  }, [contextValue]);

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

  useKeyboardShortcuts({
    initialized,
    onPlayPause: handlePlayPause,
    onStageReset: handleStageReset,
    onFrameStep: handleFrameStep,
    onSave: () => { if (hasLoadedScene) void handleSave(); },
    onOpenProject: () => { void handleOpenProject(); },
    onExport: () => { if (!showProjectHome) setShowExport(true); },
    onOpenShortcutSettings: () => { void eventBus.emit('ui:openSettings', { tab: 'shortcuts' }); },
    onUndo: handleUndo,
    onRedo: handleRedo,
  });

  return {
    saveShortcutTitle,
  };
}
