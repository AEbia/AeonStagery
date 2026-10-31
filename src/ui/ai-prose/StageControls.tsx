import type { CSSProperties, ReactNode } from 'react';
import { DEFAULT_SCRIPT_READING_SPEED, SCRIPT_READING_SPEED_RANGE } from '../../api/types/ai-prose-authoring';
import { InfoTip } from '../Tooltip';
import { STAGES } from './workbenchPresentation';

export function ReadingSpeedControl({
  value,
  onChange,
  compact = false,
  disabled = false,
}: {
  value: number;
  onChange: (value: number) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const progress = ((value - SCRIPT_READING_SPEED_RANGE.min)
    / (SCRIPT_READING_SPEED_RANGE.max - SCRIPT_READING_SPEED_RANGE.min)) * 100;
  const rangeStyle = {
    '--ai-reading-speed-progress': `${Math.max(0, Math.min(100, progress))}%`,
  } as CSSProperties;

  return (
    <div className={`ai-prose-reading-speed-control ${compact ? 'is-compact' : ''}`}>
      <div className="ai-prose-reading-speed-head">
        <span className="ai-prose-reading-speed-label">
          <b>朗读速度</b>
          <InfoTip
            title="预估朗读速度"
            content="用于推算生成对白草稿在时间轴上的默认持续时间（字/秒）。中文字幕推荐 4.5~6.0 字/秒。"
          />
          {!compact && <small>用于新时间块的时长估算</small>}
        </span>
        <output>{value.toFixed(1)}<small> chars/sec</small></output>
      </div>
      <input
        aria-label="scriptReadingSpeed"
        className="ai-prose-reading-speed-range"
        type="range"
        disabled={disabled}
        min={SCRIPT_READING_SPEED_RANGE.min}
        max={SCRIPT_READING_SPEED_RANGE.max}
        step={SCRIPT_READING_SPEED_RANGE.step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={rangeStyle}
        aria-valuetext={`${value.toFixed(1)} chars/sec`}
      />
      <div className="ai-prose-reading-speed-scale" aria-hidden="true">
        <span>{SCRIPT_READING_SPEED_RANGE.min}</span>
        <span>{DEFAULT_SCRIPT_READING_SPEED}</span>
        <span>{SCRIPT_READING_SPEED_RANGE.max}</span>
      </div>
    </div>
  );
}

export function TabIntro({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="ai-prose-tab-intro">
      <div>
        <h2>{title}</h2>
        <p>{STAGES.find((stage) => stage.label === title)?.description}</p>
      </div>
      {action}
    </div>
  );
}

