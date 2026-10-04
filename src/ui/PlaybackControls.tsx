import React, { useCallback, useRef, useState } from 'react';
import { usePlaybackAdapter, useStageAdapter } from './context/AppContext';
import type { StagePreviewResolution } from '../api/interfaces/IStageAdapter';
import { useEditorDuration, useEditorStatus } from './store/storeHooks';
import { IconPlay, IconPause, IconSkipBack, IconChevronDown, IconLoop } from './icons';
import { Tooltip } from './Tooltip';

const FRAME_STEP = 1 / 60;

const pad2 = (n: number) => n < 10 ? '0' + n : '' + n;

const formatTime = (t: number) => {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t % 1) * 100);
  return pad2(m) + ':' + pad2(s) + '.' + pad2(ms);
};

const clampProgressTime = (time: number, duration: number) => {
  if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(0, Math.min(time, duration));
};

const SPEED_OPTIONS = [
  { value: 0.5, label: '0.5x' },
  { value: 1, label: '1x' },
  { value: 1.5, label: '1.5x' },
  { value: 2, label: '2x' },
] as const;

const RESOLUTION_OPTIONS: readonly {
  value: StagePreviewResolution;
  label: string;
}[] = [
  { value: 1, label: '原分辨率' },
  { value: 0.5, label: '1/2' },
  { value: 0.25, label: '1/4' },
] as const;

export function PlaybackControls() {
  const playbackAdapter = usePlaybackAdapter();
  const stageAdapter = useStageAdapter();
  const duration = useEditorDuration();
  const { isPlaying } = useEditorStatus();
  const initialTime = playbackAdapter.getCurrentTime();
  const initialProgressTime = clampProgressTime(initialTime, duration);

  const fillRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);

  const [loopEnabled, setLoopEnabled] = useState(false);
  const [loopStart, setLoopStart] = useState('0');
  const [loopEnd, setLoopEnd] = useState('0');
  const [speed, setSpeed] = useState(1);
  const [previewResolution, setPreviewResolution] = useState<StagePreviewResolution>(() => (
    stageAdapter.getPreviewResolution()
  ));

  // Direct DOM update for playhead position
  React.useEffect(() => {
    let lastUpdate = 0;
    let lastTimeStr = '';
    const unsub = playbackAdapter.subscribeTime((time: number) => {
      const now = Date.now();
      const isLowPerf = document.documentElement.getAttribute('data-perf') === 'low';
      const throttleMs = isLowPerf ? 100 : 33;
      if (now - lastUpdate > throttleMs) {
        const progressTime = clampProgressTime(time, duration);
        if (fillRef.current) {
          fillRef.current.style.width = `${duration > 0 ? (progressTime / duration) * 100 : 0}%`;
        }
        if (timeRef.current) {
          const timeStr = formatTime(time);
          if (timeStr !== lastTimeStr) {
            timeRef.current.textContent = timeStr;
            lastTimeStr = timeStr;
          }
        }
        if (progressRef.current) {
          progressRef.current.setAttribute('aria-valuenow', String(progressTime));
          progressRef.current.setAttribute('aria-valuetext', formatTime(time));
        }
        lastUpdate = now;
      }
    });
    return unsub;
  }, [playbackAdapter, duration]);

  const handleToggle = useCallback(() => {
    if (isPlaying) {
      playbackAdapter.pause();
    } else {
      playbackAdapter.play();
    }
  }, [isPlaying, playbackAdapter]);

  const handleReset = useCallback(() => {
    playbackAdapter.seek(0);
    playbackAdapter.pause();
  }, [playbackAdapter]);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    playbackAdapter.seek(ratio * duration);
  }, [duration, playbackAdapter]);

  const handleSeekKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    const currentTime = playbackAdapter.getCurrentTime();
    let nextTime = currentTime;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') nextTime -= FRAME_STEP;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') nextTime += FRAME_STEP;
    else if (event.key === 'PageDown') nextTime -= duration * 0.1;
    else if (event.key === 'PageUp') nextTime += duration * 0.1;
    else if (event.key === 'Home') nextTime = 0;
    else if (event.key === 'End') nextTime = duration;
    else return;

    event.preventDefault();
    playbackAdapter.seek(Math.max(0, Math.min(duration, nextTime)));
  }, [duration, playbackAdapter]);

  const handleFrameStep = useCallback((dir: 1 | -1) => {
    const ct = playbackAdapter.getCurrentTime();
    playbackAdapter.seek(Math.max(0, ct + dir * FRAME_STEP));
  }, [playbackAdapter]);

  const handleLoopToggle = useCallback(() => {
    const next = !loopEnabled;
    setLoopEnabled(next);
    playbackAdapter.setLoopEnabled(next);
    if (next) {
      const s = parseFloat(loopStart) || 0;
      const e = parseFloat(loopEnd) || duration;
      playbackAdapter.setLoop(s, e);
    }
  }, [loopEnabled, loopStart, loopEnd, duration, playbackAdapter]);

  const handleLoopRegionChange = useCallback((which: 'start' | 'end', value: string) => {
    if (which === 'start') setLoopStart(value);
    else setLoopEnd(value);
    const s = which === 'start' ? parseFloat(value) || 0 : parseFloat(loopStart) || 0;
    const e = which === 'end' ? parseFloat(value) || duration : parseFloat(loopEnd) || duration;
    playbackAdapter.setLoop(s, e);
  }, [loopStart, loopEnd, duration, playbackAdapter]);

  const handleSpeedChange = useCallback((newSpeed: number) => {
    setSpeed(newSpeed);
    playbackAdapter.setSpeed(newSpeed);
  }, [playbackAdapter]);

  const handlePreviewResolutionChange = useCallback((resolution: StagePreviewResolution) => {
    stageAdapter.setPreviewResolution(resolution);
    setPreviewResolution(resolution);
  }, [stageAdapter]);

  return (
    <div className="playback-controls">
      {/* Transport Controls */}
      <div className="playback-controls__transport">
        <Tooltip title="跳转到起点" shortcut="Home">
          <button
            className="btn btn--icon playback-controls__btn"
            onClick={handleReset}
            aria-label="跳转到起点"
          >
            <IconSkipBack width={15} height={15} />
          </button>
        </Tooltip>
        <Tooltip title="后退一帧" shortcut="←">
          <button
            className="btn btn--icon playback-controls__btn"
            onClick={() => handleFrameStep(-1)}
            aria-label="后退一帧"
          >
            <IconChevronDown width={13} height={13} style={{ transform: 'rotate(90deg)' }} />
          </button>
        </Tooltip>
        <Tooltip title={isPlaying ? '暂停' : '播放'} shortcut="Space">
          <button
            className="btn btn--play playback-controls__play-btn"
            onClick={handleToggle}
            aria-label={isPlaying ? '暂停' : '播放'}
          >
            {isPlaying ? <IconPause width={19} height={19} /> : <IconPlay width={21} height={21} style={{ marginLeft: 1 }} />}
          </button>
        </Tooltip>
        <Tooltip title="前进一帧" shortcut="→">
          <button
            className="btn btn--icon playback-controls__btn"
            onClick={() => handleFrameStep(1)}
            aria-label="前进一帧"
          >
            <IconChevronDown width={13} height={13} style={{ transform: 'rotate(-90deg)' }} />
          </button>
        </Tooltip>

        {/* A/B Loop */}
        <Tooltip
          title="A/B 循环播放"
          content={loopEnabled ? '关闭 A/B 区间循环播放' : '开启 A/B 区间循环播放'}
        >
          <button
            className={`btn btn--icon playback-controls__loop-toggle${loopEnabled ? ' btn--active' : ''}`}
            onClick={handleLoopToggle}
            aria-label="A/B循环"
            aria-pressed={loopEnabled}
          >
            <IconLoop width={14} height={14} />
          </button>
        </Tooltip>
        {loopEnabled && (
          <div className="playback-controls__loop-inputs" title="A/B 循环播放区间（单位：秒）">
            <span className="playback-controls__loop-tag">A</span>
            <input
              type="text"
              value={loopStart}
              onChange={e => handleLoopRegionChange('start', e.target.value)}
              title="循环起点 (秒)"
              aria-label="循环起点（秒）"
              className="playback-controls__loop-input tabular-nums"
            />
            <span className="playback-controls__loop-sep">至</span>
            <span className="playback-controls__loop-tag">B</span>
            <input
              type="text"
              value={loopEnd}
              onChange={e => handleLoopRegionChange('end', e.target.value)}
              title="循环终点 (秒)"
              aria-label="循环终点（秒）"
              className="playback-controls__loop-input tabular-nums"
            />
          </div>
        )}
      </div>

      {/* Speed Control */}
      <div className="playback-controls__control-group playback-controls__speed" role="group" aria-label="播放速度">
        <span className="playback-controls__control-label playback-controls__speed-label">倍速</span>
        <div className="playback-controls__segmented playback-controls__speed-group">
          {SPEED_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`playback-controls__segmented-btn playback-controls__speed-btn${speed === value ? ' is-active' : ''}`}
              onClick={() => handleSpeedChange(value)}
              aria-label={`${value} 倍播放速度`}
              aria-pressed={speed === value}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Current Time */}
      <Tooltip title="当前时间码" content="播放头当前所在时间点">
        <div
          ref={timeRef}
          className="playback-controls__time playback-controls__time--current tabular-nums"
        >
          {formatTime(initialTime)}
        </div>
      </Tooltip>

      {/* Progress Bar */}
      <div
        className="playback-controls__progress"
        onClick={handleSeek}
        onKeyDown={handleSeekKeyDown}
        ref={progressRef}
        role="slider"
        tabIndex={0}
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={initialProgressTime}
        aria-valuetext={formatTime(initialTime)}
      >
        <div
          ref={fillRef}
          className="playback-controls__progress-fill"
          style={{ width: `${duration > 0 ? (initialProgressTime / duration) * 100 : 0}%` }}
        />
      </div>

      {/* Duration */}
      <Tooltip title="总时长" content="当前场景总时间轴长度">
        <div
          className="playback-controls__time playback-controls__time--total tabular-nums"
        >
          {formatTime(duration)}
        </div>
      </Tooltip>

      {/* Preview Resolution */}
      <div className="playback-controls__control-group playback-controls__resolution" role="group" aria-label="预览分辨率">
        <span className="playback-controls__control-label playback-controls__resolution-label">预览</span>
        <div className="playback-controls__segmented playback-controls__resolution-group">
          {RESOLUTION_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`playback-controls__segmented-btn playback-controls__resolution-btn${previewResolution === value ? ' is-active' : ''}`}
              onClick={() => handlePreviewResolutionChange(value)}
              aria-label={`预览分辨率 ${label}`}
              aria-pressed={previewResolution === value}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default PlaybackControls;
