import type { Live2DAdapterId, Live2DRuntimeDescriptor } from '../Live2DRuntimeResolver';
import type { ModelSnapshot } from '../Live2DConfig';
import type { Live2DParameterMetadata } from '../../api/types/live2d-parameter-animation';
import type { Live2DModelHandle } from '../live2d/runtime/Live2DRuntimeControlModule';
import type { Cubism2MotionSamplerTarget } from '../live2d/cubism2MotionSampler';
import type { CustomMotionStageHandle, InstallCustomMotionStageInput } from '../live2d/customMotionStage';
import type { PreparedAssetRef } from '../../api/types/semantic-scene';
export type { PreparedAssetRef } from '../../api/types/semantic-scene';

export type Live2DPerformanceKind = 'motion' | 'expression';
export type Live2DPerformanceRuntimeFamily = 'cubism2' | 'cubism3-plus' | 'wmdl';

export interface Live2DPerformanceMetadata {
  fadeIn?: number;
  fadeOut?: number;
  loop?: boolean;
  sound?: string;
  targetSubmodels?: string[];
  requiredParameterIds?: string[];
  /** Explicitly allow registration when required parameters are missing. */
  allowPartial?: boolean;
}

export interface Live2DPerformanceResource {
  runtimeKey: string;
  kind: Live2DPerformanceKind;
  asset: PreparedAssetRef;
  runtimeFamily: Live2DPerformanceRuntimeFamily;
  metadata?: Live2DPerformanceMetadata;
}

export interface PerformanceCompatibility {
  status: 'compatible' | 'partial' | 'incompatible';
  missingParameterIds: string[];
  ignoredParameterIds: string[];
  diagnostics: string[];
}

export interface PreparedPerformance {
  resource: Live2DPerformanceResource;
  compatibility: PerformanceCompatibility;
  registered: boolean;
}

export interface Live2DPerformanceModelBinding {
  /** Opaque runtime model object; concrete adapters own its shape. */
  model: object;
  runtimeFamily: Live2DPerformanceRuntimeFamily;
  adapter?: Live2DRuntimeAdapter;
}

export interface Live2DModelCreateOptions {
  autoHitTest?: boolean;
  autoFocus?: boolean;
  autoUpdate?: boolean;
  idleMotionGroup?: string;
}

/** Strongest deterministic motion guarantee an adapter can make. */
export type Live2DDeterminismTier =
  | 'parameter-deterministic'
  | 'native-offset-deterministic'
  | 'state-replay-deterministic'
  | 'unsupported';

export interface Live2DDeterminismCapabilities {
  readonly tier: Live2DDeterminismTier;
  /** Pure parameter curves can be evaluated from absolute scene time. */
  readonly supportsParameterCurves: boolean;
  /** Native motion queues can be restored to an authored offset. */
  readonly supportsNativeMotionOffset: boolean;
  /** Physics/Pose/LookAt state can be reconstructed from a fixed-step baseline. */
  readonly supportsStateReplay: boolean;
  readonly diagnostics: readonly string[];
}

export interface Live2DSeekMotionState {
  key: string;
  priority?: number;
  offset: number;
  sceneTime: number;
  /** Scene-level resource motion fade-in override, when authored. */
  fadeInSeconds?: number;
}

export interface Live2DSeekExpressionState {
  key: string | null;
  /** Time since this expression began; absent or +Infinity means fully latched. */
  elapsedSeconds?: number;
}

export type Live2DSeekRestoreTier = 'native' | 'snapshot-forward' | 'visual-freeze' | 'unsupported';

export interface Live2DSeekRestoreInput {
  id: string;
  snapshot?: ModelSnapshot | null;
  /** Pose owned by the previous action at the new motion's start boundary. */
  handoffSnapshot?: ModelSnapshot | null;
  targetSceneTime: number;
  motion?: Live2DSeekMotionState | null;
  expression?: Live2DSeekExpressionState | null;
  idleSnapshot?: Pick<ModelSnapshot, 'params' | 'opacities'> | null;
  isScrubbing?: boolean;
  preserveMotionForPlayback?: boolean;
}

export interface Live2DSeekRestoreResult {
  status: 'restored' | 'fallback' | 'unsupported';
  tierUsed: Live2DSeekRestoreTier;
  diagnostics?: string[];
}

/**
 * Compatibility clock over the runtime's global SDK time. The Cubism 2
 * adapter exposes the shared UtSystem behind this opaque handle so engine
 * modules can keep the monotonic-clock discipline without touching the SDK.
 */
export interface Live2DRuntimeClock {
  getUserTimeMSec(): number;
  setUserTimeMSec(ms: number): void;
}

export interface Live2DMotionStartOptions {
  /** SDK clock used for offset replay spoofing. Null = no clock manipulation. */
  clock?: Live2DRuntimeClock | null;
  /** Scene override for native Cubism motion fade-in. */
  fadeInSeconds?: number;
  /** Clear every concrete model's motion queue (and `playing` flag) before starting. */
  clearQueueFirst?: boolean;
  /**
   * Invoked after the motion is enqueued and the clock is parked at the
   * motion start time, but BEFORE the offset fast-forward replay. Seek
   * restoration uses this window to apply handoff snapshots so the replay
   * evaluates from the restored pose (same injection point as the legacy
   * Cubism 2 seek path).
   */
  beforeReplay?: (context: { motionStartUtTimeMs: number }) => void | Promise<void>;
  /**
   * Extra single-frame step (ms) applied after start when the requested
   * offset is zero. Used by ordinary playback to advance one SDK frame inside
   * the locked clock window.
   */
  stepAfterStartMs?: number;
}

export interface Live2DMotionStartResult {
  ok: boolean;
  offsetReplayMs: number;
  motionStartUtTimeMs?: number;
}

export interface Live2DModelResetOptions {
  keepFocus?: boolean;
  idleSnapshot?: Pick<ModelSnapshot, 'params' | 'opacities'> | null;
}

export interface Live2DModelPrepareOptions {
  id: string;
  mode: 'live' | 'bake';
  /** Export mode disables the SDK clock forward-sync inside parameter hooks. */
  isExportMode?: boolean;
  /**
   * Object exposing live `injectedParams` (CharacterEntry or BakeModel).
   * The parameter-override hook reads it during coreModel.update.
   */
  injectedParamsSource: { injectedParams: Record<string, number> };
  /** Live-stage render-hook callback (proxy transform sync); bake may omit. */
  applyProxyTransform?: (proxyId: string, proxy: any) => void;
}

export interface Live2DDisposeOptions {
  mode: 'soft-detach' | 'destroy';
  /** Destroy with texture/baseTexture cleanup (VRAM refcount == 0). */
  keepTextures?: boolean;
  /** Remove the model from its parent container first. */
  detach?: boolean;
}

export interface Live2DFocusInput {
  focusX: number;
  focusY: number;
  duration?: number;
  options?: Live2DFocusOptions;
}

export interface Live2DFocusOptions {
  fromX?: number;
  fromY?: number;
  elapsed?: number;
  ease?: string;
}

export interface Live2DRuntimeModelControls {
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
  ): Promise<void>;
  setInjectedParameter(model: any, paramName: string, value: number): void;
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
  flushIdleState(model: any): Promise<void>;
  /** Hard reset to idle: stop motions/expressions, restore idle pose, reset focus. */
  resetModelToIdle(model: any, options?: Live2DModelResetOptions): Promise<void>;
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
  ): Promise<Live2DMotionStartResult>;
  /**
   * Internal sampling seam for the engine's own motion-curve cache pre-warm
   * and authoring helpers (resolve-to-opaque-targets; not a pass-through).
   */
  getMotionSamplingTargets(model: any): readonly Cubism2MotionSamplerTarget[];
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
  /** Isolate the mask render buffer for one concrete model (multi-model fix). */
  isolateMask(model: any): void;
  /** Install the Cubism 2 bake render/GL guards BEFORE the first render. */
  installBakeRenderGuards(model: any): void;
  setBlink(model: any, enabled: boolean, intervalMs?: number, sceneTimeSeconds?: number, startTimeSeconds?: number, intervalRangeMs?: number): void;
  applyFocus(model: any, input: Live2DFocusInput): void;
  /** Internal handle seam for engine-side GSAP tween lifecycle around focus. */
  getFocusControllers(model: any): any[];
  /** Read the authored head hit-area anchor (model.json layout data). */
  getHeadAnchor(model: any): { x: number; y: number } | null;
}

export type MutableNumericArrayLike = {
  length: number;
  [index: number]: number;
  set?: (values: ArrayLike<number>) => void;
};

export interface Live2DRuntimeAdapter {
  id: Live2DAdapterId;
  supported: boolean;
  init(): Promise<void>;
  isReady(): boolean;
  getModelClass(): any;
  getConfig(): any;
  getControls(): Live2DRuntimeModelControls;
  createModelHandle(id: string, model: any, runtime?: Live2DRuntimeDescriptor): Live2DModelHandle;
  createModel(modelUrl: string, options: Live2DModelCreateOptions): Promise<any>;
  getUnsupportedMessage(modelPath: string): string | null;
  /** Opaque SDK time handle for the monotonic-clock discipline (null when absent). */
  getClock(): Live2DRuntimeClock | null;
  /** Placeholder model used when a Cubism 2 load fails (adapter-owned mock shape). */
  createFallbackModel(renderer?: any): any;
  /** Release the adapter-owned bake RenderTexture. */
  disposeBakeRenderTexture(): void;
}
