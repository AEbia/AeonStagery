import type { Live2DRuntimeControlPort } from '../../runtime/Live2DRuntimeControlPort';
import type { Live2DClockTransaction } from './Live2DRuntimeClockCoordinator';
import type { Live2DRuntimeClock } from './Live2DRuntimeClockCoordinator';
import type { ModelSnapshot } from '../../Live2DConfig';
import type {
  Live2DPerformanceTransitionInput,
  Live2DPerformanceTransitionResult,
  Live2DSeekMotionOffsetInput,
  Live2DSeekMotionOffsetResult,
  Live2DSeekRestoreInput,
  Live2DSeekRestoreResult,
} from '../../runtime/Live2DRuntimeContracts';
import type { Live2DModelHandle, Live2DInternalRuntimeCapabilities } from './Live2DRuntimeControlModule';
import {
  getSharedRuntimeClock,
  getSharedRuntimeClockForTransaction,
  withSharedRuntimeClock,
} from './Live2DRuntimeClockCoordinator';

function isDefaultPose(snapshot: ModelSnapshot | null): boolean {
  if (!snapshot?.params?.length) return true;
  for (let index = 0; index < snapshot.params.length; index++) {
    if (snapshot.params[index] !== 0) return false;
  }
  return true;
}

export function createBoundModelPerformance(
  id: string,
  model: object,
  controls: Live2DRuntimeControlPort,
  capabilities: Live2DInternalRuntimeCapabilities,
): {
  performance: Pick<Live2DModelHandle, 'performance'>['performance'];
  transitionInTransaction(input: Live2DPerformanceTransitionInput, transaction?: Live2DClockTransaction): Promise<Live2DPerformanceTransitionResult>;
  resetMotionTracking(): void;
  restoreExpressionBeforeFrame(key: string | null, elapsed: number, previousKey: string | null | undefined,
    isCurrent: () => boolean, transaction?: Live2DClockTransaction): Promise<boolean>;
} {
  let motionStartUtTimeMs: number | undefined;

  async function transition(
    input: Live2DPerformanceTransitionInput,
    transaction?: Live2DClockTransaction,
  ): Promise<Live2DPerformanceTransitionResult> {
    if (!input.isCurrent()) return { status: 'cancelled', offsetReplayMs: 0 };
    if (!controls.hasMotionGroup(model, input.motionKey)) {
      return { status: 'missing', offsetReplayMs: 0 };
    }

    await controls.preloadMotion(model, input.motionKey);
    if (!input.isCurrent()) return { status: 'cancelled', offsetReplayMs: 0 };

    const runStart = async (
      clock: Live2DRuntimeClock | null,
      activeTransaction: Live2DClockTransaction | null,
    ) => {
      if (!input.isCurrent()) return { status: 'cancelled', offsetReplayMs: 0 } as const;

      const handoff = input.handoffSnapshot ?? null;
      const replaying = capabilities.usesSharedSdkClock;
      if (handoff && !replaying) controls.applySnapshot(model, handoff);
      if (!input.isCurrent()) return { status: 'cancelled', offsetReplayMs: 0 } as const;

      const started = await controls.startMotion(model, input.motionKey, input.priority, input.offsetSeconds, {
        clock: replaying ? clock : null,
        fadeInSeconds: input.fadeInSeconds,
        clearQueueFirst: input.clearQueueFirst,
        stepAfterStartMs: replaying && !input.clearQueueFirst && input.offsetSeconds <= 0 ? 16 : undefined,
        isCurrent: input.isCurrent,
        beforeReplay: replaying && handoff
          ? () => {
              if (!input.isCurrent()) return;
              controls.applySnapshot(model, handoff);
            }
          : undefined,
      });
      if (started.cancelled || !input.isCurrent()) {
        return { status: 'cancelled', offsetReplayMs: started.offsetReplayMs } as const;
      }
      if (!started.ok) return { status: 'missing', offsetReplayMs: started.offsetReplayMs } as const;
      motionStartUtTimeMs = started.motionStartUtTimeMs;

      if (input.finalSnapshot && !replaying) controls.applySnapshot(model, input.finalSnapshot);
      if (input.expressionKey !== undefined) {
        const restored = await restoreExpression(input.expressionKey, 0, undefined, input.isCurrent, activeTransaction ?? undefined);
        if (!restored) return { status: 'cancelled', offsetReplayMs: started.offsetReplayMs } as const;
      }

      let retainedHandoffBoundary = false;
      if (replaying && input.restoreHandoffBoundary && handoff && input.isCurrent()) {
        const advanced = controls.captureSnapshot(id, model, input.sceneTimeSeconds);
        if (isDefaultPose(advanced)) controls.applySnapshot(model, handoff);
        retainedHandoffBoundary = true;
      }
      return {
        status: 'started',
        offsetReplayMs: started.offsetReplayMs,
        retainedHandoffBoundary,
      } as const;
    };

    if (capabilities.usesSharedSdkClock) {
      const result = await withSharedRuntimeClock(
        getSharedRuntimeClock(),
        input.isCurrent,
        (activeTransaction) => runStart(
          getSharedRuntimeClockForTransaction(activeTransaction),
          activeTransaction,
        ),
        transaction,
      );
      return result ?? { status: 'cancelled', offsetReplayMs: 0 };
    }
    return runStart(null, null);
  }

  async function seekMotionOffset(
    input: Live2DSeekMotionOffsetInput,
    transaction?: Live2DClockTransaction,
  ): Promise<Live2DSeekMotionOffsetResult> {
    if (!capabilities.usesSharedSdkClock) return { status: 'unsupported' };
    if (!input.isCurrent()) return { status: 'cancelled' };
    const result = await withSharedRuntimeClock(getSharedRuntimeClock(), input.isCurrent, async (transaction) => {
      const clock = getSharedRuntimeClockForTransaction(transaction);
      if (!clock) return { status: 'unsupported' } as const;
      if (!input.isCurrent()) return { status: 'cancelled' } as const;
      const offsetMs = Math.max(0, input.offsetSeconds) * 1000;
      const motionStart = motionStartUtTimeMs ?? clock.getUserTimeMSec() - offsetMs;
      const targetUtTimeMs = motionStart + offsetMs;
      motionStartUtTimeMs = motionStart;
      clock.setUserTimeMSec(targetUtTimeMs);
      if (!input.isCurrent()) return { status: 'cancelled' } as const;
      controls.advanceMotionOnly(model, targetUtTimeMs);

      let retainedHandoffBoundary = false;
      if (input.handoffBoundarySnapshot && input.isCurrent()) {
        const current = controls.captureSnapshot(id, model);
        if (isDefaultPose(current)) controls.applySnapshot(model, input.handoffBoundarySnapshot);
        else retainedHandoffBoundary = false;
        if (isDefaultPose(current)) retainedHandoffBoundary = true;
      }
      return { status: 'advanced', retainedHandoffBoundary } as const;
    }, transaction);
    return result ?? { status: 'cancelled' };
  }

  async function restoreSeekState(input: Live2DSeekRestoreInput): Promise<Live2DSeekRestoreResult> {
    const isCurrent = input.isCurrent ?? (() => true);
    if (!isCurrent()) return { status: 'cancelled', tierUsed: 'unsupported' };
    const result = await controls.restoreSeekState(model, { ...input, id, isCurrent });
    if (!isCurrent()) return { status: 'cancelled', tierUsed: result.tierUsed, diagnostics: result.diagnostics };
    if (input.motion && capabilities.usesSharedSdkClock) {
      const clock = getSharedRuntimeClock();
      const offsetMs = Math.max(0, input.motion.offset) * 1000;
      motionStartUtTimeMs = clock ? clock.getUserTimeMSec() - offsetMs : undefined;
    } else {
      motionStartUtTimeMs = undefined;
    }
    return result;
  }

  async function restoreExpression(
    expressionKey: string | null,
    elapsedSeconds: number,
    previousExpressionKey: string | null | undefined,
    isCurrent: () => boolean,
    transaction?: Live2DClockTransaction,
    commitPose = true,
  ): Promise<boolean> {
    if (!isCurrent()) return false;
    if (!controls.setExpressionForSeek) {
      controls.setExpression(model, expressionKey);
      return isCurrent();
    }
    await controls.setExpressionForSeek(model, expressionKey, elapsedSeconds, previousExpressionKey, isCurrent, transaction);
    if (!isCurrent()) return false;
    if (commitPose && capabilities.evaluatesPoseOnZeroDelta) controls.advanceFrame(model, 0);
    return isCurrent();
  }

  return {
    performance: {
      transition: (input) => transition(input),
      seekMotionOffset: (input) => seekMotionOffset(input),
      restoreSeekState,
      restoreExpression: (expressionKey, elapsedSeconds, previousExpressionKey, isCurrent) =>
        restoreExpression(expressionKey, elapsedSeconds, previousExpressionKey, isCurrent),
    },
    transitionInTransaction: transition,
    resetMotionTracking: () => { motionStartUtTimeMs = undefined; },
    restoreExpressionBeforeFrame: (key, elapsed, previousKey, isCurrent, transaction) =>
      restoreExpression(key, elapsed, previousKey, isCurrent, transaction, false),
  };
}
