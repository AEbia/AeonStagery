import { useState, useCallback, useEffect } from 'react';
import {
  usePlaybackAdapter, useDocumentStore, useSemanticAuthoringService,
  useIsCollaborationUndoDisabled, useCollaborationStatus, useOptionalApp,
} from '../context/AppContext';
import { deriveCollaborationStatusUx } from '../../services/collaboration/CollaborationStatusUxModel';
import { AUTHORING_SCHEMA_VERSION, type AuthoringScope } from '../../api/types/authoring';
import { buildTemplateAuthoringPreview } from '../../services/template-package';
import { computeTimelineEndSeconds } from '../../services/sequential-flow/SequentialFlowAuthoring';
import { showToast } from '../Toast';
import { useSettings } from '../SettingsStore';
import { createSemanticTimelineCorrelationId } from './semanticTimelineEditing';
import { buildSemanticStatementLibraryInsert } from './semanticStatementInsertion';
import { useSemanticTimelineCommands } from './useSemanticTimelineCommands';
import type { SemanticTimelineSnapshot } from './useSemanticTimelineSnapshot';
import type { QuickParamPatch } from './StatementQuickControls';
import type { TimelineAction } from './semanticTimelineTypes';
import type { TimelineListViewProps } from './TimelineListView';
import type { TimelineListGapMenuState } from './TimelineListGapMenu';

function createTimelineListCorrelationId(): string {
  return `timeline_list_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** List-specific commands reuse the shared semantic command and selection contract. */
export function useTimelineListEditing(
  props: Pick<TimelineListViewProps, 'sceneData' | 'handleSelect' | 'setSelectedIds' | 'setCurrentTime' | 'availableTemplates'>,
  snapshot: SemanticTimelineSnapshot,
  gapMenu: TimelineListGapMenuState,
) {
  const { sceneData, handleSelect, setSelectedIds, setCurrentTime, availableTemplates } = props;
  const { activeGapMenu, setActiveGapMenu, gapInsertPendingRef, timelineListGapByIndex } = gapMenu;
  const playbackAdapter = usePlaybackAdapter();
  const documentStore = useDocumentStore();
  const { document: sceneDocument, items: semanticTimelineItems, actions: semanticTimelineActions, itemById: semanticTimelineItemByDisplayId } = snapshot;
  const semanticAuthoring = useSemanticAuthoringService();
  const selectAfterCommit = useCallback((ids: Record<string, boolean>) => {
    const selected = Object.keys(ids);
    if (selected.length) handleSelect(selected, false);
    else setSelectedIds({});
  }, [handleSelect, setSelectedIds]);
  const commands = useSemanticTimelineCommands(selectAfterCommit);
  const collaborationUndoDisabled = useIsCollaborationUndoDisabled();
  const { settings } = useSettings();
  const dialogueFlowEnabled = settings.workbenchDialogueFlowMode === 'auto';
  const timelineReadModelActions = semanticTimelineActions;
  const [draggingActionId, setDraggingActionId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ index: number; placement: 'before' | 'after' } | null>(null);
  const [dragOverGapIndex, setDragOverGapIndex] = useState<number | null>(null);
  const app = useOptionalApp();

  useEffect(() => {
    const handleWindowDragEnd = () => {
      setDraggingActionId(null);
      setDropTarget(null);
      setDragOverGapIndex(null);
    };
    window.addEventListener('dragend', handleWindowDragEnd);
    return () => {
      window.removeEventListener('dragend', handleWindowDragEnd);
    };
  }, []);
  const collaborationStatus = useCollaborationStatus();
  const isOfflineEditingBlocked = collaborationStatus === 'offline' || collaborationStatus === 'reconnecting';
  const offlineEditMessage = deriveCollaborationStatusUx({ status: collaborationStatus }).offlineEditMessage
    ?? '共享编辑已暂停；请重新加入后才能编辑。';
  const blockOfflineAuthoring = useCallback(() => {
    if (!isOfflineEditingBlocked) return false;
    showToast(offlineEditMessage, 'warning');
    return true;
  }, [isOfflineEditingBlocked, offlineEditMessage]);
  // ── Actions ────────────────────────────────────────────
  const handleDeleteItem = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await commands.delete([id]);
  }, [commands]);

  const handleSelectActionFromLibrary = useCallback(async (type: 'statement' | 'template', data: any) => {
    if (blockOfflineAuthoring()) return;
    if (!semanticAuthoring || !activeGapMenu || gapInsertPendingRef.current) return;
    const { gap } = activeGapMenu;
    const nextRootStatement = semanticTimelineItems
      .slice(gap.index + 1)
      .find((item) => item.locator.kind === 'statement');
    const beforeStatementId = nextRootStatement?.statementId;
    const prevSpeakerId = gap.previous.source.type === 'dialogue' && typeof gap.previous.displayAction.params?.speaker === 'string'
      ? gap.previous.displayAction.params.speaker
      : undefined;
    const targetCharId = prevSpeakerId || sceneData.meta?.characters?.[0]?.id;
    const scope: AuthoringScope = targetCharId
      ? prevSpeakerId
        ? {
            kind: 'inferred-character' as const,
            charId: targetCharId,
            source: 'blank-menu-track' as const,
          }
        : {
            kind: 'character' as const,
            charId: targetCharId,
          }
      : { kind: 'none' as const };

    gapInsertPendingRef.current = true;
    try {
      if (type === 'statement' && data.blockId) {
        const document = documentStore.getCurrentSceneDocumentSnapshot();
        const result = buildSemanticStatementLibraryInsert({
          blockId: data.blockId,
          document,
          sceneMeta: sceneData.meta,
          anchorTime: gap.time,
          origin: 'timeline-list-gap',
          scope,
          correlationPrefix: 'timeline_list_gap_insert',
          lifecycleEndCorrelationPrefix: 'timeline_list_gap_lifecycle_end',
          lifecycleTargetBindingCorrelationPrefix: 'timeline_list_gap_lifecycle_target_binding',
          beforeStatementId,
        });
        if (result.kind === 'warning') {
          showToast(result.message, 'warning');
          setActiveGapMenu(null);
          return;
        }
        if (result.kind === 'unavailable') {
          if (result.message) showToast(result.message, 'warning');
          return;
        }
        if (blockOfflineAuthoring()) return;

        const receipt = await commands.insert(result.intent);
        if (!receipt) return;
        showToast(`已插入 ${receipt.createdStatementIds.length} 个语句`, 'success');
        setActiveGapMenu(null);
      } else if (type === 'template' && data.templateId) {
        const combo = availableTemplates?.find((candidate) => candidate.id === data.templateId);
        if (!combo) {
          setActiveGapMenu(null);
          return;
        }
        const preview = buildTemplateAuthoringPreview(combo, {
          anchorTime: gap.time,
          correlationId: createSemanticTimelineCorrelationId('timeline_list_gap_template'),
          origin: 'timeline-list-gap',
          scope,
        });
        if (!preview) {
          setActiveGapMenu(null);
          return;
        }
        const receipt = await commands.insert(preview.intent);
        if (!receipt) return;
        showToast(`已应用模板: ${combo.name}`, 'success');
        setActiveGapMenu(null);
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '无法插入语句', 'warning');
      setActiveGapMenu(null);
    } finally {
      gapInsertPendingRef.current = false;
    }
  }, [activeGapMenu, blockOfflineAuthoring, commands, documentStore, availableTemplates, sceneData.meta, semanticAuthoring, semanticTimelineItems]);

  const handlePasteAtGap = useCallback(async (time: number) => {
    const editorStore = app?.stores?.editor;
    if (!editorStore || editorStore.copyBuffer.length === 0 || !semanticAuthoring) return;
    if (blockOfflineAuthoring()) return;
    const receipt = await commands.paste(editorStore.copyBuffer, time, 'timeline-list-gap');
    if (receipt) showToast(`已粘贴 ${receipt.createdStatementIds.length} 个语句`, 'success');
    setActiveGapMenu(null);
  }, [app, blockOfflineAuthoring, commands, semanticAuthoring]);

  const dropRootStatementAt = useCallback(async (movedStatementId: string, insertionIndex: number) => {
    if (!semanticAuthoring || !sceneDocument || blockOfflineAuthoring()) return;
    const moved = sceneDocument.statements.find((statement) => statement.id === movedStatementId);
    if (!moved) return;
    if (moved.type === 'dialogue') {
      const rootItems = semanticTimelineItems.filter((item) => item.locator.kind === 'statement');
      const nextRoot = semanticTimelineItems
        .slice(insertionIndex)
        .find((item) => item.locator.kind === 'statement' && item.statementId !== movedStatementId);
      const remaining = rootItems.filter((item) => item.statementId !== movedStatementId);
      const targetIndex = nextRoot ? remaining.findIndex((item) => item.statementId === nextRoot.statementId) : remaining.length;
      const reordered = [...remaining];
      const movedItem = rootItems.find((item) => item.statementId === movedStatementId);
      if (!movedItem) return;
      reordered.splice(targetIndex, 0, movedItem);

      if (reordered.every((item, index) => item.statementId === rootItems[index].statementId)) {
        setDraggingActionId(null);
        setDropTarget(null);
        setDragOverGapIndex(null);
        return;
      }

      try {
        await semanticAuthoring.author({
          version: AUTHORING_SCHEMA_VERSION,
          kind: 'reorder-dialogue-chain',
          origin: 'sequential-flow',
          correlationId: createSemanticTimelineCorrelationId('timeline_list_dialogue_reorder'),
          orderedDialogueIds: reordered.filter((item) => item.source.type === 'dialogue').map((item) => item.statementId),
          movedStatementId,
          beforeStatementId: nextRoot?.statementId ?? null,
          flow: dialogueFlowEnabled,
        });
      } catch (error) {
        showToast(error instanceof Error ? error.message : '无法调整对白顺序', 'warning');
      } finally {
        setDraggingActionId(null);
        setDropTarget(null);
        setDragOverGapIndex(null);
      }
      return;
    }

    const firstItem = semanticTimelineItems[0];
    const previousGap = timelineListGapByIndex.get(insertionIndex - 1);
    const targetTime = insertionIndex <= 0
      ? Math.max(0, (firstItem?.time ?? 0) - 0.1)
      : insertionIndex >= semanticTimelineItems.length
        ? computeTimelineEndSeconds(sceneDocument)
        : previousGap?.time ?? semanticTimelineItems[insertionIndex]?.time ?? moved.time;
    try {
      await semanticAuthoring.author({
        version: AUTHORING_SCHEMA_VERSION,
        kind: 'move-timeline-locators',
        origin: 'timeline-editor',
        correlationId: createSemanticTimelineCorrelationId('timeline_list_statement_reorder'),
        moves: [{ locator: { kind: 'statement', statementId: movedStatementId }, time: targetTime }],
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '无法调整语句顺序', 'warning');
    } finally {
      setDraggingActionId(null);
      setDropTarget(null);
      setDragOverGapIndex(null);
    }
  }, [blockOfflineAuthoring, dialogueFlowEnabled, sceneDocument, semanticAuthoring, semanticTimelineItems, timelineListGapByIndex]);

  const handleSelectLeft = useCallback(() => {
    const currentTime = playbackAdapter.getCurrentTime();
    const selected: Record<string, boolean> = {};
    timelineReadModelActions
      .filter((action) => (action.time || 0) < currentTime)
      .forEach((action) => {
        if (action._id) selected[action._id] = true;
      });
    setSelectedIds(selected);
  }, [playbackAdapter, setSelectedIds, timelineReadModelActions]);

  const handleSelectRight = useCallback(() => {
    const currentTime = playbackAdapter.getCurrentTime();
    const selected: Record<string, boolean> = {};
    timelineReadModelActions
      .filter((action) => (action.time || 0) >= currentTime)
      .forEach((action) => {
        if (action._id) selected[action._id] = true;
      });
    setSelectedIds(selected);
  }, [playbackAdapter, setSelectedIds, timelineReadModelActions]);

  const handleTimeEdit = useCallback((value: number, id: string) => {
    if (blockOfflineAuthoring() || !Number.isFinite(value) || !semanticAuthoring) return;
    const item = semanticTimelineItemByDisplayId.get(id);
    if (!item || item.locator.kind !== 'statement') return;
    void semanticAuthoring.author({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: createTimelineListCorrelationId(),
      origin: 'timeline-editor',
      kind: 'update-statement',
      statementId: item.statementId,
      patch: { time: Math.max(0, value) },
      flow: item.source.type === 'dialogue' && dialogueFlowEnabled,
    });
  }, [blockOfflineAuthoring, dialogueFlowEnabled, semanticAuthoring, semanticTimelineItemByDisplayId]);

  const handleUndo = useCallback(() => {
    if (collaborationUndoDisabled) {
      showToast('协作模式暂不支持撤销', 'info');
      return;
    }
    void semanticAuthoring?.undo();
  }, [collaborationUndoDisabled, semanticAuthoring]);

  const handleRedo = useCallback(() => {
    if (collaborationUndoDisabled) {
      showToast('协作模式暂不支持重做', 'info');
      return;
    }
    void semanticAuthoring?.redo();
  }, [collaborationUndoDisabled, semanticAuthoring]);

  const commitInlineParams = useCallback((action: TimelineAction, patch: QuickParamPatch, replace = false) => {
    const item = action._id ? semanticTimelineItemByDisplayId.get(action._id) : undefined;
    if (!item) return;
    if (replace && typeof patch !== 'function') {
      void commands.replaceSourceParams(item.locator, patch, item.source.params as Record<string, unknown>);
    } else {
      void commands.updateSourceParams(item.locator, patch, replace);
    }
  }, [commands, semanticTimelineItemByDisplayId]);

  const copyActions = useCallback((ids: readonly string[]) => {
    app?.stores?.editor?.setCopyBuffer(commands.copy(ids));
  }, [app, commands]);
  const playAction = useCallback((time: number) => {
    setCurrentTime(time);
    playbackAdapter.seek(time);
    playbackAdapter.play();
  }, [setCurrentTime, playbackAdapter]);
  return {
    draggingActionId, setDraggingActionId, dropTarget, setDropTarget,
    dragOverGapIndex, setDragOverGapIndex, isOfflineEditingBlocked, blockOfflineAuthoring,
    collaborationUndoDisabled, handleDeleteItem, handleSelectActionFromLibrary, handlePasteAtGap,
    dropRootStatementAt, handleSelectLeft, handleSelectRight, handleTimeEdit, handleUndo, handleRedo,
    commitInlineParams, copyActions, deleteActions: commands.delete, playAction,
    hasCopyBuffer: (app?.stores?.editor?.copyBuffer?.length ?? 0) > 0,
  };
}

export type TimelineListEditing = ReturnType<typeof useTimelineListEditing>;
