import * as PIXI from 'pixi.js';
import gsap from 'gsap';
import type { Live2DAdapterId, Live2DRuntimeDescriptor } from './Live2DRuntimeResolver';
import { getUnsupportedLive2DRuntimeMessage, isLive2DCubism2RuntimeAvailable } from './Live2DRuntimeResolver';
import type { ModelSnapshot } from './Live2DConfig';
import {
  acquireUtSystemLock,
  CUBISM2_DEFAULT_PARAMS,
  captureModelSnapshot,
  findFirstNonFinite,
  releaseUtSystemLock,
  resetCoreParams,
  resolveNumericArrayLike,
} from './Live2DConfig';
import type { Live2DParameterMetadata } from '../api/types/live2d-parameter-animation';
import { getOfficialCubismSdkStatus, initOfficialCubismWebSdk } from './OfficialCubismWebSdk';
import { waitForLive2DRuntimeBootstrap } from './Live2DRuntimeAvailability';
import {
  createLive2DModelHandle,
  type Live2DModelHandle,
} from './live2d/runtime/Live2DRuntimeControlModule';
import { Cubism2NativeMotionSession, stepMotionQueuesAt } from './live2d/Cubism2NativeMotionSession';
import { Cubism2BakeRenderCore } from './live2d/runtime/Cubism2BakeRenderCore';
import { guardExternalGl } from './live2d/runtime/Cubism2RenderGuardSeam';
import { readPartOpacities, writePartOpacities } from './live2d/runtime/Cubism2PartOpacity';
import type { Cubism2MotionSamplerTarget } from './live2d/cubism2MotionSampler';
import {
  installCustomMotionStage,
  type CustomMotionStageHandle,
  type InstallCustomMotionStageInput,
} from './live2d/customMotionStage';
import { createBlinkControlState, evaluateBlinkMultiplier } from './live2d/blinkController';
import {
  applyBakeBreathingFix,
  applyBehaviorFixes,
  applyParameterOverride,
  applyRenderHook,
  findMaskSprite,
} from './Live2DModelSetup';
import { loadLive2DEngineModule } from './Live2DEngineBridge';

export interface Live2DModelCreateOptions {
  autoHitTest?: boolean;
  autoFocus?: boolean;
  autoUpdate?: boolean;
  idleMotionGroup?: string;
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
   * Returns null when no target has the emitter seam (official runtime).
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

type MutableNumericArrayLike = {
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

type Cubism2Module = {
  Live2DModel?: any;
  config?: any;
};

type Cubism2ModuleLoader = () => Promise<Cubism2Module>;

const defaultCubism2RuntimeDescriptor: Live2DRuntimeDescriptor = {
  runtimeFamily: 'cubism2',
  adapterId: 'pixi-live2d-display-cubism2',
  supported: true,
};

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Resolve the authored head hit-area anchor from model.json layout data.
 * Identical math for both runtime adapters (cubism2 and official web), so it
 * lives once here instead of being duplicated in each controls
 * implementation. Returns null when the model exposes no usable head
 * hit-area/layout.
 */
export function resolveHeadAnchorFromSettings(settings: any): { x: number; y: number } | null {
  const hitAreas = settings?.hit_areas_custom;
  const headX = hitAreas?.head_x;
  const headY = hitAreas?.head_y;
  if (!Array.isArray(headX) || headX.length < 2 || !Array.isArray(headY) || headY.length < 2) {
    return null;
  }

  const left = Number(headX[0]);
  const right = Number(headX[1]);
  const top = Number(headY[0]);
  const bottom = Number(headY[1]);
  if (![left, right, top, bottom].every(Number.isFinite)) return null;

  const layout = settings?.layout || {};
  const layoutCenterX = Number(layout.center_x ?? 0);
  const layoutCenterY = Number(layout.center_y ?? 0);
  const layoutWidth = Number(layout.width ?? 0);
  const scale = layoutWidth > 0 ? layoutWidth : 0;
  if (!(scale > 0)) return null;

  return {
    x: 0.5 + (((left + right) * 0.5) - layoutCenterX) / scale,
    y: 0.5 - (((top + bottom) * 0.5) - layoutCenterY) / scale,
  };
}

function normalizeParameterId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof (value as { id?: unknown }).id === 'string') {
    const id = (value as { id: string }).id;
    if (id.trim()) return id;
  }
  if (value && typeof (value as { getString?: unknown }).getString === 'function') {
    const resolved = (value as { getString: () => unknown }).getString();
    if (typeof resolved === 'string' && resolved.trim()) return resolved;
  }
  return undefined;
}

function getCubism2ModelContext(coreModel: any): any | null {
  try {
    return coreModel?.getModelContext?.() ?? coreModel?._$5S ?? null;
  } catch {
    return coreModel?._$5S ?? null;
  }
}

/**
 * Cubism 2 model.json does not carry a parameter table. pixi-live2d-display
 * therefore exposes the authoritative IDs through the core model (or its
 * private parameter-id array), while tests and older wrappers may only expose
 * settings.parameters. Keep all supported shapes at this adapter boundary so
 * handoff snapshots use the same IDs as authored custom-motion tracks.
 */
function resolveCubism2ParameterId(
  coreModel: any,
  settings: any,
  index: number,
  modelContext: any = getCubism2ModelContext(coreModel),
): string {
  const direct = [
    () => coreModel?.getParamId?.(index),
    () => coreModel?.getParamID?.(index),
    () => coreModel?.getParameterId?.(index),
    () => coreModel?.getParamIds?.()?.[index],
    () => coreModel?.getParameterIds?.()?.[index],
    () => modelContext?._$pb?.[index],
  ];
  for (const read of direct) {
    try {
      const id = normalizeParameterId(read());
      if (id) return id;
    } catch {
      // Try the next runtime representation.
    }
  }

  const setting = settings?.parameters?.[index];
  return normalizeParameterId(setting?.name)
    ?? normalizeParameterId(setting?.id)
    ?? normalizeParameterId(setting?.parameterId)
    ?? `Param_${index}`;
}

export class Cubism2PixiLive2DModelControls implements Live2DRuntimeModelControls {
  private readonly expressionRequestEpochs = new WeakMap<object, number>();
  private readonly maskSizeProvider: () => number;
  private readonly bakeCore: Cubism2BakeRenderCore | null;
  private readonly clockProvider: () => Live2DRuntimeClock | null;
  private readonly nativeMotionSession = new Cubism2NativeMotionSession();

  constructor(context: {
    maskSize?: () => number;
    bakeCore?: Cubism2BakeRenderCore;
    clock?: () => Live2DRuntimeClock | null;
  } = {}) {
    this.maskSizeProvider = context.maskSize ?? (() => 1024);
    this.bakeCore = context.bakeCore ?? null;
    // Default falls back to the legacy SDK global so directly-constructed
    // controls (tests/diagnostics) keep the historical clock access. The
    // real adapter wires this to its own getClock() handle so the SDK clock
    // is always reached through the same opaque seam.
    this.clockProvider = context.clock ?? (() => {
      if (typeof window === 'undefined') return null;
      const utSystem = (window as any).UtSystem;
      return utSystem && typeof utSystem.getUserTimeMSec === 'function' ? utSystem : null;
    });
  }

  /**
   * Resolve the authored idle motion group name ('idle' preferred over
   * 'Idle') when the runtime exposes one, else null. Shared by the load-time
   * flush, the idle restart and the hard reset so the detection exists once.
   */
  private resolveIdleMotionGroup(internalModel: any): string | null {
    const motions = internalModel?.settings?.motions;
    if (!motions) return null;
    return motions['idle'] ? 'idle' : motions['Idle'] ? 'Idle' : null;
  }

  getConcreteModels(model: any): any[] {
    if (!model) return [];
    if (typeof model.getAllModels === 'function') {
      try {
        const concrete = model.getAllModels();
        if (Array.isArray(concrete) && concrete.length > 0) {
          return concrete.filter(Boolean);
        }
      } catch {
        // Fall back to the wrapper model itself.
      }
    }
    return [model];
  }

  private supersedeExpressionRequest(expressionManager: object): number {
    const epoch = (this.expressionRequestEpochs.get(expressionManager) ?? 0) + 1;
    this.expressionRequestEpochs.set(expressionManager, epoch);
    return epoch;
  }

  private isCurrentExpressionRequest(expressionManager: object, epoch: number): boolean {
    return this.expressionRequestEpochs.get(expressionManager) === epoch;
  }

  getCoreModel(model: any): any | null {
    const internal = model?.internalModel;
    return internal?.coreModel ?? null;
  }

  describeInvalidState(model: any): string | null {
    const models = this.getConcreteModels(model);
    for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
      const target = models[modelIndex];
      const internalModel = target?.internalModel;
      const coreModel = internalModel?.coreModel;
      if (!coreModel) continue;

      const params = resolveNumericArrayLike(
        internalModel.parameterValues,
        internalModel.getParameterValues?.(),
        coreModel.getParameterValues?.(),
        coreModel.paramValues,
        coreModel._$5S?._$_2,
      );
      const invalidParamIndex = findFirstNonFinite(params);
      if (params && invalidParamIndex !== -1) {
        const label = modelIndex === 0 ? 'primary' : `submodel ${modelIndex}`;
        const paramIds = coreModel.getParamIds?.();
        const paramName = paramIds?.[invalidParamIndex] ? ` (${paramIds[invalidParamIndex]})` : '';
        return `${label} param[${invalidParamIndex}]${paramName}=${params[invalidParamIndex]}`;
      }

      const opacities = readPartOpacities(internalModel);
      const invalidOpacityIndex = findFirstNonFinite(opacities);
      if (opacities && invalidOpacityIndex !== -1) {
        const label = modelIndex === 0 ? 'primary' : `submodel ${modelIndex}`;
        return `${label} opacity[${invalidOpacityIndex}]=${opacities[invalidOpacityIndex]}`;
      }
    }

    return null;
  }

  getAvailableMotions(model: any): string[] {
    const motions = new Set<string>();
    for (const target of this.getConcreteModels(model)) {
      const settingsMotions = target?.internalModel?.settings?.motions;
      if (!settingsMotions) continue;
      for (const key of Object.keys(settingsMotions)) {
        motions.add(key);
      }
    }
    return Array.from(motions);
  }

  getAvailableExpressions(model: any): string[] {
    const expressions = new Set<string>();
    for (const target of this.getConcreteModels(model)) {
      const settingsExpressions = target?.internalModel?.settings?.expressions;
      if (!settingsExpressions) continue;
      for (const key of Object.keys(settingsExpressions)) {
        expressions.add(key);
      }
    }
    return Array.from(expressions);
  }

  getMotionDuration(model: any, motionKey: string): number {
    try {
      const internalModel = model?.internalModel;
      if (!internalModel || typeof internalModel.getMotionManager !== 'function') return 0;
      const motionManager = internalModel.getMotionManager();
      const groupIndex = motionManager.getMotionGroupIndex(motionKey);
      if (groupIndex < 0) return 0;

      const motionData = motionManager.motions?.[groupIndex];
      if (!motionData) return 0;

      const duration = motionData._duration || (motionData._endTime || 0) / 1000;
      return Math.max(0, duration);
    } catch {
      return 0;
    }
  }

  getMotionDebugState(model: any): Record<string, unknown> | null {
    const internalModel = model?.internalModel;
    const mm = internalModel?.motionManager;
    if (!mm) return null;
    const mq = mm?._motionQueueManager || mm?.motionQueue;

    return {
      currentGroup: mm?.state?.currentGroup,
      reservedGroup: mm?.state?.reservedGroup,
      playing: mm?.playing,
      isFinished: mq?.isFinished?.(),
      queueLength: (mq?.motions || mq?._motions || []).length,
      internalModel,
      motionManager: mm,
      queueManager: mq,
    };
  }

  getParameterValues(model: any): Array<{ index: number; name: string; value: number }> | null {
    const internalModel = model?.internalModel;
    const coreModel = internalModel?.coreModel;
    if (!coreModel) return null;

    const modelContext = getCubism2ModelContext(coreModel);
    const params = resolveNumericArrayLike(
      internalModel.parameterValues,
      internalModel.getParameterValues?.(),
      coreModel.getParameterValues?.(),
      coreModel.paramValues,
      modelContext?._$_2,
    );
    if (!params) return null;

    const settings = internalModel.settings;
    const contextParameterCount = modelContext?._$qo;
    const parameterCount = Number.isInteger(contextParameterCount) && contextParameterCount >= 0
      ? Math.min(params.length, contextParameterCount)
      : params.length;
    const values: Array<{ index: number; name: string; value: number }> = [];
    for (let i = 0; i < parameterCount; i++) {
      values.push({
        index: i,
        name: resolveCubism2ParameterId(coreModel, settings, i, modelContext),
        value: params[i],
      });
    }
    return values;
  }

  getParameterMetadata(model: any): readonly Live2DParameterMetadata[] | null {
    const values = this.getParameterValues(model);
    if (!values) return null;
    const settings = model?.internalModel?.settings;
    return values.map((parameter) => {
      const setting = settings?.parameters?.[parameter.index] ?? {};
      const knownDefault = CUBISM2_DEFAULT_PARAMS[parameter.name];
      return {
        id: parameter.name,
        index: parameter.index,
        label: typeof setting.label === 'string' ? setting.label : undefined,
        min: finiteOrUndefined(setting.min),
        max: finiteOrUndefined(setting.max),
        defaultValue: finiteOrUndefined(setting.defaultValue) ?? knownDefault,
        source: knownDefault !== undefined ? 'known-cubism2-default' : 'runtime',
      };
    });
  }

  clearMotionState(model: any): void {
    for (const target of this.getConcreteModels(model)) {
      const motionManager = target?.internalModel?.motionManager;
      if (!motionManager) continue;
      // Clearing the bookkeeping fields alone is not enough: the Cubism 2
      // MotionQueueManager keeps its own entry list (`_motions`) and keeps
      // writing the queued curves every update. Stop it, then clear the state
      // so a later restart decision cannot mistake the stopped motion for the
      // one that is currently playing.
      motionManager.stopAllMotions?.();
      motionManager._motionQueueManager?.stopAllMotions?.();
      motionManager.playing = false;
      if (motionManager.state) {
        motionManager.state.currentGroup = undefined;
        motionManager.state.reservedGroup = undefined;
        motionManager.state.queue = [];
      }
    }
  }

  stopAllMotions(model: any): void {
    for (const target of this.getConcreteModels(model)) {
      const motionManager = target?.internalModel?.motionManager;
      if (!motionManager) continue;
      motionManager.stopAllMotions?.();
      motionManager._motionQueueManager?.stopAllMotions?.();
      if (motionManager.state) {
        motionManager.state.currentGroup = undefined;
        motionManager.state.reservedGroup = undefined;
        motionManager.state.queue = [];
      }
    }
  }

  async preloadMotion(model: any, motionKey: string): Promise<void> {
    const tasks = this.getConcreteModels(model).map((target) => {
      const internalModel = target?.internalModel;
      const motionManager = internalModel?.motionManager;
      const motions = internalModel?.settings?.motions || {};
      if (!motionManager || !motions[motionKey]) return Promise.resolve();
      return motionManager.loadMotion(motionKey, 0);
    });
    await Promise.allSettled(tasks);
  }

  setExpression(model: any, expressionName: string | null): void {
    const targets = this.getConcreteModels(model);

    if (!expressionName) {
      for (const target of targets) {
        const internalModel = target?.internalModel as any;
        const expMgr = internalModel?.motionManager?.expressionManager;
        // A destroyed manager is already torn down: poking its internals is
        // pointless and can race the SDK's own teardown.
        if (!expMgr || expMgr.destroyed) continue;

        this.supersedeExpressionRequest(expMgr);
        expMgr.queueManager?.stopAllMotions?.();
        expMgr._motionQueueManager?.stopAllMotions?.();
        if (expMgr.defaultExpression) expMgr.currentExpression = expMgr.defaultExpression;
        expMgr.reserveExpressionIndex = -1;
        expMgr._currentExpression = null;
        expMgr.activeExpression = null;
        if (expMgr._motions) expMgr._motions = [];
        if (expMgr.motions) expMgr.motions = [];
        if (expMgr.state) {
          expMgr.state.currentGroup = undefined;
          expMgr.state.reservedGroup = undefined;
        }
        if (expMgr._motionQueueManager) {
          expMgr._motionQueueManager.stopAllMotions?.();
          if (expMgr._motionQueueManager._motions) expMgr._motionQueueManager._motions = [];
        }
      }
      return;
    }

    for (const target of targets) {
      const internalModel = target?.internalModel;
      const expMgr = internalModel?.motionManager?.expressionManager;
      // A manager that was destroyed is already torn down (caches nulled):
      // touching it would throw — or worse, write into freed state asynchronously
      // — and the SDK's own rejection must not escape here. Without any manager
      // the legacy delegation below is a no-op in the SDK, so keep calling it
      // for API parity.
      if (expMgr) {
        if (expMgr.destroyed) continue;
        this.supersedeExpressionRequest(expMgr);
      }
      const expressionIndex = expMgr?.getExpressionIndex?.(expressionName) ?? -1;
      const currentIndex = Array.isArray(expMgr?.expressions)
        ? expMgr.expressions.indexOf(expMgr.currentExpression)
        : -1;

      // pixi-live2d-display ignores setExpression() when the requested key is
      // already current. Motion startup has queued the default expression at
      // this point, so explicitly restore the current expression instead.
      if (expressionIndex >= 0 && expressionIndex === currentIndex && typeof expMgr?.restoreExpression === 'function') {
        expMgr.restoreExpression();
      } else {
        // The SDK expression pipeline is async (XHR fetch + fade queue) and
        // can reject with an abort/TypeError when the model is destroyed
        // mid-load. This call site is intentionally fire-and-forget, so the
        // promise must never escape as an unhandled rejection.
        const pending = target?.expression?.(expressionName);
        if (pending && typeof (pending as Promise<unknown>).catch === 'function') {
          (pending as Promise<unknown>).catch(() => {
            /* teardown aborts are expected and already logged by the SDK */
          });
        }
      }
    }
  }

  async setExpressionForSeek(
    model: any,
    expressionName: string | null,
    elapsedSeconds: number,
    /**
     * Expression that was in effect immediately before the target's start time.
     * `null` means "none" (the seek target has no predecessor in the scene);
     * `undefined` means "unknown" and falls back to the model's live entry.
     */
    previousExpressionKey?: string | null,
  ): Promise<void> {
    const prepared = await Promise.all(this.getConcreteModels(model).map(async (target) => {
      const internalModel = target?.internalModel;
      const coreModel = internalModel?.coreModel;
      const expressionManager = internalModel?.motionManager?.expressionManager;
      if (!coreModel || target?.destroyed || expressionManager?.destroyed) return null;
      if (!expressionManager) {
        // Models without expressions still need the restored pose committed
        // to their drawable geometry. v8 skips internalModel.update when the
        // accumulated delta is zero. Use the same minimal deferred flush as
        // the expression path below, inside the vendor's guarded render pass.
        target.update?.(0.001);
        return null;
      }
      const requestEpoch = this.supersedeExpressionRequest(expressionManager);

      expressionManager.queueManager?.stopAllMotions?.();
      expressionManager._motionQueueManager?.stopAllMotions?.();
      expressionManager.reserveExpressionIndex = -1;

      if (!expressionName) {
        if (expressionManager.defaultExpression) {
          expressionManager.currentExpression = expressionManager.defaultExpression;
        }
        return { target, expressionManager, expression: null, previousExpression: null, previousKnown: true, requestEpoch };
      }

      const index = expressionManager.getExpressionIndex?.(expressionName) ?? -1;
      if (index < 0 || typeof expressionManager.loadExpression !== 'function') {
        if (expressionManager.defaultExpression) {
          expressionManager.currentExpression = expressionManager.defaultExpression;
        }
        return { target, expressionManager, expression: null, requestEpoch };
      }

      let expression: unknown;
      try {
        expression = await expressionManager.loadExpression(index);
      } catch {
        // Teardown aborted the load (destroy() cancels the in-flight XHR and
        // nulls the manager's caches, so the SDK's own continuation can also
        // fail). The seek target is moot — drop it like the superseded
        // request path below.
        return null;
      }
      // The model may have been destroyed while the expression fetch was in
      // flight; the manager's caches are gone by now.
      if (expressionManager.destroyed) return null;
      if (!this.isCurrentExpressionRequest(expressionManager, requestEpoch)) return null;
      // A fire-and-forget expression request issued by motion restoration may
      // have shared this load. Invalidate its reservation again after await so
      // it cannot enqueue an older expression after this seek target.
      expressionManager.reserveExpressionIndex = -1;
      expressionManager.queueManager?.stopAllMotions?.();
      expressionManager._motionQueueManager?.stopAllMotions?.();
      if (!expression && expressionManager.defaultExpression) {
        expressionManager.currentExpression = expressionManager.defaultExpression;
      }
      // Resolve the predecessor the seeked frame must blend out of. Taking the
      // model's live `currentExpression` reads whatever the previous playback
      // position left behind — including an expression that only exists later
      // in the scene — which is exactly the stale data a seek must not reuse.
      const previousKnown = previousExpressionKey !== undefined;
      let previousExpression: unknown = null;
      if (previousKnown && previousExpressionKey && previousExpressionKey !== expressionName) {
        const previousIndex = expressionManager.getExpressionIndex?.(previousExpressionKey) ?? -1;
        if (previousIndex >= 0) {
          try {
            previousExpression = await expressionManager.loadExpression(previousIndex);
          } catch {
            previousExpression = null;
          }
          if (expressionManager.destroyed) return null;
          if (!this.isCurrentExpressionRequest(expressionManager, requestEpoch)) return null;
          // Re-clear the queue: the predecessor's own load may have queued it.
          expressionManager.reserveExpressionIndex = -1;
          expressionManager.queueManager?.stopAllMotions?.();
          expressionManager._motionQueueManager?.stopAllMotions?.();
        }
      }
      return {
        target,
        expressionManager,
        expression: expression ?? null,
        previousExpression,
        previousKnown,
        requestEpoch,
      };
    }));

    const targets = prepared.filter((target): target is NonNullable<typeof target> => !!target);
    if (targets.length === 0) return;

    await acquireUtSystemLock();
    try {
      const currentTargets = targets.filter(({ target, expressionManager, requestEpoch }) => (
        !target?.destroyed
        && !expressionManager.destroyed
        && this.isCurrentExpressionRequest(expressionManager, requestEpoch)
      ));
      if (currentTargets.length === 0) return;

      const utSystem = typeof window !== 'undefined' ? (window as any).UtSystem : undefined;
      const nowMs = utSystem?.getUserTimeMSec?.() ?? performance.now();
      const elapsedMs = Number.isFinite(elapsedSeconds)
        ? Math.max(0, elapsedSeconds) * 1000
        : 24 * 60 * 60 * 1000;
      try {
        const hasExpression = currentTargets.some((target) => !!target.expression);

        if (utSystem && hasExpression) {
          // Playback keeps the previous expression in the queue (pixi's
          // _setExpression never stops the old entry), so switching from A to
          // B blends A's exclusive parameters out only where B owns them, and
          // the seeked frame matches the playback frame exactly. The seek
          // reconstruction re-creates that same queue shape with two clock
          // phases: the previous expression's entry starts far enough in the
          // past to be fully faded in (weight 1, resident writer), while the
          // target expression starts at the seeked elapsed so its fade weight
          // reconstructs in-window and continues from that progress.
          const PREVIOUS_EXPRESSION_AGE_MS = 6000;
          for (const target of currentTargets) {
            if (!target.expression) continue;
            // `previousKnown` means the caller resolved the predecessor from
            // the scene: never fall back to the model's live entry, whose
            // `currentExpression` belongs to whatever position playback or the
            // previous seek left behind.
            const previous = target.previousKnown
              ? (target.previousExpression ?? null)
              : target.expressionManager.currentExpression;
            const previousIndex = Array.isArray(target.expressionManager.expressions)
              ? target.expressionManager.expressions.indexOf(previous)
              : -1;
            const previousIsLoadedExpression = !!previous
              && previous !== target.expression
              && (previousIndex >= 0
                ? target.expressionManager.definitions?.[previousIndex]?.name !== undefined
                // A runtime that does not cache loaded expressions in
                // `expressions` still produced the object we asked for.
                : previous === target.previousExpression);
            if (previousIsLoadedExpression) {
              // Phase 1: latch the previous expression's entry at a clock that
              // has its fade-in long completed, then evaluate it so the core
              // records that start time (weight becomes 1, it stays resident).
              utSystem.setUserTimeMSec(nowMs - elapsedMs - PREVIOUS_EXPRESSION_AGE_MS);
              target.expressionManager._setExpression?.(previous);
              target.expressionManager.update?.(
                target.target?.internalModel?.coreModel,
                nowMs - elapsedMs - PREVIOUS_EXPRESSION_AGE_MS,
              );
            }
            // Phase 2: latch the target expression at the seeked elapsed and
            // evaluate it so the seeked frame shows its in-progress fade.
            utSystem.setUserTimeMSec(nowMs - elapsedMs);
            target.expressionManager.currentExpression = target.expression;
            target.expressionManager._setExpression?.(target.expression);
            target.expressionManager.update?.(
              target.target?.internalModel?.coreModel,
              nowMs - elapsedMs,
            );
          }
        }
      } finally {
        if (utSystem) utSystem.setUserTimeMSec(nowMs);
      }

      // Live2DModel.update() only accumulates delta. The SDK performs the
      // actual motion/expression/core update inside its native _render(),
      // where Cubism's WebGL state is isolated from Pixi's filter programs.
      for (const { target } of currentTargets) {
        target.update?.(0.001);
      }
    } finally {
      releaseUtSystemLock();
    }
  }

  setInjectedParameter(model: any, paramName: string, value: number): void {
    const coreModel = this.getCoreModel(model);
    if (!coreModel?.getParamIndex || !coreModel?.setParamFloat) return;

    const idx = coreModel.getParamIndex(paramName);
    if (idx !== -1) {
      // ID-keyed write first: the Cubism 2 SDK's numeric-overload
      // setParamFloat silently no-ops, so index-based injection (handoff pose
      // restore, lip-sync) never reached the core on the real runtime. Both
      // forms are written — the index form is a no-op on the real SDK and the
      // only form understood by index-keyed runtimes.
      coreModel.setParamFloat(paramName, value);
      coreModel.setParamFloat(idx, value);
    }
  }

  syncInputParameters(model: any): void {
    if (model && typeof model.syncInputParameters === 'function') {
      model.syncInputParameters();
    }
  }

  captureSnapshot(id: string, model: any, motionStartTime?: number): ModelSnapshot | null {
    return captureModelSnapshot(id, model, motionStartTime);
  }

  applySnapshot(model: any, snapshot: ModelSnapshot): void {
    const internalModel = model?.internalModel;
    if (!internalModel) return;

    const coreModel = internalModel.coreModel;
    if (!coreModel) return;

    const targetParams = resolveNumericArrayLike(
      internalModel.parameterValues,
      internalModel.getParameterValues?.(),
      coreModel.getParameterValues?.(),
      coreModel.paramValues,
      coreModel._$5S?._$_2,
    );

    this.copyNumericValues(targetParams, snapshot.params);
    writePartOpacities(internalModel, snapshot.opacities);
    if (typeof coreModel.saveParam === 'function') {
      coreModel.saveParam();
    }
  }

  async restoreSeekState(model: any, input: Live2DSeekRestoreInput): Promise<Live2DSeekRestoreResult> {
    if (input.snapshot) {
      this.applySnapshot(model, input.snapshot);
    }
    if (input.motion) {
      await this.preloadMotion(model, input.motion.key);
    }
    return {
      status: 'fallback',
      tierUsed: 'snapshot-forward',
      diagnostics: ['Cubism 2 keeps the legacy snapshot-forward seek path.'],
    };
  }

  renderForBake(model: any, renderer: any, _label?: string, renderTexture?: any): void {
    if (renderTexture && typeof renderer?.render === 'function') {
      // Cubism 2 renders through raw WebGL programs while PIXI's offscreen
      // pass caches shader and framebuffer state. Reset both sides of the
      // boundary so a background/filter program cannot retain uniform
      // locations while Cubism draws the bake model.
      // v8 seam: AbstractRenderer.resetState() — the resetState runner fan-out
      // over the GL systems. v7's renderer-level `reset()` no longer exists,
      // and `?.` would turn it into a silent no-op.
      renderer.resetState?.();
      try {
        renderer.render(model, { renderTexture, clear: true });
      } finally {
        renderer.resetState?.();
      }
      return;
    }
    model?.render?.(renderer);
  }

  advanceFrame(model: any, deltaMs: number): void {
    if (model && typeof model.update === 'function') {
      model.update(deltaMs);
    }
  }

  advanceMotionOnly(model: any, utTimeMs: number): void {
    const targets = this.getConcreteModels(model)
      .map((target) => ({
        model: target,
        internalModel: target?.internalModel,
        motionManager: target?.internalModel?.motionManager,
      }))
      .filter((target) => !!target.motionManager && !!target.internalModel?.coreModel);
    // Physics-guarded queue stepping lives in the shared native-motion helper
    // (identical to the offset-replay loop in Cubism2NativeMotionSession).
    stepMotionQueuesAt(targets, utTimeMs);
  }

  stepBakeFrame(
    model: any,
    deltaMs: number,
    renderer?: any,
    _label?: string,
    flushCore: boolean = true,
  ): void {
    if (!model) return;

    // 1. Advance the display model (accumulates delta for the internal step).
    //    deltaMs === 0 keeps the model's existing accumulated delta: the
    //    legacy bake flow called renderBakeModel right after an idle flush
    //    without another model.update().
    if (deltaMs > 0 && typeof model.update === 'function') {
      model.update(deltaMs);
    }

    // 2. When the internal model has GL bound, flush its update path outside
    //    Pixi's render boundary (bake models normally never bind GL, so this
    //    is a safety net matching the legacy bake loop). The flush runs the
    //    Cubism 2 clip pipeline with raw GL — it must go through the external-GL
    //    guard so it never writes vertex attribute pointers into Pixi's
    //    still-bound batch VAO (a poisoned VAO is not self-healing: `bind()`
    //    only re-selects it, it never re-uploads the attribute state).
    const internalModel = model.internalModel;
    if (deltaMs > 0 && internalModel && (internalModel as any).gl && typeof internalModel.update === 'function') {
      guardExternalGl(renderer, () => internalModel.update());
    }

    // 3. Render (or advance-without-render for Cubism 2) into the adapter-owned
    //    bake RenderTexture.
    if (renderer) {
      this.renderBakeModel(model, renderer);
    }

    // 4. Flush the core model update so parameter arrays are committed before
    //    snapshot capture. Historically only the main bake loop flushed the
    //    core; warm-up and initial-render positions did not.
    //    NOTE: Cubism 2's `Live2DModelWebGL.update()` includes `preDraw()` →
    //    `clipManager.setupClip()` — a raw-GL mask rasterization. Outside a
    //    render pass it would write vertex attribute pointers into whichever
    //    VAO Pixi last bound (permanently — the batch VAO never recovers), so
    //    it runs behind the external-GL guard (pass-through without a renderer).
    if (flushCore) {
      const coreModel = internalModel?.coreModel;
      if (coreModel && typeof coreModel.update === 'function') {
        guardExternalGl(renderer, () => coreModel.update());
      }
    }
  }

  private renderBakeModel(model: any, renderer: any): void {
    if (!renderer || !model || model.visible === false || model.renderable === false) {
      return;
    }

    // The vendor only binds its WebGL context inside renderLive2D()
    // (InternalModel.updateWebGLContext). The advance-without-render fast path
    // below skips the real render entirely, so a fresh model would reach its
    // first internalModel.update() with drawParamWebGL.gl still unbound and
    // crash in the SDK shader compilation. Bind unbound concrete models to the
    // bake GL context first (stable slot, same semantics as renderLive2D).
    if (this.bakeCore) {
      for (const concrete of this.getConcreteModels(model)) {
        this.bakeCore.ensureBakeContextBound(concrete, renderer);
      }
    }

    // Cubism 2 bake: advance every concrete InternalModel with its accumulated
    // delta/elapsed and skip the actual GL render — mirrors the legacy
    // advance-without-render fast path that keeps headless bakes off GL.
    // The advance runs the clip pipeline with raw GL outside the render
    // boundary, hence the external-GL guard (unbind the VAO first — the SDK
    // owns no VAO and would otherwise poison Pixi's last-bound batch VAO with
    // its 32-byte mask-quad attribute pointers; on ANGLE the next batched
    // glDrawElements then fails "Vertex buffer is not big enough" and every
    // sprite drawn from that VAO lands at garbage positions).
    if (this.advanceCubism2BakeModelWithoutRender(model, renderer)) {
      return;
    }

    if (this.bakeCore) {
      const renderTexture = this.bakeCore.getBakeRenderTexture(renderer);
      this.renderToBakeTexture(model, renderer, renderTexture);
      return;
    }

    // Fallback without an adapter-owned bake context (tests / diagnostics).
    model?.render?.(renderer);
  }

  private renderToBakeTexture(model: any, renderer: any, renderTexture: PIXI.RenderTexture | null): void {
    if (renderTexture && typeof renderer?.render === 'function') {
      // Same v8 seam as renderForBake(): renderer.resetState(), not v7's reset().
      renderer.resetState?.();
      try {
        renderer.render(model, { renderTexture, clear: true });
      } finally {
        renderer.resetState?.();
      }
      return;
    }
    model?.render?.(renderer);
  }

  private advanceCubism2BakeModelWithoutRender(model: any, renderer?: any): boolean {
    let advanced = false;
    guardExternalGl(renderer, () => {
      for (const concreteModel of this.getConcreteModels(model)) {
        const internalModel = concreteModel?.internalModel;
        if (!internalModel || typeof internalModel.update !== 'function') {
          continue;
        }

        const deltaTime = Number(concreteModel.deltaTime ?? 0);
        const elapsedTime = Number(concreteModel.elapsedTime ?? 0);
        if (!(deltaTime > 0) || !Number.isFinite(elapsedTime)) {
          continue;
        }

        internalModel.update(deltaTime, elapsedTime);
        concreteModel.deltaTime = 0;
        advanced = true;
      }
    });

    return advanced;
  }

  async flushIdleState(model: any): Promise<void> {
    const internalModel = model?.internalModel;
    const coreModel = internalModel?.coreModel;
    if (!internalModel || !coreModel) return;

    try {
      const idleGroup = this.resolveIdleMotionGroup(internalModel);
      if (idleGroup && internalModel.motionManager) {
        try {
          await internalModel.motionManager.loadMotion(idleGroup, 0);
          await internalModel.motionManager.startMotion(idleGroup, 0, 3);

          // 核心修复：绝对不能在此处执行大幅度的时间跳跃和回退（如 t+2000 然后 t）！
          // 否则模型的物理系统记录了 t+2000，等稍后在较早的场景时间烘焙/渲染时，
          // 物理引擎会遇到巨大的负 dt，导致瞬间 NaN 坍缩。这里只前进 16ms 跑一帧。
          const sdkClock = this.clockProvider();
          if (sdkClock) {
            await acquireUtSystemLock();
            try {
              const t = sdkClock.getUserTimeMSec();
              sdkClock.setUserTimeMSec(t + 16);
              model.update?.(16);
            } finally {
              releaseUtSystemLock();
            }
          } else {
            for (let i = 0; i < 40; i++) model.update?.(50);
          }

          internalModel.motionManager.stopAllMotions();
          if (internalModel.motionManager._motionQueueManager) {
            internalModel.motionManager._motionQueueManager.stopAllMotions();
          }
        } catch {
          // Ignore — a partially torn-down manager must not break the load.
        }
      }
    } catch {
      // Ignore — same guarantee as the legacy load-time flush.
    }
  }

  async restartIdleMotion(model: any): Promise<void> {
    for (const target of this.getConcreteModels(model)) {
      const internalModel = target?.internalModel;
      const motionManager = internalModel?.motionManager;
      if (!motionManager) continue;
      const idleGroup = this.resolveIdleMotionGroup(internalModel);
      if (!idleGroup) continue;
      try {
        await motionManager.startMotion(idleGroup, 0, 3);
      } catch {
        // Ignore — the motion may not be loaded yet on this concrete target.
      }
      return;
    }
  }

  async resetModelToIdle(model: any, options: Live2DModelResetOptions = {}): Promise<void> {
    const { keepFocus = false, idleSnapshot = null } = options;

    for (const targetModel of this.getConcreteModels(model)) {
      const internalModel = targetModel?.internalModel;
      if (!internalModel) continue;

      if (internalModel.motionManager) {
        internalModel.motionManager.stopAllMotions();
        if (internalModel.motionManager._motionQueueManager) {
          internalModel.motionManager._motionQueueManager.stopAllMotions();
        }
        if (internalModel.motionManager.state) {
          internalModel.motionManager.state.currentGroup = undefined;
          internalModel.motionManager.state.reservedGroup = undefined;
          (internalModel.motionManager.state as any).queue = [];
          if (internalModel.motionManager._motionQueueManager) {
            (internalModel.motionManager._motionQueueManager as any)._userTimeMSec = 0;
          }
        }

        try {
          const idleGroup = this.resolveIdleMotionGroup(internalModel);
          if (idleGroup) {
            await internalModel.motionManager.startMotion(idleGroup, 0, 3);
            // 与旧实现一致：idle 洗刷推进 16ms（时钟经 adapter 句柄访问，与
            // flushIdleState 同通道；此处历史上有意不加全局锁——见旧代码）。
            const sdkClock = this.clockProvider();
            if (sdkClock) {
              sdkClock.setUserTimeMSec(sdkClock.getUserTimeMSec() + 16);
              targetModel.update?.(16);
            } else {
              targetModel.update?.(16);
            }
            internalModel.motionManager.stopAllMotions();
            if (internalModel.motionManager._motionQueueManager) {
              internalModel.motionManager._motionQueueManager.stopAllMotions();
            }
          }
        } catch {
          // Ignore — idle group may not exist on this target.
        }
      }

      if (internalModel.expressionManager) {
        internalModel.expressionManager.stopAllExpressions();
        if (internalModel.expressionManager.state) {
          internalModel.expressionManager.state.currentGroup = undefined;
        }
      }

      if (internalModel.coreModel) {
        if (idleSnapshot) {
          try {
            this.applySnapshot(targetModel, idleSnapshot as ModelSnapshot);
            console.log('[Live2D] Character restored from deep idle snapshot.');
          } catch {
            resetCoreParams(internalModel.coreModel);
          }
        } else {
          resetCoreParams(internalModel.coreModel);
        }
      }

      if (!keepFocus && internalModel.focusController) {
        internalModel.focusController.focus(0, 0, true);
      }

      targetModel.update?.(16);
    }
  }

  applyIdleBaseline(model: any, idleSnapshot: Pick<ModelSnapshot, 'params' | 'opacities'> | null): void {
    if (!model) return;
    for (const target of this.getConcreteModels(model)) {
      const coreModel = target?.internalModel?.coreModel;
      if (!coreModel) continue;
      if (idleSnapshot) {
        this.applySnapshot(target, idleSnapshot as ModelSnapshot);
      } else {
        resetCoreParams(coreModel);
      }
    }
  }

  captureIdleSnapshot(model: any): { params: Float32Array; opacities: Float32Array } | null {
    const internalModel = model?.internalModel;
    const coreModel = internalModel?.coreModel;
    if (!internalModel || !coreModel) return null;

    try {
      const params = internalModel.parameterValues
        || internalModel.getParameterValues?.()
        || coreModel.getParameterValues?.()
        || coreModel.paramValues
        // Cubism 2.1 sometimes exposes the live arrays only through the
        // private model context; without these the snapshot (and every reset
        // restoring it) would silently keep the previous lifecycle's pose.
        || coreModel._$5S?._$_2;
      const opacities = readPartOpacities(internalModel);
      if (!params) return null;

      const idleSnapshot = {
        params: Float32Array.from(params as ArrayLike<number>),
        opacities: opacities ? Float32Array.from(opacities) : new Float32Array(),
      };
      if (coreModel.saveParam) coreModel.saveParam();
      return idleSnapshot;
    } catch (e) {
      console.warn('[Live2D] Failed to capture idle snapshot', e);
      return null;
    }
  }

  hasMotionGroup(model: any, motionKey: string): boolean {
    for (const target of this.getConcreteModels(model)) {
      const motions = target?.internalModel?.settings?.motions;
      if (motions && motions[motionKey]) return true;
    }
    return false;
  }

  async startMotion(
    model: any,
    motionKey: string,
    priority: number,
    offsetSeconds: number,
    options: Live2DMotionStartOptions = {},
  ): Promise<Live2DMotionStartResult> {
    const targets = this.getConcreteModels(model)
      .map((target) => ({
        model: target,
        internalModel: target?.internalModel,
        motionManager: target?.internalModel?.motionManager,
      }))
      .filter((target) => {
        if (!target.motionManager) return false;
        const motions = target.internalModel?.settings?.motions || {};
        return !!motions[motionKey];
      });

    if (targets.length === 0) {
      return { ok: false, offsetReplayMs: 0 };
    }

    if (options.clearQueueFirst) {
      for (const { motionManager } of targets) {
        motionManager.stopAllMotions?.();
        motionManager._motionQueueManager?.stopAllMotions?.();
        if (motionManager.state) {
          motionManager.state.currentGroup = undefined;
          motionManager.state.reservedGroup = undefined;
          motionManager.state.queue = [];
        }
        motionManager.playing = false;
      }
    }

    const result = await this.nativeMotionSession.startMotion({
      targets,
      motionKey,
      priority,
      offsetSeconds,
      clock: options.clock ?? null,
      beforeReplay: options.beforeReplay
        ? async (context) => options.beforeReplay!(context)
        : undefined,
    });

    // Legacy ordinary-playback path: a zero-offset non-skip start stepped one
    // frame inside the locked clock window (physics was already restored by
    // the session's finally, so the step sees a positive dt — safe).
    if (options.stepAfterStartMs && !(offsetSeconds > 0)) {
      this.advanceFrame(model, options.stepAfterStartMs);
    }

    return {
      ok: result.started,
      offsetReplayMs: result.offsetReplayMs,
      motionStartUtTimeMs: result.motionStartUtTimeMs,
    };
  }

  getMotionSamplingTargets(model: any): readonly Cubism2MotionSamplerTarget[] {
    const targets: Cubism2MotionSamplerTarget[] = [];
    for (const instance of this.getConcreteModels(model)) {
      const internalModel = instance?.internalModel;
      const motionManager = internalModel?.motionManager;
      if (!internalModel || !motionManager || typeof motionManager.loadMotion !== 'function') continue;
      targets.push({ internalModel, motionManager });
    }
    return targets;
  }

  installCustomMotionStage(
    model: any,
    input: Omit<InstallCustomMotionStageInput, 'targets'>,
  ): CustomMotionStageHandle | null {
    const targets = this.getConcreteModels(model)
      .map((concrete) => ({ internalModel: concrete?.internalModel }))
      .filter((target) => !!target.internalModel);
    if (targets.length === 0) return null;
    return installCustomMotionStage({
      targets,
      getState: input.getState,
      lipSyncParameterIds: input.lipSyncParameterIds,
    });
  }

  quiesceModel(model: any): void {
    const internalModel = model?.internalModel;
    if (!internalModel?.motionManager) return;
    internalModel.motionManager.stopAllMotions?.();
    internalModel.motionManager._motionQueueManager?.stopAllMotions?.();
    const expMgr = internalModel.motionManager.expressionManager;
    if (expMgr && typeof expMgr.resetExpression === 'function') expMgr.resetExpression();
  }

  disposeModel(model: any, options: Live2DDisposeOptions): void {
    if (!model) return;

    if (options.detach) {
      try {
        if (model.parent) model.parent.removeChild(model);
      } catch {
        /* already detached */
      }
    }

    if (options.mode === 'soft-detach') {
      // Cubism 2 runtime keeps global mask/framebuffer state inside the shared
      // SDK singleton. Fully destroying a background model can clear that state
      // while other models are still alive, which later crashes in
      // clipManager.setupClip() with an undefined framebuffer. Soft-detach.
      model.visible = false;
      model.renderable = false;
      model.alpha = 0;
      try {
        model.stopAllMotions?.();
        model.internalModel?.motionManager?._motionQueueManager?.stopAllMotions?.();
      } catch {
        /* partially torn down model */
      }
      return;
    }

    // destroy
    const keepTextures = options.keepTextures === true;
    const concrete = this.getConcreteModels(model);
    // Release adapter-owned isolated mask buffers before disposal. They are
    // not covered by the keepTextures policy — they are ours, not the model's
    // sprite sheets — and a dropped maskSprite would leak its render texture.
    for (const target of concrete) {
      this.releaseIsolatedMask(target);
    }
    const isComposite = concrete.length > 1 || (concrete[0] !== undefined && concrete[0] !== model);
    try {
      if (isComposite && typeof model.removeChildren === 'function') {
        for (const child of concrete) {
          try {
            child.destroy({
              children: true,
              texture: keepTextures ? false : true,
              baseTexture: keepTextures ? false : true,
            });
          } catch {
            /* already disposed */
          }
        }
        model.removeChildren();
        try {
          model.destroy();
        } catch {
          /* already disposed */
        }
      } else {
        model.destroy({
          children: true,
          texture: keepTextures ? false : true,
          baseTexture: keepTextures ? false : true,
        });
      }
    } catch {
      /* detach/destroy may fail if model is already partially disposed */
    }
  }

  prepareModel(model: any, options: Live2DModelPrepareOptions): void {
    const { id, mode, isExportMode = false, injectedParamsSource, applyProxyTransform } = options;

    (model as any)._characterEntry = injectedParamsSource;

    for (const concrete of this.getConcreteModels(model)) {
      const internalModel = concrete?.internalModel;
      const coreModel = internalModel?.coreModel;
      if (!internalModel || !coreModel) continue;

      applyBehaviorFixes(injectedParamsSource as any, internalModel, coreModel);
      applyParameterOverride(injectedParamsSource as any, coreModel, internalModel, isExportMode);

      if (mode === 'bake') {
        // Deterministic breathing for bake (no Date.now()).
        applyBakeBreathingFix(internalModel, coreModel);
      } else {
        // Hook every concrete model at its _render() boundary so a filter pop
        // or the next sibling render always restores Pixi state.
        applyRenderHook(id, concrete, applyProxyTransform ?? (() => {}));
        // Isolate the mask buffer per model to prevent multi-model glitches.
        this.isolateMask(concrete);
      }
    }
  }

  isolateMask(model: any): void {
    const internalModel = model?.internalModel;
    const maskSize = Math.max(1, Math.floor(this.maskSizeProvider()));
    const maskSprite = findMaskSprite(internalModel);
    if (maskSprite) {
      // A Cubism 2 model can be recycled after an exit seek. Its clipping mask
      // render texture then contains the previous lifecycle's contents. Reusing
      // that texture can make every clipped draw resolve as a dark silhouette.
      // Renew the buffer: destroy only textures created by this isolation
      // hook; model-owned textures must remain untouched.
      const previousTexture = maskSprite.texture as any;
      if (previousTexture?.__aeonstageryMaskIsolationTexture) {
        previousTexture.destroy?.(true);
      }
      const texture = PIXI.RenderTexture.create({ width: maskSize, height: maskSize }) as any;
      texture.__aeonstageryMaskIsolationTexture = true;
      maskSprite.texture = texture;
      console.log(`[Live2D] Isolated mask buffer (${maskSize}x${maskSize})`);
      return;
    }
    const deepMask = model?.children?.find((child: any) => child.name === 'maskSprite' || child.isMask);
    if (deepMask?.texture) {
      console.log('[Live2D] Found deep mask sprite');
    } else {
      console.log('[Live2D] No mask buffer found to isolate');
    }
  }

  /** Destroy the isolation buffer `isolateMask` created for one concrete model. */
  private releaseIsolatedMask(model: any): void {
    const sprite = findMaskSprite(model?.internalModel);
    const texture = sprite?.texture as any;
    if (texture?.__aeonstageryMaskIsolationTexture) {
      texture.destroy?.(true);
      sprite.texture = PIXI.Texture.EMPTY;
    }
  }

  installBakeRenderGuards(model: any): void {
    if (!this.bakeCore) return;
    for (const concrete of this.getConcreteModels(model)) {
      this.bakeCore.installRenderGuard(concrete);
      this.bakeCore.installInternalModelGuard(concrete?.internalModel);
    }
  }

  setBlink(model: any, enabled: boolean, intervalMs: number = 4000, sceneTimeSeconds?: number, startTimeSeconds?: number, intervalRangeMs?: number): void {
    const internalModel = model?.internalModel;
    const eyeBlink = internalModel?.eyeBlink;
    if (internalModel) {
      const existing = internalModel._aeonBlinkControl ?? createBlinkControlState(false);
      const sceneTime = Number.isFinite(sceneTimeSeconds)
        ? sceneTimeSeconds
        : existing.sceneTimeSeconds;
      const startTime = Number.isFinite(startTimeSeconds)
        ? startTimeSeconds
        : existing.startTimeSeconds;
      const rangeMs = Number.isFinite(intervalRangeMs)
        ? intervalRangeMs
        : (existing.intervalRangeMs ?? 0);
      internalModel._aeonBlinkControl = {
        ...existing,
        enabled,
        intervalMs,
        intervalRangeMs: rangeMs,
        sceneTimeSeconds: sceneTime,
        startTimeSeconds: startTime,
      };
      internalModel._currentBlinkMultiplier = evaluateBlinkMultiplier(
        sceneTime,
        internalModel._aeonBlinkControl,
      );
    }
    if (!eyeBlink) return;

    if (enabled) {
      const originalUpdate = eyeBlink.__aeonOriginalUpdate;
      if (originalUpdate) {
        eyeBlink.update = originalUpdate;
        delete eyeBlink.__aeonOriginalUpdate;
      }
      if ('enabled' in eyeBlink) eyeBlink.enabled = true;
      eyeBlink.blinkInterval = intervalMs;
      eyeBlink.nextBlinkTimeLeft = intervalMs;
    } else {
      // Stop the wrapped Cubism 2 updater as well as resetting its timer.
      // A large interval alone still permits a blink after 24 hours and does
      // not reliably disable the behavior during long exports.
      if (!eyeBlink.__aeonOriginalUpdate && typeof eyeBlink.update === 'function') {
        eyeBlink.__aeonOriginalUpdate = eyeBlink.update;
      }
      eyeBlink.update = () => {};
      if ('enabled' in eyeBlink) eyeBlink.enabled = false;
      eyeBlink.blinkingState = 0;
      internalModel._currentBlinkMultiplier = 1;
      eyeBlink.blinkInterval = 24 * 60 * 60 * 1000;
      eyeBlink.nextBlinkTimeLeft = 24 * 60 * 60 * 1000;
    }
  }

  applyFocus(model: any, input: Live2DFocusInput): void {
    const rawDuration = input.duration ?? 0.5;
    const duration = Number.isFinite(rawDuration)
      ? Math.max(0, rawDuration)
      : 0.5;
    for (const target of this.getConcreteModels(model)) {
      const internalModel = target?.internalModel;
      if (!internalModel?.focusController) continue;
      this.applyLookAtToFocusController(
        internalModel.focusController,
        input.focusX,
        input.focusY,
        duration,
        input.options,
      );
    }
  }

  getFocusControllers(model: any): any[] {
    const controllers: any[] = [];
    for (const target of this.getConcreteModels(model)) {
      const focusController = target?.internalModel?.focusController;
      if (focusController) controllers.push(focusController);
    }
    return controllers;
  }

  getHeadAnchor(model: any): { x: number; y: number } | null {
    // Shared hit-area math — see resolveHeadAnchorFromSettings (used by both
    // runtime adapters so the layout math cannot drift apart).
    return resolveHeadAnchorFromSettings(model?.internalModel?.settings);
  }

  private static readonly DEFAULT_LOOK_AT_EASE = 'power1.out';

  private applyLookAtFrame(
    fc: any,
    targetX: number,
    targetY: number,
    x: number,
    y: number,
  ): void {
    fc.x = x;
    fc.y = y;
    fc.targetX = targetX;
    fc.targetY = targetY;
    // Cover the internal variable names used by both cubism2 and cubism3+
    // pixi-live2d-display FocusController implementations.
    fc.faceX = x;
    fc.faceY = y;
    fc.faceTargetX = targetX;
    fc.faceTargetY = targetY;
    fc._x = x;
    fc._y = y;
    fc._targetX = targetX;
    fc._targetY = targetY;
    fc.vx = 0;
    fc.vy = 0;
  }

  private restoreLookAtFocusUpdate(fc: any): void {
    if (fc.__aeonOriginalFocusUpdate) {
      fc.update = fc.__aeonOriginalFocusUpdate;
      delete fc.__aeonOriginalFocusUpdate;
    }
  }

  private takeLookAtFocusUpdateOwnership(fc: any): void {
    if (!fc.__aeonOriginalFocusUpdate && typeof fc.update === 'function') {
      fc.__aeonOriginalFocusUpdate = fc.update;
      fc.update = () => {};
    }
  }

  private applyLookAtToFocusController(
    fc: any,
    targetX: number,
    targetY: number,
    duration: number,
    options?: Live2DFocusOptions,
  ): void {
    if (!fc) return;

    gsap.killTweensOf(fc);
    this.restoreLookAtFocusUpdate(fc);

    const safeDuration = Number.isFinite(duration)
      ? Math.max(0, duration)
      : 0;
    const fromX = Number.isFinite(options?.fromX)
      ? options!.fromX!
      : Number.isFinite(fc.x) ? fc.x : 0;
    const fromY = Number.isFinite(options?.fromY)
      ? options!.fromY!
      : Number.isFinite(fc.y) ? fc.y : 0;
    const elapsed = Number.isFinite(options?.elapsed)
      ? Math.max(0, options!.elapsed!)
      : 0;
    const ease = typeof options?.ease === 'string' && options.ease.trim()
      ? options.ease
      : Cubism2PixiLive2DModelControls.DEFAULT_LOOK_AT_EASE;

    const finish = () => {
      this.applyLookAtFrame(fc, targetX, targetY, targetX, targetY);
      this.restoreLookAtFocusUpdate(fc);
    };

    if (safeDuration <= 0 || elapsed >= safeDuration) {
      finish();
      fc.focus?.(targetX, targetY);
      return;
    }

    // While GSAP owns the transition, disable the controller's fixed-speed
    // integrator; otherwise it fights the requested duration with its own
    // acceleration.
    this.takeLookAtFocusUpdateOwnership(fc);

    const progress = Math.min(1, Math.max(0, elapsed / safeDuration));
    const currentX = fromX + (targetX - fromX) * (progress > 0 ? gsap.parseEase(ease)(progress) : 0);
    const currentY = fromY + (targetY - fromY) * (progress > 0 ? gsap.parseEase(ease)(progress) : 0);
    this.applyLookAtFrame(fc, targetX, targetY, currentX, currentY);
    fc.focus?.(targetX, targetY);

    gsap.to(fc, {
      x: targetX,
      y: targetY,
      duration: Math.max(0, safeDuration - elapsed),
      ease: progress > 0 ? 'none' : ease,
      onUpdate: () => {
        fc.targetX = targetX;
        fc.targetY = targetY;
        fc.faceX = fc.x;
        fc.faceY = fc.y;
        fc._x = fc.x;
        fc._y = fc.y;
        fc.vx = 0;
        fc.vy = 0;
      },
      onComplete: finish,
      onInterrupt: finish,
    });
  }

  private copyNumericValues(
    target: ArrayLike<number> | null,
    source: Float32Array | undefined,
  ): void {
    if (!target || !source) return;

    const writableTarget = target as MutableNumericArrayLike;
    const copyLength = Math.min(target.length, source.length);
    if (copyLength <= 0) return;

    if (target.length === source.length) {
      if (writableTarget.set) writableTarget.set(source);
      else for (let i = 0; i < copyLength; i++) writableTarget[i] = source[i];
      return;
    }

    if (source.subarray && writableTarget.set) {
      writableTarget.set(source.subarray(0, copyLength));
    } else {
      for (let i = 0; i < copyLength; i++) writableTarget[i] = source[i];
    }
  }
}

export class Cubism2PixiLive2DAdapter implements Live2DRuntimeAdapter {
  public readonly id = 'pixi-live2d-display-cubism2';
  public readonly supported = true;
  private modelClass: any = null;
  private moduleConfig: any = null;
  private ready = false;
  private initPromise: Promise<void> | null = null;
  private readonly bakeCore = new Cubism2BakeRenderCore();
  private readonly controls: Cubism2PixiLive2DModelControls;

  constructor(
    // Must resolve to the same engine bundle whose Live2DPlugin is registered
    // as the render pipe — see Live2DEngineBridge.
    private readonly loadModule: Cubism2ModuleLoader = () => loadLive2DEngineModule(),
  ) {
    this.controls = new Cubism2PixiLive2DModelControls({
      maskSize: () => this.getConfig()?.cubism2?.maskSize ?? 1024,
      bakeCore: this.bakeCore,
      clock: () => this.getClock(),
    });
  }

  async init(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      // Importing pixi-live2d-display/cubism2 without window.Live2D throws at
      // module-evaluation time and permanently poisons the dynamic-import
      // cache. When the Cubism 2.1 runtime is known-missing, fail with an
      // explicit message instead of touching the module graph.
      await waitForLive2DRuntimeBootstrap();
      if (!isLive2DCubism2RuntimeAvailable()) {
        throw new Error(getUnsupportedLive2DRuntimeMessage('live2d.min.js', {
          runtimeFamily: 'cubism2',
          adapterId: this.id,
          supported: false,
        }) ?? 'Cubism 2.1 runtime is unavailable.');
      }

      const module = await this.loadModule();
      this.modelClass = 'Live2DModel' in module ? module.Live2DModel ?? null : null;
      this.moduleConfig = 'config' in module ? module.config ?? null : this.modelClass?.config ?? null;

      const cubism2Config = this.getConfig()?.cubism2;
      if (cubism2Config) {
        cubism2Config.maskSize = 1024;
      }

      this.ready = true;
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  getModelClass(): any {
    return this.modelClass;
  }

  getConfig(): any {
    return this.modelClass?.config ?? this.moduleConfig;
  }

  getControls(): Live2DRuntimeModelControls {
    return this.controls;
  }

  createModelHandle(
    id: string,
    model: any,
    runtime: Live2DRuntimeDescriptor = defaultCubism2RuntimeDescriptor,
  ): Live2DModelHandle {
    return createLive2DModelHandle({
      id,
      model,
      runtime,
      controls: this.controls,
    });
  }

  async createModel(modelUrl: string, options: Live2DModelCreateOptions): Promise<any> {
    await this.init();
    if (!this.modelClass?.from) {
      throw new Error('Cubism 2 Live2DModel class is not available.');
    }
    return this.modelClass.from(modelUrl, options);
  }

  getUnsupportedMessage(modelPath: string): string | null {
    return getUnsupportedLive2DRuntimeMessage(modelPath, {
      runtimeFamily: 'cubism2',
      adapterId: this.id,
      supported: isLive2DCubism2RuntimeAvailable(),
    });
  }

  getClock(): Live2DRuntimeClock | null {
    if (typeof window === 'undefined') return null;
    const utSystem = (window as any).UtSystem;
    if (!utSystem || typeof utSystem.getUserTimeMSec !== 'function') return null;
    return utSystem;
  }

  createFallbackModel(renderer?: any): any {
    const graphics = new PIXI.Graphics();
    graphics.beginFill(0x222222, 0.8);
    graphics.lineStyle(6, 0xffaa00);
    graphics.drawRect(0, 0, 800, 1200);

    // Draw a cross
    graphics.moveTo(0, 0);
    graphics.lineTo(800, 1200);
    graphics.moveTo(800, 0);
    graphics.lineTo(0, 1200);
    graphics.endFill();

    const tex = typeof renderer?.generateTexture === 'function'
      ? renderer.generateTexture(graphics)
      : PIXI.Texture.EMPTY;
    const model: any = new PIXI.Sprite(tex);

    // Mock the runtime surface the adapter's own controls call into, so the
    // placeholder survives the standard lifecycle hooks (update, snapshot,
    // motion teardown) without crashing.
    model.update = () => {};
    model.internalModel = {
      coreModel: {
        getParameterValues: () => [],
        getPartOpacities: () => [],
        saveParam: () => {},
      },
      motionManager: {
        stopAllMotions: () => {},
        loadMotion: async () => {},
        startMotion: async () => {},
      },
      settings: { motions: {} },
    };
    return model;
  }

  disposeBakeRenderTexture(): void {
    this.bakeCore.disposeBakeRenderTexture();
  }
}

export class OfficialCubismWebLive2DAdapter implements Live2DRuntimeAdapter {
  public readonly id = 'official-cubism-web';
  public get supported(): boolean {
    return getOfficialCubismSdkStatus().available;
  }
  private ready = false;
  private initPromise: Promise<void> | null = null;
  private readonly controls: Live2DRuntimeModelControls = {
    getCoreModel: (model) => model?.internalModel?.coreModel ?? null,
    describeInvalidState: (model) => {
      const internalModel = model?.internalModel;
      const coreModel = internalModel?.coreModel;
      if (!internalModel || !coreModel) return null;

      const params = resolveNumericArrayLike(
        internalModel.parameterValues,
        coreModel.getParameterValues?.(),
      );
      const invalidParamIndex = findFirstNonFinite(params);
      if (params && invalidParamIndex !== -1) {
        const rawId = coreModel.getParameterId?.(invalidParamIndex);
        const paramName = typeof rawId === 'string'
          ? rawId
          : rawId?.getString?.() ?? rawId?.toString?.() ?? `Param_${invalidParamIndex}`;
        return `primary param[${invalidParamIndex}] (${paramName})=${params[invalidParamIndex]}`;
      }

      const opacities = resolveNumericArrayLike(
        internalModel.partOpacities,
      );
      const invalidOpacityIndex = findFirstNonFinite(opacities);
      if (opacities && invalidOpacityIndex !== -1) {
        return `primary opacity[${invalidOpacityIndex}]=${opacities[invalidOpacityIndex]}`;
      }

      return null;
    },
    getAvailableMotions: (model) => Object.keys(model?.internalModel?.settings?.motions ?? {}),
    getAvailableExpressions: (model) => Object.keys(model?.internalModel?.settings?.expressions ?? {}),
    getMotionDuration: (model, motionKey) => model?.getMotionDuration?.(motionKey, 0) ?? 0,
    getMotionDebugState: (model) => {
      const motionManager = model?.internalModel?.motionManager;
      if (!motionManager) return null;

      return {
        currentGroup: motionManager.state?.currentGroup,
        reservedGroup: motionManager.state?.reservedGroup,
        playing: motionManager.playing,
        isFinished: !motionManager.playing,
        queueLength: motionManager.state?.queue?.length ?? 0,
        internalModel: model?.internalModel ?? null,
        motionManager,
        queueManager: motionManager.state?.queue ?? [],
      };
    },
    getParameterValues: (model) => {
      const coreModel = model?.internalModel?.coreModel;
      const paramIds = coreModel?.getParameterIds?.();
      const values = coreModel?.getParameterValues?.();
      if (!paramIds || !values) return null;
      return Array.from({ length: Math.min(paramIds.length, values.length) }, (_, index) => ({
        index,
        name: typeof paramIds[index] === 'string'
          ? paramIds[index]
          : paramIds[index]?.getString?.() ?? `Param_${index}`,
        value: values[index],
      }));
    },
    getParameterMetadata: (model) => {
      const coreModel = model?.internalModel?.coreModel;
      if (!coreModel?.getParameterCount || !coreModel?.getParameterId) {
        const values = this.controls.getParameterValues(model);
        return values?.map((parameter) => ({
          id: parameter.name,
          index: parameter.index,
          defaultValue: Number.isFinite(parameter.value) ? parameter.value : undefined,
          source: 'runtime',
        })) ?? null;
      }

      const parameterCount = coreModel.getParameterCount();
      const metadata: Live2DParameterMetadata[] = [];
      for (let index = 0; index < parameterCount; index++) {
        const rawId = coreModel.getParameterId(index);
        const id = typeof rawId === 'string'
          ? rawId
          : rawId?.getString?.() ?? rawId?.toString?.() ?? `Param_${index}`;
        metadata.push({
          id,
          index,
          min: finiteOrUndefined(coreModel.getParameterMinimumValue?.(index)),
          max: finiteOrUndefined(coreModel.getParameterMaximumValue?.(index)),
          defaultValue: finiteOrUndefined(coreModel.getParameterDefaultValue?.(index)),
          source: 'runtime',
        });
      }
      return metadata;
    },
    clearMotionState: (model) => {
      // Stop first: clearing the bookkeeping alone leaves the official runtime's
      // motion queue running, which keeps writing the previous action's curves.
      model?.stopAllMotions?.();
      const motionManager = model?.internalModel?.motionManager;
      if (motionManager) {
        motionManager.stopAllMotions?.();
        const expressionState = motionManager.expressionManager?.state;
        if (expressionState) {
          expressionState.currentGroup = undefined;
          expressionState.reservedGroup = undefined;
          expressionState.queue = [];
        }
      }
      if (!motionManager?.state) return;
      motionManager.state.currentGroup = undefined;
      motionManager.state.reservedGroup = undefined;
      motionManager.state.queue = [];
    },
    stopAllMotions: (model) => {
      model?.stopAllMotions?.();
    },
    preloadMotion: async (model, motionKey) => {
      await model?.preloadMotion?.(motionKey, 0);
    },
    setExpression: (model, expressionName) => {
      model?.setExpression?.(expressionName ?? null);
    },
    setExpressionForSeek: async (model, expressionName) => {
      model?.setExpression?.(expressionName ?? null);
    },
    setInjectedParameter: (model, paramName, value) => {
      const coreModel = model?.internalModel?.coreModel;
      if (!coreModel?.getParameterCount || !coreModel?.getParameterId || !coreModel?.setParameterValueByIndex) {
        return;
      }

      const parameterCount = coreModel.getParameterCount();
      for (let index = 0; index < parameterCount; index++) {
        const rawId = coreModel.getParameterId(index);
        const id = typeof rawId === 'string'
          ? rawId
          : rawId?.getString?.() ?? rawId?.toString?.();
        if (id === paramName) {
          coreModel.setParameterValueByIndex(index, value);
          model?.syncInputParameters?.();
          return;
        }
      }
    },
    syncInputParameters: (model) => {
      model?.syncInputParameters?.();
    },
    captureSnapshot: (id, model, motionStartTime) => {
      const captured = typeof model?.captureRuntimeSnapshot === 'function'
        ? model.captureRuntimeSnapshot(id, motionStartTime)
        : captureModelSnapshot(id, model, motionStartTime);
      if (!captured) return null;
      captured.runtimeFamily = 'cubism3-plus';
      captured.adapterId = 'official-cubism-web';
      return captured;
    },
    applySnapshot: (model, snapshot) => {
      const internalModel = model?.internalModel;
      const coreModel = internalModel?.coreModel;
      if (!internalModel || !coreModel) return;

      const targetParams = resolveNumericArrayLike(
        internalModel.parameterValues,
        coreModel.getParameterValues?.(),
      );
      if (targetParams && snapshot.params) {
        const length = Math.min(targetParams.length, snapshot.params.length);
        for (let i = 0; i < length; i++) {
          if (coreModel.setParameterValueByIndex) {
            coreModel.setParameterValueByIndex(i, snapshot.params[i]);
          }
          (targetParams as MutableNumericArrayLike)[i] = snapshot.params[i];
        }
        // Official Cubism loads this saved buffer before the next motion
        // update. Bake seed restores and motion handoffs must survive it.
        coreModel.saveParameters?.();
      }

      const targetOpacities = resolveNumericArrayLike(
        internalModel.partOpacities,
      );
      if (targetOpacities && snapshot.opacities && coreModel.setPartOpacityByIndex) {
        const length = Math.min(targetOpacities.length, snapshot.opacities.length);
        for (let i = 0; i < length; i++) {
          coreModel.setPartOpacityByIndex(i, snapshot.opacities[i]);
          (targetOpacities as MutableNumericArrayLike)[i] = snapshot.opacities[i];
        }
      }

      model?.syncInputParameters?.();
    },
    restoreSeekState: async (model, input) => {
      if (typeof model?.restoreAtSceneTime === 'function') {
        return model.restoreAtSceneTime(input);
      }

      const diagnostics: string[] = ['Official Cubism Web model does not expose restoreAtSceneTime; using bounded fallback.'];
      if (input.handoffSnapshot) {
        this.controls.applySnapshot(model, input.handoffSnapshot as ModelSnapshot);
      } else if (input.idleSnapshot) {
        this.controls.applySnapshot(model, input.idleSnapshot as ModelSnapshot);
      } else if (input.snapshot) {
        this.controls.applySnapshot(model, input.snapshot);
      }

      if (input.motion) {
        if (input.motion.fadeInSeconds !== undefined) {
          await model?.startMotion?.(
            input.motion.key,
            0,
            input.motion.priority ?? 3,
            input.motion.offset,
            input.motion.fadeInSeconds,
          );
        } else {
          await model?.startMotion?.(input.motion.key, 0, input.motion.priority ?? 3, input.motion.offset);
        }
      } else {
        model?.stopAllMotions?.();
      }
      model?.setExpression?.(input.expression?.key ?? null);
      model?.update?.(16);
      model?.renderForBake?.(null);

      const invalid = this.controls.describeInvalidState(model);
      if (invalid) diagnostics.push(invalid);
      return {
        status: invalid ? 'fallback' : 'restored',
        tierUsed: 'snapshot-forward',
        diagnostics,
      };
    },
    renderForBake: (model, renderer, _label, renderTexture) => {
      if (typeof model?.renderForBake === 'function') {
        model.renderForBake(renderer, renderTexture);
        return;
      }
      if (renderTexture && typeof renderer?.render === 'function') {
        renderer.render(model, { renderTexture, clear: true });
        return;
      }
      model?.render?.(renderer);
    },
    getConcreteModels: (model) => (model ? [model] : []),
    advanceFrame: (model, deltaMs) => {
      model?.update?.(deltaMs);
    },
    advanceMotionOnly: () => {
      // The official runtime advances motion queues inside its own update pass.
    },
    stepBakeFrame: (model, deltaMs, renderer, label, flushCore) => {
      if (deltaMs > 0) model?.update?.(deltaMs);
      this.controls.renderForBake(model, renderer ?? null, label, undefined);
      if (flushCore !== false) model?.syncInputParameters?.();
    },
    flushIdleState: async (model) => {
      model?.stopAllMotions?.();
      model?.update?.(16);
    },
    resetModelToIdle: async (model, options) => {
      model?.stopAllMotions?.();
      this.controls.clearMotionState(model);
      if (options?.idleSnapshot) {
        this.controls.applySnapshot(model, options.idleSnapshot as ModelSnapshot);
        console.log('[Live2D] Character restored from runtime idle snapshot.');
      }
      if (!options?.keepFocus) {
        const focusController = model?.internalModel?.focusController;
        focusController?.focus?.(0, 0, true);
      }
      model?.update?.(16);
    },
    applyIdleBaseline: (model, idleSnapshot) => {
      if (idleSnapshot) {
        this.controls.applySnapshot(model, idleSnapshot as ModelSnapshot);
      }
    },
    captureIdleSnapshot: (model) => {
      const internal = model?.internalModel;
      if (!internal?.parameterValues || !internal?.partOpacities) return null;
      return {
        params: new Float32Array(internal.parameterValues),
        opacities: new Float32Array(internal.partOpacities),
      };
    },
    restartIdleMotion: async () => {
      // The official runtime manages idle motions through its own queue.
    },
    hasMotionGroup: (model, motionKey) => {
      return !!model?.internalModel?.settings?.motions?.[motionKey];
    },
    startMotion: async (model, motionKey, priority, offsetSeconds, options) => {
      const started = options?.fadeInSeconds !== undefined
        ? await model?.startMotion?.(motionKey, 0, priority, offsetSeconds, options.fadeInSeconds)
        : await model?.startMotion?.(motionKey, 0, priority, offsetSeconds);
      return { ok: !!started, offsetReplayMs: 0 };
    },
    getMotionSamplingTargets: () => [],
    installCustomMotionStage: () => null,
    quiesceModel: (model) => {
      model?.stopAllMotions?.();
      model?.setExpression?.(null);
    },
    disposeModel: (model, options) => {
      if (!model) return;
      if (options.detach) {
        try {
          if (model.parent) model.parent.removeChild(model);
        } catch {
          /* already detached */
        }
      }
      if (options.mode === 'destroy') {
        try {
          model.destroy({
            children: true,
            texture: options.keepTextures ? false : true,
            baseTexture: options.keepTextures ? false : true,
          });
        } catch {
          /* already disposed */
        }
        return;
      }
      model.visible = false;
      model.renderable = false;
      model.alpha = 0;
    },
    prepareModel: (model, options) => {
      // The official model consumes injected runtime parameters immediately
      // before Core.update(); retain the character/bake entry it should read.
      model._characterEntry = options.injectedParamsSource;
    },
    isolateMask: () => {
      // The official runtime renders through its own canvas; no pixi mask state.
    },
    installBakeRenderGuards: () => {
      // The official runtime renders through its own canvas; no GL guards.
    },
    setBlink: (model, enabled, intervalMs = 4000, sceneTimeSeconds, startTimeSeconds, intervalRangeMs) => {
      if (intervalRangeMs !== undefined) {
        model?.setBlink?.(enabled, intervalMs, sceneTimeSeconds, startTimeSeconds, intervalRangeMs);
      } else {
        model?.setBlink?.(enabled, intervalMs, sceneTimeSeconds, startTimeSeconds);
      }
    },
    applyFocus: () => {
      // The official runtime facade has no focus controller.
    },
    getFocusControllers: () => [],
    getHeadAnchor: (model) => resolveHeadAnchorFromSettings(model?.internalModel?.settings),
  };

  async init(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      await initOfficialCubismWebSdk();
      this.ready = true;
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  getModelClass(): any {
    return null;
  }

  getConfig(): any {
    return null;
  }

  getControls(): Live2DRuntimeModelControls {
    return this.controls;
  }

  createModelHandle(
    id: string,
    model: any,
    runtime: Live2DRuntimeDescriptor = {
      runtimeFamily: 'cubism3-plus',
      adapterId: this.id,
      supported: this.supported,
    },
  ): Live2DModelHandle {
    return createLive2DModelHandle({
      id,
      model,
      runtime,
      controls: this.controls,
    });
  }

  async createModel(modelUrl: string): Promise<any> {
    if (!this.ready) {
      await this.init();
    }
    const { OfficialCubismWebModelInstance } = await import('./OfficialCubismWebModel');
    return OfficialCubismWebModelInstance.create(modelUrl);
  }

  getUnsupportedMessage(modelPath: string): string | null {
    return getUnsupportedLive2DRuntimeMessage(modelPath, {
      runtimeFamily: 'cubism3-plus',
      adapterId: this.id,
      supported: this.supported,
    });
  }

  getClock(): Live2DRuntimeClock | null {
    return null;
  }

  createFallbackModel(): any {
    return null;
  }

  disposeBakeRenderTexture(): void {
    // The official runtime renders to its own canvas; nothing to release.
  }
}

export const cubism2Live2DAdapter = new Cubism2PixiLive2DAdapter();
export const officialCubismWebLive2DAdapter = new OfficialCubismWebLive2DAdapter();

export function getLive2DRuntimeAdapter(runtime?: Live2DRuntimeDescriptor | null): Live2DRuntimeAdapter {
  const resolvedRuntime = runtime ?? defaultCubism2RuntimeDescriptor;
  if (resolvedRuntime.adapterId === 'official-cubism-web') return officialCubismWebLive2DAdapter;
  return cubism2Live2DAdapter;
}
