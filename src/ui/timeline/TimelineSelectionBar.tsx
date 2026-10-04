import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { TimelineAction } from './semanticTimelineTypes';
import {
  IconInfo,
  IconX,
  type IconProps,
} from '../icons';
import { FormSelect } from '../FormSelect';
import { getActionDisplayLabel, getTrackColorForAction } from './TrackComponents';

const CAMERA_MOVE_LABELS: Record<string, string> = {
  push: '推镜',
  pull: '拉镜',
  pan: '摇镜',
  tilt: '俯仰',
  zoom: '变焦',
  rotate: '旋转',
  dolly: '滑轨变焦',
  shake: '震动',
};

const CAMERA_EASING_LABELS: Record<string, string> = {
  smooth: '平滑',
  accelerate: '加速',
  decelerate: '减速',
  overshoot: '回弹',
  linear: '匀速',
  bounce: '弹跳',
  anticipate: '预备',
  hesitate: '停顿',
};

function motionKeyLabel(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const candidate = value as { kind?: unknown; key?: unknown };
    if (candidate.kind === 'resource' && typeof candidate.key === 'string') return candidate.key;
    if (candidate.kind === 'custom') return '自定义动作';
  }
  return '';
}

export interface TimelineSelectionBarProps {
  selectedCount: number;
  action?: TimelineAction | null;
  trackLabel?: string;
  trackValue?: string;
  trackOptions?: Array<{ id: string; label: string; disabled?: boolean }>;
  issueCount: number;
  hasRepeatWarning: boolean;
  canSplit: boolean;
  onSeek: () => void;
  onReveal: () => void;
  onClear: () => void;
  onCopy: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onSplit: () => void;
  onAlignToPlayhead: () => void;
  onSelectAdjacent: (direction: -1 | 1) => void;
  onChangeTrack: (trackId: string) => void;
}

interface TimelineSelectionSnapshot {
  selectedCount: number;
  action?: TimelineAction | null;
  trackLabel?: string;
  issueCount: number;
  hasRepeatWarning: boolean;
  trackValue?: string;
  trackOptions?: Array<{ id: string; label: string; disabled?: boolean }>;
  canSplit: boolean;
}

const EXIT_ANIMATION_MS = 180;

function SelectionIconBase({
  children,
  width = 16,
  height = 16,
  ...props
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className="mgf-icon timeline-selection-bar__action-icon"
      width={width}
      height={height}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

const IconTimelineCopy = (props: IconProps) => (
  <SelectionIconBase {...props}>
    <rect x="4" y="8" width="9" height="7" rx="1.8" />
    <rect x="11" y="5" width="9" height="7" rx="1.8" opacity="0.72" />
    <path d="M5 19h14" />
    <path d="M7 17v4" />
    <path d="M17 17v4" />
  </SelectionIconBase>
);

const IconTimelineDuplicate = (props: IconProps) => (
  <SelectionIconBase {...props}>
    <rect x="4" y="9" width="8" height="6" rx="1.6" />
    <rect x="12" y="6" width="8" height="6" rx="1.6" opacity="0.72" />
    <path d="M16 15v6" />
    <path d="M13 18h6" />
    <path d="M4 20h7" />
  </SelectionIconBase>
);

const IconTimelineSplit = (props: IconProps) => (
  <SelectionIconBase {...props}>
    <rect x="4" y="8" width="16" height="7" rx="2" />
    <path d="M12 4v16" />
    <path d="m9 6 3 2 3-2" />
    <path d="m9 18 3-2 3 2" />
  </SelectionIconBase>
);

const IconTimelineAlign = (props: IconProps) => (
  <SelectionIconBase {...props}>
    <path d="M12 4v16" />
    <path d="M4 8h5" />
    <path d="M4 16h5" />
    <path d="M15 12h5" />
    <path d="m8 8 3 4-3 4" />
  </SelectionIconBase>
);

const IconTimelineReveal = (props: IconProps) => (
  <SelectionIconBase {...props}>
    <path d="M4 18h16" />
    <rect x="7" y="8" width="10" height="6" rx="2" />
    <path d="M12 3v4" />
    <path d="M12 15v5" />
    <path d="m9 5 3-2 3 2" />
  </SelectionIconBase>
);

const IconTimelineJump = (props: IconProps) => (
  <SelectionIconBase {...props}>
    <path d="M5 5v14" />
    <path d="M9 8h6.5a3.5 3.5 0 0 1 0 7H9" />
    <path d="m12 11-3 4 3 4" />
  </SelectionIconBase>
);

const IconTimelineDelete = (props: IconProps) => (
  <SelectionIconBase {...props}>
    <rect x="4" y="9" width="16" height="6" rx="2" />
    <path d="M7 20h10" />
    <path d="M9 17v5" />
    <path d="M15 17v5" />
    <path d="m9 5 6 6" />
    <path d="m15 5-6 6" />
  </SelectionIconBase>
);

function getActionSummary(action: TimelineAction): string {
  const params = action.sourceParams ?? action.params;
  if (action.semanticType === 'camera') {
    return `镜头: ${String(params.mode || 'move')}${params.target ? ` / ${String(params.target)}` : ''}`;
  }
  if (action.semanticType === 'visualStyle') {
    return `画面效果: ${String(params.scope || 'object')} / ${String(params.slot || '')} / ${String(params.mode || 'set')}`;
  }
  if (action.semanticType === 'filterAdd') {
    return `添加滤镜: ${String(params.recipeId || '未选择')}`;
  }
  if (action.semanticType === 'filterChange') {
    return `变化滤镜: ${String(params.fromRecipeId || '未选择')} -> ${String(params.recipeId || '未选择')}`;
  }
  if (action.semanticType === 'filterReset') {
    return '重置滤镜: 全部镜头滤镜';
  }
  if (action.semanticType === 'lighting') {
    return `光照: ${String(params.effect || 'preset')} / ${String(params.mode || 'set')}`;
  }
  if (action.action === 'dialogue' && params.text) {
    return String(params.text);
  }
  if (action.action === 'playMotion' && action.params.motion) {
    const motionLabel = motionKeyLabel(action.params.motion);
    return motionLabel ? `动作: ${motionLabel}` : '动作';
  }
  if (action.action === 'setExpression' && action.params.expression) {
    return `表情: ${action.params.expression}`;
  }
  if (action.action === 'cameraMotion') {
    const move = typeof action.params.move === 'string'
      ? CAMERA_MOVE_LABELS[action.params.move] || action.params.move
      : '';
    const easing = typeof action.params.easing === 'string'
      ? CAMERA_EASING_LABELS[action.params.easing] || action.params.easing
      : '';
    if (move && easing) return `运镜: ${move} / ${easing}`;
    if (move) return `运镜: ${move}`;
    return '运镜';
  }
  if (['setEnvironmentLayer', 'transformEnvironmentLayer', 'removeEnvironmentLayer'].includes(action.action)) {
    const layerName = typeof action.params.label === 'string' && action.params.label.trim()
      ? action.params.label.trim()
      : '';
    return layerName ? `环境画面: ${layerName}` : '环境画面';
  }
  if (params.id) {
    return `目标 ID: ${params.id}`;
  }
  if (action.params.image) {
    return String(action.params.image);
  }
  return action.semanticLabel ?? action.action;
}

export function TimelineSelectionBar(props: TimelineSelectionBarProps) {
  const {
    onSeek,
    onReveal,
    onClear,
    onCopy,
    onDuplicate,
    onDelete,
    onSplit,
    onAlignToPlayhead,
    onSelectAdjacent,
    onChangeTrack,
  } = props;
  const barRef = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<TimelineSelectionSnapshot | null>(() => (
    props.selectedCount > 0
      ? {
        selectedCount: props.selectedCount,
        action: props.action,
        trackLabel: props.trackLabel,
        issueCount: props.issueCount,
        hasRepeatWarning: props.hasRepeatWarning,
        trackValue: props.trackValue,
        trackOptions: props.trackOptions,
        canSplit: props.canSplit,
      }
      : null
  ));
  const [isVisible, setIsVisible] = useState(props.selectedCount > 0);
  const [barWidth, setBarWidth] = useState(0);

  useEffect(() => {
    if (props.selectedCount > 0) {
      setSnapshot({
        selectedCount: props.selectedCount,
        action: props.action,
        trackLabel: props.trackLabel,
        issueCount: props.issueCount,
        hasRepeatWarning: props.hasRepeatWarning,
        trackValue: props.trackValue,
        trackOptions: props.trackOptions,
        canSplit: props.canSplit,
      });
      setIsVisible(true);
      return;
    }
  }, [
    props.action,
    props.hasRepeatWarning,
    props.issueCount,
    props.selectedCount,
    props.trackLabel,
    props.trackOptions,
    props.trackValue,
    props.canSplit,
  ]);

  useEffect(() => {
    if (props.selectedCount > 0 || !snapshot) return;
    setIsVisible(false);
    const timer = window.setTimeout(() => {
      setSnapshot(null);
    }, EXIT_ANIMATION_MS);
    return () => window.clearTimeout(timer);
  }, [props.selectedCount, snapshot]);

  useEffect(() => {
    const element = barRef.current;
    if (!element) return;

    const updateWidth = () => {
      setBarWidth(element.getBoundingClientRect().width);
    };

    updateWidth();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      updateWidth();
    });
    observer.observe(element);

    return () => observer.disconnect();
  }, [snapshot, isVisible]);

  if (!snapshot) return null;

  const {
    selectedCount,
    action,
    trackLabel,
    issueCount,
    hasRepeatWarning,
    trackValue,
    trackOptions,
    canSplit,
  } = snapshot;

  const isCompact = barWidth > 0 && barWidth < 640;
  const showSummary = barWidth === 0 || barWidth >= 520;
  const showTrackBadge = barWidth === 0 || barWidth >= 600;
  const showRepeatBadge = barWidth === 0 || barWidth >= 600;
  const hasTrackOptions = !!trackOptions?.some((option) => !option.disabled);
  const splitTitle = canSplit ? '在播放头处拆分' : '播放头在动作内部时可拆分';
  const trackSelect = hasTrackOptions ? (
    <FormSelect
      className="timeline-selection-bar__track-select"
      value={trackValue || ''}
      options={[
        { value: '', label: '改轨道', disabled: true },
        ...(trackOptions ?? []).map((option) => ({
          value: option.id,
          label: option.label,
          disabled: option.disabled,
        })),
      ]}
      onChange={onChangeTrack}
      title="快速改轨道"
      aria-label="快速改轨道"
    />
  ) : null;

  if (!action || selectedCount > 1) {
    return (
      <div className="timeline-selection-layer" data-visible={isVisible} data-testid="timeline-selection-layer">
        <div
          ref={barRef}
          className="timeline-selection-bar"
          data-visible={isVisible}
          data-testid="timeline-selection-bar"
        >
          <div className="timeline-selection-bar__main">
            <div className="timeline-selection-bar__identity">
              <span className="timeline-selection-bar__accent" />
              <div className="timeline-selection-bar__copy">
                <span className="timeline-selection-bar__label">{selectedCount} 个动作已选中</span>
                {showSummary && <span className="timeline-selection-bar__summary">批量编辑</span>}
              </div>
            </div>
            <div className="timeline-selection-bar__status">
              {issueCount > 0 ? (
                <span className="timeline-selection-bar__badge timeline-selection-bar__badge--issue">{issueCount} 个问题</span>
              ) : null}
            </div>
          </div>
          <div className="timeline-selection-bar__actions">
            <div className="timeline-selection-bar__action-group">
              <button className="btn btn--sm" onClick={onCopy} title="复制选区">
                <IconTimelineCopy />
                <span className="timeline-selection-bar__button-label">复制</span>
              </button>
              <button className="btn btn--sm" onClick={onDuplicate} title="复制并插入副本">
                <IconTimelineDuplicate />
                <span className="timeline-selection-bar__button-label">副本</span>
              </button>
              <button className="btn btn--sm" onClick={onAlignToPlayhead} title="将选区起点对齐到播放头">
                <IconTimelineAlign />
                <span className="timeline-selection-bar__button-label">对齐</span>
              </button>
            </div>
            {(trackSelect || !isCompact) && (
              <div className="timeline-selection-bar__action-group timeline-selection-bar__action-group--secondary">
                {trackSelect}
                {!isCompact && (
                  <button className="btn btn--sm" onClick={onReveal} title="定位选区">
                    <IconTimelineReveal />
                    <span className="timeline-selection-bar__button-label">定位</span>
                  </button>
                )}
              </div>
            )}
            <div className="timeline-selection-bar__action-group timeline-selection-bar__action-group--end">
              <button className="btn btn--icon btn--danger" onClick={onDelete} title="删除选区" aria-label="删除选区">
                <IconTimelineDelete />
              </button>
              <button className="btn btn--icon" onClick={onClear} title="清空选择" aria-label="清空选择">
                <IconX width={14} height={14} />
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const title = action.action === 'cameraMotion'
    ? '运镜'
    : action.semanticLabel ?? getActionDisplayLabel(action.action, action.params);
  const summary = getActionSummary(action);
  const actionColor = getTrackColorForAction(action);

  return (
    <div
      className="timeline-selection-layer"
      data-visible={isVisible}
      data-testid="timeline-selection-layer"
      style={{ '--selection-color': actionColor } as CSSProperties}
    >
      <div
        ref={barRef}
        className="timeline-selection-bar"
        data-visible={isVisible}
        data-testid="timeline-selection-bar"
      >
        <div className="timeline-selection-bar__main">
          <div className="timeline-selection-bar__identity">
            <span className="timeline-selection-bar__accent" />
            <div className="timeline-selection-bar__copy">
              <span className="timeline-selection-bar__label">{title}</span>
              {showSummary && <span className="timeline-selection-bar__summary">{summary}</span>}
            </div>
          </div>
          <div className="timeline-selection-bar__status">
            {showTrackBadge && (
              <span className="timeline-selection-bar__badge timeline-selection-bar__badge--track">{trackLabel || '未归类'}</span>
            )}
            {issueCount > 0 ? (
              <span className="timeline-selection-bar__badge timeline-selection-bar__badge--issue">
                <IconInfo width={11} height={11} /> {issueCount}
              </span>
            ) : null}
            {showRepeatBadge && hasRepeatWarning && (
              <span className="timeline-selection-bar__badge timeline-selection-bar__badge--repeat">重复</span>
            )}
          </div>
        </div>
        <div className="timeline-selection-bar__actions">
          {!isCompact && (
            <div className="timeline-selection-bar__action-group timeline-selection-bar__action-group--nav">
              <button className="btn btn--sm" onClick={() => onSelectAdjacent(-1)} title="上一动作">
                <span className="timeline-selection-bar__button-label">上一</span>
              </button>
              <button className="btn btn--sm" onClick={() => onSelectAdjacent(1)} title="下一动作">
                <span className="timeline-selection-bar__button-label">下一</span>
              </button>
            </div>
          )}
          <div className="timeline-selection-bar__action-group">
            <button className="btn btn--sm" onClick={onCopy} title="复制动作">
              <IconTimelineCopy />
              <span className="timeline-selection-bar__button-label">复制</span>
            </button>
            <button className="btn btn--sm" onClick={onDuplicate} title="复制并插入副本">
              <IconTimelineDuplicate />
              <span className="timeline-selection-bar__button-label">副本</span>
            </button>
            <button className="btn btn--sm" onClick={onSplit} title={splitTitle} disabled={!canSplit}>
              <IconTimelineSplit />
              <span className="timeline-selection-bar__button-label">拆分</span>
            </button>
            <button className="btn btn--sm" onClick={onAlignToPlayhead} title="将起点对齐到播放头">
              <IconTimelineAlign />
              <span className="timeline-selection-bar__button-label">对齐</span>
            </button>
          </div>
          {(trackSelect || !isCompact) && (
            <div className="timeline-selection-bar__action-group timeline-selection-bar__action-group--secondary">
              {trackSelect}
              <button className="btn btn--sm" onClick={onReveal} title="定位选区">
                <IconTimelineReveal />
                <span className="timeline-selection-bar__button-label">定位</span>
              </button>
            </div>
          )}
          <div className="timeline-selection-bar__action-group timeline-selection-bar__action-group--end">
            {!isCompact && (
              <button className="btn btn--sm" onClick={onSeek} title="跳到动作起点">
                <IconTimelineJump />
                <span className="timeline-selection-bar__button-label">跳到</span>
              </button>
            )}
            <button className="btn btn--icon btn--danger" onClick={onDelete} title="删除动作" aria-label="删除动作">
              <IconTimelineDelete />
            </button>
            <button className="btn btn--icon" onClick={onClear} title="清空选择" aria-label="清空选择">
              <IconX width={14} height={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
