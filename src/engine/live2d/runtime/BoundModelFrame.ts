import type { Live2DRuntimeControlPort } from '../../runtime/Live2DRuntimeControlPort';
import type { Live2DClockTransaction } from './Live2DRuntimeClockCoordinator';
import {
  isSharedRuntimeClockLocked,
  isSharedRuntimeClockTransactionActive,
} from './Live2DRuntimeClockCoordinator';
import type {
  Live2DBakeFrameInput,
  Live2DFrameSubmissionInput,
  Live2DFrameSubmissionResult,
} from '../../runtime/Live2DRuntimeContracts';
import type { Live2DModelHandle, Live2DInternalRuntimeCapabilities } from './Live2DRuntimeControlModule';

function isDefaultPose(params: Float32Array | null | undefined): boolean {
  if (!params?.length) return true;
  for (let index = 0; index < params.length; index++) {
    if (params[index] !== 0) return false;
  }
  return true;
}

export function createBoundModelFrame(
  id: string,
  model: object,
  controls: Live2DRuntimeControlPort,
  capabilities: Live2DInternalRuntimeCapabilities,
): {
  frame: Pick<Live2DModelHandle, 'frame'>['frame'];
  submitBakeInTransaction(input: Live2DBakeFrameInput, transaction?: Live2DClockTransaction): Live2DFrameSubmissionResult;
} {
  function shouldDeferPreview(): boolean {
    return capabilities.usesSharedSdkClock && isSharedRuntimeClockLocked();
  }

  function submit(input: Live2DFrameSubmissionInput): Live2DFrameSubmissionResult {
    const isCurrent = input.isCurrent ?? (() => true);
    if (!isCurrent()) return { status: 'cancelled' };
    if (shouldDeferPreview()) return { status: 'deferred' };

    let retainedHandoffBoundary: boolean | undefined;
    if (input.handoffBoundarySnapshot && input.manualTimeMs !== undefined) {
      const current = controls.captureSnapshot(id, model);
      if (isDefaultPose(current?.params)) {
        controls.applySnapshot(model, input.handoffBoundarySnapshot);
        retainedHandoffBoundary = true;
      } else {
        retainedHandoffBoundary = false;
      }
    }

    if (input.shouldAdvance && isCurrent()) {
      controls.advanceFrame(model, input.forceZeroDeltaCommit ? 0 : input.deltaMs);
    }
    if (!isCurrent()) return { status: 'cancelled', retainedHandoffBoundary };

    if (input.injectedParameters !== undefined) {
      for (const [parameterId, value] of Object.entries(input.injectedParameters)) {
        if (!isCurrent()) return { status: 'cancelled', retainedHandoffBoundary };
        controls.setInjectedParameter(model, parameterId, value);
      }
      if (!isCurrent()) return { status: 'cancelled', retainedHandoffBoundary };
      controls.syncInputParameters(model);
    }
    return { status: 'submitted', retainedHandoffBoundary };
  }

  function submitBake(input: Live2DBakeFrameInput, transaction?: Live2DClockTransaction): Live2DFrameSubmissionResult {
    if (!input.isCurrent()) return { status: 'cancelled' };
    if (capabilities.usesSharedSdkClock
      && !isSharedRuntimeClockTransactionActive(transaction)) {
      return { status: 'deferred' };
    }

    const display = model as { visible?: boolean; renderable?: boolean };
    const renderer = display.visible === false || display.renderable === false
      ? undefined
      : input.renderer;
    controls.stepBakeFrame(
      model,
      input.deltaMs,
      renderer,
      input.label ?? id,
      input.flushCore,
    );
    return input.isCurrent() ? { status: 'submitted' } : { status: 'cancelled' };
  }

  return {
    frame: { shouldDeferPreview, submit },
    submitBakeInTransaction: submitBake,
  };
}
