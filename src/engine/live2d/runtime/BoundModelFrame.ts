import {
  isSharedRuntimeClockLocked,
  isSharedRuntimeClockTransactionActive,
} from './Live2DRuntimeClockCoordinator';
import type {
  Live2DClockTransaction,
  Live2DFrameSubmissionInput,
  Live2DFrameSubmissionResult,
  Live2DRuntimeModelControls,
} from '../../runtime/Live2DRuntimeContracts';
import type { Live2DModelHandle, Live2DRuntimeCapabilities } from './Live2DRuntimeControlModule';

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
  controls: Live2DRuntimeModelControls,
  capabilities: Live2DRuntimeCapabilities,
): Pick<Live2DModelHandle, 'frame'> {
  function shouldDeferPreview(transaction?: Live2DClockTransaction): boolean {
    return capabilities.usesSharedSdkClock
      && isSharedRuntimeClockLocked()
      && !isSharedRuntimeClockTransactionActive(transaction);
  }

  function submit(input: Live2DFrameSubmissionInput): Live2DFrameSubmissionResult {
    const isCurrent = input.isCurrent ?? (() => true);
    if (!isCurrent()) return { status: 'cancelled' };
    if (shouldDeferPreview(input.transaction)) return { status: 'deferred' };

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

  return { frame: { shouldDeferPreview, submit } };
}
