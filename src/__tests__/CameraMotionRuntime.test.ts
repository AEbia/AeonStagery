import { afterEach, describe, expect, it, vi } from 'vitest';
import type CameraController from '../engine/CameraController';
import type { CameraMotionConfig } from '../api/types/camera';
import { MOVE_HANDLERS } from '../engine/MoveHandlers';

describe('camera motion runtime', () => {
  const activeTimelines: Array<{ kill: () => void }> = [];

  afterEach(() => {
    activeTimelines.splice(0).forEach((timeline) => timeline.kill());
  });

  it('moves pan from the current camera state to the endpoint', () => {
    const camera = {
      state: {
        position: { x: 0.2, y: 0.3 },
        zoom: 1,
        rotation: 0,
      },
      applyTransform: vi.fn(),
    } as unknown as CameraController;

    const timeline = MOVE_HANDLERS.pan.call(camera, {
      move: 'pan',
      easing: 'linear',
      to: [0.8, 0.7],
      duration: 1,
    } satisfies CameraMotionConfig, 'linear');
    activeTimelines.push(timeline);
    const position = camera.state.position as unknown as { x: number; y: number };

    expect(position.x).toBe(0.2);
    expect(position.y).toBe(0.3);

    timeline.progress(0.5);
    expect(position.x).toBeCloseTo(0.5);
    expect(position.y).toBeCloseTo(0.5);

    timeline.progress(1);
    expect(position.x).toBe(0.8);
    expect(position.y).toBe(0.7);
  });

  it('honors an explicit rotate zoomEnd of 1', () => {
    const camera = {
      state: {
        position: { x: 0.5, y: 0.5 },
        zoom: 1.6,
        rotation: 0,
      },
      applyTransform: vi.fn(),
    } as unknown as CameraController;

    const timeline = MOVE_HANDLERS.rotate.call(camera, {
      move: 'rotate',
      easing: 'linear',
      angle: 15,
      zoomEnd: 1,
      duration: 1,
    } satisfies CameraMotionConfig, 'linear');
    activeTimelines.push(timeline);

    timeline.progress(1);

    expect(camera.state.rotation).toBe(15);
    expect(camera.state.zoom).toBe(1);
  });

  it('delegates character push focus and offsets to camera moveTo', () => {
    const returnedTimeline = { kill: vi.fn() };
    const camera = {
      moveTo: vi.fn(() => returnedTimeline),
    } as unknown as CameraController;

    const timeline = MOVE_HANDLERS.push.call(camera, {
      move: 'push',
      easing: 'smooth',
      characterId: 'hero',
      focus: { offsetX: 0.1, offsetY: -0.2 },
      duration: 1.5,
      delay: 0.25,
    } satisfies CameraMotionConfig, 'power2.out');

    expect(timeline).toBe(returnedTimeline);
    expect(camera.moveTo).toHaveBeenCalledWith({
      targetCharacter: 'hero',
      targetPart: 'head',
      offsetX: 0.1,
      offsetY: -0.2,
      zoom: '+=0.3',
      duration: 1.5,
      ease: 'power2.out',
      delay: 0.25,
    });
  });

  it('computes the missing dolly scale end from the zoom ratio', () => {
    const returnedTimeline = { kill: vi.fn() };
    const camera = {
      hitchcockZoom: vi.fn(() => returnedTimeline),
    } as unknown as CameraController;

    const timeline = MOVE_HANDLERS.dolly.call(camera, {
      move: 'dolly',
      easing: 'smooth',
      characterId: 'hero',
      zoomStart: 1,
      zoomEnd: 2,
      scaleStart: 1.4,
      duration: 2,
      delay: 0.1,
    } satisfies CameraMotionConfig, 'sine.inOut');

    expect(timeline).toBe(returnedTimeline);
    expect(camera.hitchcockZoom).toHaveBeenCalledWith({
      characterId: 'hero',
      targetPart: 'head',
      screenTarget: [0.5, 0.3],
      zoomStart: 1,
      zoomEnd: 2,
      scaleStart: 1.4,
      scaleEnd: 0.7,
      duration: 2,
      ease: 'sine.inOut',
      delay: 0.1,
    });
  });

  it('starts and automatically stops character follow by default', () => {
    const camera = {
      follow: vi.fn(),
      unfollow: vi.fn(),
    } as unknown as CameraController;

    const timeline = MOVE_HANDLERS.follow.call(camera, {
      move: 'follow',
      easing: 'linear',
      characterId: 'hero',
      offset: [0.1, -0.2],
      smoothing: 0.5,
      duration: 0.5,
    } satisfies CameraMotionConfig, 'linear');
    activeTimelines.push(timeline);

    timeline.seek(0.001, false);
    expect(camera.follow).toHaveBeenCalledWith('hero', {
      offset: [0.1, -0.2],
      smoothing: 0.5,
    });

    timeline.progress(1);
    expect(camera.unfollow).toHaveBeenCalledTimes(1);
  });
});
