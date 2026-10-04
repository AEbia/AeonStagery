import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CharacterMotionOutput,
  CustomMotionKeyframe,
  CustomMotionSegment,
  CustomMotionTrack,
} from '../../api/types/semantic-scene';
import type { CustomMotionKeyframeEdit, CustomMotionKeyframeRef } from '../../services/timeline-authoring/customMotionKeyframeEdits';
import type { CustomMotionLeaseState } from '../../services/timeline-authoring/CustomMotionEditLeaseGate';
import { evaluateCustomMotionTrack } from '../../engine/live2d/customMotion';
import { buildCurvePresetSegment, CURVE_PRESETS, resolveCurvePresetId } from './curvePresets';
import { useOptionalApp } from '../context/AppContext';
import { showToast } from '../Toast';
import { InlineNumericInput } from './FormComponents';
import { getLive2DParameterDisplayName } from './live2dParameterPresentation';
import './CustomMotionEditor.css';
import type { Live2DParameterMetadata } from '../../api/types/live2d-parameter-animation';
import { useCustomMotionSelection } from './useCustomMotionSelection';
import { lowerBound, resolveParameterRange, createGroupMoveResolver } from './customMotionSelection';

export function isTrackAnimated(track: CustomMotionTrack): boolean {
  if (track.keyframes.length <= 1) return false;
  const firstValue = track.keyframes[0].value;
  return track.keyframes.some((kf) => Math.abs(kf.value - firstValue) > 1e-5);
}

export type CustomMotionEditorView = 'lanes' | 'graph';
export type CustomMotionEditorLayout = 'panel' | 'timeline';

export interface CustomMotionEditorProps {
  motion: Extract<CharacterMotionOutput, { kind: 'custom' }>;
  fps?: number;
  parameterMetadata?: readonly Live2DParameterMetadata[];
  scrollContainer?: HTMLElement | null;
  /** Block start time in the scene (used to align with the scene ruler/playhead). */
  blockTime: number;
  /** Timeline pixels-per-second for ruler alignment. */
  pixelsPerSecond: number;
  /**
   * 'panel'：独立面板（嵌在检查器等窄栏里）；'timeline'：内嵌在轨道区展开带中，
   * 画布 1:1 对齐场景时间坐标，参数名吸左，隐藏自带播放头（使用轨道区播放头）。
   */
  layout?: CustomMotionEditorLayout;
  /** timeline 模式下左侧参数名列宽度（需与轨道区标签列一致，保证画布零点对齐）。 */
  gutterWidth?: number;
  /** timeline 模式下画布的最小宽度（px），用于让轨道铺满整条时间轴。 */
  minContentWidth?: number;
  /** timeline 模式下可见视口宽度（px），用于把页头钉在滚动视口内。 */
  viewportWidth?: number;
  /** Current scene playhead time. */
  playheadTime: number;
  /** Callback that persists a batch of keyframe edits through the command layer. */
  onCommit: (edits: readonly CustomMotionKeyframeEdit[], expectedMotion?: CustomMotion) => Promise<void> | void;
  /** Optional scene seek (playhead jump). */
  onSeek?: (sceneTime: number) => void;
  /** Collaboration lease busy flag (read-only hint). */
  busy?: boolean;
  leaseState?: CustomMotionLeaseState;
  /** Hide the close button when embedded in a fixed host. */
  hideClose?: boolean;
  onClose?: () => void;
}

const LANE_HEIGHT = 28;
const GRAPH_HEIGHT = 156;
const F0_EPSILON = 0.001;
const EMPTY_PARAMETER_METADATA: readonly Live2DParameterMetadata[] = [];
const EMPTY_KEYFRAMES: readonly CustomMotionKeyframe[] = [];

type CustomMotion = Extract<CharacterMotionOutput, { kind: 'custom' }>;

export function CustomMotionEditor({
  motion,
  fps: suppliedFps = 60,
  parameterMetadata = EMPTY_PARAMETER_METADATA,
  scrollContainer,
  blockTime,
  pixelsPerSecond,
  layout = 'panel',
  gutterWidth = 100,
  minContentWidth = 0,
  viewportWidth = 0,
  playheadTime,
  onCommit,
  onSeek,
  busy = false,
  leaseState = 'unavailable',
  hideClose = false,
  onClose,
}: CustomMotionEditorProps) {
  const [view, setView] = useState<CustomMotionEditorView>('lanes');
  const [filterMode, setFilterMode] = useState<'all' | 'animated'>('all');
  const [filterQuery, setFilterQuery] = useState('');
  const [selectedParam, setSelectedParam] = useState<string>(motion.tracks[0]?.parameterId ?? '');
  const fps = Number.isFinite(suppliedFps) && suppliedFps > 0 ? suppliedFps : 60;
  const [pendingCommit, setPendingCommit] = useState(false);
  const writeBlocked = busy || pendingCommit;
  const pendingCommitRef = useRef(false);
  const [readout, setReadout] = useState<{ text: string; x: number; y: number } | null>(null);
  const [tooltip, setTooltip] = useState<{ param: string; detail: string; x: number; y: number } | null>(null);
  /** Optimistic preview of the dragged track's keyframes while a pointer drag is in flight. */
  const [previewKeyframes, setPreviewKeyframes] = useState<readonly CustomMotionKeyframe[] | null>(null);
  const [previewTrackIndex, setPreviewTrackIndex] = useState<number | null>(null);
  const dragRef = useRef<{
    motion: CustomMotion;
    track: CustomMotionTrack;
    trackIndex: number;
    keyframeIndex: number;
    cpIndex: 0 | 1;
    startX: number;
    startY: number;
    startValue: number;
    startTime: number;
    range: { min: number; max: number; bounded?: boolean };
    moved: boolean;
  } | null>(null);
  const previewKeyframesRef = useRef<readonly CustomMotionKeyframe[] | null>(null);
  const curveCanvasRef = useRef<SVGSVGElement | null>(null);

  const motionRef = useRef(motion);
  motionRef.current = motion;
  const isTimeline = layout === 'timeline';
  const playback = useOptionalApp()?.adapters.playback;
  // TrackArea stores the latest adapter notification in a ref because its
  // density rendering does not re-render for every playhead tick. On first
  // mount that value is newer than the engine getter while an async seek is
  // still settling, so the embedded timeline must use the prop it was given.
  // Standalone panel instances do not have that ref-backed contract and keep
  // the adapter getter as their initial source when it is available.
  const initialPlaybackTime = playback?.getCurrentTime();
  const initialLivePlayheadTime = isTimeline
    ? finiteOr(playheadTime, finiteOr(initialPlaybackTime, 0))
    : finiteOr(initialPlaybackTime, finiteOr(playheadTime, 0));
  const livePlayheadTimeRef = useRef(initialLivePlayheadTime);
  const [livePlayheadTime, setLivePlayheadTime] = useState(initialLivePlayheadTime);
  const rootRef = useRef<HTMLDivElement>(null);
  const initialBodyTime = useRef(initialLivePlayheadTime);
  const internalSeekRef = useRef<number | null>(null);

  const tracks = motion.tracks;
  const duration = motion.durationSeconds;
  const fadeIn = motion.fadeInSeconds;
  const firstTrackParam = tracks[0]?.parameterId ?? '';
  const selectedTrackExists = tracks.some((track) => track.parameterId === selectedParam);

  const commitAsync = useCallback(async (edits: readonly CustomMotionKeyframeEdit[]) => {
    if (busy || pendingCommitRef.current) throw new Error('编辑器当前不可写');
    playback?.pause?.();
    pendingCommitRef.current = true;
    setPendingCommit(true);
    try {
      const result = onCommit(edits, motionRef.current);
      if (result) await result;
    }
    catch (error) {
      toastError(error instanceof Error ? error.message : '关键帧修改失败，请重试');
      throw error;
    } finally { pendingCommitRef.current = false; setPendingCommit(false); }
  }, [busy, onCommit, playback]);
  const commit = useCallback((edits: readonly CustomMotionKeyframeEdit[]) => {
    void commitAsync(edits).catch(() => {});
  }, [commitAsync]);
  const metadataByParameter = useMemo(() => new Map(parameterMetadata.map((metadata) => [metadata.id, metadata])), [parameterMetadata]);
  const renderValueRange = useCallback((track: CustomMotionTrack | undefined) => resolveParameterRange(track, track ? metadataByParameter.get(track.parameterId) : undefined), [metadataByParameter]);
  const selectionState = useCustomMotionSelection({
    motion, view, fps, blockTime, pps: pixelsPerSecond, root: rootRef, scrollContainer,
    busy: writeBlocked, commit: commitAsync, pause: () => playback?.pause?.(),
    selectParam: setSelectedParam, range: renderValueRange, onError: (message) => toastError(message),
  });
  const { selection, updateSelection, clear: clearSelection, startMove, startMarquee } = selectionState;
  const selectedKfTime = selection.length === 1 && selection[0].parameterId === selectedParam ? selection[0].time : null;
  const setSelectedKfTime = useCallback((time: number | null) => {
    updateSelection(time === null ? [] : [{ parameterId: selectedParam, time }]);
  }, [selectedParam, updateSelection]);

  useEffect(() => {
    const write = (time: number) => {
      if (!Number.isFinite(time)) return;
      if (livePlayheadTimeRef.current !== time && !pendingCommitRef.current) {
        if (internalSeekRef.current === null || Math.abs(internalSeekRef.current - time) > 1e-6) clearSelection();
        internalSeekRef.current = null;
      }
      livePlayheadTimeRef.current = time;
      setLivePlayheadTime(time);
    };
    if (!playback) return;
    return playback.subscribeTime(write);
  }, [playback, clearSelection]);

  useEffect(() => {
    // Once mounted, adapter notifications are authoritative. The timeline
    // prop is only the bootstrapping value because TrackArea may have received
    // a newer notification before this editor mounted; copying a later parent
    // render back here would reintroduce a stale density bucket.
    if (playback || !Number.isFinite(playheadTime) || livePlayheadTimeRef.current === playheadTime) return;
    if (internalSeekRef.current === null || Math.abs(internalSeekRef.current - playheadTime) > 1e-6) clearSelection();
    internalSeekRef.current = null;
    livePlayheadTimeRef.current = playheadTime;
    setLivePlayheadTime(playheadTime);
  }, [playback, playheadTime, clearSelection]);

  useEffect(() => {
    if (selectedTrackExists) return;
    setSelectedParam(firstTrackParam);
    setSelectedKfTime(null);
  }, [firstTrackParam, selectedTrackExists, setSelectedKfTime]);

  const activeTrack = useMemo(
    () => tracks.find((track) => track.parameterId === selectedParam) ?? tracks[0] ?? null,
    [tracks, selectedParam],
  );

  const xOf = useCallback((localTime: number) => (blockTime + localTime) * pixelsPerSecond, [blockTime, pixelsPerSecond]);
  const contentWidth = useCallback(
    () => Math.max(600, (blockTime + duration) * pixelsPerSecond + 200, minContentWidth),
    [blockTime, duration, pixelsPerSecond, minContentWidth],
  );
  const previousSelectionByTrack = useRef(new Map<string, Set<number>>());
  const selectionByTrack = useMemo(() => {
    const result = new Map<string, Set<number>>();
    for (const ref of selectionState.displaySelection) {
      const times = result.get(ref.parameterId) ?? new Set<number>();
      times.add(ref.time); result.set(ref.parameterId, times);
    }
    for (const [id, times] of result) {
      const previous = previousSelectionByTrack.current.get(id);
      if (previous && previous.size === times.size && [...times].every((time) => previous.has(time))) result.set(id, previous);
    }
    previousSelectionByTrack.current = result;
    return result;
  }, [selectionState.displaySelection]);
  useEffect(() => { clearSelection(); }, [view, filterMode, filterQuery, clearSelection]);
  const selectedKfIndex = useMemo(() => {
    if (selectedKfTime === null || !activeTrack) return null;
    const index = activeTrack.keyframes.findIndex((keyframe) => keyframe.time === selectedKfTime);
    return index >= 0 ? index : null;
  }, [selectedKfTime, activeTrack]);

  const selectTrack = useCallback((parameterId: string) => {
    setSelectedParam(parameterId);
    clearSelection();
  }, [clearSelection]);

  const seekToScene = useCallback((sceneTime: number) => {
    internalSeekRef.current = sceneTime;
    onSeek?.(sceneTime);
  }, [onSeek]);

  const getLocalPlayheadTime = useCallback(
    () => {
      // The ref makes pointer/key interactions use the newest seek event even
      // before React commits the corresponding state update.
      const sceneTime = Number.isFinite(livePlayheadTimeRef.current)
        ? livePlayheadTimeRef.current
        : 0;
      // Keep the same precision as the scene ruler. Rounding here changes the
      // persisted local time while the main playhead still renders the raw
      // scene time, so a newly inserted marker can visibly miss the playhead.
      return round6(clampValue(sceneTime - blockTime, 0, duration));
    },
    [blockTime, duration],
  );

  const playheadKeyframeIndex = useMemo(() => {
    if (!activeTrack) return null;
    const sceneTime = Number.isFinite(livePlayheadTimeRef.current)
      ? livePlayheadTimeRef.current
      : livePlayheadTime;
    const localTime = round6(clampValue(sceneTime - blockTime, 0, duration));
    const index = activeTrack.keyframes.findIndex((keyframe) => Math.abs(keyframe.time - localTime) < F0_EPSILON);
    return index >= 0 ? index : null;
  }, [activeTrack, blockTime, duration, livePlayheadTime]);

  const togglePlayheadKeyframe = useCallback(() => {
    if (!activeTrack || busy) return;
    const localTime = getLocalPlayheadTime();
    const index = activeTrack.keyframes.findIndex((keyframe) => Math.abs(keyframe.time - localTime) < F0_EPSILON);
    if (index >= 0) {
      if (index === 0) {
        toastError('首帧 (0.0s) 受保护，不能删除');
        return;
      }
      commit([{ type: 'remove-keyframe', trackParameterId: activeTrack.parameterId, time: activeTrack.keyframes[index].time }]);
      setSelectedKfTime(null);
      return;
    }
    const value = round2(samplePlayheadTrackValue(activeTrack, blockTime + localTime, blockTime, duration));
    commit([{ type: 'insert-keyframe', trackParameterId: activeTrack.parameterId, time: localTime, value }]);
    setSelectedKfTime(localTime);
  }, [activeTrack, blockTime, busy, commit, duration, getLocalPlayheadTime, setSelectedKfTime]);

  const jumpToKeyframe = useCallback((dir: -1 | 1) => {
    if (!activeTrack) return;
    let targetIndex: number;
    if (selectedKfTime !== null) {
      const currentIndex = activeTrack.keyframes.findIndex((keyframe) => Math.abs(keyframe.time - selectedKfTime) < F0_EPSILON);
      if (currentIndex < 0) return;
      targetIndex = dir < 0 ? currentIndex - 1 : currentIndex + 1;
    } else {
      const localTime = getLocalPlayheadTime();
      const exactIndex = activeTrack.keyframes.findIndex((keyframe) => Math.abs(keyframe.time - localTime) < F0_EPSILON);
      if (exactIndex >= 0) {
        targetIndex = dir < 0 ? exactIndex - 1 : exactIndex + 1;
      } else {
        const nextIndex = activeTrack.keyframes.findIndex((keyframe) => keyframe.time > localTime);
        targetIndex = dir < 0 ? (nextIndex < 0 ? activeTrack.keyframes.length - 1 : nextIndex - 1) : (nextIndex < 0 ? activeTrack.keyframes.length : nextIndex);
      }
    }
    if (targetIndex < 0 || targetIndex >= activeTrack.keyframes.length) return;
    const target = activeTrack.keyframes[targetIndex];
    setSelectedKfTime(target.time);
    seekToScene(blockTime + target.time);
  }, [activeTrack, blockTime, getLocalPlayheadTime, seekToScene, selectedKfTime, setSelectedKfTime]);

  // 键盘事件由编辑器根节点自己接管（根节点可聚焦）：焦点在编辑器内时，
  // 全局快捷键（如 Delete 删除动作块）会被忽略，避免与关键帧编辑冲突。
  const cancelControlPointDrag = useCallback(() => {
    dragRef.current = null;
    previewKeyframesRef.current = null;
    setPreviewKeyframes(null);
    setPreviewTrackIndex(null);
    setReadout(null);
  }, []);
  const deleteSelection = useCallback(() => {
    if (writeBlocked) return;
    const removable = selection.filter((ref) => ref.time !== 0);
    if (removable.length !== selection.length) toastError('F0 起点受保护，仅删除其他选中关键帧');
    if (!removable.length) return;
    commit(removable.map((ref) => ({ type: 'remove-keyframe', trackParameterId: ref.parameterId, time: ref.time })));
    clearSelection();
  }, [selection, writeBlocked, commit, clearSelection]);
  const handleRootKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (event.defaultPrevented || target?.closest('input, select, textarea, [contenteditable="true"], [role="spinbutton"]')) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); clearSelection(); cancelControlPointDrag(); return; }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); event.stopPropagation(); jumpToKeyframe(event.key === 'ArrowLeft' ? -1 : 1);
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selection.length) {
      event.preventDefault(); event.stopPropagation(); deleteSelection();
    }
  }, [clearSelection, cancelControlPointDrag, jumpToKeyframe, selection.length, deleteSelection]);

  const handleRootPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, select, textarea, button, [role="spinbutton"]')) return;
    rootRef.current?.focus();
  }, []);

  // Control handles share the preview/commit policy without joining keyframe selection.
  const applyDragMove = useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (writeBlocked || motionRef.current !== drag.motion) { cancelControlPointDrag(); return; }
    const canvas = curveCanvasRef.current;
    if (!canvas) return;
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= 4 && !drag.moved) return;
    drag.moved = true;
    const rect = canvas.getBoundingClientRect();
    const frameTime = Math.round(((event.clientX - rect.left) / (rect.width || contentWidth()) * contentWidth() / pixelsPerSecond - blockTime) * fps) / fps;
    const point = drag.track.keyframes[drag.keyframeIndex];
    const segment = point.segment;
    const next = drag.track.keyframes[drag.keyframeIndex + 1];
    if (segment?.type !== 'bezier' || !next) return;
    const minTime = drag.cpIndex === 0 ? point.time : segment.controlPoints[0].time;
    const maxTime = drag.cpIndex === 0 ? segment.controlPoints[1].time : next.time;
    const time = clampValue(frameTime, minTime, maxTime);
    const rawValue = drag.startValue + (drag.startY - event.clientY) / 122 * (drag.range.max - drag.range.min);
    const value = drag.range.bounded ? clampValue(rawValue, drag.range.min, drag.range.max) : rawValue;
    const points = [...drag.track.keyframes];
    points[drag.keyframeIndex] = { ...point, segment: { type: 'bezier', controlPoints: [
      drag.cpIndex === 0 ? { time, value } : segment.controlPoints[0],
      drag.cpIndex === 1 ? { time, value } : segment.controlPoints[1],
    ] } };
    previewKeyframesRef.current = points;
    setPreviewKeyframes(points);
    setReadout({ text: `${formatFrame(time, fps)} 帧 · ${round2(value)}`, x: event.clientX, y: event.clientY });
  }, [writeBlocked, cancelControlPointDrag, contentWidth, pixelsPerSecond, blockTime, fps]);

  useEffect(() => {
    let frame: number | null = null;
    let latest: PointerEvent | null = null;
    const move = (event: PointerEvent) => {
      if (!dragRef.current) return;
      latest = event;
      if (frame === null) frame = requestAnimationFrame(() => { frame = null; if (latest) applyDragMove(latest); });
    };
    const up = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      if (Number.isFinite(event.clientX)) applyDragMove(event);
      const segment = previewKeyframesRef.current?.[drag.keyframeIndex]?.segment;
      dragRef.current = null;
      if (drag.moved && segment && motionRef.current === drag.motion) {
        void commitAsync([{ type: 'set-segment', trackParameterId: drag.track.parameterId, time: drag.track.keyframes[drag.keyframeIndex].time, segment }]).catch(() => {}).finally(cancelControlPointDrag);
      } else cancelControlPointDrag();
    };
    const cancel = () => { if (frame !== null) cancelAnimationFrame(frame); frame = null; cancelControlPointDrag(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
    };
  }, [applyDragMove, commitAsync, cancelControlPointDrag]);

  // ─── view model with optimistic preview applied ───
  const displayMotion = useMemo<CustomMotion>(() => {
    if (selectionState.preview) return selectionState.preview;
    if (!previewKeyframes) return motion;
    const trackIndex = previewTrackIndex ?? dragRef.current?.trackIndex;
    if (trackIndex === null || trackIndex === undefined) return motion;
    return {
      ...motion,
      tracks: motion.tracks.map((track, index) => (
        index === trackIndex ? { ...track, keyframes: previewKeyframes } : track
      )),
    };
  }, [motion, previewKeyframes, previewTrackIndex, selectionState.preview]);

  const animatedTrackIds = useMemo(() => {
    const set = new Set<string>();
    for (const track of tracks) {
      if (isTrackAnimated(track)) set.add(track.parameterId);
    }
    return set;
  }, [tracks]);

  const visibleTracks = useMemo(() => {
    const query = filterQuery.trim().toLowerCase();
    return motion.tracks.filter((track) => {
      if (filterMode === 'animated' && !animatedTrackIds.has(track.parameterId) && track.parameterId !== selectedParam) {
        return false;
      }
      if (query) {
        const displayName = getLive2DParameterDisplayName(track.parameterId).toLowerCase();
        if (!displayName.includes(query) && !track.parameterId.toLowerCase().includes(query)) {
          return false;
        }
      }
      return true;
    });
  }, [motion.tracks, filterMode, animatedTrackIds, filterQuery, selectedParam]);

  const navigatorTracks = useMemo(() => {
    if (!activeTrack || visibleTracks.some((track) => track.parameterId === activeTrack.parameterId)) {
      return visibleTracks;
    }
    return [activeTrack, ...visibleTracks];
  }, [activeTrack, visibleTracks]);

  const startLaneDrag = useCallback((event: React.PointerEvent, track: CustomMotionTrack, _trackIndex: number, index: number) => {
    cancelControlPointDrag();
    setTooltip(null);
    startMove(event, track, false, track.keyframes[index].time);
  }, [startMove, cancelControlPointDrag]);
  const startCurveDrag = useCallback((event: React.PointerEvent, index: number) => {
    if (!activeTrack) return;
    cancelControlPointDrag();
    setTooltip(null);
    startMove(event, activeTrack, true, activeTrack.keyframes[index].time);
  }, [activeTrack, startMove, cancelControlPointDrag]);

  const startControlPointDrag = useCallback((event: React.PointerEvent, index: number, cpIndex: 0 | 1) => {
    if (writeBlocked || !activeTrack || (event.button !== undefined && event.button !== 0)) return;
    const point = activeTrack.keyframes[index];
    if (point.segment?.type !== 'bezier') return;
    event.preventDefault(); event.stopPropagation();
    rootRef.current?.focus();
    clearSelection();
    playback?.pause?.();
    const cp = point.segment.controlPoints[cpIndex];
    dragRef.current = {
      motion, track: activeTrack, trackIndex: tracks.indexOf(activeTrack), keyframeIndex: index, cpIndex,
      startX: event.clientX, startY: event.clientY, startValue: cp.value, startTime: cp.time,
      range: renderValueRange(activeTrack), moved: false,
    };
    updateSelection([{ parameterId: activeTrack.parameterId, time: point.time }]);
    previewKeyframesRef.current = activeTrack.keyframes;
    setPreviewKeyframes(activeTrack.keyframes);
    setPreviewTrackIndex(tracks.indexOf(activeTrack));
  }, [writeBlocked, activeTrack, clearSelection, playback, motion, tracks, renderValueRange, updateSelection]);

  const handleKeyframeTimeChange = useCallback((track: CustomMotionTrack, index: number, value: number) => {
    if (!Number.isFinite(value) || writeBlocked) return;
    const point = track.keyframes[index];
    const refs = [{ parameterId: track.parameterId, time: point.time }];
    const resolve = createGroupMoveResolver(tracks, refs, duration, fps, true);
    const nextTime = point.time + resolve((value - point.time) * fps) / fps;
    if (nextTime === point.time) return;
    commit([{ type: 'update-keyframe', trackParameterId: track.parameterId, time: point.time, value: point.value, newTime: nextTime }]);
    updateSelection([{ parameterId: track.parameterId, time: nextTime }]);
  }, [duration, fps, commit, updateSelection, writeBlocked, tracks]);

  const handleKeyframeValueChange = useCallback((track: CustomMotionTrack, index: number, value: number) => {
    const keyframe = track.keyframes[index];
    if (!Number.isFinite(value) || writeBlocked) return;
    const range = renderValueRange(track);
    commit([{ type: 'update-keyframe', trackParameterId: track.parameterId, time: keyframe.time, value: range.bounded ? clampValue(value, range.min, range.max) : value }]);
  }, [commit, writeBlocked, renderValueRange]);

  const handleSegmentChange = useCallback((track: CustomMotionTrack, index: number, segmentType: CustomMotionSegment['type']) => {
    const keyframe = track.keyframes[index];
    const nextKeyframe = track.keyframes[index + 1];
    let segment: CustomMotionSegment;
    if (segmentType === 'bezier' && nextKeyframe) {
      const dx = nextKeyframe.time - keyframe.time;
      segment = {
        type: 'bezier',
        controlPoints: [
          { time: round2(keyframe.time + dx * 0.35), value: round2(keyframe.value) },
          { time: round2(keyframe.time + dx * 0.65), value: round2(nextKeyframe.value) },
        ],
      };
    } else if (segmentType === 'stepped') {
      segment = { type: 'stepped' };
    } else if (segmentType === 'inverseStepped') {
      segment = { type: 'inverseStepped' };
    } else {
      segment = { type: 'linear' };
    }
    commit([{ type: 'set-segment', trackParameterId: track.parameterId, time: keyframe.time, segment }]);
  }, [commit]);

  const handleApplyCurvePreset = useCallback((track: CustomMotionTrack, index: number, presetId: string) => {
    const keyframe = track.keyframes[index];
    const nextKeyframe = track.keyframes[index + 1];
    if (!keyframe || !nextKeyframe) return;
    const segment = buildCurvePresetSegment(presetId, keyframe, nextKeyframe);
    if (!segment) return;
    commit([{ type: 'set-segment', trackParameterId: track.parameterId, time: keyframe.time, segment }]);
  }, [commit]);

  const handleDeleteKeyframe = useCallback((track: CustomMotionTrack, index: number) => {
    const keyframe = track.keyframes[index];
    if (index === 0) { toastError('首帧 (0.0s) 受保护，不能删除'); return; }
    commit([{ type: 'remove-keyframe', trackParameterId: track.parameterId, time: keyframe.time }]);
    setSelectedKfTime(null);
  }, [commit, setSelectedKfTime]);

  const handleDurationChange = useCallback((value: number) => {
    const next = round2(Math.max(0.1, value));
    if (next < fadeIn) {
      toastError('时长不能短于淡入时长');
      return;
    }
    commit([{ type: 'set-duration', durationSeconds: next }]);
  }, [fadeIn, commit]);

  const handleFadeChange = useCallback((value: number) => {
    commit([{ type: 'set-fade-in', fadeInSeconds: round2(clampValue(value, 0, duration)) }]);
  }, [duration, commit]);

  const handleTrackValueChange = useCallback((track: CustomMotionTrack, value: number, isTransient?: boolean) => {
    if (!Number.isFinite(value) || writeBlocked) return;
    const trackIndex = tracks.findIndex((candidate) => candidate.parameterId === track.parameterId);
    if (trackIndex < 0) return;
    const localTime = getLocalPlayheadTime();
    const keyframeIndex = track.keyframes.findIndex((candidate) => Math.abs(candidate.time - localTime) < F0_EPSILON);
    const valueRange = renderValueRange(track);
    const nextValue = valueRange.bounded ? clampValue(value, valueRange.min, valueRange.max) : value;
    const previewKeyframes = keyframeIndex >= 0
      ? track.keyframes.map((candidate, index) => (
        index === keyframeIndex ? { ...candidate, value: nextValue } : candidate
      ))
      : insertPreviewKeyframe(track, localTime, nextValue);
    if (isTransient) {
      playback?.pause?.();
      setPreviewTrackIndex(trackIndex);
      setPreviewKeyframes(previewKeyframes);
      return;
    }
    if (keyframeIndex >= 0) {
      const keyframe = track.keyframes[keyframeIndex];
      commit([{ type: 'update-keyframe', trackParameterId: track.parameterId, time: keyframe.time, value: nextValue }]);
    } else {
      commit([{ type: 'insert-keyframe', trackParameterId: track.parameterId, time: localTime, value: nextValue }]);
      updateSelection([{ parameterId: track.parameterId, time: localTime }]);
    }
    setSelectedParam(track.parameterId);
    setPreviewKeyframes(null);
    setPreviewTrackIndex(null);
  }, [commit, getLocalPlayheadTime, tracks, writeBlocked, renderValueRange, playback, updateSelection]);

  const isF0Selected = selectedKfIndex === 0;

  const handleHover = useCallback((param: string, detail: string, x: number, y: number) => {
    setTooltip({ param, detail, x, y });
  }, []);

  const handleHoverEnd = useCallback(() => {
    setTooltip(null);
  }, []);

  const handleRegisterCurveCanvas = useCallback((el: SVGSVGElement | null) => {
    curveCanvasRef.current = el;
  }, []);

  return (
    <div
      ref={rootRef}
      className={`cme${isTimeline ? ' cme--timeline' : ''}`}
      data-testid="custom-motion-editor"
      data-layout={layout}
      tabIndex={0}
      style={{
        '--cme-gutter': `${gutterWidth}px`,
        '--cme-viewport': viewportWidth > 0 ? `${viewportWidth}px` : undefined,
      } as React.CSSProperties}
      onKeyDown={handleRootKeyDown}
      onPointerDown={handleRootPointerDown}
    >
      <div
        className="cme__sticky"
        style={{ top: isTimeline ? '-8px' : undefined }}
      >
        <div className="cme__header">
          <div className="cme__identity">
            <div className="cme__title">
              <span className="cme__diamond"><DiamondIcon /></span>
              <span>自定义动作</span>
            </div>
            <span className="cme__src" title={motion.derivedFrom.key}>
              {motion.derivedFrom.key}
              <span className="cme__src-sep">·</span>
              {motion.tracks.length} 条轨道
            </span>
            {leaseState !== 'unavailable' && (
              <span className={`cme__lease${busy ? ' cme__lease--busy' : ''}`}>
                {leaseState === 'held'
                  ? '已获得编辑权'
                  : leaseState === 'pending'
                    ? '正在获取编辑权'
                    : '协作者编辑中'}
              </span>
            )}
          </div>
          <div className="cme__header-actions">
            {activeTrack && (
              <span className="cme__active-context" title="当前编辑参数">
                {getLive2DParameterDisplayName(activeTrack.parameterId)}
              </span>
            )}
          {!hideClose && (
            <button type="button" className="cme__close" aria-label="收起关键帧编辑器" title="收起关键帧编辑器" onClick={onClose}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          )}
          </div>
        </div>

        <div className="cme__navigator">
          <label className="cme__param-picker">
            <span>参数</span>
            <select
              aria-label="当前参数"
              value={selectedParam}
              onChange={(event) => selectTrack(event.target.value)}
              disabled={navigatorTracks.length === 0}
            >
              {navigatorTracks.length === 0 && <option value="">无匹配参数</option>}
              {navigatorTracks.map((track) => (
                <option key={track.parameterId} value={track.parameterId}>
                  {getLive2DParameterDisplayName(track.parameterId)}
                </option>
              ))}
            </select>
          </label>
          <div className="cme__keyframe-nav" role="group" aria-label="关键帧导航">
            <button
              type="button"
              aria-label="上一个关键帧"
              title="上一个关键帧（←）"
              onClick={() => jumpToKeyframe(-1)}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
            </button>
            <button
              type="button"
              className={`cme__keyframe-toggle${playheadKeyframeIndex !== null ? ' is-active' : ''}`}
              aria-label={playheadKeyframeIndex === null ? '在当前播放头添加关键帧' : '删除当前播放头关键帧'}
              title={playheadKeyframeIndex === 0 ? 'F0 起点必须保留，不能删除' : playheadKeyframeIndex === null ? '在当前播放头添加关键帧' : '删除当前播放头关键帧'}
              onClick={togglePlayheadKeyframe}
              disabled={!activeTrack || writeBlocked || playheadKeyframeIndex === 0}
            >
              <DiamondIcon size={11} />
            </button>
            <button
              type="button"
              aria-label="下一个关键帧"
              title="下一个关键帧（→）"
              onClick={() => jumpToKeyframe(1)}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
            </button>
          </div>
          {activeTrack && (
            <div className="cme__navigator-value" title="当前播放头处的 Motion 值">
              <span>当前值</span>
              <TrackValueControl
                track={activeTrack}
                value={samplePlayheadTrackValue(activeTrack, livePlayheadTime, blockTime, duration)}
                valueRange={renderValueRange(activeTrack)}
                canScrub={!writeBlocked}
                blockTime={blockTime}
                duration={duration}
                playheadTime={livePlayheadTime}
                onChange={(value, isTransient) => handleTrackValueChange(activeTrack, value, isTransient)}
              />
            </div>
          )}
          <div className="cme__filter-group" role="group" aria-label="参数过滤">
            <button
              type="button"
              className={`cme__filter-btn${filterMode === 'all' ? ' is-active' : ''}`}
              onClick={() => setFilterMode('all')}
              title="显示全部参数轨道"
            >
              全部 ({tracks.length})
            </button>
            <button
              type="button"
              className={`cme__filter-btn${filterMode === 'animated' ? ' is-active' : ''}`}
              onClick={() => setFilterMode('animated')}
              title="仅显示有动作变化的参数轨道"
            >
              仅动态 ({animatedTrackIds.size})
            </button>
            <input
              type="search"
              className="cme__search-input"
              placeholder="搜索参数..."
              value={filterQuery}
              onChange={(event) => setFilterQuery(event.target.value)}
              aria-label="搜索参数"
            />
          </div>
          <div className="cme__motion-settings" aria-label="Motion 设置">
            <label className="cme__num" title="动作时长（秒）">
              时长 <MotionNumberInput value={duration} min={0.1} step={0.05} disabled={writeBlocked} ariaLabel="动作时长（秒）" onCommit={handleDurationChange} />
            </label>
            <label className="cme__num" title="动作淡入（秒）">
              淡入 <MotionNumberInput value={fadeIn} min={0} max={duration} step={0.05} disabled={writeBlocked} ariaLabel="动作淡入（秒）" onCommit={handleFadeChange} />
            </label>
          </div>
          <div className="cme__toggle" role="group" aria-label="视图切换">
            <button type="button" className={view === 'lanes' ? 'is-active' : ''} onClick={() => { setView('lanes'); setSelectedKfTime(null); }} title="关键帧轨道（每参数一条）">轨道</button>
            <button type="button" className={view === 'graph' ? 'is-active' : ''} onClick={() => { setView('graph'); setSelectedKfTime(null); }} title="单参数曲线视图">曲线</button>
          </div>
        </div>

      {selection.length > 1 && (
        <div className="cme__toolbar" role="status" aria-label="关键帧选择摘要">
          <span>已选 {selection.length} 个关键帧 · {selectionByTrack.size} 个参数</span>
          <span>F{formatFrame(Math.min(...selectionState.displaySelection.map((ref) => ref.time)), fps)} – F{formatFrame(Math.max(...selectionState.displaySelection.map((ref) => ref.time)), fps)}</span>
          {selectionByTrack.size === 1 && <span>值 {selectionValueRange(displayMotion, selectionState.displaySelection)}</span>}
          <button type="button" className="btn btn--sm btn--danger cme__delete" disabled={writeBlocked || selection.every((ref) => ref.time === 0)} onClick={deleteSelection}>删除选中</button>
          <button type="button" className="cme__deselect" onClick={clearSelection}>取消选中</button>
        </div>
      )}
      {selectedKfIndex !== null && activeTrack && (
        <div className="cme__toolbar">
          <span className="cme__kf-id">
            {isF0Selected && <span className="cme__lock" aria-hidden="true"><LockIcon /></span>}
            关键帧 {selectedKfIndex + 1}
            {isF0Selected ? ' · 起点受保护' : ''}
          </span>
          <span className="cme__nav">
            <button type="button" title="跳到上一个关键帧（←）" aria-label="跳到上一个关键帧" onClick={() => jumpToKeyframe(-1)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 5l-9 7 9 7M11 5l-9 7 9 7" /></svg>
            </button>
            <button type="button" title="跳到下一个关键帧（→）" aria-label="跳到下一个关键帧" onClick={() => jumpToKeyframe(1)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 5l9 7-9 7M13 5l9 7-9 7" /></svg>
            </button>
          </span>
          <span className="cme__field">
            <span>时间</span>
            <MotionNumberInput
              step={1 / fps}
              min={0}
              max={duration}
              value={activeTrack.keyframes[selectedKfIndex].time}
              disabled={writeBlocked}
              ariaLabel="时间"
              onCommit={(value) => handleKeyframeTimeChange(activeTrack, selectedKfIndex, value)}
            />
          </span>
          <span className="cme__field">
            <span>值</span>
            <MotionNumberInput
              step={0.05}
              value={activeTrack.keyframes[selectedKfIndex].value}
              min={renderValueRange(activeTrack).bounded ? renderValueRange(activeTrack).min : undefined}
              max={renderValueRange(activeTrack).bounded ? renderValueRange(activeTrack).max : undefined}
              disabled={writeBlocked}
              ariaLabel="值"
              onCommit={(value) => handleKeyframeValueChange(activeTrack, selectedKfIndex, value)}
            />
          </span>
          {selectedKfIndex < activeTrack.keyframes.length - 1 && (
            <>
              <span className="cme__field">
                <span>插值</span>
                <select
                  disabled={writeBlocked}
                  aria-label="关键帧分段类型"
                  value={activeTrack.keyframes[selectedKfIndex].segment?.type ?? 'linear'}
                  onChange={(event) => handleSegmentChange(activeTrack, selectedKfIndex, event.target.value as CustomMotionSegment['type'])}
                >
                  <option value="linear">线性插值 (Linear)</option>
                  <option value="bezier">三次贝塞尔插值 (Cubic Bézier)</option>
                  <option value="stepped">阶跃插值 · 前值保持 (Stepped)</option>
                  <option value="inverseStepped">阶跃插值 · 后值保持 (Inverse Stepped)</option>
                </select>
              </span>
              <span className="cme__field">
                <span>缓动曲线</span>
                <select
                  disabled={writeBlocked}
                  aria-label="动画曲线预设"
                  value={resolveCurvePresetId(activeTrack.keyframes[selectedKfIndex].segment, activeTrack.keyframes[selectedKfIndex], activeTrack.keyframes[selectedKfIndex + 1])}
                  onChange={(event) => {
                    handleApplyCurvePreset(activeTrack, selectedKfIndex, event.target.value);
                  }}
                >
                  {CURVE_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
                  <option value="custom" disabled>自定义三次贝塞尔 (Custom Cubic Bézier)</option>
                  <option value="stepped" disabled>阶跃插值 · 前值保持 (Stepped)</option>
                  <option value="inverseStepped" disabled>阶跃插值 · 后值保持 (Inverse Stepped)</option>
                </select>
              </span>
            </>
          )}
          <button type="button" className="btn btn--sm btn--danger cme__delete" disabled={writeBlocked || isF0Selected} onClick={() => handleDeleteKeyframe(activeTrack, selectedKfIndex)}>
            删除
          </button>
          <button type="button" className="cme__deselect" onClick={() => setSelectedKfTime(null)}>
            取消选中
          </button>
        </div>
      )}
      </div>

      <EditorBody
        view={view}
        motion={displayMotion}
        visibleTracks={visibleTracks}
        layout={layout}
        gutterWidth={gutterWidth}
        blockTime={blockTime}
        pixelsPerSecond={pixelsPerSecond}
        playheadTime={playback ? initialBodyTime.current : livePlayheadTime}
        duration={duration}
        fadeIn={fadeIn}
        selectedParam={selectedParam}
        selectedKfTime={selectedKfTime}
        contentWidth={contentWidth}
        xOf={xOf}
        renderValueRange={renderValueRange}
        selectTrack={selectTrack}
        onLaneDragStart={startLaneDrag}
        onCurveDragStart={startCurveDrag}
        onControlPointDragStart={startControlPointDrag}
        onTrackValueChange={handleTrackValueChange}
        onHover={handleHover}
        onHoverEnd={handleHoverEnd}
        registerCurveCanvas={handleRegisterCurveCanvas}
        busy={writeBlocked}
        selectionByTrack={selectionByTrack}
        onMarqueeStart={startMarquee}
        viewport={selectionState.viewport}
        fps={fps}
        graphRange={selectionState.graphRange}
        metadataByParameter={metadataByParameter}
      />
      {selectionState.marquee && <div className="cme__marquee" data-testid="cme-marquee" style={{ left: selectionState.marquee.left, top: selectionState.marquee.top, width: selectionState.marquee.right - selectionState.marquee.left, height: selectionState.marquee.bottom - selectionState.marquee.top }} />}

      {readout && readout.text && readout.x > 0 && (
        <div className="cme-readout" style={{ left: readout.x, top: readout.y }}>{readout.text}</div>
      )}
      {tooltip && tooltip.detail && tooltip.x > 0 && (
        <div className="cme-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <span className="cme-tooltip__param">{tooltip.param}</span>
          <span className="cme-tooltip__val">{tooltip.detail}</span>
        </div>
      )}
    </div>
  );
}

interface EditorBodyProps {
  metadataByParameter: ReadonlyMap<string, Live2DParameterMetadata>;
  graphRange: { min: number; max: number } | null;
  selectionByTrack: ReadonlyMap<string, ReadonlySet<number>>;
  onMarqueeStart: (event: React.PointerEvent<SVGSVGElement>, tracks: readonly CustomMotionTrack[], graph: boolean) => void;
  viewport: { left: number; right: number } | null;
  fps: number;
  view: CustomMotionEditorView;
  motion: CustomMotion;
  visibleTracks?: readonly CustomMotionTrack[];
  layout: CustomMotionEditorLayout;
  gutterWidth: number;
  blockTime: number;
  pixelsPerSecond: number;
  playheadTime: number;
  duration: number;
  fadeIn: number;
  selectedParam: string;
  selectedKfTime: number | null;
  contentWidth: () => number;
  xOf: (localTime: number) => number;
  renderValueRange: (track: CustomMotionTrack) => { min: number; max: number };
  selectTrack: (parameterId: string) => void;
  onLaneDragStart: (event: React.PointerEvent, track: CustomMotionTrack, trackIndex: number, keyframeIndex: number) => void;
  onCurveDragStart: (event: React.PointerEvent, keyframeIndex: number) => void;
  onControlPointDragStart: (event: React.PointerEvent, keyframeIndex: number, cpIndex: 0 | 1) => void;
  onTrackValueChange: (track: CustomMotionTrack, value: number, isTransient?: boolean) => void;
  onHover: (param: string, detail: string, x: number, y: number) => void;
  onHoverEnd: () => void;
  registerCurveCanvas: (el: SVGSVGElement | null) => void;
  busy: boolean;
}

interface TrackValueControlProps {
  valueRange?: { min: number; max: number; bounded?: boolean };
  track: CustomMotionTrack;
  value: number;
  canScrub: boolean;
  blockTime: number;
  duration: number;
  playheadTime: number;
  onChange: (value: number, isTransient?: boolean) => void;
}

function samplePlayheadTrackValue(
  track: CustomMotionTrack,
  playheadTime: number,
  blockTime: number,
  duration: number,
): number {
  return evaluateCustomMotionTrack(
    track,
    clampValue(playheadTime - blockTime, 0, duration),
  ) ?? track.keyframes[0]?.value ?? 0;
}

function LiveTrackValueReadout({
  track,
  blockTime,
  duration,
  playheadTime,
}: {
  track: CustomMotionTrack;
  blockTime: number;
  duration: number;
  playheadTime: number;
}) {
  const playback = useOptionalApp()?.adapters.playback;
  const spanRef = useRef<HTMLSpanElement>(null);
  const isAnimated = useMemo(() => isTrackAnimated(track), [track]);
  const sampleRef = useRef({ track, blockTime, duration });
  sampleRef.current = { track, blockTime, duration };

  const write = useCallback((time: number) => {
    const el = spanRef.current;
    if (!el) return;
    const { track: currentTrack, blockTime: currentBlockTime, duration: currentDuration } = sampleRef.current;
    const next = String(round2(samplePlayheadTrackValue(currentTrack, time, currentBlockTime, currentDuration)));
    if (el.textContent !== next) el.textContent = next;
  }, []);

  useEffect(() => {
    if (!isAnimated) {
      if (spanRef.current) {
        spanRef.current.textContent = String(round2(track.keyframes[0]?.value ?? 0));
      }
      return;
    }
    if (!playback) return;
    return playback.subscribeTime(write);
  }, [playback, track, blockTime, duration, write, isAnimated]);

  useEffect(() => {
    if (isAnimated && !playback) write(playheadTime);
  }, [isAnimated, playback, playheadTime, write]);

  const initial = isAnimated
    ? samplePlayheadTrackValue(
        track,
        playheadTime,
        blockTime,
        duration,
      )
    : (track.keyframes[0]?.value ?? 0);

  return (
    <span ref={spanRef} className="cme__count cme__count--readonly" title="当前参数处于只读状态">
      {round2(initial)}
    </span>
  );
}

function TrackValueControl({
  track, value, canScrub, blockTime, duration, playheadTime, onChange, valueRange,
}: TrackValueControlProps) {
  const playback = useOptionalApp()?.adapters.playback;
  const [livePlayheadTime, setLivePlayheadTime] = useState(playheadTime);
  const displayName = getLive2DParameterDisplayName(track.parameterId);

  useEffect(() => {
    if (!playback || !canScrub) return;
    const write = (time: number) => setLivePlayheadTime(time);
    return playback.subscribeTime(write);
  }, [playback, canScrub]);

  useEffect(() => {
    setLivePlayheadTime((current) => current === playheadTime ? current : playheadTime);
  }, [playheadTime]);

  const displayValue = useMemo(() => round2(canScrub && playback
    ? samplePlayheadTrackValue(track, livePlayheadTime, blockTime, duration)
    : value), [canScrub, playback, track, livePlayheadTime, blockTime, duration, value]);

  if (!canScrub) {
    return (
      <LiveTrackValueReadout
        track={track}
        blockTime={blockTime}
        duration={duration}
        playheadTime={playheadTime}
      />
    );
  }
  return (
    <InlineNumericInput
      className="cme__count"
      value={displayValue}
      step="0.05"
      min={valueRange?.bounded ? String(valueRange.min) : undefined}
      max={valueRange?.bounded ? String(valueRange.max) : undefined}
      dragLabel=""
      ariaLabel={`${displayName} 当前播放头 Motion 值`}
      onChange={onChange}
    />
  );
}

function MotionNumberInput({ value, min, max, step, ariaLabel, onCommit, disabled }: {
  disabled?: boolean;
  value: number;
  min?: number;
  max?: number;
  step: number;
  ariaLabel: string;
  onCommit: (value: number) => void;
}) {
  if (disabled) {
    return <span className="cme__numeric cme__numeric--readonly" role="spinbutton" aria-label={ariaLabel} aria-disabled="true" aria-valuenow={value} aria-valuemin={min} aria-valuemax={max}>{round6(value)}</span>;
  }
  return (
    <InlineNumericInput
      className="cme__numeric"
      value={value}
      step={String(step)}
      min={min === undefined ? undefined : String(min)}
      max={max === undefined ? undefined : String(max)}
      ariaLabel={ariaLabel}
      onChange={(next, isTransient) => {
        // The shared control previews the drag locally; persist once on release.
        if (!isTransient && Number.isFinite(next) && next !== value) onCommit(next);
      }}
    />
  );
}

function EditorBody(props: EditorBodyProps) {
  if (props.view === 'graph') {
    return <CurveBody {...props} />;
  }
  return <LanesBody {...props} />;
}

interface LanesBodyProps extends EditorBodyProps {}

function LanesBody({
  motion, visibleTracks, layout, gutterWidth, blockTime, pixelsPerSecond, playheadTime, duration, fadeIn,
  selectedParam, contentWidth, xOf, selectionByTrack, onMarqueeStart, viewport, fps, metadataByParameter,
  selectTrack, onLaneDragStart, onTrackValueChange, onHover, onHoverEnd, busy,
}: LanesBodyProps) {
  const width = contentWidth();
  const isTimeline = layout === 'timeline';
  // timeline 模式：左侧让出参数名列宽度，画布零点与轨道区内容零点（100px 标签列之后）对齐
  const offsetX = isTimeline ? gutterWidth : 0;
  const showPlayhead = !isTimeline;
  const renderedTracks = visibleTracks ?? motion.tracks;
  return (
    <div className="cme__lanes" data-testid="cme-lanes">
      <div
        className="cme__lanes-inner"
        style={{
          width: `${offsetX + width}px`,
          // The lane SVG viewBox is expressed in scene pixels. In the embedded
          // timeline the parent is often wider than the scene content; letting
          // the generic min-width:100% rule stretch this element would scale
          // every marker away from the main ruler. Keep the rendered canvas at
          // its coordinate width and let the outer timeline provide scrolling.
          minWidth: isTimeline ? `${offsetX + width}px` : undefined,
        }}
      >
        {isTimeline && (
          <div
            className="cme__extent"
            data-testid="cme-extent"
            style={{ left: `${offsetX + xOf(0)}px`, width: `${Math.max(1, duration * pixelsPerSecond)}px` }}
          />
        )}
        {fadeIn > 0 && (
          <div className="cme__fade" style={{ left: `${offsetX + xOf(0)}px`, width: `${Math.min(fadeIn, duration) * pixelsPerSecond}px` }}>
            <span>淡入 {round2(fadeIn)}s</span>
          </div>
        )}
        {showPlayhead && (
          <EditorPlayhead time={playheadTime} blockTime={blockTime} duration={duration} pixelsPerSecond={pixelsPerSecond} />
        )}
        {renderedTracks.map((track) => {
          const trackIndex = motion.tracks.findIndex((candidate) => candidate.parameterId === track.parameterId);
          return (
            <LaneRow
              key={track.parameterId}
              track={motion.tracks[trackIndex] ?? track}
              trackIndex={trackIndex >= 0 ? trackIndex : 0}
              height={LANE_HEIGHT}
              width={width}
              blockTime={blockTime}
              pixelsPerSecond={pixelsPerSecond}
              isActive={track.parameterId === selectedParam}
              metadata={metadataByParameter.get(track.parameterId)}
              selectedTimes={selectionByTrack.get(track.parameterId)}
              onMarqueeStart={onMarqueeStart}
              marqueeTracks={renderedTracks}
              viewport={viewport}
              fps={fps}
              playheadTime={playheadTime}
              duration={duration}
              busy={busy}
              onSelectTrack={selectTrack}
              onDragStart={onLaneDragStart}
              onTrackValueChange={onTrackValueChange}
              onHover={onHover}
              onHoverEnd={onHoverEnd}
            />
          );
        })}
        <div className="cme__hint">拖动空白处框选 · Shift 点击增减 / 框选追加 · 拖菱形调整时间 · Delete 删除</div>
      </div>
    </div>
  );
}

interface LaneRowProps {
  metadata?: Live2DParameterMetadata;
  selectedTimes?: ReadonlySet<number>;
  onMarqueeStart: EditorBodyProps['onMarqueeStart'];
  marqueeTracks: readonly CustomMotionTrack[];
  viewport: EditorBodyProps['viewport'];
  fps: number;
  track: CustomMotionTrack;
  trackIndex: number;
  height: number;
  width: number;
  blockTime: number;
  pixelsPerSecond: number;
  isActive: boolean;
  playheadTime: number;
  duration: number;
  busy: boolean;
  onSelectTrack: (parameterId: string) => void;
  onDragStart: (event: React.PointerEvent, track: CustomMotionTrack, trackIndex: number, keyframeIndex: number) => void;
  onTrackValueChange: (track: CustomMotionTrack, value: number, isTransient?: boolean) => void;
  onHover: (param: string, detail: string, x: number, y: number) => void;
  onHoverEnd: () => void;
}

const LaneRow = memo(function LaneRow({
  track, trackIndex, height, width, blockTime, pixelsPerSecond, isActive,
  selectedTimes, onMarqueeStart, marqueeTracks, viewport, fps, metadata, playheadTime, duration, busy, onSelectTrack, onDragStart, onTrackValueChange, onHover, onHoverEnd,
}: LaneRowProps) {
  const keyframes = track.keyframes;
  const displayName = getLive2DParameterDisplayName(track.parameterId);
  const centerY = height / 2;

  const pathD = useMemo(() => {
    if (keyframes.length < 2) return '';
    const start = Math.max((blockTime + keyframes[0].time) * pixelsPerSecond, viewport?.left ?? 0);
    const end = Math.min((blockTime + keyframes[keyframes.length - 1].time) * pixelsPerSecond, viewport?.right ?? Infinity);
    return end > start ? `M ${start} ${centerY} L ${end} ${centerY}` : '';
  }, [keyframes, blockTime, pixelsPerSecond, centerY, viewport]);

  return (
    <div className={`cme__lane${isActive ? ' is-active' : ''}`} style={{ height: `${height}px` }}>
      <div className="cme__lane-label">
        <button
          type="button"
          className="cme__param-name-button"
          aria-pressed={isActive}
          onClick={() => onSelectTrack(track.parameterId)}
        >
          <span className="cme__param-name">{displayName}</span>
        </button>
        <div
          className="cme__lane-value"
          onPointerDownCapture={() => { if (!busy && !isActive) onSelectTrack(track.parameterId); }}
          onMouseDownCapture={() => { if (!busy && !isActive) onSelectTrack(track.parameterId); }}
          onFocusCapture={() => { if (!busy && !isActive) onSelectTrack(track.parameterId); }}
        >
          <TrackValueControl
            track={track}
            value={samplePlayheadTrackValue(track, playheadTime, blockTime, duration)}
            valueRange={resolveParameterRange(track, metadata)}
            canScrub={!busy}
            blockTime={blockTime}
            duration={duration}
            playheadTime={playheadTime}
            onChange={(value, isTransient) => onTrackValueChange(track, value, isTransient)}
          />
        </div>
      </div>
      <div className="cme__lane-canvas">
        <svg
          data-param={track.parameterId}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          aria-label={`${displayName} 关键帧`}
          role="img"
          onPointerDown={(event) => onMarqueeStart(event, marqueeTracks, false)}
        >
          {pathD && (
            <path
              className="cme__lane-path"
              d={pathD}
              fill="none"
              stroke="var(--accent-primary)"
              strokeWidth={isActive ? 1.6 : 1.15}
              opacity={isActive ? 0.72 : 0.38}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {visibleKeyframes(keyframes, viewport, blockTime, pixelsPerSecond).map(({ keyframe, index: keyframeIndex }) => {
            const cx = (blockTime + keyframe.time) * pixelsPerSecond;
            const isF0 = keyframeIndex === 0 && Math.abs(keyframe.time) < F0_EPSILON;
            // 仅活动轨道的同一时刻关键帧视为选中，避免其它轨道同时刻菱形误亮
            const isSelected = selectedTimes?.has(keyframe.time) ?? false;
            return (
              <KeyframeMarker
                key={`${keyframe.time}-${keyframeIndex}`}
                cx={cx}
                cy={centerY}
                index={keyframeIndex}
                isF0={isF0}
                isSelected={isSelected}
                onPointerDown={(event) => onDragStart(event, track, trackIndex, keyframeIndex)}
                onHover={(event) => {
                  const rect = (event.currentTarget as SVGGElement).getBoundingClientRect();
                  onHover(displayName, `${formatFrame(keyframe.time, fps)} 帧 · ${formatTime(keyframe.time)} · ${round2(keyframe.value)}`, rect.left + rect.width / 2, rect.top);
                }}
                onHoverEnd={onHoverEnd}
              />
            );
          })}
        </svg>
      </div>
    </div>
  );
}, (prev, next) => (
  prev.track === next.track &&
  prev.trackIndex === next.trackIndex &&
  prev.height === next.height &&
  prev.width === next.width &&
  prev.blockTime === next.blockTime &&
  prev.pixelsPerSecond === next.pixelsPerSecond &&
  prev.isActive === next.isActive &&
  prev.selectedTimes === next.selectedTimes &&
  prev.onMarqueeStart === next.onMarqueeStart &&
  prev.marqueeTracks === next.marqueeTracks &&
  prev.viewport === next.viewport &&
  prev.fps === next.fps &&
  prev.metadata === next.metadata &&
  prev.playheadTime === next.playheadTime &&
  prev.duration === next.duration &&
  prev.busy === next.busy &&
  prev.onSelectTrack === next.onSelectTrack &&
  prev.onDragStart === next.onDragStart &&
  prev.onTrackValueChange === next.onTrackValueChange &&
  prev.onHover === next.onHover &&
  prev.onHoverEnd === next.onHoverEnd
));

interface CurveBodyProps extends EditorBodyProps {}

function CurveBody({
  motion, layout, gutterWidth, blockTime, pixelsPerSecond, playheadTime, duration, fadeIn,
  selectedParam, contentWidth, xOf, renderValueRange, selectionByTrack, onMarqueeStart, viewport, fps, graphRange,
  onCurveDragStart, onControlPointDragStart,
  onHover, onHoverEnd, registerCurveCanvas,
}: CurveBodyProps) {
  const track = motion.tracks.find((candidate) => candidate.parameterId === selectedParam) ?? motion.tracks[0];
  const height = GRAPH_HEIGHT;
  const padTop = 16;
  const padBottom = 18;
  const innerHeight = height - padTop - padBottom;
  // 空轨道（协作更新中间态）时 track 为 undefined：所有 hooks 必须无条件
  // 先执行，renderValueRange 与 pathD 对 undefined 容错，之后才提前返回，
  // 否则会抛 TypeError 并触发 "Rendered fewer hooks"。
  const range = graphRange ?? renderValueRange(track);
  const yOf = (value: number) => padTop + (1 - (value - range.min) / (range.max - range.min)) * innerHeight;
  const isTimeline = layout === 'timeline';
  const offsetX = isTimeline ? gutterWidth : 0;
  const svgRef = useRef<SVGSVGElement | null>(null);

  const keyframes = track?.keyframes ?? EMPTY_KEYFRAMES;
  const pathD = useMemo(() => {
    if (!track) return '';
    const parts: string[] = [];
    const first = viewport ? Math.max(0, lowerBound(keyframes, viewport.left / pixelsPerSecond - blockTime) - 1) : 0;
    const last = viewport ? Math.min(keyframes.length - 1, lowerBound(keyframes, viewport.right / pixelsPerSecond - blockTime)) : keyframes.length - 1;
    for (let index = first; index < last; index++) {
      const a = keyframes[index];
      const b = keyframes[index + 1];
      const segment = a.segment;
      if (segment?.type === 'stepped') {
        parts.push(`M ${xOf(a.time)} ${yOf(a.value)} L ${xOf(b.time)} ${yOf(a.value)} L ${xOf(b.time)} ${yOf(b.value)}`);
      } else if (segment?.type === 'inverseStepped') {
        parts.push(`M ${xOf(a.time)} ${yOf(a.value)} L ${xOf(a.time)} ${yOf(b.value)} L ${xOf(b.time)} ${yOf(b.value)}`);
      } else if (segment?.type === 'bezier') {
        const [cp1, cp2] = segment.controlPoints;
        parts.push(`M ${xOf(a.time)} ${yOf(a.value)} C ${xOf(cp1.time)} ${yOf(cp1.value)}, ${xOf(cp2.time)} ${yOf(cp2.value)}, ${xOf(b.time)} ${yOf(b.value)}`);
      } else {
        parts.push(`M ${xOf(a.time)} ${yOf(a.value)} L ${xOf(b.time)} ${yOf(b.value)}`);
      }
    }
    return parts.join(' ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, keyframes, blockTime, pixelsPerSecond, range.min, range.max, duration, viewport]);

  if (!track) {
    return <div className="cme__empty">该动作没有可编辑的参数轨道。</div>;
  }
  const displayName = getLive2DParameterDisplayName(track.parameterId);

  const gridLines = [];
  for (let t = Math.floor(blockTime * 2) / 2; t <= blockTime + duration + 0.001; t += 0.5) {
    gridLines.push(
      <line key={`g-${t}`} x1={t * pixelsPerSecond} y1={padTop} x2={t * pixelsPerSecond} y2={height - padBottom} stroke="var(--border-subtle)" strokeDasharray={t % 1 === 0 ? 'none' : '2 3'} />,
    );
  }
  for (let i = 0; i <= 4; i++) {
    const value = range.min + (range.max - range.min) * i / 4;
    gridLines.push(
      <line key={`h-${i}`} x1={blockTime * pixelsPerSecond} y1={yOf(value)} x2={(blockTime + duration) * pixelsPerSecond} y2={yOf(value)} stroke="var(--border-subtle)" strokeDasharray="2 4" />,
    );
  }
  gridLines.push(
    <line key="zero" x1={blockTime * pixelsPerSecond} y1={yOf(0)} x2={(blockTime + duration) * pixelsPerSecond} y2={yOf(0)} stroke="var(--border-highlight)" opacity="0.55" />,
  );

  return (
    <div className="cme__curve-wrap" data-testid="cme-curve">
      <div style={{ position: 'relative', marginLeft: offsetX, width: contentWidth() }}>
        <svg
          ref={(el) => {
            svgRef.current = el;
            registerCurveCanvas(el);
          }}
          className="cme__curve-canvas"
          viewBox={`0 0 ${contentWidth()} ${height}`}
          preserveAspectRatio="none"
          aria-label={`${displayName} 关键帧曲线`}
          role="img"
          width={contentWidth()}
          height={height}
          onPointerDown={(event) => onMarqueeStart(event, [track], true)}
        >
          {gridLines}
          {pathD && (
            <path
              className="cme__curve-path"
              d={pathD}
              fill="none"
              stroke="var(--accent-primary)"
              strokeWidth="2"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {visibleKeyframes(keyframes, viewport, blockTime, pixelsPerSecond).map(({ keyframe, index: keyframeIndex }) => {
            const next = keyframes[keyframeIndex + 1];
            const isF0 = keyframeIndex === 0 && Math.abs(keyframe.time) < F0_EPSILON;
            const isSelected = selectionByTrack.get(track.parameterId)?.has(keyframe.time) ?? false;
            const cx = xOf(keyframe.time);
            const cy = yOf(keyframe.value);
            const handles = keyframe.segment?.type === 'bezier' && next
              ? keyframe.segment.controlPoints
              : null;
            return (
              <g key={`${keyframe.time}-${keyframeIndex}`}>
                {handles && (
                  <>
                    {handles.map((point, handleIndex) => (
                      <g key={`cp-${handleIndex}`} data-cp={`${keyframeIndex}-${handleIndex}`} aria-hidden="true">
                        <line
                          className="cme__bezier-arm"
                          x1={handleIndex === 0 ? cx : xOf(next.time)}
                          y1={handleIndex === 0 ? cy : yOf(next.value)}
                          x2={xOf(point.time)}
                          y2={yOf(point.value)}
                        />
                        <circle
                          className="cme__bezier-handle"
                          cx={xOf(point.time)}
                          cy={yOf(point.value)}
                          r="3.5"
                          onPointerDown={(event) => onControlPointDragStart(event, keyframeIndex, handleIndex === 0 ? 0 : 1)}
                        />
                      </g>
                    ))}
                  </>
                )}
                <KeyframeMarker
                  cx={cx}
                  cy={cy}
                  index={keyframeIndex}
                  isF0={isF0}
                  isSelected={isSelected}
                  size={isSelected ? 6.5 : 5.5}
                  onPointerDown={(event) => onCurveDragStart(event, keyframeIndex)}
                  onHover={(event) => {
                    const rect = (event.currentTarget as SVGGElement).getBoundingClientRect();
                    onHover(displayName, `${formatFrame(keyframe.time, fps)} 帧 · ${formatTime(keyframe.time)} · ${round2(keyframe.value)}`, rect.left + rect.width / 2, rect.top);
                  }}
                  onHoverEnd={onHoverEnd}
                />
              </g>
            );
          })}
        </svg>
        <div className="cme__curve-hint">拖动空白处框选 · Shift 点击增减 / 拖动中锁定方向 · 拖菱形改时间/数值 · F0 不可删除</div>
        {fadeIn > 0 && (
          <div
            className="cme__fade cme__fade--curve"
            style={{ left: `${xOf(0)}px`, width: `${Math.min(fadeIn, duration) * pixelsPerSecond}px` }}
          />
        )}
        {!isTimeline && (
          <EditorPlayhead time={playheadTime} blockTime={blockTime} duration={duration} pixelsPerSecond={pixelsPerSecond} />
        )}
      </div>
    </div>
  );
}

function KeyframeMarker({
  cx,
  cy,
  index,
  isF0,
  isSelected,
  size = isSelected ? 6 : 5,
  onPointerDown,
  onHover,
  onHoverEnd,
}: {
  cx: number;
  cy: number;
  index: number;
  isF0: boolean;
  isSelected: boolean;
  size?: number;
  onPointerDown: (event: React.PointerEvent) => void;
  onHover: (event: React.MouseEvent<SVGGElement>) => void;
  onHoverEnd: () => void;
}) {
  return (
    <g
      data-kf={index}
      data-f0={isF0 ? 'true' : undefined}
      data-selected={isSelected ? 'true' : undefined}
      className={`cme__kf${isSelected ? ' is-selected' : ''}${isF0 ? ' is-f0' : ''}`}
      style={{ cursor: 'grab' }}
      onPointerDown={onPointerDown}
      onMouseEnter={onHover}
      onMouseLeave={onHoverEnd}
    >
      {isF0 && (
        <circle
          className="cme__kf-halo"
          cx={cx}
          cy={cy}
          r="9"
          fill="none"
        />
      )}
      <path
        className="cme__kf-diamond"
        d={`M ${cx} ${cy - size} L ${cx + size} ${cy} L ${cx} ${cy + size} L ${cx - size} ${cy} Z`}
        fill={isSelected ? 'var(--accent-primary)' : 'var(--bg-elevated)'}
        stroke={isSelected ? 'var(--accent-hover)' : isF0 ? 'var(--accent-secondary)' : 'var(--accent-primary)'}
        strokeWidth={isSelected ? 1.8 : 1.5}
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={cx} cy={cy} r="10" fill="transparent" />
    </g>
  );
}

export function DiamondIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 3l2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6z" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
  );
}

let toastError: (message: string) => void = (message) => showToast(message, 'error');

/** Register a toast sink (UI host injects the app toast implementation). */
export function setCustomMotionEditorToastSink(sink: (message: string) => void): void {
  toastError = sink;
}

function formatTime(t: number): string {
  return `${Math.max(0, t).toFixed(2)}s`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function clampValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Build the optimistic shape used while editing a value at a playhead that
 * does not yet have a keyframe. The authoring command performs the canonical
 * Bezier split on commit; the UI only needs a stable preview point here.
 */
function insertPreviewKeyframe(
  track: CustomMotionTrack,
  time: number,
  value: number,
): readonly CustomMotionKeyframe[] {
  const keyframes = [...track.keyframes];
  const insertionIndex = keyframes.findIndex((keyframe) => keyframe.time > time);
  const index = insertionIndex < 0 ? keyframes.length : insertionIndex;
  const inserted: CustomMotionKeyframe = {
    time,
    value,
    ...(index < keyframes.length ? { segment: { type: 'linear' as const } } : {}),
  };
  keyframes.splice(index, 0, inserted);
  if (index > 0 && index === keyframes.length - 1 && !keyframes[index - 1].segment) {
    keyframes[index - 1] = { ...keyframes[index - 1], segment: { type: 'linear' } };
  }
  return keyframes;
}

function formatFrame(time: number, fps: number): string {
  return String(Math.round(time * fps * 1000) / 1000);
}
function selectionValueRange(motion: CustomMotion, refs: readonly CustomMotionKeyframeRef[]): string {
  const times = new Set(refs.map((ref) => ref.time));
  const values = motion.tracks.find((track) => track.parameterId === refs[0].parameterId)?.keyframes.filter((kf) => times.has(kf.time)).map((kf) => kf.value) ?? [];
  return `${round2(Math.min(...values))} – ${round2(Math.max(...values))}`;
}
function visibleKeyframes(keyframes: readonly CustomMotionKeyframe[], viewport: EditorBodyProps['viewport'], blockTime: number, pps: number) {
  const start = viewport ? lowerBound(keyframes, viewport.left / pps - blockTime) : 0;
  const end = viewport ? lowerBound(keyframes, viewport.right / pps - blockTime) : keyframes.length;
  return keyframes.slice(start, end).map((keyframe, offset) => ({ keyframe, index: start + offset }));
}

function EditorPlayhead({ time, blockTime, duration, pixelsPerSecond }: { time: number; blockTime: number; duration: number; pixelsPerSecond: number }) {
  const playback = useOptionalApp()?.adapters.playback;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const write = (sceneTime: number) => {
      if (!ref.current) return;
      ref.current.style.left = `${sceneTime * pixelsPerSecond}px`;
      ref.current.hidden = sceneTime < blockTime || sceneTime > blockTime + duration;
    };
    write(time);
    return playback?.subscribeTime(write);
  }, [time, playback, blockTime, duration, pixelsPerSecond]);
  return <div ref={ref} className="cme__playhead" hidden={time < blockTime || time > blockTime + duration} style={{ left: `${time * pixelsPerSecond}px` }} />;
}
