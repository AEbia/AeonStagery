import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import type { CharacterMotionOutput, CustomMotionKeyframe, CustomMotionTrack } from '../../api/types/semantic-scene';
import type { Live2DParameterMetadata } from '../../api/types/live2d-parameter-animation';
import { useOptionalApp } from '../context/AppContext';
import { getLive2DParameterDisplayName } from './live2dParameterPresentation';
import { lowerBound, resolveParameterRange } from './customMotionSelection';
import type { CustomMotionGestures } from './useCustomMotionGestures';
import { TrackValueControl } from './CustomMotionReadouts';
import { F0_EPSILON, samplePlayheadTrackValue, formatFrame, formatTime, round2 } from './customMotionDisplayValues';

const LANE_HEIGHT = 28;
const GRAPH_HEIGHT = 156;
const EMPTY_KEYFRAMES: readonly CustomMotionKeyframe[] = [];

interface CustomMotionDisplayProps {
  view: 'lanes' | 'graph';
  motion: Extract<CharacterMotionOutput, { kind: 'custom' }>;
  visibleTracks: readonly CustomMotionTrack[];
  layout: 'panel' | 'timeline';
  gutterWidth: number;
  blockTime: number;
  pixelsPerSecond: number;
  width: number;
  playheadTime: number;
  selectedParam: string;
  fps: number;
  metadataByParameter: ReadonlyMap<string, Live2DParameterMetadata>;
  gestures: Pick<CustomMotionGestures, 'selectionByTrack' | 'startMarquee' | 'viewport' | 'graphRange' | 'writeBlocked' | 'startMove' | 'startControlPoint'>;
  selectTrack: (parameterId: string) => void;
  onTrackValueChange: (track: CustomMotionTrack, value: number, isTransient?: boolean) => void;
  onHover: (param: string, detail: string, x: number, y: number) => void;
  onHoverEnd: () => void;
}

export function CustomMotionDisplay(props: CustomMotionDisplayProps) {
  if (props.view === 'graph') {
    return <CurveBody {...props} />;
  }
  return <LanesBody {...props} />;
}

function LanesBody({
  motion, visibleTracks, layout, gutterWidth, blockTime, pixelsPerSecond, playheadTime,
  selectedParam, width, gestures, fps, metadataByParameter,
  selectTrack, onTrackValueChange, onHover, onHoverEnd,
}: CustomMotionDisplayProps) {
  const { selectionByTrack, startMarquee: onMarqueeStart, viewport, writeBlocked: busy, startMove } = gestures;
  const { durationSeconds: duration, fadeInSeconds: fadeIn } = motion;
  const xOf = (localTime: number) => (blockTime + localTime) * pixelsPerSecond;
  const onLaneDragStart = useCallback((event: React.PointerEvent, track: CustomMotionTrack, _trackIndex: number, index: number) => {
    onHoverEnd();
    startMove(event, track, false, track.keyframes[index].time);
  }, [startMove, onHoverEnd]);
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
  onMarqueeStart: CustomMotionGestures['startMarquee'];
  marqueeTracks: readonly CustomMotionTrack[];
  viewport: CustomMotionGestures['viewport'];
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

function CurveBody({
  motion, layout, gutterWidth, blockTime, pixelsPerSecond, playheadTime, width,
  selectedParam, gestures, fps, metadataByParameter, onHover, onHoverEnd,
}: CustomMotionDisplayProps) {
  const { selectionByTrack, startMarquee: onMarqueeStart, viewport, graphRange } = gestures;
  const { durationSeconds: duration, fadeInSeconds: fadeIn } = motion;
  const xOf = (localTime: number) => (blockTime + localTime) * pixelsPerSecond;
  const track = motion.tracks.find((candidate) => candidate.parameterId === selectedParam) ?? motion.tracks[0];
  const height = GRAPH_HEIGHT;
  const padTop = 16;
  const padBottom = 18;
  const innerHeight = height - padTop - padBottom;
  // 空轨道（协作更新中间态）时 track 为 undefined：所有 hooks 必须无条件
  // 先执行，range 与 pathD 对 undefined 容错，之后才提前返回，
  // 否则会抛 TypeError 并触发 "Rendered fewer hooks"。
  const range = graphRange ?? resolveParameterRange(track, track ? metadataByParameter.get(track.parameterId) : undefined);
  const yOf = (value: number) => padTop + (1 - (value - range.min) / (range.max - range.min)) * innerHeight;
  const isTimeline = layout === 'timeline';
  const offsetX = isTimeline ? gutterWidth : 0;

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
      <div style={{ position: 'relative', marginLeft: offsetX, width: width }}>
        <svg
          className="cme__curve-canvas"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          aria-label={`${displayName} 关键帧曲线`}
          role="img"
          width={width}
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
                          onPointerDown={(event) => gestures.startControlPoint(event, track, keyframeIndex, handleIndex === 0 ? 0 : 1)}
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
                  onPointerDown={(event) => { onHoverEnd(); gestures.startMove(event, track, true, keyframe.time); }}
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

function visibleKeyframes(keyframes: readonly CustomMotionKeyframe[], viewport: CustomMotionGestures['viewport'], blockTime: number, pps: number) {
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
