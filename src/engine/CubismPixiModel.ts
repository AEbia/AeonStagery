import * as PIXI from 'pixi.js';
import { loadCubismEngineModule } from './Live2DEngineBridge';
import { captureModelSnapshot, type ModelSnapshot } from './Live2DConfig';
import type { Live2DModelCreateOptions, Live2DSeekRestoreInput, Live2DSeekRestoreResult } from './Live2DRuntimeAdapter';
import { createBlinkControlState, evaluateBlinkMultiplier } from './live2d/blinkController';

function parameterId(id: any): string {
  const value = typeof id === 'string' ? id : id?.getString?.();
  return typeof value === 'string' ? value : value?.s ?? '';
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

/** Adapt the native model to the engine's existing controls, without a second
 * canvas, texture upload, SDK checkout, or external shader directory.
 */
export function installCubismPixiModelRuntime(model: any): any {
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
  let renderedParameters: Float32Array | null = null;
  let bakeTexture: PIXI.RenderTexture | null = null;
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

  // Drawing may follow another model load before the next simulation tick.
  const originalRenderLive2D = model.renderLive2D?.bind(model);
  if (originalRenderLive2D) {
    model.renderLive2D = (renderer: any) => {
      refreshCubismCoreViews(core);
      originalRenderLive2D(renderer);
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
      for (let index = 0; index < core.getParameterCount(); index++) {
        const id = parameterId(core.getParameterId(index));
        if (id === 'ParamEyeLOpen' || id === 'ParamEyeROpen') {
          core.setParameterValueByIndex(index, core.getParameterValueByIndex(index) * multiplier);
        }
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
  model.preloadMotion = (group: string, index = 0) => manager.loadMotion(resolveGroup(group), index);
  model.getMotionDuration = (group: string, index = 0) => {
    const motion = manager.motionGroups[resolveGroup(group)]?.[index];
    return motion?._motionData?.duration ?? motion?.getDuration?.() ?? 0;
  };
  model.stopAllMotions = () => {
    manager.stopAllMotions();
    manager.playing = false;
    for (const parallel of internal.parallelMotionManager ?? []) parallel.stopAllMotions?.();
  };
  model.startMotion = async (key: string, index = 0, priority = 3, offsetSeconds = 0, fadeInSeconds?: number) => {
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
    const index = expressionManager.getExpressionIndex(key);
    if (index < 0) return;
    const expression = await expressionManager.loadExpression(index);
    if (disposed || epoch !== expressionEpoch || !expression) return;
    if (expressionManager.currentExpression === expression) expressionManager.restoreExpression();
    else await expressionManager.setExpression(index);
    if (disposed || epoch !== expressionEpoch) return;
    if (elapsedSeconds !== undefined) {
      const now = model.elapsedTime / 1000;
      for (const entry of queueEntries(expressionManager.queueManager)) {
        entry._motion.setupMotionQueueEntry(entry, now);
        entry.setStartTime(now - Math.max(0, elapsedSeconds));
        entry.setFadeInStartTime(now - Math.max(0, elapsedSeconds));
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
    refreshCubismCoreViews(core);
    if (snapshot.params) core.getParameterValues().set(snapshot.params.subarray(0, core.getParameterCount()));
    if (snapshot.opacities) internal.partOpacities.set(snapshot.opacities.subarray(0, internal.partOpacities.length));
    core.saveParameters();
    core.update();
  };
  model.restoreAtSceneTime = async (input: Live2DSeekRestoreInput): Promise<Live2DSeekRestoreResult> => {
    model.stopAllMotions();
    sceneTime = Math.max(0, input.targetSceneTime);
    const baseline = input.handoffSnapshot ?? input.idleSnapshot ?? input.snapshot;
    if (baseline) model.applyRuntimeSnapshot(baseline);
    const started = !input.motion || await model.startMotion(input.motion.key, 0, input.motion.priority ?? 3, input.motion.offset, input.motion.fadeInSeconds);
    await setExpression(input.expression?.key ?? input.snapshot?.expression?.key ?? null, input.motion?.offset ?? 0);
    model.update(0);
    return {
      status: started ? 'restored' : 'fallback',
      tierUsed: started ? 'native' : 'snapshot-forward',
      diagnostics: started ? [] : [`Motion "${input.motion?.key}" was not available.`],
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
  return installCubismPixiModelRuntime(model);
}
