import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CharacterMotionOutput,
  CustomMotionSegment,
  CustomMotionTrack,
} from '../../api/types/semantic-scene';
import type { CustomMotionEditIntent, CustomMotionEditSessionSnapshot } from '../../services/timeline-authoring/CustomMotionEditingTypes';
import { CURVE_PRESETS, resolveCurvePresetId } from './curvePresets';
import { showToast } from '../Toast';
import { getLive2DParameterDisplayName } from './live2dParameterPresentation';
import './CustomMotionEditor.css';
import { CustomMotionDisplay } from './CustomMotionDisplay';
import { TrackValueControl, MotionNumberInput } from './CustomMotionReadouts';
import { F0_EPSILON, isTrackAnimated, samplePlayheadTrackValue, round2, clampValue, formatFrame } from './customMotionDisplayValues';
import type { Live2DParameterMetadata } from '../../api/types/live2d-parameter-animation';
import { useCustomMotionGestures } from './useCustomMotionGestures';
import { resolveParameterRange, createGroupMoveResolver } from './customMotionSelection';
interface SelectionRef { parameterId: string; time: number }

export { isTrackAnimated } from './customMotionDisplayValues';

export type CustomMotionEditorView = 'lanes' | 'graph';
export type CustomMotionEditorLayout = 'panel' | 'timeline';

export interface CustomMotionEditorProps {
  snapshot: CustomMotionEditSessionSnapshot;
  parameterMetadata?: readonly Live2DParameterMetadata[];
  scrollContainer?: HTMLElement | null;
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
  /** Optional scene seek (playhead jump). */
  onSeek?: (sceneTime: number) => void;
  /** Hide the close button when embedded in a fixed host. */
  hideClose?: boolean;
  /** Show collaborative edit lease status in the editor header. */
  showLeaseStatus?: boolean;
  onClose?: () => void;
}

const EMPTY_PARAMETER_METADATA: readonly Live2DParameterMetadata[] = [];

type CustomMotion = Extract<CharacterMotionOutput, { kind: 'custom' }>;

function findPlayheadKeyframeIndex(track: CustomMotionTrack, localTime: number, fps: number): number {
  // Preserve native subframe points before looking for an authored frame.
  const exactIndex = track.keyframes.findIndex((point) => Math.abs(point.time - localTime) < F0_EPSILON);
  if (exactIndex >= 0) return exactIndex;
  const frameTime = Math.round(localTime * fps) / fps;
  return track.keyframes.findIndex((point) => Math.abs(point.time - frameTime) < 1e-9);
}

export function CustomMotionEditor({
  snapshot,
  parameterMetadata = EMPTY_PARAMETER_METADATA,
  scrollContainer,
  pixelsPerSecond,
  layout = 'panel',
  gutterWidth = 100,
  minContentWidth = 0,
  viewportWidth = 0,
  playheadTime,
  onSeek,
  hideClose = false,
  showLeaseStatus = false,
  onClose,
}: CustomMotionEditorProps) {
  const motion = snapshot.canonicalMotion!;
  const fps = snapshot.fps;
  const blockTime = snapshot.target?.blockTime ?? 0;
  const busy = snapshot.state === 'readonly' || snapshot.state === 'closed';
  const leaseState = snapshot.state;
  const [view, setView] = useState<CustomMotionEditorView>('lanes');
  const [filterMode, setFilterMode] = useState<'all' | 'animated'>('all');
  const [filterQuery, setFilterQuery] = useState('');
  const [selectedParam, setSelectedParam] = useState<string>(motion.tracks[0]?.parameterId ?? '');
  const [tooltip, setTooltip] = useState<{ param: string; detail: string; x: number; y: number } | null>(null);
  const isTimeline = layout === 'timeline';
  const rootRef = useRef<HTMLDivElement>(null);

  const tracks = motion.tracks;
  const duration = motion.durationSeconds;
  const fadeIn = motion.fadeInSeconds;
  const firstTrackParam = tracks[0]?.parameterId ?? '';
  const selectedTrackExists = tracks.some((track) => track.parameterId === selectedParam);

  const metadataByParameter = useMemo(() => new Map(parameterMetadata.map((metadata) => [metadata.id, metadata])), [parameterMetadata]);
  const renderValueRange = useCallback((track: CustomMotionTrack | undefined) => resolveParameterRange(track, track ? metadataByParameter.get(track.parameterId) : undefined), [metadataByParameter]);
  const gestures = useCustomMotionGestures({
    snapshot, view, filterMode, filterQuery, layout, playheadTime, onSeek, blockTime, pps: pixelsPerSecond, root: rootRef, scrollContainer,
    selectParam: setSelectedParam, range: renderValueRange, onError: (message) => toastError(message),
  });
  const { selection, selectionByTrack, select: updateSelection, clear: clearSelection, writeBlocked, readout,
    commit: commitAsync, preview, keyframeRef, playhead } = gestures;
  const { time: livePlayheadTime, bodyTime, getLocalTime: getLocalPlayheadTime, seek: seekToScene } = playhead;
  const commit = useCallback((intent: CustomMotionEditIntent) => {
    void commitAsync(intent).catch(() => {});
  }, [commitAsync]);
  const selectedKfTime = selection.length === 1 && selection[0].parameterId === selectedParam ? selection[0].time : null;
  const setSelectedKfTime = useCallback((time: number | null) => {
    updateSelection(time === null ? [] : [{ parameterId: selectedParam, time }]);
  }, [selectedParam, updateSelection]);

  useEffect(() => {
    if (selectedTrackExists) return;
    setSelectedParam(firstTrackParam);
    setSelectedKfTime(null);
  }, [firstTrackParam, selectedTrackExists, setSelectedKfTime]);

  const activeTrack = useMemo(
    () => tracks.find((track) => track.parameterId === selectedParam) ?? tracks[0] ?? null,
    [tracks, selectedParam],
  );

  const selectedKfIndex = useMemo(() => {
    if (selectedKfTime === null || !activeTrack) return null;
    const index = activeTrack.keyframes.findIndex((keyframe) => keyframe.time === selectedKfTime);
    return index >= 0 ? index : null;
  }, [selectedKfTime, activeTrack]);

  const selectTrack = useCallback((parameterId: string) => {
    setSelectedParam(parameterId);
    clearSelection();
  }, [clearSelection]);

  const playheadKeyframeIndex = useMemo(() => {
    // The ref preserves event-before-render precision; state still invalidates this cached lookup.
    void livePlayheadTime;
    if (!activeTrack) return null;
    const localTime = getLocalPlayheadTime();
    const index = findPlayheadKeyframeIndex(activeTrack, localTime, fps);
    return index >= 0 ? index : null;
  }, [activeTrack, getLocalPlayheadTime, livePlayheadTime, fps]);

  const togglePlayheadKeyframe = useCallback(() => {
    if (!activeTrack || busy) return;
    const localTime = getLocalPlayheadTime();
    const index = findPlayheadKeyframeIndex(activeTrack, localTime, fps);
    if (index >= 0) {
      if (index === 0) {
        toastError('首帧 (0.0s) 受保护，不能删除');
        return;
      }
      commit({ type: 'remove-keyframe', keyframe: keyframeRef(activeTrack.parameterId, activeTrack.keyframes[index].time) });
      setSelectedKfTime(null);
      return;
    }
    const value = round2(samplePlayheadTrackValue(activeTrack, blockTime + localTime, blockTime, duration));
    const frame = Math.round(localTime * fps);
    void commitAsync({ type: 'insert-keyframe', parameterId: activeTrack.parameterId, frame, value })
      .then(() => setSelectedKfTime(frame / fps)).catch(() => {});
  }, [activeTrack, blockTime, busy, commit, commitAsync, duration, fps, getLocalPlayheadTime, keyframeRef, setSelectedKfTime]);

  const jumpToKeyframe = useCallback((dir: -1 | 1) => {
    if (!activeTrack) return;
    let targetIndex: number;
    if (selectedKfTime !== null) {
      const currentIndex = activeTrack.keyframes.findIndex((keyframe) => Math.abs(keyframe.time - selectedKfTime) < F0_EPSILON);
      if (currentIndex < 0) return;
      targetIndex = dir < 0 ? currentIndex - 1 : currentIndex + 1;
    } else {
      const localTime = getLocalPlayheadTime();
      const exactIndex = findPlayheadKeyframeIndex(activeTrack, localTime, fps);
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
  }, [activeTrack, blockTime, fps, getLocalPlayheadTime, seekToScene, selectedKfTime, setSelectedKfTime]);

  // 键盘事件由编辑器根节点自己接管（根节点可聚焦）：焦点在编辑器内时，
  // 全局快捷键（如 Delete 删除动作块）会被忽略，避免与关键帧编辑冲突。
  const deleteSelection = useCallback(() => {
    if (writeBlocked) return;
    const removable = selection.filter((ref) => ref.time !== 0);
    if (removable.length !== selection.length) toastError('F0 起点受保护，仅删除其他选中关键帧');
    if (!removable.length) return;
    commit({ type: 'batch', intents: removable.map((ref) => ({ type: 'remove-keyframe', keyframe: keyframeRef(ref.parameterId, ref.time) })) });
    clearSelection();
  }, [selection, writeBlocked, commit, clearSelection, keyframeRef]);
  const handleRootKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (event.defaultPrevented || target?.closest('input, select, textarea, [contenteditable="true"], [role="spinbutton"]')) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); clearSelection(); return; }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); event.stopPropagation(); jumpToKeyframe(event.key === 'ArrowLeft' ? -1 : 1);
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selection.length) {
      event.preventDefault(); event.stopPropagation(); deleteSelection();
    }
  }, [clearSelection, jumpToKeyframe, selection.length, deleteSelection]);

  const handleRootPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, select, textarea, button, [role="spinbutton"]')) return;
    rootRef.current?.focus();
  }, []);

  const displayMotion = gestures.motion;

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

  const handleKeyframeTimeChange = useCallback((track: CustomMotionTrack, index: number, value: number) => {
    if (!Number.isFinite(value) || writeBlocked) return;
    const point = track.keyframes[index];
    const refs = [{ parameterId: track.parameterId, time: point.time }];
    const resolve = createGroupMoveResolver(tracks, refs, duration, fps, true);
    const nextTime = point.time + resolve((value - point.time) * fps) / fps;
    if (nextTime === point.time) return;
    commit({ type: 'update-keyframe', keyframe: keyframeRef(track.parameterId, point.time), value: point.value, frame: Math.round(nextTime * fps) });
    updateSelection([{ parameterId: track.parameterId, time: nextTime }]);
  }, [duration, fps, commit, updateSelection, writeBlocked, tracks, keyframeRef]);

  const handleKeyframeValueChange = useCallback((track: CustomMotionTrack, index: number, value: number) => {
    const keyframe = track.keyframes[index];
    if (!Number.isFinite(value) || writeBlocked) return;
    const range = renderValueRange(track);
    commit({ type: 'update-keyframe', keyframe: keyframeRef(track.parameterId, keyframe.time), value: range.bounded ? clampValue(value, range.min, range.max) : value });
  }, [commit, writeBlocked, renderValueRange, keyframeRef]);

  const handleSegmentChange = useCallback((track: CustomMotionTrack, index: number, segmentType: CustomMotionSegment['type']) => {
    const keyframe = track.keyframes[index];
    const nextKeyframe = track.keyframes[index + 1];
    if (!nextKeyframe) return;
    commit({ type: 'set-curve', keyframe: keyframeRef(track.parameterId, keyframe.time), curve: segmentType });
  }, [commit, keyframeRef]);

  const handleApplyCurvePreset = useCallback((track: CustomMotionTrack, index: number, presetId: string) => {
    const keyframe = track.keyframes[index];
    const nextKeyframe = track.keyframes[index + 1];
    if (!keyframe || !nextKeyframe) return;
    commit({ type: 'set-curve-preset', keyframe: keyframeRef(track.parameterId, keyframe.time), presetId });
  }, [commit, keyframeRef]);

  const handleDeleteKeyframe = useCallback((track: CustomMotionTrack, index: number) => {
    const keyframe = track.keyframes[index];
    if (index === 0) { toastError('首帧 (0.0s) 受保护，不能删除'); return; }
    commit({ type: 'remove-keyframe', keyframe: keyframeRef(track.parameterId, keyframe.time) });
    setSelectedKfTime(null);
  }, [commit, setSelectedKfTime, keyframeRef]);

  const handleDurationChange = useCallback((value: number) => {
    const next = Math.max(1, Math.round(value * fps)) / fps;
    if (next < fadeIn) {
      toastError('时长不能短于淡入时长');
      return;
    }
    commit({ type: 'set-duration', frames: Math.round(next * fps) });
  }, [fadeIn, commit, fps]);

  const handleFadeChange = useCallback((value: number) => {
    commit({ type: 'set-fade-in', frames: Math.round(clampValue(value, 0, duration) * fps) });
  }, [duration, commit, fps]);

  const handleTrackValueChange = useCallback((track: CustomMotionTrack, value: number, isTransient?: boolean) => {
    if (!Number.isFinite(value) || writeBlocked) return;
    const trackIndex = tracks.findIndex((candidate) => candidate.parameterId === track.parameterId);
    if (trackIndex < 0) return;
    const localTime = getLocalPlayheadTime();
    const keyframeIndex = findPlayheadKeyframeIndex(track, localTime, fps);
    const valueRange = renderValueRange(track);
    const nextValue = valueRange.bounded ? clampValue(value, valueRange.min, valueRange.max) : value;
    const intent: CustomMotionEditIntent = keyframeIndex >= 0
      ? { type: 'update-keyframe', keyframe: keyframeRef(track.parameterId, track.keyframes[keyframeIndex].time), value: nextValue }
      : { type: 'insert-keyframe', parameterId: track.parameterId, frame: Math.round(localTime * fps), value: nextValue };
    if (isTransient) {
      try { preview(intent); } catch (error) { toastError(error instanceof Error ? error.message : '预览失败'); }
      return;
    }
    if (keyframeIndex < 0) {
      const time = Math.round(localTime * fps) / fps;
      // Select only after the canonical revision contains the new point;
      // selection validation drops references absent from the old revision.
      void commitAsync(intent).then(() => updateSelection([{ parameterId: track.parameterId, time }])).catch(() => {});
    } else commit(intent);
    setSelectedParam(track.parameterId);
  }, [commit, commitAsync, getLocalPlayheadTime, tracks, writeBlocked, renderValueRange, updateSelection, keyframeRef, fps, preview]);

  const isF0Selected = selectedKfIndex === 0;

  const handleHover = useCallback((param: string, detail: string, x: number, y: number) => {
    setTooltip({ param, detail, x, y });
  }, []);

  const handleHoverEnd = useCallback(() => {
    setTooltip(null);
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
            {showLeaseStatus && leaseState !== 'closed' && (
              <span className={`cme__lease${busy ? ' cme__lease--busy' : ''}`}>
                {leaseState === 'held'
                  ? '已获得编辑权'
                  : leaseState === 'pending'
                    ? '正在获取编辑权'
                    : '只读，请重新打开编辑器'}
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
              时长 <MotionNumberInput value={duration} min={1 / fps} step={1 / fps} disabled={writeBlocked} ariaLabel="动作时长（秒）" onCommit={handleDurationChange} />
            </label>
            <label className="cme__num" title="动作淡入（秒）">
              淡入 <MotionNumberInput value={fadeIn} min={0} max={duration} step={1 / fps} disabled={writeBlocked} ariaLabel="动作淡入（秒）" onCommit={handleFadeChange} />
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
          <span>F{formatFrame(Math.min(...gestures.displaySelection.map((ref) => ref.time)), fps)} – F{formatFrame(Math.max(...gestures.displaySelection.map((ref) => ref.time)), fps)}</span>
          {selectionByTrack.size === 1 && <span>值 {selectionValueRange(displayMotion, gestures.displaySelection)}</span>}
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

      <CustomMotionDisplay
        view={view}
        motion={displayMotion}
        visibleTracks={visibleTracks}
        layout={layout}
        gutterWidth={gutterWidth}
        blockTime={blockTime}
        pixelsPerSecond={pixelsPerSecond}
        width={Math.max(600, (blockTime + duration) * pixelsPerSecond + 200, minContentWidth)}
        playheadTime={bodyTime}
        selectedParam={selectedParam}
        selectTrack={selectTrack}
        onTrackValueChange={handleTrackValueChange}
        onHover={handleHover}
        onHoverEnd={handleHoverEnd}
        gestures={gestures}
        fps={fps}
        metadataByParameter={metadataByParameter}
      />
      {gestures.marquee && <div className="cme__marquee" data-testid="cme-marquee" style={{ left: gestures.marquee.left, top: gestures.marquee.top, width: gestures.marquee.right - gestures.marquee.left, height: gestures.marquee.bottom - gestures.marquee.top }} />}

      {readout && readout.x > 0 && (
        <div className="cme-readout" style={{ left: readout.x, top: readout.y }}>{formatFrame(readout.time, fps)} 帧 · {round2(readout.value)}</div>
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

function selectionValueRange(motion: CustomMotion, refs: readonly SelectionRef[]): string {
  const times = new Set(refs.map((ref) => ref.time));
  const values = motion.tracks.find((track) => track.parameterId === refs[0].parameterId)?.keyframes.filter((kf) => times.has(kf.time)).map((kf) => kf.value) ?? [];
  return `${round2(Math.min(...values))} – ${round2(Math.max(...values))}`;
}
