import { describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';

const cameraMocks = vi.hoisted(() => ({
  executeMotion: vi.fn(),
  createPath: vi.fn(),
  reset: vi.fn(),
  shake: vi.fn(),
  hitchcockZoom: vi.fn(),
  stopFollow: vi.fn(),
}));

vi.mock('../engine/CameraController', () => ({
  cameraController: cameraMocks,
}));

import { actionSchedulers } from '../engine/actions';
import type { SchedulerContext } from '../engine/actions/types';

describe('camera action schedulers', () => {
  it('inserts a camera motion at the authored time', () => {
    const cameraTimeline = gsap.timeline().to({}, { duration: 0.75 });
    cameraMocks.executeMotion.mockReturnValue(cameraTimeline);
    const timeline = gsap.timeline({ paused: true });

    actionSchedulers.cameraMotion({
      tl: timeline,
    } as any, {
      time: 2,
      action: 'cameraMotion',
      _id: 'camera-motion-1',
      params: { move: 'pan', target: [0.3, 0.6], duration: 0.75 },
    });

    expect(cameraMocks.executeMotion).toHaveBeenCalledWith({
      move: 'pan',
      target: [0.3, 0.6],
      duration: 0.75,
    });
    expect(timeline.duration()).toBeCloseTo(2.75, 6);
  });

  it('translates the legacy camera follow action into an indefinite follow motion', () => {
    const cameraTimeline = gsap.timeline();
    cameraMocks.executeMotion.mockReturnValue(cameraTimeline);
    const timeline = gsap.timeline({ paused: true });

    actionSchedulers.cameraFollow({
      tl: timeline,
    } as any, {
      time: 1.5,
      action: 'cameraFollow',
      _id: 'camera-follow-1',
      params: {
        characterId: 'tomori',
        offset: [0.1, -0.05],
        smoothing: 0.8,
      },
    });

    expect(cameraMocks.executeMotion).toHaveBeenCalledWith({
      move: 'follow',
      easing: 'linear',
      duration: 0,
      characterId: 'tomori',
      offset: [0.1, -0.05],
      smoothing: 0.8,
    });
    expect(timeline.duration()).toBeCloseTo(1.5, 6);
  });

  it('releases follow through a dedicated unfollow action without resetting the camera', () => {
    const cameraTimeline = gsap.timeline();
    cameraMocks.stopFollow.mockReturnValue(cameraTimeline);
    const timeline = gsap.timeline({ paused: true });

    actionSchedulers.cameraUnfollow({
      tl: timeline,
    } as any, {
      time: 3,
      action: 'cameraUnfollow',
      _id: 'camera-unfollow-1',
      params: {},
    });

    expect(cameraMocks.stopFollow).toHaveBeenCalledTimes(1);
    expect(cameraMocks.reset).not.toHaveBeenCalled();
    expect(timeline.duration()).toBeCloseTo(3, 6);
  });

  it('ignores legacy follow duration without scheduling an automatic stop', () => {
    const cameraTimeline = gsap.timeline();
    cameraMocks.executeMotion.mockReturnValue(cameraTimeline);
    const timeline = gsap.timeline({ paused: true });

    actionSchedulers.cameraFollow({
      tl: timeline,
    } as any, {
      time: 1,
      action: 'cameraFollow',
      _id: 'camera-follow-2',
      params: { characterId: 'tomori', duration: 4 },
    });

    expect(cameraMocks.executeMotion).toHaveBeenCalledWith(expect.objectContaining({
      move: 'follow',
      characterId: 'tomori',
      duration: 0,
    }));
    expect(timeline.duration()).toBeCloseTo(1, 6);
  });

  it.each(['cameraFollow', 'cameraUnfollow'] as const)('keeps formal %s instantaneous despite legacy duration fields', action => {
    const timeline = gsap.timeline({ paused: true });
    actionSchedulers[action]({ tl: timeline, cameraStateDriven: true } as SchedulerContext, {
      _id: 'follow-boundary', action, time: 2,
      params: { characterId: 'hero', duration: 5, durationSeconds: 5 },
    });
    expect(timeline.duration()).toBe(2);
    timeline.kill();
  });

  it('passes camera path playback options to the path controller', () => {
    const cameraTimeline = gsap.timeline().to({}, { duration: 1.25 });
    cameraMocks.createPath.mockReturnValue(cameraTimeline);
    const timeline = gsap.timeline({ paused: true });
    const keyframes = [
      { time: 0, position: [0.5, 0.5], zoom: 1 },
      { time: 1.25, position: [0.2, 0.4], zoom: 1.4 },
    ];

    actionSchedulers.cameraPath({
      tl: timeline,
    } as any, {
      time: 3,
      action: 'cameraPath',
      _id: 'camera-path-1',
      params: {
        keyframes,
        ease: 'sine.inOut',
        loop: true,
        repeat: 2,
        yoyo: true,
      },
    });

    expect(cameraMocks.createPath).toHaveBeenCalledWith(keyframes, {
      defaultEase: 'sine.inOut',
      loop: true,
      repeat: 2,
      yoyo: true,
    });
    expect(timeline.duration()).toBeCloseTo(4.25, 6);
  });

  it('uses the camera reset defaults while preserving explicit easing', () => {
    const cameraTimeline = gsap.timeline().to({}, { duration: 1 });
    cameraMocks.reset.mockReturnValue(cameraTimeline);
    const timeline = gsap.timeline({ paused: true });

    actionSchedulers.cameraReset({
      tl: timeline,
    } as any, {
      time: 2,
      action: 'cameraReset',
      _id: 'camera-reset-1',
      params: { ease: 'power4.out' },
    });

    expect(cameraMocks.reset).toHaveBeenCalledWith(1, 'power4.out');
    expect(timeline.duration()).toBeCloseTo(3, 6);
  });

  it('schedules a camera shake with its authored configuration', () => {
    const cameraTimeline = gsap.timeline().to({}, { duration: 0.4 });
    cameraMocks.shake.mockReturnValue(cameraTimeline);
    const timeline = gsap.timeline({ paused: true });
    const config = { intensity: 0.12, frequency: 18, duration: 0.4, decay: true };

    actionSchedulers.cameraShake({
      tl: timeline,
    } as any, {
      time: 1,
      action: 'cameraShake',
      _id: 'camera-shake-1',
      params: config,
    });

    expect(cameraMocks.shake).not.toHaveBeenCalled();
    expect(timeline.duration()).toBeCloseTo(1.4, 6);
  });

  it('schedules a Hitchcock zoom with its authored configuration', () => {
    const cameraTimeline = gsap.timeline().to({}, { duration: 2 });
    cameraMocks.hitchcockZoom.mockReturnValue(cameraTimeline);
    const timeline = gsap.timeline({ paused: true });
    const config = { zoom: 1.6, duration: 2, focalPoint: [0.4, 0.5] };

    actionSchedulers.cameraHitchcock({
      tl: timeline,
    } as any, {
      time: 0.5,
      action: 'cameraHitchcock',
      _id: 'camera-hitchcock-1',
      params: config,
    });

    expect(cameraMocks.hitchcockZoom).toHaveBeenCalledWith(config);
    expect(timeline.duration()).toBeCloseTo(2.5, 6);
  });
});
