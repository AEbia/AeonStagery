import React from 'react';
import { DragEngine, SnapConfig } from '../../engine/interaction/DragEngine';
import { usePlaybackAdapter, useDocumentStore } from '../context/AppContext';
import {
  emitTimelineInteractionFeedback,
  findMagneticSnapTarget,
} from './timelineInteractionFeedback';
import { buildSemanticTimelineReadModel } from './semanticTimelineReadModel';
import {
  pinTransientUntilCommitSettles,
  type TrackTransientState,
} from './transientCommit';

interface BlockDragOptions {
  blockRefs: React.RefObject<Map<string, HTMLElement>>;
  pps: number;
  onDrag: (id: string, newTime: number, updates?: Array<{ id: string; time: number }>) => void | Promise<unknown>;
  setTransientStates: React.Dispatch<React.SetStateAction<Record<string, TrackTransientState>>>;
  getSnapTargets: (id: string, excludeIds?: Record<string, boolean>) => number[];
  getDragGroup?: (id: string, initialTime: number) => Array<{ id: string; initialTime: number }>;
}

export function useBlockDrag({
  blockRefs,
  pps,
  onDrag,
  setTransientStates,
  getSnapTargets,
  getDragGroup,
}: BlockDragOptions) {
  const playbackAdapter = usePlaybackAdapter();
  const documentStore = useDocumentStore();

  const handlePointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();

    const blockEl = blockRefs.current?.get(id);
    if (!blockEl) return;

    try {
      blockEl.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic automation events do not always create an active browser pointer.
    }

    const startX = e.clientX;
    const semanticItems = buildSemanticTimelineReadModel(
      documentStore.getCurrentSceneDocumentSnapshot(),
      documentStore.getCompiledSceneSnapshot(),
    );
    const semanticItem = semanticItems.find((item) => item.id === id);
    if (!semanticItem) return;
    const initialTime = semanticItem.time;

    const dragBlocks = getDragGroup?.(id, initialTime) ?? [{ id, initialTime }];
    for (const block of dragBlocks) {
      blockRefs.current?.get(block.id)?.classList.add('is-dragging');
    }
    const dragEngine = new DragEngine();

    const isShift = e.shiftKey;
    const snapConfig: SnapConfig = {
      gridStep: isShift ? 0 : 0.1,
      thresholdPx: 15,
      pixelsPerUnit: pps,
      getSnapTargets: () => {
        if (isShift) return [];
        return [playbackAdapter.getCurrentTime(), ...getSnapTargets(id)];
      }
    };

    dragEngine.beginDrag({ time: initialTime }, snapConfig);
    emitTimelineInteractionFeedback({
      kind: 'drag',
      phase: 'start',
      pointerX: e.clientX,
      pointerY: e.clientY,
      time: initialTime,
      deltaTime: 0,
      count: 1,
      snapTime: null,
    });

    const onPointerMove = (me: PointerEvent) => {
      const dx = me.clientX - startX;
      const rawDeltas = { time: dx / pps };
      
      const currentSnap = { ...snapConfig };
      if (me.shiftKey) {
        currentSnap.gridStep = 0;
        currentSnap.getSnapTargets = undefined;
      }
      
      const snappedDeltas = dragEngine.update(rawDeltas, currentSnap);
      const snappedTime = initialTime + (snappedDeltas.time ?? 0);
      const finalTime = Math.max(0, snappedTime);
      const targets = currentSnap.getSnapTargets?.() ?? [];
      const snapTime = currentSnap.getSnapTargets
        ? findMagneticSnapTarget(finalTime, targets, currentSnap.thresholdPx, pps)
        : null;

      const nextTimes = dragBlocks.map((block) => ({
        id: block.id,
        time: Math.max(0, block.initialTime + (finalTime - initialTime)),
      }));

      // High priority: synchronous update of the lead and its related blocks.
      for (const next of nextTimes) {
        const element = blockRefs.current?.get(next.id);
        if (!element) continue;
        element.style.left = `${next.time * pps}px`;
        (element as any)._dragTime = next.time;
      }

      // Low priority: defer lanes recomputation for surrounding blocks
      React.startTransition(() => {
        setTransientStates(prev => ({
          ...prev,
          ...Object.fromEntries(nextTimes.map((next) => [next.id, { time: next.time }])),
        }));
      });

      emitTimelineInteractionFeedback({
        kind: 'drag',
        phase: 'update',
        pointerX: me.clientX,
        pointerY: me.clientY,
        time: finalTime,
        deltaTime: finalTime - initialTime,
        count: 1,
        snapTime,
      });
    };

    const onPointerUp = (ue: PointerEvent) => {
      try {
        blockEl.releasePointerCapture(ue.pointerId);
      } catch {}
      
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);

      const finalDeltas = dragEngine.commit();
      const committedTime = Math.max(0, parseFloat((initialTime + (finalDeltas.time ?? 0)).toFixed(1)));
      for (const block of dragBlocks) {
        blockRefs.current?.get(block.id)?.classList.remove('is-dragging');
      }
      const updates = dragBlocks.map((block) => ({
        id: block.id,
        time: Math.max(0, parseFloat((block.initialTime + (committedTime - initialTime)).toFixed(1))),
      }));
      emitTimelineInteractionFeedback({
        kind: 'drag',
        phase: 'end',
        pointerX: ue.clientX,
        pointerY: ue.clientY,
        time: committedTime,
        deltaTime: committedTime - initialTime,
        count: 1,
        snapTime: null,
      });
      
      // Pin the block at its committed position until the asynchronous
      // authoring commit lands. Clearing the transient synchronously would
      // re-render the block at its stale document time between drop and
      // commit — the visible "jump back to the original position, then to
      // the target" flicker.
      const pinned: Record<string, TrackTransientState> = Object.fromEntries(
        updates.map((update) => [update.id, { time: update.time }]),
      );
      setTransientStates(prev => ({
        ...prev,
        ...pinned,
      }));
      pinTransientUntilCommitSettles(
        setTransientStates,
        pinned,
        () => onDrag(id, committedTime, updates),
      );
      window.setTimeout(() => emitTimelineInteractionFeedback(null), 700);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  return { handlePointerDown };
}
