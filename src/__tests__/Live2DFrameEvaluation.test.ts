import { describe, expect, it } from 'vitest';
import {
  decideLive2DMotionRestart,
  evaluateLive2DMotionIntent,
  getLive2DSnapshotRestorePolicy,
  isLive2DEpochStale,
  normalizeLive2DMotionOffset,
} from '../engine/Live2DFrameEvaluation';

describe('Live2DFrameEvaluation', () => {
  it('restarts when the motion group changes', () => {
    const decision = decideLive2DMotionRestart({
      currentMotionGroup: 'idle',
      targetMotionGroup: 'wave',
      isMotionActuallyPlaying: true,
      previousOffset: 1.0,
      requestedOffset: 1.05,
      motionStartTime: 4,
      sceneTime: 5.05,
    });

    expect(decision.needsRestart).toBe(true);
    expect(decision.groupChanged).toBe(true);
    expect(decision.isTimeJumping).toBe(false);
    expect(decision.isMovingBackward).toBe(false);
  });

  it('restarts when the requested offset jumps by more than 0.15s', () => {
    const decision = decideLive2DMotionRestart({
      currentMotionGroup: 'idle',
      targetMotionGroup: 'idle',
      isMotionActuallyPlaying: true,
      previousOffset: 1.0,
      requestedOffset: 1.2,
      motionStartTime: 4,
      sceneTime: 5,
    });

    expect(decision.needsRestart).toBe(true);
    expect(decision.groupChanged).toBe(false);
    expect(decision.isTimeJumping).toBe(true);
    expect(decision.isMovingBackward).toBe(false);
    expect(decision.currentOffset).toBe(1);
  });

  it('does not restart for a normal 0.1s bake/live progression', () => {
    const decision = decideLive2DMotionRestart({
      currentMotionGroup: 'idle',
      targetMotionGroup: 'idle',
      isMotionActuallyPlaying: true,
      previousOffset: 1.0,
      requestedOffset: 1.1,
      motionStartTime: 4,
      sceneTime: 5,
    });

    expect(decision.needsRestart).toBe(false);
    expect(decision.isTimeJumping).toBe(false);
  });

  it('restarts when seek moves backward beyond epsilon', () => {
    const decision = decideLive2DMotionRestart({
      currentMotionGroup: 'idle',
      targetMotionGroup: 'idle',
      isMotionActuallyPlaying: true,
      previousOffset: 3.0,
      requestedOffset: 0.75,
      motionStartTime: 4.25,
      sceneTime: 5,
    });

    expect(decision.needsRestart).toBe(true);
    expect(decision.isMovingBackward).toBe(true);
  });

  it('preserves current snapshot state when skipHardReset is set', () => {
    expect(getLive2DSnapshotRestorePolicy({ skipHardReset: true })).toBe('preserve-current');
    expect(getLive2DSnapshotRestorePolicy({ skipHardReset: false })).toBe('restore-idle');
    expect(getLive2DSnapshotRestorePolicy({ skipHardReset: false, isReconstructing: true })).toBe('preserve-current');
  });

  it('marks epoch mismatches as stale while allowing zero legacy epochs', () => {
    expect(isLive2DEpochStale({ currentEpoch: 7, requestEpoch: 6 })).toBe(true);
    expect(isLive2DEpochStale({ currentEpoch: 7, requestEpoch: 7 })).toBe(false);
    expect(isLive2DEpochStale({ currentEpoch: 7, requestEpoch: 0 })).toBe(false);
    expect(isLive2DEpochStale({ currentEpoch: 7 })).toBe(false);
  });

  it('normalizes tiny motion offsets through the shared helper', () => {
    expect(normalizeLive2DMotionOffset(0.019)).toBe(0);
    expect(normalizeLive2DMotionOffset(0.02)).toBe(0.02);
  });

  it('preserves tiny motion offsets for seek reconstruction', () => {
    expect(normalizeLive2DMotionOffset(0.005, { preserveTinyOffset: true })).toBe(0.005);
    expect(normalizeLive2DMotionOffset(-0.005, { preserveTinyOffset: true })).toBe(0);
  });

  it('combines fake evaluator state, intent, restart, snapshot, and stale decisions', () => {
    const decision = evaluateLive2DMotionIntent(
      {
        currentMotionGroup: 'idle',
        isMotionActuallyPlaying: true,
        lastOffset: 2.0,
        motionStartTime: 4,
        currentEpoch: 10,
        isReconstructing: false,
      },
      {
        motionKey: 'wave',
        priority: 3,
        offset: 1.0,
        sceneTime: 5,
        skipHardReset: true,
        requestEpoch: 9,
      },
    );

    expect(decision.stale).toBe(true);
    expect(decision.restart.needsRestart).toBe(true);
    expect(decision.restart.groupChanged).toBe(true);
    expect(decision.restart.isMovingBackward).toBe(true);
    expect(decision.snapshotRestorePolicy).toBe('preserve-current');
  });
});
