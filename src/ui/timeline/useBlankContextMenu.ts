import { useState, useEffect, type MutableRefObject, type RefObject } from 'react';
import { showToast } from '../Toast';
import { useOptionalApp } from '../context/AppContext';

interface BlankContextMenuOptions {
  areaRef: RefObject<HTMLDivElement | null>;
  trackRefs: MutableRefObject<Map<string, HTMLDivElement>>;
  pps: number;
}

export function useBlankContextMenu({
  areaRef,
  trackRefs,
  pps,
}: BlankContextMenuOptions) {
  const app = useOptionalApp();
  const isOffline = app?.collaboration?.status === 'offline' || app?.collaboration?.status === 'reconnecting';
  const [blankMenu, setBlankMenu] = useState<{
    x: number;
    y: number;
    time: number;
    charId: string | null;
    charLabel: string | null;
  } | null>(null);

  // Close blank context menu on mousedown outside
  useEffect(() => {
    if (!blankMenu) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.track-blank-menu')) {
        setBlankMenu(null);
      }
    };
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setBlankMenu(null);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [blankMenu]);

  const handleContextMenu = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    
    // Only trigger context menu on empty/blank space inside tracks
    if (target.closest('.track-block') || target.closest('.track-label')) return;

    if (isOffline) {
      e.preventDefault();
      showToast('共享编辑已暂停；请重新加入后才能编辑。', 'warning');
      return;
    }
    
    e.preventDefault();
    const areaEl = areaRef.current;
    if (!areaEl) return;

    const rect = areaEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = Math.max(0, Math.round((x - 100) / pps * 10) / 10);
    
    let row = target.closest('.track-row') as HTMLElement | null;
    if (!row) {
      trackRefs.current.forEach((trackEl) => {
        if (row) return;
        const trackRect = trackEl.getBoundingClientRect();
        if (e.clientY >= trackRect.top && e.clientY <= trackRect.bottom) {
          row = trackEl;
        }
      });
    }

    let charId: string | null = null;
    let charLabel: string | null = null;
    if (row && row.dataset.trackId) {
      const tid = row.dataset.trackId;
      if (tid.startsWith('char:')) {
        charId = tid.slice(5);
        charLabel = row.dataset.trackLabel || null;
      }
    }
    
    setBlankMenu({
      x: e.clientX,
      y: e.clientY,
      time,
      charId,
      charLabel,
    });
  };

  return { blankMenu, setBlankMenu, handleContextMenu };
}
