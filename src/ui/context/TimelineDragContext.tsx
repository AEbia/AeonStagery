import React, { createContext, useContext, useRef, useCallback, useEffect, useState } from 'react';
import { DragEngine, SnapConfig } from '../../engine/interaction/DragEngine';

interface TimelineDragCtx {
  engine: DragEngine;
  /** Begin a batch drag for multiple blocks (shared engine). */
  beginBatchDrag: (blocks: Array<{ id: string; time: number }>, snap: number, pps: number) => void;
  /** Update the shared drag delta. Returns snapped times keyed by block id. */
  updateBatchDrag: (deltaPx: number) => Record<string, number> | null;
  /** Commit batch drag. Returns { id → newTime } for all blocks. */
  commitBatchDrag: () => Record<string, number>;
  /** Cancel batch drag. */
  cancelBatchDrag: () => void;
}

const DragCtx = createContext<TimelineDragCtx | null>(null);

export function TimelineDragProvider({ children }: { children: React.ReactNode }) {
  const engineRef = useRef(new DragEngine());
  const ppsRef = useRef(50);
  const [, setTick] = useState(0);
  const forceUpdate = useCallback(() => setTick(n => n + 1), []);

  useEffect(() => {
    const engine = engineRef.current;
    engine.onChange.add(forceUpdate);
    return () => {
      engine.onChange.delete(forceUpdate);
    };
  }, [forceUpdate]);

  const beginBatchDrag = useCallback(
    (blocks: Array<{ id: string; time: number }>, snap: number, pps: number) => {
      const engine = engineRef.current;
      if (engine.isDragging) engine.cancel();

      ppsRef.current = pps;
      const keys: Record<string, number> = {};
      for (const b of blocks) {
        keys[b.id] = b.time;
      }

      const snapConfig: SnapConfig = {
        gridStep: snap,
        thresholdPx: 8,
        pixelsPerUnit: pps,
      };
      engine.beginDrag(keys, snapConfig);
    },
    [],
  );

  const updateBatchDrag = useCallback((deltaPx: number) => {
    const engine = engineRef.current;
    if (!engine.isDragging) return null;

    const pps = ppsRef.current;
    const rawDeltas: Record<string, number> = {};
    
    // We access internal keys from the engine to map pixel delta to delta-time
    const keys = (engine as any)._keys;
    if (!keys) return null;
    for (const id of Object.keys(keys)) {
      rawDeltas[id] = deltaPx / pps;
    }

    const snappedDeltas = engine.update(rawDeltas);
    const finalValues: Record<string, number> = {};
    for (const id of Object.keys(keys)) {
      finalValues[id] = keys[id] + (snappedDeltas[id] ?? 0);
    }
    return finalValues;
  }, []);

  const commitBatchDrag = useCallback(() => {
    const engine = engineRef.current;
    const keys = (engine as any)._keys; // get initial keys before commit resets them
    const finalDeltas = engine.commit();
    const finalValues: Record<string, number> = {};
    if (keys) {
      for (const id of Object.keys(keys)) {
        finalValues[id] = keys[id] + (finalDeltas[id] ?? 0);
      }
    }
    return finalValues;
  }, []);

  const cancelBatchDrag = useCallback(() => {
    engineRef.current.cancel();
  }, []);

  return React.createElement(DragCtx.Provider, {
    value: {
      engine: engineRef.current,
      beginBatchDrag,
      updateBatchDrag,
      commitBatchDrag,
      cancelBatchDrag,
    },
  }, children);
}

export function useTimelineDrag(): TimelineDragCtx {
  const ctx = useContext(DragCtx);
  if (!ctx) throw new Error('useTimelineDrag must be used within TimelineDragProvider');
  return ctx;
}
