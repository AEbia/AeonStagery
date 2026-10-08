import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import {
  usePlaybackAdapter,
  useDocumentStore,
  useSemanticAuthoringService,
  useIsCollaborationUndoDisabled,
  useCollaborationStatus,
  useCollaborationPresence,
  useOptionalApp,
} from '../context/AppContext';
import {
  IconPlus, IconTrash, IconPlay, IconUndo, IconRedo, IconSearch,
  IconX, IconSelectLeft, IconSelectRight, IconUsers, IconGripVertical,
  IconChevronDown, IconCopy,
} from '../icons';
import { InlineNumericInput } from './FormComponents';
import { ActionInspector } from './ActionInspector';
import { StatementQuickControls, type QuickParamPatch } from './StatementQuickControls';
import { MeasuredTimelineRow, useVirtualTimelineRows } from './useVirtualTimelineRows';
import { ActionIcons } from './TimelineConstants';
import { showToast } from '../Toast';
import { deriveCollaborationStatusUx } from '../../services/collaboration/CollaborationStatusUxModel';
import {
  AUTHORING_SCHEMA_VERSION,
  type AuthoringScope,
} from '../../api/types/authoring';
import type { WorkspaceToolTab } from '../workspace-tools/types';
import { InspectorViewPicker } from './InspectorViewPicker';
import {
  buildTemplateAuthoringPreview,
  type SourcedSemanticAuthoringCombo,
} from '../../services/template-package';
import { BACKGROUND_LAYER_ID } from '../../engine/environmentLayerModel';
import {
  collectEnvironmentLayerPresentations,
  getEnvironmentActionLayerId,
} from './environmentPresentation';

import {
  getPeersEditingLocator,
  summarizeLocatorEditingPeers,
} from '../../services/collaboration/CollaborationPresence';
import {
  buildSemanticPasteTimelineIntent,
  buildSemanticCopyBufferForTimelineActions,
  buildSemanticDeleteTimelineIntents,
  createSemanticTimelineCorrelationId,
  selectCompiledActionsForStatements,
} from './semanticTimelineEditing';
import {
  buildSemanticStatementLibraryInsert,
  submitSemanticStatementLibraryInsert,
} from './semanticStatementInsertion';
import { StatementLibraryMenu } from './StatementLibraryMenu';
import { listAvailableLifecycleEndCommandIds } from './insertLifecycleEndCommand';
import { listAvailableLifecycleTargetBindingCommandIds } from './lifecycleTargetBinding';
import {
  buildSemanticTimelineReadModel,
  type SemanticTimelineReadModelItem,
} from './semanticTimelineReadModel';
import {
  buildTimelineListGaps,
  type TimelineListGap,
} from './timelineListGaps';
import {
  computeTimelineEndSeconds,
} from '../../services/sequential-flow/SequentialFlowAuthoring';
import { useSettings } from '../SettingsStore';
import { useSemanticDocument } from '../store/storeHooks';
import type { TimelineAction, TimelineScene } from './semanticTimelineTypes';

function getTimelineItemClassForSemanticCategory(category: TimelineAction['semanticCategory']): string {
  switch (category) {
    case 'dialogue':
      return 'timeline-item--dialogue';
    case 'character':
      return 'timeline-item--character';
    case 'camera':
      return 'timeline-item--camera';
    case 'audio':
      return 'timeline-item--audio';
    default:
      return 'timeline-item--environment';
  }
}

function createTimelineListCorrelationId(): string {
  return `timeline_list_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isRootDialogueItem(item: SemanticTimelineReadModelItem | undefined): boolean {
  return item?.locator.kind === 'statement' && item.source.type === 'dialogue';
}

function isRootStatementItem(item: SemanticTimelineReadModelItem | undefined): boolean {
  return item?.locator.kind === 'statement';
}

function motionKeyLabel(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const candidate = value as { kind?: unknown; key?: unknown };
    if (candidate.kind === 'resource' && typeof candidate.key === 'string') return candidate.key;
    if (candidate.kind === 'custom') return '自定义动作';
  }
  return '';
}

export interface TimelineListViewProps {
  sceneData: TimelineScene;
  inlineExpandable?: boolean;
  selectedActionIds: Record<string, boolean>;
  setSelectedIds: (ids: Record<string, boolean>) => void;
  addAction: () => void;
  handleSelect: (idOrIds: string | string[], multi?: boolean) => void;
  setCurrentTime: (t: number) => void;
  loadExample: () => Promise<boolean>;
  workspaceErrorCount?: number;
  workspaceWarningCount?: number;
  availableTemplates?: SourcedSemanticAuthoringCombo[];
  onSelectWorkspaceView?: (tab: WorkspaceToolTab) => void;
  updateAction?: (id: string, updates: any, isTransient?: boolean) => void;
  updateParam?: (id: string, key: string, val: any, isTransient?: boolean) => void;
  replaceSourceParams?: (id: string, params: Record<string, unknown>) => void | Promise<unknown>;
  deleteAction?: (id: string) => void;
  deleteActions?: (ids: readonly string[]) => void | Promise<void>;
  copyActions?: (ids: readonly string[]) => void;
}

export const TimelineListView: React.FC<TimelineListViewProps> = (props) => {
  const {
    sceneData,
    selectedActionIds, setSelectedIds,
    addAction,
    handleSelect, setCurrentTime,
    loadExample,
    workspaceErrorCount = 0,
    workspaceWarningCount = 0,
    onSelectWorkspaceView,
  } = props;

  const playbackAdapter = usePlaybackAdapter();
  const documentStore = useDocumentStore();
  const { document: sceneDocument } = useSemanticDocument();
  const semanticAuthoring = useSemanticAuthoringService();
  const collaborationUndoDisabled = useIsCollaborationUndoDisabled();
  const { peers: collaborationPeers } = useCollaborationPresence();
  const { settings, setSetting } = useSettings();
  const dialogueFlowEnabled = settings.workbenchDialogueFlowMode === 'auto';
  const isTracksMode = settings.workbenchTimelineLayoutMode === 'tracks';
  const allowInlineExpand = props.inlineExpandable ?? (!isTracksMode);

  const [searchQuery, setSearchQuery] = useState('');
  const [expandedActionIds, setExpandedActionIds] = useState<Record<string, boolean>>({});
  const [draggingActionId, setDraggingActionId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ index: number; placement: 'before' | 'after' } | null>(null);
  const [dragOverGapIndex, setDragOverGapIndex] = useState<number | null>(null);
  const gapInsertPendingRef = useRef(false);
  const app = useOptionalApp();

  const toggleExpand = useCallback((id: string) => {
    setExpandedActionIds((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

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
  const copyBuffer = app?.stores?.editor?.copyBuffer ?? [];
  const [activeGapMenu, setActiveGapMenu] = useState<{
    gap: TimelineListGap;
    x: number;
    y: number;
  } | null>(null);
  const collaborationStatus = useCollaborationStatus();
  const isOfflineEditingBlocked = collaborationStatus === 'offline' || collaborationStatus === 'reconnecting';
  const offlineEditMessage = deriveCollaborationStatusUx({ status: collaborationStatus }).offlineEditMessage
    ?? '共享编辑已暂停；请重新加入后才能编辑。';
  const blockOfflineAuthoring = useCallback(() => {
    if (!isOfflineEditingBlocked) return false;
    showToast(offlineEditMessage, 'warning');
    return true;
  }, [isOfflineEditingBlocked, offlineEditMessage]);
  const listContainerRef = useRef<HTMLDivElement>(null);

  const selectedIdsList = useMemo(() => Object.keys(selectedActionIds), [selectedActionIds]);
  const selectedSingleId = selectedIdsList.length === 1 ? selectedIdsList[0] : undefined;
  useEffect(() => {
    if (allowInlineExpand && selectedSingleId) setExpandedActionIds((prev) => (
      prev[selectedSingleId] ? prev : { ...prev, [selectedSingleId]: true }
    ));
  }, [allowInlineExpand, selectedSingleId]);
  const characterCount = sceneData.meta.characters?.length ?? 0;
  const charactersById = useMemo(
    () => new Map((sceneData.meta.characters || []).map((character) => [character.id, character])),
    [sceneData.meta.characters],
  );

  const availableLifecycleEndCommandIds = useMemo(() => {
    const document = documentStore.getCurrentSceneDocumentSnapshot();
    if (!activeGapMenu || !document) return new Set<string>();
    return listAvailableLifecycleEndCommandIds(
      document,
      activeGapMenu.gap.time,
      { sceneMeta: sceneData.meta, charId: null },
    );
  }, [activeGapMenu, documentStore, sceneData.meta]);

  const availableLifecycleTargetBindingCommandIds = useMemo(() => {
    const document = documentStore.getCurrentSceneDocumentSnapshot();
    if (!activeGapMenu || !document) return new Set<string>();
    return listAvailableLifecycleTargetBindingCommandIds(
      document,
      activeGapMenu.gap.time,
      { sceneMeta: sceneData.meta, charId: null },
    );
  }, [activeGapMenu, documentStore, sceneData.meta]);

  const gapContextMeta = useMemo(() => {
    if (!activeGapMenu) return undefined;
    const prev = activeGapMenu.gap.previous;
    const speakerId = prev.source.type === 'dialogue' && typeof prev.displayAction.params?.speaker === 'string'
      ? prev.displayAction.params.speaker
      : undefined;
    if (speakerId) {
      const speaker = charactersById.get(speakerId);
      return speaker?.name || speakerId;
    }
    return undefined;
  }, [activeGapMenu, charactersById]);
  const environmentLayers = useMemo(
    () => collectEnvironmentLayerPresentations(sceneData),
    [sceneData],
  );
  const semanticTimelineItems = useMemo(
    () => buildSemanticTimelineReadModel(
      sceneDocument,
      documentStore.getCompiledSceneSnapshot(),
    ),
    [documentStore, sceneDocument],
  );
  const semanticTimelineActions = useMemo(
    () => semanticTimelineItems.map((item) => item.displayAction),
    [semanticTimelineItems],
  );
  const semanticTimelineItemByDisplayId = useMemo(
    () => new Map(semanticTimelineItems.map((item) => [item.id, item])),
    [semanticTimelineItems],
  );
  const timelineReadModelActions = semanticTimelineActions;
  const timelineItemCount = semanticTimelineItems.length;
  const timelineListGaps = useMemo(
    () => buildTimelineListGaps(semanticTimelineItems),
    [semanticTimelineItems],
  );
  const timelineListGapByIndex = useMemo(
    () => new Map<number, TimelineListGap>(timelineListGaps.map((gap) => [gap.index, gap])),
    [timelineListGaps],
  );
  // ── Filter actions by search ────────────────────────────
  const filteredActions = useMemo(() => {
    const actions = timelineReadModelActions;

    if (!searchQuery.trim()) return actions;

    const q = searchQuery.toLowerCase();
    return actions.filter(a => {
      if (a.action.toLowerCase().includes(q)) return true;
      if (a.params.text && String(a.params.text).toLowerCase().includes(q)) return true;
      if (a.params.speaker && String(a.params.speaker).toLowerCase().includes(q)) return true;
      if (a.params.motion && String(motionKeyLabel(a.params.motion)).toLowerCase().includes(q)) return true;
      // ADR-0022: $speaker performance placeholders carry no runtime id —
      // match the read-model-resolved speaker and the source target too, so
      // searching the auto-bound character name finds the 动作待定 block.
      // The literal $speaker token must not shadow the resolved speaker.
      const rawTarget = a.params.target;
      const charId = a.params.id || a.params.speakerId
        || (rawTarget && rawTarget !== '$speaker' ? rawTarget : undefined)
        || a.resolvedSpeakerId;
      if (charId) {
        const char = charactersById.get(String(charId));
        if (char && char.name.toLowerCase().includes(q)) return true;
      }
      const environmentLayerId = getEnvironmentActionLayerId(a);
      if (environmentLayerId) {
        const presentation = environmentLayers.get(environmentLayerId);
        if (presentation?.displayLabel.toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [charactersById, environmentLayers, searchQuery, timelineReadModelActions]);

  const virtualRowSizes = useMemo(() => filteredActions.map((action, index) => {
    const id = action._id ?? `timeline-item:${index}`;
    const expanded = allowInlineExpand && !!expandedActionIds[id];
    return {
      id,
      measurementKey: `${id}:${allowInlineExpand}:${expanded}`,
      estimatedHeight: expanded ? 700 : allowInlineExpand ? 160 : 52,
    };
  }), [filteredActions, allowInlineExpand, expandedActionIds]);
  const virtualRows = useVirtualTimelineRows(listContainerRef, virtualRowSizes);

  // ── Actions ────────────────────────────────────────────
  const handleDeleteItem = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!semanticAuthoring || blockOfflineAuthoring()) return;
    const item = semanticTimelineItemByDisplayId.get(id);
    if (!item) return;
    try {
      if (item.locator.kind === 'companion') {
        await semanticAuthoring.author({
          version: AUTHORING_SCHEMA_VERSION,
          correlationId: createTimelineListCorrelationId(),
          origin: 'timeline-editor',
          kind: 'delete-dialogue-companions',
          locators: [item.locator],
        });
      } else {
        await semanticAuthoring.author({
          version: AUTHORING_SCHEMA_VERSION,
          correlationId: createTimelineListCorrelationId(),
          origin: 'timeline-editor',
          kind: 'delete-statements',
          statementIds: [item.statementId],
          flow: item.source.type === 'dialogue' && dialogueFlowEnabled,
        });
      }
      setSelectedIds({});
    } catch (error) {
      showToast(error instanceof Error ? error.message : '无法删除语句', 'warning');
    }
  }, [blockOfflineAuthoring, dialogueFlowEnabled, semanticAuthoring, semanticTimelineItemByDisplayId, setSelectedIds]);

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

        let selectedCalled = false;
        const receipt = await submitSemanticStatementLibraryInsert({
          semanticAuthoring,
          documentStore,
          intent: result.intent,
          onSelect: (ids) => {
            selectedCalled = true;
            handleSelect(ids, false);
          },
        });
        showToast(`已插入 ${receipt.createdStatementIds.length} 个语句`, 'success');
        if (!selectedCalled && receipt.createdStatementIds.length > 0) {
          handleSelect(receipt.createdStatementIds, false);
        }
        setActiveGapMenu(null);
      } else if (type === 'template' && data.templateId) {
        const combo = props.availableTemplates?.find((candidate) => candidate.id === data.templateId);
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
        const receipt = await semanticAuthoring.author(preview.intent);
        showToast(`已应用模板: ${combo.name}`, 'success');
        const selected = selectCompiledActionsForStatements(
          documentStore.getCompiledSceneSnapshot(),
          receipt.createdStatementIds,
        );
        const selectedIds = Object.keys(selected);
        if (selectedIds.length > 0) {
          handleSelect(selectedIds, false);
        } else if (receipt.createdStatementIds.length > 0) {
          handleSelect(receipt.createdStatementIds, false);
        }
        setActiveGapMenu(null);
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '无法插入语句', 'warning');
      setActiveGapMenu(null);
    } finally {
      gapInsertPendingRef.current = false;
    }
  }, [activeGapMenu, blockOfflineAuthoring, documentStore, handleSelect, props.availableTemplates, sceneData.meta, semanticAuthoring, semanticTimelineItems]);

  const handlePasteAtGap = useCallback(async (time: number) => {
    const editorStore = app?.stores?.editor;
    if (!editorStore || editorStore.copyBuffer.length === 0 || !semanticAuthoring) return;
    if (blockOfflineAuthoring()) return;
    const intent = buildSemanticPasteTimelineIntent(
      editorStore.copyBuffer,
      time,
      createSemanticTimelineCorrelationId('timeline_list_gap_paste'),
      'timeline-list-gap',
    );
    if (intent) {
      try {
        const receipt = await semanticAuthoring.author(intent);
        showToast(`已粘贴 ${receipt.createdStatementIds.length} 个语句`, 'success');
        const nextSelected = selectCompiledActionsForStatements(
          documentStore.getCompiledSceneSnapshot(),
          receipt.createdStatementIds,
        );
        const selectedIds = Object.keys(nextSelected);
        if (selectedIds.length > 0) {
          handleSelect(selectedIds, false);
        } else if (receipt.createdStatementIds.length > 0) {
          handleSelect(receipt.createdStatementIds, false);
        }
      } catch (error) {
        showToast(error instanceof Error ? error.message : '无法粘贴语句', 'warning');
      }
    }
    setActiveGapMenu(null);
  }, [app, blockOfflineAuthoring, documentStore, handleSelect, semanticAuthoring]);

  const dropRootStatementAt = useCallback(async (movedStatementId: string, insertionIndex: number) => {
    if (!semanticAuthoring || !sceneDocument || blockOfflineAuthoring()) return;
    const moved = sceneDocument.statements.find((statement) => statement.id === movedStatementId);
    if (!moved) return;
    if (moved.type === 'dialogue') {
      const orderedDialogueIds = sceneDocument.statements
        .filter((statement) => statement.type === 'dialogue')
        .map((statement) => statement.id);
      const fromIndex = orderedDialogueIds.indexOf(movedStatementId);
      if (fromIndex < 0) return;

      const afterDialogue = semanticTimelineItems
        .slice(insertionIndex)
        .find((item) => isRootDialogueItem(item) && item.statementId !== movedStatementId);
      const beforeDialogue = semanticTimelineItems
        .slice(0, insertionIndex)
        .reverse()
        .find((item) => isRootDialogueItem(item) && item.statementId !== movedStatementId);

      const remaining = orderedDialogueIds.filter((id) => id !== movedStatementId);
      let targetIndex = remaining.length;

      if (afterDialogue) {
        const idx = remaining.indexOf(afterDialogue.statementId);
        if (idx >= 0) targetIndex = idx;
      } else if (beforeDialogue) {
        const prevIdx = remaining.indexOf(beforeDialogue.statementId);
        if (prevIdx >= 0) targetIndex = prevIdx + 1;
      }

      const reordered = [...remaining];
      reordered.splice(targetIndex, 0, movedStatementId);

      if (reordered.every((id, index) => id === orderedDialogueIds[index])) {
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
          orderedDialogueIds: reordered,
          movedStatementId,
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

  const handleExpandAll = useCallback(() => {
    const next: Record<string, boolean> = {};
    filteredActions.forEach((action) => {
      if (action._id) next[action._id] = true;
    });
    setExpandedActionIds(next);
  }, [filteredActions]);

  const handleCollapseAll = useCallback(() => {
    setExpandedActionIds({});
  }, []);

  const commitInlineParams = useCallback((action: TimelineAction, patch: QuickParamPatch, replace = false) => {
    if (blockOfflineAuthoring() || !semanticAuthoring || !action._id) return;
    const item = semanticTimelineItemByDisplayId.get(action._id);
    if (!item) return;
    // Build against the latest document inside the serial authoring queue.
    // A quick edit and the full inspector share the same canonical source seam.
    void semanticAuthoring.authorTransaction((document) => {
      const statement = document.statements.find((candidate) => candidate.id === item.statementId);
      const source = item.locator.kind === 'companion'
        ? statement?.companions?.find((candidate) => candidate.id === item.companionId)
        : statement;
      if (!source) throw new Error('语句已不存在');
      const changes = typeof patch === 'function' ? patch(source.params as Record<string, unknown>) : patch;
      const params: Record<string, unknown> = replace ? { ...changes } : { ...source.params, ...changes };
      for (const key of Object.keys(params)) {
        if (params[key] === undefined) delete params[key];
      }
      const base = { version: AUTHORING_SCHEMA_VERSION, correlationId: createTimelineListCorrelationId(), origin: 'timeline-editor' as const };
      return [item.locator.kind === 'companion'
        ? { ...base, kind: 'update-dialogue-companion', locator: item.locator, patch: { params } as any }
        : { ...base, kind: 'update-statement', statementId: item.statementId, patch: { params } as any, flow: dialogueFlowEnabled }];
    }).catch((error) => showToast(error instanceof Error ? error.message : '无法修改语句属性', 'warning'));
  }, [blockOfflineAuthoring, dialogueFlowEnabled, semanticAuthoring, semanticTimelineItemByDisplayId]);

  return (
    <div className={`timeline-list-view${allowInlineExpand ? '' : ' timeline-list-view--outline'}`} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Toolbar */}
      <div className="timeline-toolbar">
        <InspectorViewPicker
          activeView="actions"
          actionCount={timelineItemCount}
          characterCount={characterCount}
          errorCount={workspaceErrorCount}
          warningCount={workspaceWarningCount}
          onSelect={(view) => {
            if (view !== 'actions') onSelectWorkspaceView?.(view);
          }}
        />
        <div className="timeline-segmented-control" role="group" aria-label="对白自动重排模式">
          <button
            type="button"
            aria-pressed={dialogueFlowEnabled}
            data-active={dialogueFlowEnabled}
            onClick={() => setSetting('workbenchDialogueFlowMode', 'auto')}
          >
            全自动
          </button>
          <button
            type="button"
            aria-pressed={!dialogueFlowEnabled}
            data-active={!dialogueFlowEnabled}
            onClick={() => setSetting('workbenchDialogueFlowMode', 'manual')}
          >
            不自动重排
          </button>
        </div>
        {allowInlineExpand && (
          <div className="timeline-expand-controls" role="group" aria-label="展开控制">
            <button
              type="button"
              className="btn btn--sm"
              onClick={handleExpandAll}
              title="全部展开"
              aria-label="全部展开"
            >
              全部展开
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={handleCollapseAll}
              title="全部折叠"
              aria-label="全部折叠"
            >
              全部折叠
            </button>
          </div>
        )}
        {selectedIdsList.length > 1 && (
          <div className="timeline-toolbar__selection" role="group" aria-label="批量操作">
            <button type="button" className="btn btn--icon" aria-label="复制到剪贴板" title="复制选中语句"
              onClick={() => {
                if (props.copyActions) props.copyActions(selectedIdsList);
                else app?.stores.editor.setCopyBuffer(buildSemanticCopyBufferForTimelineActions(documentStore, selectedIdsList));
              }}><IconCopy width={14} height={14} /></button>
            <button type="button" className="btn btn--icon" aria-label="批量删除" title="删除选中语句" disabled={isOfflineEditingBlocked}
              onClick={async () => {
                if (blockOfflineAuthoring()) return;
                if (props.deleteActions) await props.deleteActions(selectedIdsList);
                else if (semanticAuthoring) {
                  const intents = buildSemanticDeleteTimelineIntents(documentStore, selectedIdsList);
                  if (intents.length) await semanticAuthoring.authorTransaction(intents);
                }
                setSelectedIds({});
              }}><IconTrash width={14} height={14} /></button>
          </div>
        )}
        <div className="timeline-toolbar__spacer" />
        <button
          type="button"
          className="btn btn--icon"
          onClick={handleUndo}
          disabled={collaborationUndoDisabled}
          title={collaborationUndoDisabled ? '协作模式暂不支持撤销' : '撤销 (Ctrl+Z)'}
          aria-label={collaborationUndoDisabled ? '协作模式暂不支持撤销' : '撤销'}
        >
          <IconUndo width={16} height={16} />
        </button>
        <button
          type="button"
          className="btn btn--icon"
          onClick={handleRedo}
          disabled={collaborationUndoDisabled}
          title={collaborationUndoDisabled ? '协作模式暂不支持重做' : '重做 (Ctrl+Shift+Z)'}
          aria-label={collaborationUndoDisabled ? '协作模式暂不支持重做' : '重做'}
        >
          <IconRedo width={16} height={16} />
        </button>
        <div style={{ width: 1, height: 20, background: 'var(--border-subtle)', margin: '0 4px' }} />
        <button type="button" className="btn btn--icon" onClick={handleSelectLeft} title="选中播放位置左侧所有动作" aria-label="选中播放位置左侧所有动作">
          <IconSelectLeft width={15} height={15} />
        </button>
        <button type="button" className="btn btn--icon" onClick={handleSelectRight} title="选中播放位置右侧所有动作" aria-label="选中播放位置右侧所有动作">
          <IconSelectRight width={15} height={15} />
        </button>
      </div>

      {/* Search */}
      <div className="timeline-list-search-container" style={{ padding: allowInlineExpand ? '0 12px 4px 12px' : '0 6px 4px' }}>
        <div className="timeline-search">
          <IconSearch width={14} height={14} className="timeline-search__icon" />
          <input
            type="text"
            aria-label="搜索时间轴动作、台词或角色"
            placeholder="搜索动作、台词、角色..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              aria-label="清除搜索"
              title="清除搜索"
              style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2, display: 'flex' }}
            >
              <IconX width={12} height={12} />
            </button>
          )}
        </div>
      </div>

      {/* Empty state */}
      {!timelineItemCount && (
        <div style={{ padding: '0 12px 8px 12px' }}>
          <div className="card" style={{ padding: 24, textAlign: 'center', border: '1px dashed var(--border-default)', background: 'var(--bg-elevated)' }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4, color: 'var(--text-primary)' }}>剧本时间轴为空</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>添加动作或加载示例剧本开始创作</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button className="btn btn--primary" onClick={addAction}><IconPlus width={14} height={14} /> 添加动作</button>
              <button className="btn" onClick={loadExample}><IconPlay width={14} height={14} /> 加载示例</button>
            </div>
          </div>
        </div>
      )}

      {searchQuery && filteredActions.length === 0 && timelineItemCount > 0 && (
        <div className="empty-state" style={{ flex: 0, padding: 24 }}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>未找到匹配 "{searchQuery}" 的动作</div>
        </div>
      )}

      {/* Timeline List */}
      {filteredActions.length > 0 && (
        <>
          <div className="timeline-list-header">
            <span>{searchQuery ? `搜索结果 (${filteredActions.length})` : `剧本时间轴 (${timelineItemCount} 项)`}</span>
            {selectedIdsList.length > 0 && (
              <span style={{ color: 'var(--accent-primary)', fontSize: 10 }}>
                已选 {selectedIdsList.length}
              </span>
            )}
          </div>

          <div
            className="timeline-list-scroll"
            ref={listContainerRef}
            onDragLeave={(event) => {
              if (listContainerRef.current && !listContainerRef.current.contains(event.relatedTarget as Node)) {
                setDropTarget(null);
                setDragOverGapIndex(null);
              }
            }}
            style={{
              flex: 1, overflowY: 'auto', padding: allowInlineExpand ? '0 8px 16px' : '0 8px 12px',
              position: 'relative', minHeight: 0, isolation: 'isolate'
            }}
          >
            <div className="timeline-list-items" style={{ position: 'relative', height: virtualRows.totalHeight }}>
              {virtualRows.indices.map((realIdx) => {
                const action = filteredActions[realIdx];
                const isSelected = !!action._id && !!selectedActionIds[action._id];
                const isExpanded = !!action._id && !!expandedActionIds[action._id];
                const readModelItem = action._id
                  ? semanticTimelineItemByDisplayId.get(action._id)
                  : undefined;
                const presenceLocator = readModelItem?.locator;
                const editingPeers = presenceLocator
                  ? getPeersEditingLocator(collaborationPeers, presenceLocator)
                  : [];
                const collaborationEditingSummary = presenceLocator
                  ? summarizeLocatorEditingPeers(collaborationPeers, presenceLocator)
                  : null;
                let title: string = action.semanticLabel ?? action.action;
                let typeClass = getTimelineItemClassForSemanticCategory(action.semanticCategory);
                const environmentLayerId = getEnvironmentActionLayerId(action);
                const environmentLayer = environmentLayerId ? environmentLayers.get(environmentLayerId) : null;
                const gap = !searchQuery.trim() ? timelineListGapByIndex.get(realIdx) : undefined;
                const canDragRootStatement = !searchQuery.trim() && isRootStatementItem(readModelItem);
                const IconComp = (ActionIcons as any)[action.semanticIconKey ?? action.action] || ActionIcons.default;

                if (action.semanticType === 'filterAdd') {
                  title = '添加滤镜';
                  typeClass = 'timeline-item--environment';
                } else if (action.semanticType === 'filterChange') {
                  title = '变化滤镜';
                  typeClass = 'timeline-item--environment';
                } else if (action.semanticType === 'filterReset') {
                  title = '重置滤镜';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'dialogue') {
                  const char = sceneData.meta.characters?.find(c => c.id === action.params.speakerId);
                  title = char ? char.name : (action.params.speaker || action.params.speakerId || '旁白');
                  typeClass = 'timeline-item--dialogue';
                } else if (action.action === 'characterPerformance' && !action.params.motion) {
                  const targetCharId = action.resolvedSpeakerId ?? action.params.target;
                  const char = sceneData.meta.characters?.find(c => c.id === targetCharId);
                  title = `${char ? char.name : (targetCharId || '未知角色')} · 动作待定`;
                  typeClass = 'timeline-item--character timeline-item--placeholder';
                } else if (action.action === 'playMotion') {
                  const char = sceneData.meta.characters?.find(c => c.id === action.params.id);
                  title = `${char ? char.name : (action.params.id || '未知角色')} · 播放动作`;
                  typeClass = 'timeline-item--character';
                } else if (action.action === 'setExpression') {
                  const char = sceneData.meta.characters?.find(c => c.id === action.params.id);
                  title = `${char ? char.name : (action.params.id || '未知角色')} · 设置表情`;
                  typeClass = 'timeline-item--character';
                } else if (action.action === 'transformCharacter') {
                  const char = sceneData.meta.characters?.find(c => c.id === action.params.id);
                  title = `${char ? char.name : (action.params.id || '未知角色')} · 变换角色`;
                  typeClass = 'timeline-item--character';
                } else if (action.action === 'addCharacter') {
                  const char = sceneData.meta.characters?.find(c => c.id === action.params.id);
                  title = `${char ? char.name : (action.params.id || '未知角色')} · 角色登场`;
                  typeClass = 'timeline-item--character';
                } else if (action.action === 'removeCharacter') {
                  const char = sceneData.meta.characters?.find(c => c.id === action.params.id);
                  title = `${char ? char.name : (action.params.id || '未知角色')} · 角色退场`;
                  typeClass = 'timeline-item--character';
                } else if (action.action === 'characterLookAt') {
                  const char = sceneData.meta.characters?.find(c => c.id === action.params.id);
                  title = `${char ? char.name : (action.params.id || '未知角色')} · 角色对焦`;
                  typeClass = 'timeline-item--character';
                } else if (action.action === 'characterBlink') {
                  const char = sceneData.meta.characters?.find(c => c.id === action.params.id);
                  title = `${char ? char.name : (action.params.id || '未知角色')} · 角色眨眼`;
                  typeClass = 'timeline-item--character';
                } else if (action.action === 'setCharacterRimLight') {
                  const char = sceneData.meta.characters?.find(c => c.id === action.params.id);
                  title = `${char ? char.name : (action.params.id || '未知角色')} · 角色边光`;
                  typeClass = 'timeline-item--character';
                } else if (action.action === 'cameraPath') {
                  title = '镜头路径运动';
                  typeClass = 'timeline-item--camera';
                } else if (action.action === 'cameraShake') {
                  title = '镜头震动';
                  typeClass = 'timeline-item--camera';
                } else if (action.action === 'cameraFollow') {
                  const char = sceneData.meta.characters?.find(c => c.id === action.params.characterId);
                  title = `镜头跟随 · ${char ? char.name : (action.params.characterId || '未知角色')}`;
                  typeClass = 'timeline-item--camera';
                } else if (action.action === 'cameraHitchcock') {
                  const char = sceneData.meta.characters?.find(c => c.id === action.params.characterId);
                  title = `希区柯克变焦 · ${char ? char.name : (action.params.characterId || '未知角色')}`;
                  typeClass = 'timeline-item--camera';
                } else if (action.action === 'cameraMotion') {
                  title = '运镜动作';
                  typeClass = 'timeline-item--camera';
                } else if (action.action === 'cameraReset') {
                  title = '重置镜头';
                  typeClass = 'timeline-item--camera';
                } else if (action.action === 'setEnvironmentLayer') {
                  const layerId = action.params.layerId || BACKGROUND_LAYER_ID;
                  title = layerId === BACKGROUND_LAYER_ID ? '放入背景' : `放入环境画面 · ${environmentLayer?.displayLabel || '环境层'}`;
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'transformEnvironmentLayer') {
                  const layerId = action.params.layerId || BACKGROUND_LAYER_ID;
                  title = layerId === BACKGROUND_LAYER_ID ? '调整背景' : `调整环境画面 · ${environmentLayer?.displayLabel || '环境层'}`;
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'removeEnvironmentLayer') {
                  const layerId = action.params.layerId || BACKGROUND_LAYER_ID;
                  title = layerId === BACKGROUND_LAYER_ID ? '收起背景' : `收起环境画面 · ${environmentLayer?.displayLabel || '环境层'}`;
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'setCompositeRecipe') {
                  title = action.params.slot === 'grounding' ? '设置角色明暗融入' : action.params.slot === 'integration' ? '设置角色色彩融入' : '设置角色融入';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'modulateComposite') {
                  title = action.params.slot === 'grounding' ? '变化角色明暗融入' : action.params.slot === 'integration' ? '变化角色色彩融入' : '变化角色融入';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'resetCompositeRecipe') {
                  title = action.params.slot === 'grounding' ? '重置角色明暗融入' : action.params.slot === 'integration' ? '重置角色色彩融入' : '重置角色融入';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'setLighting') {
                  title = '设置光照预设';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'resetLighting') {
                  title = '重置光照';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'setBlur') {
                  title = '设置模糊';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'resetBlur') {
                  title = '重置模糊';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'setGodrays') {
                  title = '设置体积光';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'resetGodrays') {
                  title = '重置体积光';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'setPostProcessing') {
                  title = '设置后期处理';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'resetPostProcessing') {
                  title = '重置后处理';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'addColorOverlay') {
                  title = '添加色彩叠加';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'removeColorOverlay') {
                  title = '移除色彩叠加';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'clearColorOverlays') {
                  title = '清除全部色彩叠加';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'addPointLight') {
                  title = '添加点光源';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'clearPointLights') {
                  title = '清除全部点光源';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'removePointLight') {
                  title = '移除点光源';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'addImage') {
                  title = '添加图片';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'transformImage') {
                  title = '变换图片';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'removeImage') {
                  title = '移除图片';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'addTextLayer') {
                  title = '添加文本图层';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'transformTextLayer') {
                  title = '变换文本图层';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'removeTextLayer') {
                  title = '移除文本图层';
                  typeClass = 'timeline-item--environment';
                } else if (action.action === 'playAudio') {
                  title = '播放音频';
                  typeClass = 'timeline-item--audio';
                } else if (action.action === 'stopAudio') {
                  title = '停止音频';
                  typeClass = 'timeline-item--audio';
                } else if (action.action === 'setBGM') {
                  title = '设置背景音乐';
                  typeClass = 'timeline-item--audio';
                } else if (action.action === 'playCustomAnimation') {
                  title = '自定义动画';
                  typeClass = 'timeline-item--environment';
                }

                const isDragging = !!draggingActionId && (
                  draggingActionId === readModelItem?.statementId ||
                  (!!action._id && draggingActionId === action._id)
                );
                const isDropBefore = !isDragging && dropTarget?.index === realIdx && dropTarget.placement === 'before';
                const isDropAfter = !isDragging && dropTarget?.index === realIdx && dropTarget.placement === 'after';

                return (
                  <MeasuredTimelineRow key={virtualRowSizes[realIdx].id}
                    measurementKey={virtualRowSizes[realIdx].measurementKey}
                    top={virtualRows.offsets[realIdx]} gap={allowInlineExpand ? 6 : 4}
                    measure={virtualRows.measure}
                    onFocus={() => virtualRows.setFocusedId(virtualRowSizes[realIdx].id)}
                    onBlur={() => virtualRows.setFocusedId(null)}>
                  <div key={action._id ?? `timeline-item:${realIdx}`} className={`timeline-item-container ${!allowInlineExpand ? 'timeline-item-container--compact' : ''}`} style={{ position: 'relative' }}>
                    <div
                      className={`timeline-item ${typeClass} ${isSelected ? 'timeline-item--active' : ''} ${isExpanded && allowInlineExpand ? 'timeline-item--expanded' : ''} ${collaborationEditingSummary ? 'timeline-item--collaboration-editing' : ''} ${isDragging ? 'timeline-item--dragging' : ''} ${isDropBefore ? 'timeline-item--drop-before' : ''} ${isDropAfter ? 'timeline-item--drop-after' : ''} ${!allowInlineExpand ? 'timeline-item--compact' : 'timeline-item--authoring'}`}
                      onClick={(event) => {
                        handleSelect(action._id!, event.ctrlKey || event.metaKey);
                        if (allowInlineExpand && !event.ctrlKey && !event.metaKey) toggleExpand(action._id!);
                      }}
                      onDragOver={(event) => {
                        if (!draggingActionId || searchQuery.trim()) return;
                        if (isDragging) {
                          setDropTarget(null);
                          return;
                        }
                        event.preventDefault();
                        event.stopPropagation();
                        event.dataTransfer.dropEffect = 'move';
                        const rect = event.currentTarget.getBoundingClientRect();
                        const placement = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                        setDropTarget((current) => {
                          if (current?.index === realIdx && current?.placement === placement) return current;
                          return { index: realIdx, placement };
                        });
                        setDragOverGapIndex(null);
                      }}
                      onDragLeave={(event) => {
                        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                        setDropTarget((current) => (current?.index === realIdx ? null : current));
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        const currentDraggingId = draggingActionId;
                        setDropTarget(null);
                        setDragOverGapIndex(null);
                        if (!currentDraggingId || searchQuery.trim()) return;
                        const rect = event.currentTarget.getBoundingClientRect();
                        const insertAfter = event.clientY >= rect.top + rect.height / 2;
                        void dropRootStatementAt(currentDraggingId, realIdx + (insertAfter ? 1 : 0));
                      }}
                      role="group"
                      aria-label={`${title}${action.action === 'dialogue' && action.params?.text ? `，${action.params.text}` : ''}，时间 ${(action.time || 0).toFixed(1)} 秒${isSelected ? '，已选中' : ''}`}
                      title={collaborationEditingSummary || undefined}
                    >
                      <div className="timeline-item__identity">
                        {canDragRootStatement ? (
                          <button
                            type="button"
                            className={`timeline-item__drag-handle ${isDragging ? 'timeline-item__drag-handle--dragging' : ''}`}
                            draggable
                            style={{ background: isSelected ? 'rgba(255,255,255,0.08)' : 'var(--bg-surface)' }}
                            title="拖拽调整语句顺序"
                            aria-label={`拖拽第 ${realIdx + 1} 行调整语句顺序`}
                            onClick={(event) => event.stopPropagation()}
                            onDragStart={(event) => {
                              if (!readModelItem || readModelItem.locator.kind !== 'statement') {
                                event.preventDefault();
                                return;
                              }
                              event.stopPropagation();
                              event.dataTransfer.effectAllowed = 'move';
                              event.dataTransfer.setData('text/plain', readModelItem.statementId);
                              setDraggingActionId(readModelItem.statementId);
                              setDropTarget(null);
                              setDragOverGapIndex(null);
                            }}
                            onDragEnd={() => {
                              setDraggingActionId(null);
                              setDropTarget(null);
                              setDragOverGapIndex(null);
                            }}
                          >
                            <span className="timeline-item__type-glyph" aria-hidden="true">
                              <IconComp width={15} height={15} />
                            </span>
                            <IconGripVertical className="timeline-item__grip-glyph" width={15} height={15} aria-hidden="true" />
                          </button>
                        ) : (
                          <div
                            className="timeline-item__type-icon"
                            aria-hidden="true"
                            style={{ background: isSelected ? 'rgba(255,255,255,0.08)' : 'var(--bg-surface)' }}
                          >
                            <IconComp width={15} height={15} />
                          </div>
                        )}
                        <div className="timeline-item__time" title="编辑时间" onClick={(event) => event.stopPropagation()}>
                          <InlineNumericInput value={action.time || 0} step="0.1" min="0" popoverMin="0" popoverMax="60"
                            ariaLabel={`${title}开始时间`} disabled={isOfflineEditingBlocked}
                            onChange={(value, transient) => { if (!transient) handleTimeEdit(value, action._id!); }} />
                        </div>
                      </div>

                      {allowInlineExpand && (
                        <button
                          type="button"
                          className={`timeline-item__expand-btn ${isExpanded ? 'timeline-item__expand-btn--expanded' : ''}`}
                          aria-expanded={isExpanded}
                          aria-label={isExpanded ? '折叠详情' : '展开详情'}
                          title={isExpanded ? '折叠详情' : '展开详情'}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleExpand(action._id!);
                          }}
                        >
                          <IconChevronDown
                            width={13}
                            height={13}
                            style={{
                              transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
                              transition: 'transform var(--transition-fast)',
                            }}
                          />
                        </button>
                      )}

                      <button
                        type="button"
                        className="timeline-item__select-button"
                        aria-label={`选择${title}${isSelected ? '，当前已选中' : ''}`}
                        aria-pressed={isSelected}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleSelect(action._id!, event.ctrlKey || event.metaKey);
                          if (allowInlineExpand && !event.ctrlKey && !event.metaKey) toggleExpand(action._id!);
                        }}

                      >
                        <div className="timeline-item__title-row">
                          <div className="timeline-item__title">{title}</div>
                          {collaborationEditingSummary && (
                            <span
                              className="timeline-item__collaboration-badge"
                              title={collaborationEditingSummary}
                              aria-label={collaborationEditingSummary}
                            >
                              <IconUsers width={11} height={11} />
                              <span>{editingPeers.length}</span>
                            </span>
                          )}
                        </div>
                        {environmentLayer && (
                          <div className="timeline-item__layer-label" style={allowInlineExpand ? { display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' } : undefined}>
                            <span className="timeline-item__layer-tag">
                              {environmentLayer.isBackground ? '主背景' : environmentLayer.displayLabel}
                            </span>
                          </div>
                        )}
                      </button>

                      {allowInlineExpand && (
                        <div
                          className="timeline-item__inline-controls"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {readModelItem && (
                            <StatementQuickControls item={readModelItem} sceneMeta={sceneData.meta} sceneVisual={sceneData.visual}
                              disabled={isOfflineEditingBlocked} onChange={(patch) => commitInlineParams(action, patch)} />
                          )}
                        </div>
                      )}

                      <div className="timeline-item__actions">
                        <button
                          className="timeline-item__action-btn timeline-item__action-btn--play"
                          onClick={(event) => {
                            event.stopPropagation();
                            setCurrentTime(action.time || 0);
                            playbackAdapter.seek(action.time || 0);
                            playbackAdapter.play();
                          }}
                          title="播放到此句"
                          aria-label="播放到此句"
                        >
                          <IconPlay width={13} height={13} />
                        </button>
                        <button
                          className="timeline-item__action-btn timeline-item__action-btn--delete"
                          onClick={(event) => { void handleDeleteItem(event, action._id!); }}
                          title="删除语句"
                          aria-label="删除语句"
                        >
                          <IconTrash width={13} height={13} />
                        </button>
                      </div>
                    </div>

                    {allowInlineExpand && isExpanded && (
                      <div className="inspector-workspace__detail" onClick={(event) => event.stopPropagation()}>
                        <ActionInspector
                          key={action._id}
                          sceneData={sceneData}
                          semanticTimelineItems={semanticTimelineItems}
                          presentation="inline"
                          selectedActionIds={{ [action._id!]: true }}
                          setSelectedIds={setSelectedIds}
                          updateAction={props.updateAction ?? ((_id, updates) => {
                            if (updates.params) commitInlineParams(action, updates.params, true);
                          })}
                          updateParam={props.updateParam ?? ((_id, key, val) => {
                            commitInlineParams(action, { [key]: val });
                          })}
                          replaceSourceParams={props.replaceSourceParams ?? ((_id, params) => {
                            commitInlineParams(action, params, true);
                          })}
                          deleteAction={props.deleteAction ?? ((id) => {
                            void handleDeleteItem({ stopPropagation: () => {} } as any, id);
                          })}
                          copyActions={props.copyActions}
                          onClose={() => toggleExpand(action._id!)}
                          closeMode="close"
                        />
                      </div>
                    )}

                    {gap && (
                      <div
                        className={`timeline-list-gap ${dragOverGapIndex === gap.index ? 'timeline-list-gap--drag-over' : ''}`}
                        data-testid="timeline-list-gap"
                        data-active={activeGapMenu?.gap.index === gap.index}
                        onDragOver={(event) => {
                          if (!draggingActionId) return;
                          event.preventDefault();
                          event.stopPropagation();
                          event.dataTransfer.dropEffect = 'move';
                          setDragOverGapIndex(gap.index);
                          setDropTarget(null);
                        }}
                        onDragLeave={(event) => {
                          if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                          setDragOverGapIndex((current) => (current === gap.index ? null : current));
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          const currentDraggingId = draggingActionId;
                          setDragOverGapIndex(null);
                          setDropTarget(null);
                          if (!currentDraggingId) return;
                          void dropRootStatementAt(currentDraggingId, gap.index + 1);
                        }}
                      >
                        <button
                          type="button"
                          className="timeline-list-gap__button"
                          tabIndex={-1}
                          aria-label={`在 ${gap.time.toFixed(1)} 秒插入语句`}
                          title={`在 ${gap.time.toFixed(1)} 秒插入语句`}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (gapInsertPendingRef.current) return;
                            if (blockOfflineAuthoring()) return;
                            const rect = event.currentTarget.getBoundingClientRect();
                            const x = Math.max(12, rect.left - 424);
                            const y = rect.top;
                            setActiveGapMenu((current) => (current?.gap.index === gap.index ? null : { gap, x, y }));
                          }}
                        >
                          <IconPlus width={11} height={11} aria-hidden="true" />
                        </button>
                      </div>
                    )}
                  </div>
                  </MeasuredTimelineRow>
                );
              })}
            </div>
          </div>
        </>
      )}

      <StatementLibraryMenu
        menu={activeGapMenu ? {
          x: activeGapMenu.x,
          y: activeGapMenu.y,
          time: activeGapMenu.gap.time,
          ...(gapContextMeta ? { contextMeta: gapContextMeta } : {}),
        } : null}
        hasCopyBuffer={copyBuffer.length > 0}
        templates={props.availableTemplates}
        onPaste={handlePasteAtGap}
        onSelectAction={handleSelectActionFromLibrary}
        onDismiss={() => setActiveGapMenu(null)}
        dataTestId="timeline-blank-insert-menu"
        ariaLabel="时间轴插入语句菜单"
        availableLifecycleEndCommandIds={availableLifecycleEndCommandIds}
        availableStateSpanDependencyCommandIds={availableLifecycleTargetBindingCommandIds}
      />
    </div>
  );
};
