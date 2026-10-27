import type { Live2DRuntimeDescriptor } from '../Live2DRuntimeResolver';
import { getUnsupportedLive2DRuntimeMessage } from '../Live2DRuntimeResolver';
import type { ModelSnapshot } from '../Live2DConfig';
import { captureModelSnapshot, findFirstNonFinite, resolveNumericArrayLike } from '../Live2DConfig';
import type { Live2DParameterMetadata } from '../../api/types/live2d-parameter-animation';
import { getCubismPixiSdkStatus, initCubismPixiSdk } from '../CubismPixiSdk';
import { createLive2DModelHandle, type Live2DModelHandle } from '../live2d/runtime/Live2DRuntimeControlModule';
import { loadCubismEngineModule } from '../Live2DEngineBridge';
import { installCustomMotionStage, type InstallCustomMotionStageInput } from '../live2d/customMotionStage';
import { loadCubism3Motion } from '../live2d/cubism3MotionSampler';
import type {
  Live2DModelCreateOptions,
  Live2DModelDisplayObject,
  MutableNumericArrayLike,
  Live2DRuntimeAdapter,
  Live2DPerformanceMetadata,
  PerformanceCompatibility,
  PreparedAssetRef,
} from './Live2DRuntimeContracts';
import type { Live2DRuntimeControlPort } from './Live2DRuntimeControlPort';
import { finiteOrUndefined, resolveCubismParameterId, resolveHeadAnchorFromSettings } from './modelMetadata';
import { resolveCubismModelAnchor, type CubismAnchorModel } from './CubismModelAnchors';
import { applyRuntimeFocus, manageRuntimeFocusAnimations } from '../live2d/runtime/RuntimeFocus';
import {
  isExternalPerformanceMethod,
  isGenericExternalPerformanceMethod,
  isPerformanceCompatibility,
  readExpressionNames,
  readSdkProperty,
} from './sdkBoundary';

async function registerExternalPerformance(
  model: unknown,
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
      diagnostics: ['Cubism 3+ submodel identifiers are unavailable; targetSubmodels cannot be resolved safely.'],
    };
  }
  const method = readSdkProperty(model, `registerExternal${kind === 'motion' ? 'Motion' : 'Expression'}`);
  const generic = readSdkProperty(model, 'registerExternalPerformance');
  if (!isExternalPerformanceMethod(method) && !isGenericExternalPerformanceMethod(generic)) {
    return {
      status: 'incompatible',
      missingParameterIds: [],
      ignoredParameterIds: [],
      diagnostics: [`Cubism 3+ model does not expose external ${kind} registration.`],
    };
  }

  try {
    const result = isExternalPerformanceMethod(method)
      ? await method.call(model, runtimeKey, source, metadata)
      : isGenericExternalPerformanceMethod(generic)
        ? await generic.call(model, kind, runtimeKey, source, metadata)
        : undefined;
    if (isPerformanceCompatibility(result)) return result;
    if (readSdkProperty(result, 'status') !== undefined) {
      return {
        status: 'incompatible', missingParameterIds: [], ignoredParameterIds: [],
        diagnostics: [`Cubism 3+ external ${kind} registration returned an invalid compatibility report.`],
      };
    }
    return { status: 'compatible', missingParameterIds: [], ignoredParameterIds: [], diagnostics: [] };
  } catch (error) {
    return {
      status: 'incompatible',
      missingParameterIds: [],
      ignoredParameterIds: [],
      diagnostics: [`Failed to register external ${kind} "${runtimeKey}": ${String(error)}`],
    };
  }
}

export class CubismPixiLive2DAdapter implements Live2DRuntimeAdapter {
  public readonly id = 'untitled-pixi-live2d-engine-cubism';
  public get supported(): boolean {
    return getCubismPixiSdkStatus().available;
  }
  private ready = false;
  private initPromise: Promise<void> | null = null;
  private readonly controls: Live2DRuntimeControlPort = {
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
          : resolveCubismParameterId(rawId) ?? `Param_${invalidParamIndex}`;
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
    getAvailableMotions: (model) => [...new Set([
      ...Object.keys(model?.internalModel?.settings?.motions ?? {}),
      ...(model?.getExternalPerformanceKeys?.('motion') ?? []),
    ])],
    getAvailableExpressions: (model) => {
      const definitions = model?.internalModel?.settings?.expressions;
      const configured = readExpressionNames(definitions);
      return [...new Set([...configured, ...(model?.getExternalPerformanceKeys?.('expression') ?? [])])];
    },
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
          : resolveCubismParameterId(paramIds[index]) ?? `Param_${index}`,
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
          : resolveCubismParameterId(rawId) ?? `Param_${index}`;
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
    registerExternalMotion: (model, runtimeKey, source, metadata) =>
      registerExternalPerformance(model, 'motion', runtimeKey, source, metadata),
    registerExternalExpression: (model, runtimeKey, source, metadata) =>
      registerExternalPerformance(model, 'expression', runtimeKey, source, metadata),
    unregisterExternalPerformance: (model, runtimeKey) => {
      model?.unregisterExternalPerformance?.(runtimeKey);
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
    setExpressionForSeek: async (model, expressionName, elapsedSeconds, previousExpressionKey, isCurrent = () => true) => {
      if (!isCurrent()) return;
      if (model?.setExpressionForSeek) {
        await model.setExpressionForSeek(expressionName, elapsedSeconds, previousExpressionKey, isCurrent);
      } else if (isCurrent()) {
        model?.setExpression?.(expressionName ?? null);
      }
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
          : resolveCubismParameterId(rawId);
        if (id === paramName) {
          coreModel.setParameterValueByIndex(index, value);
          // Geometry is committed by syncInputParameters after the batch.
          // Updating Core here repeats the whole model deformation per track.
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
      captured.adapterId = 'untitled-pixi-live2d-engine-cubism';
      return captured;
    },
    applySnapshot: (model, snapshot) => {
      const internalModel = model?.internalModel;
      const coreModel = internalModel?.coreModel;
      if (!internalModel || !coreModel) return;
      if (model.applyRuntimeSnapshot) {
        model.applyRuntimeSnapshot(snapshot);
        return;
      }

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

      const isCurrent = input.isCurrent ?? (() => true);
      if (!isCurrent()) return { status: 'cancelled', tierUsed: 'unsupported' };
      const diagnostics: string[] = ['Cubism model does not expose restoreAtSceneTime; using bounded fallback.'];
      if (input.handoffSnapshot) {
        this.controls.applySnapshot(model, input.handoffSnapshot as ModelSnapshot);
      } else if (input.idleSnapshot) {
        this.controls.applySnapshot(model, input.idleSnapshot as ModelSnapshot);
      } else if (input.snapshot) {
        this.controls.applySnapshot(model, input.snapshot);
      }

      if (input.motion) {
        await this.controls.startMotion(model, input.motion.key, input.motion.priority ?? 3, input.motion.offset, {
          fadeInSeconds: input.motion.fadeInSeconds,
          isCurrent,
        });
        if (!isCurrent()) return { status: 'cancelled', tierUsed: 'unsupported', diagnostics };
      } else {
        model?.stopAllMotions?.();
      }
      if (!isCurrent()) return { status: 'cancelled', tierUsed: 'unsupported', diagnostics };
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
        renderer.render({ container: model, target: renderTexture, clear: true });
        return;
      }
      model?.render?.(renderer);
    },
    getConcreteModels: (model) => (model ? [model] : []),
    setSceneTime: (model, time, deltaMs) => (model as { setSceneTime?: (time: number, deltaMs?: number) => void }).setSceneTime?.(time, deltaMs),
    advanceFrame: (model, deltaMs) => {
      model?.update?.(deltaMs);
    },
    advanceMotionOnly: () => {
      // The native runtime advances motion queues inside its own update pass.
    },
    stepBakeFrame: (model, deltaMs, renderer, label, flushCore) => {
      model?.update?.(Math.max(0, deltaMs));
      this.controls.renderForBake(model, renderer ?? null, label, undefined);
      if (flushCore !== false) model?.syncInputParameters?.();
    },
    flushIdleState: async (model) => {
      model?.stopAllMotions?.();
      model?.update?.(16);
    },
    resetModelToIdle: async (model, options, isCurrent = () => true) => {
      if (!isCurrent()) return;
      model?.stopAllMotions?.();
      this.controls.clearMotionState(model);
      if (!isCurrent()) return;
      if (options?.idleSnapshot) {
        this.controls.applySnapshot(model, options.idleSnapshot as ModelSnapshot);
        console.log('[Live2D] Character restored from runtime idle snapshot.');
      }
      if (!options?.keepFocus) {
        const focusController = model?.internalModel?.focusController;
        focusController?.focus?.(0, 0, true);
      }
      if (isCurrent()) model?.update?.(16);
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
      // The timeline explicitly owns motion playback; idle remains stopped here.
    },
    hasMotionGroup: (model, motionKey) => {
      return !!model?.internalModel?.settings?.motions?.[motionKey]
        || (model?.getExternalPerformanceKeys?.('motion') ?? []).includes(motionKey);
    },
    startMotion: async (model, motionKey, priority, offsetSeconds, options) => {
      if (options?.isCurrent && !options.isCurrent()) return { ok: false, offsetReplayMs: 0, cancelled: true };
      const started = options?.isCurrent
        ? await model?.startMotion?.(motionKey, 0, priority, offsetSeconds, options.fadeInSeconds, options.isCurrent)
        : options?.fadeInSeconds !== undefined
          ? await model?.startMotion?.(motionKey, 0, priority, offsetSeconds, options.fadeInSeconds)
          : await model?.startMotion?.(motionKey, 0, priority, offsetSeconds);
      if (options?.isCurrent && !options.isCurrent()) return { ok: false, offsetReplayMs: 0, cancelled: true };
      return { ok: !!started, offsetReplayMs: 0 };
    },
    sampleMotion: async (model, motionKey, options) => {
      const targets = this.controls.getConcreteModels(model)
        .map((concrete) => concrete?.internalModel)
        .filter((internal): internal is { settings: unknown } => !!internal?.settings)
        .map((internal) => ({ kind: 'cubism3-plus' as const, settings: internal.settings }));
      const target = targets[0];
      if (!target) {
        return { status: 'unsupported', diagnostics: ['Cubism 3+ motion settings are unavailable.'] };
      }
      const parsed = await loadCubism3Motion(target, motionKey, undefined, { fps: options.fps });
      return {
        status: 'sampled',
        metadata: {
          durationSeconds: parsed.sourceDurationSeconds,
          fadeInSeconds: parsed.motion.derivedFrom.fadeInSeconds,
          fadeOutSeconds: parsed.motion.derivedFrom.fadeOutSeconds,
          hasNonParameterCurves: parsed.ignoredCurves.length > 0,
        },
        motion: parsed.motion,
        diagnostics: parsed.ignoredCurves.length > 0
          ? parsed.ignoredCurves.map((curve) => `Unsupported ${curve.target} curve: ${curve.id}`)
          : undefined,
      };
    },
    installCustomMotionStage: (model, input: Omit<InstallCustomMotionStageInput, 'targets'>) => {
      const targets = this.controls.getConcreteModels(model)
        .map((concrete) => {
          const internalModel = concrete?.internalModel;
          const coreModel = internalModel?.coreModel;
          if (!internalModel || !coreModel
            || typeof coreModel.getParameterCount !== 'function'
            || typeof coreModel.getParameterId !== 'function'
            || typeof coreModel.setParameterValueByIndex !== 'function') {
            return null;
          }

          const parameterIds: string[] = [];
          const indexById = new Map<string, number>();
          for (let index = 0; index < coreModel.getParameterCount(); index++) {
            const rawId = coreModel.getParameterId(index);
            const id = typeof rawId === 'string' ? rawId : resolveCubismParameterId(rawId);
            if (!id) continue;
            parameterIds.push(id);
            indexById.set(id, index);
          }

          return {
            internalModel,
            parameterTarget: {
              parameterIds: () => parameterIds,
              writeParameter: (parameterId: string, value: number) => {
                const index = indexById.get(parameterId);
                if (index !== undefined) coreModel.setParameterValueByIndex(index, value);
              },
            },
          };
        })
        .filter((target): target is NonNullable<typeof target> => target !== null);
      if (targets.length === 0) return null;
      const stage = installCustomMotionStage({ ...input, targets });
      if (!stage) return null;
      const parameterIds = input.getState()?.controlledParameterIds ?? [];
      const releases = this.controls.getConcreteModels(model)
        .map((concrete): (() => void) | undefined => concrete?.claimCustomMotionParameters?.(parameterIds))
        .filter((release): release is () => void => typeof release === 'function');
      return {
        setSceneTime: (time) => stage.setSceneTime(time),
        dispose: () => {
          stage.dispose();
          releases.forEach((release) => release());
        },
      };
    },
    quiesceModel: (model) => {
      this.controls.manageFocusAnimations(model, 'stop');
      model?.stopAllMotions?.();
      model?.setExpression?.(null);
    },
    disposeModel: (model, options) => {
      if (!model) return;
      this.controls.manageFocusAnimations(model, 'stop');
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
      // The model consumes injected runtime parameters immediately
      // before Core.update(); retain the character/bake entry it should read.
      model._characterEntry = options.injectedParamsSource;
    },
    prepareModelResources: () => {
      // Native Cubism 3+ models own their clipping buffers.
    },
    isolateMask: () => {
      // The vendor owns a clipping manager per model.
    },
    installBakeRenderGuards: () => {
      // The native vendor render pipe owns GL state restoration.
    },
    setBlink: (model, enabled, intervalMs = 4000, sceneTimeSeconds, startTimeSeconds, intervalRangeMs) => {
      if (intervalRangeMs !== undefined) {
        model?.setBlink?.(enabled, intervalMs, sceneTimeSeconds, startTimeSeconds, intervalRangeMs);
      } else {
        model?.setBlink?.(enabled, intervalMs, sceneTimeSeconds, startTimeSeconds);
      }
    },
    applyFocus: (model, input) => {
      for (const controller of this.controls.getFocusControllers(model)) applyRuntimeFocus(controller, input);
    },
    getFocusControllers: (model) => this.controls.getConcreteModels(model)
      .map((concrete) => concrete?.internalModel?.focusController)
      .filter(Boolean),
    manageFocusAnimations: (model, action) => manageRuntimeFocusAnimations(this.controls.getFocusControllers(model), action),
    getHeadAnchor: (model) => resolveHeadAnchorFromSettings(model?.internalModel?.settings),
    getAnchor: (model, anchor) => resolveCubismModelAnchor(model as CubismAnchorModel, anchor),
  };

  async init(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      await initCubismPixiSdk();
      await loadCubismEngineModule();
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

  createModelHandle(
    id: string,
    model: object,
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

  async createModel(modelUrl: string, options: Live2DModelCreateOptions = {}): Promise<Live2DModelDisplayObject> {
    if (!this.ready) {
      await this.init();
    }
    const { createCubismPixiModel } = await import('../CubismPixiModel');
    return createCubismPixiModel(modelUrl, options);
  }

  getUnsupportedMessage(modelPath: string): string | null {
    return getUnsupportedLive2DRuntimeMessage(modelPath, {
      runtimeFamily: 'cubism3-plus',
      adapterId: this.id,
      supported: this.supported,
    });
  }

  createFallbackModel(): Live2DModelDisplayObject | null {
    return null;
  }

  disposeBakeRenderTexture(): void {
    // Each native model releases its own bake RenderTexture on disposal.
  }
}
