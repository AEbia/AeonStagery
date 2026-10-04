export interface TimelineViewportRange {
  start: number;
  end: number;
}

export interface TimelineViewportTarget {
  pixelsPerSecond: number;
  scrollLeft: number;
}

export interface AnimateViewportOptions {
  from: TimelineViewportTarget;
  to: TimelineViewportTarget;
  durationMs?: number;
  reduceMotion?: boolean;
  onUpdate: (next: TimelineViewportTarget) => void;
  requestFrame?: (cb: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  now?: () => number;
}

export interface ViewportAnimationHandle {
  cancel: () => void;
}

function easeInOutCubic(t: number): number {
  if (t < 0.5) return 4 * t * t * t;
  return 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function computeRangeNavigationTarget(
  range: TimelineViewportRange,
  targetPixelsPerSecond: number,
  containerWidth: number,
  maxTime: number,
): TimelineViewportTarget {
  const rangeCenter = (range.start + range.end) / 2;
  const maxScroll = Math.max(0, maxTime * targetPixelsPerSecond - containerWidth);
  const scrollLeft = Math.max(
    0,
    Math.min(maxScroll, rangeCenter * targetPixelsPerSecond - containerWidth / 2),
  );

  return {
    pixelsPerSecond: targetPixelsPerSecond,
    scrollLeft,
  };
}

export function animateViewportTransition(options: AnimateViewportOptions): ViewportAnimationHandle {
  const {
    from,
    to,
    durationMs = 300,
    reduceMotion = false,
    onUpdate,
    requestFrame = (cb) => requestAnimationFrame(cb),
    now = () => performance.now(),
  } = options;

  let frameHandle: number | null = null;
  let cancelled = false;
  const cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));

  if (reduceMotion || durationMs <= 0) {
    onUpdate(to);
    return {
      cancel: () => {
        cancelled = true;
      },
    };
  }

  const startedAt = now();

  const step = () => {
    if (cancelled) return;

    const elapsed = Math.max(0, now() - startedAt);
    const progress = Math.min(1, elapsed / durationMs);
    const eased = easeInOutCubic(progress);
    const next = {
      pixelsPerSecond: from.pixelsPerSecond + (to.pixelsPerSecond - from.pixelsPerSecond) * eased,
      scrollLeft: from.scrollLeft + (to.scrollLeft - from.scrollLeft) * eased,
    };
    onUpdate(next);

    if (progress >= 1) {
      frameHandle = null;
      return;
    }

    frameHandle = requestFrame(() => step());
  };

  frameHandle = requestFrame(() => step());

  return {
    cancel: () => {
      cancelled = true;
      if (frameHandle !== null) {
        cancelFrame(frameHandle);
        frameHandle = null;
      }
    },
  };
}
