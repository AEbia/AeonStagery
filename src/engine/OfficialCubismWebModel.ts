// @ts-nocheck
import * as PIXI from 'pixi.js';
import { CubismModelSettingJson } from '@cubism/cubismmodelsettingjson';
import type { ICubismModelSetting } from '@cubism/icubismmodelsetting';
import { CubismUserModel } from '@cubism/model/cubismusermodel';
import { CubismMatrix44 } from '@cubism/math/cubismmatrix44';
import { resolveOfficialCubismWebSpriteLayout } from './OfficialCubismWebGeometry';
import { ensureOfficialCubismWebDrawPipe } from './OfficialCubismWebDrawPipe';
import {
  registerOfficialCubismWebPreviewTarget,
  unregisterOfficialCubismWebPreviewTarget,
} from './OfficialCubismWebPreview';
import type { ModelSnapshot } from './Live2DConfig';
import type { Live2DSeekRestoreInput, Live2DSeekRestoreResult } from './Live2DRuntimeAdapter';
import type { StagePreviewResolution } from '../api/interfaces/IStageAdapter';
import { createBlinkControlState, evaluateBlinkMultiplier } from './live2d/blinkController';

const SHADER_PATH = '/vendor/cubism-web/Shaders/WebGL/';
const INITIAL_RENDER_SURFACE_SIZE = 2048;

type TextureInfo = {
  texture: WebGLTexture;
  image: HTMLImageElement | ImageBitmap;
};

function dirname(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index + 1);
}

function joinAssetUrl(baseDir: string, childPath: string): string {
  if (/^(asset|file|https?):\/\//.test(childPath)) return childPath;
  return `${baseDir}${childPath}`.replace(/\\/g, '/');
}

// Cubism Core can replace its WASM heap while creating another model. Its
// existing JS typed arrays keep pointing at the old heap, including the
// Framework's parameter aliases and the raw drawable geometry arrays.
const activeOfficialModels = new Set<OfficialCubismUserModel>();
const CUBISM_BREATH_PERIOD_SECONDS = 3.2345;
const CUBISM_BREATH_PARAMETER_IDS = new Set(['ParamBreath', 'PARAM_BREATH']);

function resolveCubismParameterId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof (value as { getString?: () => string }).getString === 'function') {
    return (value as { getString: () => string }).getString();
  }
  return value == null ? null : String(value);
}

export class OfficialCubismUserModel extends CubismUserModel {
  public modelSetting: ICubismModelSetting | null = null;
  public modelHomeDir = '';
  public ready = false;
  public texturesReady = false;
  public readonly textureInfos: TextureInfo[] = [];
  public readonly expressions = new Set<string>();
  public readonly motions = new Set<string>();
  public readonly expressionState = {
    currentGroup: undefined as string | undefined,
    reservedGroup: undefined as string | undefined,
    queue: [] as unknown[],
  };
  public readonly motionState = {
    currentGroup: undefined as string | undefined,
    reservedGroup: undefined as string | undefined,
    queue: [] as unknown[],
  };

  private readonly motionDefinitions = new Map<string, Array<{ file: string; index: number }>>();
  private readonly expressionDefinitions = new Map<string, { file: string }>();
  private readonly motionCache = new Map<string, Array<any | null>>();
  private readonly sourceMotionFadeInTimes = new WeakMap<object, number>();
  private readonly motionLoadPromises = new Map<string, Promise<any | null>>();
  private readonly expressionCache = new Map<string, any>();
  private readonly eyeBlinkParameterIds: any[] = [];
  private readonly lipSyncParameterIds: any[] = [];
  private blinkControl = createBlinkControlState(false);
  private userTimeSeconds = 0;
  private breathingTimeSeconds = 0;
  private breathParameterIndex: number | null = null;

  async loadFromModelJson(modelUrl: string): Promise<void> {
    this.breathingTimeSeconds = 0;
    this.breathParameterIndex = null;
    const response = await fetch(modelUrl);
    if (!response.ok) {
      throw new Error(`无法读取模型配置：${modelUrl}`);
    }
    const modelBuffer = await response.arrayBuffer();
    const parsedModelJson = JSON.parse(new TextDecoder().decode(modelBuffer));
    const setting = new CubismModelSettingJson(modelBuffer, modelBuffer.byteLength);
    this.modelSetting = setting;
    this.modelHomeDir = dirname(modelUrl);

    const mocPath = setting.getModelFileName();
    if (!mocPath) {
      throw new Error(`模型缺少 Moc 引用：${modelUrl}`);
    }

    const mocResponse = await fetch(joinAssetUrl(this.modelHomeDir, mocPath));
    if (!mocResponse.ok) {
      throw new Error(`无法读取 Moc 文件：${joinAssetUrl(this.modelHomeDir, mocPath)}`);
    }
    const mocBuffer = await mocResponse.arrayBuffer();
    this.loadModel(mocBuffer);
    for (const activeModel of activeOfficialModels) {
      activeModel.refreshCoreMemoryViews();
    }
    this.refreshCoreMemoryViews();

    const layout = new Map<string, number>();
    if (setting.getLayoutMap(layout)) {
      this.getModelMatrix()?.setupFromLayout(layout);
    }

    this.collectEffectIds(setting);
    this.collectExpressions(setting, parsedModelJson);
    this.collectMotions(setting, parsedModelJson);
    await this.preloadExpressions(setting);
    await this.loadOptionalPhysics(setting);
    await this.loadOptionalPose(setting);
    this.syncMotionState();
    this.syncExpressionState();

    // Another model may have expanded Core memory during an asynchronous
    // resource fetch above. Register only after loading succeeds.
    this.refreshCoreMemoryViews();
    this.ready = true;
    activeOfficialModels.add(this);
  }

  async bindTextures(gl: WebGLRenderingContext | WebGL2RenderingContext): Promise<void> {
    if (!this.modelSetting) {
      throw new Error('模型配置尚未加载。');
    }
    if (!this.getModel()) {
      throw new Error('Cubism 模型尚未创建。');
    }

    const textureCount = this.modelSetting.getTextureCount();
    this.createRenderer(gl.canvas.width, gl.canvas.height);
    this.getRenderer().startUp(gl);
    this.getRenderer().loadShaders(SHADER_PATH);

    for (let i = 0; i < textureCount; i++) {
      const textureFile = this.modelSetting.getTextureFileName(i);
      if (!textureFile) continue;

      const image = await this.loadImage(joinAssetUrl(this.modelHomeDir, textureFile));
      const texture = gl.createTexture();
      if (!texture) throw new Error(`无法为贴图创建 WebGLTexture：${textureFile}`);

      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      this.getRenderer().bindTexture(i, texture);
      this.textureInfos[i] = { texture, image };
    }

    this.getRenderer().setIsPremultipliedAlpha(true);
    this.texturesReady = true;
  }

  updateFrame(deltaMs: number, injectedParams?: Readonly<Record<string, number>>): void {
    if (!this.ready || !this.getModel()) return;
    const deltaTimeSeconds = Math.max(0, deltaMs) / 1000;
    this.userTimeSeconds += deltaTimeSeconds;

    const coreModel = this.getModel();
    coreModel.loadParameters?.();

    if (this._motionManager && !this._motionManager.isFinished()) {
      this._motionManager.updateMotion(coreModel, deltaTimeSeconds);
    }

    coreModel.saveParameters?.();

    if (this._expressionManager) {
      this._expressionManager.updateMotion(coreModel, deltaTimeSeconds);
    }
    // Match the official Cubism update order: natural movement runs after
    // authored motion and expressions, before physics and pose evaluation.
    this.applyPersistentBreathing(coreModel, deltaTimeSeconds);
    if (this._physics) {
      this._physics.evaluate(coreModel, deltaTimeSeconds);
    }
    if (this._pose) {
      this._pose.updateParameters(coreModel, deltaTimeSeconds);
    }

    this.applyBlink(coreModel);
    this.blinkControl.sceneTimeSeconds += deltaTimeSeconds;

    // Runtime effects such as audio lip sync are written to the character's
    // injected parameter map between frames. Apply them after motion,
    // expression, physics and blink evaluation so they reach Core's vertex
    // update for this frame without becoming the next motion baseline.
    if (injectedParams && typeof coreModel.setParameterValueByIndex === 'function') {
      const parameterCount = coreModel.getParameterCount?.() ?? 0;
      for (let index = 0; index < parameterCount; index++) {
        const parameterId = resolveCubismParameterId(coreModel.getParameterId?.(index));
        const value = parameterId ? injectedParams[parameterId] : undefined;
        if (typeof value === 'number' && Number.isFinite(value)) {
          coreModel.setParameterValueByIndex(index, value);
        }
      }
    }

    coreModel.update();
    this.syncMotionState();
    this.syncExpressionState();
  }

  private applyPersistentBreathing(coreModel: any, deltaTimeSeconds: number): void {
    if (this.breathParameterIndex === null) {
      this.breathParameterIndex = this.findBreathParameterIndex(coreModel);
    }
    if (this.breathParameterIndex < 0 || typeof coreModel?.setParameterValueByIndex !== 'function') {
      return;
    }

    this.breathingTimeSeconds += deltaTimeSeconds;
    const value = 0.5 + 0.5 * Math.sin(
      (this.breathingTimeSeconds * Math.PI * 2) / CUBISM_BREATH_PERIOD_SECONDS,
    );
    coreModel.setParameterValueByIndex(this.breathParameterIndex, value);
  }

  setBreathingSceneTime(sceneTimeSeconds: number): void {
    if (!Number.isFinite(sceneTimeSeconds)) return;
    this.breathingTimeSeconds = Math.max(0, sceneTimeSeconds);
  }

  setBlink(
    enabled: boolean,
    intervalMs = 4000,
    sceneTimeSeconds = this.userTimeSeconds,
    startTimeSeconds?: number,
    intervalRangeMs?: number,
  ): void {
    const resolvedStartTime = Number.isFinite(startTimeSeconds)
      ? (startTimeSeconds as number)
      : (enabled && !this.blinkControl.enabled ? sceneTimeSeconds : this.blinkControl.startTimeSeconds);
    const resolvedRangeMs = Number.isFinite(intervalRangeMs)
      ? (intervalRangeMs as number)
      : (this.blinkControl.intervalRangeMs ?? 0);
    this.blinkControl = createBlinkControlState(
      enabled,
      intervalMs,
      sceneTimeSeconds,
      resolvedStartTime,
      resolvedRangeMs,
    );
    this.applyBlink(this.getModel());
  }

  private applyBlink(coreModel: any): void {
    if (!coreModel || this.eyeBlinkParameterIds.length === 0) return;
    const multiplier = evaluateBlinkMultiplier(
      this.blinkControl.sceneTimeSeconds,
      this.blinkControl,
    );
    for (const parameterId of this.eyeBlinkParameterIds) {
      const current = Number(coreModel.getParameterValueById?.(parameterId));
      if (!Number.isFinite(current)) continue;
      coreModel.setParameterValueById?.(parameterId, current * multiplier);
    }
  }

  private findBreathParameterIndex(coreModel: any): number {
    const parameterIds = coreModel?.getParameterIds?.();
    const parameterCount = Number(
      coreModel?.getParameterCount?.() ?? parameterIds?.length ?? 0,
    );
    if (!Number.isFinite(parameterCount) || parameterCount <= 0) return -1;

    for (let index = 0; index < parameterCount; index++) {
      const parameterId = resolveCubismParameterId(coreModel.getParameterId?.(index));
      if (parameterId && CUBISM_BREATH_PARAMETER_IDS.has(parameterId)) return index;
    }

    if (parameterIds && typeof parameterIds.length === 'number') {
      for (let index = 0; index < Math.min(parameterCount, parameterIds.length); index++) {
        const parameterId = resolveCubismParameterId(parameterIds[index]);
        if (parameterId && CUBISM_BREATH_PARAMETER_IDS.has(parameterId)) return index;
      }
    }

    return -1;
  }

  drawFrame(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!this.texturesReady || !this.getRenderer() || !this.getModel()) return;
    const projection = new CubismMatrix44();
    projection.loadIdentity();
    const modelMatrix = this.getModelMatrix();
    if (!modelMatrix) return;
    projection.multiplyByMatrix(modelMatrix);
    this.getRenderer().setRenderState(null as any, [0, 0, gl.canvas.width, gl.canvas.height]);
    this.getRenderer().setMvpMatrix(projection);
    this.getRenderer().drawModel(SHADER_PATH);
  }

  override release(): void {
    activeOfficialModels.delete(this);
    this.ready = false;
    this.texturesReady = false;
    this.motionLoadPromises.clear();
    this.motionCache.clear();
    this.expressionCache.clear();
    super.release();
  }

  private refreshCoreMemoryViews(): void {
    const sdkModel = this.getModel();
    const rawModel = sdkModel?.getModel?.();
    const core = (globalThis as any).Live2DCubismCore;
    if (typeof rawModel?._ptr !== 'number' || !core?.Parameters) return;

    const parameters = new core.Parameters(rawModel._ptr);
    if (rawModel.parameters?.values?.buffer === parameters.values.buffer) return;

    const parts = new core.Parts(rawModel._ptr);
    const drawables = new core.Drawables(rawModel._ptr);
    const offscreens = new core.Offscreens(rawModel._ptr);
    const previousRenderOrders = rawModel.renderOrders;
    rawModel.parameters = parameters;
    rawModel.parts = parts;
    rawModel.drawables = drawables;
    rawModel.offscreens = offscreens;
    rawModel.canvasinfo = new core.CanvasInfo(rawModel._ptr);
    if (previousRenderOrders) {
      rawModel.renderOrders = new Int32Array(
        parameters.values.buffer,
        previousRenderOrders.byteOffset,
        previousRenderOrders.length,
      );
    }

    // CubismModel caches these views in initialize(); replacing only the raw
    // Core structs would leave motion writes on the abandoned heap.
    sdkModel._parameterValues = parameters.values;
    sdkModel._parameterMaximumValues = parameters.maximumValues;
    sdkModel._parameterMinimumValues = parameters.minimumValues;
    sdkModel._partOpacities = parts.opacities;
    sdkModel._offscreenOpacities = offscreens.opacities;
  }

  async preloadMotion(group: string, index: number = 0): Promise<any | null> {
    if (!this.modelSetting) return null;

    const cacheKey = `${group}:${index}`;
    const cachedMotion = this.motionCache.get(group)?.[index] ?? null;
    if (cachedMotion) return cachedMotion;

    const pending = this.motionLoadPromises.get(cacheKey);
    if (pending) return pending;

    const task = (async () => {
      const motionFile = this.motionDefinitions.get(group)?.find((definition) => definition.index === index)?.file;
      if (!motionFile) return null;

      const buffer = await this.fetchArrayBuffer(joinAssetUrl(this.modelHomeDir, motionFile));
      const motion = this.loadMotion(
        buffer,
        buffer.byteLength,
        `${group}_${index}`,
        undefined,
        undefined,
        this.modelSetting ?? undefined,
        group,
        index,
      );
      if (!motion) return null;

      motion.setEffectIds?.(this.eyeBlinkParameterIds, this.lipSyncParameterIds);
      let groupMotions = this.motionCache.get(group);
      if (!groupMotions) {
        groupMotions = [];
        this.motionCache.set(group, groupMotions);
      }
      groupMotions[index] = motion;
      return motion;
    })();

    this.motionLoadPromises.set(cacheKey, task);
    try {
      return await task;
    } finally {
      this.motionLoadPromises.delete(cacheKey);
    }
  }

  async startMotion(
    group: string,
    index: number = 0,
    priority: number = 3,
    offsetSeconds: number = 0,
    fadeInSeconds?: number,
  ): Promise<boolean> {
    // Authoring/catalog keys may omit the bundle namespace. Resolve a unique
    // leaf here as well as in the manager so direct runtime calls (seek/bake)
    // use the same concrete group.
    if (!this.motionDefinitions.has(group)) {
      const leaf = group.split('/').at(-1) ?? group;
      const matches = Array.from(this.motionDefinitions.keys()).filter((candidate) =>
        (candidate.split('/').at(-1) ?? candidate) === leaf,
      );
      if (matches.length === 1) group = matches[0];
    }
    const motion = await this.preloadMotion(group, index);
    if (!motion || !this._motionManager) {
      this.syncMotionState();
      return false;
    }

    // Scene playback owns the motion's terminal state: once an authored
    // motion reaches its last curve sample, the character must hold that
    // pose until another action takes over. Cubism's exported FadeOutTime
    // otherwise blends the motion back toward the saved baseline immediately
    // before the queue entry finishes, which appears as a flashback to the
    // original pose on Cubism 3+/4/5 models.
    if (!this.sourceMotionFadeInTimes.has(motion) && typeof motion.getFadeInTime === 'function') {
      this.sourceMotionFadeInTimes.set(motion, motion.getFadeInTime());
    }
    const sourceFadeInSeconds = this.sourceMotionFadeInTimes.get(motion);
    const effectiveFadeInSeconds = typeof fadeInSeconds === 'number' && Number.isFinite(fadeInSeconds) && fadeInSeconds >= 0
      ? fadeInSeconds
      : sourceFadeInSeconds;
    if (effectiveFadeInSeconds !== undefined) {
      motion.setFadeInTime?.(effectiveFadeInSeconds);
    }
    motion.setFadeOutTime?.(0);
    motion.setOffsetTime?.(offsetSeconds);
    motion.setBeganMotionHandler?.(() => {
      this.motionState.currentGroup = group;
      this.syncMotionState();
    });
    motion.setFinishedMotionHandler?.(() => {
      if (this.motionState.currentGroup === group) {
        this.motionState.currentGroup = undefined;
      }
      this.syncMotionState();
    });

    this.motionState.reservedGroup = group;
    this._motionManager.setReservePriority?.(priority);
    const startMotionPriority = this._motionManager.startMotionPriority;
    if (typeof startMotionPriority !== 'function') {
      this.motionState.reservedGroup = undefined;
      this.syncMotionState();
      return false;
    }

    const motionQueueEntryHandle = startMotionPriority.call(this._motionManager, motion, false, priority);
    let motionQueueEntry = this._motionManager.getCubismMotionQueueEntry?.(motionQueueEntryHandle);
    if (!motionQueueEntry) {
      const entries = this._motionManager.getCubismMotionQueueEntries?.();
      if (Array.isArray(entries) && entries.length > 0) {
        motionQueueEntry = entries[entries.length - 1];
      }
    }
    if (!motionQueueEntry) {
      this._motionManager.stopAllMotions?.();
      this.motionState.reservedGroup = undefined;
      this.syncMotionState();
      return false;
    }

    if (typeof motion.setupMotionQueueEntry === 'function') {
      // Cubism's offset only shifts the curve time. Its default lazy queue
      // setup still starts fade-in at the current SDK time, which makes every
      // seeked frame render the baseline pose with ~0 motion weight. Prime the
      // entry as if it had started `offsetSeconds` ago so both the curve and
      // fade state represent the requested scene time on the first update.
      const runtimeUserTime = Number.isFinite(this._motionManager._userTimeSeconds)
        ? this._motionManager._userTimeSeconds
        : this.userTimeSeconds;
      const normalizedOffset = Number.isFinite(offsetSeconds) ? Math.max(0, offsetSeconds) : 0;
      motion.setupMotionQueueEntry(motionQueueEntry, runtimeUserTime);
      const motionStartTime = runtimeUserTime - normalizedOffset;
      motionQueueEntry.setStartTime?.(motionStartTime);
      motionQueueEntry.setFadeInStartTime?.(motionStartTime);
      motionQueueEntry.setLastCheckEventSeconds?.(motionStartTime);
    }
    this.motionState.currentGroup = group;
    this.motionState.reservedGroup = undefined;
    this.syncMotionState();
    return true;
  }

  async evaluateMotionAtOffset(group: string, index: number, priority: number, offsetSeconds: number): Promise<boolean> {
    const started = await this.startMotion(group, index, priority, 0);
    if (!started) return false;

    const totalMs = Math.max(0, offsetSeconds * 1000);
    let elapsedMs = 0;
    while (elapsedMs < totalMs) {
      const stepMs = Math.min(16.666, totalMs - elapsedMs);
      this.updateFrame(stepMs);
      elapsedMs += stepMs;
    }
    if (totalMs === 0) {
      this.updateFrame(0.001);
    }
    return true;
  }

  async startMotionAtOffset(
    group: string,
    index: number,
    priority: number,
    offsetSeconds: number,
    fadeInSeconds?: number,
  ): Promise<boolean> {
    return this.startMotion(group, index, priority, offsetSeconds, fadeInSeconds);
  }

  stopAllMotions(): void {
    this._motionManager?.stopAllMotions?.();
    this.motionState.currentGroup = undefined;
    this.motionState.reservedGroup = undefined;
    this.syncMotionState();
  }

  setExpression(expressionName: string | null): void {
    if (!this._expressionManager) return;

    if (!expressionName) {
      this._expressionManager.stopAllMotions?.();
      this.expressionState.currentGroup = undefined;
      this.expressionState.reservedGroup = undefined;
      this.syncExpressionState();
      return;
    }

    const motion = this.expressionCache.get(expressionName);
    if (!motion) return;

    this.expressionState.reservedGroup = expressionName;
    this._expressionManager.startMotion(motion, false);
    this.expressionState.currentGroup = expressionName;
    this.expressionState.reservedGroup = undefined;
    this.syncExpressionState();
  }

  getMotionDuration(group: string, index: number = 0): number {
    const motion = this.motionCache.get(group)?.[index];
    const duration = motion?.getDuration?.();
    return typeof duration === 'number' && Number.isFinite(duration) ? Math.max(0, duration) : 0;
  }

  isMotionPlaying(): boolean {
    return !!this._motionManager && !this._motionManager.isFinished();
  }

  private collectExpressions(setting: ICubismModelSetting, rawJson?: any): void {
    this.expressions.clear();
    this.expressionDefinitions.clear();
    for (let i = 0; i < setting.getExpressionCount(); i++) {
      const name = setting.getExpressionName(i);
      if (!name) continue;
      this.expressions.add(name);
      this.expressionDefinitions.set(name, {
        file: setting.getExpressionFileName(i),
      });
    }

    // Keep the source JSON as a fallback. Some WebGAL model3 files contain
    // namespaced expression entries that older CubismModelSettingJson builds
    // fail to enumerate even though the entries are valid.
    const rawExpressions = rawJson?.FileReferences?.Expressions;
    if (Array.isArray(rawExpressions)) {
      for (const expression of rawExpressions) {
        const name = expression?.Name ?? expression?.name;
        const file = expression?.File ?? expression?.file;
        if (typeof name === 'string' && name && typeof file === 'string' && file) {
          this.expressions.add(name);
          if (!this.expressionDefinitions.has(name)) {
            this.expressionDefinitions.set(name, { file });
          }
        }
      }
    }
  }

  private collectMotions(setting: ICubismModelSetting, rawJson?: any): void {
    this.motions.clear();
    this.motionDefinitions.clear();
    const groupCount = setting.getMotionGroupCount();
    for (let i = 0; i < groupCount; i++) {
      const groupName = setting.getMotionGroupName(i);
      if (!groupName) continue;
      this.motions.add(groupName);
      const definitions: Array<{ file: string; index: number }> = [];
      const motionCount = setting.getMotionCount(groupName);
      for (let motionIndex = 0; motionIndex < motionCount; motionIndex++) {
        const file = setting.getMotionFileName(groupName, motionIndex);
        if (file) {
          definitions.push({ file, index: motionIndex });
        }
      }
      this.motionDefinitions.set(groupName, definitions);
    }

    // The raw FileReferences map is the authoritative source for WebGAL
    // model3 bundles. Merge it after SDK enumeration so a parser that omits a
    // namespaced group (or one of its entries) cannot make that action
    // impossible to play.
    const rawMotions = rawJson?.FileReferences?.Motions;
    if (rawMotions && typeof rawMotions === 'object') {
      for (const [groupName, rawEntries] of Object.entries(rawMotions)) {
        if (typeof groupName !== 'string' || !groupName) continue;
        this.motions.add(groupName);
        const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
        const existing = this.motionDefinitions.get(groupName) ?? [];
        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index] as any;
          const file = entry?.File ?? entry?.file;
          if (typeof file !== 'string' || !file) continue;
          if (!existing.some((definition) => definition.index === index)) {
            existing.push({ file, index });
          }
        }
        existing.sort((left, right) => left.index - right.index);
        this.motionDefinitions.set(groupName, existing);
      }
    }
  }

  getMotionSettings(): Record<string, Array<{ file: string; index: number }>> {
    const motions: Record<string, Array<{ file: string; index: number }>> = {};
    for (const [group, definitions] of this.motionDefinitions.entries()) {
      motions[group] = definitions.map((definition) => ({ ...definition }));
    }
    return motions;
  }

  getExpressionSettings(): Record<string, { file: string }> {
    const expressions: Record<string, { file: string }> = {};
    for (const [name, definition] of this.expressionDefinitions.entries()) {
      expressions[name] = { ...definition };
    }
    return expressions;
  }

  private async preloadExpressions(setting: ICubismModelSetting): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < setting.getExpressionCount(); i++) {
      const expressionName = setting.getExpressionName(i);
      const expressionFile = setting.getExpressionFileName(i);
      if (!expressionName || !expressionFile) continue;

      tasks.push((async () => {
        const buffer = await this.fetchArrayBuffer(joinAssetUrl(this.modelHomeDir, expressionFile));
        const motion = this.loadExpression(buffer, buffer.byteLength, expressionName);
        if (motion) {
          this.expressionCache.set(expressionName, motion);
        }
      })());
    }
    await Promise.all(tasks);
  }

  private async loadOptionalPhysics(setting: ICubismModelSetting): Promise<void> {
    const physicsFile = setting.getPhysicsFileName();
    if (!physicsFile) return;

    const buffer = await this.fetchArrayBuffer(joinAssetUrl(this.modelHomeDir, physicsFile));
    this.loadPhysics(buffer, buffer.byteLength);
  }

  private async loadOptionalPose(setting: ICubismModelSetting): Promise<void> {
    const poseFile = setting.getPoseFileName();
    if (!poseFile) return;

    const buffer = await this.fetchArrayBuffer(joinAssetUrl(this.modelHomeDir, poseFile));
    this.loadPose(buffer, buffer.byteLength);
  }

  private collectEffectIds(setting: ICubismModelSetting): void {
    this.eyeBlinkParameterIds.length = 0;
    for (let i = 0; i < setting.getEyeBlinkParameterCount(); i++) {
      const id = setting.getEyeBlinkParameterId(i);
      if (id) this.eyeBlinkParameterIds.push(id);
    }

    if (this.eyeBlinkParameterIds.length === 0) {
      const coreModel = this.getModel();
      const count = Number(coreModel?.getParameterCount?.() ?? 0);
      const candidates = new Set(['ParamEyeLOpen', 'ParamEyeROpen', 'PARAM_EYE_L_OPEN', 'PARAM_EYE_R_OPEN']);
      for (let i = 0; i < count; i++) {
        const rawId = coreModel.getParameterId?.(i);
        const idStr = typeof rawId === 'string' ? rawId : rawId?.getString?.() ?? rawId?.toString?.();
        if (idStr && candidates.has(idStr)) {
          this.eyeBlinkParameterIds.push(idStr);
        }
      }
    }

    this.lipSyncParameterIds.length = 0;
    for (let i = 0; i < setting.getLipSyncParameterCount(); i++) {
      const id = setting.getLipSyncParameterId(i);
      if (id) this.lipSyncParameterIds.push(id);
    }
  }

  private syncMotionState(): void {
    this.motionState.queue = this._motionManager?.getCubismMotionQueueEntries?.() ?? [];
    if (!this.isMotionPlaying()) {
      this.motionState.currentGroup = undefined;
      this.motionState.reservedGroup = undefined;
    }
  }

  private syncExpressionState(): void {
    this.expressionState.queue = this._expressionManager?.getCubismMotionQueueEntries?.() ?? [];
    if (!this.expressionState.queue.length) {
      this.expressionState.currentGroup = undefined;
      this.expressionState.reservedGroup = undefined;
    }
  }

  private async fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`无法读取资源：${url}`);
    }
    return response.arrayBuffer();
  }

  private async loadImage(url: string): Promise<HTMLImageElement | ImageBitmap> {
    if (typeof createImageBitmap === 'function') {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`无法读取贴图：${url}`);
      }
      return createImageBitmap(await response.blob());
    }

    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`无法读取贴图：${url}`));
      image.src = url;
    });
  }
}

export class OfficialCubismWebModelInstance extends PIXI.Container {
  public readonly internalModel: {
    coreModel: any;
    parameterValues: Float32Array;
    partOpacities: Float32Array;
    motionManager: {
      state: {
        currentGroup?: string;
        reservedGroup?: string;
        queue: unknown[];
      };
      playing: boolean;
      loadMotion: (group: string, index?: number) => Promise<any | null>;
      startMotion: (group: string, index?: number, priority?: number, offsetSeconds?: number) => Promise<boolean>;
      stopAllMotions: () => void;
      expressionManager: {
        state: {
          currentGroup?: string;
          reservedGroup?: string;
          queue: unknown[];
        };
        stopAllMotions: () => void;
      };
    };
    physics: any;
    pose: any;
    settings: {
      motions: Record<string, Array<{ file: string; index: number }>>;
      expressions: Record<string, { file: string }>;
    };
  };
  public readonly anchor: PIXI.ObservablePoint;
  public autoUpdate = false;
  public readonly modelUrl: string;

  private readonly sprite: PIXI.Sprite;
  private readonly canvasTexture: PIXI.Texture;
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGLRenderingContext | WebGL2RenderingContext;
  private readonly model: OfficialCubismUserModel;
  private displayWidth = 1;
  private displayHeight = 1;
  private previewResolution: StagePreviewResolution = 1;
  private released = false;

  private constructor(
    modelUrl: string,
    model: OfficialCubismUserModel,
    canvas: HTMLCanvasElement,
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ) {
    super();
    this.modelUrl = modelUrl;
    this.model = model;
    this.canvas = canvas;
    this.gl = gl;
    this.canvasTexture = PIXI.Texture.from(canvas);
    this.sprite = new PIXI.Sprite(this.canvasTexture);
    this.sprite.anchor.set(0, 0);
    this.anchor = new PIXI.ObservablePoint({
      _onUpdate: () => this.applySpriteLayout(),
    }, 0.5, 0.9);
    this.displayWidth = canvas.width;
    this.displayHeight = canvas.height;
    this.applySpriteLayout();
    this.addChild(this.sprite);

    const coreModel = model.getModel();
    const parameterValues = new Float32Array(coreModel?.getParameterCount?.() ?? 0);
    for (let i = 0; i < parameterValues.length; i++) {
      parameterValues[i] = coreModel.getParameterValueByIndex(i);
    }
    const partOpacities = new Float32Array(coreModel?.getPartCount?.() ?? 0);
    for (let i = 0; i < partOpacities.length; i++) {
      partOpacities[i] = coreModel.getPartOpacityByIndex(i);
    }
    const motionManager = {
      state: model.motionState,
      get playing() {
        return model.isMotionPlaying();
      },
      loadMotion: (group: string, index: number = 0) => model.preloadMotion(group, index),
      startMotion: (group: string, index: number = 0, priority: number = 3, offsetSeconds: number = 0, fadeInSeconds?: number) =>
        fadeInSeconds !== undefined
          ? model.startMotion(group, index, priority, offsetSeconds, fadeInSeconds)
          : model.startMotion(group, index, priority, offsetSeconds),
      stopAllMotions: () => model.stopAllMotions(),
      expressionManager: {
        state: model.expressionState,
        stopAllMotions: () => model.setExpression(null),
      },
    };

    this.internalModel = {
      coreModel,
      parameterValues,
      partOpacities,
      motionManager,
      physics: (model as any)._physics ?? null,
      pose: (model as any)._pose ?? null,
      settings: {
        motions: model.getMotionSettings(),
        expressions: model.getExpressionSettings(),
      },
    };

    registerOfficialCubismWebPreviewTarget(this);
  }

  static async create(modelUrl: string): Promise<OfficialCubismWebModelInstance> {
    const canvas = document.createElement('canvas');
    canvas.width = INITIAL_RENDER_SURFACE_SIZE;
    canvas.height = INITIAL_RENDER_SURFACE_SIZE;
    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    }) ?? canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });

    if (!gl) {
      throw new Error('当前环境无法为官方 Cubism Web runtime 创建 WebGL 上下文。');
    }

    const model = new OfficialCubismUserModel();
    await model.loadFromModelJson(modelUrl);
    await model.bindTextures(gl);

    const instance = new OfficialCubismWebModelInstance(modelUrl, model, canvas, gl);
    instance.update(16);
    instance.drawToCanvas();
    instance.refreshTexture();
    return instance;
  }

  override get width(): number {
    return this.displayWidth * Math.abs(this.scale.x || 1);
  }

  override set width(value: number) {
    if (!Number.isFinite(value) || value <= 0) return;
    const scaleX = Math.abs(this.scale.x || 1);
    this.displayWidth = value / (scaleX || 1);
    this.applySpriteLayout();
  }

  override get height(): number {
    return this.displayHeight * Math.abs(this.scale.y || 1);
  }

  override set height(value: number) {
    if (!Number.isFinite(value) || value <= 0) return;
    const scaleY = Math.abs(this.scale.y || 1);
    this.displayHeight = value / (scaleY || 1);
    this.applySpriteLayout();
  }

  update(deltaMs: number): void {
    if (this.released) return;
    this.model.updateFrame(deltaMs, (this as any)._characterEntry?.injectedParams);
    this.syncInternalState();
  }

  setBlink(
    enabled: boolean,
    intervalMs = 4000,
    sceneTimeSeconds?: number,
    startTimeSeconds?: number,
    intervalRangeMs?: number,
  ): void {
    this.model.setBlink(enabled, intervalMs, sceneTimeSeconds, startTimeSeconds, intervalRangeMs);
  }

  /**
   * v8 render-pass boundary (replaces the dead v7 `render(renderer)` override).
   *
   * PixiJS 8 removed `Container.render()`/`_render()` — `Container.prototype.render`
   * is `undefined`, so the v7 override ran zero times per live frame (the sprite
   * below kept painting the stale canvas upload) and any explicit call into it
   * died on `super.render(renderer)`. v8 instead executes an instruction tree
   * once per render pass; we push this wrapper's canvas refresh through the
   * dedicated draw pipe immediately before our sprite children are collected,
   * which reproduces the v7 cadence exactly (once per pass, culled wrappers
   * skipped) for the live stage pass, the bake composition pass and filter
   * passes alike. See ./OfficialCubismWebDrawPipe.ts for the seam details.
   */
  collectRenderables(instructionSet: any, renderer: any, currentLayer: any): void {
    // Mirror the culling guard from v8's Container collectRenderables mixin so
    // an invisible/culled wrapper does not keep driving offscreen GL draws.
    if ((this.parentRenderLayer && this.parentRenderLayer !== currentLayer)
      || this.globalDisplayStatus < 7
      || !this.includeInBuild) {
      return;
    }
    // A promoted render group rebuilds from its own root below
    // (collectRenderablesWithEffects) — skipping the outer add keeps the draw
    // instruction at exactly one per pass.
    if (!this.renderGroup) {
      ensureOfficialCubismWebDrawPipe(renderer)?.addDraw(this, instructionSet);
    }
    super.collectRenderables(instructionSet, renderer, currentLayer);
  }

  /**
   * v8 builds the instruction tree of a render-pass ROOT straight from this
   * method (AbstractRenderer.render promotes the container to a render group),
   * never via collectRenderables — so a wrapper passed directly to
   * renderer.render() (single-model bake passes) also needs the seam here.
   * Only act as the group's root: as an effect-carrying child, this method is
   * reached from collectRenderables, which already added the instruction.
   */
  collectRenderablesWithEffects(instructionSet: any, renderer: any, currentLayer: any): void {
    if (this.renderGroup && this.renderGroup.root === this) {
      ensureOfficialCubismWebDrawPipe(renderer)?.addDraw(this, instructionSet);
    }
    super.collectRenderablesWithEffects(instructionSet, renderer, currentLayer);
  }

  /**
   * The per-render-pass work the v7 `render()` override used to perform before
   * delegating to the container subtree: redraw the model on the private GL
   * canvas and flag the canvas texture dirty so the sprite that follows this
   * instruction uploads the fresh pixels. Executed by OfficialCubismWebDrawPipe.
   *
   * The Cubism canvas keeps a fixed logical display size, while its drawing
   * buffer follows the preview quality. The renderer target size is updated
   * together with the canvas so Cubism can recreate its internal render
   * targets lazily on the next draw.
   */
  drawForRenderPass(_renderer: PIXI.Renderer): void {
    if (this.released || !this.hasRenderableCanvasTexture()) return;
    this.drawToCanvas();
    this.refreshTexture();
    if (!this.hasRenderableCanvasTexture()) return;
    this.sprite.alpha = 1;
    this.sprite.rotation = 0;
  }

  renderForBake(_renderer: PIXI.Renderer): void {
    if (this.released || !this.hasRenderableCanvasTexture()) return;
    this.drawToCanvas();
    this.refreshTexture();
  }

  setPreviewResolution(resolution: StagePreviewResolution): void {
    if (this.released) return;
    const nextResolution = resolution === 1 || resolution === 0.5 || resolution === 0.25
      ? resolution
      : 1;
    if (nextResolution === this.previewResolution) return;

    this.previewResolution = nextResolution;
    const size = Math.max(1, Math.round(INITIAL_RENDER_SURFACE_SIZE * nextResolution));
    this.resizeRenderSurface(size, size);
  }

  private drawToCanvas(): void {
    if (this.released) return;
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.model.drawFrame(this.gl);
  }

  private resizeRenderSurface(width: number, height: number): void {
    if (this.canvas.width === width && this.canvas.height === height) return;

    this.canvas.width = width;
    this.canvas.height = height;
    this.model.getRenderer()?.setRenderTargetSize?.(width, height);
    this.gl.viewport(0, 0, width, height);
  }

  override destroy(options?: PIXI.IDestroyOptions | boolean): void {
    if (this.released) return;
    this.released = true;
    unregisterOfficialCubismWebPreviewTarget(this);
    try {
      this.model.release();
    } finally {
      this.removeChild(this.sprite);
      this.sprite.destroy({ children: false, texture: false, textureSource: false });
      this.canvasTexture.destroy(true);
      super.destroy({ children: false, texture: false, textureSource: false });
    }
  }

  private refreshTexture(): void {
    if (!this.hasRenderableCanvasTexture()) return;
    // The canvas dimensions are physical pixels, while Pixi sprite layout is
    // expressed in the model's fixed logical 2048x2048 surface. Passing the
    // physical dimensions as logical texture dimensions makes the sprite's
    // local scale change whenever preview quality changes. Keep the logical
    // size stable and express preview quality through texture resolution.
    this.canvasTexture.source.resize(
      INITIAL_RENDER_SURFACE_SIZE,
      INITIAL_RENDER_SURFACE_SIZE,
      this.previewResolution,
    );
    this.canvasTexture.source.update();
    this.applySpriteLayout();
  }

  private applySpriteLayout(): void {
    if (!this.sprite) return;
    const layout = resolveOfficialCubismWebSpriteLayout(
      this.anchor?.x ?? 0.5,
      this.anchor?.y ?? 0.9,
      this.displayWidth,
      this.displayHeight,
    );
    this.sprite.width = layout.width;
    this.sprite.height = layout.height;
    this.sprite.position.set(layout.x, layout.y);
  }

  private hasRenderableCanvasTexture(): boolean {
    const texture = this.sprite?.texture;
    const textureSource = texture?.source;
    return !!texture
      && !!textureSource
      && !(texture as any).destroyed
      && !(textureSource as any).destroyed;
  }

  syncInputParameters(): void {
    this.syncInternalState();
  }

  captureRuntimeSnapshot(id: string, motionStartTime?: number): ModelSnapshot | null {
    const coreModel = this.model.getModel();
    if (!coreModel) return null;

    this.syncInternalState();
    const motionGroup = this.internalModel.motionManager.state.currentGroup;
    const expressionGroup = this.internalModel.motionManager.expressionManager.state.currentGroup;
    return {
      runtimeFamily: 'cubism3-plus',
      adapterId: 'official-cubism-web',
      params: new Float32Array(this.internalModel.parameterValues),
      opacities: new Float32Array(this.internalModel.partOpacities),
      motion: motionGroup ? { key: motionGroup, startTime: motionStartTime ?? 0 } : undefined,
      expression: { key: expressionGroup ?? null },
      motionState: {
        currentGroup: this.internalModel.motionManager.state.currentGroup,
        reservedGroup: this.internalModel.motionManager.state.reservedGroup,
        queueLength: this.internalModel.motionManager.state.queue.length,
      },
      expressionState: {
        currentGroup: this.internalModel.motionManager.expressionManager.state.currentGroup,
        reservedGroup: this.internalModel.motionManager.expressionManager.state.reservedGroup,
        queueLength: this.internalModel.motionManager.expressionManager.state.queue.length,
      },
      position: { x: this.x, y: this.y },
      scale: { x: this.scale.x, y: this.scale.y },
      rotation: this.rotation,
      alpha: this.alpha,
    };
  }

  applyRuntimeSnapshot(snapshot: Pick<ModelSnapshot, 'params' | 'opacities'>): void {
    const coreModel = this.model.getModel();
    if (!coreModel) return;

    if (snapshot.params) {
      const length = Math.min(coreModel.getParameterCount?.() ?? 0, snapshot.params.length);
      for (let i = 0; i < length; i++) {
        coreModel.setParameterValueByIndex?.(i, snapshot.params[i]);
        this.internalModel.parameterValues[i] = snapshot.params[i];
      }
      // updateFrame begins by loading the SDK's saved motion parameters.
      // Commit the restored baseline there too, otherwise the first seek or
      // playback frame replaces it with the previous motion's pose.
      coreModel.saveParameters?.();
    }

    if (snapshot.opacities) {
      const length = Math.min(coreModel.getPartCount?.() ?? 0, snapshot.opacities.length);
      for (let i = 0; i < length; i++) {
        coreModel.setPartOpacityByIndex?.(i, snapshot.opacities[i]);
        this.internalModel.partOpacities[i] = snapshot.opacities[i];
      }
    }

    coreModel.update?.();
    this.syncInternalState();
  }

  refreshAfterSeek(): void {
    this.syncInternalState();
    this.drawToCanvas();
    this.refreshTexture();
  }

  async restoreAtSceneTime(input: Live2DSeekRestoreInput): Promise<Live2DSeekRestoreResult> {
    const diagnostics: string[] = [];

    try {
      this.model.stopAllMotions();
      this.model.setBreathingSceneTime?.(input.targetSceneTime);
      const baseline = input.handoffSnapshot ?? input.idleSnapshot ?? input.snapshot;
      if (baseline) {
        this.applyRuntimeSnapshot(baseline);
      }

      if (input.motion) {
        const started = input.motion.fadeInSeconds !== undefined
          ? await this.model.startMotionAtOffset(
            input.motion.key,
            input.motion.index ?? 0,
            input.motion.priority ?? 3,
            input.motion.offset,
            input.motion.fadeInSeconds,
          )
          : await this.model.startMotionAtOffset(
            input.motion.key,
            input.motion.index ?? 0,
            input.motion.priority ?? 3,
            input.motion.offset,
          );
        if (!started) diagnostics.push(`Motion "${input.motion.key}" was not available.`);
      } else {
        this.model.stopAllMotions();
      }

      this.model.setExpression(input.expression?.key ?? input.snapshot?.expression?.key ?? null);
      this.model.updateFrame(0.001);
      this.refreshAfterSeek();

      return {
        status: diagnostics.length ? 'fallback' : 'restored',
        tierUsed: diagnostics.length ? 'snapshot-forward' : 'native',
        diagnostics,
      };
    } catch (err) {
      diagnostics.push(err instanceof Error ? err.message : String(err));
      this.drawToCanvas();
      this.refreshTexture();
      return {
        status: 'fallback',
        tierUsed: 'visual-freeze',
        diagnostics,
      };
    }
  }

  startMotion(
    group: string,
    index: number = 0,
    priority: number = 3,
    offsetSeconds: number = 0,
    fadeInSeconds?: number,
  ): Promise<boolean> {
    return fadeInSeconds !== undefined
      ? this.model.startMotion(group, index, priority, offsetSeconds, fadeInSeconds)
      : this.model.startMotion(group, index, priority, offsetSeconds);
  }

  startMotionAtOffset(
    group: string,
    index: number = 0,
    priority: number = 3,
    offsetSeconds: number = 0,
    fadeInSeconds?: number,
  ): Promise<boolean> {
    return fadeInSeconds !== undefined
      ? this.model.startMotionAtOffset(group, index, priority, offsetSeconds, fadeInSeconds)
      : this.model.startMotionAtOffset(group, index, priority, offsetSeconds);
  }

  preloadMotion(group: string, index: number = 0): Promise<any | null> {
    return this.model.preloadMotion(group, index);
  }

  setExpression(expressionName: string | null): void {
    this.model.setExpression(expressionName);
    this.syncInternalState();
  }

  stopAllMotions(): void {
    this.model.stopAllMotions();
    this.syncInternalState();
  }

  getMotionDuration(group: string, index: number = 0): number {
    return this.model.getMotionDuration(group, index);
  }

  private syncInternalState(): void {
    const coreModel = this.model.getModel();
    if (!coreModel) return;

    const parameterCount = coreModel.getParameterCount?.() ?? 0;
    if (this.internalModel.parameterValues.length !== parameterCount) {
      this.internalModel.parameterValues = new Float32Array(parameterCount);
    }
    for (let i = 0; i < parameterCount; i++) {
      this.internalModel.parameterValues[i] = coreModel.getParameterValueByIndex(i);
    }

    const partCount = coreModel.getPartCount?.() ?? 0;
    if (this.internalModel.partOpacities.length !== partCount) {
      this.internalModel.partOpacities = new Float32Array(partCount);
    }
    for (let i = 0; i < partCount; i++) {
      this.internalModel.partOpacities[i] = coreModel.getPartOpacityByIndex(i);
    }

    this.internalModel.motionManager.state.queue = this.model.motionState.queue;
    this.internalModel.motionManager.state.currentGroup = this.model.motionState.currentGroup;
    this.internalModel.motionManager.state.reservedGroup = this.model.motionState.reservedGroup;
    this.internalModel.motionManager.expressionManager.state.queue = this.model.expressionState.queue;
    this.internalModel.motionManager.expressionManager.state.currentGroup = this.model.expressionState.currentGroup;
    this.internalModel.motionManager.expressionManager.state.reservedGroup = this.model.expressionState.reservedGroup;
    this.internalModel.physics = (this.model as any)._physics ?? null;
    this.internalModel.pose = (this.model as any)._pose ?? null;
  }
}
