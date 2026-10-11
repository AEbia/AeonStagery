import React, { useRef, useMemo, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { eventBus } from '../../api/events';
import { Ruler } from './Ruler';
import {
  TrackRow,
  TrackBlock,
  TrackSummaryBlock,
  TrackAnchorPin,
  TrackSummaryTooltip,
  LifecyclePairRelationshipRail,
  CompanionRelationshipRail,
  isPlaceholderTimelineAction,
  type SummaryTooltipPayload,
} from './TrackComponents';
import {
  useApp,
  useDocumentStore,
  useEditorStore,
  usePlaybackAdapter,
  useSemanticAuthoringService,
  useTemplatePackageCatalog,
  useCollaborationStatus,
  useCollaborationPresence,
  useCollaborationPresencePublisher,
  useCharacterAdapter,
} from '../context/AppContext';
import { useValidationIssues, useCustomMotionEditorActionId } from '../store/storeHooks';

import { computePresentationFootprintLanes } from './laneUtils';
import { resolveLifecyclePairRelationshipLaneIndices } from './lifecyclePairRelationshipGeometry';
import { Playhead } from './Playhead';
import { useMarqueeSelection, type BlockGeometry } from './useMarqueeSelection';
import { useTimelineDrop } from './useTimelineDrop';
import { useMarkerManager } from './useMarkerManager';
import { useBlankContextMenu } from './useBlankContextMenu';
import { useBlockDrag } from './useBlockDrag';
import { useBlockResize } from './useBlockResize';
import { useBatchDrag } from './useBatchDrag';
import { useBlockContextMenu } from './useBlockContextMenu';
import type { TimelineInteractionFeedbackPayload } from './timelineInteractionFeedback';
import { formatFeedbackSeconds, formatTimelineFeedbackLabel } from './timelineInteractionFeedback';
import { useSemanticTimelineSnapshot, type SemanticTimelineSnapshot } from './useSemanticTimelineSnapshot';
import { useSemanticTimelineCommands } from './useSemanticTimelineCommands';

import { MarqueeOverlay } from './MarqueeOverlay';
import { BlankContextMenu } from './BlankContextMenu';
import { BlockContextMenu } from './BlockContextMenu';
import { MarkerPrompt } from './MarkerPrompt';
import { CustomMotionConversionDialog, type CustomMotionConversionDialogState } from './CustomMotionConversionDialog';
import { CustomMotionEditor } from './CustomMotionEditor';
import type { CustomMotionKeyframeEdit } from '../../services/timeline-authoring/customMotionKeyframeEdits';
import {
  CustomMotionAuthoring,
  describeCustomMotionAuthoringError,
} from './CustomMotionAuthoring';
import {
  locatorToLeaseTarget,
  type CustomMotionLeaseState,
} from '../../services/timeline-authoring/CustomMotionEditLeaseGate';
import { showToast } from '../Toast';
import {
  estimateCustomMotionKeyframes,
  type CustomMotionDensity,
} from '../../engine/live2d/customMotionConversion';
import { resolveCubism2MotionMeta } from '../../engine/live2d/cubism2MotionSampler';
import {
  buildSummarySegmentsFromBuckets,
  buildTimeBucketIndex,
  buildTrackActionIndex,
  calculateNextLOD,
  getPlayheadSpotlightRange,
  isActionInView,
  pickTimeBucketSeconds,
  PLAYHEAD_SPOTLIGHT_BUCKET_SECONDS,
  queryVisibleBuckets,
  queryVisibleTrackActions,
  quantizeTimeToBucket,
  getTimelineActionDuration,
  type TrackActionItem,
  type TrackLodMode,
} from './timelineDensity';
import { getEnvironmentTrackKind } from './environmentPresentation';
import type { AuthoringScope } from '../../api/types/authoring';
import {
  buildTemplateAuthoringPreview,
} from '../../services/template-package';
import {
  createSemanticTimelineCorrelationId,
  locatorForCompiledTimelineAction,
} from './semanticTimelineEditing';
import {
  listAvailableLifecycleEndCommandIds,
} from './insertLifecycleEndCommand';
import {
  listAvailableLifecycleTargetBindingCommandIds,
} from './lifecycleTargetBinding';
import {
  buildLifecyclePairTable,
  resolveLifecyclePair,
} from './lifecyclePairing';
import {
  formatPresencePlayheadTime,
  getPeersEditingLocator,
  summarizeLocatorEditingPeers,
} from '../../services/collaboration/CollaborationPresence';
import { deriveCollaborationStatusUx } from '../../services/collaboration/CollaborationStatusUxModel';
import {
  projectTimelinePointerPresence,
  shouldPublishTimelinePointer,
} from '../../services/timeline-interaction/TimelinePresenceProjector';
import type { TimelineAction, TimelineScene } from './semanticTimelineTypes';
import {
  getLifecycleBoundaryFootprintRange,
  getLifecycleBoundaryPresentationMetrics,
} from './lifecycleBoundaryPresentation';
import type { CharacterMotionOutput, SceneStatement } from '../../api/types/semantic-scene';
import {
  buildSemanticStatementLibraryInsert,
  submitSemanticStatementLibraryInsert,
} from './semanticStatementInsertion';

interface TrackAreaProps {
  semanticSnapshot?: SemanticTimelineSnapshot;
  tracks: Array<{ id: string; label: string; actions: TrackActionItem[] }>;
  pps: number;
  maxTime: number;
  selectedIds: Record<string, boolean>;
  onSelect: (idOrIds: string | string[], isMulti?: boolean) => void;
  // Handlers may return the authoring promise so interactions can keep
  // their transient overlay pinned until the async commit settles.
  onDrag: (id: string, time: number, updates?: Array<{ id: string; time: number }>) => void | Promise<unknown>;
  onResize: (id: string, duration: number) => void | Promise<unknown>;
  onSeek: (time: number, isFinal?: boolean) => void;
  sceneData: TimelineScene;
  scrollLeft: number;
  containerWidth: number;
  repeatIndexMap?: Map<string, string>;
  onBatchDrag: (updates: Array<{ id: string; time: number }>) => void | Promise<unknown>;
  onCopyActions?: (ids: readonly string[]) => void;
  onDuplicateActions?: (ids: readonly string[]) => void | Promise<void>;
  onDeleteActions?: (ids: readonly string[]) => void | Promise<void>;
  viewWindow?: { start: number; end: number };
  onNavigateRange: (range: { start: number; end: number }) => void;
}

export const TrackArea = React.memo(({
  semanticSnapshot: providedSemanticSnapshot,
  tracks,
  pps,
  maxTime,
  selectedIds,
  onSelect,
  onDrag,
  onResize,
  onSeek,
  sceneData,
  scrollLeft,
  containerWidth,
  repeatIndexMap,
  onBatchDrag,
  onCopyActions,
  onDuplicateActions,
  onDeleteActions,
  viewWindow,
  onNavigateRange,
}: TrackAreaProps) => {
  const areaRef = useRef<HTMLDivElement>(null);
  const marqueeRef = useRef<HTMLDivElement>(null);

  const documentStore = useDocumentStore();
  const semanticSnapshot = useSemanticTimelineSnapshot(providedSemanticSnapshot);
  const { items: semanticTimelineItems, itemById: semanticTimelineItemById } = semanticSnapshot;
  const selectAfterCommit = useCallback((ids: Record<string, boolean>) => onSelect(Object.keys(ids), false), [onSelect]);
  const commands = useSemanticTimelineCommands(selectAfterCommit);
  const editorStore = useEditorStore();
  const writableEditorStore = useApp().stores.editor;
  const playbackAdapter = usePlaybackAdapter();
  const semanticAuthoring = useSemanticAuthoringService();
  const customMotionEditLeaseGate = useApp().collaboration?.customMotionEditLeaseGate ?? undefined;
  const characterAdapter = useCharacterAdapter();
  const collaborationStatus = useCollaborationStatus();
  const [conversionDialog, setConversionDialog] = useState<CustomMotionConversionDialogState | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const conversionLocatorRef = useRef<{ kind: 'statement' | 'companion'; statementId: string; companionId?: string } | null>(null);
  const customMotionAuthoring = React.useMemo(() => {
    if (!semanticAuthoring) return null;
    return new CustomMotionAuthoring({
      authoring: semanticAuthoring,
      samplerTargets: (characterId) => characterAdapter.getCubism2SamplerTargets?.(characterId) ?? [],
      leaseGate: customMotionEditLeaseGate,
      origin: 'block-context-menu',
    });
  }, [semanticAuthoring, characterAdapter, customMotionEditLeaseGate]);
  const expandedCustomMotionActionId = useCustomMotionEditorActionId();
  const templateCatalog = useTemplatePackageCatalog();
  const templatePackageSnapshot = React.useSyncExternalStore(
    templateCatalog ? (listener) => templateCatalog.subscribe(listener) : () => () => {},
    templateCatalog ? () => templateCatalog.getPackages() : getStableEmptyPackages,
    getStableEmptyPackages,
  );
  const { peers: collaborationPeers } = useCollaborationPresence();
  const publishCollaborationPresence = useCollaborationPresencePublisher();
  const { issues: validationIssues } = useValidationIssues();
  const availableTemplates = useMemo(
    () => {
      // The external-store snapshot invalidates this memo when packages change;
      // the catalog remains the source of truth for combo derivation.
      void templatePackageSnapshot;
      return templateCatalog?.getSemanticAuthoringCombos() ?? [];
    },
    [templateCatalog, templatePackageSnapshot],
  );

  const firstCharacterEntranceTime = useMemo(() => {
    const entrance = sceneData?.timeline?.find((action) => (
      action.semanticType === 'characterPresence'
      && (action.sourceParams?.mode === 'enter' || action.params?.mode === 'enter')
      && typeof action.time === 'number'
    ));
    return typeof entrance?.time === 'number' ? entrance.time : null;
  }, [sceneData]);

  const blockRefs = useRef<Map<string, HTMLElement>>(new Map());
  const trackRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const prevTrackActionCountsRef = useRef<Record<string, number>>({});
  const lastPointerPresenceRef = useRef<{ time: number; trackId?: string; sentAt: number } | null>(null);

  const registerBlock = useCallback((id: string, el: HTMLElement | null) => {
    if (el) blockRefs.current.set(id, el);
    else blockRefs.current.delete(id);
  }, []);

  const registerTrack = useCallback((trackId: string, el: HTMLDivElement | null) => {
    if (el) trackRefs.current.set(trackId, el);
    else trackRefs.current.delete(trackId);
  }, []);

  useEffect(() => {
    const blockRefsSnapshot = blockRefs.current;
    const trackRefsSnapshot = trackRefs.current;
    return () => {
      blockRefsSnapshot.clear();
      trackRefsSnapshot.clear();
    };
  }, []);

  const [transientStates, setTransientStates] = useState<Record<string, {
    time?: number;
    duration?: number;
  }>>({});
  const [hoveredLifecycleActionId, setHoveredLifecycleActionId] = useState<string>();
  const [trackLodModes, setTrackLodModes] = useState<Record<string, TrackLodMode>>({});
  const [summaryTooltip, setSummaryTooltip] = useState<SummaryTooltipPayload | null>(null);
  const [interactionFeedback, setInteractionFeedback] = useState<TimelineInteractionFeedbackPayload | null>(null);
  const playheadTimeRef = useRef(playbackAdapter.getCurrentTime());
  const [spotlightBucketTime, setSpotlightBucketTime] = useState(() =>
    quantizeTimeToBucket(playbackAdapter.getCurrentTime(), PLAYHEAD_SPOTLIGHT_BUCKET_SECONDS),
  );

  useEffect(() => playbackAdapter.subscribeTime((time: number) => {
    if (Number.isFinite(time)) playheadTimeRef.current = time;
    const quantized = quantizeTimeToBucket(time, PLAYHEAD_SPOTLIGHT_BUCKET_SECONDS);
    setSpotlightBucketTime((previous) => previous === quantized ? previous : quantized);
  }), [playbackAdapter]);

  useEffect(() => (
    eventBus.on('timeline:interaction-feedback', (payload: unknown) => {
      setInteractionFeedback((payload || null) as TimelineInteractionFeedbackPayload | null);
    })
  ), []);

  const validationSeverityByActionId = useMemo(() => {
    const severities = new Map<string, 'error' | 'warning'>();
    for (const issue of validationIssues) {
      if (!issue.actionId) continue;
      const existing = severities.get(issue.actionId);
      if (existing === 'error') continue;
      severities.set(issue.actionId, issue.severity);
    }
    return severities;
  }, [validationIssues]);

  const validationActionIds = useMemo(() => new Set(validationSeverityByActionId.keys()), [validationSeverityByActionId]);

  const collaborationEditingByActionId = useMemo(() => {
    const map = new Map<string, { summary: string; peerCount: number }>();
    for (const track of tracks) {
      for (const { id } of track.actions) {
        const presenceLocator = locatorForCompiledTimelineAction(documentStore, id);
        const summary = presenceLocator
          ? summarizeLocatorEditingPeers(collaborationPeers, presenceLocator)
          : null;
        if (!summary) continue;
        map.set(id, {
          summary,
          peerCount: getPeersEditingLocator(collaborationPeers, presenceLocator!).length,
        });
      }
    }
    return map;
  }, [collaborationPeers, documentStore, tracks]);

  const collaborationPlayheadPeers = useMemo(() => (
    collaborationPeers.filter((peer) => (
      typeof peer.playheadTime === 'number' &&
      Number.isFinite(peer.playheadTime) &&
      peer.playheadTime >= 0
    ))
  ), [collaborationPeers]);

  const collaborationPointerPeers = useMemo(() => (
    collaborationPeers.filter((peer) => (
      peer.pointer?.surface === 'timeline' &&
      typeof peer.pointer.time === 'number' &&
      Number.isFinite(peer.pointer.time) &&
      peer.pointer.time >= 0
    ))
  ), [collaborationPeers]);

  const actionTrackMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const track of tracks) {
      for (const { id } of track.actions) {
        map.set(id, track.id);
      }
    }
    return map;
  }, [tracks]);

  const actionById = useMemo(() => {
    const map = new Map<string, TimelineAction>();
    for (const track of tracks) {
      for (const { action, id } of track.actions) map.set(id, action);
    }
    return map;
  }, [tracks]);

  // 关键帧编辑器展开带目标：仅当该动作仍存在且仍为自定义动作时才展开
  const customMotionEditorTarget = useMemo(() => {
    if (!expandedCustomMotionActionId) return null;
    const action = actionById.get(expandedCustomMotionActionId);
    const trackId = actionTrackMap.get(expandedCustomMotionActionId);
    if (!action || !trackId) return null;
    const motion = (action.params as Record<string, unknown> | undefined)?.motion;
    if (!motion || typeof motion !== 'object' || (motion as { kind?: unknown }).kind !== 'custom') return null;
    return {
      trackId,
      actionId: expandedCustomMotionActionId,
      sceneId: sceneData.sceneId,
      blockTime: transientStates[expandedCustomMotionActionId]?.time ?? action.time ?? 0,
      characterId: String((action.params as Record<string, unknown> | undefined)?.target ?? ''),
      motion: motion as Extract<CharacterMotionOutput, { kind: 'custom' }>,
    };
  }, [actionById, actionTrackMap, expandedCustomMotionActionId, transientStates, sceneData.sceneId]);

  const customMotionEditorLocator = useMemo(() => (
    customMotionEditorTarget
      ? locatorForCompiledTimelineAction(documentStore, customMotionEditorTarget.actionId)
      : null
  ), [customMotionEditorTarget, documentStore]);
  const customMotionLeaseTarget = useMemo(
    () => customMotionEditorLocator ? locatorToLeaseTarget(customMotionEditorLocator) : null,
    [customMotionEditorLocator],
  );
  const getCustomMotionLeaseState = useCallback((): CustomMotionLeaseState => (
    customMotionLeaseTarget && customMotionEditLeaseGate?.getState
      ? customMotionEditLeaseGate.getState(customMotionLeaseTarget)
      : 'unavailable'
  ), [customMotionEditLeaseGate, customMotionLeaseTarget]);
  // useSyncExternalStore 以普通函数回调方式调用 subscribe，类方法直接传递会
  // 丢失 this 绑定（this.listeners 未定义而崩溃）；用闭包显式绑定并保持引用稳定。
  const customMotionLeaseSubscribe = useCallback(
    (listener: () => void) => customMotionEditLeaseGate?.subscribe?.(listener) ?? (() => {}),
    [customMotionEditLeaseGate],
  );
  const customMotionLeaseState = useSyncExternalStore<CustomMotionLeaseState>(
    customMotionLeaseSubscribe,
    getCustomMotionLeaseState,
    () => 'unavailable' as const,
  );

  // 目标动作被删除或不再是自定义动作时，自动收起展开带
  useEffect(() => {
    if (expandedCustomMotionActionId && !customMotionEditorTarget) {
      writableEditorStore.setCustomMotionEditorActionId(null);
    }
  }, [expandedCustomMotionActionId, customMotionEditorTarget, writableEditorStore]);

  const handleCustomMotionEditorCommit = useCallback(async (edits: readonly CustomMotionKeyframeEdit[], expectedMotion?: Extract<CharacterMotionOutput, { kind: 'custom' }>) => {
    if (!customMotionAuthoring || !customMotionEditorTarget) throw new Error('自定义动作已关闭');
    const locator = locatorForCompiledTimelineAction(documentStore, customMotionEditorTarget.actionId);
    if (!locator) throw new Error('自定义动作已不存在');
    try {
      await customMotionAuthoring.commitEdits(locator, edits, undefined, expectedMotion, customMotionEditorTarget.sceneId, sceneData.meta.fps ?? 60);
    } catch (error) {
      throw new Error(describeCustomMotionAuthoringError(error));
    }
  }, [customMotionAuthoring, customMotionEditorTarget, documentStore, sceneData.meta.fps]);

  const selectedTrackIds = useMemo(() => {
    const ids = new Set<string>();
    for (const actionId of Object.keys(selectedIds)) {
      if (!selectedIds[actionId]) continue;
      const trackId = actionTrackMap.get(actionId);
      if (trackId) ids.add(trackId);
    }
    return ids;
  }, [actionTrackMap, selectedIds]);

  const trackActionIndexes = useMemo(() => {
    const indexes: Record<string, ReturnType<typeof buildTrackActionIndex>> = {};
    for (const track of tracks) {
      indexes[track.id] = buildTrackActionIndex(track.actions);
    }
    return indexes;
  }, [tracks]);

  const visibleTrackActions = useMemo(() => {
    const visible: Record<string, TrackActionItem[]> = {};
    for (const track of tracks) {
      visible[track.id] = queryVisibleTrackActions(trackActionIndexes[track.id], viewWindow, 1);
    }
    return visible;
  }, [tracks, trackActionIndexes, viewWindow]);

  const visibleTrackCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const track of tracks) {
      counts[track.id] = visibleTrackActions[track.id]?.length ?? 0;
    }
    return counts;
  }, [tracks, visibleTrackActions]);

  useEffect(() => {
    setTrackLodModes((currentModes) => {
      const nextModes: Record<string, TrackLodMode> = {};
      let changed = false;

      for (const track of tracks) {
        const currentMode = currentModes[track.id] ?? 'detail';
        const visibleActionCount = visibleTrackCounts[track.id] ?? 0;
        const currentTrackActionCount = track.actions.length;
        const previousTrackActionCount = prevTrackActionCountsRef.current[track.id];
        const reason = previousTrackActionCount === undefined
          ? 'init'
          : previousTrackActionCount !== currentTrackActionCount
            ? 'data'
            : 'zoom';

        const nextMode = calculateNextLOD(currentMode, visibleActionCount, pps, reason);
        nextModes[track.id] = nextMode;
        if (nextMode !== currentMode) {
          changed = true;
        }
      }

      return changed ? nextModes : currentModes;
    });

    const nextTrackActionCounts: Record<string, number> = {};
    for (const track of tracks) {
      nextTrackActionCounts[track.id] = track.actions.length;
    }
    prevTrackActionCountsRef.current = nextTrackActionCounts;
  }, [tracks, visibleTrackCounts, pps]);

  const summaryBucketSeconds = useMemo(() => pickTimeBucketSeconds(pps), [pps]);

  const trackBucketIndexes = useMemo(() => {
    const indexes: Record<string, ReturnType<typeof buildTimeBucketIndex>> = {};
    for (const track of tracks) {
      indexes[track.id] = buildTimeBucketIndex(track.actions, summaryBucketSeconds);
    }
    return indexes;
  }, [tracks, summaryBucketSeconds]);

  const getSnapTargets = useCallback((id: string, excludeIds: Record<string, boolean> = {}) => {
    const trackId = actionTrackMap.get(id);
    if (!trackId) return [];
    const index = trackActionIndexes[trackId];
    if (!index) return [];
    const targets: number[] = [];
    for (const item of index.items) {
      if (item.id === id || excludeIds[item.id]) continue;
      targets.push(item.start, item.end);
    }
    return targets;
  }, [actionTrackMap, trackActionIndexes]);

  const trackAnchorIds = useMemo(() => {
    const anchorMap: Record<string, Set<string>> = {};

    for (const track of tracks) {
      const anchors = new Set<string>();
      for (const { id } of visibleTrackActions[track.id] ?? []) {
        if (selectedIds[id] || collaborationEditingByActionId.has(id)) {
          anchors.add(id);
        }
      }
      anchorMap[track.id] = anchors;
    }

    return anchorMap;
  }, [tracks, visibleTrackActions, selectedIds, collaborationEditingByActionId]);

  const { laneMap, laneCounts } = useMemo(() => {
    const map: Record<string, number> = {};
    const counts: Record<string, number> = {};

    for (const track of tracks) {
      if (trackLodModes[track.id] === 'summary') {
        counts[track.id] = 1;
        for (const id of Object.keys(selectedIds)) {
          if (selectedIds[id]) map[id] = 0;
        }
        continue;
      }

      const blocksInfo = track.actions.map(({ action, id }) => {
        const transient = transientStates[id];
        const time = transient?.time !== undefined ? transient.time : (action.time || 0);
        const authoringParams = action.sourceParams ?? action.params;
        const duration = transient?.duration !== undefined
          ? transient.duration
          : getTimelineActionDuration(action);
        if (action.semanticType) {
          const metrics = getLifecycleBoundaryPresentationMetrics(
            {
              type: action.semanticType,
              params: {
                ...authoringParams,
                ...(transient?.duration !== undefined ? { durationSeconds: transient.duration } : {}),
              } as SceneStatement['params'],
            },
            pps,
          );
          if (metrics.isLifecycleBoundary) {
            return {
              id,
              ranges: [getLifecycleBoundaryFootprintRange(time, metrics, pps)],
            };
          }
        }
        return {
          id,
          ranges: [{
            start: time,
            end: time + Math.max(duration, 4 / pps),
          }],
        };
      });

      const assignments = computePresentationFootprintLanes(blocksInfo);
      let maxLane = 0;
      for (const item of assignments) {
        map[item.id] = item.laneIndex;
        if (item.laneIndex > maxLane) maxLane = item.laneIndex;
      }
      counts[track.id] = track.actions.length > 0 ? maxLane + 1 : 1;
    }

    return { laneMap: map, laneCounts: counts };
  }, [tracks, transientStates, pps, selectedIds, trackLodModes]);

  const trackPointerRows = useMemo(() => {
    const rows = new Map<string, { top: number; height: number }>();
    let top = 40;
    for (const track of tracks) {
      const laneCount = Math.max(1, laneCounts[track.id] ?? 1);
      const height = laneCount * 32 + 8;
      rows.set(track.id, { top, height });
      top += height;
    }
    return rows;
  }, [laneCounts, tracks]);

  const companionRelationshipItems = useMemo(() => {
    const relationships: Array<{
      companionId: string;
      parentId: string;
      companionTime: number;
      parentTime: number;
      companionAction: TimelineAction;
      active: boolean;
    }> = [];
    for (const item of semanticTimelineItems) {
      if (!item.companionId || !item.parentItemId) continue;
      const parentItem = semanticTimelineItemById.get(item.parentItemId);
      const companionAction = actionById.get(item.id);
      const parentAction = actionById.get(item.parentItemId);
      if (!parentItem || !companionAction || !parentAction) continue;
      const active = !!selectedIds[item.id]
        || !!selectedIds[item.parentItemId]
        || hoveredLifecycleActionId === item.id
        || hoveredLifecycleActionId === item.parentItemId;
      relationships.push({
        companionId: item.id,
        parentId: item.parentItemId,
        companionTime: transientStates[item.id]?.time ?? item.time,
        parentTime: transientStates[item.parentItemId]?.time ?? parentItem.time,
        companionAction,
        active,
      });
    }
    return relationships;
  }, [actionById, hoveredLifecycleActionId, semanticTimelineItemById, semanticTimelineItems, selectedIds, transientStates]);

  const companionRelatedActionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const relationship of companionRelationshipItems) {
      if (!relationship.active) continue;
      ids.add(relationship.companionId);
      ids.add(relationship.parentId);
    }
    return ids;
  }, [companionRelationshipItems]);

  const relationshipLabelByActionId = useMemo(() => {
    const labels = new Map<string, string>();
    const companionCountByParent = new Map<string, number>();
    for (const item of semanticTimelineItems) {
      if (!item.companionId || !item.parentItemId) continue;
      companionCountByParent.set(
        item.parentItemId,
        (companionCountByParent.get(item.parentItemId) ?? 0) + 1,
      );
      const anchorLabel = item.companionAnchor === 'end' ? '对白结束' : '对白开始';
      const offset = item.companionOffsetSeconds ?? 0;
      const offsetLabel = Math.abs(offset) < 0.0001
        ? ''
        : ` ${Math.abs(offset).toFixed(1)} 秒${offset < 0 ? '前' : '后'}`;
      labels.set(
        item.id,
        `伴随语句 · ${anchorLabel}${offsetLabel}`,
      );
    }
    for (const [parentId, count] of companionCountByParent) {
      labels.set(parentId, `对白 · 包含 ${count} 条伴随语句`);
    }
    return labels;
  }, [semanticTimelineItems]);

  const trackRenderState = useMemo(() => {
    const state: Record<string, {
      mode: TrackLodMode;
      blocks: TrackActionItem[];
      summarySegments: ReturnType<typeof buildSummarySegmentsFromBuckets>;
      anchorActions: TrackActionItem[];
    }> = {};

    for (const track of tracks) {
      const visibleActions = visibleTrackActions[track.id] ?? [];
      const mode = trackLodModes[track.id] ?? 'detail';

      if (mode === 'summary') {
        const anchorIds = trackAnchorIds[track.id] ?? new Set<string>();
        const buckets = queryVisibleBuckets(trackBucketIndexes[track.id], viewWindow, 1);
        state[track.id] = {
          mode,
          blocks: [],
          summarySegments: buildSummarySegmentsFromBuckets(buckets, {
            anchorIds,
            getValidationSeverity: (id) => validationSeverityByActionId.get(id) ?? null,
            hasRepeatWarning: (id) => !!repeatIndexMap?.get(id),
          }),
          anchorActions: visibleActions.filter(({ id }) => anchorIds.has(id)),
        };
        continue;
      }

      state[track.id] = {
        mode,
        blocks: visibleActions.filter(({ action, id }) => {
          if (selectedIds[id]) return true;
          return isActionInView(action, viewWindow, 1);
        }),
        summarySegments: [],
        anchorActions: [],
      };
    }

    return state;
  }, [
    tracks,
    visibleTrackActions,
    trackLodModes,
    trackAnchorIds,
    trackBucketIndexes,
    viewWindow,
    selectedIds,
    validationSeverityByActionId,
    repeatIndexMap,
  ]);

  const getBlockGeometries = useCallback((): BlockGeometry[] => {
    const geometries: BlockGeometry[] = [];
    let rowTop = 40;

    for (const track of tracks) {
      const laneCount = Math.max(1, laneCounts[track.id] ?? 1);
      const rowHeight = laneCount * 32 + 8;
      const renderState = trackRenderState[track.id];

      if (renderState) {
        for (const { action, id } of renderState.blocks) {
          const start = action.time || 0;
          const authoringParams = action.sourceParams ?? action.params;
          const duration = getTimelineActionDuration(action);
          let width = Math.max(4, duration * pps);
          if (action.semanticType) {
            const metrics = getLifecycleBoundaryPresentationMetrics(
              {
                type: action.semanticType,
                params: authoringParams as SceneStatement['params'],
              },
              pps,
            );
            if (metrics.isLifecycleBoundary) {
              width = metrics.visualWidthPx;
            }
          }
          const x1 = 100 + start * pps;
          const y1 = rowTop + (laneMap[id] ?? 0) * 32 + 4;
          geometries.push({
            id,
            x1,
            y1,
            x2: x1 + width,
            y2: y1 + 24,
          });
        }
      }

      rowTop += rowHeight;
    }

    return geometries;
  }, [tracks, laneCounts, trackRenderState, laneMap, pps]);

  const { handlePointerDown: handleMarqueeDown } = useMarqueeSelection({
    areaRef,
    marqueeRef,
    getBlockGeometries,
    onSelect,
  });

  const {
    handleDragOver,
    handleDrop,
  } = useTimelineDrop({
    areaRef,
    trackRefs,
    sceneData,
    pps,
  });

  const {
    markerPrompt,
    handleAddMarker,
    completeAddMarker,
    handleRemoveMarker,
    setMarkerPrompt,
  } = useMarkerManager(documentStore);

  const {
    blankMenu,
    setBlankMenu,
    handleContextMenu: handleBlankContextMenu,
  } = useBlankContextMenu({
    areaRef,
    trackRefs,
    pps,
  });
  const blockOfflineAuthoring = useCallback(() => {
    const offlineEditMessage = deriveCollaborationStatusUx({ status: collaborationStatus }).offlineEditMessage;
    if (!offlineEditMessage) return false;
    showToast(offlineEditMessage, 'warning');
    setBlankMenu(null);
    return true;
  }, [collaborationStatus, setBlankMenu]);
  const preferredLifecycleStartStatementIds = useMemo(() => new Set(
    (documentStore.getCompiledSceneSnapshot()?.actions ?? [])
      .filter((action) => !!selectedIds[action.id] && !action.source.companionId)
      .map((action) => action.source.statementId),
  ), [documentStore, selectedIds]);
  const lifecyclePairTable = useMemo(() => {
    // sceneData invalidates this memo when the timeline projection changes;
    // the document store remains the canonical pairing source.
    void sceneData;
    const document = documentStore.getCurrentSceneDocumentSnapshot();
    return buildLifecyclePairTable(document);
  }, [documentStore, sceneData]);
  const statementIdByActionId = useMemo(() => {
    const map = new Map<string, string>();
    for (const action of documentStore.getCompiledSceneSnapshot()?.actions ?? []) {
      if (!action.source.companionId) map.set(action.id, action.source.statementId);
    }
    // Fallback for uncompiled display actions that use statement id as action id.
    for (const track of tracks) {
      for (const { action, id } of track.actions) {
        if (!map.has(id) && action.semanticType) map.set(id, id);
      }
    }
    return map;
  }, [documentStore, tracks]);
  const actionIdByStatementId = useMemo(() => {
    const map = new Map<string, string>();
    for (const [actionId, statementId] of statementIdByActionId) {
      if (!map.has(statementId)) map.set(statementId, actionId);
    }
    return map;
  }, [statementIdByActionId]);
  const activePairPeerActionIds = useMemo(() => {
    const peers = new Set<string>();
    const focusIds = new Set([
      ...Object.keys(selectedIds).filter((id) => selectedIds[id]),
      ...(hoveredLifecycleActionId ? [hoveredLifecycleActionId] : []),
    ]);
    for (const actionId of focusIds) {
      const statementId = statementIdByActionId.get(actionId);
      if (!statementId) continue;
      const record = resolveLifecyclePair(lifecyclePairTable, statementId);
      if (record?.status !== 'paired' || !record.peerId) continue;
      const peerActionId = actionIdByStatementId.get(record.peerId);
      if (peerActionId) peers.add(peerActionId);
    }
    return peers;
  }, [actionIdByStatementId, hoveredLifecycleActionId, lifecyclePairTable, selectedIds, statementIdByActionId]);
  const availableLifecycleEndCommandIds = useMemo(() => {
    const document = documentStore.getCurrentSceneDocumentSnapshot();
    if (!blankMenu || !document) return new Set<string>();
    return listAvailableLifecycleEndCommandIds(
      document,
      blankMenu.time,
      { sceneMeta: sceneData.meta, charId: blankMenu.charId },
      preferredLifecycleStartStatementIds,
    );
  }, [blankMenu, documentStore, preferredLifecycleStartStatementIds, sceneData.meta]);
  const availableLifecycleTargetBindingCommandIds = useMemo(() => {
    const document = documentStore.getCurrentSceneDocumentSnapshot();
    if (!blankMenu || !document) return new Set<string>();
    return listAvailableLifecycleTargetBindingCommandIds(
      document,
      blankMenu.time,
      { sceneMeta: sceneData.meta, charId: blankMenu.charId },
      preferredLifecycleStartStatementIds,
    );
  }, [blankMenu, documentStore, preferredLifecycleStartStatementIds, sceneData.meta]);

  const { handlePointerDown: handleBlockDrag } = useBlockDrag({
    blockRefs,
    pps,
    onDrag,
    setTransientStates,
    getSnapTargets,
    getDragGroup: (id, initialTime) => {
      const item = semanticTimelineItemById.get(id);
      if (!item || item.locator.kind !== 'statement') return [{ id, initialTime }];
      return [
        { id, initialTime },
        ...semanticTimelineItems
          .filter((candidate) => candidate.parentItemId === id)
          .map((candidate) => ({ id: candidate.id, initialTime: candidate.time })),
      ];
    },
  });

  const { handlePointerDown: handleBlockResize } = useBlockResize({
    blockRefs,
    pps,
    onResize,
    setTransientStates,
    getSnapTargets,
    getRelatedResizeStates: (id, initialTime, duration) => {
      const item = semanticTimelineItemById.get(id);
      if (!item || item.locator.kind !== 'statement') return {};
      const related: Record<string, { time: number }> = {};
      for (const companion of semanticTimelineItems) {
        if (companion.parentItemId !== id) continue;
        const baseTime = companion.companionAnchor === 'end'
          ? initialTime + duration
          : initialTime;
        related[companion.id] = {
          time: Math.max(0, Number((baseTime + (companion.companionOffsetSeconds ?? 0)).toFixed(1))),
        };
      }
      return related;
    },
  });

  const handleTrackResizeNudge = useCallback((id: string, deltaSeconds: number) => {
    const action = actionById.get(id);
    if (!action || isPlaceholderTimelineAction(action)) return;
    const authoringParams = action.sourceParams ?? action.params;
    if (action.semanticType) {
      const metrics = getLifecycleBoundaryPresentationMetrics(
        {
          type: action.semanticType,
          params: authoringParams as SceneStatement['params'],
        },
        pps,
      );
      if (metrics.isLifecycleBoundary) {
        if (!metrics.canResizeTransition) return;
        const currentDuration = metrics.semanticDurationSeconds;
        const nextDuration = Math.max(0, Math.min(Math.max(100, currentDuration), currentDuration + deltaSeconds));
        if (Math.abs(nextDuration - currentDuration) <= 0.0001) return;
        onResize(id, Number(nextDuration.toFixed(1)));
        return;
      }
    }
    const currentDuration = getTimelineActionDuration(action);
    const nextDuration = Math.max(0.1, Math.min(Math.max(100, currentDuration), currentDuration + deltaSeconds));
    if (nextDuration === currentDuration) return;
    onResize(id, Number(nextDuration.toFixed(1)));
  }, [actionById, onResize, pps]);

  const { handlePointerDown: handleBatchDrag } = useBatchDrag({
    blockRefs,
    selectedIds,
    pps,
    onBatchDrag,
    setTransientStates,
    getSnapTargets,
  });

  const handleAnchorDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>, id: string) => {
    const selectedIdsList = Object.keys(selectedIds).filter((key) => selectedIds[key]);
    if (selectedIdsList.length > 1 && selectedIds[id]) {
      handleBatchDrag(event, id);
      return;
    }
    handleBlockDrag(event, id);
  }, [handleBatchDrag, handleBlockDrag, selectedIds]);

  const buildMotionMenuActions = React.useCallback((id: string): Array<{ label: string; danger?: boolean; run: () => void | Promise<void> }> => {
    const targetAction = actionById.get(id);
    const params = targetAction?.sourceParams ?? targetAction?.params;
    const motion = params?.motion;
    if (!motion || typeof motion !== 'object') return [];
    const kind = (motion as { kind?: unknown }).kind;
    const semanticItem = semanticTimelineItemById.get(id);
    const motionKey = kind === 'resource' && typeof (motion as { key?: unknown }).key === 'string'
      ? (motion as { key: string }).key
      : kind === 'custom' && (motion as { derivedFrom?: { key?: unknown } }).derivedFrom?.key
        ? String((motion as { derivedFrom: { key: unknown } }).derivedFrom.key)
        : '';
    if (!semanticItem || !motionKey) return [];
    const charId = typeof params.target === 'string' ? params.target : '';
    const locator = semanticItem.locator.kind === 'companion'
      ? { kind: 'companion' as const, statementId: semanticItem.statementId, companionId: semanticItem.companionId! }
      : { kind: 'statement' as const, statementId: semanticItem.statementId };
    const isCustom = kind === 'custom';
    const customDuration = isCustom && typeof (motion as { durationSeconds?: unknown }).durationSeconds === 'number'
      ? (motion as { durationSeconds: number }).durationSeconds
      : undefined;
    const adapterDuration = (!isCustom && charId && characterAdapter?.getMotionDuration)
      ? characterAdapter.getMotionDuration(charId, motionKey)
      : 0;
    const durationSeconds = customDuration
      ?? (adapterDuration > 0
        ? adapterDuration
        : (typeof params.durationSeconds === 'number'
          ? params.durationSeconds
          : (semanticItem.durationSeconds || 1)));
    if (kind === 'resource') {
      return [{
        label: '转为自定义动作…',
        run: () => {
          conversionLocatorRef.current = locator;
          setConversionDialog({ mode: 'convert', targetId: charId, motionKey, durationSeconds });
          if (charId && motionKey && adapterDuration <= 0) {
            const targets = characterAdapter.getCubism2SamplerTargets?.(charId) ?? [];
            if (targets.length > 0) {
              void resolveCubism2MotionMeta(targets[0], motionKey).then((meta) => {
                if (meta.durationSeconds > 0) {
                  setConversionDialog((prev) => (
                    prev && prev.motionKey === motionKey && prev.targetId === charId
                      ? { ...prev, durationSeconds: meta.durationSeconds }
                      : prev
                  ));
                }
              }).catch(() => {});
            }
          }
        },
      }];
    }
    if (kind === 'custom') {
      return [
        {
          label: '编辑关键帧',
          run: () => {
            onSelect(id, false);
            // 与检查器按钮一致：真正在轨道区展开关键帧编辑器，而不是只提示。
            writableEditorStore.setCustomMotionEditorActionId(id);
          },
        },
        {
          label: '重新转换（重选密度）…',
          run: () => {
            conversionLocatorRef.current = locator;
            setConversionDialog({ mode: 'regenerate', targetId: charId, motionKey, durationSeconds });
          },
        },
      ];
    }
    return [];
  }, [actionById, semanticTimelineItemById, onSelect, writableEditorStore, characterAdapter]);

  const sceneFps = documentStore.getCurrentSceneDocumentSnapshot()?.meta?.fps ?? 60;
  const estimateKeyframesForDensity = React.useCallback((density: CustomMotionDensity): number => {
    if (!conversionDialog) return 0;
    return estimateCustomMotionKeyframes(conversionDialog.durationSeconds, density, sceneFps);
  }, [conversionDialog, sceneFps]);

  const handleConvertConfirm = async (density: CustomMotionDensity) => {
    const locator = conversionLocatorRef.current;
    if (!customMotionAuthoring || !locator || !conversionDialog) return;
    setIsConverting(true);
    try {
      const locatorArg = locator.companionId !== undefined
        ? { kind: 'companion' as const, statementId: locator.statementId, companionId: locator.companionId }
        : { kind: 'statement' as const, statementId: locator.statementId };
      const receipt = await customMotionAuthoring.convert(locatorArg, density);
      showToast(
        conversionDialog.mode === 'regenerate'
          ? `已从源动作重新生成（${receipt.motion.tracks.length} 条轨道）`
          : `已转为自定义动作（${receipt.motion.tracks.length} 条轨道）`,
        'success',
      );
      setConversionDialog(null);
      conversionLocatorRef.current = null;
    } catch (error) {
      showToast(describeCustomMotionAuthoringError(error), 'error');
    } finally {
      setIsConverting(false);
    }
  };

  const {
    menuState: blockMenuState,
    setMenuState: setBlockMenuState,
    handleBlockContextMenu,
    dispatchMenuAction,
  } = useBlockContextMenu({
    semanticSnapshot,
    selectAfterCommit,
    onCopyActions,
    onDuplicateActions,
    onDeleteActions,
    getMotionActions: (id) => buildMotionMenuActions(id),
    onLocateParent: (id) => {
      const item = semanticTimelineItemById.get(id);
      if (!item?.parentItemId) return;
      const parent = semanticTimelineItemById.get(item.parentItemId);
      if (!parent) return;
      onSelect(parent.id, false);
      onNavigateRange({
        start: parent.time,
        end: parent.time + Math.max(parent.durationSeconds, 0.1),
      });
    },
  });

  const motionItems = (() => {
    if (!blockMenuState) return undefined;
    return buildMotionMenuActions(blockMenuState.targetId).map(({ label, danger }) => ({ label, danger }));
  })();

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;

    if (
      target.closest('.timeline-ruler') ||
      target.closest('.playhead-handle') ||
      target.classList.contains('playhead-line') ||
      target.closest('.track-label') ||
      target.closest('.cme')
    ) {
      return;
    }

    const blockEl = target.closest('.track-block') as HTMLElement | null;
    if (blockEl) {
      const blockId = blockEl.dataset.id;
      if (!blockId) return;

      const isMulti = e.ctrlKey || e.metaKey || e.shiftKey;
      if (isMulti) {
        e.preventDefault();
        e.stopPropagation();
        onSelect(blockId, true);
        return;
      }

      if (!selectedIds[blockId]) onSelect(blockId, false);

      // ADR-0022 placeholders are selectable/editable but never draggable or
      // resizable: their anchor and zero-offset are part of the placeholder
      // contract until a motion is filled.
      if (isPlaceholderTimelineAction(actionById.get(blockId))) return;

      const isResize = target.classList.contains('track-resize-handle');
      if (isResize) {
        handleBlockResize(e, blockId);
      } else {
        const selectedIdsList = Object.keys(selectedIds).filter((key) => selectedIds[key]);
        if (selectedIdsList.length > 1 && selectedIds[blockId]) {
          handleBatchDrag(e, blockId);
        } else {
          handleBlockDrag(e, blockId);
        }
      }
      return;
    }

    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    handleMarqueeDown(e);
  };

  const publishTimelinePointer = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const area = areaRef.current;
    if (!area || pps <= 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('.timeline-ruler') || target.closest('.track-label')) return;

    const areaRect = area.getBoundingClientRect();
    const projection = projectTimelinePointerPresence({
      clientX: e.clientX,
      clientY: e.clientY,
      areaLeft: areaRect.left,
      pixelsPerSecond: pps,
      maxTime,
      tracks: Array.from(trackRefs.current, ([id, trackEl]) => {
        const trackRect = trackEl.getBoundingClientRect();
        return { id, top: trackRect.top, bottom: trackRect.bottom };
      }),
    });
    if (!projection) {
      if (lastPointerPresenceRef.current) {
        lastPointerPresenceRef.current = null;
        publishCollaborationPresence({ pointer: null });
      }
      return;
    }

    const now = Date.now();
    const nextPointer = {
      time: projection.pointer.time,
      trackId: projection.pointer.trackId,
    };
    if (!shouldPublishTimelinePointer({
      previous: lastPointerPresenceRef.current,
      next: nextPointer,
      now,
    })) {
      return;
    }

    lastPointerPresenceRef.current = { ...nextPointer, sentAt: now };
    publishCollaborationPresence(projection);
  }, [maxTime, pps, publishCollaborationPresence]);

  const clearTimelinePointer = useCallback(() => {
    if (!lastPointerPresenceRef.current) return;
    lastPointerPresenceRef.current = null;
    publishCollaborationPresence({ pointer: null });
  }, [publishCollaborationPresence]);

  const completePasteHere = async (time: number) => {
    await commands.paste(editorStore.copyBuffer, time, 'blank-context-menu');
    setBlankMenu(null);
  };

  const handleSelectActionFromLibrary = async (type: 'statement' | 'template', data: any) => {
    if (blockOfflineAuthoring()) return;
    if (!semanticAuthoring || !blankMenu) return;
    const targetCharId = blankMenu.charId || sceneData.meta?.characters?.[0]?.id;
    const scope: AuthoringScope = targetCharId
      ? blankMenu.charId
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

    if (type === 'statement' && data.blockId) {
      const document = documentStore.getCurrentSceneDocumentSnapshot();
      try {
        const result = buildSemanticStatementLibraryInsert({
          blockId: data.blockId,
          document,
          sceneMeta: sceneData.meta,
          anchorTime: blankMenu.time,
          origin: 'blank-context-menu',
          scope,
          preferredLifecycleStartStatementIds,
          correlationPrefix: 'blank_menu_insert',
          lifecycleEndCorrelationPrefix: 'blank_menu_lifecycle_end',
          lifecycleTargetBindingCorrelationPrefix: 'blank_menu_lifecycle_target_binding',
        });
        if (result.kind === 'warning') {
          showToast(result.message, 'warning');
          setBlankMenu(null);
          return;
        }
        if (result.kind === 'unavailable') {
          if (result.message) showToast(result.message, 'warning');
          return;
        }
        if (blockOfflineAuthoring()) return;
        await submitSemanticStatementLibraryInsert({
          semanticAuthoring,
          documentStore,
          intent: result.intent,
          onSelect: (ids) => onSelect(ids, false),
        });
      } catch (error) {
        showToast(error instanceof Error ? error.message : '无法执行生命周期命令', 'warning');
        setBlankMenu(null);
        return;
      }
      setBlankMenu(null);
    }

    if (type === 'template' && data.templateId) {
      const combo = availableTemplates.find((candidate) => candidate.id === data.templateId);
      const preview = combo
        ? buildTemplateAuthoringPreview(combo, {
            anchorTime: blankMenu.time,
            correlationId: createSemanticTimelineCorrelationId('blank_menu_template'),
            origin: 'blank-context-menu',
            scope,
          })
        : null;
      if (!preview || !combo) return;
      if (blockOfflineAuthoring()) return;
      await commands.insert(preview.intent);
    }

    setBlankMenu(null);
  };

  const spotlightRange = useMemo(
    () => getPlayheadSpotlightRange(spotlightBucketTime),
    [spotlightBucketTime],
  );

  const hasSummaryTrack = tracks.some((track) => trackRenderState[track.id]?.mode === 'summary');

  const handleSummarySeek = useCallback((time: number) => {
    onSeek(time, true);
  }, [onSeek]);

  const feedbackHudStyle = useMemo(() => {
    if (!interactionFeedback || typeof interactionFeedback.pointerX !== 'number' || typeof interactionFeedback.pointerY !== 'number') {
      return undefined;
    }
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect) return undefined;
    const x = Math.max(108, Math.min(rect.width - 260, interactionFeedback.pointerX - rect.left + 14));
    const y = Math.max(38, Math.min(rect.height - 52, interactionFeedback.pointerY - rect.top - 42));
    return {
      transform: `translate(${x}px, ${y}px)`,
    } as React.CSSProperties;
  }, [interactionFeedback]);

  const projectTransientAction = (action: TimelineAction, id: string): TimelineAction => {
    const transient = transientStates[id];
    if (!transient) return action;
    const time = transient.time ?? action.time;
    if (transient.duration === undefined) return { ...action, time };

    const authoringParams = action.sourceParams ?? action.params;
    const nextParams: Record<string, any> = { ...action.params, duration: transient.duration };
    let nextSourceParams = action.sourceParams;
    const motion = authoringParams.motion;
    if (motion && typeof motion === 'object' && !Array.isArray(motion) && (motion as { kind?: unknown }).kind === 'custom') {
      const nextMotion = { ...motion, durationSeconds: transient.duration };
      nextParams.motion = nextMotion;
      nextSourceParams = { ...authoringParams, motion: nextMotion };
    } else if (typeof authoringParams.durationSeconds === 'number') {
      nextSourceParams = { ...authoringParams, durationSeconds: transient.duration };
    }

    return {
      ...action,
      time,
      params: nextParams,
      ...(nextSourceParams ? { sourceParams: nextSourceParams } : {}),
    };
  };

  const renderLifecyclePairRail = (
    action: TimelineAction,
    id: string,
    laneIndex: number,
    keyPrefix: 'anchor' | 'detail',
  ) => {
    const statementId = statementIdByActionId.get(id);
    if (!statementId) return null;
    const record = resolveLifecyclePair(lifecyclePairTable, statementId);
    if (!record || record.role !== 'start' || record.status !== 'paired' || !record.peerId) return null;
    const peerActionId = actionIdByStatementId.get(record.peerId);
    if (!peerActionId) return null;
    const peerAction = tracks.flatMap((track) => track.actions).find((item) => item.id === peerActionId)?.action;
    if (!peerAction) return null;
    const isActive = !!selectedIds[id] || !!selectedIds[peerActionId]
      || hoveredLifecycleActionId === id || hoveredLifecycleActionId === peerActionId;
    if (!isActive) return null;
    const projectedAction = projectTransientAction(action, id);
    const projectedPeerAction = projectTransientAction(peerAction, peerActionId);
    const { startLaneIndex, endLaneIndex } = resolveLifecyclePairRelationshipLaneIndices({
      startTrackId: actionTrackMap.get(id),
      peerTrackId: actionTrackMap.get(peerActionId),
      startLaneIndex: laneIndex,
      peerLaneIndex: laneMap[peerActionId],
    });
    return (
      <LifecyclePairRelationshipRail
        key={`pair-rail:${keyPrefix}:${id}`}
        startTime={projectedAction.time ?? record.time}
        endTime={projectedPeerAction.time ?? 0}
        pixelsPerSecond={pps}
        startLaneIndex={startLaneIndex}
        endLaneIndex={endLaneIndex}
        isActive={isActive}
        colorAction={action}
      />
    );
  };

  const renderTrackBlock = (
    action: TimelineAction,
    id: string,
    laneIndex: number,
    keyPrefix: 'anchor' | 'detail',
  ) => (
    <TrackBlock
      key={`${keyPrefix}:${id}`}
      action={projectTransientAction(action, id)}
      id={id}
      trackId={actionTrackMap.get(id)}
      pixelsPerSecond={pps}
      isSelected={!!selectedIds[id]}
      isPairPeer={activePairPeerActionIds.has(id) || companionRelatedActionIds.has(id)}
      repeatWarning={repeatIndexMap?.get(id)}
      collaborationEditingSummary={collaborationEditingByActionId.get(id)?.summary}
      collaborationEditingPeerCount={collaborationEditingByActionId.get(id)?.peerCount}
      relationshipLabel={relationshipLabelByActionId.get(id)}
      laneIndex={laneIndex}
      registerBlock={registerBlock}
      onSelect={(actionId) => onSelect(actionId, false)}
      onResizeNudge={handleTrackResizeNudge}
      onContextMenu={handleBlockContextMenu}
      onHoverChange={setHoveredLifecycleActionId}
    />
  );

  const contentWidth = Math.max(1000, containerWidth, maxTime * pps + 200);

  return (
    <div
      ref={areaRef}
      data-testid="timeline-track-area"
      style={{
        width: `${contentWidth}px`,
        position: 'relative',
        minHeight: '100%',
        cursor: 'default',
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={publishTimelinePointer}
      onPointerLeave={clearTimelinePointer}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onContextMenu={(event) => {
        if ((event.target as HTMLElement).closest('.cme')) return;
        handleBlankContextMenu(event);
      }}
    >
      <Ruler
        maxTime={Math.max(maxTime, (contentWidth - 100) / pps)}
        pps={pps}
        onSeek={onSeek}
        scrollLeft={scrollLeft}
        containerWidth={containerWidth}
        markers={sceneData?.meta?.markers}
        onAddMarker={handleAddMarker}
        onRemoveMarker={handleRemoveMarker}
      />

      <div data-tutorial-target="timeline-blank-start" aria-hidden="true" />
      <div
        data-tutorial-target="timeline-blank-after-entrance"
        aria-hidden="true"
        style={firstCharacterEntranceTime !== null
          ? { left: 100 + firstCharacterEntranceTime * pps }
          : undefined}
      />

      <MarqueeOverlay marqueeRef={marqueeRef} />

      {hasSummaryTrack && (
        <div
          data-testid="timeline-spotlight-window"
          className="timeline-spotlight-window"
          style={{
            left: `${100 + spotlightRange.start * pps}px`,
            width: `${Math.max(24, (spotlightRange.end - spotlightRange.start) * pps)}px`,
          }}
        />
      )}

      {typeof interactionFeedback?.snapTime === 'number' && (
        <div
          className="timeline-snap-guide"
          data-testid="timeline-snap-guide"
          style={{ left: `${100 + interactionFeedback.snapTime * pps}px` }}
        >
          <span>{formatFeedbackSeconds(interactionFeedback.snapTime)}</span>
        </div>
      )}

      {interactionFeedback && feedbackHudStyle && (
        <div className="timeline-feedback-hud" style={feedbackHudStyle} data-testid="timeline-feedback-hud">
          {formatTimelineFeedbackLabel(interactionFeedback)}
        </div>
      )}

      <Playhead
        pps={pps}
        areaRef={areaRef}
        onSeek={onSeek}
      />

      {collaborationPlayheadPeers.map((peer) => {
        const displayName = peer.displayName.trim() || peer.clientId;
        const time = peer.playheadTime ?? 0;
        return (
          <div
            key={peer.clientId}
            className="collaboration-playhead"
            data-testid="collaboration-playhead"
            data-client-id={peer.clientId}
            style={{ left: `${100 + time * pps}px` }}
            title={`${displayName} 的 CTI: ${formatPresencePlayheadTime(time)}`}
            aria-label={`${displayName} 的 CTI ${formatPresencePlayheadTime(time)}`}
          >
            <span className="collaboration-playhead__handle" />
            <span className="collaboration-playhead__label">{displayName}</span>
          </div>
        );
      })}

      {collaborationPointerPeers.map((peer) => {
        const displayName = peer.displayName.trim() || peer.clientId;
        const pointer = peer.pointer!;
        const row = pointer.trackId ? trackPointerRows.get(pointer.trackId) : undefined;
        const top = row ? row.top + Math.min(row.height - 10, 14) : 36;
        return (
          <div
            key={peer.clientId}
            className="collaboration-pointer"
            data-testid="collaboration-pointer"
            data-client-id={peer.clientId}
            data-track-id={pointer.trackId}
            style={{
              left: `${100 + pointer.time * pps}px`,
              top: `${top}px`,
            }}
            title={`${displayName} 指向 ${formatPresencePlayheadTime(pointer.time)}`}
            aria-label={`${displayName} 指向 ${formatPresencePlayheadTime(pointer.time)}`}
          >
            <span className="collaboration-pointer__dot" />
            <span className="collaboration-pointer__label">{displayName}</span>
          </div>
        );
      })}

      <div
        className="timeline-companion-relationship-layer"
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          zIndex: 0,
        }}
      >
        {companionRelationshipItems.map((relationship) => {
          if (!relationship.active) return null;
          const parentTrackId = actionTrackMap.get(relationship.parentId);
          const companionTrackId = actionTrackMap.get(relationship.companionId);
          const parentRow = parentTrackId ? trackPointerRows.get(parentTrackId) : undefined;
          const companionRow = companionTrackId ? trackPointerRows.get(companionTrackId) : undefined;
          if (!parentRow || !companionRow) return null;
          const parentLane = laneMap[relationship.parentId] ?? 0;
          const companionLane = laneMap[relationship.companionId] ?? 0;
          return (
            <CompanionRelationshipRail
              key={`companion-relationship:${relationship.companionId}`}
              startTime={relationship.parentTime}
              endTime={relationship.companionTime}
              startY={parentRow.top + parentLane * 32 + 16}
              endY={companionRow.top + companionLane * 32 + 16}
              pixelsPerSecond={pps}
              isActive
              colorAction={relationship.companionAction}
            />
          );
        })}
      </div>

      <div style={{ paddingTop: '8px' }}>
        {tracks.map((track) => {
          const renderState = trackRenderState[track.id];
          return (
            <React.Fragment key={track.id}>
            <TrackRow
              trackId={track.id}
              trackKind={getEnvironmentTrackKind(track.id)}
              label={track.label}
              laneCount={renderState?.mode === 'summary' ? 1 : laneCounts[track.id]}
              registerTrack={registerTrack}
              isSelected={selectedTrackIds.has(track.id)}
              railLayer={(
                <>
                  {renderState?.blocks.map(({ action, id }) => (
                    <React.Fragment key={`rails:${id}`}>
                      {renderLifecyclePairRail(action, id, laneMap[id], 'detail')}
                    </React.Fragment>
                  ))}
                  {renderState?.anchorActions.map(({ action, id }) => (
                    <React.Fragment key={`rails-anchor:${id}`}>
                      {renderLifecyclePairRail(action, id, 0, 'anchor')}
                    </React.Fragment>
                  ))}
                </>
              )}
              summaryLayer={renderState?.summarySegments.map((segment) => (
                <TrackSummaryBlock
                  key={`summary:${segment.id}`}
                  segment={segment}
                  pixelsPerSecond={pps}
                  trackLabel={track.label}
                  trackKind={track.id}
                  onHover={setSummaryTooltip}
                  onLeave={() => setSummaryTooltip(null)}
                  onSeek={handleSummarySeek}
                  onNavigate={onNavigateRange}
                />
              ))}
              anchorLayer={renderState?.anchorActions.map(({ action, id }) => (
                <TrackAnchorPin
                  key={`anchor:${id}`}
                  action={action}
                  id={id}
                  pixelsPerSecond={pps}
                  isSelected={!!selectedIds[id]}
                  hasValidationIssue={validationActionIds.has(id)}
                  hasRepeatWarning={!!repeatIndexMap?.get(id)}
                  isCollaborationEditing={collaborationEditingByActionId.has(id)}
                  collaborationEditingSummary={collaborationEditingByActionId.get(id)?.summary}
                  onSelect={(actionId) => onSelect(actionId, false)}
                  onSeek={(time) => onSeek(time, true)}
                  registerBlock={registerBlock}
                  onPointerDown={handleAnchorDrag}
                />
              ))}
              detailLayer={renderState?.blocks.map(({ action, id }) => (
                renderTrackBlock(action, id, laneMap[id], 'detail')
              ))}
            />
            {customMotionEditorTarget?.trackId === track.id && (
              <CustomMotionEditor
                key={`${customMotionEditorTarget.sceneId}:${customMotionEditorTarget.actionId}`}
                layout="timeline"
                gutterWidth={100}
                minContentWidth={maxTime * pps}
                viewportWidth={containerWidth}
                fps={sceneData.meta.fps ?? 60}
                scrollContainer={areaRef.current?.closest<HTMLElement>('.timeline-editor-scroll-container')}
                parameterMetadata={characterAdapter.getParameterMetadata?.(customMotionEditorTarget.characterId)}
                motion={customMotionEditorTarget.motion}
                blockTime={customMotionEditorTarget.blockTime}
                pixelsPerSecond={pps}
                playheadTime={playheadTimeRef.current}
                onCommit={handleCustomMotionEditorCommit}
                leaseState={customMotionLeaseState}
                busy={customMotionLeaseState === 'pending' || customMotionLeaseState === 'denied'}
                onSeek={(sceneTime) => onSeek(sceneTime, true)}
                onClose={() => writableEditorStore.setCustomMotionEditorActionId(null)}
              />
            )}
            </React.Fragment>
          );
        })}
      </div>

      <BlankContextMenu
        menu={blankMenu}
        hasCopyBuffer={editorStore.copyBuffer.length > 0}
        templates={availableTemplates}
        onPaste={completePasteHere}
        onSelectAction={handleSelectActionFromLibrary}
        availableLifecycleEndCommandIds={availableLifecycleEndCommandIds}
        availableStateSpanDependencyCommandIds={availableLifecycleTargetBindingCommandIds}
      />

      <BlockContextMenu
        menu={blockMenuState}
        onAction={dispatchMenuAction}
        onDismiss={() => setBlockMenuState(null)}
        motionItems={motionItems}
        showLocateParent={!!blockMenuState?.isCompanion}
      />

      <MarkerPrompt
        prompt={markerPrompt}
        onComplete={completeAddMarker}
        onCancel={() => setMarkerPrompt(null)}
      />

      <CustomMotionConversionDialog
        open={conversionDialog}
        estimateKeyframes={estimateKeyframesForDensity}
        busy={isConverting}
        onConfirm={(density) => { void handleConvertConfirm(density); }}
        onCancel={() => { if (!isConverting) { setConversionDialog(null); conversionLocatorRef.current = null; } }}
      />

      <TrackSummaryTooltip payload={summaryTooltip} />
    </div>
  );
});

TrackArea.displayName = 'TrackArea';

const stableEmptyPackages: never[] = [];
const getStableEmptyPackages = () => stableEmptyPackages;
