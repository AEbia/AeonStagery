import * as PIXI from 'pixi.js';
import { loadCubismEngineModule } from './Live2DEngineBridge';
import { captureModelSnapshot, type ModelSnapshot } from './Live2DConfig';
import type { Live2DModelCreateOptions, Live2DSeekRestoreInput, Live2DSeekRestoreResult } from './runtime/Live2DRuntimeContracts';
import type { Live2DPerformanceMetadata, PerformanceCompatibility, PreparedAssetRef } from './runtime/Live2DRuntimeContracts';
import { createBlinkControlState, evaluateBlinkMultiplier } from './live2d/blinkController';

function parameterId(id: any): string {
  const value = typeof id === 'string' ? id : id?.getString?.();
  return typeof value === 'string' ? value : value?.s ?? '';
}

const CUBISM_STATE_REPLAY_STEP_MS = 1000 / 60;
const CUBISM_STATE_REPLAY_EPSILON_MS = 1e-6;

/**
 * Clear stateful Cubism 3+ subsystems before replaying from a scene snapshot.
 * Parameters/opacities are restored immediately after this reset, so Pose's
 * authored default selection cannot overwrite the seek handoff pose.
 */
function resetCubismStateForReplay(internal: any, core: any): void {
  const physics = internal?.physics;
  physics?.initialize?.();
  if (physics && typeof physics === 'object') {
    // CubismPhysics.initialize() resets particle positions but intentionally
    // keeps interpolation history for ordinary runtime use. Seek replay needs
    // a fresh integrator so the result cannot depend on a previous seek.
    if ('_currentRemainTime' in physics) physics._currentRemainTime = 0;
    for (const field of ['_currentRigOutputs', '_previousRigOutputs']) {
      const outputs = physics[field];
      const size = outputs?.getSize?.() ?? 0;
      for (let index = 0; index < size; index++) {
        const values = outputs.at(index)?.outputs;
        const valueSize = values?.getSize?.() ?? 0;
        for (let valueIndex = 0; valueIndex < valueSize; valueIndex++) values.set(valueIndex, 0);
      }
    }
  }
  internal?.pose?.reset?.(core);
  const focus = internal?.focusController;
  focus?.focus?.(0, 0, true);
  if (focus && typeof focus === 'object') {
    if ('vx' in focus) focus.vx = 0;
    if ('vy' in focus) focus.vy = 0;
  }
}

function replayCubismState(model: any, durationSeconds: number): void {
  let remainingMs = Math.max(0, durationSeconds * 1000);
  while (remainingMs > CUBISM_STATE_REPLAY_EPSILON_MS) {
    const stepMs = Math.min(CUBISM_STATE_REPLAY_STEP_MS, remainingMs);
    model.update(stepMs);
    remainingMs -= stepMs;
  }
}

/** The SDK caches native memory views. A second model may grow the shared heap. */
export function refreshCubismCoreViews(coreModel: any): void {
  const raw = coreModel?.getModel?.();
  const core = (globalThis as any).Live2DCubismCore ?? (typeof window !== 'undefined' ? window.Live2DCubismCore : null);
  if (typeof raw?._ptr !== 'number' || !core?.Parameters) return;
  const parameters = new core.Parameters(raw._ptr);
  if (raw.parameters?.values?.buffer === parameters.values.buffer) return;
  raw.parameters = parameters;
  raw.parts = new core.Parts(raw._ptr);
  raw.drawables = new core.Drawables(raw._ptr);
  if (core.Offscreens) raw.offscreens = new core.Offscreens(raw._ptr);
  raw.canvasinfo = new core.CanvasInfo(raw._ptr);
  if (raw.renderOrders) {
    raw.renderOrders = new Int32Array(parameters.values.buffer, raw.renderOrders.byteOffset, raw.renderOrders.length);
  }
  coreModel._parameterValues = parameters.values;
  coreModel._parameterMinimumValues = parameters.minimumValues;
  coreModel._parameterMaximumValues = parameters.maximumValues;
  coreModel._partOpacities = raw.parts.opacities;
  if (raw.offscreens) coreModel._offscreenOpacities = raw.offscreens.opacities;
}

function queueEntries(queue: any): any[] {
  const entries = queue?.getCubismMotionQueueEntries?.();
  if (Array.isArray(entries)) return entries;
  return Array.from({ length: entries?.getSize?.() ?? 0 }, (_, index) => entries.at(index));
}

type CubismExternalEngine = {
  Live2DCubismFramework?: {
    CubismMotion?: { create: (buffer: ArrayBuffer, size: number) => any };
    CubismExpressionMotion?: { create: (buffer: ArrayBuffer, size: number) => any };
  };
  [key: string]: unknown;
};

function modelParameterIds(core: any): Set<string> {
  const ids = new Set<string>();
  const count = core?.getParameterCount?.() ?? 0;
  for (let index = 0; index < count; index++) ids.add(parameterId(core.getParameterId(index)));
  return ids;
}

function externalParameterIds(kind: 'motion' | 'expression', value: any): string[] {
  if (kind === 'motion') {
    const curves = value?._motionData?.curves;
    const list = Array.isArray(curves)
      ? curves
      : Array.from({ length: curves?.getSize?.() ?? 0 }, (_, index) => curves.at(index));
    return list.map((curve: any) => parameterId(curve?.id)).filter(Boolean);
  }
  const parameters = value?.getExpressionParameters?.();
  const list = Array.isArray(parameters)
    ? parameters
    : Array.from({ length: parameters?.getSize?.() ?? 0 }, (_, index) => parameters.at(index));
  return list.map((entry: any) => parameterId(entry?.parameterId)).filter(Boolean);
}

function compatibilityForExternal(
  kind: 'motion' | 'expression',
  value: any,
  core: any,
  metadata?: Live2DPerformanceMetadata,
): PerformanceCompatibility {
  const available = modelParameterIds(core);
  const referenced = [...new Set(externalParameterIds(kind, value))];
  const required = metadata?.requiredParameterIds ?? [];
  const missingParameterIds = required.filter((id) => !available.has(id));
  const ignoredParameterIds = referenced.filter((id) => !available.has(id));
  const diagnostics = ignoredParameterIds.length
    ? [`${kind} references unknown parameter ids: ${ignoredParameterIds.join(', ')}.`]
    : [];
  if (missingParameterIds.length && !metadata?.allowPartial) {
    diagnostics.unshift(`Missing required parameter ids: ${missingParameterIds.join(', ')}.`);
    return { status: 'incompatible', missingParameterIds, ignoredParameterIds, diagnostics };
  }
  return {
    status: missingParameterIds.length || ignoredParameterIds.length ? 'partial' : 'compatible',
    missingParameterIds,
    ignoredParameterIds,
    diagnostics,
  };
}

/** Adapt the native model to the engine's existing controls, without a second
 * canvas, texture upload, SDK checkout, or external shader directory.
 */
export function installCubismPixiModelRuntime(model: any, suppliedEngine?: CubismExternalEngine): any {
  const internal = model.internalModel;
  const core = internal.coreModel;
  const manager = internal.motionManager;
  const expressionManager = manager.expressionManager;
  let disposed = false;
  let expressionEpoch = 0;
  let expressionKey: string | null = null;
  let sceneTime = 0;
  let blink = createBlinkControlState(false);
  const sourceFadeIns = new WeakMap<object, number>();
  const sourceCurveFadeIns = new WeakMap<object, number[]>();
  const externalMotions = new Map<string, any>();
  const externalExpressions = new Map<string, any>();
  let enginePromise: Promise<CubismExternalEngine> | null = suppliedEngine ? Promise.resolve(suppliedEngine) : null;
  let renderedParameters: Float32Array | null = null;
  let bakeTexture: PIXI.RenderTexture | null = null;
  let motionUpdateTime: number | null = null;
  let motionUpdated = false;
  const originalUpdateMotions = internal.updateMotions.bind(internal);
  internal.updateMotions = (target: any, now: number) => {
    if (motionUpdateTime === now) {
      // The SDK saves the blended motion pose as the next frame's baseline.
      // Blending it again at the same timestamp would finish a paused fade.
      // Keep stage hooks running so parameter edits can still be displayed.
      internal.emit('beforeMotionUpdate');
      internal.emit('afterMotionUpdate');
      return motionUpdated;
    }
    motionUpdateTime = now;
    motionUpdated = originalUpdateMotions(target, now);
    return motionUpdated;
  };
  // The timeline owns idle playback and blink; never let the vendor choose
  // random idle motions or run a second, nondeterministic eye-blink channel.
  internal.eyeBlink = undefined;
  manager.getSoundFile = () => undefined;
  manager.state.shouldOverrideExpression = () => false;
  manager.state.shouldRequestIdleMotion = () => false;
  manager.groups.idle = '__aeon_manual_idle__';
  core.getParameterIds = () => Array.from({ length: core.getParameterCount() }, (_, i) => parameterId(core.getParameterId(i)));
  core.getParameterValues = () => core._parameterValues ?? core.getModel().parameters.values;
  // Newer Core versions moved render orders from Drawables to Model and
  // include offscreen objects after the drawable entries. The vendor's
  // drawable-only renderer still requires contiguous drawable ranks.
  core.getDrawableRenderOrders = () => {
    const raw = core.getModel();
    if (raw.drawables.renderOrders) return raw.drawables.renderOrders;
    const orders: Int32Array = raw.getRenderOrders();
    const count: number = raw.drawables.count;
    if (orders.length === count) return orders;
    const indices = Array.from({ length: count }, (_, i) => i)
      .sort((a, b) => orders[a] - orders[b]);
    const ranks = new Int32Array(count);
    indices.forEach((index, rank) => { ranks[index] = rank; });
    return ranks;
  };
  Object.defineProperties(internal, {
    parameterValues: { configurable: true, get: () => core.getParameterValues() },
    partOpacities: { configurable: true, get: () => core._partOpacities ?? core.getModel().parts.opacities },
  });
  const configuredBlinkIds = internal.settings.getEyeBlinkParameters?.() ?? [];
  const blinkIds = new Set<string>(configuredBlinkIds.length
    ? configuredBlinkIds.map(parameterId)
    : ['ParamEyeLOpen', 'ParamEyeROpen', 'PARAM_EYE_L_OPEN', 'PARAM_EYE_R_OPEN']);
  const blinkIndices = Array.from({ length: core.getParameterCount() }, (_, index) => index)
    .filter((index) => blinkIds.has(parameterId(core.getParameterId(index))));

  // Native GL drawing bypasses Pixi's color uniforms. Apply the current pass's
  // opacity here, including its render-group root, without accumulating fades
  // in the SDK color or multiplying the timeline's AlphaFilter a second time.
  const originalRenderLive2D = model.renderLive2D?.bind(model);
  if (originalRenderLive2D) {
    model.renderLive2D = (renderer: any) => {
      refreshCubismCoreViews(core);
      const color = internal.renderer.getModelColor();
      const worldColor = renderer.globalUniforms.globalUniformData.worldColor ?? 0xffffffff;
      const worldAlpha = (worldColor >>> 24) / 255;
      const groupAlpha = model.renderGroup ? 1 : model.groupAlpha;
      internal.renderer.setModelColor(color.r, color.g, color.b, color.a * groupAlpha * worldAlpha);
      try {
        originalRenderLive2D(renderer);
      } finally {
        internal.renderer.setModelColor(color.r, color.g, color.b, color.a);
      }
    };
  }

  const writeParameter = (id: string, value: number) => {
    for (let index = 0; index < core.getParameterCount(); index++) {
      if (parameterId(core.getParameterId(index)) === id) {
        core.setParameterValueByIndex(index, value);
        return;
      }
    }
  };
  // Preserve the previous runtime's authored head/body pose and deterministic
  // breath channel. Vendor idle head/body oscillation would change that pose.
  internal.updateNaturalMovements = () => {
    writeParameter('ParamBreath', 0.5 + 0.5 * Math.sin(sceneTime * Math.PI * 2 / 3.2345));
  };
  const beforeCoreUpdate = () => {
    const multiplier = evaluateBlinkMultiplier(sceneTime, blink);
    if (blink.enabled) {
      for (const index of blinkIndices) {
        core.setParameterValueByIndex(index, core.getParameterValueByIndex(index) * multiplier);
      }
    }
    for (const [id, value] of Object.entries(model._characterEntry?.injectedParams ?? {})) {
      if (typeof value === 'number' && Number.isFinite(value)) writeParameter(id, value);
    }
    renderedParameters = new Float32Array(core.getParameterValues());
  };
  internal.on('beforeModelUpdate', beforeCoreUpdate);
  const originalUpdate = model.update.bind(model);
  model.update = (deltaMs: number) => {
    if (disposed || !Number.isFinite(deltaMs) || deltaMs < 0) return;
    refreshCubismCoreViews(core);
    originalUpdate(deltaMs);
    sceneTime += deltaMs / 1000;
    blink.sceneTimeSeconds = sceneTime;
    core.loadParameters();
    internal.update(model.deltaTime, model.elapsedTime);
    // Native rendering normally advances simulation. We have already done
    // that for seek/cache/bake consumers; drawing must not advance it twice.
    model.deltaTime = 0;
    const values = core.getParameterValues();
    if (renderedParameters) values.set(renderedParameters);
  };
  const resolveGroup = (key: string): string => {
    if (manager.definitions[key]) return key;
    const leaf = key.split('/').at(-1);
    const matches = Object.keys(manager.definitions).filter((group) => group.split('/').at(-1) === leaf);
    return matches.length === 1 ? matches[0] : key;
  };
  const loadExternalEngine = async (): Promise<CubismExternalEngine> => {
    enginePromise ??= loadCubismEngineModule().then((loaded) => loaded as CubismExternalEngine);
    return enginePromise;
  };
  const registerExternalPerformance = async (
    kind: 'motion' | 'expression',
    runtimeKey: string,
    source: PreparedAssetRef,
    metadata?: Live2DPerformanceMetadata,
  ): Promise<PerformanceCompatibility> => {
    const incompatible = (diagnostic: string): PerformanceCompatibility => ({
      status: 'incompatible', missingParameterIds: [], ignoredParameterIds: [], diagnostics: [diagnostic],
    });
    if (!source.runtimeUri || source.unavailable) return incompatible(`Failed to fetch external ${kind} "${runtimeKey}": runtime URI is unavailable.`);
    if (kind === 'expression' && !expressionManager) {
      return incompatible(`Cannot register external expression "${runtimeKey}": this model has no expression manager.`);
    }
    let bytes: ArrayBuffer;
    try {
      const response = await fetch(source.runtimeUri);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bytes = await response.arrayBuffer();
    } catch (error) {
      return incompatible(`Failed to fetch external ${kind} "${runtimeKey}": ${String(error)}`);
    }
    try {
      const definition = {
        File: source.source,
        FadeInTime: metadata?.fadeIn ?? 0,
        FadeOutTime: metadata?.fadeOut ?? 0,
        Sound: metadata?.sound,
      };
      const managerValue = kind === 'motion'
        ? manager.createMotion?.(bytes, runtimeKey, definition)
        : expressionManager?.createExpression?.(bytes, undefined);
      let value = managerValue;
      if (!value) {
        const engine = await loadExternalEngine();
        const framework = engine.Live2DCubismFramework;
        const factory = kind === 'motion' ? framework?.CubismMotion : framework?.CubismExpressionMotion;
        value = factory?.create?.(bytes, bytes.byteLength);
      }
      if (!value) return incompatible(`Failed to parse external ${kind} "${runtimeKey}": Cubism ${kind} factory is unavailable.`);
      if (metadata?.fadeIn !== undefined) value.setFadeInTime?.(metadata.fadeIn);
      if (metadata?.fadeOut !== undefined) value.setFadeOutTime?.(metadata.fadeOut);
      if (kind === 'motion' && metadata?.loop !== undefined) value.setIsLoop?.(metadata.loop);
      const compatibility = compatibilityForExternal(kind, value, core, metadata);
      if (compatibility.status === 'incompatible') return compatibility;
      model.unregisterExternalPerformance?.(runtimeKey);
      (kind === 'motion' ? externalMotions : externalExpressions).set(runtimeKey, value);
      return compatibility;
    } catch (error) {
      return incompatible(`Failed to parse external ${kind} "${runtimeKey}": ${String(error)}`);
    }
  };
  model.registerExternalMotion = (runtimeKey: string, source: PreparedAssetRef, metadata?: Live2DPerformanceMetadata) =>
    registerExternalPerformance('motion', runtimeKey, source, metadata);
  model.registerExternalExpression = (runtimeKey: string, source: PreparedAssetRef, metadata?: Live2DPerformanceMetadata) =>
    registerExternalPerformance('expression', runtimeKey, source, metadata);
  model.unregisterExternalPerformance = (runtimeKey: string) => {
    const motion = externalMotions.get(runtimeKey);
    const expression = externalExpressions.get(runtimeKey);
    if (motion && queueEntries(manager.queueManager).some((entry) => entry?._motion === motion)) manager.stopAllMotions();
    if (expression && expressionManager) {
      if (queueEntries(expressionManager.queueManager).some((entry) => entry?._motion === expression)) {
        expressionManager.stopAllExpressions();
      }
      if (expressionManager.currentExpression === expression) expressionManager.resetExpression();
    }
    externalMotions.delete(runtimeKey);
    externalExpressions.delete(runtimeKey);
  };
  model.getExternalPerformanceKeys = (kind?: 'motion' | 'expression'): string[] => {
    if (kind === 'motion') return [...externalMotions.keys()];
    if (kind === 'expression') return [...externalExpressions.keys()];
    return [...new Set([...externalMotions.keys(), ...externalExpressions.keys()])];
  };
  model.preloadMotion = (group: string, index = 0) => {
    const external = externalMotions.get(group);
    return external ? Promise.resolve(external) : manager.loadMotion(resolveGroup(group), index);
  };
  model.getMotionDuration = (group: string, index = 0) => {
    const external = externalMotions.get(group);
    if (external) return external._motionData?.duration ?? external.getDuration?.() ?? 0;
    const motion = manager.motionGroups[resolveGroup(group)]?.[index];
    return motion?._motionData?.duration ?? motion?.getDuration?.() ?? 0;
  };
  model.stopAllMotions = () => {
    motionUpdateTime = null;
    manager.stopAllMotions();
    manager.playing = false;
    for (const parallel of internal.parallelMotionManager ?? []) parallel.stopAllMotions?.();
  };
  model.startMotion = async (key: string, index = 0, priority = 3, offsetSeconds = 0, fadeInSeconds?: number) => {
    const external = externalMotions.get(key);
    if (external) {
      if (disposed) return false;
      if (fadeInSeconds !== undefined) external.setFadeInTime?.(fadeInSeconds);
      model.stopAllMotions();
      const queue = manager.queueManager;
      const handle = queue?.startMotion?.(external, false);
      const entry = queueEntries(queue).find((candidate) => candidate?._motion === external)
        ?? queue?.getCubismMotionQueueEntry?.(handle);
      if (!entry) return false;
      const now = model.elapsedTime / 1000;
      external.setupMotionQueueEntry?.(entry, now);
      const start = now - Math.max(0, Number.isFinite(offsetSeconds) ? offsetSeconds : 0);
      entry.setStartTime?.(start);
      entry.setFadeInStartTime?.(start);
      if (!external.isLoop?.()) entry.setEndTime?.(start + model.getMotionDuration(key, index));
      entry.setLastCheckEventSeconds?.(start);
      manager.playing = true;
      if (manager.state) {
        manager.state.currentGroup = key;
        manager.state.currentIndex = index;
        manager.state.currentPriority = priority;
      }
      return true;
    }
    const group = resolveGroup(key);
    const motion = await model.preloadMotion(group, index);
    if (!motion || disposed) return false;
    if (!sourceFadeIns.has(motion)) sourceFadeIns.set(motion, motion.getFadeInTime());
    const override = typeof fadeInSeconds === 'number' && Number.isFinite(fadeInSeconds) && fadeInSeconds >= 0;
    motion.setFadeInTime(override ? fadeInSeconds : sourceFadeIns.get(motion));
    // Per-curve fades take precedence over the motion fade in the SDK.
    const curves = motion._motionData?.curves;
    const curveList = Array.isArray(curves) ? curves : Array.from({ length: curves?.getSize?.() ?? 0 }, (_, i) => curves.at(i));
    if (!sourceCurveFadeIns.has(motion)) sourceCurveFadeIns.set(motion, curveList.map((curve: any) => curve.fadeInTime));
    curveList.forEach((curve: any, i: number) => {
      curve.fadeInTime = override ? -1 : sourceCurveFadeIns.get(motion)![i];
      curve.fadeOutTime = 0;
    });
    motion.setFadeOutTime(0);
    motion.setOffsetTime(0);
    model.stopAllMotions();
    const started = await manager.startMotion(group, index, priority, { loop: false, resetExpression: false });
    if (!started || disposed) return false;
    const entry = queueEntries(manager.queueManager).find((candidate) => candidate?._motion === motion);
    if (!entry) {
      model.stopAllMotions();
      return false;
    }
    const now = model.elapsedTime / 1000;
    motion.setupMotionQueueEntry(entry, now);
    const start = now - Math.max(0, Number.isFinite(offsetSeconds) ? offsetSeconds : 0);
    entry.setStartTime(start);
    entry.setFadeInStartTime(start);
    entry.setEndTime?.(start + model.getMotionDuration(group, index));
    entry.setLastCheckEventSeconds(start);
    return true;
  };
  const setExpression = async (key: string | null, elapsedSeconds?: number) => {
    // The character API and inspector use an empty string to clear expressions.
    key = key || null;
    const epoch = ++expressionEpoch;
    expressionKey = key;
    if (!expressionManager) return;
    expressionManager.reserveExpressionIndex = -1;
    if (key === null || elapsedSeconds !== undefined) {
      expressionManager.stopAllExpressions();
      expressionManager.currentExpression = expressionManager.defaultExpression;
      expressionManager.resetExpression();
    }
    if (key === null) return;
    const external = externalExpressions.get(key);
    if (external) {
      const queue = expressionManager.queueManager;
      queue?.stopAllMotions?.();
      expressionManager.currentExpression = external;
      const handle = queue?.startMotion?.(external, false);
      const entry = queueEntries(queue).find((candidate) => candidate?._motion === external)
        ?? queue?.getCubismMotionQueueEntry?.(handle);
      if (entry) {
        const now = model.elapsedTime / 1000;
        external.setupMotionQueueEntry?.(entry, now);
        const elapsed = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds!) : Math.max(0, external.getFadeInTime?.() ?? 0);
        entry.setStartTime?.(now - elapsed);
        entry.setFadeInStartTime?.(now - elapsed);
      }
      return;
    }
    const index = expressionManager.getExpressionIndex(key);
    if (index < 0) return;
    const expression = await expressionManager.loadExpression(index);
    if (disposed || epoch !== expressionEpoch || !expression) return;
    if (expressionManager.currentExpression === expression) expressionManager.restoreExpression();
    else await expressionManager.setExpression(index);
    if (disposed || epoch !== expressionEpoch) return;
    if (elapsedSeconds !== undefined) {
      const now = model.elapsedTime / 1000;
      // A legacy state without a start timestamp requests the final latch.
      // Keep queue timestamps finite so subsequent playback remains valid.
      const elapsed = Number.isFinite(elapsedSeconds)
        ? Math.max(0, elapsedSeconds)
        : Math.max(0, expression.getFadeInTime());
      for (const entry of queueEntries(expressionManager.queueManager)) {
        entry._motion.setupMotionQueueEntry(entry, now);
        entry.setStartTime(now - elapsed);
        entry.setFadeInStartTime(now - elapsed);
      }
    }
  };
  model.setExpression = (key: string | null) => {
    void setExpression(key).catch((error) => { if (!disposed) console.warn('[Live2D] Expression load failed:', error); });
  };
  model.setExpressionForSeek = setExpression;
  model.setBlink = (enabled: boolean, intervalMs = 4000, at = sceneTime, startTime?: number, range?: number) => {
    blink = {
      enabled,
      intervalMs,
      intervalRangeMs: range ?? blink.intervalRangeMs,
      sceneTimeSeconds: at,
      startTimeSeconds: startTime ?? (enabled && !blink.enabled ? at : blink.startTimeSeconds),
    };
    sceneTime = at;
  };
  model.syncInputParameters = () => { refreshCubismCoreViews(core); core.update(); };
  model.captureRuntimeSnapshot = (_id: string, motionStartTime?: number): ModelSnapshot | null => {
    refreshCubismCoreViews(core);
    const captured = captureModelSnapshot(_id, model, motionStartTime);
    if (captured) captured.expression = { key: expressionKey };
    return captured;
  };
  model.applyRuntimeSnapshot = (snapshot: Pick<ModelSnapshot, 'params' | 'opacities'>) => {
    motionUpdateTime = null;
    refreshCubismCoreViews(core);
    if (snapshot.params) core.getParameterValues().set(snapshot.params.subarray(0, core.getParameterCount()));
    if (snapshot.opacities) internal.partOpacities.set(snapshot.opacities.subarray(0, internal.partOpacities.length));
    core.saveParameters();
    core.update();
  };
  model.restoreAtSceneTime = async (input: Live2DSeekRestoreInput): Promise<Live2DSeekRestoreResult> => {
    model.stopAllMotions();
    const offsetSeconds = input.motion?.offset ?? input.expression?.elapsedSeconds ?? 0;
    sceneTime = Math.max(0, input.targetSceneTime - (Number.isFinite(offsetSeconds) ? offsetSeconds : 0));
    resetCubismStateForReplay(internal, core);
    const baseline = input.handoffSnapshot ?? input.idleSnapshot ?? input.snapshot;
    if (baseline) model.applyRuntimeSnapshot(baseline);
    const focus = internal?.focusController;
    focus?.focus?.(input.focus?.[0] ?? 0, input.focus?.[1] ?? 0, true);
    const started = !input.motion || await model.startMotion(input.motion.key, 0, input.motion.priority ?? 3, 0, input.motion.fadeInSeconds);
    const key = input.expression !== undefined
      ? input.expression?.key ?? null
      : input.snapshot?.expression?.key ?? null;
    const expressionElapsed = input.expression?.elapsedSeconds;
    await setExpression(key, expressionElapsed === undefined ? Number.POSITIVE_INFINITY : 0);
    if (input.motion && Number.isFinite(input.motion.offset) && input.motion.offset > 0) {
      replayCubismState(model, input.motion.offset);
    } else if (Number.isFinite(expressionElapsed) && expressionElapsed !== undefined && expressionElapsed > 0) {
      replayCubismState(model, expressionElapsed);
    } else {
      model.update(0);
    }
    return {
      status: started ? 'restored' : 'fallback',
      tierUsed: started ? 'state-replay' : 'snapshot-forward',
      diagnostics: started
        ? []
        : [`Motion "${input.motion?.key}" was not available.`],
    };
  };
  model.renderForBake = (renderer: any, target?: PIXI.RenderTexture) => {
    if (!renderer?.render) return;
    if (!target) {
      bakeTexture ??= PIXI.RenderTexture.create({ width: 512, height: 512 });
      target = bakeTexture;
    }
    renderer.render({ container: model, target, clear: true });
  };
  const originalDestroy = model.destroy.bind(model);
  model.destroy = (options: any) => {
    if (disposed) return;
    disposed = true;
    expressionEpoch++;
    externalMotions.clear();
    externalExpressions.clear();
    internal.off('beforeModelUpdate', beforeCoreUpdate);
    bakeTexture?.destroy(true);
    bakeTexture = null;
    originalDestroy(options);
  };
  return model;
}

export async function createCubismPixiModel(modelUrl: string, options: Live2DModelCreateOptions): Promise<any> {
  const engine = await loadCubismEngineModule();
  const model = await engine.Live2DModel.from(modelUrl, { ...options, autoUpdate: false, autoFocus: false, autoHitTest: false, idleMotionGroup: '__aeon_manual_idle__', eyeBlink: false });
  return installCubismPixiModelRuntime(model, engine);
}
