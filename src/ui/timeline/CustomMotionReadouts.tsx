import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CustomMotionTrack } from '../../api/types/semantic-scene';
import { useOptionalApp } from '../context/AppContext';
import { InlineNumericInput } from './FormComponents';
import { getLive2DParameterDisplayName } from './live2dParameterPresentation';
import { isTrackAnimated, samplePlayheadTrackValue, round2, round6 } from './customMotionDisplayValues';

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

export function TrackValueControl({
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

export function MotionNumberInput({ value, min, max, step, ariaLabel, onCommit, disabled }: {
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

