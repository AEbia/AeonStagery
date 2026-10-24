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
import type * as PIXI from 'pixi.js';

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  getCoreModel(model: any): any | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  describeInvalidState(model: any): string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  getAvailableMotions(model: any): string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  getAvailableExpressions(model: any): string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  getMotionDuration(model: any, motionKey: string): number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  getMotionDebugState(model: any): Record<string, unknown> | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  getParameterValues(model: any): Array<{ index: number; name: string; value: number }> | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  getParameterMetadata(model: any): readonly Live2DParameterMetadata[] | null;
  /** Register a project-prepared performance without exposing SDK internals. */
  registerExternalMotion(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
    model: any,
    runtimeKey: string,
    source: PreparedAssetRef,
    metadata?: Live2DPerformanceMetadata,
  ): Promise<PerformanceCompatibility>;
  registerExternalExpression(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
    model: any,
    runtimeKey: string,
    source: PreparedAssetRef,
    metadata?: Live2DPerformanceMetadata,
  ): Promise<PerformanceCompatibility>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  unregisterExternalPerformance(model: any, runtimeKey: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  clearMotionState(model: any): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  stopAllMotions(model: any): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  preloadMotion(model: any, motionKey: string): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  setExpression(model: any, expressionName: string | null): void;
  setExpressionForSeek?(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
    model: any,
    expressionName: string | null,
    elapsedSeconds: number,
    previousExpressionKey?: string | null,
    isCurrent?: () => boolean,
    transaction?: Live2DClockTransaction,
  ): Promise<void>;
  /** Write parameter input only; callers commit geometry once after a batch. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  setInjectedParameter(model: any, paramName: string, value: number): void;
  /** Commit the accumulated parameter inputs to the model geometry. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  syncInputParameters(model: any): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  captureSnapshot(id: string, model: any, motionStartTime?: number): ModelSnapshot | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  applySnapshot(model: any, snapshot: ModelSnapshot): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  restoreSeekState(model: any, input: Live2DSeekRestoreInput): Promise<Live2DSeekRestoreResult>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  renderForBake(model: any, renderer: PIXI.Renderer | null, label?: string, renderTexture?: PIXI.RenderTexture): void;

  /** Enumerate the concrete runtime model instances of a (possibly composite) model. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  getConcreteModels(model: any): any[];
  /** Pin the next simulation's effect channels to authored scene time. */
  setSceneTime?(model: object, sceneTimeSeconds: number, deltaMs?: number): void;
  /** Standard per-frame simulation step (`model.update(deltaMs)`; composite-aware). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  advanceFrame(model: any, deltaMs: number): void;
  /** Advance only the motion queues of every concrete model to an absolute SDK time. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
    model: any,
    deltaMs: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
    renderer?: any,
    label?: string,
    flushCore?: boolean,
  ): void;
  /** Load-time idle flush: start the idle group once, step 16ms, then stop it. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  flushIdleState(model: any, isCurrent?: () => boolean, transaction?: Live2DClockTransaction): Promise<void>;
  /** Hard reset to idle: stop motions/expressions, restore idle pose, reset focus. */
  resetModelToIdle(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
    model: any,
    options?: Live2DModelResetOptions,
    isCurrent?: () => boolean,
    transaction?: Live2DClockTransaction,
  ): Promise<void>;
  /** Restore only the idle parameter baseline (uncovered-parameter ownership handoff). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  applyIdleBaseline(model: any, idleSnapshot: Pick<ModelSnapshot, 'params' | 'opacities'> | null): void;
  /** Capture the load-time idle parameter/opacity arrays and persist core params. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  captureIdleSnapshot(model: any): { params: Float32Array; opacities: Float32Array } | null;
  /** Start the authored idle motion group if present (keeps it playing). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  restartIdleMotion(model: any): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  hasMotionGroup(model: any, motionKey: string): boolean;
  startMotion(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
    model: any,
    motionKey: string,
    priority: number,
    offsetSeconds: number,
    options?: Live2DMotionStartOptions,
  ): Promise<Live2DInternalMotionStartResult>;
  /** Evaluate a resource motion in isolation and return SDK-neutral data. */
  sampleMotion(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
    model: any,
    input: Omit<InstallCustomMotionStageInput, 'targets'>,
  ): CustomMotionStageHandle | null;
  /** Pre-disposal teardown: stop motions/queues and reset the expression manager. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  quiesceModel(model: any): void;
  /** Dispose or soft-detach a model with the runtime's exact teardown semantics. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  disposeModel(model: any, options: Live2DDisposeOptions): void;
  /** Install the runtime's behavior/GL hooks (bake or live stage). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  prepareModel(model: any, options: Live2DModelPrepareOptions): void;
  /** Prepare adapter-owned mask and render resources before the first use. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  prepareModelResources(model: any): void;
  /** Isolate the mask render buffer for one concrete model (multi-model fix). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  isolateMask(model: any): void;
  /** Install the Cubism 2 bake render/GL guards BEFORE the first render. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  installBakeRenderGuards(model: any): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  setBlink(model: any, enabled: boolean, intervalMs?: number, sceneTimeSeconds?: number, startTimeSeconds?: number, intervalRangeMs?: number): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  applyFocus(model: any, input: Live2DFocusInput): void;
  /** Internal handle seam for engine-side GSAP tween lifecycle around focus. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  getFocusControllers(model: any): any[];
  /** Stop/pause/resume focus tweens without exposing their SDK targets. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  manageFocusAnimations(model: any, action: Live2DFocusAnimationAction): void;
  /** Read the authored head hit-area anchor (model.json layout data). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  getHeadAnchor(model: any, target?: 'head' | 'main'): { x: number; y: number } | null;
}

