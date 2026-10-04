export const LIVE2D_MOTION_OFFSET_JUMP_THRESHOLD_SECONDS = 0.15;
export const LIVE2D_MOTION_BACKWARD_EPSILON_SECONDS = 0.001;
export const LIVE2D_MOTION_TINY_OFFSET_SECONDS = 0.02;
export const LIVE2D_MOTION_HANDOFF_OFFSET_SECONDS = 0.5;

export interface Live2DMotionRestartInput {
  currentMotionGroup?: string;
  targetMotionGroup: string;
  isMotionActuallyPlaying: boolean;
  previousOffset?: number;
  requestedOffset: number;
  motionStartTime?: number;
  sceneTime: number;
}

export interface Live2DMotionRestartDecision {
  needsRestart: boolean;
  groupChanged: boolean;
  isTimeJumping: boolean;
  isMovingBackward: boolean;
  currentOffset: number;
}

export interface Live2DEpochState {
  currentEpoch: number;
  requestEpoch?: number;
}

export type Live2DSnapshotRestorePolicy = 'restore-idle' | 'preserve-current';

export interface Live2DSnapshotRestoreInput {
  skipHardReset: boolean;
  isReconstructing?: boolean;
}

export interface Live2DMotionIntent {
  motionKey: string;
  priority: number;
  offset: number;
  sceneTime: number;
  skipHardReset: boolean;
  requestEpoch?: number;
}

export interface Live2DFrameEvaluationState {
  currentMotionGroup?: string;
  isMotionActuallyPlaying: boolean;
  lastOffset?: number;
  motionStartTime?: number;
  currentEpoch: number;
  isReconstructing?: boolean;
}

export interface Live2DFrameEvaluationDecision {
  stale: boolean;
  restart: Live2DMotionRestartDecision;
  snapshotRestorePolicy: Live2DSnapshotRestorePolicy;
}

export function normalizeLive2DMotionOffset(
  offset: number,
  options: { preserveTinyOffset?: boolean } = {},
): number {
  if (options.preserveTinyOffset) return Math.max(0, offset);
  return offset < LIVE2D_MOTION_TINY_OFFSET_SECONDS ? 0 : offset;
}

export function isLive2DMotionBoundaryOffset(offset: number): boolean {
  return offset >= 0 && offset < LIVE2D_MOTION_TINY_OFFSET_SECONDS;
}

export function isLive2DMotionHandoffOffset(offset: number): boolean {
  return offset >= 0 && offset < LIVE2D_MOTION_HANDOFF_OFFSET_SECONDS;
}

export function isLive2DEpochStale(input: Live2DEpochState): boolean {
  return input.requestEpoch !== undefined && input.requestEpoch > 0 && input.currentEpoch !== input.requestEpoch;
}

export function decideLive2DMotionRestart(input: Live2DMotionRestartInput): Live2DMotionRestartDecision {
  const groupChanged = input.currentMotionGroup !== input.targetMotionGroup;
  const isMovingBackward =
    input.previousOffset !== undefined &&
    input.requestedOffset < input.previousOffset - LIVE2D_MOTION_BACKWARD_EPSILON_SECONDS;
  const currentOffset =
    input.motionStartTime !== undefined
      ? input.sceneTime - input.motionStartTime
      : -1;
  const isTimeJumping =
    Math.abs(currentOffset - input.requestedOffset) > LIVE2D_MOTION_OFFSET_JUMP_THRESHOLD_SECONDS;

  return {
    needsRestart: !input.isMotionActuallyPlaying || groupChanged || isTimeJumping || isMovingBackward,
    groupChanged,
    isTimeJumping,
    isMovingBackward,
    currentOffset,
  };
}

export function getLive2DSnapshotRestorePolicy(input: Live2DSnapshotRestoreInput): Live2DSnapshotRestorePolicy {
  return input.skipHardReset || input.isReconstructing ? 'preserve-current' : 'restore-idle';
}

export function evaluateLive2DMotionIntent(
  state: Live2DFrameEvaluationState,
  intent: Live2DMotionIntent,
): Live2DFrameEvaluationDecision {
  const stale = isLive2DEpochStale({
    currentEpoch: state.currentEpoch,
    requestEpoch: intent.requestEpoch,
  });

  return {
    stale,
    restart: decideLive2DMotionRestart({
      currentMotionGroup: state.currentMotionGroup,
      targetMotionGroup: intent.motionKey,
      isMotionActuallyPlaying: state.isMotionActuallyPlaying,
      previousOffset: state.lastOffset,
      requestedOffset: intent.offset,
      motionStartTime: state.motionStartTime,
      sceneTime: intent.sceneTime,
    }),
    snapshotRestorePolicy: getLive2DSnapshotRestorePolicy({
      skipHardReset: intent.skipHardReset,
      isReconstructing: state.isReconstructing,
    }),
  };
}
