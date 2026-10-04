import React, { useLayoutEffect } from 'react';
import { usePlaybackAdapter } from '../context/AppContext';

export function usePlayhead(
  ref: React.RefObject<HTMLDivElement | null>,
  pps: number,
  areaRef: React.RefObject<HTMLDivElement | null>,
  onSeek: (time: number, isFinal: boolean) => void
) {
  const playbackAdapter = usePlaybackAdapter();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Initial position
    const initialTime = playbackAdapter.getCurrentTime();
    el.style.transform = `translateX(${initialTime * pps}px)`;

    // Playhead priority: Normal 60fps (16ms), Low 30fps (33ms)
    let lastUpdate = 0;
    const unsub = playbackAdapter.subscribeTime((time: number) => {
      const now = Date.now();
      const throttleMs = (document.documentElement.getAttribute('data-perf') === 'low') ? 33 : 16;

      if (now - lastUpdate > throttleMs) {
        el.style.transform = `translateX(${time * pps}px)`;
        lastUpdate = now;
      }
    });

    return unsub;
  }, [pps, ref, playbackAdapter]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const handleEl = e.currentTarget;
    const lineEl = ref.current;
    if (!lineEl || !areaRef.current) return;
    const areaRect = areaRef.current.getBoundingClientRect();
    const areaLeft = areaRect.left;

    handleEl.setPointerCapture(e.pointerId);

    const onMove = (moveEvent: PointerEvent) => {
      if (!areaRef.current || !lineEl) return;
      const x = moveEvent.clientX - areaLeft - 100;
      const time = Math.max(0, x / pps);
      
      // Update DOM transform immediately (high performance, no React re-render)
      lineEl.style.transform = `translateX(${time * pps}px)`;
      onSeek(time, false);
    };

    const onUp = (upEvent: PointerEvent) => {
      try {
        handleEl.releasePointerCapture(upEvent.pointerId);
      } catch {}
      
      if (areaRef.current && lineEl) {
        const x = upEvent.clientX - areaLeft - 100;
        const time = Math.max(0, x / pps);
        
        lineEl.style.transform = `translateX(${time * pps}px)`;
        onSeek(time, true);
      }

      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return { handlePointerDown };
}
