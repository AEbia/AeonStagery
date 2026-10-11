import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { TimelineRowLayout, type TimelineRowSize } from './TimelineRowLayout';

const OVERSCAN = 4;

/** Measure only mounted rows; retain a focused row so scrolling cannot discard its draft. */
export function useVirtualTimelineRows(containerRef: RefObject<HTMLDivElement>, rows: TimelineRowSize[]) {
  const heights = useRef(new Map<string, number>());
  const pendingHeights = useRef(new Map<string, number>());
  const measurementFrame = useRef<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const mountedRows = useRef(new Map<string, HTMLDivElement>());
  const committedLayout = useRef<TimelineRowLayout | null>(null);
  const measurementRevision = useRef(0);
  const cacheGenerationRef = useRef(0);
  const [cacheGeneration, setCacheGeneration] = useState(0);
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

  const registerRow = useCallback((id: string, element: HTMLDivElement | null) => {
    if (element) mountedRows.current.set(id, element);
    else mountedRows.current.delete(id);
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
        pendingHeights.current.clear();
        measurementRevision.current += 1;
        cacheGenerationRef.current += 1;
        setCacheGeneration(cacheGenerationRef.current);
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

  // A new callback makes mounted rows remeasure after width invalidation;
  // notifications from the previous observers cannot repopulate the new cache.
  const measure = useCallback((key: string, height: number, defer = false) => {
    if (cacheGeneration !== cacheGenerationRef.current || !Number.isFinite(height)
      || height <= 0 || heights.current.get(key) === height) return;
    heights.current.set(key, height);
    pendingHeights.current.set(key, height);
    measurementRevision.current += 1;
    if (defer && committedLayout.current) {
      // Keep animated neighbors aligned before paint. React receives one batch
      // next frame, but these geometry-only wrappers need no content rerender.
      const current = committedLayout.current;
      current.setHeight(key, height);
      mountedRows.current.forEach((element, id) => {
        const index = current.indexById.get(id);
        if (index === undefined) return;
        const top = `${current.getOffset(index)}px`;
        if (element.style.top !== top) element.style.top = top;
      });
      const totalHeight = `${current.totalHeight}px`;
      if (contentRef.current && contentRef.current.style.height !== totalHeight) {
        contentRef.current.style.height = totalHeight;
      }
    }
    if (!defer) {
      // Initial mounts must settle before paint so reveal and focus stay exact.
      setMeasurementVersion((version) => version + 1);
    } else if (measurementFrame.current === null) {
      const frame = window.requestAnimationFrame(() => {
        if (measurementFrame.current !== frame) return;
        measurementFrame.current = null;
        setMeasurementVersion((version) => version + 1);
      });
      measurementFrame.current = frame;
    }
  }, [cacheGeneration]);

  useLayoutEffect(() => () => {
    if (measurementFrame.current !== null) window.cancelAnimationFrame(measurementFrame.current);
    measurementFrame.current = null;
  }, []);

  const rowLayout = useMemo(() => new TimelineRowLayout(rows, heights.current), [rows, cacheGeneration]);
  useLayoutEffect(() => { committedLayout.current = rowLayout; }, [rowLayout]);
  const layout = useMemo(() => {
    void measurementVersion;
    pendingHeights.current.forEach((height, key) => rowLayout.setHeight(key, height));
    pendingHeights.current.clear();
    return { rowLayout, totalHeight: rowLayout.totalHeight, revision: measurementRevision.current };
  }, [rowLayout, measurementVersion]);

  useLayoutEffect(() => {
    if (layout.revision === measurementRevision.current && measurementFrame.current !== null) {
      // Synchronous mount/width updates may have already consumed this batch.
      window.cancelAnimationFrame(measurementFrame.current);
      measurementFrame.current = null;
    }
  }, [layout]);

  const revealRow = useCallback((id: string) => {
    const container = containerRef.current;
    const index = rowLayout.indexById.get(id);
    if (!container || index === undefined) return false;
    revealTargetId.current = id;
    const height = container.clientHeight || 400;
    const top = rowLayout.getOffset(index);
    // Align each new selection, including headings already inside the viewport.
    const targetTop = Math.min(top, Math.max(0, rowLayout.totalHeight - height));
    if (Math.abs(targetTop - container.scrollTop) > 0.5) {
      container.scrollTop = targetTop;
    }
    revealScrollTop.current = container.scrollTop;
    // Mount the destination without waiting for the browser's scroll event.
    setViewport((current) => current.top === container.scrollTop && current.height === height
      ? current : { top: container.scrollTop, height });
    return true;
  }, [containerRef, layout, rowLayout]);

  useLayoutEffect(() => {
    const id = revealTargetId.current;
    // Keep following the destination as earlier rows animate or resize. Wait
    // for child measurements to reach the layout before correcting its offset.
    if (id === null || layout.revision !== measurementRevision.current) return;
    const index = rowLayout.indexById.get(id);
    if (index === undefined) {
      cancelReveal();
      return;
    }
    if (!heights.current.has(rows[index].measurementKey)) return;
    revealRow(id);
  }, [cancelReveal, layout, revealRow, rows, rowLayout]);

  const start = Math.max(0, rowLayout.findRow(viewport.top) - OVERSCAN);
  const end = Math.min(rows.length, rowLayout.findRow(viewport.top + viewport.height) + OVERSCAN + 1);
  const indices = Array.from({ length: end - start }, (_, index) => start + index);
  const focusedIndex = focusedId === null ? -1 : rowLayout.indexById.get(focusedId) ?? -1;
  if (focusedIndex >= 0 && (focusedIndex < start || focusedIndex >= end)) indices.push(focusedIndex);

  return { getOffset: rowLayout.getOffset, totalHeight: layout.totalHeight, contentRef, registerRow,
    indexById: rowLayout.indexById, indices, measure, setFocusedId, revealRow, cancelReveal };
}

export function MeasuredTimelineRow({ id, measurementKey, top, gap, measure, registerRow, children, onFocus, onBlur }: {
  id: string;
  measurementKey: string;
  top: number;
  gap: number;
  measure: (key: string, height: number, defer?: boolean) => void;
  registerRow: (id: string, element: HTMLDivElement | null) => void;
  children: ReactNode;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    registerRow(id, ref.current);
    return () => registerRow(id, null);
  }, [id, registerRow]);
  // Observe content and animation changes instead of measuring on every render:
  // a changing height would otherwise synchronously trigger another render.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === element);
      measure(measurementKey, entry?.borderBoxSize?.[0]?.blockSize ?? element.getBoundingClientRect().height, true);
    });
    observer.observe(element);
    measure(measurementKey, element.getBoundingClientRect().height);
    return () => observer.disconnect();
  }, [measurementKey, measure]);
  return <div ref={ref} data-timeline-virtual-row="" onFocusCapture={onFocus}
    onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onBlur(); }}
    style={{ position: 'absolute', top, left: 0, width: '100%', display: 'flow-root', paddingBottom: gap }}>
    {children}
  </div>;
}
