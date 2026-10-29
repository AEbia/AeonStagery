import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { focusHomeView, playHomeMotion, type MotionStep } from './homeMotion';

/** Presentation lifetime is independent of project lifetime: the home can finish its exit. */
export function useWorkspaceTransition(homeRequested: boolean, editorReady = true) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [retainedHome, setRetainedHome] = useState(homeRequested);
  // Project metadata is published before its default scene finishes loading.
  // Keep the home and its current view until there is an editor scene to reveal.
  const showHome = homeRequested || (retainedHome && !editorReady);
  const [transitioning, setTransitioning] = useState(false);
  const [returningBusy, setReturningBusy] = useState(false);
  const busy = transitioning || returningBusy;
  const pendingFocus = useRef<'home' | 'editor' | null>(null);
  const previous = useRef(showHome);
  const returning = useRef(false);
  const returnMotion = useRef<ReturnType<typeof playHomeMotion>>(null);
  const completedMotion = useRef<ReturnType<typeof playHomeMotion>>(null);
  const mounted = useRef(true);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; returnMotion.current?.cancel(); };
  }, []);

  useLayoutEffect(() => {
    if (previous.current === showHome) return;
    previous.current = showHome;
    const root = rootRef.current;
    const home = root?.querySelector<HTMLElement>('.ph-overlay');
    if (!root || !home) { setRetainedHome(showHome); return; }
    setRetainedHome(true);
    const steps: MotionStep[] = [];
    const add = (selector: string, keyframes: Keyframe[], duration: number, delay = 0) => {
      root.querySelectorAll<HTMLElement>(selector).forEach((element) => steps.push({ element, keyframes, duration, delay }));
    };
    if (showHome) {
      // The new opaque home backdrop is mounted before releasing the editor's exit pose.
      returnMotion.current?.cancel();
      returnMotion.current = null;
      // The backdrop covers the cleared editor while its replacement comes into focus.
      add('.ph-shell', [
        { opacity: 0, transform: 'perspective(1400px) translate3d(0, -30px, -160px)' },
        { opacity: 1, transform: 'perspective(1400px) translate3d(0, 0, 0)' },
      ], 480);
    } else {
      home.dataset.departing = 'true';
      const selected = home.querySelector<HTMLElement>('.ph-board__slot[data-selected] .ph-board__card');
      if (selected) {
        // Advance through the selected frame, then expose the live editor behind it.
        const initial = getComputedStyle(selected).transform;
        steps.push({ element: selected, duration: 620, keyframes: [
          { transform: initial, opacity: 1 },
          { transform: 'translate3d(0, -10px, 180px) rotateX(0deg) scale(1.12)', opacity: 1, offset: 0.45 },
          { transform: 'translate3d(0, -24px, 500px) rotateX(0deg) scale(1.8)', opacity: 0 },
        ] });
        add('.ph-board__slot:not([data-selected]) .ph-board__card', [
          { opacity: 1, transform: 'translateZ(0)' },
          { opacity: 0, transform: 'translate3d(0, 48px, -220px) scale(0.8)' },
        ], 260);
      } else {
        add('.ph-view-stage', [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.08) translateY(-24px)' }], 320);
      }
      add('.ph-command-rail, .ph-sources, .ph-board__toolbar, .ph-board__details, .ph-start__library', [
        { opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(24px)' },
      ], 230);
      steps.push({ element: home, duration: 620, easing: 'linear', keyframes: [
        { opacity: 1 }, { opacity: 1, offset: 0.32 }, { opacity: 0 },
      ] });
      add('.main-content', [
        { opacity: 0, transform: 'perspective(1400px) translateZ(-100px)' },
        { opacity: 1, transform: 'perspective(1400px) translateZ(0)' },
      ], 440, 180);
      add('.bottom-panel', [
        { opacity: 0, transform: 'translateY(36px)' }, { opacity: 1, transform: 'translateY(0)' },
      ], 360, 260);
    }
    let active = true;
    const motion = playHomeMotion(steps);
    const complete = () => {
      if (!active) return;
      // Hold the last frame until React removes the old home; early cancellation restores it for a frame.
      completedMotion.current = motion;
      setRetainedHome(showHome);
      pendingFocus.current = showHome ? 'home' : 'editor';
      setTransitioning(false);
    };
    if (motion) { setTransitioning(true); void motion.finished.then(complete); }
    else complete();
    return () => { active = false; motion?.cancel(); delete home.dataset.departing; };
  }, [showHome]);

  useLayoutEffect(() => {
    completedMotion.current?.cancel();
    completedMotion.current = null;
  });

  useLayoutEffect(() => {
    if (busy || !pendingFocus.current || document.querySelector('[aria-modal="true"]')) return;
    const root = rootRef.current;
    if (pendingFocus.current === 'home') {
      const home = root?.querySelector<HTMLElement>('.ph-overlay');
      if (home) focusHomeView(home);
    } else root?.querySelector<HTMLElement>('.top-bar__brand-control--return')?.focus({ preventScroll: true });
    pendingFocus.current = null;
  }, [busy, retainedHome, showHome]);

  const returnHome = useCallback(async (close: () => Promise<boolean>) => {
    if (returning.current) return false;
    returning.current = true;
    setReturningBusy(true);
    const panels = rootRef.current?.querySelectorAll<HTMLElement>('.main-content, .bottom-panel');
    returnMotion.current = playHomeMotion(Array.from(panels ?? []).map((element) => ({
      element, duration: 240, easing: 'cubic-bezier(0.4, 0, 1, 1)',
      keyframes: [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.94) translateY(24px)' }],
    })));
    let closed = false;
    try {
      await returnMotion.current?.finished;
      if (!mounted.current) return false;
      closed = await close();
      if (!closed && mounted.current) {
        // A failed save keeps the editor and brings it back into focus.
        returnMotion.current?.cancel();
        returnMotion.current = playHomeMotion(Array.from(panels ?? []).map((element) => ({
          element, duration: 280,
          keyframes: [{ opacity: 0, transform: 'scale(0.94) translateY(24px)' }, { opacity: 1, transform: 'scale(1)' }],
        })));
        await returnMotion.current?.finished;
      }
      return closed;
    } finally {
      if (!closed) {
        returnMotion.current?.cancel();
        returnMotion.current = null;
        pendingFocus.current = 'editor';
      }
      returning.current = false;
      if (mounted.current) setReturningBusy(false);
    }
  }, []);

  return { rootRef, showHome, homeMounted: showHome || retainedHome, busy, returnHome };
}
