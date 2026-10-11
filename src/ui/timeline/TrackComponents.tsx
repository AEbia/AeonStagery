import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { ActionIcons } from './TimelineConstants';
import { IconChevronDown, IconChevronRight, IconError, IconPlus, IconUsers, IconWarning } from '../icons';
import type { SceneStatement } from '../../api/types/semantic-scene';
import { isCharacterPerformancePlaceholderParams } from '../../services/semantic-scene';
import type { TimelineAction } from './semanticTimelineTypes';
import { EasingOverlay } from './EasingOverlay';
import { useActionValidationSeverity } from '../store/storeHooks';
import { useValidationStore } from '../context/AppContext';
import type { SummarySegment } from './timelineDensity';
import { getTimelineActionDuration } from './timelineDensity';
import {
  getLifecycleBoundaryPresentationMetrics,
  LIFECYCLE_BOUNDARY_PAD_PX,
} from './lifecycleBoundaryPresentation';
import {
  getLifecyclePairRelationshipSegments,
  getTimelineRelationshipCurve,
} from './lifecyclePairRelationshipGeometry';

/**
 * ADR-0022 placeholder timeline action: an uncompiled raw characterPerformance
 * display action whose exact empty-string motion marks the performance slot as
 * "pending a motion choice". Derived — any filled motion stops being a
 * placeholder.
 */
export function isPlaceholderTimelineAction(action: TimelineAction | { action: string; semanticType?: string; params?: Record<string, unknown>; sourceParams?: Record<string, unknown> } | undefined): boolean {
  if (!action) return false;
  const params = (action as { sourceParams?: Record<string, unknown> }).sourceParams
    ?? (action as { params?: Record<string, unknown> }).params;
  return (action as { semanticType?: string }).semanticType === 'characterPerformance'
    && isCharacterPerformancePlaceholderParams(params as { motion?: unknown });
}

export function getTrackColorForAction(action: TimelineAction | { action: string }): string {
  const semanticCategory = 'semanticCategory' in action ? action.semanticCategory : undefined;
  if (semanticCategory === 'dialogue') return 'var(--color-dialogue)';
  if (semanticCategory === 'character') return 'var(--color-character)';
  if (semanticCategory === 'camera') return 'var(--color-camera)';
  if (semanticCategory === 'audio') return 'var(--color-audio)';
  if (semanticCategory === 'scene' || semanticCategory === 'visual' || semanticCategory === 'layer') return 'var(--color-environment)';

  if ([
    'setEnvironmentLayer',
    'transformEnvironmentLayer',
    'removeEnvironmentLayer',
    'addLensFilter',
    'changeLensFilter',
    'resetLensFilters',
    'setCompositeRecipe',
    'modulateComposite',
  ].includes(action.action)) return 'var(--color-environment)';
  if (action.action === 'dialogue') return 'var(--color-dialogue)';
  if ([
    'playMotion', 'addCharacter', 'transformCharacter',
    'removeCharacter', 'setExpression', 'characterLookAt', 'characterBlink',
  ].includes(action.action)) {
    return 'var(--color-character)';
  }
  if (action.action.startsWith('camera')) return 'var(--color-camera)';
  if (['playAudio', 'stopAudio', 'setBGM', 'addImage', 'transformImage', 'removeImage'].includes(action.action)) return 'var(--color-audio)';
  return 'var(--color-environment)';
}

/** Weak pair line between two ordinary boundary statements (select/hover only). */
export const LifecyclePairRelationshipRail = React.memo(({
  startTime,
  endTime,
  pixelsPerSecond,
  startLaneIndex,
  endLaneIndex,
  isActive,
  colorAction,
}: {
  startTime: number;
  endTime: number;
  pixelsPerSecond: number;
  startLaneIndex: number;
  endLaneIndex: number;
  isActive: boolean;
  colorAction: TimelineAction;
}) => {
  if (!isActive) return null;
  const segments = getLifecyclePairRelationshipSegments({
    startTime,
    endTime,
    pixelsPerSecond,
    startLaneIndex,
    endLaneIndex,
  });
  if (segments.length === 0) return null;
  return (
    <>
      {segments.map((segment, index) => (
        <span
          key={`${segment.orientation}:${index}`}
          className="lifecycle-pair-relationship-line is-active"
          aria-hidden="true"
          style={{
            '--track-color': getTrackColorForAction(colorAction),
            left: `${segment.left}px`,
            top: `${segment.top}px`,
            width: `${segment.width}px`,
            pointerEvents: 'none',
            position: 'absolute',
            height: `${segment.height}px`,
            zIndex: 0,
          } as React.CSSProperties}
        />
      ))}
    </>
  );
});

LifecyclePairRelationshipRail.displayName = 'LifecyclePairRelationshipRail';

/** Relationship rail for a dialogue root and one of its companions. */
export const CompanionRelationshipRail = React.memo(({
  startTime,
  endTime,
  startY,
  endY,
  pixelsPerSecond,
  isActive,
  colorAction,
}: {
  startTime: number;
  endTime: number;
  startY: number;
  endY: number;
  pixelsPerSecond: number;
  isActive: boolean;
  colorAction: TimelineAction;
}) => {
  if (!isActive) return null;
  const curve = getTimelineRelationshipCurve({
    startTime,
    endTime,
    startY,
    endY,
    pixelsPerSecond,
    contentOffsetPx: 100,
  });
  if (!curve) return null;
  return (
    <svg
      className="companion-relationship-rail"
      aria-hidden="true"
      focusable="false"
      width={curve.width}
      height={curve.height}
      viewBox={`0 0 ${curve.width} ${curve.height}`}
      style={{
        '--track-color': getTrackColorForAction(colorAction),
        left: `${curve.left}px`,
        top: `${curve.top}px`,
        position: 'absolute',
        pointerEvents: 'none',
        zIndex: 0,
      } as React.CSSProperties}
    >
      <path className="companion-relationship-rail__path" d={curve.path} />
      <circle
        className="companion-relationship-rail__anchor"
        cx={curve.startX}
        cy={curve.startY}
        r="2"
      />
      <circle
        className="companion-relationship-rail__anchor"
        cx={curve.endX}
        cy={curve.endY}
        r="2"
      />
    </svg>
  );
});

CompanionRelationshipRail.displayName = 'CompanionRelationshipRail';

const LifecycleBoundaryOpacityOverlay = React.memo(({
  boundary,
  width,
}: {
  boundary?: 'start' | 'end';
  width: number;
}) => {
  const safeWidth = Math.max(0, width);
  if (safeWidth <= 0) return null;

  const isEntryBoundary = boundary === 'start';
  const curvePath = isEntryBoundary ? 'M 0 100 L 100 0' : 'M 0 0 L 100 100';
  const belowPath = isEntryBoundary ? 'M 0 100 L 100 0 L 100 100 Z' : 'M 0 0 L 100 100 L 0 100 Z';
  const abovePath = isEntryBoundary ? 'M 0 0 L 100 0 L 0 100 Z' : 'M 0 0 L 100 0 L 100 100 Z';

  return (
    <span
      className="lifecycle-boundary-transition-band"
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: `${safeWidth}px`,
        pointerEvents: 'none',
        zIndex: 0,
      }}
    >
      <svg
        className="lifecycle-boundary-opacity-plot"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <path className="lifecycle-boundary-opacity-region lifecycle-boundary-opacity-region--below" d={belowPath} />
        <path className="lifecycle-boundary-opacity-region lifecycle-boundary-opacity-region--above" d={abovePath} />
        <path className="lifecycle-boundary-opacity-curve" d={curvePath} />
      </svg>
    </span>
  );
});

LifecycleBoundaryOpacityOverlay.displayName = 'LifecycleBoundaryOpacityOverlay';

export function getActionDisplayLabel(actionType: string, params?: Record<string, any>): string {
  switch (actionType) {
    case 'dialogue':
      return '对话';
    case 'playMotion':
      return '播放动作';
    case 'setExpression':
      return '设置表情';
    case 'transformCharacter':
      return '变换角色';
    case 'removeCharacter':
      return '移除角色';
    case 'characterLookAt':
      return '角色对焦';
    case 'characterBlink':
      return '角色眨眼';
    case 'setEnvironmentLayer':
      return '放入环境画面';
    case 'transformEnvironmentLayer':
      return '调整环境画面';
    case 'removeEnvironmentLayer':
      return '收起环境画面';
    case 'addLensFilter':
      return '添加滤镜';
    case 'changeLensFilter':
      return '变化滤镜';
    case 'resetLensFilters':
      return '重置滤镜';
    case 'setCompositeRecipe':
      if (params?.slot === 'grounding') return '设置角色明暗融入';
      if (params?.slot === 'integration') return '设置角色色彩融入';
      return '角色融入';
    case 'modulateComposite':
      if (params?.slot === 'grounding') return '变化角色明暗融入';
      if (params?.slot === 'integration') return '变化角色色彩融入';
      return '变化角色融入';
    case 'resetCompositeRecipe':
      if (params?.slot === 'grounding') return '重置角色明暗融入';
      if (params?.slot === 'integration') return '重置角色色彩融入';
      return '重置角色融入';
    case 'setLighting':
      return '设置光照预设';
    case 'resetLighting':
      return '重置光照预设';
    case 'setBlur':
      return '设置模糊';
    case 'resetBlur':
      return '重置模糊';
    case 'setGodrays':
      return '设置体积光';
    case 'resetGodrays':
      return '重置体积光';
    case 'setPostProcessing':
      return '设置后期处理';
    case 'resetPostProcessing':
      return '重置后期处理';
    case 'addColorOverlay':
      return '添加色彩叠加';
    case 'removeColorOverlay':
      return '移除色彩叠加';
    case 'clearColorOverlays':
      return '清除全部色彩叠加';
    case 'addPointLight':
      return '添加点光源';
    case 'removePointLight':
      return '移除点光源';
    case 'clearPointLights':
      return '清除全部点光源';
    case 'addImage':
      return '图片';
    case 'transformImage':
      return '变换图片';
    case 'removeImage':
      return '移除图片';
    case 'playCustomAnimation':
      return '特效';
    case 'setBGM':
      return 'BGM';
    case 'playAudio':
      return '音效';
    case 'stopAudio':
      return '停音效';
    case 'cameraMotion':
      if (params?.move) return `${params.move}`;
      return '运镜';
    default:
      return actionType;
  }
}

export const TrackBlock = React.memo(({
  action,
  id,
  trackId,
  pixelsPerSecond,
  isSelected,
  isPairPeer = false,
  repeatWarning,
  collaborationEditingSummary,
  collaborationEditingPeerCount = 0,
  relationshipLabel,
  laneIndex,
  registerBlock,
  onSelect,
  onResizeNudge,
  onContextMenu,
  onHoverChange,
}: {
  action: TimelineAction;
  id: string;
  trackId?: string;
  pixelsPerSecond: number;
  isSelected: boolean;
  /** Weak visual highlight for lifecycle peer; never selection identity. */
  isPairPeer?: boolean;
  repeatWarning?: string;
  collaborationEditingSummary?: string | null;
  collaborationEditingPeerCount?: number;
  relationshipLabel?: string;
  laneIndex: number;
  registerBlock: (id: string, el: HTMLElement | null) => void;
  onSelect?: (id: string) => void;
  onResizeNudge?: (id: string, deltaSeconds: number) => void;
  onContextMenu: (e: React.MouseEvent, id: string, disableSplit?: boolean) => void;
  onHoverChange?: (id: string | undefined) => void;
}) => {
  const time = action.time || 0;
  const authoringParams = action.sourceParams ?? action.params;
  const lifecycleMetrics = action.semanticType
    ? getLifecycleBoundaryPresentationMetrics(
      {
        type: action.semanticType,
        params: authoringParams as SceneStatement['params'],
      },
      pixelsPerSecond,
    )
    : null;
  const isLifecycleBoundaryBlock = !!lifecycleMetrics?.isLifecycleBoundary;
  const duration = isLifecycleBoundaryBlock
    ? lifecycleMetrics!.semanticDurationSeconds
    : getTimelineActionDuration(action);
  const left = time * pixelsPerSecond;
  const width = isLifecycleBoundaryBlock
    ? lifecycleMetrics!.visualWidthPx
    : Math.max(4, duration * pixelsPerSecond);
  const transitionWidthPx = isLifecycleBoundaryBlock
    ? lifecycleMetrics!.transitionWidthPx
    : width;
  const isVeryThin = width < 16;
  const isCompact = width < 72;
  const showCollaborationBadge = !!collaborationEditingSummary && width >= 96;
  const showResizeHandle = !isVeryThin && !(isLifecycleBoundaryBlock && isCompact);
  const trackResizeMinDuration = isLifecycleBoundaryBlock ? 0 : 0.1;
  const trackResizeMaxDuration = Math.max(100, Math.max(duration, 0.1));

  const handleTrackResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const nextDuration = event.key === 'Home'
      ? trackResizeMinDuration
      : event.key === 'End'
        ? trackResizeMaxDuration
        : duration + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 1 : 0.1);
    const deltaSeconds = nextDuration - duration;
    if (deltaSeconds !== 0) onResizeNudge?.(id, deltaSeconds);
  };

  const severity = useActionValidationSeverity(id);
  const validationStore = useValidationStore();
  const [tooltip, setTooltip] = useState<string | null>(null);
  const typeColorVar = getTrackColorForAction(action);
  const isPlaceholder = isPlaceholderTimelineAction(action);

  const handleMouseEnter = () => {
    const msg = validationStore.getIssueMessageByActionId(id);
    setTooltip(msg);
  };

  const getIcon = () => {
    const IconComp = (ActionIcons as any)[action.semanticIconKey ?? action.action] || ActionIcons.default;
    return <IconComp aria-hidden="true" width={isCompact ? 16 : 14} height={isCompact ? 16 : 14} style={{ opacity: 0.8 }} />;
  };

  const MOVE_LABELS: Record<string, string> = {
    push: '推', pull: '拉', pan: '摇', tilt: '直摇',
    zoom: '变焦', rotate: '旋转', dolly: '希区柯克', shake: '震动',
  };

  const EASING_LABELS: Record<string, string> = {
    smooth: '平滑', accelerate: '急出', overshoot: '回弹', linear: '匀速',
    decelerate: '缓入', bounce: '弹跳', anticipate: '预备', hesitate: '犹豫',
  };

  const blockLabel = isPlaceholder
    ? '动作待定'
    : action.semanticLabel ? action.semanticLabel :
    action.action === 'dialogue' ? authoringParams.text :
    action.action === 'cameraMotion' && action.semanticType !== 'camera'
      ? `${MOVE_LABELS[action.params.move] || action.params.move}·${EASING_LABELS[action.params.easing] || action.params.easing}`
      : getActionDisplayLabel(action.action, action.params);

  let borderStyle = undefined;
  let shadowStyle = undefined;
  if (severity === 'error') {
    borderStyle = '1.5px solid var(--error)';
    shadowStyle = '0 0 6px rgba(239, 68, 68, 0.4)';
  } else if (severity === 'warning') {
    borderStyle = '1.5px solid var(--warning)';
    shadowStyle = '0 0 6px rgba(245, 158, 11, 0.4)';
  } else if (isPlaceholder) {
    borderStyle = '1px dashed var(--color-character, var(--border-default))';
  }

  return (
    <div
      ref={(el) => registerBlock(id, el)}
      data-testid="timeline-track-block"
      data-id={id}
      data-action-id={id}
      data-track-id={trackId}
      data-action-time={time}
      data-action-duration={duration}
      data-semantic-type={action.semanticType}
      data-placeholder={isPlaceholder ? 'true' : undefined}
      data-lifecycle-boundary={isLifecycleBoundaryBlock ? lifecycleMetrics?.boundary : undefined}
      data-collaboration-editing={collaborationEditingSummary ? 'true' : 'false'}
      className={[
        'track-block',
        isSelected ? 'is-selected' : '',
        !isSelected && isPairPeer ? 'is-pair-peer' : '',
        collaborationEditingSummary ? 'is-collaboration-editing' : '',
        isLifecycleBoundaryBlock ? 'track-block--lifecycle-boundary' : '',
        isPlaceholder ? 'track-block--placeholder' : '',
      ].filter(Boolean).join(' ')}
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      data-pair-peer={!isSelected && isPairPeer ? 'true' : undefined}
      style={{
        '--track-color': typeColorVar,
        left: `${left}px`,
        width: `${width}px`,
        top: `${laneIndex * 32 + 4}px`,
        position: 'absolute',
        height: '24px',
        borderRadius: 'var(--radius-sm)',
        fontSize: '10px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: isCompact ? 'center' : 'flex-start',
        padding: isVeryThin ? '0' : isCompact ? '0 2px' : '0 4px',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        cursor: isPlaceholder ? 'default' : 'move',
        opacity: isPlaceholder ? 0.6 : undefined,
        userSelect: 'none',
        zIndex: isSelected ? 10 : 1,
        border: borderStyle,
        boxShadow: shadowStyle,
      } as React.CSSProperties}
      onContextMenu={(event) => onContextMenu(event, id, false)}
      onMouseEnter={() => {
        handleMouseEnter();
        onHoverChange?.(id);
      }}
      onMouseLeave={() => onHoverChange?.(undefined)}
      title={tooltip || collaborationEditingSummary || relationshipLabel || undefined}
      aria-label={collaborationEditingSummary || (relationshipLabel ? `${blockLabel}，${relationshipLabel}` : blockLabel)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        onSelect?.(id);
      }}
    >
      {isLifecycleBoundaryBlock && (
        <>
          <LifecycleBoundaryOpacityOverlay boundary={lifecycleMetrics?.boundary} width={transitionWidthPx} />
          <span
            className="lifecycle-boundary-pad"
            aria-hidden="true"
            style={{
              position: 'absolute',
              right: 0,
              top: 0,
              bottom: 0,
              width: `${LIFECYCLE_BOUNDARY_PAD_PX}px`,
              pointerEvents: 'none',
              zIndex: 0,
            }}
          />
        </>
      )}
      {!isLifecycleBoundaryBlock && !isCompact && <EasingOverlay action={action} width={width} />}
      {!isVeryThin && (
        <span style={{ marginRight: isCompact ? '0' : '6px', fontSize: '12px', display: 'flex', alignItems: 'center', position: 'relative', zIndex: 1 }}>
          {getIcon()}
        </span>
      )}
      {!isCompact && (
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 500, position: 'relative', zIndex: 1, paddingRight: severity ? '12px' : '0' }}>
          {blockLabel}
        </div>
      )}
      {severity && !isVeryThin && (
        <span
          style={{
            position: 'absolute',
            right: '4px',
            top: '50%',
            transform: 'translateY(-50%)',
            fontSize: '10px',
            color: severity === 'error' ? 'var(--error)' : 'var(--warning)',
            zIndex: 3,
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            lineHeight: 1,
          }}
        >
          {severity === 'error' ? '●' : '▲'}
        </span>
      )}
      {repeatWarning && !isCompact && !severity && (
        <span
          title={`动作"${repeatWarning}"在短时间内重复使用`}
          style={{
            position: 'relative',
            zIndex: 2,
            marginLeft: 4,
            fontSize: 10,
            color: 'var(--error)',
            flexShrink: 0,
          }}
        >
          <IconWarning width={10} height={10} />
        </span>
      )}
      {showCollaborationBadge && (
        <span
          className="track-block__collaboration-badge"
          title={collaborationEditingSummary || undefined}
          aria-label={collaborationEditingSummary || undefined}
        >
          <IconUsers width={9} height={9} />
          <span>{collaborationEditingPeerCount}</span>
        </span>
      )}
      {showResizeHandle && (
        <div
          data-testid="timeline-resize-handle"
          data-action-id={id}
          className="track-resize-handle"
          style={{
            width: isLifecycleBoundaryBlock ? '8px' : '6px',
            height: '100%',
            cursor: lifecycleMetrics?.canResizeTransition === false && isLifecycleBoundaryBlock
              ? 'default'
              : 'ew-resize',
            position: 'absolute',
            // Handle anchors to semantic transition edge, not pad edge.
            right: isLifecycleBoundaryBlock ? `${LIFECYCLE_BOUNDARY_PAD_PX}px` : 0,
            zIndex: 1,
            display: isLifecycleBoundaryBlock && !lifecycleMetrics?.canResizeTransition ? 'none' : undefined,
          }}
          role="slider"
          tabIndex={0}
          aria-label={isLifecycleBoundaryBlock ? `调整${blockLabel}过渡时长` : `调整${blockLabel}时长`}
          aria-orientation="horizontal"
          aria-valuemin={trackResizeMinDuration}
          aria-valuemax={trackResizeMaxDuration}
          aria-valuenow={duration}
          aria-valuetext={isLifecycleBoundaryBlock
            ? `${blockLabel}过渡 ${duration.toFixed(1)} 秒`
            : `${blockLabel}时长 ${duration.toFixed(1)} 秒`}
          onKeyDown={handleTrackResizeKeyDown}
        />
      )}
    </div>
  );
});

TrackBlock.displayName = 'TrackBlock';

export interface SummaryTooltipPayload {
  x: number;
  y: number;
  segment: SummarySegment;
  trackLabel: string;
}

export const TrackSummaryBlock = React.memo(({
  segment,
  pixelsPerSecond,
  trackLabel,
  onHover,
  onLeave,
  onSeek,
  onNavigate,
  trackKind,
}: {
  segment: SummarySegment;
  pixelsPerSecond: number;
  trackLabel: string;
  onHover: (payload: SummaryTooltipPayload) => void;
  onLeave: () => void;
  onSeek: (time: number) => void;
  onNavigate: (range: { start: number; end: number }) => void;
  trackKind?: string;
}) => {
  const left = segment.start * pixelsPerSecond;
  const width = Math.max(6, (segment.end - segment.start) * pixelsPerSecond);
  const summaryColor = getTrackColorForAction({
    action: segment.dominantActionType,
    semanticCategory: segment.dominantCategory as TimelineAction['semanticCategory'],
  });
  const IconComp = (ActionIcons as any)[segment.dominantIconKey ?? segment.dominantActionType] || ActionIcons.default;
  const statusSeverity = segment.issueSeverity ?? (segment.hasRepeatWarning ? 'warning' : null);
  const compactMode = width < 34;
  const showIcon = width >= 38;
  const showLabel = width >= 80;
  const showCount = width >= 58;
  const showStatusBadge = !!statusSeverity && !compactMode;
  const summaryLabel = (
    trackKind === 'background'
    || trackKind === 'env:background'
    || (
      trackKind === 'environment'
      && [
        'setEnvironmentLayer',
        'transformEnvironmentLayer',
        'removeEnvironmentLayer',
      ].includes(segment.dominantActionType)
    )
  )
    ? '环境画面'
    : segment.dominantActionLabel ?? getActionDisplayLabel(segment.dominantActionType);

  const emitHover = (event: React.MouseEvent<HTMLButtonElement>) => {
    onHover({
      x: event.clientX,
      y: event.clientY,
      segment,
      trackLabel,
    });
  };

  return (
    <button
      type="button"
      data-testid="track-summary-block"
      data-summary-id={segment.id}
      className="track-summary-block"
      style={{
        '--summary-color': summaryColor,
        left: `${left}px`,
        width: `${width}px`,
      } as React.CSSProperties}
      data-track-kind={trackKind}
      data-has-issue={statusSeverity ? 'true' : 'false'}
      data-issue-severity={statusSeverity || 'none'}
      data-has-repeat={segment.hasRepeatWarning ? 'true' : 'false'}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseEnter={emitHover}
      onMouseMove={emitHover}
      onMouseLeave={onLeave}
      onClick={(e) => {
        e.stopPropagation();
        onSeek(segment.start);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onNavigate({ start: segment.start, end: segment.end });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <span className="track-summary-block__accent" aria-hidden="true" />
      <span className="track-summary-block__content">
        {showIcon && (
          <span className="track-summary-block__icon" aria-hidden="true">
            <IconComp />
          </span>
        )}
        {showLabel && <span className="track-summary-block__label">{summaryLabel}</span>}
      </span>
      {(showCount || showStatusBadge) && (
        <span className="track-summary-block__meta">
          {showCount && <span className="track-summary-block__count">{segment.count}</span>}
          {showStatusBadge && (
            <span
              className={`track-summary-block__issue-badge track-summary-block__issue-badge--${statusSeverity}`}
              title={statusSeverity === 'error' ? '该摘要区间内存在错误动作' : '该摘要区间内存在重复动作警告'}
              aria-label={statusSeverity === 'error' ? '摘要区间存在错误' : '摘要区间存在重复警告'}
            >
              {statusSeverity === 'error' ? <IconError width={10} height={10} /> : <IconWarning width={10} height={10} />}
            </span>
          )}
        </span>
      )}
    </button>
  );
});

TrackSummaryBlock.displayName = 'TrackSummaryBlock';

export const TrackAnchorPin = React.memo(({
  action,
  id,
  pixelsPerSecond,
  isSelected,
  hasValidationIssue,
  hasRepeatWarning,
  isCollaborationEditing,
  collaborationEditingSummary,
  onSelect,
  onSeek,
  registerBlock,
  onPointerDown,
}: {
  action: TimelineAction;
  id: string;
  pixelsPerSecond: number;
  isSelected: boolean;
  hasValidationIssue: boolean;
  hasRepeatWarning: boolean;
  isCollaborationEditing?: boolean;
  collaborationEditingSummary?: string | null;
  onSelect: (id: string) => void;
  onSeek: (time: number) => void;
  registerBlock?: (id: string, el: HTMLElement | null) => void;
  onPointerDown?: (event: React.PointerEvent<HTMLButtonElement>, id: string) => void;
}) => {
  const left = (action.time || 0) * pixelsPerSecond;
  const trackColor = getTrackColorForAction(action);

  return (
    <button
      type="button"
      ref={(element) => registerBlock?.(id, element)}
      data-testid="track-anchor-pin"
      data-anchor-id={id}
      className={`track-anchor-pin ${isSelected ? 'is-selected' : ''}`}
      style={{
        '--track-color': trackColor,
        left: `${left}px`,
      } as React.CSSProperties}
      data-has-issue={hasValidationIssue ? 'true' : 'false'}
      data-has-repeat={hasRepeatWarning ? 'true' : 'false'}
      data-collaboration-editing={isCollaborationEditing ? 'true' : 'false'}
      title={collaborationEditingSummary || undefined}
      onPointerDown={(e) => {
        e.stopPropagation();
        onPointerDown?.(e, id);
      }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(id);
        onSeek(action.time || 0);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSelect(id);
      }}
    >
      <span className="track-anchor-pin__stem" />
      <span className="track-anchor-pin__head" />
    </button>
  );
});

TrackAnchorPin.displayName = 'TrackAnchorPin';

export const TrackSummaryTooltip = React.memo(({
  payload,
}: {
  payload: SummaryTooltipPayload | null;
}) => {
  if (!payload || typeof document === 'undefined') return null;

  const topTypes = payload.segment.topTypes
    .map((item) => `${item.label ?? item.type} × ${item.count}`)
    .join(' · ');

  return createPortal(
    <div
      data-testid="summary-tooltip-portal"
      className="track-summary-tooltip"
      style={{
        position: 'fixed',
        left: `${payload.x + 14}px`,
        top: `${payload.y + 14}px`,
        pointerEvents: 'none',
        zIndex: 2000,
      }}
    >
      <div className="track-summary-tooltip__title">{payload.trackLabel}</div>
      <div className="track-summary-tooltip__range">
        {payload.segment.start.toFixed(1)}s - {payload.segment.end.toFixed(1)}s
      </div>
      <div className="track-summary-tooltip__meta">{payload.segment.count} 个动作</div>
      <div className="track-summary-tooltip__types">{topTypes}</div>
    </div>,
    document.body,
  );
});

TrackSummaryTooltip.displayName = 'TrackSummaryTooltip';

export const TrackRow = React.memo(({
  label,
  trackId,
  laneCount,
  registerTrack,
  isSelected,
  detailLayer,
  summaryLayer,
  anchorLayer,
  railLayer,
  trackKind,
}: {
  label: string;
  trackId: string;
  laneCount: number;
  registerTrack: (trackId: string, el: HTMLDivElement | null) => void;
  isSelected?: boolean;
  detailLayer?: React.ReactNode;
  summaryLayer?: React.ReactNode;
  anchorLayer?: React.ReactNode;
  railLayer?: React.ReactNode;
  trackKind?: string;
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const rowHeight = Math.max(1, laneCount) * 32 + 8;

  return (
    <div
      ref={(el) => registerTrack(trackId, el)}
      data-testid="timeline-track-row"
      data-track-id={trackId}
      data-track-label={label}
      data-track-kind={trackKind}
      className={`track-row ${isSelected ? 'is-selected-track' : ''}`}
      style={{
        display: 'flex',
        minHeight: collapsed ? '28px' : '40px',
        height: collapsed ? '28px' : `${rowHeight}px`,
        borderBottom: '1px solid var(--border-subtle)',
        position: 'relative',
        background: 'rgba(255,255,255,0.01)',
        contain: 'layout style',
      }}
    >
      <div
        className="track-label"
        style={{
          width: '100px',
          flexShrink: 0,
          height: '100%',
          borderRight: '1px solid var(--border-subtle)',
          position: 'sticky',
          left: 0,
          zIndex: 5,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 6px',
        }}
      >
        <button
          type="button"
          className="track-label__collapse"
          onClick={(e) => { e.stopPropagation(); setCollapsed((c) => !c); }}
          title={collapsed ? '展开轨道' : '折叠轨道'}
          aria-label={collapsed ? `展开${label}轨道` : `折叠${label}轨道`}
        >
          {collapsed
            ? <IconChevronRight width={12} height={12} aria-hidden="true" />
            : <IconChevronDown width={12} height={12} aria-hidden="true" />}
        </button>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginLeft: 4 }}>
          {label}
        </span>
      </div>
      <div
        className="track-content"
        style={{
          flex: 1,
          position: 'relative',
          height: '100%',
          display: collapsed ? 'none' : undefined,
        }}
      >
        <div className="track-rail-layer">{railLayer}</div>
        <div className="track-summary-layer">{summaryLayer}</div>
        <div className="track-anchor-layer">{anchorLayer}</div>
        <div className="track-detail-layer">{detailLayer}</div>
      </div>
    </div>
  );
});

TrackRow.displayName = 'TrackRow';

export const QuickAdd = ({ onClick }: { onClick: () => void }) => (
  <div
    className="timeline-quick-add"
    onClick={onClick}
    style={{ height: '8px', position: 'relative', margin: '4px 0', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
  >
    <div style={{ height: '2px', background: 'var(--accent-glow)', width: '100%', position: 'absolute' }} />
    <div
      className="timeline-quick-add__icon"
      style={{ zIndex: 2, background: 'var(--accent-primary)', borderRadius: '50%', width: '16px', height: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 8px var(--accent-glow)' }}
    >
      <IconPlus width={10} height={10} style={{ color: 'white' }} />
    </div>
  </div>
);
