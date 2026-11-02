import { useLayoutEffect, useRef, type RefObject } from 'react';

interface PreviewPose extends Keyframe { opacity: string; transform: string }

/** Each committed direction owns its animation and completion; interrupted runs cannot dismiss a newer one. */
export function useResourcePreviewMotion(panelRef: RefObject<HTMLElement>, open: boolean, positioned: boolean, onExited: () => void) {
  const onExitedRef = useRef(onExited);
  const interruptedPose = useRef<PreviewPose | null>(null);
  onExitedRef.current = onExited;

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (!positioned) {
      if (!open) onExitedRef.current();
      return;
    }

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const skipMotion = () => document.hidden || reduced?.matches || Boolean(panel.closest('[data-perf="low"]'));
    const duration = open ? 240 : 160;
    let active = true;
    let completed = false;
    let animation: Animation | null = null;
    const complete = () => {
      if (!active || completed) return;
      completed = true;
      if (open) animation?.cancel();
      else onExitedRef.current();
    };

    const offsetX = panel.style.getPropertyValue('--preview-offset-x') || '0px';
    const offsetY = panel.style.getPropertyValue('--preview-offset-y') || '0px';
    const visible: PreviewPose = { opacity: '1', transform: 'translate(0px, 0px) scale(1)' };
    const from = interruptedPose.current ?? (open
      ? { opacity: '0', transform: `translate(${offsetX}, ${offsetY}) scale(0.96)` }
      : visible);
    const to = open ? visible : { opacity: '0', transform: `translate(${offsetX}, ${offsetY}) scale(0.97)` };
    interruptedPose.current = null;

    if (skipMotion()) { complete(); return; }
    // Environments without Web Animations still release retained previews without relying on DOM animation events.
    if (typeof panel.animate !== 'function') {
      const timeout = open ? undefined : window.setTimeout(complete, duration);
      return () => { active = false; window.clearTimeout(timeout); };
    }

    animation = panel.animate([from, to], {
      duration, easing: open ? 'cubic-bezier(0.16, 1, 0.3, 1)' : 'cubic-bezier(0.4, 0, 1, 1)', fill: 'both',
    });
    void animation.finished.then(complete, complete);

    const preferencesChanged = () => { if (skipMotion()) complete(); };
    reduced?.addEventListener('change', preferencesChanged);
    document.addEventListener('visibilitychange', preferencesChanged);
    const preferences = new MutationObserver(preferencesChanged);
    preferences.observe(document.documentElement, { attributes: true, attributeFilter: ['data-perf'] });
    return () => {
      active = false;
      preferences.disconnect();
      reduced?.removeEventListener('change', preferencesChanged);
      document.removeEventListener('visibilitychange', preferencesChanged);
      if (!completed) {
        // Read the presented pose before cancelling, so a reversal continues from the current frame.
        const current = window.getComputedStyle(panel);
        interruptedPose.current = { opacity: current.opacity || '1', transform: current.transform || 'none' };
      }
      animation.cancel();
    };
  }, [open, panelRef, positioned]);
}
