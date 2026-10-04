import React from 'react';
import { DragEngine, SnapConfig } from '../../engine/interaction/DragEngine';
import { usePlaybackAdapter, useDocumentStore } from '../context/AppContext';
import type { TimelineAction } from './semanticTimelineTypes';
import { buildSemanticTimelineReadModel } from './semanticTimelineReadModel';
import {
  emitTimelineInteractionFeedback,
  findMagneticSnapTarget,
} from './timelineInteractionFeedback';
import {
  pinTransientUntilCommitSettles,
  type TrackTransientState,
} from './transientCommit';

interface BatchDragOptions {
  blockRefs: React.RefObject<Map<string, HTMLElement>>;
  selectedIds: Record<string, boolean>;
  pps: number;
  onBatchDrag: (updates: Array<{ id: string; time: number }>) => void | Promise<unknown>;
  setTransientStates: React.Dispatch<React.SetStateAction<Record<string, TrackTransientState>>>;
  getSnapTargets: (id: string, excludeIds?: Record<string, boolean>) => number[];
}

export type BatchDragBlock = { id: string; initialTime: number; el?: HTMLElement };

export function collectSelectedBatchDragBlocks(
  selectedIds: Record<string, boolean>,
  timeline: TimelineAction[] | undefined,
  getElement: (id: string) => HTMLElement | undefined,
): BatchDragBlock[] {
  if (!timeline) return [];

  const actionById = new Map<string, TimelineAction>();
  for (const action of timeline) {
    if (action._id) actionById.set(action._id, action);
  }

  const blocks: BatchDragBlock[] = [];
  for (const id of Object.keys(selectedIds)) {
    if (!selectedIds[id]) continue;
    const action = actionById.get(id);
    if (!action) continue;
    blocks.push({
      id,
      initialTime: action.time ?? 0,
      el: getElement(id),
    });
  }

  return blocks;
}

export function constrainBatchDeltaTime(blocks: BatchDragBlock[], deltaTime: number): number {
  if (blocks.length === 0) return deltaTime;

  let minInitialTime = Number.POSITIVE_INFINITY;
  for (const block of blocks) {
    minInitialTime = Math.min(minInitialTime, block.initialTime);
  }

  return Math.max(deltaTime, -minInitialTime);
}

export function buildBatchDragUpdates(blocks: BatchDragBlock[], deltaTime: number): Array<{ id: string; time: number }> {
  const constrainedDeltaTime = constrainBatchDeltaTime(blocks, deltaTime);
  return blocks.map((block) => ({
    id: block.id,
    time: Math.max(0, parseFloat((block.initialTime + constrainedDeltaTime).toFixed(1))),
  }));
}

export function useBatchDrag({
  blockRefs,
  selectedIds,
  pps,
  onBatchDrag,
  setTransientStates,
  getSnapTargets,
}: BatchDragOptions) {
  const playbackAdapter = usePlaybackAdapter();
  const documentStore = useDocumentStore();

  const handlePointerDown = (e: React.PointerEvent, leadId: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();

    const leadEl = blockRefs.current?.get(leadId);
    if (!leadEl) return;

    // Capture pointer on the lead block when the browser has an active pointer.
    try {
      leadEl.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic automation events do not always create an active browser pointer.
    }

    const startX = e.clientX;
    const isShift = e.shiftKey;

    const semanticItems = buildSemanticTimelineReadModel(
      documentStore.getCurrentSceneDocumentSnapshot(),
      documentStore.getCompiledSceneSnapshot(),
    );
    const semanticActions = semanticItems.map((item) => item.displayAction);
    const blocks = collectSelectedBatchDragBlocks(
      selectedIds,
      semanticActions,
      (id) => blockRefs.current?.get(id),
    );

    const leadBlock = blocks.find(b => b.id === leadId);
    if (!leadBlock) return;

    // Set up dragging style cues
    blocks.forEach(b => b.el?.classList.add('is-dragging'));

    const dragEngine = new DragEngine();

    // CRITICAL REQUIREMENT 3: Snapping is evaluated ONLY against the lead block coordinate
    const snapConfig: SnapConfig = {
      gridStep: isShift ? 0 : 0.1,
      thresholdPx: 15,
      pixelsPerUnit: pps,
      getSnapTargets: () => {
        if (isShift) return [];
        return [playbackAdapter.getCurrentTime(), ...getSnapTargets(leadId, selectedIds)];
      }
    };

    dragEngine.beginDrag({ leadTime: leadBlock.initialTime }, snapConfig);
    emitTimelineInteractionFeedback({
      kind: 'batch-drag',
      phase: 'start',
      pointerX: e.clientX,
      pointerY: e.clientY,
      time: leadBlock.initialTime,
      deltaTime: 0,
      count: blocks.length,
      snapTime: null,
    });

    const onPointerMove = (me: PointerEvent) => {
      const dx = me.clientX - startX;
      const rawDeltas = { leadTime: dx / pps };

      const currentSnap = { ...snapConfig };
      if (me.shiftKey) {
        currentSnap.gridStep = 0;
        currentSnap.getSnapTargets = undefined;
      }

      const snappedDeltas = dragEngine.update(rawDeltas, currentSnap);
      const snappedDeltaTime = snappedDeltas.leadTime ?? (dx / pps);
      const constrainedDeltaTime = constrainBatchDeltaTime(blocks, snappedDeltaTime);
      const leadTime = leadBlock.initialTime + constrainedDeltaTime;
      const targets = currentSnap.getSnapTargets?.() ?? [];
      const snapTime = currentSnap.getSnapTargets
        ? findMagneticSnapTarget(leadTime, targets, currentSnap.thresholdPx, pps)
        : null;

      const nextTransientStates: Record<string, { time?: number; duration?: number }> = {};

      for (const b of blocks) {
        const finalTime = b.initialTime + constrainedDeltaTime;
        
        // High priority: synchronous DOM updates for all selected blocks
        if (b.el) {
          b.el.style.left = `${finalTime * pps}px`;
          (b.el as any)._dragTime = finalTime;
        }

        nextTransientStates[b.id] = { time: finalTime };
      }

      // Low priority: defer lanes recomputation for surrounding blocks
      React.startTransition(() => {
        setTransientStates(prev => ({
          ...prev,
          ...nextTransientStates
        }));
      });

      emitTimelineInteractionFeedback({
        kind: 'batch-drag',
        phase: 'update',
        pointerX: me.clientX,
        pointerY: me.clientY,
        time: leadTime,
        deltaTime: constrainedDeltaTime,
        count: blocks.length,
        snapTime,
      });
    };

    const onPointerUp = (ue: PointerEvent) => {
      try {
        leadEl.releasePointerCapture(ue.pointerId);
      } catch {}

      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);

      const finalDeltas = dragEngine.commit();
      const committedDeltaTime = finalDeltas.leadTime ?? 0;
      blocks.forEach(b => b.el?.classList.remove('is-dragging'));
      emitTimelineInteractionFeedback({
        kind: 'batch-drag',
        phase: 'end',
        pointerX: ue.clientX,
        pointerY: ue.clientY,
        time: leadBlock.initialTime + committedDeltaTime,
        deltaTime: committedDeltaTime,
        count: blocks.length,
        snapTime: null,
      });

      // Pin every selected block at its committed position until the batch
      // commit settles. Clearing the transients synchronously would flash
      // all dragged blocks back to their stale document times between drop
      // and commit (same flicker as single drag).
      const updates = buildBatchDragUpdates(blocks, committedDeltaTime);
      const pinned: Record<string, TrackTransientState> = {};
      for (const update of updates) {
        pinned[update.id] = { time: update.time };
      }
      setTransientStates(prev => ({
        ...prev,
        ...pinned,
      }));
      pinTransientUntilCommitSettles(
        setTransientStates,
        pinned,
        () => onBatchDrag(updates),
      );
      window.setTimeout(() => emitTimelineInteractionFeedback(null), 700);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  return { handlePointerDown };
}
