import { useState, useEffect, useCallback } from 'react';
import {
  usePlaybackAdapter,
  useDocumentStore,
  useApp,
  useCollaborationStatus,
  useSemanticAuthoringService,
} from '../context/AppContext';
import { showToast } from '../Toast';
import {
  buildSemanticSplitTimelineIntents,
} from './semanticTimelineEditing';
import { useSemanticTimelineSnapshot, type SemanticTimelineSnapshot } from './useSemanticTimelineSnapshot';
import { useSemanticTimelineCommands } from './useSemanticTimelineCommands';

interface BlockContextMenuOptions {
  semanticSnapshot?: SemanticTimelineSnapshot;
  selectAfterCommit?: (ids: Record<string, boolean>) => void;
  onCopyActions?: (ids: readonly string[]) => void;
  onDuplicateActions?: (ids: readonly string[]) => void | Promise<void>;
  onDeleteActions?: (ids: readonly string[]) => void | Promise<void>;
  /** Conditional motion actions, resolved lazily from the target id at dispatch time. */
  getMotionActions?: (id: string) => Array<{ label: string; danger?: boolean; run: () => void | Promise<void> }>;
  onLocateParent?: (id: string) => void | Promise<void>;
}

export function useBlockContextMenu(options: BlockContextMenuOptions = {}) {
  const playbackAdapter = usePlaybackAdapter();
  const documentStore = useDocumentStore();
  const semanticAuthoring = useSemanticAuthoringService();
  const app = useApp();
  const editorStore = app.stores.editor;
  const selectAfterCommit = useCallback((ids: Record<string, boolean>) => {
    if (options.selectAfterCommit) options.selectAfterCommit(ids);
    else app.adapters.timeline.select(ids);
  }, [app, options.selectAfterCommit]);
  const commands = useSemanticTimelineCommands(selectAfterCommit);
  const semanticSnapshot = useSemanticTimelineSnapshot(options.semanticSnapshot);
  const collaborationStatus = useCollaborationStatus();

  const [menuState, setMenuState] = useState<{
    x: number;
    y: number;
    targetId: string;
    disableSplit?: boolean;
    isCompanion?: boolean;
  } | null>(null);

  // Close context menu on click outside
  useEffect(() => {
    if (!menuState) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.track-context-menu')) {
        setMenuState(null);
      }
    };
    document.addEventListener('mousedown', onMouseDown, true);
    return () => document.removeEventListener('mousedown', onMouseDown, true);
  }, [menuState]);

  const handleBlockContextMenu = (e: React.MouseEvent, id: string, isStateSpan = false) => {
    e.preventDefault();
    e.stopPropagation();
    const semanticItem = semanticSnapshot.itemById.get(id);
    const menuPadding = 20;
    const menuHeight = semanticItem?.locator.kind === 'companion' ? 280 : 240;
    const x = Math.min(e.clientX, window.innerWidth - 200 - menuPadding);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - menuPadding);
    setMenuState({
      x,
      y,
      targetId: id,
      disableSplit: isStateSpan,
      isCompanion: semanticItem?.locator.kind === 'companion',
    });
  };

  const dispatchMenuAction = async (actionIdx: number) => {
    if (!menuState) return;

    if ((collaborationStatus === 'offline' || collaborationStatus === 'reconnecting') && actionIdx !== 0) {
      showToast(
        collaborationStatus === 'reconnecting'
          ? '共享编辑已暂停；实时通道恢复后才能继续编辑。'
          : '共享编辑已暂停；请手动重连后才能继续编辑。',
        'warning',
      );
      setMenuState(null);
      return;
    }

    const id = menuState.targetId;
    const semanticItem = semanticSnapshot.itemById.get(id);
    if (!semanticItem) return;
    const timelineAction = semanticItem.displayAction;

    const actions = [
      // 0: Copy
      () => {
        if (options.onCopyActions) {
          options.onCopyActions([id]);
          return;
        }
        const statements = commands.copy([id]);
        if (statements.length > 0) editorStore.setCopyBuffer(statements);
      },
      // 1: Paste
      async () => {
        const buffer = editorStore.copyBuffer;
        if (buffer.length === 0) return;
        const insertTime = semanticItem.time
          + (semanticItem.durationSeconds || timelineAction.params.duration || 1);
        await commands.paste(buffer, insertTime, 'block-context-menu');
      },
      // 2: Duplicate / Copy action
      async () => {
        if (options.onDuplicateActions) {
          await options.onDuplicateActions([id]);
          return;
        }
        await commands.duplicate([id]);
      },
      // 3: Split at playhead
      async () => {
        if (menuState.disableSplit) return;
        const playheadTime = playbackAdapter.getCurrentTime();
        const blockStart = semanticItem.time;
        const blockDuration = semanticItem.durationSeconds || timelineAction.params.duration || 1;
        const blockEnd = blockStart + blockDuration;
        if (playheadTime <= blockStart || playheadTime >= blockEnd) return;
        if (!semanticAuthoring) return;
        const intents = buildSemanticSplitTimelineIntents(documentStore, id, playheadTime);
        if (intents.length > 0) await semanticAuthoring.authorTransaction(intents);
      },
      // 4: Delete
      async () => {
        if (options.onDeleteActions) {
          await options.onDeleteActions([id]);
          return;
        }
        await commands.delete([id]);
      },
      ...(options.getMotionActions ? options.getMotionActions(id).map((motionAction) => (
        async () => { await motionAction.run(); }
      )) : []),
    ];

    if (semanticItem.locator.kind === 'companion' && options.onLocateParent) {
      actions.splice(5, 0, async () => { await options.onLocateParent?.(id); });
    }

    if (actionIdx >= 0 && actionIdx < actions.length) {
      await actions[actionIdx]();
      setMenuState(null);
    }
  };

  return {
    menuState,
    setMenuState,
    handleBlockContextMenu,
    dispatchMenuAction,
  };
}
