/**
 * Live2DConfig — Types, constants, and utilities for Live2D model management.
 */

import type { CharacterConfig } from '../api/types/character';
import type { CharacterMotionOutput } from '../api/types/semantic-scene';
import type { Live2DAdapterId, Live2DRuntimeDescriptor } from './Live2DRuntimeResolver';
import type { Live2DModelHandle } from './live2d/runtime/Live2DRuntimeControlModule';
import { readPartOpacities } from './live2d/runtime/Cubism2PartOpacity';

export const STAGE_WIDTH = 1920;
export const STAGE_HEIGHT = 1080;

// Robust FIFO queue-based mutex protecting UtSystem.setUserTimeMSec() spoofing.
// Only ONE character (across Live2DManager AND BakeEngine) may manipulate
// the shared Cubism SDK clock at a time.
interface MutexRequest {
  resolve: () => void;
}

const lockQueue: MutexRequest[] = [];
let isLocked = false;
let criticalDepth = 0;

export function acquireUtSystemLock(): Promise<void> {
  if (!isLocked) {
    isLocked = true;
    criticalDepth++;
    return Promise.resolve();
  }
  return new Promise<void>(resolve => {
    lockQueue.push({
      resolve: () => {
        criticalDepth++;
        resolve();
      },
    });
  });
}

export function releaseUtSystemLock(): void {
  criticalDepth = Math.max(0, criticalDepth - 1);
  const next = lockQueue.shift();
  if (next) {
    next.resolve();
  } else {
    isLocked = false;
  }
}

export function isUtSystemLockActive(): boolean {
  return criticalDepth > 0;
}

/**
 * Standard Cubism 2 parameter names and their idle default values.
 * The Cubism 2 SDK (Live2DModelWebGL) does NOT have getParamCount()/getParamDefault(),
 * so we must use string-based setParamFloat via getParamIndex.
 */
export const CUBISM2_DEFAULT_PARAMS: Record<string, number> = {
  'PARAM_ANGLE_X': 0, 'PARAM_ANGLE_Y': 0, 'PARAM_ANGLE_Z': 0,
  'PARAM_EYE_L_OPEN': 1, 'PARAM_EYE_R_OPEN': 1,
  'PARAM_EYE_BALL_X': 0, 'PARAM_EYE_BALL_Y': 0,
  'PARAM_EYE_BALL_FORM': 0,
  'PARAM_BROW_L_X': 0, 'PARAM_BROW_L_Y': 0, 'PARAM_BROW_L_ANGLE': 0,
  'PARAM_BROW_R_X': 0, 'PARAM_BROW_R_Y': 0, 'PARAM_BROW_R_ANGLE': 0,
  'PARAM_BROW_L_FORM': 0, 'PARAM_BROW_R_FORM': 0,
  'PARAM_MOUTH_OPEN_Y': 0, 'PARAM_MOUTH_FORM': 1,
  'PARAM_BODY_ANGLE_X': 0, 'PARAM_BODY_ANGLE_Y': 0, 'PARAM_BODY_ANGLE_Z': 0,
  'PARAM_BREATH': 0,
  'PARAM_ARM_L_A': 0, 'PARAM_ARM_R_A': 0, 'PARAM_ARM_L_B': 0, 'PARAM_ARM_R_B': 0,
  'PARAM_ARM_L': 0, 'PARAM_ARM_R': 0,
  'ParamArmLA': 0, 'ParamArmRA': 0, 'ParamArmLB': 0, 'ParamArmRB': 0,
  'ParamArmL': 0, 'ParamArmR': 0,
  'PARAM_ARM_L_CHANGE': 0, 'PARAM_ARM_R_CHANGE': 0,
  'PARAM_ARM_L_01_001': 0, 'PARAM_ARM_L_01_002': 0, 'PARAM_ARM_L_01_003': 0,
  'PARAM_ARM_R_01_001': 0, 'PARAM_ARM_R_01_002': 0, 'PARAM_ARM_R_01_003': 0,
  'PARAM_ARM_R_FOR_ADJUSTMENT': 0, 'PARAM_ARM_L_FOR_ADJUSTMENT': 0,
  'PARAM_HAND_L': 0, 'PARAM_HAND_R': 0,
  'ParamHandL': 0, 'ParamHandR': 0,
  'PARAM_HAND_L_01_001': 0, 'PARAM_HAND_L_02_001': 0, 'PARAM_HAND_L_03_001': 0,
  'PARAM_HAND_L_04_001': 0, 'PARAM_HAND_L_05_001': 0, 'PARAM_HAND_L_06_001': 0,
  'PARAM_HAND_L_07_001': 0,
  'PARAM_HAND_R_01_001': 0, 'PARAM_HAND_R_02_001': 0, 'PARAM_HAND_R_03_001': 0,
  'PARAM_HAND_R_04_001': 0, 'PARAM_HAND_R_05_001': 0, 'PARAM_HAND_R_06_001': 0,
  'PARAM_HAND_R_09_001': 0,
  'PARAM_HAIR_FRONT': 0, 'PARAM_HAIR_SIDE': 0, 'PARAM_HAIR_BACK': 0, 'PARAM_HAIR_FLUFFY': 0,
  'PARAM_CHEEK': 0, 'PARAM_TEAR': 0, 'PARAM_TERE': 0,
  'PARAM_BASE_X': 0, 'PARAM_BASE_Y': 0,
};

export interface ModelSnapshot {
  params: Float32Array;
  opacities: Float32Array;
  runtimeFamily?: Live2DRuntimeDescriptor['runtimeFamily'];
  adapterId?: Live2DAdapterId;
  capturedAtSceneTime?: number;
  motion?: { key: string; startTime: number; index?: number; priority?: number; offset?: number };
  expression?: { key: string | null };
  motionState?: {
    currentGroup?: string;
    reservedGroup?: string;
    queueLength?: number;
  };
  expressionState?: {
    currentGroup?: string;
    reservedGroup?: string;
    queueLength?: number;
  };
  position?: { x: number; y: number };
  scale?: { x: number; y: number };
  rotation?: number;
  alpha?: number;
}

export function isNumericArrayLike(values: ArrayLike<unknown> | null | undefined): values is ArrayLike<number> {
  if (!values) return false;
  let sawNumber = false;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (typeof value === 'number') {
      sawNumber = true;
    } else if (value !== undefined && value !== null) {
      return false;
    }
  }
  return sawNumber;
}

export function resolveNumericArrayLike(...values: Array<ArrayLike<unknown> | null | undefined>): ArrayLike<number> | null {
  return values.find(isNumericArrayLike) ?? null;
}

export function findFirstNonFinite(values: ArrayLike<unknown> | null | undefined): number {
  if (!isNumericArrayLike(values)) return -1;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      return i;
    }
  }
  return -1;
}

function cloneNumericArray(values: ArrayLike<number>): Float32Array {
  const copy = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    copy[i] = values[i];
  }
  return copy;
}

export function describeInvalidModelSnapshot(
  snapshot: Pick<ModelSnapshot, 'params' | 'opacities'>,
): string | null {
  const invalidParam = findFirstNonFinite(snapshot.params);
  if (invalidParam !== -1) {
    return `param[${invalidParam}]`;
  }

  const invalidOpacity = findFirstNonFinite(snapshot.opacities);
  if (invalidOpacity !== -1) {
    return `opacity[${invalidOpacity}]`;
  }

  return null;
}

/**
 * Pure function: extract parameter/opacity/motion state from any Live2D model.
 * Used by both Live2DManager (live models) and BakeEngine (headless models).
 */
export function captureModelSnapshot(
  id: string,
  model: any,
  motionStartTime?: number,
): ModelSnapshot | null {
  const internalModel = (model as any).internalModel;
  if (!internalModel) return null;
  const coreModel = internalModel.coreModel;
  if (!coreModel) return null;

  const params = resolveNumericArrayLike(
    internalModel.parameterValues,
    internalModel.getParameterValues?.(),
    coreModel.getParameterValues?.(),
    coreModel.paramValues,
    coreModel._$5S?._$_2,
  );

  const opacities = readPartOpacities(internalModel);

  if (!params) {
    console.warn(`[Live2D] Failed to resolve parameter array for "${id}".`);
    return null;
  }

  const mm = internalModel.motionManager;
  let motionInfo: any = undefined;
  if (mm && mm.state && mm.state.currentGroup) {
    motionInfo = {
      key: mm.state.currentGroup,
      startTime: motionStartTime ?? 0,
    };
  }

  const paramsSlice = cloneNumericArray(params);
  const opacitiesSlice = opacities ? cloneNumericArray(opacities) : new Float32Array();
  const invalidSnapshotField = describeInvalidModelSnapshot({
    params: paramsSlice,
    opacities: opacitiesSlice,
  });
  if (invalidSnapshotField) {
    console.warn(`[Live2D] Refusing to capture invalid snapshot for "${id}" (${invalidSnapshotField} is not finite).`);
    return null;
  }

  let isDefault = true;
  for (let i = 0; i < paramsSlice.length; i++) {
    if (paramsSlice[i] !== 0) { isDefault = false; break; }
  }
  if (isDefault) console.warn(`%c[Snapshot] Captured T-pose (all zeros) for ${id} at ${motionStartTime}`, 'color: orange');

  return {
    params: paramsSlice,
    opacities: opacitiesSlice,
    motion: motionInfo,
    position: { x: model.x, y: model.y },
    scale: { x: model.scale.x, y: model.scale.y },
    rotation: model.rotation,
    alpha: model.alpha,
  };
}

export interface CharacterEntry {
  id: string;
  model: any;
  modelPath: string;
  modelUrl: string;
  runtime: Live2DRuntimeDescriptor;
  adapterId: Live2DAdapterId;
  runtimeHandle?: Live2DModelHandle;
  config: CharacterConfig;
  injectedParams: Record<string, number>;
  /**
   * Parameter ids currently owned by the active real-time lip-sync effect
   * channel. Per ADR-0029 lip sync keeps running in its own stage while a
   * custom motion evaluates, so the motion must not overwrite or release
   * these until the channel releases ownership.
   */
  lipSyncParameterIds: Set<string>;
  /**
   * Lip-sync channel ids waiting for ownership handoff. When the channel
   * releases (`clearLipSyncParameters`), the ids land here so the frame-end
   * re-injection loop can apply the closing values once and then drop them
   * from injectedParams — otherwise the stale channel values would be
   * re-written every frame and permanently mask any later owner (e.g. a
   * custom motion's mouth track in Motion-stage mode, ADR-0029).
   */
  pendingLipSyncRelease?: Set<string>;
  baseHeight: number;
  baseWidth?: number;
  breathTween?: gsap.core.Tween;
  motionStartTime?: number;
  motionEpoch: number;
  motionStartUtTime?: number;
  pendingMotionGroup?: string;
  lastOffset?: number;
  _pendingPlayMotion?: {
    key: string;
    priority: number;
    offset: number;
    sceneTime: number;
    skipHardReset: boolean;
    handoffSnapshot?: ModelSnapshot | null;
    reqEpoch: number;
  };
  _pendingExpression?: string | null;
  /** The latest expression intent must survive motion hard resets. */
  expressionKey?: string | null;
  _pendingLookAt?: { focusX: number; focusY: number; duration: number; options?: { fromX?: number; fromY?: number; elapsed?: number; ease?: string } };
  isCorrupted?: boolean; // NaN detected — block updates until async repair completes
  corruptionRepairPromise?: Promise<void>;
  idleSnapshot?: { params: Float32Array; opacities: Float32Array };
  pendingSeekBoundarySnapshot?: ModelSnapshot;
  pendingSeekBoundaryMotionStartTime?: number;
  pendingSeekBoundaryDuration?: number;
  lastSnapshot?: ModelSnapshot;
  lastManualTimeMs?: number; // Track last manual update time to detect large seek jumps and prevent physics overflow
  filterWarmupFrames?: number; // Avoid Pixi filter offscreen rendering on freshly reconstructed Live2D models
  lifecycleGeneration?: number;
  loadToken?: symbol;
  /** Inline custom motion currently owning the character's parameters. */
  customMotion?: CustomMotionRuntimeState;
  /** Handoff pose captured when the custom motion took over (fade-in source). */
  customMotionHandoff?: import('./live2d/customMotionRuntime').CustomMotionHandoffPose;
  /**
   * Motion-stage writer for the active custom motion. When installed, curve
   * values are written during the SDK update pass (afterMotionUpdate) so an
   * active Expression keeps compositing above them (ADR-0029); null means the
   * runtime lacks the emitter seam and the legacy post-update injection path
   * applies instead.
   */
  customMotionStage?: import('./live2d/customMotionStage').CustomMotionStageHandle | null;
}

/**
 * Runtime state of an inline custom motion that has taken over a character's
 * motion output. The newest motion (resource or custom) fully replaces the
 * previous one; the custom motion holds its tail pose until a later motion
 * takes over (ADR-0029).
 */
export interface CustomMotionRuntimeState {
  readonly motion: Extract<CharacterMotionOutput, { kind: 'custom' }>;
  /** Scene time at which the custom motion started. */
  readonly startSceneTime: number;
  /**
   * Parameter ids this custom motion currently controls. Used to release
   * control when a newer motion takes over or the state is cleared.
   */
  readonly controlledParameterIds: readonly string[];
}

/**
 * Reset a Cubism 2 coreModel's parameters to their idle defaults.
 * Prefers core.loadParam() snapshot if available; falls back to manual reset.
 */
export function resetCoreParams(core: any): void {
  if (!core) return;
  if (typeof core.loadParam === 'function') {
    try {
      core.loadParam();
      return;
    } catch (e) { /* fall through */ }
  }

  if (typeof core.getParamIndex === 'function' && typeof core.setParamFloat === 'function') {
    for (const [name, defaultVal] of Object.entries(CUBISM2_DEFAULT_PARAMS)) {
      const idx = core.getParamIndex(name);
      if (idx !== -1) core.setParamFloat(idx, defaultVal);
    }
  }
}
