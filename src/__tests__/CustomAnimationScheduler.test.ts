import gsap from 'gsap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const customAnimationMocks = vi.hoisted(() => ({
  playAnimation: vi.fn(),
}));

vi.mock('../engine/CustomAnimHost', () => ({
  customAnimHost: customAnimationMocks,
}));

import { eventBus } from '../api/events';
import { schedulePlayCustomAnimation } from '../engine/actions/customAnimation';

describe('custom animation action scheduling', () => {
  beforeEach(() => {
    customAnimationMocks.playAnimation.mockReset();
  });

  afterEach(() => {
    eventBus.clear('toast:show');
    vi.restoreAllMocks();
  });

  it('reports a ready/error rejection from the async scheduler callback', async () => {
    const error = new Error('animation was cleared before ready');
    customAnimationMocks.playAnimation.mockRejectedValue(error);
    const emit = vi.spyOn(eventBus, 'emit').mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const tl = gsap.timeline({ paused: true });

    schedulePlayCustomAnimation({
      tl,
      resolvePath: vi.fn(() => 'animation.html'),
      isReconstructing: vi.fn(() => false),
    } as any, {
      time: 0,
      params: { file: 'animation.html', duration: 5, layer: 'overlay' },
    } as any);

    tl.progress(1);

    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(
      'toast:show',
      expect.objectContaining({
        message: expect.stringContaining('animation was cleared before ready'),
        type: 'error',
      }),
    ));
    expect(customAnimationMocks.playAnimation).toHaveBeenCalledWith('animation.html', 5, 'overlay');
  });
});
