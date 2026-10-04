import React from 'react';
import { DragEngine, type SnapConfig } from '../../engine/interaction/DragEngine';
import { usePlaybackAdapter } from '../context/AppContext';
import { emitTimelineInteractionFeedback, findMagneticSnapTarget } from './timelineInteractionFeedback';

interface BlockStartResizeOptions {
  blockRefs: React.RefObject<Map<string, HTMLElement>>;
  pps: number;
  onResizeStart: (id: string, newTime: number) => void;
  setTransientStates: React.Dispatch<React.SetStateAction<Record<string, { time?: number; duration?: number }>>>;
  getSnapTargets: (id: string, excludeIds?: Record<string, boolean>) => number[];
  getInitialRange: (id: string) => { time: number; duration: number } | undefined;
  getTimeBounds?: (id: string) => { min: number; max: number } | undefined;
}

export function useBlockStartResize({
  blockRefs,
  pps,
  onResizeStart,
  setTransientStates,
  getSnapTargets,
  getInitialRange,
  getTimeBounds,
}: BlockStartResizeOptions) {
  const playbackAdapter = usePlaybackAdapter();

  const handlePointerDown = (event: React.PointerEvent, id: string) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const block = blockRefs.current?.get(id);
    const initialRange = getInitialRange(id);
    if (!block || !initialRange) return;

    const startX = event.clientX;
    const activationDistancePx = 3;
    let interactionActive = false;
    const initialEnd = initialRange.time + initialRange.duration;
    const bounds = getTimeBounds?.(id) ?? { min: 0, max: initialEnd - 0.1 };
    const dragEngine = new DragEngine();
    const snapConfig: SnapConfig = {
      gridStep: event.shiftKey ? 0 : 0.1,
      thresholdPx: 15,
      pixelsPerUnit: pps,
      getSnapTargets: () => event.shiftKey
        ? []
        : [playbackAdapter.getCurrentTime(), ...getSnapTargets(id)],
    };
    dragEngine.beginDrag({ time: initialRange.time }, snapConfig);

    const update = (pointerEvent: PointerEvent) => {
      const pointerDelta = pointerEvent.clientX - startX;
      if (!interactionActive) {
        if (Math.abs(pointerDelta) < activationDistancePx) return;
        interactionActive = true;
        block.setPointerCapture(pointerEvent.pointerId);
        block.classList.add('is-resizing');
      }
      const currentSnap = { ...snapConfig };
      if (pointerEvent.shiftKey) {
        currentSnap.gridStep = 0;
        currentSnap.getSnapTargets = undefined;
      }
      const delta = dragEngine.update({ time: pointerDelta / pps }, currentSnap);
      const nextTime = Math.min(bounds.max, Math.max(bounds.min, initialRange.time + (delta.time ?? 0)));
      const nextDuration = initialEnd - nextTime;
      block.style.left = `${nextTime * pps}px`;
      block.style.width = `${Math.max(4, nextDuration * pps)}px`;
      React.startTransition(() => {
        setTransientStates((current) => ({ ...current, [id]: { time: nextTime, duration: nextDuration } }));
      });
      const targets = currentSnap.getSnapTargets?.() ?? [];
      emitTimelineInteractionFeedback({
        kind: 'resize',
        phase: 'update',
        pointerX: pointerEvent.clientX,
        pointerY: pointerEvent.clientY,
        time: nextTime,
        duration: nextDuration,
        endTime: initialEnd,
        snapTime: currentSnap.getSnapTargets
          ? findMagneticSnapTarget(nextTime, targets, currentSnap.thresholdPx, pps)
          : null,
      });
    };

    const clearInteraction = (pointerEvent: PointerEvent) => {
      if (interactionActive) {
        try { block.releasePointerCapture(pointerEvent.pointerId); } catch {}
      }
      window.removeEventListener('pointermove', update);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      block.classList.remove('is-resizing');
      block.style.left = `${initialRange.time * pps}px`;
      block.style.width = `${Math.max(4, initialRange.duration * pps)}px`;
      setTransientStates((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    };

    const finish = (pointerEvent: PointerEvent) => {
      if (!interactionActive) {
        dragEngine.cancel();
        clearInteraction(pointerEvent);
        emitTimelineInteractionFeedback(null);
        return;
      }
      const delta = dragEngine.commit();
      const finalDelta = delta.time ?? 0;
      const nextTime = finalDelta === 0
        ? initialRange.time
        : Math.min(
            bounds.max,
            Math.max(bounds.min, Number((initialRange.time + finalDelta).toFixed(1))),
          );
      clearInteraction(pointerEvent);
      if (nextTime === initialRange.time) {
        emitTimelineInteractionFeedback(null);
        return;
      }
      onResizeStart(id, nextTime);
      window.setTimeout(() => emitTimelineInteractionFeedback(null), 700);
    };

    const cancel = (pointerEvent: PointerEvent) => {
      dragEngine.cancel();
      clearInteraction(pointerEvent);
      emitTimelineInteractionFeedback(null);
    };

    window.addEventListener('pointermove', update);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
  };

  return { handlePointerDown };
}
