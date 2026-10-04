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

interface BlockResizeOptions {
  blockRefs: React.RefObject<Map<string, HTMLElement>>;
  pps: number;
  onResize?: (id: string, newDuration: number) => void | Promise<unknown>;
  setTransientStates: React.Dispatch<React.SetStateAction<Record<string, TrackTransientState>>>;
  getSnapTargets: (id: string, excludeIds?: Record<string, boolean>) => number[];
  getInitialRange?: (id: string) => { time: number; duration: number } | undefined;
  getMinimumDuration?: (id: string) => number | undefined;
  skipCommitWhenUnchanged?: boolean;
  activationDistancePx?: number;
  getRelatedResizeStates?: (
    id: string,
    initialTime: number,
    duration: number,
  ) => Record<string, TrackTransientState>;
}

export function useBlockResize({
  blockRefs,
  pps,
  onResize,
  setTransientStates,
  getSnapTargets,
  getInitialRange,
  getMinimumDuration,
  skipCommitWhenUnchanged = false,
  activationDistancePx = 0,
  getRelatedResizeStates,
}: BlockResizeOptions) {
  const playbackAdapter = usePlaybackAdapter();
  const documentStore = useDocumentStore();

  const handlePointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();

    const blockEl = blockRefs.current?.get(id);
    if (!blockEl) return;

    const startX = e.clientX;
    const initialRange = getInitialRange?.(id);
    const semanticItems = initialRange ? [] : buildSemanticTimelineReadModel(
      documentStore.getCurrentSceneDocumentSnapshot(),
      documentStore.getCompiledSceneSnapshot(),
    );
    const semanticItem = semanticItems.find((item) => item.id === id);
    if (!initialRange && !semanticItem) return;
    const initialTime = initialRange?.time ?? semanticItem!.time;
    const initialDuration = initialRange?.duration
      ?? (semanticItem!.durationSeconds || semanticItem!.displayAction.params.duration || 1);
    const minimumDuration = Math.max(0.1, getMinimumDuration?.(id) ?? 0.1);

    const dragEngine = new DragEngine();
    let interactionActive = activationDistancePx <= 0;

    const isShift = e.shiftKey;
    const snapConfig: SnapConfig = {
      gridStep: isShift ? 0 : 0.1,
      thresholdPx: 15,
      pixelsPerUnit: pps,
      getSnapTargets: () => {
        if (isShift) return [];
        return [playbackAdapter.getCurrentTime(), ...getSnapTargets(id)]
          .map(target => target - initialTime)
          .filter(target => target > 0);
      }
    };

    dragEngine.beginDrag({ duration: initialDuration }, snapConfig);

    const activateInteraction = (pointerEvent: Pick<PointerEvent, 'pointerId' | 'clientX' | 'clientY'>) => {
      if (interactionActive) return;
      interactionActive = true;
      try {
        blockEl.setPointerCapture(pointerEvent.pointerId);
      } catch {
        // Synthetic automation events do not always create an active browser pointer.
      }
      blockEl.classList.add('is-resizing');
      emitTimelineInteractionFeedback({
        kind: 'resize',
        phase: 'start',
        pointerX: pointerEvent.clientX,
        pointerY: pointerEvent.clientY,
        time: initialTime,
        duration: initialDuration,
        endTime: initialTime + initialDuration,
        snapTime: null,
      });
    };

    if (interactionActive) {
      try {
        blockEl.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic automation events do not always create an active browser pointer.
      }
      blockEl.classList.add('is-resizing');
      emitTimelineInteractionFeedback({
        kind: 'resize',
        phase: 'start',
        pointerX: e.clientX,
        pointerY: e.clientY,
        time: initialTime,
        duration: initialDuration,
        endTime: initialTime + initialDuration,
        snapTime: null,
      });
    }

    const onPointerMove = (me: PointerEvent) => {
      const dx = me.clientX - startX;
      if (!interactionActive) {
        if (Math.abs(dx) < activationDistancePx) return;
        activateInteraction(me);
      }
      const rawDeltas = { duration: dx / pps };
      
      const currentSnap = { ...snapConfig };
      if (me.shiftKey) {
        currentSnap.gridStep = 0;
        currentSnap.getSnapTargets = undefined;
      }
      
      const snappedDeltas = dragEngine.update(rawDeltas, currentSnap);
      const snappedDuration = initialDuration + (snappedDeltas.duration ?? 0);
      const finalDuration = Math.max(minimumDuration, snappedDuration);
      const endTime = initialTime + finalDuration;
      const targets = currentSnap.getSnapTargets?.().map(target => target + initialTime) ?? [];
      const snapTime = currentSnap.getSnapTargets
        ? findMagneticSnapTarget(endTime, targets, currentSnap.thresholdPx, pps)
        : null;
      
      // High priority: synchronous DOM style width update
      const newWidth = Math.max(4, finalDuration * pps);
      blockEl.style.width = `${newWidth}px`;
      (blockEl as any)._resizeDuration = finalDuration;

      const relatedStates = getRelatedResizeStates?.(id, initialTime, finalDuration) ?? {};
      for (const [relatedId, relatedState] of Object.entries(relatedStates)) {
        const relatedElement = blockRefs.current?.get(relatedId);
        if (relatedElement && relatedState.time !== undefined) {
          relatedElement.style.left = `${relatedState.time * pps}px`;
        }
      }

      // Low priority: defer lanes recomputation for surrounding blocks
      React.startTransition(() => {
        setTransientStates(prev => ({
          ...prev,
          ...relatedStates,
          [id]: { duration: finalDuration }
        }));
      });

      emitTimelineInteractionFeedback({
        kind: 'resize',
        phase: 'update',
        pointerX: me.clientX,
        pointerY: me.clientY,
        time: initialTime,
        duration: finalDuration,
        endTime,
        snapTime,
      });
    };

    const restoreAuthoritativeStyles = () => {
      blockEl.style.width = `${Math.max(4, initialDuration * pps)}px`;
      delete (blockEl as any)._resizeDuration;
    };

    const clearTransient = () => {
      setTransientStates(prev => {
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    };

    const clearInteraction = (pointerEvent: PointerEvent, restoreStyles: boolean) => {
      if (interactionActive) {
        try {
          blockEl.releasePointerCapture(pointerEvent.pointerId);
        } catch {}
      }
      blockEl.classList.remove('is-resizing');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      if (restoreStyles) restoreAuthoritativeStyles();
      clearTransient();
    };

    const onPointerUp = (ue: PointerEvent) => {
      if (!interactionActive) {
        dragEngine.cancel();
        clearInteraction(ue, true);
        emitTimelineInteractionFeedback(null);
        return;
      }
      const finalDeltas = dragEngine.commit();
      const finalDelta = finalDeltas.duration ?? 0;
      const committedDuration = finalDelta === 0
        ? initialDuration
        : Math.max(
            minimumDuration,
            parseFloat((initialDuration + finalDelta).toFixed(1)),
          );

      // Stop interaction styling and listeners without clearing the
      // transient: the authoring commit is asynchronous, so clearing it
      // synchronously would re-render the block back at its stale document
      // duration until the commit lands (the same jump-back flicker as
      // drag).
      if (interactionActive) {
        try {
          blockEl.releasePointerCapture(ue.pointerId);
        } catch {}
      }
      blockEl.classList.remove('is-resizing');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);

      if (skipCommitWhenUnchanged && committedDuration === initialDuration) {
        restoreAuthoritativeStyles();
        clearTransient();
        emitTimelineInteractionFeedback(null);
        return;
      }

      // Pin the block at its committed duration until the commit settles.
      const pinned: Record<string, TrackTransientState> = {
        ...(getRelatedResizeStates?.(id, initialTime, committedDuration) ?? {}),
        [id]: { duration: committedDuration },
      };
      setTransientStates(prev => ({
        ...prev,
        ...pinned,
      }));

      emitTimelineInteractionFeedback({
        kind: 'resize',
        phase: 'end',
        pointerX: ue.clientX,
        pointerY: ue.clientY,
        time: initialTime,
        duration: committedDuration,
        endTime: initialTime + committedDuration,
        snapTime: null,
      });

      pinTransientUntilCommitSettles(
        setTransientStates,
        pinned,
        () => onResize?.(id, committedDuration),
      );
      window.setTimeout(() => emitTimelineInteractionFeedback(null), 700);
    };

    const onPointerCancel = (ce: PointerEvent) => {
      dragEngine.cancel();
      clearInteraction(ce, true);
      emitTimelineInteractionFeedback(null);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  };

  return { handlePointerDown };
}
