/**
 * AeonStagery — Visual Timeline Editor
 *
 * Real-time editor for JSON scene scripts. Allows modifying actions, timing,
 * and parameters visually, replacing the need to hand-write JSON.
 */

import React, { useState, useCallback, useEffect, useRef, useMemo, useLayoutEffect } from 'react';
import {
  useApp,
  usePlaybackAdapter,
  useDocumentStore,
  useSemanticAuthoringService,
  useCollaborationStatus,
} from './context/AppContext';
import type { TimelineAction, TimelineScene } from './timeline/semanticTimelineTypes';
import { AUTHORING_SCHEMA_VERSION } from '../api/types/authoring';
import { useEditorState, useSemanticDocument, useValidationIssues } from './store/storeHooks';

// Sub-components
import { TrackArea } from './timeline/TrackArea';
import { InspectorArea } from './timeline/InspectorArea';
import { TimelineZoomSlider } from './timeline/TimelineZoomSlider';
import { detectMotionRepeats } from '../engine/MotionRepeatDetector';
import {
  animateViewportTransition,
  computeRangeNavigationTarget,
  type ViewportAnimationHandle,
  type TimelineViewportTarget,
} from './timeline/timelineViewport';
import { withAuthorFacingEnvironmentLabel } from './timeline/environmentAuthoring';
import { buildTimelineTracks, isCharacterTrackAction } from './timeline/timelineTrackPresentation';
import { buildSemanticTimelineReadModel } from './timeline/semanticTimelineReadModel';
import { deriveTimelineMaxTimeSeconds } from './timeline/timelineMaxTime';
import { TimelineSelectionBar } from './timeline/TimelineSelectionBar';
import { pruneSelectedActionIdsForTimeline } from './timeline/selectionHygiene';
import { getTimelineActionDuration } from './timeline/timelineDensity';
import { showToast } from './Toast';
import { deriveCollaborationStatusUx } from '../services/collaboration/CollaborationStatusUxModel';
import { eventBus } from '../api/events';
import {
  inspectorViewSupportsActionDetail,
  type InspectorPanelView,
} from './timeline/InspectorViewPicker';
import {
  buildSemanticCopyBufferForTimelineActions,
  buildSemanticDeleteTimelineIntents,
  buildSemanticDuplicateTimelineIntent,
  buildSemanticDurationUpdateIntent,
  buildSemanticMoveTimelineIntent,
  buildSemanticPasteTimelineIntent,
  buildSemanticSourceParamUpdateIntent,
  buildSemanticSourceParamsReplaceIntent,
  buildSemanticTimelineParamUpdateIntent,
  buildSemanticRetargetTimelineIntents,
  buildSemanticSplitTimelineIntents,
  createSemanticTimelineCorrelationId,
  defaultDialogueStatementDraft,
  locatorForCompiledTimelineAction,
  selectCompiledActionsForStatements,
  shouldRouteTimelineParamPatchToSource,
} from './timeline/semanticTimelineEditing';
import type { ShortcutCommandId } from './shortcuts/types';

export interface TimelineEditorProps {
  mode?: 'all' | 'inspector' | 'tracks';
  inspectorLayout?: 'split' | 'replace';
  inspectorNavigatorWidth?: number;
  inspectorDetailWidth?: number;
  inspectorView?: InspectorPanelView;
  onInspectorDetailResizeStart?: (event: React.MouseEvent) => void;
  onInspectorDetailResizeKeyDown?: (event: React.KeyboardEvent) => void;
  onInspectorDetailVisibilityChange?: (visible: boolean) => void;
  onSelectInspectorView?: (view: InspectorPanelView) => void;
  onDetachWorkspaceTools?: () => void;
  canDetachWorkspaceTools?: boolean;
}

const DETAIL_EXIT_DURATION_MS = 200;

export function TimelineEditor({
  mode = 'all',
  inspectorLayout = 'replace',
  inspectorNavigatorWidth = 320,
  inspectorDetailWidth = 360,
  inspectorView = 'actions',
  onInspectorDetailResizeStart,
  onInspectorDetailResizeKeyDown,
  onInspectorDetailVisibilityChange,
  onSelectInspectorView,
  onDetachWorkspaceTools,
  canDetachWorkspaceTools = false,
}: TimelineEditorProps) {
  const {
    selectedActionIds,
    setSelectedIds,
    pixelsPerSecond,
    setPixelsPerSecond,
    loadExample,
    handleSave,
  } = useEditorState();
  const { document: semanticDocument } = useSemanticDocument();
  const playbackAdapter = usePlaybackAdapter();
  const documentStore = useDocumentStore();
  const semanticAuthoring = useSemanticAuthoringService();
  const app = useApp();
  const editorStore = app.stores.editor;
  const dialoguePresentation = app.services?.projectWorkspace
    ?.getCurrentProject()?.metadata.templates?.dialoguePresentation;
  const dialogueTemplate = app.services?.projectWorkspace
    ?.getCurrentProject()?.metadata.templates?.dialogueTemplate;
  const collaborationStatus = useCollaborationStatus();
  const collaborationStatusUx = useMemo(() => deriveCollaborationStatusUx({ status: collaborationStatus }), [collaborationStatus]);
  const offlineEditMessage = collaborationStatusUx.offlineEditMessage ?? '共享编辑已暂停；请重新加入后才能编辑。';
  const { issues: validationIssues } = useValidationIssues();

  const [scrollLeft, setScrollLeft] = useState(0);
  const [timelineWidth, setTimelineWidth] = useState(1000);
  const [inspectorTab, setInspectorTab] = useState<'basic' | 'transform' | 'state'>('basic');
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailClosing, setDetailClosing] = useState(false);
  const [detailSelectedActionIds, setDetailSelectedActionIds] = useState<Record<string, boolean>>({});
  const [isZoomSliderInteracting, setIsZoomSliderInteracting] = useState(false);
  const [zoomViewportPreview, setZoomViewportPreview] = useState<TimelineViewportTarget | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const viewportAnimationRef = useRef<ViewportAnimationHandle | null>(null);
  const detailCloseTimerRef = useRef<number | null>(null);
  const detailOpenRef = useRef(false);
  const detailClosingRef = useRef(false);
  const lastSeekTime = useRef<number>(0);
  const lastAutoRevealSelectionRef = useRef<string | null>(null);
  const suppressScrollSyncRef = useRef(false);
  const isOfflineEditingBlocked = collaborationStatus === 'offline' || collaborationStatus === 'reconnecting';

  const semanticTimelineItems = useMemo(
    () => buildSemanticTimelineReadModel(
      semanticDocument,
      documentStore.getCompiledSceneSnapshot(),
    ),
    [documentStore, semanticDocument],
  );
  const semanticSceneEnd = useMemo(() => {
    if (!semanticDocument) return 0;
    let maxActionEnd = semanticDocument.meta.durationSeconds ?? 0;
    for (const item of semanticTimelineItems) {
      maxActionEnd = Math.max(maxActionEnd, item.time + item.durationSeconds);
    }
    return maxActionEnd;
  }, [semanticDocument, semanticTimelineItems]);
  // Length from real statement extents only — never State Span derived ends.
  const maxTime = useMemo(
    () => deriveTimelineMaxTimeSeconds(semanticSceneEnd),
    [semanticSceneEnd],
  );
  // Ordinary semantic display actions only — no synthetic StateSpan projection.
  const timelineReadModelActions = useMemo(
    () => semanticTimelineItems.map((item) => item.displayAction),
    [semanticTimelineItems],
  );
  const timelineReadModelActionById = useMemo(
    () => new Map(timelineReadModelActions.flatMap((action) => action._id ? [[action._id, action] as const] : [])),
    [timelineReadModelActions],
  );
  const blockOfflineEdit = useCallback(() => {
    if (!isOfflineEditingBlocked) return false;
    showToast(offlineEditMessage, 'warning');
    return true;
  }, [isOfflineEditingBlocked, offlineEditMessage]);

  const shouldUseSourceParamPatch = useCallback((id: string, paramPatch: Record<string, unknown>) => {
    const action = timelineReadModelActionById.get(id);
    let sourceParams = action?.sourceParams;
    if (!sourceParams) {
      const locator = locatorForCompiledTimelineAction(documentStore, id);
      const document = documentStore.getCurrentSceneDocumentSnapshot();
      if (locator?.kind === 'statement') {
        sourceParams = document?.statements.find((statement) => statement.id === locator.statementId)?.params;
      }
    }
    return shouldRouteTimelineParamPatchToSource(
      sourceParams,
      paramPatch,
      !!locatorForCompiledTimelineAction(documentStore, id),
      action?.semanticType,
    );
  }, [documentStore, timelineReadModelActionById]);

  const replaceSourceParams = useCallback(async (id: string, params: Record<string, unknown>) => {
    if (blockOfflineEdit()) return;
    if (!semanticDocument || !semanticAuthoring) return;
    const intent = buildSemanticSourceParamsReplaceIntent(documentStore, id, params);
    if (intent) await semanticAuthoring.author(intent);
  }, [blockOfflineEdit, documentStore, semanticAuthoring, semanticDocument]);
  const effectivePixelsPerSecond = zoomViewportPreview?.pixelsPerSecond ?? pixelsPerSecond;
  const effectiveScrollLeft = zoomViewportPreview?.scrollLeft ?? scrollLeft;

  const isProgrammaticScroll = useRef(false);

  // Migrated from useEffect to useLayoutEffect to prevent frame-lag jitter during scroll
  useLayoutEffect(() => {
    if (timelineRef.current && timelineRef.current.scrollLeft !== effectiveScrollLeft) {
      isProgrammaticScroll.current = true;
      timelineRef.current.scrollLeft = effectiveScrollLeft;
    }
  }, [effectiveScrollLeft]);

  // Handle manual scroll in the container
  const scrollTicking = useRef(false);
  const handleContainerScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (suppressScrollSyncRef.current) {
      return;
    }
    if (isProgrammaticScroll.current) {
      isProgrammaticScroll.current = false;
      return;
    }
    const targetScrollLeft = e.currentTarget.scrollLeft;
    if (!scrollTicking.current) {
      window.requestAnimationFrame(() => {
        setScrollLeft(targetScrollLeft);
        scrollTicking.current = false;
      });
      scrollTicking.current = true;
    }
  };

  // Update width tracking
  useEffect(() => {
    const updateWidth = () => {
      setTimelineWidth(timelineRef.current?.clientWidth || 1000);
    };
    if (timelineRef.current) {
      updateWidth();
      window.addEventListener('resize', updateWidth);
    }
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  useEffect(() => {
    return () => {
      viewportAnimationRef.current?.cancel();
      viewportAnimationRef.current = null;
    };
  }, []);

  useEffect(() => {
    const result = pruneSelectedActionIdsForTimeline(selectedActionIds, timelineReadModelActions);
    if (result.changed) {
      setSelectedIds(result.selectedActionIds);
    }
  }, [timelineReadModelActions, selectedActionIds, setSelectedIds]);

  // Auto-scroll timeline to bring selected action into view (X and Y axis)
  useEffect(() => {
    const selectedIds = Object.keys(selectedActionIds);
    if (selectedIds.length !== 1) {
      lastAutoRevealSelectionRef.current = null;
      return;
    }
    
    const selectedId = selectedIds[0];
    if (lastAutoRevealSelectionRef.current === selectedId) return;
    lastAutoRevealSelectionRef.current = selectedId;

    const action = timelineReadModelActionById.get(selectedId);
    if (!action) return;
    
    const container = timelineRef.current;
    if (!container) return;

    // Use a tiny timeout to ensure the TrackArea has finished rendering the block element ref in the DOM
    const timer = setTimeout(() => {
      const blockEl = (
        container.querySelector(`[data-id="${selectedId}"]`) ||
        container.querySelector(`[data-anchor-id="${selectedId}"]`)
      ) as HTMLElement | null;
      if (!blockEl) {
        // Fallback to pure time-based X scroll if DOM element is not found yet
        const actionTime = action.time ?? 0;
        const actionX = actionTime * effectivePixelsPerSecond;
        const marginX = 100;
        const isOutsideX = actionX < effectiveScrollLeft + marginX || actionX > effectiveScrollLeft + timelineWidth - marginX;
        if (isOutsideX) {
          const targetScroll = Math.max(0, actionX - timelineWidth / 3);
          setScrollLeft(targetScroll);
        }
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const blockRect = blockEl.getBoundingClientRect();

      // 1. Horizontal Scroll Reveal (X-Axis)
      const isOutsideX = blockRect.left < containerRect.left + 100 || blockRect.right > containerRect.right - 100;
      if (isOutsideX) {
        const relativeLeft = blockRect.left - containerRect.left + container.scrollLeft;
        const targetScrollLeft = Math.max(0, relativeLeft - containerRect.width / 3);
        setScrollLeft(targetScrollLeft);
      }

      // 2. Vertical Scroll Reveal (Y-Axis)
      const isOutsideY = blockRect.top < containerRect.top + 40 || blockRect.bottom > containerRect.bottom - 40;
      if (isOutsideY) {
        const relativeTop = blockRect.top - containerRect.top + container.scrollTop;
        const targetScrollTop = Math.max(0, relativeTop - containerRect.height / 2 + blockRect.height / 2);
        container.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
      }
    }, 60);

    return () => clearTimeout(timer);
  }, [selectedActionIds, documentStore, effectivePixelsPerSecond, effectiveScrollLeft, timelineReadModelActionById, timelineWidth]);

  const authorBatchMove = useCallback((
    updates: readonly { id: string; time: number }[],
  ): void | Promise<unknown> => {
    if (blockOfflineEdit()) return;
    if (!semanticDocument || !semanticAuthoring) return;
    const intent = buildSemanticMoveTimelineIntent(documentStore, updates);
    if (!intent) return;
    // Returning the promise lets the caller keep transient overlays pinned
    // until the commit actually lands.
    return semanticAuthoring.author(intent);
  }, [blockOfflineEdit, documentStore, semanticAuthoring, semanticDocument]);

  const onBatchDrag = useCallback((updates: Array<{ id: string; time: number }>) => {
    // A selected dialogue root already carries its companions through the
    // parent move. Do not send duplicate companion moves in the same intent.
    const selected = new Set(updates.map((update) => update.id));
    const itemById = new Map(semanticTimelineItems.map((item) => [item.id, item]));
    const collapsed = updates.filter((update) => {
      const item = itemById.get(update.id);
      return !(item?.companionId && item.parentItemId && selected.has(item.parentItemId));
    });
    // Return the promise so useBatchDrag keeps its transient overlays pinned
    // until the batch commit settles (same chain as single drag).
    return authorBatchMove(collapsed);
  }, [authorBatchMove, semanticTimelineItems]);

  const updateAction = useCallback((id: string, updates: Partial<TimelineAction>, isTransient?: boolean) => {
    if (blockOfflineEdit()) return;
    if (!semanticDocument || !semanticAuthoring) return;
    const paramPatch = updates.params ?? {};
    const runtimePatch = {
      ...paramPatch,
      ...(updates.time !== undefined ? { time: updates.time } : {}),
    };
    if (updates.time !== undefined) {
      const intent = buildSemanticMoveTimelineIntent(documentStore, [{ id, time: updates.time }]);
      if (intent && !isTransient) void semanticAuthoring.author(intent);
    }
    if (Object.keys(paramPatch).length === 0) return;
    const intent = shouldUseSourceParamPatch(id, paramPatch)
      ? buildSemanticSourceParamUpdateIntent(documentStore, id, paramPatch)
      : buildSemanticTimelineParamUpdateIntent(documentStore, id, runtimePatch);
    if (!intent || isTransient) return;
    void semanticAuthoring.author(intent);
  }, [blockOfflineEdit, documentStore, semanticAuthoring, semanticDocument, shouldUseSourceParamPatch]);

  const updateParam = useCallback((id: string, key: string, value: any, isTransient?: boolean) => {
    if (blockOfflineEdit()) return;
    if (!semanticDocument || !semanticAuthoring) return;
    const paramPatch = { [key]: value };
    const intent = shouldUseSourceParamPatch(id, paramPatch)
      ? buildSemanticSourceParamUpdateIntent(documentStore, id, paramPatch)
      : buildSemanticTimelineParamUpdateIntent(documentStore, id, paramPatch);
    if (!intent || isTransient) return;
    void semanticAuthoring.author(intent);
  }, [blockOfflineEdit, documentStore, semanticAuthoring, semanticDocument, shouldUseSourceParamPatch]);

  const addActionAt = useCallback(async (time: number) => {
    if (blockOfflineEdit()) return;
    if (!semanticDocument || !semanticAuthoring) return;
    const roundedTime = Math.max(0, Math.round(time * 10) / 10);
    const receipt = await semanticAuthoring.author({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: createSemanticTimelineCorrelationId('timeline_add'),
      origin: 'timeline-editor',
      kind: 'insert-statement',
      anchorTime: roundedTime,
      statement: defaultDialogueStatementDraft(semanticDocument, dialoguePresentation, dialogueTemplate),
    });
    const nextSelected = selectCompiledActionsForStatements(
      documentStore.getCompiledSceneSnapshot(),
      receipt.createdStatementIds,
    );
    if (Object.keys(nextSelected).length > 0) {
      setSelectedIds(nextSelected);
    }
  }, [blockOfflineEdit, dialoguePresentation, dialogueTemplate, documentStore, semanticAuthoring, semanticDocument, setSelectedIds]);

  const addAction = useCallback(() => addActionAt(playbackAdapter.getCurrentTime()), [addActionAt, playbackAdapter]);

  const timelinePresentationScene = useMemo<TimelineScene | null>(() => {
    if (!semanticDocument) return null;
    return {
      sceneId: semanticDocument.sceneId,
      meta: semanticDocument.meta,
      visual: semanticDocument.visual,
      timeline: timelineReadModelActions,
    };
  }, [semanticDocument, timelineReadModelActions]);

  const tracks = React.useMemo(() => (
    timelinePresentationScene ? buildTimelineTracks(timelinePresentationScene) : []
  ), [timelinePresentationScene]);

  const repeatWarnings = useMemo(() => {
    if (!timelinePresentationScene) return [];
    return detectMotionRepeats(timelinePresentationScene.timeline, 30);
  }, [timelinePresentationScene]);

  const repeatIndexMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!timelinePresentationScene) return map;
    repeatWarnings.forEach(w => {
      const actionA = timelinePresentationScene.timeline[w.indexA];
      const actionB = timelinePresentationScene.timeline[w.indexB];
      if (actionA?._id) map.set(actionA._id, w.motionKey);
      if (actionB?._id) map.set(actionB._id, w.motionKey);
    });
    return map;
  }, [repeatWarnings, timelinePresentationScene]);

  const selectedIdsList = useMemo(
    () => Object.keys(selectedActionIds).filter((id) => selectedActionIds[id]),
    [selectedActionIds],
  );
  const selectedIdsKey = useMemo(() => selectedIdsList.slice().sort().join('|'), [selectedIdsList]);
  const detailSelectedIdsList = useMemo(
    () => Object.keys(detailSelectedActionIds).filter((id) => detailSelectedActionIds[id]),
    [detailSelectedActionIds],
  );
  const cancelPendingDetailClose = useCallback(() => {
    if (detailCloseTimerRef.current === null) return;
    window.clearTimeout(detailCloseTimerRef.current);
    detailCloseTimerRef.current = null;
  }, []);

  const openDetail = useCallback(() => {
    cancelPendingDetailClose();
    detailOpenRef.current = true;
    detailClosingRef.current = false;
    setDetailClosing(false);
    setDetailOpen(true);
  }, [cancelPendingDetailClose]);

  const closeDetail = useCallback(() => {
    cancelPendingDetailClose();
    if (!detailOpenRef.current) return;

    const skipAnimation = document.documentElement.dataset.perf === 'low'
      || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (skipAnimation) {
      detailOpenRef.current = false;
      detailClosingRef.current = false;
      setDetailClosing(false);
      setDetailOpen(false);
      return;
    }

    detailClosingRef.current = true;
    setDetailClosing(true);
    detailCloseTimerRef.current = window.setTimeout(() => {
      detailCloseTimerRef.current = null;
      detailOpenRef.current = false;
      detailClosingRef.current = false;
      setDetailOpen(false);
      setDetailClosing(false);
    }, DETAIL_EXIT_DURATION_MS);
  }, [cancelPendingDetailClose]);

  useLayoutEffect(() => {
    if (selectedIdsKey) {
      setDetailSelectedActionIds(Object.fromEntries(selectedIdsList.map((id) => [id, true])));
      openDetail();
      return;
    }
    closeDetail();
  }, [
    closeDetail,
    openDetail,
    selectedIdsKey,
    selectedIdsList,
  ]);

  useLayoutEffect(() => {
    if (mode !== 'inspector') return;
    onInspectorDetailVisibilityChange?.(
      inspectorViewSupportsActionDetail(inspectorView)
      && detailOpen
      && !detailClosing
      && detailSelectedIdsList.length > 0,
    );
  }, [
    detailClosing,
    detailOpen,
    detailSelectedIdsList.length,
    inspectorView,
    mode,
    onInspectorDetailVisibilityChange,
  ]);

  useEffect(() => {
    if (mode !== 'inspector') return;
    return () => onInspectorDetailVisibilityChange?.(false);
  }, [mode, onInspectorDetailVisibilityChange]);

  useEffect(() => () => {
    cancelPendingDetailClose();
  }, [cancelPendingDetailClose]);

  const singleSelectedAction = useMemo(
    () => selectedIdsList.length === 1
      ? timelineReadModelActionById.get(selectedIdsList[0]) ?? null
      : null,
    [selectedIdsList, timelineReadModelActionById],
  );
  const singleSelectedDisplayAction = useMemo(() => (
    timelinePresentationScene && singleSelectedAction
      ? withAuthorFacingEnvironmentLabel(timelinePresentationScene, singleSelectedAction)
      : singleSelectedAction
  ), [singleSelectedAction, timelinePresentationScene]);
  const stableCanonicalActions = useMemo(() => (
    timelinePresentationScene ? timelinePresentationScene.timeline.filter((action) => !!action._id) : []
  ), [timelinePresentationScene]);
  const trackLabelByActionId = useMemo(() => {
    const labels = new Map<string, string>();
    for (const track of tracks) {
      for (const { id } of track.actions) {
        labels.set(id, track.label);
      }
    }
    return labels;
  }, [tracks]);
  const trackIdByActionId = useMemo(() => {
    const ids = new Map<string, string>();
    for (const track of tracks) {
      for (const { id } of track.actions) {
        ids.set(id, track.id);
      }
    }
    return ids;
  }, [tracks]);
  const selectedIssueCount = useMemo(() => {
    const selected = new Set(selectedIdsList);
    return validationIssues.filter((issue) => issue.actionId && selected.has(issue.actionId)).length;
  }, [selectedIdsList, validationIssues]);

  const handleSelect = useCallback((idOrIds: string | string[], isMulti?: boolean) => {
    setDetailOpen(true);
    if (Array.isArray(idOrIds)) {
      const next: Record<string, boolean> = {};
      idOrIds.forEach(id => { next[id] = true; });
      setSelectedIds(next);
    } else if (isMulti) {
      const current = { ...selectedActionIds };
      if (current[idOrIds]) {
        delete current[idOrIds];
      } else {
        current[idOrIds] = true;
      }
      setSelectedIds(current);
    } else {
      setSelectedIds({ [idOrIds]: true });
    }
  }, [selectedActionIds, setSelectedIds]);

  const handleDrag = useCallback((id: string, time: number, updates?: Array<{ id: string; time: number }>): void | Promise<unknown> => {
    if (blockOfflineEdit()) return;
    if (!semanticAuthoring) return;
    const draggedItem = semanticTimelineItems.find((item) => item.id === id);
    const normalizedUpdates = draggedItem?.locator.kind === 'statement'
      ? [{ id, time }]
      : updates ?? [{ id, time }];
    const intent = buildSemanticMoveTimelineIntent(documentStore, normalizedUpdates);
    if (!intent) return;
    // Returning the promise lets the drag interaction keep its transient
    // overlay pinned until the commit lands (no jump-back flicker).
    return semanticAuthoring.author(intent);
  }, [blockOfflineEdit, documentStore, semanticAuthoring, semanticTimelineItems]);
  const handleResize = useCallback((id: string, dur: number): void | Promise<unknown> => {
    if (blockOfflineEdit()) return;
    if (!semanticAuthoring) return;
    const intent = buildSemanticDurationUpdateIntent(documentStore, id, dur);
    if (!intent) return;
    return semanticAuthoring.author(intent);
  }, [blockOfflineEdit, documentStore, semanticAuthoring]);

  const handleSeek = useCallback((t: number, isFinal: boolean = false) => {
    const now = Date.now();
    if (isFinal || now - lastSeekTime.current > 32) {
      playbackAdapter.seek(t, isFinal);
      lastSeekTime.current = now;
    }
  }, [playbackAdapter]);

  const handleNavigateRange = useCallback((range: { start: number; end: number }) => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const target = computeRangeNavigationTarget(
      range,
      Math.max(24, effectivePixelsPerSecond),
      timelineWidth,
      maxTime,
    );

    viewportAnimationRef.current?.cancel();
    viewportAnimationRef.current = animateViewportTransition({
      from: {
        pixelsPerSecond: effectivePixelsPerSecond,
        scrollLeft: effectiveScrollLeft,
      },
      to: target,
      durationMs: 300,
      reduceMotion,
      onUpdate: (next) => {
        setPixelsPerSecond(next.pixelsPerSecond);
        setScrollLeft(next.scrollLeft);
      },
    });
  }, [effectivePixelsPerSecond, effectiveScrollLeft, maxTime, setPixelsPerSecond, timelineWidth]);

  const handleZoomSliderInteractionChange = useCallback((isActive: boolean) => {
    suppressScrollSyncRef.current = isActive;
    setIsZoomSliderInteracting(isActive);
    if (isActive) {
      viewportAnimationRef.current?.cancel();
      viewportAnimationRef.current = null;
    }
  }, []);

  const handleZoomViewportPreview = useCallback((next: TimelineViewportTarget) => {
    setZoomViewportPreview(next);
  }, []);

  const handleZoomViewportCommit = useCallback((next: TimelineViewportTarget) => {
    setZoomViewportPreview(next);
    setPixelsPerSecond(next.pixelsPerSecond);
    setScrollLeft(next.scrollLeft);
  }, [setPixelsPerSecond]);

  useEffect(() => {
    if (isZoomSliderInteracting || !zoomViewportPreview) return;
    const ppsSettled = Math.abs(pixelsPerSecond - zoomViewportPreview.pixelsPerSecond) < 0.01;
    const scrollSettled = Math.abs(scrollLeft - zoomViewportPreview.scrollLeft) < 1;
    if (ppsSettled && scrollSettled) {
      setZoomViewportPreview(null);
    }
  }, [isZoomSliderInteracting, pixelsPerSecond, scrollLeft, zoomViewportPreview]);

  const chunkedScrollLeft = Math.floor(effectiveScrollLeft / (timelineWidth || 1000)) * (timelineWidth || 1000);

  const memoViewWindow = useMemo(() => ({
    start: Math.max(0, (chunkedScrollLeft - timelineWidth) / effectivePixelsPerSecond),
    end: (chunkedScrollLeft + 2 * timelineWidth) / effectivePixelsPerSecond
  }), [chunkedScrollLeft, effectivePixelsPerSecond, timelineWidth]);

  const handleSeekToSelection = useCallback(() => {
    if (!singleSelectedAction) return;
    void playbackAdapter.seek(singleSelectedAction.time || 0, true);
  }, [playbackAdapter, singleSelectedAction]);

  const handleRevealSelection = useCallback(() => {
    if (!singleSelectedAction) {
      const selectedActions = selectedIdsList
        .map((id) => timelineReadModelActionById.get(id))
        .filter((action): action is TimelineAction => !!action);
      if (selectedActions.length === 0) return;
      const start = Math.min(...selectedActions.map((action) => action.time || 0));
      const end = Math.max(...selectedActions.map((action) => (action.time || 0) + getTimelineActionDuration(action)));
      handleNavigateRange({ start, end });
      return;
    }
    const start = singleSelectedAction.time || 0;
    const end = start + getTimelineActionDuration(singleSelectedAction);
    handleNavigateRange({ start, end });
    void playbackAdapter.seek(start, true);
  }, [handleNavigateRange, playbackAdapter, selectedIdsList, singleSelectedAction, timelineReadModelActionById]);

  const handleSelectAdjacentAction = useCallback((direction: -1 | 1) => {
    if (!singleSelectedAction?._id || stableCanonicalActions.length === 0) return;
    const currentIndex = stableCanonicalActions.findIndex((action) => action._id === singleSelectedAction._id);
    if (currentIndex < 0) return;
    const nextIndex = Math.max(0, Math.min(stableCanonicalActions.length - 1, currentIndex + direction));
    const nextAction = stableCanonicalActions[nextIndex];
    if (!nextAction?._id) return;
    setSelectedIds({ [nextAction._id]: true });
    void playbackAdapter.seek(nextAction.time || 0, true);
  }, [playbackAdapter, setSelectedIds, singleSelectedAction, stableCanonicalActions]);

  const selectedActions = useMemo(() => (
    selectedIdsList
      .map((id) => timelineReadModelActionById.get(id))
      .filter((action): action is TimelineAction => !!action)
  ), [selectedIdsList, timelineReadModelActionById]);

  const selectedActionTrackValue = useMemo(() => {
    if (selectedActions.length === 0) return '';
    const ids = new Set<string>();
    for (const action of selectedActions) {
      if (!action._id) continue;
      const trackId = trackIdByActionId.get(action._id);
      if (trackId) ids.add(trackId);
    }
    return ids.size === 1 ? [...ids][0] : '';
  }, [selectedActions, trackIdByActionId]);

  const canMoveActionToCharacterTrack = useCallback((action: TimelineAction) => (
    !!timelinePresentationScene && isCharacterTrackAction(timelinePresentationScene, action)
  ), [timelinePresentationScene]);

  const quickTrackOptions = useMemo(() => tracks.map((track) => ({
    id: track.id,
    label: track.label,
    disabled: !track.id.startsWith('char:')
      || selectedActions.some((action) => !canMoveActionToCharacterTrack(action)),
  })), [canMoveActionToCharacterTrack, selectedActions, tracks]);

  const canSplitSelection = useMemo(() => {
    if (!singleSelectedAction) return false;
    const start = singleSelectedAction.time || 0;
    const duration = singleSelectedAction.params.duration || 0;
    const currentTime = playbackAdapter.getCurrentTime();
    return duration > 0.1 && currentTime > start && currentTime < start + duration;
  }, [playbackAdapter, singleSelectedAction]);

  const handleCopyActionIds = useCallback((actionIds: readonly string[]) => {
    if (actionIds.length === 0) return;
    const statements = buildSemanticCopyBufferForTimelineActions(
      documentStore,
      actionIds,
    );
    if (statements.length === 0) return;
    editorStore.setCopyBuffer(statements);
    showToast(`已复制 ${statements.length} 个语义语句`, 'success');
  }, [documentStore, editorStore]);

  const handleCopySelection = useCallback(() => {
    handleCopyActionIds(selectedIdsList);
  }, [handleCopyActionIds, selectedIdsList]);

  const handleDuplicateActionIds = useCallback(async (actionIds: readonly string[]) => {
    if (blockOfflineEdit()) return;
    if (!semanticAuthoring || actionIds.length === 0) return;
    const intent = buildSemanticDuplicateTimelineIntent(
      documentStore,
      actionIds,
    );
    if (!intent) return;
    const receipt = await semanticAuthoring.author(intent);
    if (receipt.createdStatementIds.length > 0) {
      const next = selectCompiledActionsForStatements(
        documentStore.getCompiledSceneSnapshot(),
        receipt.createdStatementIds,
      );
      if (Object.keys(next).length > 0) setSelectedIds(next);
    }
  }, [blockOfflineEdit, documentStore, semanticAuthoring, setSelectedIds]);

  const handleDuplicateSelection = useCallback(async () => {
    await handleDuplicateActionIds(selectedIdsList);
  }, [handleDuplicateActionIds, selectedIdsList]);

  const handlePasteAtPlayhead = useCallback(async () => {
    if (blockOfflineEdit()) return;
    if (!semanticAuthoring || editorStore.copyBuffer.length === 0) return;
    const intent = buildSemanticPasteTimelineIntent(
      editorStore.copyBuffer,
      playbackAdapter.getCurrentTime(),
      createSemanticTimelineCorrelationId('timeline_shortcut_paste'),
      'timeline-editor',
    );
    if (!intent) return;
    const receipt = await semanticAuthoring.author(intent);
    const next = selectCompiledActionsForStatements(
      documentStore.getCompiledSceneSnapshot(),
      receipt.createdStatementIds,
    );
    if (Object.keys(next).length > 0) setSelectedIds(next);
  }, [blockOfflineEdit, documentStore, editorStore.copyBuffer, playbackAdapter, semanticAuthoring, setSelectedIds]);

  const performDeleteActionIds = useCallback(async (actionIds: readonly string[]) => {
    if (blockOfflineEdit()) return;
    if (!semanticAuthoring || actionIds.length === 0) return;
    const intents = buildSemanticDeleteTimelineIntents(documentStore, actionIds);
    try {
      if (intents.length > 0) await semanticAuthoring.authorTransaction(intents);
      setSelectedIds({});
    } catch (error) {
      showToast(error instanceof Error ? error.message : '无法删除所选语句', 'warning');
    }
  }, [blockOfflineEdit, documentStore, semanticAuthoring, setSelectedIds]);

  const handleDeleteActionIds = useCallback(async (actionIds: readonly string[]) => {
    await performDeleteActionIds(actionIds);
  }, [performDeleteActionIds]);

  const deleteAction = useCallback(async (id: string) => {
    await handleDeleteActionIds([id]);
  }, [handleDeleteActionIds]);

  const handleDeleteSelection = useCallback(async () => {
    await handleDeleteActionIds(selectedIdsList);
  }, [handleDeleteActionIds, selectedIdsList]);

  useEffect(() => {
    // In split workspaces the tracks instance is the single keyboard authoring owner;
    // avoid registering the same event on the inspector-only instance.
    if (mode === 'inspector') return;
    return eventBus.on('timeline:delete', () => handleDeleteSelection());
  }, [handleDeleteSelection, mode]);

  useEffect(() => {
    // In split workspaces the tracks instance is the single keyboard authoring owner;
    // avoid registering the same event on the inspector-only instance.
    if (mode === 'inspector') return;
    return eventBus.on('timeline:save', () => { void handleSave(); });
  }, [handleSave, mode]);

  const handleSplitSelection = useCallback(async () => {
    if (blockOfflineEdit()) return;
    if (!semanticAuthoring || !singleSelectedAction?._id) return;
    const start = singleSelectedAction.time || 0;
    const end = start + (singleSelectedAction.params.duration || 0);
    const splitTime = playbackAdapter.getCurrentTime();
    if (splitTime <= start || splitTime >= end) {
      showToast('将播放头移动到动作内部后再拆分', 'warning');
      return;
    }
    const intents = buildSemanticSplitTimelineIntents(documentStore, singleSelectedAction._id, splitTime);
    if (intents.length === 0) return;
    const receipt = await semanticAuthoring.authorTransaction(intents);
    const createdStatementIds = receipt.createdStatementIds;
    const createdCompanionLocators = receipt.createdCompanionLocators;
    const compiled = documentStore.getCompiledSceneSnapshot();
    const selectedTail: Record<string, boolean> = {};
    for (const action of compiled?.actions ?? []) {
      if (
        createdStatementIds.includes(action.source.statementId) ||
        createdCompanionLocators.some((locator) =>
          locator.statementId === action.source.statementId && locator.companionId === action.source.companionId)
      ) {
        selectedTail[action.id] = true;
      }
    }
    setSelectedIds(Object.keys(selectedTail).length > 0 ? selectedTail : { [singleSelectedAction._id]: true });
  }, [blockOfflineEdit, documentStore, playbackAdapter, semanticAuthoring, setSelectedIds, singleSelectedAction]);

  const handleAlignSelectionToPlayhead = useCallback(() => {
    if (blockOfflineEdit()) return;
    if (!semanticAuthoring || selectedActions.length === 0) return;
    const playheadTime = Math.max(0, playbackAdapter.getCurrentTime());
    const earliest = Math.min(...selectedActions.map((action) => action.time || 0));
    const delta = playheadTime - earliest;
    authorBatchMove(
      selectedActions
        .filter((action) => !!action._id)
        .map((action) => ({
          id: action._id!,
          time: Math.max(0, parseFloat(((action.time || 0) + delta).toFixed(1))),
        })),
    );
  }, [authorBatchMove, blockOfflineEdit, playbackAdapter, selectedActions, semanticAuthoring]);

  const handleNudgeSelection = useCallback((direction: -1 | 1) => {
    if (selectedActions.length === 0) return;
    authorBatchMove(
      selectedActions
        .filter((action) => !!action._id)
        .map((action) => ({
          id: action._id!,
          time: Math.max(0, parseFloat(((action.time || 0) + direction * 0.1).toFixed(1))),
        })),
    );
  }, [authorBatchMove, selectedActions]);

  const handleTimelineZoomShortcut = useCallback((direction: -1 | 1) => {
    const factor = direction > 0 ? 1.25 : 0.8;
    const nextPixelsPerSecond = Math.max(10, Math.min(1000, Math.round(effectivePixelsPerSecond * factor * 100) / 100));
    if (Math.abs(nextPixelsPerSecond - effectivePixelsPerSecond) < 0.01) return;
    const focusTime = Math.max(0, playbackAdapter.getCurrentTime());
    const nextScrollLeft = Math.max(
      0,
      Math.min(maxTime * nextPixelsPerSecond, Math.round(focusTime * nextPixelsPerSecond - timelineWidth / 2)),
    );
    viewportAnimationRef.current?.cancel();
    viewportAnimationRef.current = null;
    setZoomViewportPreview(null);
    setPixelsPerSecond(nextPixelsPerSecond);
    setScrollLeft(nextScrollLeft);
  }, [effectivePixelsPerSecond, maxTime, playbackAdapter, setPixelsPerSecond, timelineWidth]);

  const handleTimelineWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.altKey) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (delta === 0) return;
    event.preventDefault();
    event.stopPropagation();
    handleTimelineZoomShortcut(delta < 0 ? 1 : -1);
  }, [handleTimelineZoomShortcut]);

  const handleAddMarkerAtPlayhead = useCallback(async () => {
    if (blockOfflineEdit()) return;
    if (!semanticAuthoring || !semanticDocument) return;
    const time = Math.max(0, Math.round(playbackAdapter.getCurrentTime() * 10) / 10);
    await semanticAuthoring.author({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: createSemanticTimelineCorrelationId('timeline_shortcut_marker'),
      origin: 'timeline-editor',
      kind: 'add-marker',
      time,
      label: `标记 ${time.toFixed(1)}s`,
    });
  }, [blockOfflineEdit, playbackAdapter, semanticAuthoring, semanticDocument]);

  const handleChangeSelectionTrack = useCallback((trackId: string) => {
    if (blockOfflineEdit()) return;
    if (!semanticAuthoring || !timelinePresentationScene || selectedIdsList.length === 0 || !trackId.startsWith('char:')) return;
    const charId = trackId.slice('char:'.length);
    const character = timelinePresentationScene.meta.characters?.find((candidate) => candidate.id === charId);
    const intents = buildSemanticRetargetTimelineIntents(
      documentStore,
      selectedIdsList,
      charId,
      character?.name,
    );
    if (intents.length > 0) void semanticAuthoring.authorTransaction(intents);
  }, [blockOfflineEdit, documentStore, selectedIdsList, semanticAuthoring, timelinePresentationScene]);

  const handleTimelineShortcutCommand = useCallback((commandId: ShortcutCommandId) => {
    switch (commandId) {
      case 'timeline.copySelection':
        handleCopySelection();
        return;
      case 'timeline.pasteAtPlayhead':
        void handlePasteAtPlayhead();
        return;
      case 'timeline.duplicateSelection':
        void handleDuplicateSelection();
        return;
      case 'timeline.deleteSelection':
        void handleDeleteSelection();
        return;
      case 'timeline.splitSelection':
        void handleSplitSelection();
        return;
      case 'timeline.alignSelectionToPlayhead':
        handleAlignSelectionToPlayhead();
        return;
      case 'timeline.nudgeSelectionLeft':
        handleNudgeSelection(-1);
        return;
      case 'timeline.nudgeSelectionRight':
        handleNudgeSelection(1);
        return;
      case 'timeline.selectPrevious':
        handleSelectAdjacentAction(-1);
        return;
      case 'timeline.selectNext':
        handleSelectAdjacentAction(1);
        return;
      case 'timeline.zoomIn':
        handleTimelineZoomShortcut(1);
        return;
      case 'timeline.zoomOut':
        handleTimelineZoomShortcut(-1);
        return;
      case 'timeline.addMarker':
        void handleAddMarkerAtPlayhead();
        return;
    }
  }, [
    handleAddMarkerAtPlayhead,
    handleAlignSelectionToPlayhead,
    handleCopySelection,
    handleDeleteSelection,
    handleDuplicateSelection,
    handleNudgeSelection,
    handlePasteAtPlayhead,
    handleSelectAdjacentAction,
    handleSplitSelection,
    handleTimelineZoomShortcut,
  ]);

  useEffect(() => {
    // In split workspaces the tracks instance is the single keyboard authoring owner;
    // avoid registering timeline commands on the inspector-only instance.
    if (mode === 'inspector') return;
    return eventBus.on('shortcut:timeline-command', (payload: unknown) => {
      const commandId = typeof payload === 'object' && payload && 'commandId' in payload
        ? (payload as { commandId?: unknown }).commandId
        : null;
      if (typeof commandId !== 'string') return;
      handleTimelineShortcutCommand(commandId as ShortcutCommandId);
    });
  }, [handleTimelineShortcutCommand, mode]);

  if (!semanticDocument || !timelinePresentationScene) return null;

  return (
    <div
      className="timeline-editor-root"
      data-editor-mode={mode}
      data-timeline-zooming={isZoomSliderInteracting ? 'true' : 'false'}
      data-collaboration-offline={isOfflineEditingBlocked ? 'true' : 'false'}
      style={{ display: 'flex', height: '100%', background: 'var(--timeline-bg)', overflow: 'hidden', position: 'relative' }}
    >
      {isOfflineEditingBlocked && (
        <div className="timeline-collaboration-offline-banner" role="status">
          {offlineEditMessage}
        </div>
      )}
      {/* Track Area */}
      {(mode === 'all' || mode === 'tracks') && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
          <div
            ref={timelineRef}
            onScroll={handleContainerScroll}
            onWheel={handleTimelineWheel}
            className="timeline-editor-scroll-container"
            style={{ flex: 1, overflow: 'auto', position: 'relative', borderRight: '1px solid var(--border-subtle)' }}
          >
            <TrackArea
              tracks={tracks} pps={effectivePixelsPerSecond} maxTime={maxTime}
              selectedIds={selectedActionIds} sceneData={timelinePresentationScene}
              onSelect={handleSelect}
              onDrag={handleDrag}
              onResize={handleResize}
              onCopyActions={handleCopyActionIds}
              onDuplicateActions={handleDuplicateActionIds}
              onDeleteActions={handleDeleteActionIds}
              viewWindow={memoViewWindow}
              onSeek={handleSeek}
              onNavigateRange={handleNavigateRange}
              onBatchDrag={onBatchDrag}
              scrollLeft={chunkedScrollLeft}
              containerWidth={timelineWidth}
              repeatIndexMap={repeatIndexMap}
            />
          </div>
          <TimelineSelectionBar
            selectedCount={selectedIdsList.length}
            action={singleSelectedDisplayAction}
            trackLabel={singleSelectedAction?._id ? trackLabelByActionId.get(singleSelectedAction._id) : undefined}
            trackValue={selectedActionTrackValue}
            trackOptions={quickTrackOptions}
            issueCount={selectedIssueCount}
            hasRepeatWarning={!!(singleSelectedAction?._id && repeatIndexMap.get(singleSelectedAction._id))}
            canSplit={canSplitSelection}
            onSeek={handleSeekToSelection}
            onReveal={handleRevealSelection}
            onClear={() => setSelectedIds({})}
            onCopy={handleCopySelection}
            onDuplicate={handleDuplicateSelection}
            onDelete={handleDeleteSelection}
            onSplit={handleSplitSelection}
            onAlignToPlayhead={handleAlignSelectionToPlayhead}
            onSelectAdjacent={handleSelectAdjacentAction}
            onChangeTrack={handleChangeSelectionTrack}
          />

          {/* Zoom Navigator Bar (Replaces default scrollbar) */}
          <div style={{ background: 'var(--timeline-bg)', borderTop: '1px solid var(--border-subtle)', paddingLeft: '100px' }}>
            <TimelineZoomSlider
              pixelsPerSecond={effectivePixelsPerSecond}
              setPixelsPerSecond={setPixelsPerSecond}
              maxTime={maxTime}
              containerWidth={Math.max(10, timelineWidth - 100)}
              scrollLeft={effectiveScrollLeft}
              setScrollLeft={setScrollLeft}
              onInteractionChange={handleZoomSliderInteractionChange}
              onViewportPreview={handleZoomViewportPreview}
              onViewportCommit={handleZoomViewportCommit}
            />
          </div>
        </div>
      )}

      {/* Inspector Area */}
      {(mode === 'all' || mode === 'inspector') && (
        <div
          className="timeline-editor__inspector-shell"
          style={{ width: mode === 'all' ? '360px' : '100%', minWidth: mode === 'all' ? '360px' : 'auto', height: '100%' }}
        >
          <InspectorArea
            sceneData={timelinePresentationScene}
            selectedActionIds={selectedActionIds} setSelectedIds={setSelectedIds}
            inspectorTab={inspectorTab as any} setInspectorTab={setInspectorTab as any}
            updateAction={updateAction} updateParam={updateParam} replaceSourceParams={replaceSourceParams}
            deleteAction={deleteAction} deleteActions={handleDeleteActionIds} copyActions={handleCopyActionIds}
            addActionAt={addActionAt} addAction={addAction}
            handleSelect={handleSelect} setCurrentTime={(t: number) => playbackAdapter.seek(t)}
            handleSave={handleSave}
            loadExample={loadExample}
            detailOpen={detailOpen}
            detailClosing={detailClosing}
            detailSelectedActionIds={detailSelectedActionIds}
            onDetailOpen={openDetail}
            onDetailClose={closeDetail}
            layoutMode={inspectorLayout}
            navigatorWidth={inspectorNavigatorWidth}
            detailWidth={inspectorDetailWidth}
            onDetailResizeStart={onInspectorDetailResizeStart}
            onDetailResizeKeyDown={onInspectorDetailResizeKeyDown}
            workspaceIssues={validationIssues}
            inspectorView={inspectorView}
            onSelectInspectorView={onSelectInspectorView}
            onDetachWorkspaceTools={onDetachWorkspaceTools}
            canDetachWorkspaceTools={canDetachWorkspaceTools}
          />
        </div>
      )}
    </div>
  );
}

export default TimelineEditor;
