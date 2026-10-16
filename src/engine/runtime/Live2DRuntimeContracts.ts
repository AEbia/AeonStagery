import type * as PIXI from 'pixi.js';
import type { TransformationProxy } from '../actions/types';
import type { Live2DAdapterId, Live2DRuntimeDescriptor } from '../Live2DRuntimeResolver';
import type { ModelSnapshot } from '../Live2DConfig';
import type { Live2DModelHandle } from '../live2d/runtime/Live2DRuntimeControlModule';
import type { PreparedAssetRef } from '../../api/types/semantic-scene';
import type { CustomMotionSamplePoint } from '../live2d/customMotionConversion';
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

/** Runtime-neutral curve returned by an isolated resource-motion evaluation. */
export interface Live2DMotionSampledCurve {
  readonly parameterId: string;
  readonly samples: readonly CustomMotionSamplePoint[];
}

export interface Live2DMotionSamplingOptions {
  readonly fps: number;
  /** Keep source fades in the metadata instead of baking them into values. */
  readonly zeroSourceFades?: boolean;
  /** Best-effort cache sampling may ignore parameters absent from the model. */
  readonly skipMissingParameters?: boolean;
}

export interface Live2DMotionSamplingMetadata {
  readonly durationSeconds: number;
  readonly fadeInSeconds?: number;
  readonly fadeOutSeconds?: number;
  readonly hasNonParameterCurves?: boolean;
}

export interface Live2DMotionSamplingResult {
  readonly status: 'sampled' | 'unsupported';
  readonly metadata?: Live2DMotionSamplingMetadata;
  readonly curves?: readonly Live2DMotionSampledCurve[];
  /** Cubism 3+ retains native curve segments in this neutral parsed form. */
  readonly motion?: Extract<import('../../api/types/semantic-scene').CharacterMotionOutput, { kind: 'custom' }>;
  readonly diagnostics?: readonly string[];
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
  /** A model bound to its adapter's complete runtime behaviors. */
  handle: Live2DModelHandle;
  runtimeFamily: Live2DPerformanceRuntimeFamily;
}

export interface Live2DModelCreateOptions {
  autoHitTest?: boolean;
  autoFocus?: boolean;
  autoUpdate?: boolean;
  idleMotionGroup?: string;
}

/** Display-only surface required by Stage and Bake resource owners. */
export type Live2DModelDisplayObject = PIXI.Container & {
  anchor: PIXI.ObservablePoint;
  autoUpdate?: boolean;
  tint?: number;
};

/** Strongest deterministic motion guarantee an adapter can make. */
export type Live2DDeterminismTier =
  | 'parameter-deterministic'
  | 'offset-replay-deterministic'
  | 'native-offset-deterministic'
  | 'state-replay-deterministic'
  | 'unsupported';

export interface Live2DDeterminismCapabilities {
  readonly tier: Live2DDeterminismTier;
  /** Pure parameter curves can be evaluated from absolute scene time. */
  readonly supportsParameterCurves: boolean;
  /** Native motion queues accept an authored offset without clock replay. */
  readonly supportsNativeMotionOffset: boolean;
  /** Motion offsets can be reached by fixed-step shared SDK clock replay. */
  readonly supportsMotionOffsetReplay: boolean;
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

export type Live2DSeekRestoreTier = 'native' | 'state-replay' | 'snapshot-forward' | 'visual-freeze' | 'unsupported';

export interface Live2DSeekRestoreInput {
  id: string;
  snapshot?: ModelSnapshot | null;
  /** Pose owned by the previous action at the new motion's start boundary. */
  handoffSnapshot?: ModelSnapshot | null;
  targetSceneTime: number;
  /** Normalized Cubism focus at the target scene time, restored before state replay. */
  focus?: readonly [number, number];
  motion?: Live2DSeekMotionState | null;
  expression?: Live2DSeekExpressionState | null;
  idleSnapshot?: Pick<ModelSnapshot, 'params' | 'opacities'> | null;
  isScrubbing?: boolean;
  preserveMotionForPlayback?: boolean;
  /** Revalidated by the bound behavior after each asynchronous operation. */
  isCurrent?: () => boolean;
}

export interface Live2DSeekRestoreResult {
  status: 'restored' | 'fallback' | 'unsupported' | 'cancelled';
  tierUsed: Live2DSeekRestoreTier;
  diagnostics?: string[];
}

export interface Live2DPerformanceTransitionInput {
  motionKey: string;
  priority: number;
  offsetSeconds: number;
  sceneTimeSeconds: number;
  fadeInSeconds?: number;
  clearQueueFirst?: boolean;
  handoffSnapshot?: ModelSnapshot | null;
  finalSnapshot?: ModelSnapshot | null;
  expressionKey?: string | null;
  restoreHandoffBoundary?: boolean;
  isCurrent: () => boolean;
}

export interface Live2DPerformanceTransitionResult {
  status: 'started' | 'missing' | 'cancelled';
  offsetReplayMs: number;
  retainedHandoffBoundary?: boolean;
}

export interface Live2DSeekMotionOffsetInput {
  offsetSeconds: number;
  handoffBoundarySnapshot?: ModelSnapshot | null;
  isCurrent: () => boolean;
}

export interface Live2DSeekMotionOffsetResult {
  status: 'advanced' | 'cancelled' | 'unsupported';
  retainedHandoffBoundary?: boolean;
}

export interface Live2DFrameSubmissionInput {
  deltaMs: number;
  /** Absolute authored time for deterministic effect channels. */
  sceneTimeSeconds?: number;
  shouldAdvance: boolean;
  forceZeroDeltaCommit?: boolean;
  forceStep?: boolean;
  manualTimeMs?: number;
  injectedParameters?: Readonly<Record<string, number>>;
  handoffBoundarySnapshot?: ModelSnapshot | null;
  isCurrent?: () => boolean;
}

/** One bound model's complete Bake frame request; SDK update/render ordering stays adapter-owned. */
export interface Live2DBakeFrameInput {
  deltaMs: number;
  sceneTimeSeconds?: number;
  renderer?: PIXI.Renderer;
  label?: string;
  flushCore?: boolean;
  isCurrent: () => boolean;
}

/** Optional one-time native transition performed before a coordinated Bake frame. */
export type Live2DBakeMotionStartInput = Omit<Live2DPerformanceTransitionInput, 'isCurrent'>;

export interface Live2DBakeFrameOperation {
  readonly handle: Live2DModelHandle;
  readonly isCurrent: () => boolean;
  readonly renderer?: PIXI.Renderer;
  readonly flushCore?: boolean;
  readonly sceneTimeSeconds?: number;
  /** Bound state preparation performed under the batch's shared clock transaction. */
  readonly resetRuntimeState?: Live2DRuntimeResetInput;
  /** Apply a previously captured pose under the batch's shared clock transaction. */
  readonly restoreSnapshot?: ModelSnapshot;
  /** Omit the frame step for state-only restore/reset batches. Defaults to true. */
  readonly submitFrame?: boolean;
  readonly stopMotion?: boolean;
  readonly expression?: string | null;
  readonly expressionState?: Live2DSeekExpressionState & { readonly previousKey?: string | null };
  readonly motionStart?: Live2DBakeMotionStartInput;
  readonly resetForPlayback?: {
    readonly idleSnapshot: ModelSnapshot;
    readonly restartIdleMotion: boolean;
  };
}

export interface Live2DBakeFrameBatchInput {
  readonly operations: readonly Live2DBakeFrameOperation[];
  readonly deltaMs: number;
  readonly advanceClock?: boolean;
  readonly isCurrent: () => boolean;
}

export interface Live2DBakeFrameBatchResult {
  readonly status: 'submitted' | 'cancelled';
  readonly transitions: ReadonlyMap<string, Live2DPerformanceTransitionResult>;
}

export interface Live2DFrameSubmissionResult {
  status: 'submitted' | 'deferred' | 'cancelled';
  retainedHandoffBoundary?: boolean;
}

export type Live2DFocusAnimationAction = 'stop' | 'pause' | 'resume';

/** Neutral entrance pose; composite snapshots describe the main model. */
export type Live2DIdleBaseline = Pick<ModelSnapshot, 'params' | 'opacities'>;

export type Live2DInitializationInput = {
  isCurrent: () => boolean;
} & ({ mode: 'live' } | { mode: 'bake'; renderer: PIXI.Renderer });

export type Live2DInitializationResult =
  | { status: 'ready'; idleSnapshot: Live2DIdleBaseline | null }
  | { status: 'cancelled' };

export interface Live2DRuntimeSourceBinding {
  mode: 'live' | 'bake';
  isExportMode?: boolean;
  /** Retain this live source; its injectedParams property may be replaced. */
  injectedParamsSource: { injectedParams: Record<string, number> };
  applyProxyTransform?: (proxyId: string, proxy: Partial<TransformationProxy>) => void;
  isCurrent: () => boolean;
}

export interface Live2DRuntimeResetInput {
  /** Pose handoff can retain a newly enqueued performance. */
  stopPlayback?: boolean;
  pose?: 'preserve' | 'neutral' | 'idle';
  idleSnapshot?: Live2DIdleBaseline | null;
  clearExpression?: boolean;
  keepFocus?: boolean;
}

export interface Live2DModelResetOptions {
  keepFocus?: boolean;
  idleSnapshot?: Pick<ModelSnapshot, 'params' | 'opacities'> | null;
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
  /** Full authored transition duration, including options.elapsed. */
  duration?: number;
  options?: Live2DFocusOptions;
}

export interface Live2DFocusOptions {
  fromX?: number;
  fromY?: number;
  elapsed?: number;
  ease?: string;
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
  createModelHandle(id: string, model: object, runtime?: Live2DRuntimeDescriptor): Live2DModelHandle;
  createModel(modelUrl: string, options: Live2DModelCreateOptions): Promise<Live2DModelDisplayObject>;
  getUnsupportedMessage(modelPath: string): string | null;
  /** Adapter-owned display placeholder for a failed supported model load. */
  createFallbackModel(renderer?: PIXI.Renderer): Live2DModelDisplayObject | null;
  /** Release the adapter-owned bake RenderTexture. */
  disposeBakeRenderTexture(): void;
}
