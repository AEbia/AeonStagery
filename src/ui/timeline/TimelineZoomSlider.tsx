import React, { useEffect, useRef, useState } from 'react';
import { usePlaybackAdapter } from '../context/AppContext';

interface TimelineZoomSliderProps {
  pixelsPerSecond: number;
  setPixelsPerSecond: (pps: number) => void;
  maxTime: number;
  containerWidth: number;
  scrollLeft: number;
  setScrollLeft: (left: number) => void;
  onInteractionChange?: (isActive: boolean) => void;
  onViewportPreview?: (next: { pixelsPerSecond: number; scrollLeft: number }) => void;
  onViewportCommit?: (next: { pixelsPerSecond: number; scrollLeft: number }) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function computeSmartZoomWindow(params: {
  dragSide: 'left' | 'right';
  deltaTime: number;
  startTime: number;
  visibleTime: number;
  maxTime: number;
  focusTime: number;
  minVisibleTime: number;
}): { startTime: number; visibleTime: number } {
  const {
    dragSide,
    deltaTime,
    startTime,
    visibleTime,
    maxTime,
    focusTime,
    minVisibleTime,
  } = params;

  const visibleChange = dragSide === 'left' ? -2 * deltaTime : 2 * deltaTime;
  const nextVisibleTime = clamp(visibleTime + visibleChange, minVisibleTime, maxTime);
  const maxStart = Math.max(0, maxTime - nextVisibleTime);
  const currentCenter = startTime + visibleTime / 2;

  if (nextVisibleTime >= visibleTime) {
    const centeredOnWindowStart = currentCenter - nextVisibleTime / 2;
    return {
      startTime: clamp(centeredOnWindowStart, 0, maxStart),
      visibleTime: nextVisibleTime,
    };
  }

  const shrinkAmount = visibleTime - nextVisibleTime;
  const maxCenterShift = shrinkAmount / 2;
  const desiredCenterShift = focusTime - currentCenter;
  const nextCenter = clamp(
    currentCenter + clamp(desiredCenterShift, -maxCenterShift, maxCenterShift),
    nextVisibleTime / 2,
    Math.max(nextVisibleTime / 2, maxTime - nextVisibleTime / 2),
  );

  return {
    startTime: clamp(nextCenter - nextVisibleTime / 2, 0, maxStart),
    visibleTime: nextVisibleTime,
  };
}

export const TimelineZoomSlider = ({
  pixelsPerSecond,
  setPixelsPerSecond,
  maxTime,
  containerWidth,
  scrollLeft,
  setScrollLeft,
  onInteractionChange,
  onViewportPreview,
  onViewportCommit,
}: TimelineZoomSliderProps) => {
  const sliderRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState<'move' | 'left' | 'right' | null>(null);
  
  const startX = useRef(0);
  const startPPS = useRef(0);
  const startScroll = useRef(0);
  const startFocusTime = useRef(0);
  const activeDragRef = useRef<'move' | 'left' | 'right' | null>(null);
  const activePointerTargetRef = useRef<HTMLElement | null>(null);
  const pendingFrame = useRef<number | null>(null);
  const pendingUpdate = useRef<{ pps: number; scrollLeft: number } | null>(null);
  const lastPreviewViewport = useRef<{ pixelsPerSecond: number; scrollLeft: number } | null>(null);

  const cleanupPointerListenersRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      if (pendingFrame.current != null) {
        window.cancelAnimationFrame(pendingFrame.current);
      }
      onInteractionChange?.(false);
      cleanupPointerListenersRef.current?.();
    };
  }, [onInteractionChange]);

  const flushPendingUpdate = () => {
    pendingFrame.current = null;
    const pending = pendingUpdate.current;
    pendingUpdate.current = null;
    if (!pending) return;
    const nextViewport = {
      pixelsPerSecond: pending.pps,
      scrollLeft: pending.scrollLeft,
    };
    lastPreviewViewport.current = nextViewport;
    if (onViewportPreview) {
      onViewportPreview(nextViewport);
      return;
    }
    setPixelsPerSecond(nextViewport.pixelsPerSecond);
    setScrollLeft(nextViewport.scrollLeft);
  };

  const scheduleUpdate = (next: { pps: number; scrollLeft: number }) => {
    const rounded = {
      pps: Math.round(next.pps * 100) / 100,
      scrollLeft: Math.round(next.scrollLeft),
    };
    pendingUpdate.current = rounded;
    if (pendingFrame.current != null) return;
    pendingFrame.current = window.requestAnimationFrame(flushPendingUpdate);
  };

  // Time-based calculations
  const timeStart = scrollLeft / pixelsPerSecond;
  const timeVisible = containerWidth / pixelsPerSecond;
  const timeEnd = timeStart + timeVisible;
  const timeMax = Math.max(maxTime, timeEnd);
  const minVisibleTime = Math.max(0.01, containerWidth / 1000);
  const maxWindowStart = Math.max(0, timeMax - timeVisible);

  // Physical slider mappings
  const handleLeft = (timeStart / timeMax) * containerWidth;
  const handleWidth = Math.max(20, (timeVisible / timeMax) * containerWidth);

  const playbackAdapter = usePlaybackAdapter();

  const commitKeyboardViewport = (nextStartTime: number, nextVisibleTime: number) => {
    const boundedVisibleTime = Math.max(minVisibleTime, nextVisibleTime);
    const nextPps = clamp(containerWidth / boundedVisibleTime, 0.1, 1000);
    const actualVisibleTime = containerWidth / nextPps;
    const actualMaxStart = Math.max(0, timeMax - actualVisibleTime);
    const actualStartTime = clamp(nextStartTime, 0, actualMaxStart);
    const nextViewport = {
      pixelsPerSecond: Math.round(nextPps * 100) / 100,
      scrollLeft: Math.round(actualStartTime * nextPps),
    };
    const currentViewport = { pixelsPerSecond, scrollLeft };
    if (
      Math.abs(nextViewport.pixelsPerSecond - currentViewport.pixelsPerSecond) < 0.01
      && Math.abs(nextViewport.scrollLeft - currentViewport.scrollLeft) < 1
    ) return;

    onInteractionChange?.(true);
    lastPreviewViewport.current = nextViewport;
    if (onViewportPreview) {
      onViewportPreview(nextViewport);
    } else {
      setPixelsPerSecond(nextViewport.pixelsPerSecond);
      setScrollLeft(nextViewport.scrollLeft);
    }
    onViewportCommit?.(nextViewport);
    onInteractionChange?.(false);
  };

  const handleKeyboardDown = (
    type: 'move' | 'left' | 'right',
    event: React.KeyboardEvent<HTMLDivElement>,
  ) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();

    const step = Math.max(minVisibleTime, Math.min(1, timeVisible / 10));
    if (type === 'move') {
      const nextStartTime = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? maxWindowStart
          : clamp(
              timeStart + (event.key === 'ArrowRight' ? step : -step),
              0,
              maxWindowStart,
            );
      commitKeyboardViewport(nextStartTime, timeVisible);
      return;
    }

    if (type === 'left') {
      const maxStartTime = Math.max(0, timeEnd - minVisibleTime);
      const nextStartTime = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? maxStartTime
          : clamp(
              timeStart + (event.key === 'ArrowRight' ? step : -step),
              0,
              maxStartTime,
            );
      commitKeyboardViewport(nextStartTime, timeEnd - nextStartTime);
      return;
    }

    const minEndTime = Math.min(timeMax, timeStart + minVisibleTime);
    const nextEndTime = event.key === 'Home'
      ? minEndTime
      : event.key === 'End'
        ? timeMax
        : clamp(
            timeEnd + (event.key === 'ArrowRight' ? step : -step),
            minEndTime,
            timeMax,
          );
    commitKeyboardViewport(timeStart, nextEndTime - timeStart);
  };

  const updateDrag = (clientX: number) => {
    const dragType = activeDragRef.current;
    if (!dragType) return;
    const deltaX = clientX - startX.current;
    
    const s_timeStart = startScroll.current / startPPS.current;
    const s_timeVisible = containerWidth / startPPS.current;
    const s_timeEnd = s_timeStart + s_timeVisible;
    const s_timeMax = Math.max(maxTime, s_timeEnd);

    const deltaTime = (deltaX / containerWidth) * s_timeMax;
    
    const minVisibleTime = containerWidth / 1000;
    const maxTimeVisible = s_timeMax;

    if (dragType === 'move') {
      let newTimeStart = s_timeStart + deltaTime;
      newTimeStart = Math.max(0, Math.min(s_timeMax - s_timeVisible, newTimeStart));
      scheduleUpdate({ pps: startPPS.current, scrollLeft: newTimeStart * startPPS.current });
      return;
    }

    const smartWindow = computeSmartZoomWindow({
      dragSide: dragType,
      deltaTime,
      startTime: s_timeStart,
      visibleTime: s_timeVisible,
      maxTime: maxTimeVisible,
      focusTime: startFocusTime.current,
      minVisibleTime,
    });

    const newTimeVisible = smartWindow.visibleTime;
    const newPPS = containerWidth / newTimeVisible;
    const finalPPS = Math.max(0.1, Math.min(1000, newPPS));
    if (finalPPS === startPPS.current) return;

    const maxScroll = s_timeMax * finalPPS - containerWidth;
    const targetScrollLeft = clamp(
      smartWindow.startTime * finalPPS,
      0,
      Math.max(0, maxScroll),
    );

    scheduleUpdate({ pps: finalPPS, scrollLeft: targetScrollLeft });
  };

  const finishDrag = (pointerId?: number) => {
    if (pendingFrame.current != null) {
      window.cancelAnimationFrame(pendingFrame.current);
      flushPendingUpdate();
    }
    const activeTarget = activePointerTargetRef.current;
    if (activeTarget && pointerId !== undefined) {
      try {
        activeTarget.releasePointerCapture(pointerId);
      } catch {}
    }
    cleanupPointerListenersRef.current?.();
    cleanupPointerListenersRef.current = null;
    activeDragRef.current = null;
    activePointerTargetRef.current = null;
    setIsDragging(null);
    if (onViewportCommit && lastPreviewViewport.current) {
      onViewportCommit(lastPreviewViewport.current);
    }
    onInteractionChange?.(false);
  };

  const handlePointerDown = (type: 'move' | 'left' | 'right', e: React.PointerEvent) => {
    e.stopPropagation();
    cleanupPointerListenersRef.current?.();
    setIsDragging(type);
    activeDragRef.current = type;
    startX.current = e.clientX;
    startPPS.current = pixelsPerSecond;
    startScroll.current = scrollLeft;
    lastPreviewViewport.current = null;
    const dragStartTime = scrollLeft / pixelsPerSecond;
    const dragVisibleTime = containerWidth / pixelsPerSecond;
    const dragEndTime = dragStartTime + dragVisibleTime;
    const ctiTime = playbackAdapter.getCurrentTime();
    const currentCenterTime = (dragStartTime + dragEndTime) / 2;
    startFocusTime.current = ctiTime >= dragStartTime && ctiTime <= dragEndTime
      ? ctiTime
      : currentCenterTime;
    onInteractionChange?.(true);

    const targetEl = e.currentTarget as HTMLElement;
    activePointerTargetRef.current = targetEl;
    targetEl.setPointerCapture(e.pointerId);

    const onPointerMove = (moveEvent: PointerEvent) => {
      updateDrag(moveEvent.clientX);
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      finishDrag(upEvent.pointerId);
    };

    const onPointerCancel = () => {
      finishDrag();
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
    window.addEventListener('pointercancel', onPointerCancel, { once: true });
    cleanupPointerListenersRef.current = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
    };
  };

  return (
    <div
      ref={sliderRef}
      data-testid="timeline-zoom-slider"
      role="group"
      aria-label="时间轴缩放导航"
      style={{
        height: '12px',
        background: 'rgba(0,0,0,0.2)',
        position: 'relative',
        width: '100%',
        cursor: 'default',
        userSelect: 'none'
      }}
    >
      <div
        data-testid="timeline-zoom-window"
        role="slider"
        tabIndex={0}
        aria-label="移动时间轴可视窗口"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={maxWindowStart}
        aria-valuenow={timeStart}
        aria-valuetext={`时间轴显示 ${timeStart.toFixed(1)} 至 ${timeEnd.toFixed(1)} 秒`}
        style={{
          position: 'absolute',
          left: `${handleLeft}px`,
          width: `${handleWidth}px`,
          height: '100%',
          background: 'rgba(255, 255, 255, 0.15)',
          backdropFilter: 'blur(8px)',
          borderLeft: '2px solid var(--accent-primary)',
          borderRight: '2px solid var(--accent-primary)',
          cursor: isDragging ? 'grabbing' : 'grab',
          transition: 'background 0.2s, border-color 0.2s',
          boxShadow: '0 0 15px rgba(0,0,0,0.3)'
        }}
        onPointerDown={(e) => handlePointerDown('move', e)}
        onKeyDown={(e) => handleKeyboardDown('move', e)}
      >
        {/* Center Indicator */}
        <div style={{ position: 'absolute', inset: 0, height: '100%', borderTop: '1px solid rgba(255,255,255,0.1)', borderBottom: '1px solid rgba(255,255,255,0.1)' }} />
      </div>

      {/* Left Zoom Handle */}
      <div
        data-testid="timeline-zoom-handle-left"
        role="slider"
        tabIndex={0}
        aria-label="调整时间轴可视窗口左边界"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, timeEnd - minVisibleTime)}
        aria-valuenow={timeStart}
        aria-valuetext={`左边界 ${timeStart.toFixed(1)} 秒`}
        style={{
          position: 'absolute',
          left: `${handleLeft}px`,
          top: 0,
          width: '10px', height: '100%',
          background: 'var(--accent-primary)',
          cursor: 'ew-resize',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          opacity: 0.8,
          zIndex: 1,
        }}
        onPointerDown={(e) => handlePointerDown('left', e)}
        onKeyDown={(e) => handleKeyboardDown('left', e)}
      >
        <div style={{ width: '1px', height: '6px', background: '#fff', borderRadius: 'var(--radius-xs)', opacity: 0.5 }} />
      </div>

      {/* Right Zoom Handle */}
      <div
        data-testid="timeline-zoom-handle-right"
        role="slider"
        tabIndex={0}
        aria-label="调整时间轴可视窗口右边界"
        aria-orientation="horizontal"
        aria-valuemin={Math.min(timeMax, timeStart + minVisibleTime)}
        aria-valuemax={timeMax}
        aria-valuenow={timeEnd}
        aria-valuetext={`右边界 ${timeEnd.toFixed(1)} 秒`}
        style={{
          position: 'absolute',
          left: `${handleLeft + handleWidth - 10}px`,
          top: 0,
          width: '10px', height: '100%',
          background: 'var(--accent-primary)',
          cursor: 'ew-resize',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          opacity: 0.8,
          zIndex: 1,
        }}
        onPointerDown={(e) => handlePointerDown('right', e)}
        onKeyDown={(e) => handleKeyboardDown('right', e)}
      >
        <div style={{ width: '1px', height: '6px', background: '#fff', borderRadius: 'var(--radius-xs)', opacity: 0.5 }} />
      </div>
    </div>
  );
};
