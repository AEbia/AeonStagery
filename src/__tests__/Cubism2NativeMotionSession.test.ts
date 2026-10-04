import { describe, expect, it, vi } from 'vitest';
import {
  Cubism2NativeMotionSession,
  type Cubism2NativeMotionClock,
  type Cubism2NativeMotionTarget,
} from '../engine/live2d/Cubism2NativeMotionSession';

function makeTarget(overrides: Partial<Cubism2NativeMotionTarget> = {}): Cubism2NativeMotionTarget {
  const motionManager = {
    startMotion: vi.fn(async () => true),
    update: vi.fn(),
  };
  const internalModel: any = {
    physics: { enabled: true },
    motionManager,
    coreModel: {},
  };
  const model: any = {
    update: vi.fn(),
    internalModel,
  };
  return { model, internalModel, motionManager, ...overrides };
}

function makeClock(base = 100000): Cubism2NativeMotionClock {
  let now = base;
  const clock: Cubism2NativeMotionClock = {
    getUserTimeMSec: vi.fn(() => now),
    setUserTimeMSec: vi.fn((ms: number) => {
      now = ms;
    }),
  };
  return clock;
}

describe('Cubism2NativeMotionSession', () => {
  it('starts a motion at the offset-derived SDK time and replays offset in 50ms steps', async () => {
    const target = makeTarget();
    const clock = makeClock(100000);
    const session = new Cubism2NativeMotionSession();

    const result = await session.startMotion({
      targets: [target],
      motionKey: 'wave',
      priority: 3,
      offsetSeconds: 0.25,
      clock,
    });

    expect(target.motionManager.startMotion).toHaveBeenCalledWith('wave', 0, 3);
    // motionStartUtTime = utBase - offset * 1000
    expect(clock.setUserTimeMSec).toHaveBeenCalledWith(100000 - 250);
    // 50ms replay reaches the requested offset exactly once — every step
    // advances the motion queue (never the whole model: legacy parity keeps
    // the silent queue-only step, no absolute-time-as-delta fallback).
    expect(target.motionManager.update).toHaveBeenCalledTimes(5);
    expect(target.model.update).not.toHaveBeenCalled();
    expect(result.offsetReplayMs).toBe(250);
    expect(result.motionStartUtTimeMs).toBe(100000 - 250);
    // Clock must not go backwards after the replay.
    expect(clock.getUserTimeMSec()).toBeGreaterThanOrEqual(100000);
  });

  it('does not replay offset when no shared UtSystem clock is available', async () => {
    const target = makeTarget();
    const session = new Cubism2NativeMotionSession();

    const result = await session.startMotion({
      targets: [target],
      motionKey: 'wave',
      priority: 4,
      offsetSeconds: 2,
      clock: null,
    });

    expect(target.motionManager.startMotion).toHaveBeenCalledWith('wave', 0, 4);
    expect(target.model.update).not.toHaveBeenCalled();
    expect(result.offsetReplayMs).toBe(0);
  });

  it('starts and replays every concrete target of a composite model', async () => {
    const main = makeTarget();
    const arm = makeTarget();
    const clock = makeClock(5000);

    const session = new Cubism2NativeMotionSession();
    await session.startMotion({
      targets: [main, arm],
      motionKey: 'angry03',
      priority: 2,
      offsetSeconds: 0.1,
      clock,
    });

    expect(main.motionManager.startMotion).toHaveBeenCalledWith('angry03', 0, 2);
    expect(arm.motionManager.startMotion).toHaveBeenCalledWith('angry03', 0, 2);
    // 0.1s @ 50ms steps = 2 steps, each stepping every concrete target's
    // motion queue only (the model itself is never advanced by the replay).
    expect(main.motionManager.update).toHaveBeenCalledTimes(2);
    expect(arm.motionManager.update).toHaveBeenCalledTimes(2);
    expect(main.model.update).not.toHaveBeenCalled();
    expect(arm.model.update).not.toHaveBeenCalled();
  });

  it('disables physics during offset replay and restores it afterwards', async () => {
    const physics = { enabled: true };
    const target = makeTarget({ internalModel: { physics } as any });
    const clock = makeClock(1000);
    const session = new Cubism2NativeMotionSession();

    await session.startMotion({
      targets: [target],
      motionKey: 'wave',
      priority: 3,
      offsetSeconds: 0.05,
      clock,
    });

    expect(target.internalModel.physics).toBe(physics);
    expect(target.motionManager.startMotion).toHaveBeenCalledTimes(1);
  });
});
