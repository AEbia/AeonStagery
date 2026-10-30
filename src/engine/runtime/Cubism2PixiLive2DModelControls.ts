import type { Live2DRuntimeControlPort } from './Live2DRuntimeControlPort';
import type { Live2DRuntimeClock } from '../live2d/runtime/Live2DRuntimeClockCoordinator';
import type { Live2DMotionStartOptions, Live2DModelPrepareOptions } from './Live2DRuntimeControlPort';
import * as PIXI from 'pixi.js';
import gsap from 'gsap';
import type { ModelSnapshot } from '../Live2DConfig';
import {
  CUBISM2_DEFAULT_PARAMS,
  captureModelSnapshot,
  findFirstNonFinite,
  resetCoreParams,
  resolveNumericArrayLike,
} from '../Live2DConfig';
import {
  getSharedRuntimeClockForTransaction,
  withSharedRuntimeClock,
  type Live2DClockTransaction,
} from '../live2d/runtime/Live2DRuntimeClockCoordinator';
import type { Live2DParameterMetadata } from '../../api/types/live2d-parameter-animation';
import { Cubism2NativeMotionSession, stepMotionQueuesAt } from '../live2d/Cubism2NativeMotionSession';
import {
  mergeCubism2SampledCurves,
  resolveCubism2MotionMeta,
  sampleCubism2MotionCurves,
} from '../live2d/cubism2MotionSampler';
import { Cubism2BakeRenderCore } from '../live2d/runtime/Cubism2BakeRenderCore';
import { Cubism2ExpressionLifecycle } from '../live2d/runtime/Cubism2ExpressionLifecycle';
import { guardExternalGl } from '../live2d/runtime/Cubism2RenderGuardSeam';
import { readPartOpacities, writePartOpacities } from '../live2d/runtime/Cubism2PartOpacity';
import {
  installCustomMotionStage,
  type CustomMotionStageHandle,
  type InstallCustomMotionStageInput,
} from '../live2d/customMotionStage';
import { createBlinkControlState, evaluateBlinkMultiplier } from '../live2d/blinkController';
import {
  applyBakeBreathingFix,
  applyBehaviorFixes,
  applyParameterOverride,
  applyRenderHook,
  findMaskSprite,
} from '../Live2DModelSetup';
import type {
  Live2DSeekRestoreInput,
  Live2DSeekRestoreResult,
  Live2DModelResetOptions,
  Live2DDisposeOptions,
  Live2DFocusInput,
  Live2DFocusOptions,
  Live2DFocusAnimationAction,
  Live2DMotionSamplingOptions,
  Live2DMotionSamplingResult,
  MutableNumericArrayLike,
  Live2DPerformanceMetadata,
  PerformanceCompatibility,
  PreparedAssetRef,
} from './Live2DRuntimeContracts';
import type { Live2DInternalMotionStartResult } from './Live2DRuntimeControlPort';
import {
  finiteOrUndefined,
  getCubism2ModelContext,
  resolveCubism2ParameterId,
  resolveHeadAnchorFromSettings,
} from './modelMetadata';

function mergePerformanceCompatibility(
  first: PerformanceCompatibility,
  second: PerformanceCompatibility,
): PerformanceCompatibility {
  const status = first.status === 'incompatible' || second.status === 'incompatible'
    ? 'incompatible'
    : first.status === 'partial' || second.status === 'partial' ? 'partial' : 'compatible';
  return {
    status,
    missingParameterIds: Array.from(new Set([...first.missingParameterIds, ...second.missingParameterIds])),
    ignoredParameterIds: Array.from(new Set([...first.ignoredParameterIds, ...second.ignoredParameterIds])),
    diagnostics: [...first.diagnostics, ...second.diagnostics],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
type Cubism2SamplingTarget = { readonly internalModel: any; readonly motionManager: any };

export class Cubism2PixiLive2DModelControls implements Live2DRuntimeControlPort {
  private readonly expressions: Cubism2ExpressionLifecycle;
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
      const utSystem = (window as any).UtSystem;
      return utSystem && typeof utSystem.getUserTimeMSec === 'function' ? utSystem : null;
    });
    this.expressions = new Cubism2ExpressionLifecycle(
      (model) => this.getConcreteModels(model), this.clockProvider,
    );
  }

  /**
   * Resolve the authored idle motion group name ('idle' preferred over
   * 'Idle') when the runtime exposes one, else null. Shared by the load-time
   * flush, the idle restart and the hard reset so the detection exists once.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism 2 passes legacy model and Pixi renderer objects through its pre-v8 two-argument render hook.
  private resolveIdleMotionGroup(internalModel: any): string | null {
    const motions = internalModel?.settings?.motions;
    if (!motions) return null;
    return motions['idle'] ? 'idle' : motions['Idle'] ? 'Idle' : null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  getCoreModel(model: any): any | null {
    const internal = model?.internalModel;
    return internal?.coreModel ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  getParameterMetadata(model: any): readonly Live2DParameterMetadata[] | null {
    const values = this.getParameterValues(model);
    if (!values) return null;
    const settings = model?.internalModel?.settings;
    const context = getCubism2ModelContext(model?.internalModel?.coreModel);
    return values.map((parameter) => {
      const setting = settings?.parameters?.[parameter.index] ?? {};
      const knownDefault = CUBISM2_DEFAULT_PARAMS[parameter.name];
      return {
        id: parameter.name,
        index: parameter.index,
        label: typeof setting.label === 'string' && setting.label
          ? setting.label
          : typeof setting.name === 'string' && setting.name !== parameter.name ? setting.name : undefined,
        min: finiteOrUndefined(context?.getParamMin?.(parameter.index)) ?? finiteOrUndefined(setting.min),
        max: finiteOrUndefined(context?.getParamMax?.(parameter.index)) ?? finiteOrUndefined(setting.max),
        defaultValue: finiteOrUndefined(setting.defaultValue) ?? knownDefault,
        source: knownDefault !== undefined ? 'known-cubism2-default' : 'runtime',
      };
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  async registerExternalMotion(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
    model: any,
    runtimeKey: string,
    source: PreparedAssetRef,
    metadata?: Live2DPerformanceMetadata,
  ): Promise<PerformanceCompatibility> {
    return this.registerExternalPerformance(model, 'motion', runtimeKey, source, metadata);
  }

  async registerExternalExpression(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
    model: any,
    runtimeKey: string,
    source: PreparedAssetRef,
    metadata?: Live2DPerformanceMetadata,
  ): Promise<PerformanceCompatibility> {
    return this.registerExternalPerformance(model, 'expression', runtimeKey, source, metadata);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  unregisterExternalPerformance(model: any, runtimeKey: string): void {
    for (const target of this.getConcreteModels(model)) {
      target?.unregisterExternalPerformance?.(runtimeKey);
    }
  }

  private async registerExternalPerformance(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
    model: any,
    kind: 'motion' | 'expression',
    runtimeKey: string,
    source: PreparedAssetRef,
    metadata?: Live2DPerformanceMetadata,
  ): Promise<PerformanceCompatibility> {
    if (metadata?.targetSubmodels?.length) {
      return {
        status: 'incompatible',
        missingParameterIds: [],
        ignoredParameterIds: [],
        diagnostics: ['Cubism 2 composite submodel identifiers are unavailable; targetSubmodels cannot be resolved safely.'],
      };
    }
    const targets = this.getConcreteModels(model);
    if (targets.length === 0) {
      return {
        status: 'incompatible',
        missingParameterIds: [],
        ignoredParameterIds: [],
        diagnostics: ['Cubism 2 model has no concrete submodel for external performance registration.'],
      };
    }

    const diagnostics: string[] = [];
    let registered = 0;
    let report: PerformanceCompatibility = { status: 'compatible', missingParameterIds: [], ignoredParameterIds: [], diagnostics: [] };
    for (const target of targets) {
      const method = target?.[`registerExternal${kind === 'motion' ? 'Motion' : 'Expression'}`];
      const generic = target?.registerExternalPerformance;
      if (typeof method !== 'function' && typeof generic !== 'function') {
        diagnostics.push(`Cubism 2 dynamic ${kind} registration is unavailable for this model.`);
        continue;
      }
      try {
        const result = typeof method === 'function'
          ? await method.call(target, runtimeKey, source, metadata)
          : await generic.call(target, kind, runtimeKey, source, metadata);
        if (result && typeof result === 'object' && 'status' in result) {
          report = mergePerformanceCompatibility(report, result as PerformanceCompatibility);
        }
        registered += 1;
      } catch (error) {
        diagnostics.push(`Failed to register external ${kind} "${runtimeKey}": ${String(error)}`);
      }
    }

    report = mergePerformanceCompatibility(report, {
      status: registered === targets.length ? 'compatible' : registered > 0 ? 'partial' : 'incompatible',
      missingParameterIds: [], ignoredParameterIds: [], diagnostics,
    });
    return report;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  setExpression(model: any, expressionName: string | null): void {
    this.expressions.set(model, expressionName);
  }

  setExpressionForSeek(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
    model: any,
    expressionName: string | null,
    elapsedSeconds: number,
    previousExpressionKey?: string | null,
    isCurrent: () => boolean = () => true,
    transaction?: Live2DClockTransaction,
  ): Promise<void> {
    return this.expressions.restoreForSeek(
      model, expressionName, elapsedSeconds, previousExpressionKey, isCurrent, transaction,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  syncInputParameters(model: any): void {
    if (model && typeof model.syncInputParameters === 'function') {
      model.syncInputParameters();
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  captureSnapshot(id: string, model: any, motionStartTime?: number): ModelSnapshot | null {
    return captureModelSnapshot(id, model, motionStartTime);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  async restoreSeekState(model: any, input: Live2DSeekRestoreInput): Promise<Live2DSeekRestoreResult> {
    const isCurrent = input.isCurrent ?? (() => true);
    if (!isCurrent()) return { status: 'cancelled', tierUsed: 'unsupported' };
    if (input.snapshot) {
      this.applySnapshot(model, input.snapshot);
    }
    if (!isCurrent()) return { status: 'cancelled', tierUsed: 'unsupported' };
    if (input.motion) {
      await this.preloadMotion(model, input.motion.key);
    }
    if (!isCurrent()) return { status: 'cancelled', tierUsed: 'unsupported' };
    return {
      status: 'fallback',
      tierUsed: 'snapshot-forward',
      diagnostics: ['Cubism 2 keeps the legacy snapshot-forward seek path.'],
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  advanceFrame(model: any, deltaMs: number): void {
    if (model && typeof model.update === 'function') {
      model.update(deltaMs);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
    model: any,
    deltaMs: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  async flushIdleState(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
    model: any,
    isCurrent: () => boolean = () => true,
    transaction?: Live2DClockTransaction,
  ): Promise<void> {
    if (!isCurrent()) return;
    const internalModel = model?.internalModel;
    const coreModel = internalModel?.coreModel;
    if (!internalModel || !coreModel) return;

    try {
      const idleGroup = this.resolveIdleMotionGroup(internalModel);
      if (idleGroup && internalModel.motionManager) {
        try {
          await internalModel.motionManager.loadMotion(idleGroup, 0);
          if (!isCurrent()) return;
          await internalModel.motionManager.startMotion(idleGroup, 0, 3);
          if (!isCurrent()) return;

          // 核心修复：绝对不能在此处执行大幅度的时间跳跃和回退（如 t+2000 然后 t）！
          // 否则模型的物理系统记录了 t+2000，等稍后在较早的场景时间烘焙/渲染时，
          // 物理引擎会遇到巨大的负 dt，导致瞬间 NaN 坍缩。这里只前进 16ms 跑一帧。
          const sdkClock = this.clockProvider();
          if (sdkClock) {
            await withSharedRuntimeClock(sdkClock, isCurrent, (lease) => {
              if (!isCurrent()) return;
              const clock = getSharedRuntimeClockForTransaction(lease);
              if (!clock) return;
              const t = clock.getUserTimeMSec();
              clock.setUserTimeMSec(t + 16);
              model.update?.(16);
            }, transaction);
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  async resetModelToIdle(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
    model: any,
    options: Live2DModelResetOptions = {},
    isCurrent: () => boolean = () => true,
    transaction?: Live2DClockTransaction,
  ): Promise<void> {
    const { keepFocus = false, idleSnapshot = null } = options;
    if (!isCurrent()) return;
    this.expressions.clear(model);
    const sdkClock = this.clockProvider();

    await withSharedRuntimeClock(sdkClock, isCurrent, async (activeTransaction) => {
      const clock = getSharedRuntimeClockForTransaction(activeTransaction) ?? sdkClock;
      for (const targetModel of this.getConcreteModels(model)) {
        if (!isCurrent()) return;
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
            (internalModel.motionManager.state as any).queue = [];
            if (internalModel.motionManager._motionQueueManager) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
              (internalModel.motionManager._motionQueueManager as any)._userTimeMSec = 0;
            }
          }

          try {
            const idleGroup = this.resolveIdleMotionGroup(internalModel);
            if (idleGroup) {
              await internalModel.motionManager.startMotion(idleGroup, 0, 3);
              if (!isCurrent()) return;
              // Preserve the idle flush step while sharing the runtime clock lease.
              if (clock) {
                clock.setUserTimeMSec(clock.getUserTimeMSec() + 16);
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

        this.expressions.clear(targetModel);

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

        if (!isCurrent()) return;
        if (!keepFocus && internalModel.focusController) {
          internalModel.focusController.focus(0, 0, true);
        }

        targetModel.update?.(16);
      }
    }, transaction);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  hasMotionGroup(model: any, motionKey: string): boolean {
    for (const target of this.getConcreteModels(model)) {
      const motions = target?.internalModel?.settings?.motions;
      if (motions && motions[motionKey]) return true;
    }
    return false;
  }

  async startMotion(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
    model: any,
    motionKey: string,
    priority: number,
    offsetSeconds: number,
    options: Live2DMotionStartOptions = {},
  ): Promise<Live2DInternalMotionStartResult> {
    if (options.isCurrent && !options.isCurrent()) {
      return { ok: false, offsetReplayMs: 0, cancelled: true };
    }
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
        if (options.isCurrent && !options.isCurrent()) {
          return { ok: false, offsetReplayMs: 0, cancelled: true };
        }
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
      isCurrent: options.isCurrent,
      beforeReplay: options.beforeReplay
        ? async (context) => options.beforeReplay!(context)
        : undefined,
    });

    // Legacy ordinary-playback path: a zero-offset non-skip start stepped one
    // frame inside the locked clock window (physics was already restored by
    // the session's finally, so the step sees a positive dt — safe).
    if (options.isCurrent && !options.isCurrent()) {
      return { ok: false, offsetReplayMs: result.offsetReplayMs, cancelled: true };
    }
    if (options.stepAfterStartMs && !(offsetSeconds > 0)) {
      this.advanceFrame(model, options.stepAfterStartMs);
    }

    return {
      ok: result.started,
      offsetReplayMs: result.offsetReplayMs,
      motionStartUtTimeMs: result.motionStartUtTimeMs,
      cancelled: result.cancelled,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  #getMotionSamplingTargets(model: any): readonly Cubism2SamplingTarget[] {
    const targets: Cubism2SamplingTarget[] = [];
    for (const instance of this.getConcreteModels(model)) {
      const internalModel = instance?.internalModel;
      const motionManager = internalModel?.motionManager;
      if (!internalModel || !motionManager || typeof motionManager.loadMotion !== 'function') continue;
      targets.push({ internalModel, motionManager });
    }
    return targets;
  }

  async sampleMotion(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
    model: any,
    motionKey: string,
    options: Live2DMotionSamplingOptions,
    transaction?: Live2DClockTransaction,
  ): Promise<Live2DMotionSamplingResult> {
    const targets = this.#getMotionSamplingTargets(model);
    if (targets.length === 0) {
      return { status: 'unsupported', diagnostics: ['Cubism 2 motion sampling requires a loaded motion manager.'] };
    }
    const metas = await Promise.all(targets.map((target) => resolveCubism2MotionMeta(target, motionKey)));
    const firstMeta = metas[0];
    const meta = {
      ...firstMeta,
      ...(metas.some((candidate) => candidate.hasNonParameterCurves) ? { hasNonParameterCurves: true } : {}),
    };
    const sampleOptions = {
      fps: options.fps,
      durationSeconds: meta.durationSeconds,
      zeroSourceFades: options.zeroSourceFades,
      skipMissingParameters: options.skipMissingParameters,
      fadeInSeconds: meta.fadeInSeconds,
      fadeOutSeconds: meta.fadeOutSeconds,
    };
    const curves = transaction
      ? await (async () => {
          const results: Array<Awaited<ReturnType<typeof sampleCubism2MotionCurves>>> = [];
          for (const target of targets) {
            results.push(await sampleCubism2MotionCurves(target, motionKey, sampleOptions, transaction));
          }
          return results;
        })()
      : await Promise.all(targets.map((target) => sampleCubism2MotionCurves(target, motionKey, sampleOptions)));
    return {
      status: 'sampled',
      metadata: meta,
      curves: mergeCubism2SampledCurves(curves),
    };
  }

  installCustomMotionStage(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  quiesceModel(model: any): void {
    if (!model) return;
    this.expressions.clear(model);
    Reflect.deleteProperty(model, '_characterEntry');
    for (const concrete of this.getConcreteModels(model)) {
      Reflect.deleteProperty(concrete, '_characterEntry');
      const internalModel = concrete?.internalModel;
      if (!internalModel) continue;
      Reflect.deleteProperty(internalModel, '_characterEntry');
      if (internalModel.coreModel) Reflect.deleteProperty(internalModel.coreModel, '_characterEntry');
      internalModel.motionManager?.stopAllMotions?.();
      internalModel.motionManager?._motionQueueManager?.stopAllMotions?.();
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  disposeModel(model: any, options: Live2DDisposeOptions): void {
    if (!model) return;
    this.expressions.clear(model);

    if (options.detach) {
      try {
        if (model.parent) model.parent.removeChild(model);
      } catch {
        /* already detached */
      }
    }

    const concrete = this.getConcreteModels(model);
    // Native masks belong to each model/context pair, including soft-detached
    // bake models. Pool returns never enter this final-disposal path.
    for (const target of concrete) {
      this.bakeCore?.releaseModelContexts(target);
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  prepareModel(model: any, options: Live2DModelPrepareOptions): void {
    const { id, mode, isExportMode = false, injectedParamsSource, applyProxyTransform } = options;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
    (model as any)._characterEntry = injectedParamsSource;

    for (const concrete of this.getConcreteModels(model)) {
      const internalModel = concrete?.internalModel;
      const coreModel = internalModel?.coreModel;
      if (!internalModel || !coreModel) continue;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
      applyBehaviorFixes(injectedParamsSource as any, internalModel, coreModel);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  prepareModelResources(model: any): void {
    for (const concreteModel of this.getConcreteModels(model)) this.isolateMask(concreteModel);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
      const previousTexture = maskSprite.texture as any;
      if (previousTexture?.__aeonstageryMaskIsolationTexture) {
        previousTexture.destroy?.(true);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
      const texture = PIXI.RenderTexture.create({ width: maskSize, height: maskSize }) as any;
      texture.__aeonstageryMaskIsolationTexture = true;
      maskSprite.texture = texture;
      console.log(`[Live2D] Isolated mask buffer (${maskSize}x${maskSize})`);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
    const deepMask = model?.children?.find((child: any) => child.name === 'maskSprite' || child.isMask);
    if (deepMask?.texture) {
      console.log('[Live2D] Found deep mask sprite');
    } else {
      console.log('[Live2D] No mask buffer found to isolate');
    }
  }

  /** Destroy the isolation buffer `isolateMask` created for one concrete model. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  private releaseIsolatedMask(model: any): void {
    const sprite = findMaskSprite(model?.internalModel);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
    const texture = sprite?.texture as any;
    if (texture?.__aeonstageryMaskIsolationTexture) {
      texture.destroy?.(true);
      sprite.texture = PIXI.Texture.EMPTY;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  installBakeRenderGuards(model: any): void {
    if (!this.bakeCore) return;
    for (const concrete of this.getConcreteModels(model)) {
      this.bakeCore.installRenderGuard(concrete);
      this.bakeCore.installInternalModelGuard(concrete?.internalModel);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  getFocusControllers(model: any): any[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
    const controllers: any[] = [];
    for (const target of this.getConcreteModels(model)) {
      const focusController = target?.internalModel?.focusController;
      if (focusController) controllers.push(focusController);
    }
    return controllers;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  manageFocusAnimations(model: any, action: Live2DFocusAnimationAction): void {
    for (const focusController of this.getFocusControllers(model)) {
      if (action === 'stop') {
        gsap.killTweensOf(focusController);
        this.restoreLookAtFocusUpdate(focusController);
      } else {
        gsap.getTweensOf(focusController).forEach((tween) => {
          if (action === 'pause') tween.pause();
          else tween.resume();
        });
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  getHeadAnchor(model: any, target: 'head' | 'main' = 'main'): { x: number; y: number } | null {
    // Shared hit-area math — see resolveHeadAnchorFromSettings (used by both
    // runtime adapters so the layout math cannot drift apart).
    const source = target === 'head'
      ? model?.subModels?.[0] ?? model?.mainModel ?? model
      : model?.mainModel ?? model;
    return resolveHeadAnchorFromSettings(source?.internalModel?.settings);
  }

  private static readonly DEFAULT_LOOK_AT_EASE = 'power1.out';

  private applyLookAtFrame(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  private restoreLookAtFocusUpdate(fc: any): void {
    if (fc.__aeonOriginalFocusUpdate) {
      fc.update = fc.__aeonOriginalFocusUpdate;
      delete fc.__aeonOriginalFocusUpdate;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  private takeLookAtFocusUpdateOwnership(fc: any): void {
    if (!fc.__aeonOriginalFocusUpdate && typeof fc.update === 'function') {
      fc.__aeonOriginalFocusUpdate = fc.update;
      fc.update = () => {};
    }
  }

  private applyLookAtToFocusController(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
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
