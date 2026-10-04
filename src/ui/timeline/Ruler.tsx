import type { SceneMarker } from '../../api/types/scene-common';
import React, { useRef, useMemo } from 'react';
import { usePointerDrag } from '../hooks/usePointerDrag';
import { IconMarker } from '../icons';

const INTERVALS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600];

export type MarkerData = SceneMarker;

export const Ruler = React.memo(({ maxTime, pps, onSeek, scrollLeft, containerWidth, markers, onAddMarker, onRemoveMarker }: {
  maxTime: number; pps: number; onSeek: (t: number, isFinal?: boolean) => void;
  scrollLeft?: number; containerWidth?: number;
  markers?: MarkerData[];
  onAddMarker?: (time: number) => void;
  onRemoveMarker?: (markerId: string) => void;
}) => {
  const dragMoved = useRef(false);
  const dragStartX = useRef(0);
  const rulerRef = useRef<HTMLDivElement>(null);

  const activePps = pps;
  const activeScrollLeft = scrollLeft;

  const timeStep = useMemo(() => {
    return INTERVALS.find(i => i * activePps >= 80) || 3600;
  }, [activePps]);

  const formatLabel = (time: number) => {
    if (time >= 60 || timeStep >= 60) {
      const m = Math.floor(time / 60);
      const s = Math.floor(time % 60);
      if (timeStep < 1) {
        const ms = Math.floor((time % 1) * 10);
        return `${m}:${s.toString().padStart(2, '0')}.${ms}`;
      }
      return `${m}:${s.toString().padStart(2, '0')}`;
    }
    if (timeStep < 1) {
      return `${time.toFixed(1)}s`;
    }
    return `${time}s`;
  };

  const calcTime = (clientX: number, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    const x = clientX - rect.left - 100;
    return Math.max(0, x / activePps);
  };

  const dragHook = usePointerDrag({
    getKeys: () => ({ time: calcTime(dragStartX.current, rulerRef.current!) }),
    getSnapConfig: () => ({
      gridStep: 0,
      thresholdPx: 0,
      pixelsPerUnit: activePps,
    }),
    deltaMapper: (dx, _dy) => ({ time: dx / activePps }),
    onDragUpdate: (_snappedDeltas, finalValues, isFinal) => {
      const finalTime = Math.max(0, finalValues.time ?? 0);
      onSeek(finalTime, isFinal);
    },
    onDragEnd: (_finalDeltas, finalValues) => {
      const finalTime = Math.max(0, finalValues.time ?? 0);
      onSeek(finalTime, true);
    },
  });

  const lastClickTime = useRef(0);

  const handlePointerDown = (e: React.PointerEvent<HTMLElement>) => {
    e.stopPropagation();
    if (e.button !== 0) return;

    const now = Date.now();
    if (now - lastClickTime.current < 300) {
      if (onAddMarker) {
        const time = calcTime(e.clientX, e.currentTarget as HTMLElement);
        onAddMarker(time);
      }
      lastClickTime.current = 0;
      return;
    }
    lastClickTime.current = now;

    dragStartX.current = e.clientX;
    dragMoved.current = false;

    const initialTime = calcTime(e.clientX, e.currentTarget as HTMLElement);
    onSeek(initialTime, false);

    dragHook.handlePointerDown(e);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    if (dragMoved.current) return;
    if (!onAddMarker) return;
    const target = e.target as HTMLElement;
    if (target.closest('.ruler-marker')) return;
    const rulerEl = e.currentTarget as HTMLElement;
    const time = calcTime(e.clientX, rulerEl);
    onAddMarker(time);
  };

  const ticks = [];
  const numMajorTicks = Math.ceil(maxTime / timeStep);

  // Virtualize: only render ticks in the visible horizontal range
  let visStartIdx = 0;
  let visEndIdx = numMajorTicks;
  if (activeScrollLeft != null && containerWidth != null) {
    const visStartTime = (activeScrollLeft - 100) / activePps - timeStep;
    const visEndTime = (activeScrollLeft + containerWidth * 2) / activePps;
    visStartIdx = Math.max(0, Math.floor(visStartTime / timeStep));
    visEndIdx = Math.min(numMajorTicks, Math.ceil(visEndTime / timeStep) + 1);
  }

  for (let i = visStartIdx; i <= visEndIdx; i++) {
    const t = i * timeStep;
    ticks.push(
      <React.Fragment key={t}>
        <div
          className={`ruler-tick ruler-tick--major`}
          style={{ left: `${t * activePps}px` }}
        >
          <span className="ruler-tick__label">{formatLabel(t)}</span>
        </div>

        {/* Minor Ticks */}
        {timeStep * activePps > 40 && Array.from({ length: 4 }).map((_, j) => {
          const minorT = t + (j + 1) * (timeStep / 5);
          if (minorT >= maxTime || minorT >= (i + 1) * timeStep) return null;
          return (
            <div
              key={`${t}-minor-${j}`}
              className="ruler-tick ruler-tick--minor"
              style={{ left: `${minorT * activePps}px` }}
            />
          );
        })}
      </React.Fragment>
    );
  }

  return (
    <div
      ref={rulerRef}
      className="timeline-ruler"
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
    >
      <div className="timeline-ruler__header">
        TIMELINE
      </div>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {ticks}
        {markers?.map((m) => (
          <div key={m.markerId}
            className="ruler-marker"
            onClick={(e) => { e.stopPropagation(); onSeek(m.time); }}
            onDoubleClick={(e) => { e.stopPropagation(); onRemoveMarker?.(m.markerId); }}
            onContextMenu={(e) => { e.stopPropagation(); e.preventDefault(); onRemoveMarker?.(m.markerId); }}
            title={m.label + " (双击或右键删除)"}
            style={{
              position: 'absolute', left: `${m.time * activePps}px`, top: 2,
              color: m.color || '#f59e0b', cursor: 'pointer', zIndex: 10,
              transform: 'translateX(-50%)',
            }}
          >
            <IconMarker width={14} height={14} style={{ display: 'block', margin: '0 auto' }} />
            <div style={{ fontSize: 9, whiteSpace: 'nowrap', marginTop: -2, textAlign: 'center',
              textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>{m.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
});
