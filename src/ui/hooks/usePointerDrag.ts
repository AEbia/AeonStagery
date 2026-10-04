import { useRef, useCallback, useEffect } from 'react';
import { DragEngine, SnapConfig } from '../../engine/interaction/DragEngine';

export interface UsePointerDragOptions {
  /** Initial values to begin the drag with */
  getKeys: () => Record<string, number>;
  /** Configuration for grid/magnetic snapping */
  getSnapConfig: () => SnapConfig;
  /** Maps client pixel moves (dx, dy) to delta units (e.g. time delta) */
  deltaMapper: (dx: number, dy: number) => Record<string, number>;
  /** Direct high-performance callback on updates to bypass React re-renders */
  onDragUpdate: (
    snappedDeltas: Record<string, number>,
    finalValues: Record<string, number>,
    isFinal: boolean
  ) => void;
  /** Final commit callback */
  onDragEnd: (
    finalDeltas: Record<string, number>,
    finalValues: Record<string, number>
  ) => void;
  /** Optional cancel callback */
  onDragCancel?: () => void;
}

export function usePointerDrag(options: UsePointerDragOptions) {
  const engineRef = useRef(new DragEngine());
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Cleanup on unmount if a drag is active
  useEffect(() => {
    const engine = engineRef.current;
    return () => {
      if (engine.isDragging) {
        engine.cancel();
      }
    };
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent<Element> | PointerEvent) => {
    // Only support left button
    if (e.button !== 0) return;

    e.stopPropagation();

    // Set pointer capture if supported
    const target = e.currentTarget as Element;
    const pointerId = (e as any).pointerId;
    if (target && typeof target.setPointerCapture === 'function' && pointerId !== undefined) {
      try {
        target.setPointerCapture(pointerId);
      } catch (err) {
        console.warn('Failed to set pointer capture:', err);
      }
    }

    const startX = e.clientX;
    const startY = e.clientY;
    const opts = optionsRef.current;
    
    const initialKeys = opts.getKeys();
    const snapConfig = opts.getSnapConfig();
    const engine = engineRef.current;

    engine.beginDrag(initialKeys, snapConfig);

    const onPointerMove = (me: PointerEvent) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      const rawDeltas = opts.deltaMapper(dx, dy);
      
      const currentSnap = { ...opts.getSnapConfig() };
      if (me.shiftKey) {
        currentSnap.gridStep = 0;
        currentSnap.getSnapTargets = undefined;
      }
      const snappedDeltas = engine.update(rawDeltas, currentSnap);
      
      const finalValues: Record<string, number> = {};
      for (const k of Object.keys(initialKeys)) {
        finalValues[k] = initialKeys[k] + (snappedDeltas[k] ?? 0);
      }

      opts.onDragUpdate(snappedDeltas, finalValues, false);
    };

    const onPointerUp = () => {
      if (target && typeof target.releasePointerCapture === 'function' && pointerId !== undefined) {
        try {
          target.releasePointerCapture(pointerId);
        } catch {}
      }

      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);

      const finalDeltas = engine.commit();
      const finalValues: Record<string, number> = {};
      for (const k of Object.keys(initialKeys)) {
        finalValues[k] = initialKeys[k] + (finalDeltas[k] ?? 0);
      }

      opts.onDragUpdate(finalDeltas, finalValues, true);
      opts.onDragEnd(finalDeltas, finalValues);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }, []);

  return {
    handlePointerDown,
    isDragging: () => engineRef.current.isDragging,
  };
}
