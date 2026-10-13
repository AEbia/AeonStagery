import type * as PIXI from 'pixi.js';
import { createBoundModelInitialization } from './BoundModelInitialization';
import { createBoundModelParameters } from './BoundModelParameters';
import { createBoundModelPerformance } from './BoundModelPerformance';
import { createBoundModelFrame } from './BoundModelFrame';
import { createBoundModelFocus } from './BoundModelFocus';
import { createBoundModelCustomMotion } from './BoundModelCustomMotion';
import type { Live2DParameterEdit, Live2DParameterEditResult, Live2DParameterInspection } from '../../../api/types/live2d-parameter-animation';
import type { Live2DParameterMetadata } from '../../../api/types/live2d-parameter-animation';
import type { ModelSnapshot } from '../../Live2DConfig';
import type { CustomMotionStageHandle, InstallCustomMotionStageInput } from '../customMotionStage';
import type { Live2DAdapterId, Live2DRuntimeDescriptor } from '../../Live2DRuntimeResolver';
import type {
  Live2DInitializationInput,
  Live2DInitializationResult,
  Live2DRuntimeSourceBinding,
  Live2DRuntimeResetInput,
  Live2DDisposeOptions,
  Live2DDeterminismCapabilities,
  Live2DRuntimeModelControls,
  Live2DSeekRestoreInput,
  Live2DSeekRestoreResult,
  Live2DMotionSamplingOptions,
  Live2DMotionSamplingResult,
  Live2DPerformanceTransitionInput,
  Live2DPerformanceTransitionResult,
  Live2DSeekMotionOffsetInput,
  Live2DSeekMotionOffsetResult,
  Live2DFocusAnimationAction,
  Live2DFocusInput,
  Live2DFrameSubmissionInput,
  Live2DFrameSubmissionResult,
  Live2DModelResetOptions,
  Live2DClockTransaction,
  Live2DBakeFrameBatchInput,
  Live2DBakeFrameBatchResult,
  Live2DBakeFrameInput,
  Live2DBakeFrameOperation,
} from '../../runtime/Live2DRuntimeContracts';
import {
  getSharedRuntimeClock,
  getSharedRuntimeClockForTransaction,
  isSharedRuntimeClockTransactionActive,
  withSharedRuntimeClock,
} from './Live2DRuntimeClockCoordinator';

export interface Live2DRuntimeCapabilities {
  readonly runtimeFamily: Live2DRuntimeDescriptor['runtimeFamily'];
  readonly adapterId: Live2DAdapterId;
  readonly supportsMotion: boolean;
  readonly supportsExpression: boolean;
  readonly supportsParameterInjection: boolean;
  readonly supportsSnapshot: boolean;
  readonly supportsBakeRender: boolean;
  readonly usesCubism2PrivateControls: boolean;
  readonly usesSharedSdkClock: boolean;
  /** update(0) evaluates motion/expression writers and commits the pose. */
  readonly evaluatesPoseOnZeroDelta: boolean;
  readonly supportsMotionHandoff: boolean;
  readonly supportsCompositeModels: boolean;
  readonly supportsFallbackModel: boolean;
  readonly requiresIdleMotionFlush: boolean;
  readonly determinism: Live2DDeterminismCapabilities;
}

function resolveDeterminismCapabilities(adapterId: Live2DAdapterId): Live2DDeterminismCapabilities {
  if (adapterId === 'pixi-live2d-display-cubism2') {
    return {
      tier: 'offset-replay-deterministic',
      supportsParameterCurves: true,
      supportsNativeMotionOffset: false,
      supportsMotionOffsetReplay: true,
      supportsStateReplay: false,
      diagnostics: [
        'Cubism 2 motion offsets require fixed-step replay with a shared SDK clock.',
        'Stateful Physics/Pose replay is not guaranteed by this adapter.',
      ],
    };
  }
  if (adapterId === 'untitled-pixi-live2d-engine-cubism') {
    return {
      tier: 'native-offset-deterministic',
      supportsParameterCurves: true,
      supportsNativeMotionOffset: true,
      supportsMotionOffsetReplay: false,
      supportsStateReplay: false,
      diagnostics: [
        'Cubism 3+ parameter motions use the runtime-neutral deterministic curve cache when available.',
        'Native Cubism 3+ motion offsets are restored in O(1); Physics/Pose/LookAt state replay is not guaranteed.',
      ],
    };
  }
  return {
    tier: 'unsupported',
    supportsParameterCurves: false,
    supportsNativeMotionOffset: false,
    supportsMotionOffsetReplay: false,
    supportsStateReplay: false,
    diagnostics: ['No runtime adapter can provide deterministic motion evaluation.'],
  };
}

/** Capability classification stays here, including before a model is loaded. */
export function resolveLive2DRuntimeCapabilities(runtime: Live2DRuntimeDescriptor): Live2DRuntimeCapabilities {
  const usesCubism2PrivateControls = runtime.adapterId === 'pixi-live2d-display-cubism2';
  const isCubism3 = runtime.adapterId === 'untitled-pixi-live2d-engine-cubism';
  const supported = runtime.supported && (usesCubism2PrivateControls || isCubism3);
  return {
    runtimeFamily: runtime.runtimeFamily,
    adapterId: runtime.adapterId,
    supportsMotion: supported,
    supportsExpression: supported,
    supportsParameterInjection: supported,
    supportsSnapshot: supported,
    supportsBakeRender: supported,
    usesCubism2PrivateControls: supported && usesCubism2PrivateControls,
    usesSharedSdkClock: supported && usesCubism2PrivateControls,
    evaluatesPoseOnZeroDelta: supported && isCubism3,
    supportsMotionHandoff: supported && isCubism3,
    supportsCompositeModels: supported && usesCubism2PrivateControls,
    supportsFallbackModel: supported && usesCubism2PrivateControls && runtime.runtimeFamily === 'cubism2',
    requiresIdleMotionFlush: supported && usesCubism2PrivateControls && runtime.runtimeFamily === 'cubism2',
    determinism: resolveDeterminismCapabilities(supported ? runtime.adapterId : 'unknown'),
  };
}

/** Loaded handles are authoritative; descriptor-only legacy entries retain Cubism 2 defaults. */
export function getLive2DRuntimeCapabilities(entry: {
  runtime?: Live2DRuntimeDescriptor | null;
  runtimeHandle?: Pick<Live2DModelHandle, 'capabilities'>;
}): Live2DRuntimeCapabilities {
  return entry.runtimeHandle?.capabilities ?? resolveLive2DRuntimeCapabilities(entry.runtime ?? {
    runtimeFamily: 'cubism2',
    adapterId: 'pixi-live2d-display-cubism2',
    supported: true,
  });
}

export interface Live2DLifecycleInterface {
  clearMotionState(): void;
  stopAllMotions(): void;
  resetToIdle(
    options?: Live2DModelResetOptions,
    isCurrent?: () => boolean,
    transaction?: Live2DClockTransaction,
  ): Promise<boolean>;
  /** Restore Bake's idle baseline and optional idle start before an appearance. */
  prepareForBakePlayback(
    idleSnapshot: ModelSnapshot,
    restartIdleMotion: boolean,
    isCurrent: () => boolean,
    transaction?: Live2DClockTransaction,
  ): Promise<boolean>;
}

export interface Live2DMotionInterface {
  getAvailableMotions(): string[];
  hasMotionGroup(motionKey: string): boolean;
  getMotionDuration(motionKey: string): number;
  getMotionDebugState(): Record<string, unknown> | null;
  preloadMotion(motionKey: string, isCurrent?: () => boolean): Promise<boolean>;
  sampleMotion(motionKey: string, options: Live2DMotionSamplingOptions, transaction?: Live2DClockTransaction): Promise<Live2DMotionSamplingResult>;
  getPlaybackState(): { currentGroup: string | null; playing: boolean };
}

export interface Live2DExpressionInterface {
  getAvailableExpressions(): string[];
  setExpression(expressionName: string | null): void;
  restoreAtSceneTime(
    expressionName: string | null,
    elapsedSeconds: number,
    previousExpressionKey: string | null | undefined,
    isCurrent: () => boolean,
    transaction?: Live2DClockTransaction,
  ): Promise<boolean>;
}

export interface Live2DParameterInterface {
  getParameterValues(): Array<{ index: number; name: string; value: number }> | null;
  getParameterMetadata(): readonly Live2DParameterMetadata[] | null;
  setInjectedParameter(paramName: string, value: number): void;
  syncInputParameters(): void;
}

export interface Live2DSnapshotInterface {
  captureSnapshot(motionStartTime?: number): ModelSnapshot | null;
  applySnapshot(snapshot: ModelSnapshot): void;
  restoreSeekState(input: Live2DSeekRestoreInput): Promise<Live2DSeekRestoreResult>;
}

export interface Live2DPerformanceInterface {
  transition(input: Live2DPerformanceTransitionInput, transaction?: Live2DClockTransaction): Promise<Live2DPerformanceTransitionResult>;
  seekMotionOffset(input: Live2DSeekMotionOffsetInput): Promise<Live2DSeekMotionOffsetResult>;
  restoreSeekState(input: Live2DSeekRestoreInput): Promise<Live2DSeekRestoreResult>;
  restoreExpression(
    expressionName: string | null,
    elapsedSeconds: number,
    previousExpressionKey: string | null | undefined,
    isCurrent: () => boolean,
    transaction?: Live2DClockTransaction,
  ): Promise<boolean>;
}

export interface Live2DFrameInterface {
  shouldDeferPreview(transaction?: Live2DClockTransaction): boolean;
  submit(input: Live2DFrameSubmissionInput): Live2DFrameSubmissionResult;
  submitBake(input: Live2DBakeFrameInput): Live2DFrameSubmissionResult;
}

export interface Live2DFocusInterface {
  apply(input: Live2DFocusInput): void;
  manageAnimations(action: Live2DFocusAnimationAction): void;
}

export interface Live2DCustomMotionInterface {
  installStage(input: Omit<InstallCustomMotionStageInput, 'targets'>): CustomMotionStageHandle | null;
}

export interface Live2DRenderInterface {
  renderForBake(renderer: any, label?: string, renderTexture?: any): void;
}

export interface Live2DDiagnosticsInterface {
  describeInvalidState(): string | null;
}

export interface Live2DModelHandle {
  readonly id: string;
  readonly runtime: Live2DRuntimeDescriptor;
  readonly displayObject: PIXI.Container;
  readonly capabilities: Live2DRuntimeCapabilities;
  inspectParameters(): readonly Live2DParameterInspection[] | null;
  editParameters(edits: readonly Live2DParameterEdit[]): Live2DParameterEditResult;
  initialize(input: Live2DInitializationInput): Promise<Live2DInitializationResult>;
  bindRuntimeSource(input: Live2DRuntimeSourceBinding): boolean;
  resetRuntimeState(input?: Live2DRuntimeResetInput): void;
  quiesce(): void;
  dispose(input: Live2DDisposeOptions): void;
  readonly lifecycle: Live2DLifecycleInterface;
  readonly motion: Live2DMotionInterface;
  readonly expression: Live2DExpressionInterface;
  readonly performance: Live2DPerformanceInterface;
  readonly frame: Live2DFrameInterface;
  readonly focus: Live2DFocusInterface;
  readonly customMotion: Live2DCustomMotionInterface;
  readonly parameters: Live2DParameterInterface;
  readonly snapshot: Live2DSnapshotInterface;
  readonly render: Live2DRenderInterface;
  readonly diagnostics: Live2DDiagnosticsInterface;
}

export interface Live2DModelHandleCreateOptions {
  id: string;
  model: any;
  runtime: Live2DRuntimeDescriptor;
  controls: Live2DRuntimeModelControls;
}

export function createLive2DModelHandle({
  id,
  model,
  runtime,
  controls,
}: Live2DModelHandleCreateOptions): Live2DModelHandle {
  const capabilities = resolveLive2DRuntimeCapabilities(runtime);
  const performance = createBoundModelPerformance(id, model, controls, capabilities).performance;

  return {
    id,
    runtime,
    displayObject: model as PIXI.Container,
    capabilities,
    ...createBoundModelParameters(model, controls),
    ...createBoundModelInitialization(id, model, controls, capabilities),
    lifecycle: {
      clearMotionState: () => controls.clearMotionState(model),
      stopAllMotions: () => controls.stopAllMotions(model),
      prepareForBakePlayback: async (idleSnapshot, restartIdleMotion, isCurrent, transaction) => {
        const prepare = async () => {
          if (!isCurrent()) return false;
          controls.stopAllMotions(model);
          controls.clearMotionState(model);
          if (!isCurrent()) return false;
          controls.applySnapshot(model, idleSnapshot);
          if (restartIdleMotion) {
            await controls.restartIdleMotion(model);
            if (!isCurrent()) return false;
          }
          return isCurrent();
        };
        if (!capabilities.usesSharedSdkClock) return prepare();
        const result = await withSharedRuntimeClock(getSharedRuntimeClock(), isCurrent, prepare, transaction);
        return result ?? false;
      },
      resetToIdle: async (options = {}, isCurrent = () => true, transaction) => {
        if (!isCurrent()) return false;
        if (!capabilities.usesCubism2PrivateControls) {
          await controls.resetModelToIdle(model, options, isCurrent, transaction);
          return isCurrent();
        }
        const result = await withSharedRuntimeClock(
          getSharedRuntimeClock(),
          isCurrent,
          async (activeTransaction) => {
            await controls.resetModelToIdle(model, options, isCurrent, activeTransaction ?? undefined);
            if (!isCurrent()) return false;
            controls.advanceFrame(model, 16);
            return isCurrent();
          },
          transaction,
        );
        return result ?? false;
      },
    },
    motion: {
      getAvailableMotions: () => controls.getAvailableMotions(model),
      hasMotionGroup: (motionKey) => controls.hasMotionGroup(model, motionKey),
      getMotionDuration: (motionKey) => controls.getMotionDuration(model, motionKey),
      getMotionDebugState: () => controls.getMotionDebugState(model),
      preloadMotion: async (motionKey, isCurrent = () => true) => {
        if (!isCurrent()) return false;
        await controls.preloadMotion(model, motionKey);
        return isCurrent();
      },
      sampleMotion: (motionKey, options, transaction) => controls.sampleMotion(model, motionKey, options, transaction),
      getPlaybackState: () => {
        const state = controls.getMotionDebugState(model);
        return {
          currentGroup: typeof state?.currentGroup === 'string' ? state.currentGroup : null,
          playing: state?.playing === true,
        };
      },
    },
    performance,
    expression: {
      getAvailableExpressions: () => controls.getAvailableExpressions(model),
      setExpression: (expressionName) => controls.setExpression(model, expressionName),
      restoreAtSceneTime: (expressionName, elapsedSeconds, previousExpressionKey, isCurrent, transaction) =>
        performance.restoreExpression(expressionName, elapsedSeconds, previousExpressionKey, isCurrent, transaction),
    },
    ...createBoundModelFrame(id, model, controls, capabilities),
    ...createBoundModelFocus(model, controls),
    ...createBoundModelCustomMotion(model, controls),
    parameters: {
      getParameterValues: () => controls.getParameterValues(model),
      getParameterMetadata: () => controls.getParameterMetadata(model),
      setInjectedParameter: (paramName, value) => controls.setInjectedParameter(model, paramName, value),
      syncInputParameters: () => controls.syncInputParameters(model),
    },
    snapshot: {
      captureSnapshot: (motionStartTime) => controls.captureSnapshot(id, model, motionStartTime),
      applySnapshot: (snapshot) => controls.applySnapshot(model, snapshot),
      restoreSeekState: (input) => performance.restoreSeekState(input),
    },
    render: {
      renderForBake: (renderer, label, renderTexture) => controls.renderForBake(model, renderer, label, renderTexture),
    },
    diagnostics: {
      describeInvalidState: () => controls.describeInvalidState(model),
    },
  };
}

/** Run complete Bake work for a frame as one runtime-owned clock transaction. */
export async function submitLive2DBakeFrameBatch(
  input: Live2DBakeFrameBatchInput,
): Promise<Live2DBakeFrameBatchResult> {
  const seen = new Set<string>();
  for (const operation of input.operations) {
    if (seen.has(operation.handle.id)) {
      throw new Error(`Bake frame batch contains duplicate model handle: ${operation.handle.id}`);
    }
    seen.add(operation.handle.id);
  }

  const transitions = new Map<string, Live2DPerformanceTransitionResult>();
  const usesSharedClock = input.operations.some(operation => operation.handle.capabilities.usesSharedSdkClock);
  const run = async (transaction: Live2DClockTransaction | null): Promise<Live2DBakeFrameBatchResult> => {
    const clock = getSharedRuntimeClockForTransaction(transaction);
    const clockTimeAtStart = clock?.getUserTimeMSec();
    const clockFloor = Number.isFinite(clockTimeAtStart) ? Number(clockTimeAtStart) : 0;
    const isCurrent = () => input.isCurrent() && input.operations.every(operation => operation.isCurrent());
    let completed = false;
    try {
      for (const operation of input.operations) {
        const current = () => input.isCurrent() && operation.isCurrent();
        if (!current()) return { status: 'cancelled', transitions };
        if (operation.resetRuntimeState) {
          operation.handle.resetRuntimeState(operation.resetRuntimeState);
          if (!current()) return { status: 'cancelled', transitions };
        }
        if (operation.resetForPlayback) {
          const reset = await operation.handle.lifecycle.prepareForBakePlayback(
            operation.resetForPlayback.idleSnapshot,
            operation.resetForPlayback.restartIdleMotion,
            current,
            transaction ?? undefined,
          );
          if (!reset || !current()) return { status: 'cancelled', transitions };
        } else if (operation.stopMotion) {
          operation.handle.lifecycle.stopAllMotions();
          operation.handle.lifecycle.clearMotionState();
          if (!current()) return { status: 'cancelled', transitions };
        }
        if (operation.expression !== undefined) {
          operation.handle.expression.setExpression(operation.expression);
          if (!current()) return { status: 'cancelled', transitions };
        }
        if (operation.restoreSnapshot) {
          operation.handle.snapshot.applySnapshot(operation.restoreSnapshot);
          if (!current()) return { status: 'cancelled', transitions };
        }
      }

      for (const operation of input.operations) {
        const motionStart = operation.motionStart;
        if (!motionStart) continue;
        const current = () => input.isCurrent() && operation.isCurrent();
        if (!current()) return { status: 'cancelled', transitions };
        const result = await operation.handle.performance.transition(
          { ...motionStart, isCurrent: current },
          transaction ?? undefined,
        );
        transitions.set(operation.handle.id, result);
        if (result.status === 'cancelled' || !current()) return { status: 'cancelled', transitions };
      }

      if (!isCurrent()) return { status: 'cancelled', transitions };
      const shouldSubmitFrame = input.operations.some(operation => operation.submitFrame !== false);
      if (clock && shouldSubmitFrame && input.advanceClock !== false
        && Number.isFinite(input.deltaMs) && input.deltaMs > 0) {
        const currentTime = clock.getUserTimeMSec();
        const safeTime = Number.isFinite(currentTime) ? currentTime : clockFloor;
        clock.setUserTimeMSec(safeTime + input.deltaMs);
      }

      for (const operation of input.operations) {
        if (operation.submitFrame === false) continue;
        const current = () => input.isCurrent() && operation.isCurrent();
        if (!current()) return { status: 'cancelled', transitions };
        const result = operation.handle.frame.submitBake({
          deltaMs: input.deltaMs,
          renderer: operation.renderer,
          label: operation.handle.id,
          flushCore: operation.flushCore,
          isCurrent: current,
          transaction: transaction ?? undefined,
        });
        if (result.status !== 'submitted') return { status: 'cancelled', transitions };
      }
      completed = true;
      return { status: 'submitted', transitions };
    } finally {
      if (!completed && clock) {
        const currentTime = clock.getUserTimeMSec();
        const monotonicTime = Number.isFinite(currentTime)
          ? Math.max(currentTime, clockFloor)
          : clockFloor;
        if (currentTime !== monotonicTime) clock.setUserTimeMSec(monotonicTime);
      }
    }
  };

  if (!usesSharedClock) return run(null);
  const result = await withSharedRuntimeClock(getSharedRuntimeClock(), input.isCurrent, run);
  return result ?? { status: 'cancelled', transitions };
}
