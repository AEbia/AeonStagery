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
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 400 });
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const enabled = rows.length > 0;

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
        setMeasurementVersion((version) => version + 1);
      }
    };
    const onScroll = () => {
      if (frame === null) frame = window.requestAnimationFrame(update);
    };
    const observer = new ResizeObserver(update);
    observer.observe(container);
    container.addEventListener('scroll', onScroll, { passive: true });
    update();
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      container.removeEventListener('scroll', onScroll);
      observer.disconnect();
    };
  }, [containerRef, enabled]);

  const measure = useCallback((key: string, height: number) => {
    if (height <= 0 || heights.current.get(key) === height) return;
    heights.current.set(key, height);
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
    return { offsets, totalHeight, indexById };
  }, [rows, measurementVersion]);

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

  return { ...layout, indices, measure, setFocusedId };
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
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => measure(measurementKey, element.getBoundingClientRect().height);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, [measurementKey, measure]);
  useLayoutEffect(() => {
    if (ref.current) measure(measurementKey, ref.current.getBoundingClientRect().height);
  });

  return <div ref={ref} data-timeline-virtual-row="" onFocusCapture={onFocus}
    onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onBlur(); }}
    style={{ position: 'absolute', top, left: 0, width: '100%', display: 'flow-root', paddingBottom: gap }}>
    {children}
  </div>;
}
