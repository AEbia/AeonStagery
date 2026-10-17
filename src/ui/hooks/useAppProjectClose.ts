import { useCallback, useRef, useState } from 'react';
import type { BootstrapContext } from '../../engine/Bootstrapper';
import { showToast } from '../Toast';

/** Save before leaving, then detach the session and clear project editor state. */
export function useAppProjectClose(
  context: BootstrapContext,
  disconnect: () => Promise<void>,
  waitForPendingProjectOperations: () => Promise<void>,
) {
  const closingRef = useRef(false);
  const [isClosingProject, setIsClosingProject] = useState(false);

  const handleCloseProject = useCallback(async (): Promise<boolean> => {
    if (closingRef.current || !context.services.projectWorkspace.getCurrentProject()) return false;
    closingRef.current = true;
    setIsClosingProject(true);
    try {
      await waitForPendingProjectOperations();
      context.adapters.playback.pause();
      // Finish a custom motion edit before taking the final scene snapshot.
      await context.services.customMotionEditing.closeActive('authority-changed');
      await context.services.customMotionConversion.cancel();
      await context.services.semanticAuthoring.waitForPendingEdits();
      const savedVersion = context.stores.document.version;
      if (context.stores.document.getCurrentSceneDocumentView()) {
        const saved = await context.services.sceneFile.save();
        if (!saved.success) {
          if ('error' in saved) showToast(`关闭项目失败，场景未保存：${saved.error}`, 'error');
          return false;
        }
      }
      await disconnect();
      await context.services.semanticAuthoring.waitForPendingEdits();
      // A remote edit may have arrived while the initial save was in flight.
      if (context.stores.document.getCurrentSceneDocumentView() && context.stores.document.version !== savedVersion) {
        const saved = await context.services.sceneFile.save();
        if (!saved.success) {
          if ('error' in saved) showToast(`关闭项目失败，场景未保存：${saved.error}`, 'error');
          return false;
        }
      }
      context.stores.document._setFilePath(null);
      context.stores.document._clearCurrentSceneDocumentSnapshot();
      context.services.semanticAuthoring.clearHistory();
      context.adapters.timeline.clearSelection();
      context.stores.editor.setCopyBuffer([]);
      context.stores.editor.setSaveStatus('idle');
      context.stores.playback.setDuration(0);
      context.stores.validation._clearAllSources();
      context.services.projectWorkspace.closeProject();
      return true;
    } catch (error) {
      showToast(`关闭项目失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      return false;
    } finally {
      closingRef.current = false;
      setIsClosingProject(false);
    }
  }, [context, disconnect, waitForPendingProjectOperations]);

  return { handleCloseProject, isClosingProject };
}
