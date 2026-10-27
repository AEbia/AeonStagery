import { afterEach, describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';

vi.mock('../engine/StageManager', () => ({ stageManager: { getApp: () => ({ ticker: { add: vi.fn(), remove: vi.fn() } }) } }));
vi.mock('../engine/Live2DManager', () => ({ live2DManager: { getPoint: vi.fn(), getPosition: vi.fn() } }));

import { cameraController } from '../engine/CameraController';
import { CameraCoordinator } from '../engine/coordinators/CameraCoordinator';
import { actionSchedulers } from '../engine/actions';
import type { SchedulerContext } from '../engine/actions/types';
import type { RuntimeTimelineAction } from '../engine/RuntimeTimelineScene';
import { hookSystem } from '../api/hooks';

const action = (_id: string, action: RuntimeTimelineAction['action'], time: number, params: Record<string, unknown>): RuntimeTimelineAction => ({ _id, action, time, params });
const motion = (id: string, time: number, params: Record<string, unknown>) => action(id, 'cameraMotion', time, { easing: 'linear', ...params });

function scene(actions: readonly RuntimeTimelineAction[], duration = 10) {
  cameraController.init();
  const coordinator = new CameraCoordinator(cameraController);
  const master = gsap.timeline({ paused: true, onUpdate: () => coordinator.sync(master.time(), actions) });
  const context = { tl: master, cameraStateDriven: true } as SchedulerContext;
  for (const entry of actions) actionSchedulers[entry.action](context, entry);
  master.to({}, { duration }, 0);
  return {
    master,
    playback(time: number) { master.time(time, false); return cameraController.getState(); },
    seek(time: number) { master.time(time, true); coordinator.sync(time, actions); return cameraController.getState(); },
    query(time: number) { coordinator.sync(time, actions); return cameraController.getState(); },
  };
}

afterEach(() => { gsap.globalTimeline.clear(); cameraController.init(); });

describe('evaluated playback channels at the real scheduler/controller/coordinator seam', () => {
  it('takes x and y independently from their actual start values, then takes both for a complete position', () => {
    const runtime = scene([
      motion('x', 1, { move: 'pan', strength: 0.4, duration: 4 }),
      motion('y', 2, { move: 'tilt', toY: 0.1, duration: 2 }),
      motion('take-x', 3, { move: 'pan', strength: -0.2, duration: 1 }),
      motion('both', 6, { move: 'pan', target: [0.2, 0.8], duration: 1 }),
    ]);
    for (const [time, x, y] of [[0.999, 0.5, 0.5], [1, 0.5, 0.5], [3, 0.7, 0.3], [3.5, 0.6, 0.2], [4, 0.5, 0.1], [5.125, 0.5, 0.1], [6.5, 0.35, 0.45], [7, 0.2, 0.8], [8.25, 0.2, 0.8]]) {
      const playback = runtime.playback(time);
      expect(playback.position).toEqual({ x: expect.closeTo(x, 8), y: expect.closeTo(y, 8) });
      runtime.seek(9);
      expect(runtime.seek(time)).toEqual(playback);
    }
  });

  it.each([
    { duration: 7, sample: 3, zoom: 4 },
    { duration: 0.5, sample: 1.125, zoom: 3.125 },
    { repeat: 1, sample: 3.125, zoom: 3.125 },
    { repeat: 1, yoyo: true, sample: 3.125, zoom: 2.875 },
    { repeat: 1, yoyo: true, sample: 4, zoom: 2 },
    { repeat: -1, sample: 4.125, zoom: 2.125 },
    { loop: true, repeat: 1, sample: 4.125, zoom: 2.125 },
    { loop: true, repeat: -1, yoyo: true, sample: 3.125, zoom: 2.875 },
  ])('keeps path rhythm and finite scene time for $sample / $zoom ($repeat, $loop, $yoyo)', (config) => {
    const runtime = scene([action('path', 'cameraPath', 0, {
      ease: 'linear', keyframes: [{ time: 0, zoom: 2 }, { time: 2, zoom: 4 }], ...config,
    })]);
    expect(runtime.playback(config.sample).zoom).toBeCloseTo(config.zoom, 8);
    expect(runtime.seek(config.sample).zoom).toBeCloseTo(config.zoom, 8);
    expect(runtime.master.duration()).toBe(10);
    expect(runtime.seek(0).zoom).toBe(2);
  });

  it('resets from the unshaken pose and keeps only later same-time shake envelopes', () => {
    const runtime = scene([
      motion('initial', 0, { move: 'pan', target: [0.8, 0.2], zoom: 2, angle: 30, duration: 0 }),
      action('old-shake', 'cameraShake', 1, { direction: 'horizontal', intensity: 1, duration: 4 }),
      action('before-reset', 'cameraShake', 2, { direction: 'horizontal', intensity: 1, duration: 3 }),
      action('reset', 'cameraReset', 2, { duration: 2, ease: 'linear' }),
      action('after-reset', 'cameraShake', 2, { direction: 'vertical', intensity: 1, duration: 3 }),
    ]);
    expect(runtime.playback(1.25).shakeOffset?.x).not.toBe(0);
    for (const [time, x, y, zoom, rotation] of [[2, 0.8, 0.2, 2, 30], [3, 0.65, 0.35, 1.5, 15], [4, 0.5, 0.5, 1, 0], [5, 0.5, 0.5, 1, 0]]) {
      const playback = runtime.playback(time);
      expect(playback.position).toEqual({ x: expect.closeTo(x, 8), y: expect.closeTo(y, 8) });
      expect(playback.zoom).toBeCloseTo(zoom, 8);
      expect(playback.rotation).toBeCloseTo(rotation, 8);
      if (time === 3 || time === 4) {
        expect(playback.shakeOffset?.x).toBe(0);
        expect(playback.shakeOffset?.y).not.toBe(0);
      } else expect(playback.shakeOffset).toBeUndefined();
      runtime.seek(8);
      expect(runtime.seek(time)).toEqual(playback);
    }
  });

  it('is independent of query order, fresh runtimes and earlier 24/30/60/120 fps playback sampling', () => {
    const actions = [
      motion('move', 1, { move: 'pan', duration: 4, target: [0.8, 0.2] }),
      action('path', 'cameraPath', 2, { ease: 'linear', keyframes: [{ time: 0.5, zoom: 2 }, { time: 2, zoom: 3 }] }),
      action('shake-a', 'cameraShake', 2, { duration: 2, intensity: 0.7, frequency: 9 }),
      action('shake-b', 'cameraShake', 2.5, { duration: 2, intensity: 0.3, frequency: 7 }),
    ];
    const target = 3.137;
    const expected = scene(actions).seek(target);
    for (const fps of [24, 30, 60, 120]) {
      const runtime = scene(actions);
      for (let frame = 0; frame <= fps * 5; frame++) runtime.playback(frame / fps);
      for (const time of [8.75, 1.125, target, 0, 4.75, target, target]) runtime.seek(time);
      expect(runtime.query(target)).toEqual(expected);
      expect(runtime.seek(5).shakeOffset).toBeUndefined();
    }
  });

  it('uses each sparse property keyframe interval and easing independently', () => {
    const runtime = scene([
      motion('initial', 0, { move: 'pan', target: [0.8, 0.2], duration: 0 }),
      action('sparse', 'cameraPath', 1, { ease: 'linear', keyframes: [
        { time: 0, zoom: 2 },
        { time: 1, rotation: 30, ease: 'power1.in' },
        { time: 2, zoom: 4, ease: 'linear' },
        { time: 3, position: [0.2, 0.8], ease: 'linear' },
      ] }),
    ]);
    const playback = runtime.playback(1.5);
    expect(playback.position).toEqual({ x: expect.closeTo(0.7, 8), y: expect.closeTo(0.3, 8) });
    expect(playback.zoom).toBe(2.5);
    expect(playback.rotation).toBe(7.5);
    expect(runtime.seek(1.5)).toEqual(playback);
    expect(runtime.seek(1).zoom).toBe(2);
    expect(runtime.seek(0.999).zoom).toBe(1);
  });

  it('returns diagnostics as data without camera playback events or logs during repeated pure queries', () => {
    const actions = [motion('rotate', 1, { move: 'rotate', angle: 45, duration: 0, _cameraProperties: ['rotation'] })];
    scene(actions);
    const coordinator = new CameraCoordinator(cameraController);
    const events: string[] = [];
    const offMove = hookSystem.on('camera:move', () => { events.push('move'); });
    const offShake = hookSystem.on('camera:shake', () => { events.push('shake'); });
    const warn = vi.spyOn(console, 'warn');
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    try {
      for (const time of [2, 0, 2, 1.125]) {
        const output = coordinator.sync(time, actions, { logicalReferenceSize: { width: 1080, height: 1920 } });
        expect(output?.diagnostics.map(({ code }) => code)).toEqual(time < 1 ? [] : ['rotation-edge-exposure']);
        expect(cameraController.getState().rotation).toBe(time < 1 ? 0 : 45);
      }
      expect(events).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally { offMove(); offShake(); warn.mockRestore(); log.mockRestore(); error.mockRestore(); }
  });

  it('applies a zero-duration reset immediately and releases later shake when reset is last at the same instant', () => {
    const runtime = scene([
      motion('initial', 0, { move: 'pan', target: [0.8, 0.2], zoom: 2, angle: 30, duration: 0 }),
      action('new-shake', 'cameraShake', 2, { intensity: 1, duration: 3 }),
      action('reset-last', 'cameraReset', 2, { duration: 0 }),
    ]);
    expect(runtime.playback(1.999).zoom).toBe(2);
    const baseline = { position: { x: 0.5, y: 0.5 }, zoom: 1, rotation: 0 };
    expect(runtime.playback(2)).toEqual(baseline);
    expect(runtime.playback(2.125)).toEqual(baseline);
    expect(runtime.seek(2)).toEqual(baseline);
  });

  it('adds overlapping finite shake envelopes and returns exactly zero after their ends', () => {
    const horizontal = action('horizontal', 'cameraShake', 1, { duration: 2, intensity: 0.7, direction: 'horizontal' });
    const vertical = action('vertical', 'cameraShake', 1, { duration: 2, intensity: 0.4, direction: 'vertical' });
    const first = scene([horizontal]).seek(1.375).shakeOffset!;
    const second = scene([vertical]).seek(1.375).shakeOffset!;
    const combined = scene([horizontal, vertical]);
    expect(combined.playback(1.375).shakeOffset).toEqual({ x: first.x, y: second.y });
    expect(first.x).not.toBe(0);
    expect(second.y).not.toBe(0);
    expect(combined.seek(3).shakeOffset).toBeUndefined();
    expect(combined.seek(4.125).shakeOffset).toBeUndefined();
    expect(combined.seek(1.375).shakeOffset).toEqual({ x: first.x, y: second.y });
  });

  it('updates dimension-dependent diagnostics when the reference changes and returns to the original result', () => {
    const actions = [motion('rotate', 0, { move: 'rotate', zoom: 1.6, angle: 45, duration: 0, _cameraProperties: ['zoom', 'rotation'] })];
    const coordinator = new CameraCoordinator(cameraController);
    const square = coordinator.sync(1.125, actions, { logicalReferenceSize: { width: 1080, height: 1080 } });
    expect(square?.diagnostics).toEqual([]);
    expect(coordinator.sync(1.125, actions, { logicalReferenceSize: { width: 3240, height: 1080 } })?.diagnostics)
      .toMatchObject([{ code: 'rotation-edge-exposure' }]);
    expect(coordinator.sync(1.125, actions, { logicalReferenceSize: { width: 1080, height: 1080 } })).toEqual(square);
  });
});
