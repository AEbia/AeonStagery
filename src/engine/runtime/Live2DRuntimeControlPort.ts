import type { ModelSnapshot } from '../Live2DConfig';
import type { Live2DParameterMetadata } from '../../api/types/live2d-parameter-animation';
import type { CustomMotionStageHandle, InstallCustomMotionStageInput } from '../live2d/customMotionStage';
import type { PreparedAssetRef } from '../../api/types/semantic-scene';
import type {
  Live2DDisposeOptions,
  Live2DFocusAnimationAction,
  Live2DFocusInput,
  Live2DModelResetOptions,
  Live2DPerformanceMetadata,
  PerformanceCompatibility,
  Live2DSeekRestoreInput,
  Live2DSeekRestoreResult,
  Live2DMotionSamplingOptions,
  Live2DMotionSamplingResult,
} from './Live2DRuntimeContracts';
import type { Live2DClockTransaction, Live2DRuntimeClock } from '../live2d/runtime/Live2DRuntimeClockCoordinator';

/** Runtime-internal preparation payload; the SDK transform proxy stays private. */
export interface Live2DModelPrepareOptions {
  id: string;
  mode: 'live' | 'bake';
  isExportMode?: boolean;
  injectedParamsSource: { injectedParams: Record<string, number> };
  applyProxyTransform?: (proxyId: string, proxy: Partial<import('../actions/types').TransformationProxy>) => void;
}

/** SDK operation protocol consumed only by adapter implementations. */
export interface Live2DMotionStartOptions {
  clock?: Live2DRuntimeClock | null;
  fadeInSeconds?: number;
  clearQueueFirst?: boolean;
  beforeReplay?: (context: { motionStartUtTimeMs: number }) => void | Promise<void>;
  stepAfterStartMs?: number;
  isCurrent?: () => boolean;
}

/** SDK clock details stay inside the runtime control port. */
export interface Live2DInternalMotionStartResult {
  ok: boolean;
  offsetReplayMs: number;
  motionStartUtTimeMs?: number;
  cancelled?: boolean;
}

export interface Live2DRuntimeControlPort {
  getCoreModel(model: any): any | null;
  describeInvalidState(model: any): string | null;
  getAvailableMotions(model: any): string[];
  getAvailableExpressions(model: any): string[];
  getMotionDuration(model: any, motionKey: string): number;
  getMotionDebugState(model: any): Record<string, unknown> | null;
  getParameterValues(model: any): Array<{ index: number; name: string; value: number }> | null;
  getParameterMetadata(model: any): readonly Live2DParameterMetadata[] | null;
  /** Register a project-prepared performance without exposing SDK internals. */
  registerExternalMotion(
    model: any,
    runtimeKey: string,
    source: PreparedAssetRef,
    metadata?: Live2DPerformanceMetadata,
  ): Promise<PerformanceCompatibility>;
  registerExternalExpression(
    model: any,
    runtimeKey: string,
    source: PreparedAssetRef,
    metadata?: Live2DPerformanceMetadata,
  ): Promise<PerformanceCompatibility>;
  unregisterExternalPerformance(model: any, runtimeKey: string): void;
  clearMotionState(model: any): void;
  stopAllMotions(model: any): void;
  preloadMotion(model: any, motionKey: string): Promise<void>;
  setExpression(model: any, expressionName: string | null): void;
  setExpressionForSeek?(
    model: any,
    expressionName: string | null,
    elapsedSeconds: number,
    previousExpressionKey?: string | null,
    isCurrent?: () => boolean,
    transaction?: Live2DClockTransaction,
  ): Promise<void>;
  /** Write parameter input only; callers commit geometry once after a batch. */
  setInjectedParameter(model: any, paramName: string, value: number): void;
  /** Commit the accumulated parameter inputs to the model geometry. */
  syncInputParameters(model: any): void;
  captureSnapshot(id: string, model: any, motionStartTime?: number): ModelSnapshot | null;
  applySnapshot(model: any, snapshot: ModelSnapshot): void;
  restoreSeekState(model: any, input: Live2DSeekRestoreInput): Promise<Live2DSeekRestoreResult>;
  renderForBake(model: any, renderer: any, label?: string, renderTexture?: any): void;

  /** Enumerate the concrete runtime model instances of a (possibly composite) model. */
  getConcreteModels(model: any): any[];
  /** Standard per-frame simulation step (`model.update(deltaMs)`; composite-aware). */
  advanceFrame(model: any, deltaMs: number): void;
  /** Advance only the motion queues of every concrete model to an absolute SDK time. */
  advanceMotionOnly(model: any, utTimeMs: number): void;
  /**
   * Full bake frame: advance the model, flush the internal/Core update, render
   * into the adapter-owned bake RenderTexture (or advance without render when
   * the Cubism 2 runtime allows it), and flush the core model parameters.
   * `deltaMs === 0` renders/advances with the model's current accumulated
   * delta (used right after an idle flush). `flushCore === false` skips the
   * trailing coreModel.update() (warm-up/initial positions that historically
   * did not flush the core).
   */
  stepBakeFrame(
    model: any,
    deltaMs: number,
    renderer?: any,
    label?: string,
    flushCore?: boolean,
  ): void;
  /** Load-time idle flush: start the idle group once, step 16ms, then stop it. */
  flushIdleState(model: any, isCurrent?: () => boolean, transaction?: Live2DClockTransaction): Promise<void>;
  /** Hard reset to idle: stop motions/expressions, restore idle pose, reset focus. */
  resetModelToIdle(
    model: any,
    options?: Live2DModelResetOptions,
    isCurrent?: () => boolean,
    transaction?: Live2DClockTransaction,
  ): Promise<void>;
  /** Restore only the idle parameter baseline (uncovered-parameter ownership handoff). */
  applyIdleBaseline(model: any, idleSnapshot: Pick<ModelSnapshot, 'params' | 'opacities'> | null): void;
  /** Capture the load-time idle parameter/opacity arrays and persist core params. */
  captureIdleSnapshot(model: any): { params: Float32Array; opacities: Float32Array } | null;
  /** Start the authored idle motion group if present (keeps it playing). */
  restartIdleMotion(model: any): Promise<void>;
  hasMotionGroup(model: any, motionKey: string): boolean;
  startMotion(
    model: any,
    motionKey: string,
    priority: number,
    offsetSeconds: number,
    options?: Live2DMotionStartOptions,
  ): Promise<Live2DInternalMotionStartResult>;
  /** Evaluate a resource motion in isolation and return SDK-neutral data. */
  sampleMotion(
    model: any,
    motionKey: string,
    options: Live2DMotionSamplingOptions,
    transaction?: Live2DClockTransaction,
  ): Promise<Live2DMotionSamplingResult>;
  /**
   * Install the Motion-stage writer on every attachable concrete model.
   * Returns null when no target has both the emitter and parameter-write seams.
   */
  installCustomMotionStage(
    model: any,
    input: Omit<InstallCustomMotionStageInput, 'targets'>,
  ): CustomMotionStageHandle | null;
  /** Pre-disposal teardown: stop motions/queues and reset the expression manager. */
  quiesceModel(model: any): void;
  /** Dispose or soft-detach a model with the runtime's exact teardown semantics. */
  disposeModel(model: any, options: Live2DDisposeOptions): void;
  /** Install the runtime's behavior/GL hooks (bake or live stage). */
  prepareModel(model: any, options: Live2DModelPrepareOptions): void;
  /** Prepare adapter-owned mask and render resources before the first use. */
  prepareModelResources(model: any): void;
  /** Isolate the mask render buffer for one concrete model (multi-model fix). */
  isolateMask(model: any): void;
  /** Install the Cubism 2 bake render/GL guards BEFORE the first render. */
  installBakeRenderGuards(model: any): void;
  setBlink(model: any, enabled: boolean, intervalMs?: number, sceneTimeSeconds?: number, startTimeSeconds?: number, intervalRangeMs?: number): void;
  applyFocus(model: any, input: Live2DFocusInput): void;
  /** Internal handle seam for engine-side GSAP tween lifecycle around focus. */
  getFocusControllers(model: any): any[];
  /** Stop/pause/resume focus tweens without exposing their SDK targets. */
  manageFocusAnimations(model: any, action: Live2DFocusAnimationAction): void;
  /** Read the authored head hit-area anchor (model.json layout data). */
  getHeadAnchor(model: any, target?: 'head' | 'main'): { x: number; y: number } | null;
}

