import type { ModelSnapshot } from '../../Live2DConfig';
import type {
  Live2DPerformanceTransitionInput,
  Live2DPerformanceTransitionResult,
  Live2DRuntimeClock,
  Live2DClockTransaction,
  Live2DRuntimeModelControls,
  Live2DSeekMotionOffsetInput,
  Live2DSeekMotionOffsetResult,
  Live2DSeekRestoreInput,
  Live2DSeekRestoreResult,
} from '../../runtime/Live2DRuntimeContracts';
import type { Live2DModelHandle, Live2DRuntimeCapabilities } from './Live2DRuntimeControlModule';

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
  controls: Live2DRuntimeModelControls,
  capabilities: Live2DRuntimeCapabilities,
): Pick<Live2DModelHandle, 'performance'> {
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

    const runStart = async (clock: Live2DRuntimeClock | null) => {
      if (!input.isCurrent()) return { status: 'cancelled', offsetReplayMs: 0 } as const;

      const handoff = input.handoffSnapshot ?? null;
      const replaying = capabilities.usesSharedSdkClock;
      if (handoff && !replaying) controls.applySnapshot(model, handoff);
      if (!input.isCurrent()) return { status: 'cancelled', offsetReplayMs: 0 } as const;

      const started = await controls.startMotion(model, input.motionKey, input.priority, input.offsetSeconds, {
        clock: replaying ? clock : null,
        fadeInSeconds: input.fadeInSeconds,
        clearQueueFirst: input.clearQueueFirst,
        stepAfterStartMs: input.stepAfterStartMs,
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

      if (input.finalSnapshot && !replaying) controls.applySnapshot(model, input.finalSnapshot);
      if (input.expressionKey !== undefined && input.isCurrent()) {
        controls.setExpression(model, input.expressionKey);
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
        motionStartUtTimeMs: started.motionStartUtTimeMs,
        retainedHandoffBoundary,
      } as const;
    };

    if (capabilities.usesSharedSdkClock) {
      const result = await controls.withSharedClock(model, input.isCurrent, runStart, transaction);
      return result ?? { status: 'cancelled', offsetReplayMs: 0 };
    }
    const result = await controls.withSharedClock(model, input.isCurrent, runStart, transaction);
    return result ?? { status: 'cancelled', offsetReplayMs: 0 };
  }

  async function seekMotionOffset(input: Live2DSeekMotionOffsetInput): Promise<Live2DSeekMotionOffsetResult> {
    if (!capabilities.usesSharedSdkClock) return { status: 'unsupported' };
    if (!input.isCurrent()) return { status: 'cancelled' };
    const result = await controls.withSharedClock(model, input.isCurrent, async (clock) => {
      if (!clock) return { status: 'unsupported' } as const;
      if (!input.isCurrent()) return { status: 'cancelled' } as const;
      const offsetMs = Math.max(0, input.offsetSeconds) * 1000;
      const motionStartUtTimeMs = input.motionStartUtTimeMs ?? clock.getUserTimeMSec() - offsetMs;
      const targetUtTimeMs = motionStartUtTimeMs + offsetMs;
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
      return { status: 'advanced', motionStartUtTimeMs, retainedHandoffBoundary } as const;
    });
    return result ?? { status: 'cancelled' };
  }

  async function restoreSeekState(input: Live2DSeekRestoreInput): Promise<Live2DSeekRestoreResult> {
    const isCurrent = input.isCurrent ?? (() => true);
    if (!isCurrent()) return { status: 'cancelled', tierUsed: 'unsupported' };
    const result = await controls.restoreSeekState(model, { ...input, id, isCurrent });
    if (!isCurrent()) return { status: 'cancelled', tierUsed: result.tierUsed, diagnostics: result.diagnostics };
    return result;
  }

  async function restoreExpression(
    expressionKey: string | null,
    elapsedSeconds: number,
    previousExpressionKey: string | null | undefined,
    isCurrent: () => boolean,
    transaction?: Live2DClockTransaction,
  ): Promise<boolean> {
    if (!isCurrent()) return false;
    if (!controls.setExpressionForSeek) {
      controls.setExpression(model, expressionKey);
      return isCurrent();
    }
    await controls.setExpressionForSeek(model, expressionKey, elapsedSeconds, previousExpressionKey, isCurrent, transaction);
    if (!isCurrent()) return false;
    if (capabilities.evaluatesPoseOnZeroDelta) controls.advanceFrame(model, 0);
    return isCurrent();
  }

  return {
    performance: {
      transition,
      seekMotionOffset,
      restoreSeekState,
      restoreExpression,
    },
  };
}
