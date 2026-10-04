import React from 'react';
import { resolveMarqueeRect, resolveMarqueeSelection } from '../../services/timeline-interaction/TimelineMarqueeResolver';

interface MarqueeSelectionOptions {
  areaRef: React.RefObject<HTMLDivElement | null>;
  marqueeRef: React.RefObject<HTMLDivElement | null>;
  getBlockGeometries: () => ReadonlyArray<BlockGeometry>;
  onSelect: (ids: string[], isMulti?: boolean) => void;
}

export interface BlockGeometry {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function useMarqueeSelection({
  areaRef,
  marqueeRef,
  getBlockGeometries,
  onSelect,
}: MarqueeSelectionOptions) {
  
  const handlePointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    const areaEl = areaRef.current;
    if (!areaEl || !areaEl.contains(target)) return;

    // Filter out pointer clicks intended for interactive targets
    const isBlock = target.closest('.track-block');
    const isRuler = target.closest('.timeline-ruler');
    const isPlayhead = target.closest('.playhead-handle') || target.classList.contains('playhead-line');
    const isTrackLabel = target.closest('.track-label');
    
    if (isBlock || isRuler || isPlayhead || isTrackLabel) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;

    areaEl.setPointerCapture(e.pointerId);

    const rect = areaEl.getBoundingClientRect();
    const startX = e.clientX - rect.left;
    const startY = e.clientY - rect.top;

    let hasMoved = false;

    const cachedBlocks = getBlockGeometries();

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (!marqueeRef.current) return;

      const currentX = moveEvent.clientX - rect.left;
      const currentY = moveEvent.clientY - rect.top;

      // Small jitter deadzone
      if (!hasMoved && Math.abs(currentX - startX) < 5 && Math.abs(currentY - startY) < 5) return;
      hasMoved = true;

      const marqueeRect = resolveMarqueeRect({ x: startX, y: startY }, { x: currentX, y: currentY });
      const minX = marqueeRect.xMin;
      const minY = marqueeRect.yMin;
      const width = marqueeRect.xMax - marqueeRect.xMin;
      const height = marqueeRect.yMax - marqueeRect.yMin;
      
      // Update marquee selection UI directly via DOM
      marqueeRef.current.style.display = 'block';
      marqueeRef.current.style.left = `${minX}px`;
      marqueeRef.current.style.top = `${minY}px`;
      marqueeRef.current.style.width = `${width}px`;
      marqueeRef.current.style.height = `${height}px`;
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      try {
        areaEl.releasePointerCapture(upEvent.pointerId);
      } catch {}

      const endX = upEvent.clientX - rect.left;
      const endY = upEvent.clientY - rect.top;

      if (hasMoved) {
        const selectedIds = resolveMarqueeSelection({
          start: { x: startX, y: startY },
          end: { x: endX, y: endY },
          blocks: cachedBlocks,
        });
        onSelect(selectedIds, false);
      } else {
        // Clear selection on single-click empty space
        onSelect([], false);
      }

      if (marqueeRef.current) {
        marqueeRef.current.style.display = 'none';
      }
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  return { handlePointerDown };
}
