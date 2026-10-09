import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';

interface TimelineRowSize {
  id: string;
  measurementKey: string;
  estimatedHeight: number;
}

const OVERSCAN = 4;

/** Measure only mounted rows; retain a focused row so scrolling cannot discard its draft. */
export function useVirtualTimelineRows(containerRef: RefObject<HTMLDivElement>, rows: TimelineRowSize[]) {
  const heights = useRef(new Map<string, number>());
  const measurementRevision = useRef(0);
  const revealTargetId = useRef<string | null>(null);
  const revealScrollTop = useRef<number | null>(null);
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 400 });
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const enabled = rows.length > 0;

  const cancelReveal = useCallback(() => {
    revealTargetId.current = null;
    revealScrollTop.current = null;
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;
    let frame: number | null = null;
    let width = container.clientWidth;
    const update = () => {
      frame = null;
      const top = container.scrollTop;
      const height = container.clientHeight || 400;
      setViewport((current) => current.top === top && current.height === height ? current : { top, height });
      if (container.clientWidth !== width) {
        width = container.clientWidth;
        heights.current.clear();
        measurementRevision.current += 1;
        setMeasurementVersion((version) => version + 1);
      }
    };
    const onScroll = () => {
      if (revealScrollTop.current !== null && Math.abs(container.scrollTop - revealScrollTop.current) > 0.5) {
        cancelReveal();
      }
      if (frame === null) frame = window.requestAnimationFrame(update);
    };
    const observer = new ResizeObserver(update);
    observer.observe(container);
    container.addEventListener('scroll', onScroll, { passive: true });
    container.addEventListener('wheel', cancelReveal, { passive: true });
    container.addEventListener('pointerdown', cancelReveal);
    container.addEventListener('keydown', cancelReveal);
    update();
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      container.removeEventListener('scroll', onScroll);
      container.removeEventListener('wheel', cancelReveal);
      container.removeEventListener('pointerdown', cancelReveal);
      container.removeEventListener('keydown', cancelReveal);
      observer.disconnect();
    };
  }, [cancelReveal, containerRef, enabled]);

  const measure = useCallback((key: string, height: number) => {
    if (height <= 0 || heights.current.get(key) === height) return;
    heights.current.set(key, height);
    measurementRevision.current += 1;
    setMeasurementVersion((version) => version + 1);
  }, []);

  const layout = useMemo(() => {
    void measurementVersion;
    let totalHeight = 0;
    const indexById = new Map<string, number>();
    const offsets = rows.map((row, index) => {
      indexById.set(row.id, index);
      const top = totalHeight;
      totalHeight += heights.current.get(row.measurementKey) ?? row.estimatedHeight;
      return top;
    });
    return { offsets, totalHeight, indexById, revision: measurementRevision.current };
  }, [rows, measurementVersion]);

  const revealRow = useCallback((id: string) => {
    const container = containerRef.current;
    const index = layout.indexById.get(id);
    if (!container || index === undefined) return false;
    revealTargetId.current = id;
    const height = container.clientHeight || 400;
    const top = layout.offsets[index];
    // Align each new selection, including headings already inside the viewport.
    const targetTop = Math.min(top, Math.max(0, layout.totalHeight - height));
    if (Math.abs(targetTop - container.scrollTop) > 0.5) {
      container.scrollTop = targetTop;
    }
    revealScrollTop.current = container.scrollTop;
    // Mount the destination without waiting for the browser's scroll event.
    setViewport((current) => current.top === container.scrollTop && current.height === height
      ? current : { top: container.scrollTop, height });
    return true;
  }, [containerRef, layout]);

  useLayoutEffect(() => {
    const id = revealTargetId.current;
    // Keep following the destination as earlier rows animate or resize. Wait
    // for child measurements to reach the layout before correcting its offset.
    if (id === null || layout.revision !== measurementRevision.current) return;
    const index = layout.indexById.get(id);
    if (index === undefined) {
      cancelReveal();
      return;
    }
    if (!heights.current.has(rows[index].measurementKey)) return;
    revealRow(id);
  }, [cancelReveal, layout, revealRow, rows]);

  // Binary search keeps scroll updates independent of the total row count.
  const findRow = (position: number) => {
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (layout.offsets[mid] <= position) low = mid + 1;
      else high = mid;
    }
    return Math.max(0, low - 1);
  };
  const start = Math.max(0, findRow(viewport.top) - OVERSCAN);
  const end = Math.min(rows.length, findRow(viewport.top + viewport.height) + OVERSCAN + 1);
  const indices = Array.from({ length: end - start }, (_, index) => start + index);
  const focusedIndex = focusedId === null ? -1 : layout.indexById.get(focusedId) ?? -1;
  if (focusedIndex >= 0 && (focusedIndex < start || focusedIndex >= end)) indices.push(focusedIndex);

  return { offsets: layout.offsets, totalHeight: layout.totalHeight,
    indexById: layout.indexById, indices, measure, setFocusedId, revealRow, cancelReveal };
}

export function MeasuredTimelineRow({ measurementKey, top, gap, measure, children, onFocus, onBlur }: {
  measurementKey: string;
  top: number;
  gap: number;
  measure: (key: string, height: number) => void;
  children: ReactNode;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Observe content and animation changes instead of measuring on every render:
  // a changing height would otherwise synchronously trigger another render.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => measure(measurementKey, element.getBoundingClientRect().height);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, [measurementKey, measure]);
  return <div ref={ref} data-timeline-virtual-row="" onFocusCapture={onFocus}
    onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onBlur(); }}
    style={{ position: 'absolute', top, left: 0, width: '100%', display: 'flow-root', paddingBottom: gap }}>
    {children}
  </div>;
}
