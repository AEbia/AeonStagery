export interface MotionStep {
  element: HTMLElement;
  keyframes: Keyframe[];
  duration: number;
  delay?: number;
  easing?: string;
}

export const HOME_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';

/** One bounded sequence; cancellation, hidden windows and preference changes release all waiters. */
export function playHomeMotion(steps: MotionStep[]) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (!steps.length || reduced.matches || document.hidden
    || steps.some(({ element }) => !element.animate || element.closest('[data-perf="low"]'))) return null;

  const animations = steps.map(({ element, keyframes, duration, delay = 0, easing = HOME_EASE }) =>
    element.animate(keyframes, { duration, delay, easing, fill: 'both' }));
  const finish = () => animations.forEach((animation) => animation.finish());
  const preferenceChanged = () => {
    if (reduced.matches || document.hidden || steps[0].element.closest('[data-perf="low"]')) finish();
  };
  const preferences = new MutationObserver(preferenceChanged);
  preferences.observe(document.documentElement, { attributes: true, attributeFilter: ['data-perf'] });
  reduced.addEventListener('change', preferenceChanged);
  document.addEventListener('visibilitychange', preferenceChanged);
  const timeout = window.setTimeout(finish, Math.max(...steps.map((step) => step.duration + (step.delay ?? 0))) + 100);
  const cleanup = () => {
    window.clearTimeout(timeout);
    preferences.disconnect();
    reduced.removeEventListener('change', preferenceChanged);
    document.removeEventListener('visibilitychange', preferenceChanged);
  };
  return {
    finished: Promise.all(animations.map((animation) => animation.finished.catch(() => undefined))).then(cleanup),
    cancel: () => { cleanup(); animations.forEach((animation) => animation.cancel()); },
  };
}

export function focusHomeView(element: HTMLElement) {
  if (document.querySelector('[aria-modal="true"]')) return;
  const target = element.querySelector<HTMLElement>('.ph-board__open')
    ?? element.querySelector<HTMLElement>('h1, h2, .ph-section-title');
  if (!target) return;
  if (!target.matches('button')) target.tabIndex = -1;
  target.focus({ preventScroll: true });
}
