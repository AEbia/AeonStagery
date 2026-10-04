import { describe, expect, it, vi } from 'vitest';
import {
  animateViewportTransition,
  computeRangeNavigationTarget,
} from '../ui/timeline/timelineViewport';

describe('timeline viewport animation', () => {
  it('computes centered navigation targets for a range', () => {
    const target = computeRangeNavigationTarget({ start: 10, end: 14 }, 24, 1000, 120);

    expect(target.pixelsPerSecond).toBe(24);
    expect(target.scrollLeft).toBe(0);
  });

  it('animates viewport transitions over multiple frames', () => {
    let now = 0;
    const updates: Array<{ pixelsPerSecond: number; scrollLeft: number }> = [];
    const queued: FrameRequestCallback[] = [];

    const handle = animateViewportTransition({
      from: { pixelsPerSecond: 8, scrollLeft: 0 },
      to: { pixelsPerSecond: 24, scrollLeft: 300 },
      durationMs: 300,
      onUpdate: (next) => updates.push(next),
      requestFrame: (cb) => {
        queued.push(cb);
        return queued.length;
      },
      cancelFrame: vi.fn(),
      now: () => now,
    });

    expect(updates).toHaveLength(0);

    now = 150;
    queued.shift()?.(0 as any);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[updates.length - 1].pixelsPerSecond).toBeGreaterThan(8);

    now = 300;
    queued.shift()?.(0 as any);
    expect(updates[updates.length - 1].pixelsPerSecond).toBe(24);
    expect(updates[updates.length - 1].scrollLeft).toBe(300);

    handle.cancel();
  });
});
