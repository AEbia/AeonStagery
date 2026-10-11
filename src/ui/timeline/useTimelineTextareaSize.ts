import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

/** Preserve manual sizing and drafts while coalescing content-driven layout reads. */
export function useTimelineTextareaSize(ref: RefObject<HTMLTextAreaElement>, expanded: boolean, value: string) {
  const sizing = useRef({ expanded, height: '', manualMinimum: 0 });
  const metrics = useRef<{ lineHeight: number; padding: number; borders: number } | null>(null);
  const frame = useRef<number | null>(null);
  const previousValue = useRef(value);
  const resize = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const previous = sizing.current;
    if (previous.expanded !== expanded) previous.manualMinimum = 0;
    else if (element.style.height !== previous.height) {
      previous.manualMinimum = Number.parseFloat(element.style.height) || 0;
    }
    previous.expanded = expanded;
    if (!expanded) {
      if (element.style.height) element.style.height = '';
      previous.height = '';
      metrics.current = null;
      return;
    }
    if (!metrics.current) {
      const style = window.getComputedStyle(element);
      metrics.current = {
        lineHeight: Number.parseFloat(style.lineHeight) || (Number.parseFloat(style.fontSize) || 12) * 1.4,
        padding: (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0),
        borders: (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.borderBottomWidth) || 0),
      };
    }
    const { lineHeight, padding, borders } = metrics.current;
    element.style.height = 'auto';
    element.style.height = `${Math.min(lineHeight * 10 + padding + borders,
      Math.max(lineHeight * 5 + padding + borders, element.scrollHeight + borders, previous.manualMinimum))}px`;
    previous.height = element.style.height;
  }, [expanded, ref]);

  const scheduleResize = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null;
      resize();
    });
  }, [resize]);

  useLayoutEffect(() => {
    resize();
    return () => {
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [resize]);

  useLayoutEffect(() => {
    if (previousValue.current === value) return;
    previousValue.current = value;
    if (expanded) scheduleResize();
  }, [expanded, value, scheduleResize]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !expanded) return;
    let width = element.getBoundingClientRect().width;
    const invalidate = () => { metrics.current = null; scheduleResize(); };
    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === element);
      const nextWidth = entry?.borderBoxSize?.[0]?.inlineSize ?? element.getBoundingClientRect().width;
      if (nextWidth !== width) { width = nextWidth; invalidate(); }
    });
    observer.observe(element);
    // Theme/density changes and late-loaded fonts can alter metrics at a fixed width.
    const typography = new MutationObserver(invalidate);
    typography.observe(document.documentElement, { attributes: true });
    document.fonts?.addEventListener('loadingdone', invalidate);
    return () => {
      observer.disconnect();
      typography.disconnect();
      document.fonts?.removeEventListener('loadingdone', invalidate);
    };
  }, [expanded, ref, scheduleResize]);
}
