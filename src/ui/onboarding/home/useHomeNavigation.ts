import { useLayoutEffect, useRef, useState } from 'react';
import type { NavigationTarget } from '../ProjectHome';
import { focusHomeView, playHomeMotion } from './homeMotion';

const DEPTH: Record<NavigationTarget, number> = {
  start: 0, 'create-form': 1, 'create-capabilities': 2, 'collab-menu': 1,
  'collab-host-new': 2, 'collab-host-existing': 2, 'collab-join': 2,
};

/** Keep the live outgoing view mounted until it has left the visual focus. */
export function useHomeNavigation() {
  const [navigation, setNavigation] = useState<{ view: NavigationTarget; revision: number }>({ view: 'start', revision: 0 });
  const { view } = navigation;
  const stageRef = useRef<HTMLDivElement>(null);
  const current = useRef(view);
  const pending = useRef(view);
  const direction = useRef(1);
  const exiting = useRef(false);
  const motion = useRef<ReturnType<typeof playHomeMotion>>(null);
  const generation = useRef(0);

  const navigateTo = (target: NavigationTarget) => {
    pending.current = target;
    if (exiting.current || current.current === target) return;
    const stage = stageRef.current;
    const initial = stage ? { transform: getComputedStyle(stage).transform, opacity: getComputedStyle(stage).opacity } : {};
    motion.current?.cancel();
    const run = ++generation.current;
    direction.current = DEPTH[target] < DEPTH[current.current] ? -1 : 1;
    const commit = () => {
      if (run !== generation.current) return;
      const next = pending.current;
      direction.current = DEPTH[next] < DEPTH[current.current] ? -1 : 1;
      current.current = next;
      setNavigation((value) => ({ view: next, revision: value.revision + 1 }));
    };
    motion.current = stage ? playHomeMotion([{
      element: stage, duration: 220, easing: 'cubic-bezier(0.4, 0, 1, 1)',
      keyframes: [initial, {
        opacity: 0,
        transform: `perspective(1200px) translate3d(${-direction.current * 72}px, 12px, ${direction.current > 0 ? -100 : 100}px) rotateY(${direction.current * -5}deg)`,
      }],
    }]) : null;
    if (!motion.current) { commit(); return; }
    exiting.current = true;
    stage?.setAttribute('inert', '');
    stage?.setAttribute('aria-busy', 'true');
    void motion.current.finished.then(commit);
  };

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || view === 'start' && generation.current === 0) return;
    // The replacement DOM is committed now. Cancelling the filled exit earlier flashes the old view.
    motion.current?.cancel();
    exiting.current = false;
    stage.removeAttribute('inert');
    stage.removeAttribute('aria-busy');
    stage.closest('.ph-overlay')?.scrollTo?.({ top: 0 });
    focusHomeView(stage);
    const entrance = playHomeMotion([{
      element: stage, duration: 380,
      keyframes: [{
        opacity: 0,
        transform: `perspective(1200px) translate3d(${direction.current * 88}px, 8px, ${direction.current > 0 ? 100 : -100}px) rotateY(${direction.current * 5}deg)`,
      }, { opacity: 1, transform: 'perspective(1200px) translate3d(0, 0, 0) rotateY(0deg)' }],
    }]);
    motion.current = entrance;
    void entrance?.finished.then(() => entrance.cancel());
  }, [navigation, view]);

  useLayoutEffect(() => () => {
    generation.current++;
    motion.current?.cancel();
  }, []);

  return { view, stageRef, navigateTo };
}
