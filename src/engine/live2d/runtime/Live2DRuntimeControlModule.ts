import type { Live2DRuntimeControlPort } from '../../runtime/Live2DRuntimeControlPort';
import type { Live2DClockTransaction } from './Live2DRuntimeClockCoordinator';
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
  Live2DSeekRestoreInput,
  Live2DSeekRestoreResult,
  Live2DMotionSamplingOptions,
  Live2DMotionSamplingResult,
  Live2DPerformanceTransitionInput,
  Live2DPerformanceTransitionResult,
  Live2DPerformanceResource,
  PerformanceCompatibility,
  Live2DSeekMotionOffsetInput,
  Live2DSeekMotionOffsetResult,
  Live2DFocusAnimationAction,
  Live2DFocusInput,
  Live2DFrameSubmissionInput,
  Live2DFrameSubmissionResult,
  Live2DModelResetOptions,
  Live2DBakeFrameBatchInput,
  Live2DBakeFrameBatchResult,
  Live2DBakeFrameInput,
} from '../../runtime/Live2DRuntimeContracts';
import {
  getSharedRuntimeClock,
  getSharedRuntimeClockForTransaction,
  withSharedRuntimeClock,
  advanceSharedRuntimeClock,
} from './Live2DRuntimeClockCoordinator';

export interface Live2DRuntimeCapabilities {
  readonly runtimeFamily: Live2DRuntimeDescriptor['runtimeFamily'];
  readonly adapterId: Live2DAdapterId;
  readonly supportsMotion: boolean;
  readonly supportsExpression: boolean;
  readonly supportsParameterInjection: boolean;
  readonly supportsSnapshot: boolean;
  readonly supportsBakeRender: boolean;
  /** update(0) evaluates motion/expression writers and commits the pose. */
  readonly evaluatesPoseOnZeroDelta: boolean;
  readonly supportsMotionHandoff: boolean;
  readonly supportsCompositeModels: boolean;
  readonly supportsFallbackModel: boolean;
  readonly determinism: Live2DDeterminismCapabilities;
}

/** SDK-specific implementation facts never cross the bound handle boundary. */
export interface Live2DInternalRuntimeCapabilities extends Live2DRuntimeCapabilities {
  readonly usesCubism2PrivateControls: boolean;
  readonly usesSharedSdkClock: boolean;
  readonly requiresIdleMotionFlush: boolean;
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

function resolveInternalCapabilities(runtime: Live2DRuntimeDescriptor): Live2DInternalRuntimeCapabilities {
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

/** Capability classification stays here, including before a model is loaded. */
export function resolveLive2DRuntimeCapabilities(runtime: Live2DRuntimeDescriptor): Live2DRuntimeCapabilities {
  const { usesCubism2PrivateControls: _cubism2, usesSharedSdkClock: _clock, requiresIdleMotionFlush: _flush, ...capabilities } =
    resolveInternalCapabilities(runtime);
  return capabilities;
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
  ): Promise<boolean>;
  restoreIdleBaseline(idleSnapshot?: ModelSnapshot | null): void;
  /** Restore Bake's idle baseline and optional idle start before an appearance. */
  prepareForBakePlayback(
    idleSnapshot: ModelSnapshot,
    restartIdleMotion: boolean,
    isCurrent: () => boolean,
  ): Promise<boolean>;
}

export interface Live2DMotionInterface {
  getAvailableMotions(): string[];
  hasMotionGroup(motionKey: string): boolean;
  getMotionDuration(motionKey: string): number;
  getMotionDebugState(): Record<string, unknown> | null;
  preloadMotion(motionKey: string, isCurrent?: () => boolean): Promise<boolean>;
  sampleMotion(motionKey: string, options: Live2DMotionSamplingOptions): Promise<Live2DMotionSamplingResult>;
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
  ): Promise<boolean>;
}

export interface Live2DParameterInterface {
  getParameterValues(): Array<{ index: number; name: string; value: number }> | null;
  getParameterMetadata(): readonly Live2DParameterMetadata[] | null;
  setInjectedParameter(paramName: string, value: number): void;
  syncInputParameters(): void;
  restoreIdleBaseline(idleSnapshot?: ModelSnapshot | null): void;
}

export interface Live2DSnapshotInterface {
  captureSnapshot(motionStartTime?: number): ModelSnapshot | null;
  applySnapshot(snapshot: ModelSnapshot): void;
  restoreSeekState(input: Live2DSeekRestoreInput): Promise<Live2DSeekRestoreResult>;
}

export interface Live2DPerformanceInterface {
  transition(input: Live2DPerformanceTransitionInput): Promise<Live2DPerformanceTransitionResult>;
  seekMotionOffset(input: Live2DSeekMotionOffsetInput): Promise<Live2DSeekMotionOffsetResult>;
  restoreSeekState(input: Live2DSeekRestoreInput): Promise<Live2DSeekRestoreResult>;
  restoreExpression(
    expressionName: string | null,
    elapsedSeconds: number,
    previousExpressionKey: string | null | undefined,
    isCurrent: () => boolean,
  ): Promise<boolean>;
}

export interface Live2DFrameInterface {
  shouldDeferPreview(): boolean;
  submit(input: Live2DFrameSubmissionInput): Live2DFrameSubmissionResult;
}

export interface Live2DFocusInterface {
  apply(input: Live2DFocusInput): void;
  manageAnimations(action: Live2DFocusAnimationAction): void;
}

export interface Live2DCustomMotionInterface {
  installStage(input: Omit<InstallCustomMotionStageInput, 'targets'>): CustomMotionStageHandle | null;
}

export interface Live2DRenderInterface {
  renderForBake(renderer: PIXI.Renderer, label?: string, renderTexture?: PIXI.RenderTexture): void;
}

export interface Live2DDiagnosticsInterface {
  describeInvalidState(): string | null;
}

export interface Live2DExternalPerformanceInterface {
  register(resource: Live2DPerformanceResource): Promise<PerformanceCompatibility>;
  unregister(runtimeKey: string): void;
}

export interface Live2DBlinkInterface {
  set(enabled: boolean, intervalMs?: number, sceneTimeSeconds?: number, startTimeSeconds?: number, intervalRangeMs?: number): void;
}

export interface Live2DCharacterBehaviorInterface {
  getHeadAnchor(target?: 'head' | 'main'): { x: number; y: number } | null;
}

export interface Live2DModelHandle {
  readonly id: string;
  readonly runtime: Live2DRuntimeDescriptor;
  readonly displayObject: PIXI.Container;
  readonly capabilities: Live2DRuntimeCapabilities;
  readonly blink: Live2DBlinkInterface;
  readonly character: Live2DCharacterBehaviorInterface;
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
  readonly externalPerformances: Live2DExternalPerformanceInterface;
}

interface Live2DModelHandleCreateOptions {
  id: string;
  model: object;
  runtime: Live2DRuntimeDescriptor;
  controls: Live2DRuntimeControlPort;
}

interface PrivateHandleOperations {
  prepareFrameSceneTime(sceneTime: number, deltaMs: number): void;
  restoreExpressionBeforeFrame(key: string | null, elapsed: number, previousKey: string | null | undefined,
    isCurrent: () => boolean, transaction?: Live2DClockTransaction): Promise<boolean>;
  prepareForBakePlayback(
    idleSnapshot: ModelSnapshot,
    restartIdleMotion: boolean,
    isCurrent: () => boolean,
    transaction?: Live2DClockTransaction,
  ): Promise<boolean>;
  transitionInTransaction(
    input: Live2DPerformanceTransitionInput,
    transaction?: Live2DClockTransaction,
  ): Promise<Live2DPerformanceTransitionResult>;
  submitBakeInTransaction(
    input: Live2DBakeFrameInput,
    transaction?: Live2DClockTransaction,
  ): Live2DFrameSubmissionResult;
}

const privateHandleOperations = new WeakMap<Live2DModelHandle, PrivateHandleOperations>();
const privateHandleCapabilities = new WeakMap<Live2DModelHandle, Live2DInternalRuntimeCapabilities>();

/** Advance the runtime clock for one ordinary Stage frame without exposing the SDK clock. */
export function advanceLive2DStageClock(deltaMs: number): void {
  advanceSharedRuntimeClock(deltaMs);
}

/** Advance the shared SDK clock monotonically for export and return its new baseline. */
export function advanceLive2DExportClock(deltaMs: number, minimumTimeMs = 0): number | null {
  const clock = getSharedRuntimeClock();
  if (!clock) return null;
  const current = clock.getUserTimeMSec();
  const baseline = Math.max(Number.isFinite(current) ? current : 0, Number.isFinite(minimumTimeMs) ? minimumTimeMs : 0);
  const next = baseline + (Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : 0);
  if (next !== current) clock.setUserTimeMSec(next);
  return next;
}

export function createLive2DModelHandle({
  id,
  model,
  runtime,
  controls,
}: Live2DModelHandleCreateOptions): Live2DModelHandle {
  const capabilities = resolveInternalCapabilities(runtime);
  const { usesCubism2PrivateControls: _cubism2, usesSharedSdkClock: _clock, requiresIdleMotionFlush: _flush, ...publicCapabilities } = capabilities;
  const performanceBinding = createBoundModelPerformance(id, model, controls, capabilities);
  const performance = performanceBinding.performance;
  const frameBinding = createBoundModelFrame(id, model, controls, capabilities);
  const initialization = createBoundModelInitialization(id, model, controls, capabilities);
  const prepareForBakePlayback = async (
    idleSnapshot: ModelSnapshot,
    restartIdleMotion: boolean,
    isCurrent: () => boolean,
    transaction?: Live2DClockTransaction,
  ): Promise<boolean> => {
    const prepare = async () => {
      if (!isCurrent()) return false;
      controls.stopAllMotions(model);
      controls.clearMotionState(model);
      performanceBinding.resetMotionTracking();
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
  };

  const handle: Live2DModelHandle = {
    id,
    runtime,
    displayObject: model as PIXI.Container,
    capabilities: publicCapabilities,
    ...createBoundModelParameters(model, controls),
    ...initialization,
    resetRuntimeState: (input) => {
      initialization.resetRuntimeState(input);
      if (input?.stopPlayback !== false) performanceBinding.resetMotionTracking();
    },
    lifecycle: {
      clearMotionState: () => {
        controls.clearMotionState(model);
        performanceBinding.resetMotionTracking();
      },
      stopAllMotions: () => {
        controls.stopAllMotions(model);
        performanceBinding.resetMotionTracking();
      },
      prepareForBakePlayback: (idleSnapshot, restartIdleMotion, isCurrent) =>
        prepareForBakePlayback(idleSnapshot, restartIdleMotion, isCurrent),
      restoreIdleBaseline: (idleSnapshot = null) => controls.applyIdleBaseline(model, idleSnapshot),
      resetToIdle: async (options = {}, isCurrent = () => true) => {
        if (!isCurrent()) return false;
        if (!capabilities.usesCubism2PrivateControls) {
          await controls.resetModelToIdle(model, options, isCurrent);
          if (isCurrent()) performanceBinding.resetMotionTracking();
          return isCurrent();
        }
        const result = await withSharedRuntimeClock(
          getSharedRuntimeClock(),
          isCurrent,
          async (activeTransaction) => {
            await controls.resetModelToIdle(model, options, isCurrent, activeTransaction ?? undefined);
            if (!isCurrent()) return false;
            controls.advanceFrame(model, 16);
            performanceBinding.resetMotionTracking();
            return isCurrent();
          },
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
      sampleMotion: (motionKey, options) => controls.sampleMotion(model, motionKey, options),
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
      restoreAtSceneTime: (expressionName, elapsedSeconds, previousExpressionKey, isCurrent) =>
        performance.restoreExpression(expressionName, elapsedSeconds, previousExpressionKey, isCurrent),
    },
    frame: frameBinding.frame,
    ...createBoundModelFocus(model, controls),
    ...createBoundModelCustomMotion(model, controls),
    parameters: {
      getParameterValues: () => controls.getParameterValues(model),
      getParameterMetadata: () => controls.getParameterMetadata(model),
      setInjectedParameter: (paramName, value) => controls.setInjectedParameter(model, paramName, value),
      syncInputParameters: () => controls.syncInputParameters(model),
      restoreIdleBaseline: (idleSnapshot = null) => controls.applyIdleBaseline(model, idleSnapshot),
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
    blink: {
      set: (enabled, intervalMs, sceneTimeSeconds, startTimeSeconds, intervalRangeMs) =>
        controls.setBlink(model, enabled, intervalMs, sceneTimeSeconds, startTimeSeconds, intervalRangeMs),
    },
    character: {
      getHeadAnchor: target => controls.getHeadAnchor(model, target),
    },
    externalPerformances: {
      register: resource => resource.kind === 'motion'
        ? controls.registerExternalMotion(model, resource.runtimeKey, resource.asset, resource.metadata)
        : controls.registerExternalExpression(model, resource.runtimeKey, resource.asset, resource.metadata),
      unregister: runtimeKey => controls.unregisterExternalPerformance(model, runtimeKey),
    },
  };
  privateHandleOperations.set(handle, {
    prepareFrameSceneTime: (time, deltaMs) => controls.setSceneTime?.(model, time, deltaMs),
    restoreExpressionBeforeFrame: performanceBinding.restoreExpressionBeforeFrame,
    prepareForBakePlayback,
    transitionInTransaction: performanceBinding.transitionInTransaction,
    submitBakeInTransaction: frameBinding.submitBakeInTransaction,
  });
  privateHandleCapabilities.set(handle, capabilities);
  return handle;
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
  const usesSharedClock = input.operations.some(operation =>
    privateHandleCapabilities.get(operation.handle)?.usesSharedSdkClock === true);
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
          const reset = await privateHandleOperations.get(operation.handle)!.prepareForBakePlayback(
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
        if (operation.sceneTimeSeconds !== undefined && Number.isFinite(operation.sceneTimeSeconds)) {
          privateHandleOperations.get(operation.handle)!.prepareFrameSceneTime(operation.sceneTimeSeconds, input.deltaMs);
        }
        if (operation.expressionState !== undefined) {
          const expression = operation.expressionState;
          const restored = await privateHandleOperations.get(operation.handle)!.restoreExpressionBeforeFrame(
            expression.key, expression.elapsedSeconds ?? Number.POSITIVE_INFINITY, expression.previousKey,
            current, transaction ?? undefined,
          );
          if (!restored || !current()) return { status: 'cancelled', transitions };
        } else if (operation.expression !== undefined) {
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
        const result = await privateHandleOperations.get(operation.handle)!.transitionInTransaction(
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
        const result = privateHandleOperations.get(operation.handle)!.submitBakeInTransaction({
          deltaMs: input.deltaMs,
          sceneTimeSeconds: operation.sceneTimeSeconds,
          renderer: operation.renderer,
          label: operation.handle.id,
          flushCore: operation.flushCore,
          isCurrent: current,
        }, transaction ?? undefined);
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
