import { useEffect, useRef } from 'react';

/** Keep decorative motion outside React renders and stop work when it cannot be seen. */
export function useStoryboardMotion(paused: boolean) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let visible = true;
    let enabled = false;
    let frame = 0;
    let x = 0;
    let y = 0;
    let targetX = 0;
    let targetY = 0;

    const reset = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      x = y = targetX = targetY = 0;
      element.style.removeProperty('--board-look-x');
      element.style.removeProperty('--board-look-y');
    };
    const update = () => {
      enabled = !paused && !reduced.matches && !document.hidden && visible
        && !element.closest('[data-perf="low"]');
      element.dataset.motion = enabled ? 'running' : 'paused';
      if (!enabled) reset();
    };
    let previousTime = 0;
    const tick = (time: number) => {
      const elapsed = Math.min(64, time - previousTime);
      previousTime = time;
      const blend = 1 - Math.exp(-elapsed / 110);
      x += (targetX - x) * blend;
      y += (targetY - y) * blend;
      element.style.setProperty('--board-look-x', `${x.toFixed(3)}deg`);
      element.style.setProperty('--board-look-y', `${y.toFixed(3)}deg`);
      if (Math.abs(targetX - x) + Math.abs(targetY - y) > 0.015) frame = requestAnimationFrame(tick);
      else frame = 0;
    };
    const requestTick = () => {
      if (frame || !enabled) return;
      previousTime = performance.now();
      frame = requestAnimationFrame(tick);
    };
    const move = (event: PointerEvent) => {
      if (!enabled || event.pointerType !== 'mouse') return;
      const bounds = element.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      targetX = Math.max(-1, Math.min(1, (event.clientX - bounds.left) / bounds.width * 2 - 1)) * 9;
      targetY = Math.max(-1, Math.min(1, (event.clientY - bounds.top) / bounds.height * 2 - 1)) * -5;
      requestTick();
    };
    const leave = () => { targetX = targetY = 0; requestTick(); };
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      update();
    }, { threshold: 0.05 });
    observer?.observe(element);
    const preferences = new MutationObserver(update);
    preferences.observe(document.documentElement, { attributes: true, attributeFilter: ['data-perf'] });
    reduced.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerleave', leave);
    update();
    return () => {
      reset();
      observer?.disconnect();
      preferences.disconnect();
      reduced.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', update);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerleave', leave);
    };
  }, [paused]);
  return ref;
}
