/**
 * AeonStagery — Live2D Manager
 *
 * Manages loading, displaying, and controlling multiple Live2D Cubism 2.1 models
 * simultaneously. Each character on stage is an independent model instance.
 *
 * Uses pixi-live2d-display with cubism2 bundle for .moc/.mtn support.
 * NOTE: All Live2D imports are lazy to avoid crashing the module graph
 * if live2d.min.js is not yet loaded.
 */

import * as PIXI from 'pixi.js';
import gsap from 'gsap';
import { stageManager } from './StageManager';
import { hookSystem } from '../api/hooks';
import { eventBus } from '../api/events';
import { getLogger } from './Logger';
import type { CharacterConfig } from '../api/types/character';
import type { Vec2 } from '../api/types/common';
import type {
  Live2DParameterMetadata,
} from '../api/types/live2d-parameter-animation';
import { resolveVec2 } from './utils/math';
import { STAGE_WIDTH, STAGE_HEIGHT, isUtSystemLockActive } from './Live2DConfig';
import type { CharacterEntry, ModelSnapshot } from './Live2DConfig';
import type { RimLightStyleState } from '../api/types/visual';
import { setScriptEngineForSetup } from './Live2DSetupState';
import { Live2DMotionController, MotionRequest } from './Live2DMotionController';
import { Live2DModelLoader } from './Live2DModelLoader';
import { RimLightFilter } from './RimLightFilter';
import { projectToScreen } from './Projection';
import { WmdlConfigRegistry } from './WmdlConfigRegistry';
import { Live2DCompositeModel } from './Live2DCompositeModel';
import { getUnsupportedLive2DRuntimeMessage } from './Live2DRuntimeResolver';
import { cubism2Live2DAdapter, getLive2DRuntimeAdapter } from './Live2DRuntimeAdapter';
import {
  resolveRimLightStateAtTime,
} from './RimLightResolver';
import type { ResolvedRimLightState } from './RimLightResolver';
import type { RuntimeTimelineScene } from './RuntimeTimelineScene';
import type { CharacterMotionOutput } from '../api/types/semantic-scene';
import {
  applyCustomMotionValues,
  customMotionControlledParameterIds,
  selectHandoffPoseValues,
  evaluateCustomMotionRuntime,
  type CustomMotionHandoffPose,
} from './live2d/customMotionRuntime';
import type { Cubism2MotionSamplerTarget } from './live2d/cubism2MotionSampler';
import { motionCurveCache } from './live2d/motionCurveCache';
import { releaseCustomMotionOwnership, reclaimControlledInjectedParams } from './live2d/customMotionOwnership';
import { purgeCharacterRuntimeState, resetModelToNeutralPose, restoreNeutralModelPose } from './live2d/characterStatePurge';

function isDefaultLive2DPose(snapshot: ModelSnapshot | null): boolean {
  if (!snapshot?.params?.length) return true;
  for (let i = 0; i < snapshot.params.length; i++) {
    if (snapshot.params[i] !== 0) return false;
  }
  return true;
}

export interface LookAtOptions {
  fromX?: number;
  fromY?: number;
  elapsed?: number;
  ease?: string;
}

type PendingLookAt = { focusX: number; focusY: number; duration: number; options?: LookAtOptions };
type PendingBlink = {
  enabled: boolean;
  intervalMs: number;
  sceneTimeSeconds?: number;
  startTimeSeconds?: number;
  intervalRangeMs?: number;
};
/**
 * A custom motion intent whose character is not on stage yet. A 角色登场
 * (addCharacter) and a 自定义动作 statement can share one timestamp: the
 * entrance registers the character only after its asynchronous model load, so
 * the motion callback runs first and would otherwise be dropped.
 */
type PendingCustomMotion = {
  motion: Extract<CharacterMotionOutput, { kind: 'custom' }>;
  /** Authored scene time the motion started at, so evaluation resumes mid-curve. */
  sceneTime: number;
  handoffSnapshot?: ModelSnapshot | null;
};

type PendingRimLightCommand =
  | {
      mode: 'set';
      color: string | number;
      intensity: number;
      thickness: number;
      angle: number;
      softness: number;
      duration: number;
      startTime?: number;
    }
  | {
      mode: 'reset';
      duration: number;
      baseline?: RimLightStyleState;
      startTime?: number;
    };

// Lazy reference — resolved at init time
let Live2DModel: any = null;
let live2dReady = false;
let nextLive2DToastId = 0;

function showRuntimeErrorToast(message: string): void {
  void eventBus.emit('toast:show', {
    id: `live2d_${Date.now()}_${++nextLive2DToastId}`,
    message,
    type: 'error',
  });
}

class Live2DManager {
  private wmdlConfigRegistry: WmdlConfigRegistry | null = null;
  private activeModelRefCounts = new Map<string, number>();

  public setWmdlConfigRegistry(registry: WmdlConfigRegistry): void {
    this.wmdlConfigRegistry = registry;
    this.modelLoader.setWmdlConfigRegistry(registry);
  }

  private characters: Map<string, CharacterEntry> = new Map();
  private containers: Map<string, PIXI.Container> = new Map();
  private pendingMotions: Map<string, MotionRequest[]> = new Map();
  private _loadingPromises: Map<string, Promise<void>> = new Map(); // 加载锁
  private _activeLoadTokens: Map<string, symbol> = new Map();
  private _characterGenerations: Map<string, number> = new Map();
  private basePath: string = '';
  private _isExportMode: boolean = false; // Only used by ExportDialog (fast export path). Bake uses BakeEngine with independent models.
  private _shouldUpdate: boolean = true;
  private _tickerAdded: boolean = false;
  private _jumpingCharacters: Set<string> = new Set(); // per-character jump lock (replaces global _isJumping)
  private _abortedLoads: Set<string> = new Set(); // IDs whose in-flight loadTask must abort
  private _motionMutex: Map<string, Promise<void>> = new Map(); // per-character motion serialization
  private _hardResetMutex: Map<string, Promise<void>> = new Map(); // per-character hardReset serialization
  private pendingConfigs: Map<string, any[]> = new Map(); // id -> queue of transform configs
  private _activeMotionLoads: Set<string> = new Set(); // IDs of characters currently loading motions
  private _initPromise: Promise<void> | null = null;
  private _scriptEngine: any = null;
  private pendingExpressions = new Map<string, string | null>();
  private pendingCustomMotions = new Map<string, PendingCustomMotion>();
  private pendingLookAts = new Map<string, PendingLookAt>();
  private pendingBlinks = new Map<string, PendingBlink>();
  private pendingRimLightCommands = new Map<string, PendingRimLightCommand>();
  private pendingRimLightStates = new Map<string, ResolvedRimLightState>();

  /**
   * Current camera state — set by ScriptEngine before each render pass.
   * Used as fallback by applyProxyTransform when no explicit camera is passed.
   * Avoids circular imports with CameraController.
   */
  public currentCamera: { position: Vec2; zoom: number } | null = null;
  private motionController: Live2DMotionController | null = null;
  private modelLoader!: Live2DModelLoader;
  private _pendingMotionQueue: { id: string; req: any }[] = [];
  private _pendingMotionCount: number = 0;
  private resourceMotionCacheEnabled = true;
  private readonly logger = getLogger('Live2DManager');

  constructor() {
    this.modelLoader = new Live2DModelLoader(
      () => this.basePath,
    );
  }

  private nextCharacterGeneration(id: string): number {
    const next = (this._characterGenerations.get(id) ?? 0) + 1;
    this._characterGenerations.set(id, next);
    return next;
  }

  private isActiveLoad(id: string, token: symbol): boolean {
    return this._activeLoadTokens.get(id) === token && !this._abortedLoads.has(id);
  }

  /**
   * Set export mode (only used by ExportDialog fast export path).
   * Pre-baking no longer touches this — it uses BakeEngine with independent models.
   */
  setExportMode(enabled: boolean): void {
    this._isExportMode = enabled;
    this.setAutoUpdate(!enabled);
  }

  /**
   * Wait for all characters to finish loading.
   */
  async waitForAllLoaded(): Promise<void> {
    // Drain ALL async states: loads, motions, hard resets.
    // Uses polling loop because new promises can be added after Promise.all takes its snapshot.
    // Mutex entries are deleted on resolution, so empty maps guarantee quiescence.
    while (this._loadingPromises.size > 0 ||
      this._motionMutex.size > 0 ||
      this._hardResetMutex.size > 0) {
      const promises: Promise<void>[] = [
        ...this._loadingPromises.values(),
        ...this._motionMutex.values(),
        ...this._hardResetMutex.values(),
      ];
      if (promises.length === 0) break;
      await Promise.allSettled(promises);
    }
  }

  /**
   * Initialize pixi-live2d-display (must be called after live2d.min.js is loaded).
   */
  async init(): Promise<void> {
    if (live2dReady) return;
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      try {
        await cubism2Live2DAdapter.init();
        Live2DModel = cubism2Live2DAdapter.getModelClass();
        live2dReady = cubism2Live2DAdapter.isReady();
        console.log('[Live2D] pixi-live2d-display initialized successfully.');
      } catch (err) {
        console.error('[Live2D] Failed to initialize pixi-live2d-display:', err);
        console.warn('[Live2D] Ensure live2d.min.js is loaded in index.html before this module.');
      } finally {
        this._initPromise = null;
      }
    })();

    return this._initPromise;
  }

  /**
   * Set the base path for resolving relative model paths.
   * This is typically the project root (e.g., d:\AeonStagery).
   */
  setBasePath(path: string): void {
    this.basePath = path;
  }

  /**
   * Link the ScriptEngine to this manager for transformation proxy synchronization.
   */
  setScriptEngine(engine: any): void {
    this._scriptEngine = engine;
    setScriptEngineForSetup(engine);
  }

  private resetReusedModelVisualState(model: any): void {
    if (!model) return;
    try {
      model.visible = false;
      model.alpha = 0;
      model.filters = null;
      if ('tint' in model) {
        model.tint = 0xFFFFFF;
      }

      if (model instanceof Live2DCompositeModel) {
        for (const child of model.getAllModels()) {
          child.visible = true;
          child.alpha = 1;
          child.filters = null;
          if ('tint' in child) {
            child.tint = 0xFFFFFF;
          }
        }
      }
    } catch (err) {
      console.warn('[Live2D] Failed to reset reused model visual state:', err);
    }
  }

  private syncCurrentCameraFromScriptEngine(): { position: Vec2; zoom: number } | null {
    const camera = this._scriptEngine?.getCurrentCamera?.();
    if (camera?.position && Number.isFinite(camera.zoom)) {
      this.currentCamera = camera;
    }
    return this.currentCamera;
  }

  private getElapsedSince(startTime?: number): number {
    if (startTime === undefined) return 0;
    const currentTime = this._scriptEngine?.getCurrentTime?.();
    if (!Number.isFinite(currentTime)) return 0;
    return Math.max(0, currentTime - startTime);
  }

  /**
   * Add a character to the stage.
   *
   * @param id Unique identifier for this character instance (e.g., "tomori")
   * @param modelJsonPath Path to model.json, relative to basePath or absolute
   *                      e.g., "figure/tomori/casual-2023/model.json"
   * @param config Optional positioning/animation config
   */
  async addCharacter(id: string, modelJsonPath: string, config: CharacterConfig = {}): Promise<void> {
    const targetMap = this.characters;

    // 如果该角色正在加载中，等待完成。但如果等待结束后角色被 abort 了
    // （比如 removeCharacter 在加载期间被调用），必须重新加载而不是直接 return。
    // 注意：绝对不能 break！当多个并发的 addCharacter 调用者被同一个锁唤醒时，
    // break 会导致所有调用者同时跳出循环并各自启动 loadTask（惊群效应）。
    // 正确的做法是让循环自然重新评估 _loadingPromises.has(id)：
    // 如果前面的调用者已经加载成功并释放了锁，当前调用者会发现锁已释放并退出循环；
    // 如果前面的调用者重新加了锁，当前调用者会再次 await 排队。
    while (this._loadingPromises.has(id)) {
      await this._loadingPromises.get(id);
      if (this.characters.has(id) && !this._abortedLoads.has(id)) {
        return; // 角色已成功加载，无需重复加载
      }
      // 继续循环：锁已被 finally 清理。如果锁还在（前面的人重新加了），则再次 await。
    }

    const loadToken = Symbol(`load:${id}`);
    const lifecycleGeneration = this.nextCharacterGeneration(id);
    this._activeLoadTokens.set(id, loadToken);
    this._abortedLoads.delete(id);

    // 包装加载任务
    const loadTask = async () => {
      // 核心修复：强制延迟到下一个微任务执行，确保外部的 _loadingPromises.set(id, promise) 先完成。
      // 否则在预加载模式下，代码会同步跑完前面的逻辑并触发“生命周期校验”导致模型被意外销毁。
      await Promise.resolve();

      // Abort if character was removed during microtask yield
      if (!this.isActiveLoad(id, loadToken)) return;

      // Ensure Live2D is initialized
      if (!live2dReady) {
        await this.init();
      }
      // Abort if removed during init
      if (!this.isActiveLoad(id, loadToken)) return;

      if (!Live2DModel) {
        console.error('[Live2D] Live2D runtime not available. Cannot add character.');
        return;
      }

      if (targetMap.has(id)) {
        console.warn(`[Live2D] Character "${id}" already on stage, removing first.`);
        this.removeCharacter(id);
        // Clear abort flag that removeCharacter set — this is an internal replace, not an external removal
        this._activeLoadTokens.set(id, loadToken);
        this._characterGenerations.set(id, lifecycleGeneration);
        this._abortedLoads.delete(id);
      }

      // Guard against undefined/empty model path — prevents PixiJS Assets resolver crash
      if (!modelJsonPath) {
        console.warn(`[Live2D] Cannot add character "${id}" — no model path provided`);
        return;
      }

      const modelProbe = await this.modelLoader.probeModelPath(modelJsonPath);
      if (!this.isActiveLoad(id, loadToken)) return;
      if (!modelProbe.exists) {
        console.error(
          `[Live2D] Cannot add character "${id}" — invalid Live2D model path "${modelJsonPath}"` +
          (modelProbe.error ? ` (${modelProbe.error})` : ''),
        );
        showRuntimeErrorToast(
          `Live2D 模型加载失败：角色 "${id}" 的模型文件无法读取。\n${modelProbe.fullPath || modelJsonPath}`,
        );
        return;
      }
      const unsupportedRuntimeMessage = modelProbe.runtime
        ? getUnsupportedLive2DRuntimeMessage(modelJsonPath, modelProbe.runtime)
        : null;
      if (unsupportedRuntimeMessage) {
        console.error(`[Live2D] Cannot add character "${id}" — ${unsupportedRuntimeMessage}`);
        showRuntimeErrorToast(unsupportedRuntimeMessage);
        return;
      }
      const runtime = modelProbe.runtime ?? { runtimeFamily: 'cubism2', adapterId: 'pixi-live2d-display-cubism2', supported: true } as const;
      const adapter = getLive2DRuntimeAdapter(runtime);

      // Resolve path
      const normalizedModelJsonPath = this.modelLoader.normalizeModelPath(modelJsonPath);
      let fullPath = (modelProbe.fullPath || normalizedModelJsonPath).replace(/\\/g, '/').trim();
      // Check if it's already an absolute path or has the asset protocol
      const isAbsolute = fullPath.startsWith('asset://') || fullPath.startsWith('file://') || /^[a-zA-Z]:[/\\]/.test(fullPath) || fullPath.startsWith('/');

      if (!isAbsolute) {
        // Relative path — resolve against base
        fullPath = `${this.basePath}/${normalizedModelJsonPath}`.replace(/\\/g, '/');
      }

      const modelUrl = this.modelLoader.resolvedPathToUrl(fullPath);

      console.log(`[Live2D] Loading model: ${modelUrl}`);

      try {
        let model: any = null;

        // Check if this is a composed model (.wmdl) - pure in-memory check
        let wmdlConfig = this.wmdlConfigRegistry?.get(modelJsonPath);
        if (!wmdlConfig && modelJsonPath.endsWith('.wmdl')) {
          const base = this.basePath.replace(/\\/g, '/');
          const relPath = modelJsonPath.replace(base, '').replace(/^\/+/, '');
          wmdlConfig = this.wmdlConfigRegistry?.get(relPath);
        }

        if (wmdlConfig) {
          if (!wmdlConfig.modelRelativePath) {
            console.error(`[Live2D] Invalid composed model config for "${modelJsonPath}" — missing modelRelativePath.`);
            return;
          }
          // Composed model! Load constituent models
          const mainModelPath = wmdlConfig.modelRelativePath;
          const mainModelUrl = this.modelLoader.pathToUrl(mainModelPath);

          // Increment reference count for main torso model
          this.activeModelRefCounts.set(mainModelUrl, (this.activeModelRefCounts.get(mainModelUrl) || 0) + 1);

          // Load main model (torso)
          if (runtime.runtimeFamily === 'cubism3-plus') {
            console.error(`[Live2D] Composed Cubism 3/4/5 model is not supported yet: ${modelJsonPath}`);
            showRuntimeErrorToast(`Live2D 模型 "${modelJsonPath}" 已识别为 Cubism 3/4/5 组合模型，但当前仅支持单个 .model3.json 主舞台加载。`);
            return;
          }
          let mainModel: any = null;
          let mainPool = this.modelLoader.preloadedModels.get(mainModelUrl);
          if (mainPool && mainPool.length > 0) {
            mainModel = mainPool.pop();
            if (mainPool.length === 0) this.modelLoader.preloadedModels.delete(mainModelUrl);
            console.log(`[Live2D] Using preloaded main model for composed: ${id}`);
            this.resetReusedModelVisualState(mainModel);
          } else {
            mainModel = await adapter.createModel(mainModelUrl, {
              autoHitTest: false,
              autoFocus: false,
              autoUpdate: false,
              idleMotionGroup: '',
            });
          }

          // Abort check
          if (!this.isActiveLoad(id, loadToken)) {
            if (mainModel.parent) mainModel.parent.removeChild(mainModel);
            return;
          }

          // Load sub-models in parallel
          const subModels: any[] = [];
          if (wmdlConfig.subModels && Array.isArray(wmdlConfig.subModels)) {
            for (const sub of wmdlConfig.subModels) {
              if (!sub?.modelRelativePath) {
                console.warn(`[Live2D] Skipping invalid composed sub-model entry for "${modelJsonPath}"`);
                continue;
              }
              const subUrl = this.modelLoader.pathToUrl(sub.modelRelativePath);
              
              // Increment reference count for submodel
              this.activeModelRefCounts.set(subUrl, (this.activeModelRefCounts.get(subUrl) || 0) + 1);

              let subModel: any = null;
              try {
                let subPool = this.modelLoader.preloadedModels.get(subUrl);
                if (subPool && subPool.length > 0) {
                  subModel = subPool.pop();
                  if (subPool.length === 0) this.modelLoader.preloadedModels.delete(subUrl);
                  console.log(`[Live2D] Using preloaded submodel: ${subUrl}`);
                  this.resetReusedModelVisualState(subModel);
                  subModel.visible = true;
                } else {
                  subModel = await adapter.createModel(subUrl, {
                    autoHitTest: false,
                    autoFocus: false,
                    autoUpdate: false,
                    idleMotionGroup: '',
                  });
                }
                if (!this.isActiveLoad(id, loadToken)) {
                  if (subModel?.parent) subModel.parent.removeChild(subModel);
                  return;
                }
              } catch (err) {
                console.warn(`[Live2D] Failed to load sub-model: ${subUrl}`, err);
                // Decrement reference count since this load failed
                const currentCount = this.activeModelRefCounts.get(subUrl) || 1;
                this.activeModelRefCounts.set(subUrl, Math.max(0, currentCount - 1));
                continue;
              }

              // Apply sub-model offsets
              subModel.x = sub.offsetX ?? 0;
              subModel.y = sub.offsetY ?? 0;

              // Apply mask isolation to sub-model to prevent multi-model rendering glitches
              if (runtime.adapterId === 'pixi-live2d-display-cubism2') {
                adapter.getControls().isolateMask(subModel);
              }

              // Store URL for clean reference counted recycling/destruction
              (subModel as any)._modelUrl = subUrl;

              subModels.push(subModel);
            }
          }

          // Assemble the Composite Model
          model = new Live2DCompositeModel(mainModel, subModels);
          model._modelUrl = modelUrl; // Store the .wmdl URL
          this.resetReusedModelVisualState(model);
        } else {
          // Standard single model load
          this.activeModelRefCounts.set(modelUrl, (this.activeModelRefCounts.get(modelUrl) || 0) + 1);

          // 优先从预加载池中拾取已加载好的模型实例
          let pool = this.modelLoader.preloadedModels.get(modelUrl);
          if (pool && pool.length > 0) {
            model = pool.pop();
            if (pool.length === 0) this.modelLoader.preloadedModels.delete(modelUrl);
            console.log(`[Live2D] Using preloaded instance for: ${id}`);
            // 立即锁定状态，防止异步过程中的任何闪现
            this.resetReusedModelVisualState(model);
          } else {
            // If a preload is in progress for this URL, wait for it to finish
            if (this.modelLoader.preloadingModels.has(modelUrl)) {
              await this.modelLoader.preloadingModels.get(modelUrl);
              if (!this.isActiveLoad(id, loadToken)) return;
              // Try the pool again after preload completes
              pool = this.modelLoader.preloadedModels.get(modelUrl);
              if (pool && pool.length > 0) {
                model = pool.pop();
                if (pool.length === 0) this.modelLoader.preloadedModels.delete(modelUrl);
                console.log(`[Live2D] Using preloaded instance (after await) for: ${id}`);
                this.resetReusedModelVisualState(model);
              }
            }
            // Load from scratch if still no model
            if (!model) {
              try {
                model = await adapter.createModel(modelUrl, {
                  autoHitTest: false,
                  autoFocus: false,
                  autoUpdate: false,
                  idleMotionGroup: '', // 禁用内置自动 idle，防止动作播放完毕后立刻被打断还原为闲置
                });
                if (!this.isActiveLoad(id, loadToken)) {
                  if (model?.parent) model.parent.removeChild(model);
                  return;
                }
              } catch (err) {
                if (runtime.runtimeFamily !== 'cubism2') {
                  throw err;
                }
                console.warn(`[Live2D] Failed to load model ${modelUrl}, using placeholder`, err);
                // Adapter-owned placeholder: fabricates the runtime surface the
                // adapter's own controls call into (no mock shape leaks here).
                model = adapter.createFallbackModel(stageManager.getApp().renderer);
              }
              // Abort if character was removed while loading
              if (!this.isActiveLoad(id, loadToken)) {
                if (model.parent) model.parent.removeChild(model);
                return;
              }
              this.resetReusedModelVisualState(model);
            }
          }
        }

        // === 核心修复：捕获“灵魂快照” (Manual Parameters & Opacities) ===
        const isCubism2Runtime = runtime.adapterId === 'pixi-live2d-display-cubism2';
        if (isCubism2Runtime) {
          // Pooled instances retain their Cubism clipping mask texture. Renew
          // it before the first draw of the new lifecycle so a previous exit
          // seek cannot leave the model rendering as a black silhouette. The
          // isolation buffer is adapter-owned since the runtime-adapter
          // centralization; isolateMask destroys the previous isolated
          // texture and allocates a fresh one for each concrete model.
          const loadControls = adapter.getControls();
          for (const concrete of loadControls.getConcreteModels(model)) {
            loadControls.isolateMask(concrete);
          }
        }
        // A pooled instance keeps the motion queue, expression and pose of its
        // previous owner. The idle snapshot captured below is the pose every
        // later hard reset and custom-motion baseline restores to, so it must
        // be taken from a neutralised model — otherwise the character's neutral
        // pose is the previous scene time's action.
        resetModelToNeutralPose(model, runtime);
        adapter.getControls().advanceFrame(model, 100);
        let idleSnapshot: any = null;

        if (isCubism2Runtime) {
          // === 核心修复：安全地洗刷初始状态遗留的 0 opacity ===
          // SDK 时钟在 adapter 的锁内单调前进一小步，避免一次超长模型更新
          // 带来的巨大 dt 导致物理系统 NaN 爆炸（flush 在 adapter 内完成）。
          await adapter.getControls().flushIdleState(model);
        } else {
          try {
            model.stopAllMotions?.();
            adapter.getControls().advanceFrame(model, 16);
          } catch {
            // Ignore errors
          }
        }

        // Idle warmup advances the SDK and can leave its final motion pose
        // in the parameter buffer. The snapshot used for future entrances
        // must remain the instance's pristine baseline captured before the
        // first update, especially when this pooled model has already served
        // another character.
        try {
          resetModelToNeutralPose(model, runtime);
        } catch (e) {
          console.warn(`[Live2D] Failed to neutralise idle baseline for ${id}`, e);
        }

        idleSnapshot = adapter.getControls().captureIdleSnapshot(model);

        // Keep hidden during setup to prevent "flashing" at wrong scale/pos
        model.visible = false;

        // Start our manual ticker if this is the first character
        if (!this._tickerAdded) {
          const app = stageManager.getApp();
          app.ticker.add((ticker) => this.updateAll(ticker.deltaMS));
          this._tickerAdded = true;
        }

        // Apply positioning
        const camera = this.syncCurrentCameraFromScriptEngine();
        const pos = config.position ? resolveVec2(config.position) : { x: 0.5, y: 1.15 };
        const container = this.getContainer(id);
        container.x = pos.x * 1920;
        container.y = pos.y * 1080;
        container.angle = config.rotation ?? 0;

        model.x = 0;
        model.y = 0;

        // Scale — reset to 1 first to get clean height reading
        model.scale.set(1);
        const baseHeight = model.height || 1000;
        (model as any)._baseHeight = baseHeight;

        const targetHeight = 1080 * (config.scale ?? 1.3);
        const modelScale = targetHeight / baseHeight;
        model.scale.set(modelScale);
        const baseWidth = (model.width && modelScale !== 0)
          ? model.width / modelScale
          : baseHeight * 0.58;

        // Flip
        if (config.flipX) {
          model.scale.x *= -1;
          (model as any)._flipX = true;
        }

        // Anchor from feet
        model.anchor.set(0.5, 0.9);

        // Opacity
        if (config.opacity !== undefined) {
          model.alpha = config.opacity;
        }

        // Z-index
        if (config.zIndex !== undefined) {
          model.zIndex = config.zIndex;
        }

        // Add model to its persistent container
        container.addChild(model);

        // 核心修复：在变可见前，强行同步一次代理状态到模型实例
        // 注意：此时 entry 还没加入 characters Map，所以必须通过 modelOverride 传入模型
        if (this._scriptEngine) {
          const proxy = this._scriptEngine.transformationProxies.get(id);
          if (proxy) this.applyProxyTransform(id, proxy, model, camera ?? undefined);
        }

        model.visible = true; // 现在可以安全显示了

        // --- 核心修复：生命周期校验 ---
        // 如果在 await 加载期间角色已经被删除了（例如连续 Seek），则直接丢弃这个模型
        if (!this.isActiveLoad(id, loadToken)) {
          console.warn(`[Live2D] Model for "${id}" loaded but character was already removed. Skip display.`);
          if (model.parent) model.parent.removeChild(model);
          return;
        }

        const entry: CharacterEntry = {
          id,
          model,
          modelPath: modelJsonPath,
          modelUrl,
          runtime,
          adapterId: runtime.adapterId,
          runtimeHandle: adapter.createModelHandle(id, model, runtime),
          config,
          injectedParams: {},
          lipSyncParameterIds: new Set<string>(),
          baseHeight,
          baseWidth,
          motionEpoch: 0,
          filterWarmupFrames: 6,
          lifecycleGeneration,
          loadToken,
        };

        (model as any)._characterEntry = entry;

        // Link CharacterEntry to composite model for dynamic injected parameters synchronization
        if (model instanceof Live2DCompositeModel) {
          (model as any)._characterEntry = entry;
        }

        if (idleSnapshot) entry.idleSnapshot = idleSnapshot;

        // Apply visual fixes and hooks — behavior fixes (head/eye, breathing,
        // blink), the parameter-override commit hook (lip sync, etc.), the
        // _render() GL-boundary hook and mask isolation are all owned by the
        // runtime adapter.
        if (isCubism2Runtime) {
          adapter.getControls().prepareModel(model, {
            id,
            mode: 'live',
            isExportMode: this._isExportMode,
            injectedParamsSource: entry,
            applyProxyTransform: (proxyId, proxy) => this.applyProxyTransform(proxyId, proxy),
          });
        }

        targetMap.set(id, entry);

        // Abort if character was removed during async loading / setup
        if (!this.isActiveLoad(id, loadToken)) {
          targetMap.delete(id);
          if (model && model.parent) model.parent.removeChild(model);
          return;
        }

        // 核心修复：加载完成后，立即对齐 ScriptEngine 的代理状态（透明度、位置等）
        // 这样即便在 fadeIn 补间过程中加载完成，模型也会立刻跳到当前的正确不透明度
        if (this._scriptEngine) {
          const proxy = this._scriptEngine.transformationProxies.get(id);
          if (proxy) {
            const latestCamera = this.syncCurrentCameraFromScriptEngine();
            this.applyProxyTransform(id, proxy, undefined, latestCamera ?? undefined);
          }
        }

        this.applyPendingCharacterVisualState(id);

        // 核心修复：全量恢复积压的指令，保留 offset 等关键参数
        const pendingM = this.pendingMotions.get(id);
        if (pendingM) {
          pendingM.forEach(m => this.playMotion(id, m.key, m.priority, m.offset, m.sceneTime, m.skipHardReset));
          this.pendingMotions.delete(id);
        }

        // A custom motion buffered before the entrance loaded replays after the
        // queued resource motions: it was requested later, and the newest motion
        // intent owns the character's output (ADR-0029).
        const pendingCustomMotion = this.pendingCustomMotions.get(id);
        if (pendingCustomMotion) {
          this.pendingCustomMotions.delete(id);
          this.playCustomMotion(
            id,
            pendingCustomMotion.motion,
            pendingCustomMotion.sceneTime,
            pendingCustomMotion.handoffSnapshot,
          );
        }

        const pendingE = (entry as any)._pendingExpression;
        if (pendingE !== undefined) {
          this.setExpression(id, pendingE);
          (entry as any)._pendingExpression = undefined;
        }

        const pendingL = (entry as any)._pendingLookAt;
        if (pendingL) {
          const l = pendingL as any;
          this.lookAt(id, l.focusX, l.focusY, l.duration, l.options);
          (entry as any)._pendingLookAt = undefined;
        }

        const pendingB = (entry as any)._pendingBlink;
        if (pendingB) {
          this.setBlink(id, pendingB.enabled, pendingB.intervalMs, pendingB.sceneTimeSeconds, pendingB.startTimeSeconds, pendingB.intervalRangeMs);
          (entry as any)._pendingBlink = undefined;
        }

        const pendingTrans = this.pendingConfigs.get(id);
        if (pendingTrans) {
          pendingTrans.forEach(conf => this.transform(id, conf));
          this.pendingConfigs.delete(id);
        }

        // Fire hook
        hookSystem.execute('character:add', { id, modelPath: modelJsonPath });

        console.log(`[Live2D] Character "${id}" added to stage.`);
      } catch (err) {
        console.error(`[Live2D] Failed to load model "${modelJsonPath}":`, err);
        throw err;
      }
    }; // loadTask 结束

    // 挂载锁并执行
    const promise = loadTask();
    this._loadingPromises.set(id, promise);
    try {
      await promise;
    } finally {
      if (this._loadingPromises.get(id) === promise) {
        this._loadingPromises.delete(id);
        this._activeLoadTokens.delete(id);
        this._abortedLoads.delete(id);
      }
    }
  }

  /**
   * Safe destruction of a model (composed or single) with active WebGL texture reference counting.
   * Decrements active reference counts, then delegates the destroy semantics
   * (children/texture/baseTexture options, composite teardown) to the runtime
   * adapter. VRAM refcount bookkeeping stays here (per-URL movie-level policy).
   */
  private destroyModelInstance(model: any, controls: import('./Live2DRuntimeAdapter').Live2DRuntimeModelControls): void {
    if (!model) return;

    if (model instanceof Live2DCompositeModel) {
      const concrete = controls.getConcreteModels(model);
      // concrete[0] is the torso; subs follow (matches getAllModels order).
      // 1. Decrement and safe-destroy sub-models first
      for (const sub of concrete.slice(1)) {
        const subUrl = sub._modelUrl;
        if (subUrl) {
          const count = Math.max(0, (this.activeModelRefCounts.get(subUrl) || 1) - 1);
          this.activeModelRefCounts.set(subUrl, count);
          console.log(`[VRAM] Destroying BaseTexture for model: ${subUrl}`);
          controls.disposeModel(sub, { mode: 'destroy', keepTextures: count > 0 });
        }
      }

      // 2. Decrement and safe-destroy main torso model
      const mainUrl = model.mainModel?._modelUrl || model.mainModel?.modelUrl || this.modelLoader.pathToUrl(model.mainModel?.modelPath || '');
      if (mainUrl) {
        const count = Math.max(0, (this.activeModelRefCounts.get(mainUrl) || 1) - 1);
        this.activeModelRefCounts.set(mainUrl, count);
        console.log(`[VRAM] Destroying BaseTexture for model: ${mainUrl}`);
        controls.disposeModel(model.mainModel, { mode: 'destroy', keepTextures: count > 0 });
      }

      // 3. Clean up the composite container itself (Live2DCompositeModel.destroy
      //    re-destroys children with texture:false — safe, matches legacy flow).
      model.removeChildren();
      model.destroy();
    } else {
      // Standard single model destruction
      // (isolated mask render buffers are released inside controls.disposeModel)
      const modelUrl = model._modelUrl || model.modelUrl || this.modelLoader.pathToUrl(model.modelPath || '');
      if (modelUrl) {
        const count = Math.max(0, (this.activeModelRefCounts.get(modelUrl) || 1) - 1);
        this.activeModelRefCounts.set(modelUrl, count);
        console.log(`[VRAM] Destroying BaseTexture for model: ${modelUrl}`);
        controls.disposeModel(model, { mode: 'destroy', keepTextures: count > 0 });
      } else {
        controls.disposeModel(model, { mode: 'destroy', keepTextures: true });
      }
    }
  }

  /**
   * Remove a character from the stage.
   */
  removeCharacter(id: string): void {
    // MUST be outside the entry block: if the model is still loading (no entry yet),
    // we still need to signal the in-flight loadTask to abort.
    if (this._loadingPromises.has(id)) {
      this._abortedLoads.add(id);
      this._activeLoadTokens.delete(id);
    }
    this.nextCharacterGeneration(id);
    this.pendingExpressions.delete(id);
    // A motion intent buffered for a character that never entered must die with
    // the character; otherwise it would fire on a later, unrelated entrance.
    this.pendingCustomMotions.delete(id);
    this.pendingLookAts.delete(id);
    this.pendingBlinks.delete(id);
    this.pendingRimLightCommands.delete(id);

    const targetMap = this.characters;
    const entry = targetMap.get(id);
    if (entry) {
      entry.lifecycleGeneration = (entry.lifecycleGeneration ?? 0) + 1;
      // Shared ownership exit: dispose the stage writer (restores eye blink,
      // detaches listeners), release controlled injected parameters, stop the
      // SDK motion/expression channels and restore the neutral pose. The model
      // instance is recycled into the preload pool below, so anything left
      // behind here would be inherited by the next character that enters with
      // the same model — visible as the previous action during its fade-in.
      purgeCharacterRuntimeState(entry, { restoreNeutralPose: true });
      // 1. 停止所有 GSAP 动画
      gsap.killTweensOf(entry.model);
      gsap.killTweensOf(entry.model.scale);
      if (entry.breathTween) entry.breathTween.kill();
      if ((entry as any).rimProxy) { gsap.killTweensOf((entry as any).rimProxy); delete (entry as any).rimProxy; }
      if ((entry as any).rimFilter) { delete (entry as any).rimFilter; }

      // CRITICAL: Detach model from container before destroying the container to prevent
      // container.destroy({ children: true }) from automatically destroying the model,
      // which ruins the globally shared Cubism WebGL shader program!
      if (entry.model && entry.model.parent) {
        entry.model.parent.removeChild(entry.model);
      }

      const container = this.containers.get(id);
      if (container) {
        gsap.killTweensOf(container);
        container.parent?.removeChild(container);
        container.destroy({ children: true });
        this.containers.delete(id);
      }

      // 2. 销毁模型 - 核心原理解析与修复：
      // 模型销毁由 runtime adapter 统一执行（保留贴图，显式不销毁
      // texture/baseTexture，只销毁 children 与自有缓冲）。
      // 注意：必须显式保留 texture 和 baseTexture！
      // 这样既能完全清理和销毁模型内部独有的 WebGL 顶点缓冲区（Vertex Buffers）、索引缓冲区（Index Buffers）以及顶点数组对象（VAOs），
      // 彻底解决由于频繁出入场导致的 WebGL 缓冲区/VAO 泄露引起的“角色下半身模型消失、上半身衣服奇怪色块”的 Bug；
      // 又绝对不会去销毁 PixiJS 全局缓存（TextureCache/BaseTextureCache）中的贴图纹理资源。
      // 这完美保证了前后台（主渲染线程与后台静默预烘焙线程）共享贴图的引用有效性，彻底消除了“WebGL: no texture bound to target”报错以及角色首入场全黑的问题。
      if (entry.model) {
        try {
          (entry.model as any).autoUpdate = false;
          // Pre-disposal teardown (motions + expression reset) is adapter-owned.
          getLive2DRuntimeAdapter(entry.runtime).getControls().quiesceModel(entry.model);

          const modelUrl = entry.modelUrl || entry.modelPath;
          if (modelUrl) {
            let pool = this.modelLoader.preloadedModels.get(modelUrl);
            if (!pool) {
              pool = [];
              this.modelLoader.preloadedModels.set(modelUrl, pool);
            }
            if (pool.length < 10) {
              pool.push(entry.model);
              console.log(`[Live2D] Model recycled to preload pool: ${modelUrl}`);
            } else {
              this.destroyModelInstance(entry.model, getLive2DRuntimeAdapter(entry.runtime).getControls());
            }
          } else {
            this.destroyModelInstance(entry.model, getLive2DRuntimeAdapter(entry.runtime).getControls());
          }
        } catch (e) {
          console.warn(`[Live2D] Error during model cleanup for ${id}:`, e);
        }
      }

      // 3. 清理状态
      targetMap.delete(id);
      this.pendingMotions.delete(id);
      this.pendingConfigs.delete(id);

      hookSystem.execute('character:remove', { id });
      console.log(`[Live2D] Character "${id}" removed from stage.`);
    }
  }

  /**
   * Get a persistent container for a character.
   */
  getContainer(id: string): PIXI.Container {
    let container = this.containers.get(id);
    if (!container) {
      container = new PIXI.Container();
      container.name = `character-container-${id}`;
      container.alpha = 0; // 核心修复：初始状态强制设为全透明，防止动画接管前的瞬时闪现
      this.containers.set(id, container);

      const charLayer = stageManager.getLayer('characters');
      charLayer.addChild(container);
    }
    return container;
  }

  private applyPendingCharacterVisualState(id: string): void {
    if (this.pendingExpressions.has(id)) {
      const expression = this.pendingExpressions.get(id) ?? null;
      this.pendingExpressions.delete(id);
      this.setExpression(id, expression);
    }

    const pendingLookAt = this.pendingLookAts.get(id);
    if (pendingLookAt) {
      this.pendingLookAts.delete(id);
      this.lookAt(id, pendingLookAt.focusX, pendingLookAt.focusY, pendingLookAt.duration, pendingLookAt.options);
    }

    const pendingBlink = this.pendingBlinks.get(id);
    if (pendingBlink) {
      this.pendingBlinks.delete(id);
      this.setBlink(
        id,
        pendingBlink.enabled,
        pendingBlink.intervalMs,
        pendingBlink.sceneTimeSeconds,
        pendingBlink.startTimeSeconds,
        pendingBlink.intervalRangeMs,
      );
    }

    const pendingRimCommand = this.pendingRimLightCommands.get(id);
    if (pendingRimCommand) {
      this.pendingRimLightCommands.delete(id);
      if (pendingRimCommand.mode === 'set') {
        this.applyRimLightSet(id, pendingRimCommand, this.getElapsedSince(pendingRimCommand.startTime));
      } else {
        this.applyRimLightReset(
          id,
          pendingRimCommand.duration,
          pendingRimCommand.baseline,
          this.getElapsedSince(pendingRimCommand.startTime),
        );
      }
      return;
    }

    const pendingRimState = this.pendingRimLightStates.get(id);
    if (pendingRimState) {
      this.applyResolvedRimLightState(id, pendingRimState);
    }
  }

  /**
   * Play a motion (animation) on a character.
   *
   * The motionKey corresponds to the motion group name in model.json,
   * e.g., "tomori/smile01", "anon/angry02"
   *
   * @param priority Motion priority (0=idle, 1=normal, 2=force)
   * @param offset Optional time offset in seconds to start the motion from
   * @param sceneTime Current scene time in seconds (for correct SDK time sync)
   * @param skipHardReset Skip the hard reset when playing the motion
   * @param handoffSnapshot Optional motion-start handoff used by the shared
   *   custom-motion evaluator when this resource motion is cache-backed.
   */
  playMotion(
    id: string,
    motionKey: string,
    priority: number = 3,
    offset: number = 0,
    sceneTime: number = 0,
    skipHardReset: boolean = false,
    handoffSnapshot?: ModelSnapshot | null,
  ): void {
    // The newest motion intent owns the character's output (ADR-0029). A custom
    // motion still waiting for its entrance is superseded by this resource
    // intent; otherwise it would replay on load afterwards and wrongly take
    // over. A cache-backed resource motion *is* a custom motion, so the cache
    // branch below re-buffers it as the newer intent.
    this.pendingCustomMotions.delete(id);

    const entry = this.characters.get(id);
    if (this.resourceMotionCacheEnabled && entry) {
      const cached = motionCurveCache.get({
        adapterId: entry.runtime.adapterId,
        modelRuntimePath: entry.modelPath,
        motionKey,
      });
      if (cached) {
        // The cache converts the resource motion into the same in-memory custom
        // motion shape used by Seek/Play/Bake/Export, so evaluation stays on one
        // code path. `sceneTime - offset` is the motion start scene time.
        this.logger.debug(`[MotionCurveCache] "${id}/${motionKey}" hit -> custom evaluator (start @${(sceneTime - offset).toFixed(3)}s)`);
        this.playCustomMotion(id, cached.motion, sceneTime - offset, handoffSnapshot ?? undefined);
        return;
      }
      this.logger.debug(`[MotionCurveCache] "${id}/${motionKey}" miss -> SDK motion queue`);
    }

    this.ensureMotionController();
    this.motionController!.playMotion(id, motionKey, priority, offset, sceneTime, skipHardReset);
  }

  /**
   * Start an inline custom motion as the character's motion output. The
   * custom motion fully takes over from any previous motion (resource or
   * custom) and owns the listed parameters until a later motion takes over.
   *
   * Normal playback captures the handoff pose from the model's current pose.
   * Seek reconstruction can provide the motion-start snapshot explicitly so
   * forward simulation to the target frame cannot overwrite the fade source
   * with an already-advanced curve value (ADR-0029).
   *
   * The takeover is not purely a parameter injection: the previous resource
   * motion is stopped in the SDK queue and parameters the custom motion does
   * not cover return to the idle baseline (like the hard reset a resource
   * motion performs before it starts). Otherwise the predecessor motion keeps
   * animating — and eventually holds its tail pose on — every uncovered
   * parameter for the whole custom motion, which looks like the character is
   * stuck in the previous action and breaks the entry fade.
   */
  playCustomMotion(
    id: string,
    motion: Extract<CharacterMotionOutput, { kind: 'custom' }>,
    sceneTime: number = 0,
    handoffSnapshot?: ModelSnapshot | null,
  ): void {
    const entry = this.characters.get(id);
    if (!entry) {
      // No character on stage yet: a statement can pair the custom motion with
      // the entrance that creates the character (角色登场 + 角色动作 at the same
      // time), and the entrance registers its entry only after the asynchronous
      // model load. Buffer the intent — the same way resource motions wait in
      // `pendingMotions` — and replay it on load, keeping the authored start
      // time so the curve resumes at the frame the playhead is actually on.
      this.pendingCustomMotions.set(id, { motion, sceneTime, handoffSnapshot });
      return;
    }

    this.releaseCustomMotion(entry);
    entry.customMotion = {
      motion,
      startSceneTime: sceneTime,
      controlledParameterIds: customMotionControlledParameterIds(motion),
    };
    entry.customMotionHandoff = this.captureCustomMotionHandoff(entry, handoffSnapshot);
    this.takeOverCustomMotion(entry);
  }

  /**
   * Complete the custom motion takeover: invalidate a queued resource-motion
   * start, stop the SDK motion queue, restore the uncovered-parameter baseline
   * to idle, and immediately write the captured handoff pose back on the
   * covered parameters so no intermediate frame can flash an idle pose before
   * the next injection.
   */
  private takeOverCustomMotion(entry: CharacterEntry): void {
    if (entry._pendingPlayMotion) {
      entry._pendingPlayMotion = undefined;
      entry.motionEpoch++;
    }
    // 自定义动作接管后，资源动作的 seek 边界保持快照已失效；若不清理，
    // 暂停拖动落在边界窗口内时它仍会每帧覆盖自定义动作的基线姿态。
    entry.pendingSeekBoundarySnapshot = undefined;
    entry.pendingSeekBoundaryMotionStartTime = undefined;
    entry.pendingSeekBoundaryDuration = undefined;
    // 收回受控参数的历史注入值：舞台模式下曲线在 model.update 内写入，
    // updateAll 的重放循环仍会把 injectedParams 残留值 post-update 写回，
    // 每帧压过曲线与表情叠加。必须在接管入口清洗（lip-sync 通道豁免）。
    // 放在 model 守卫之前：模型未就绪的接管同样要清掉陈旧值。
    reclaimControlledInjectedParams(entry);
    if (!entry.model) return;
    const controls = getLive2DRuntimeAdapter(entry.runtime).getControls();
    controls.stopAllMotions(entry.model);
    this.restoreCustomMotionBaseline(entry);
    for (const [parameterId, value] of Object.entries(entry.customMotionHandoff?.values ?? {})) {
      controls.setInjectedParameter(entry.model, parameterId, value);
    }
    controls.syncInputParameters(entry.model);
    this.maybeInstallCustomMotionStageOnEntry(entry);
  }

  /**
   * Install the Motion-stage writer exactly once per custom-motion takeover.
   *
   * Called from takeOverCustomMotion and lazily re-invoked by updateAll so a
   * motion that started before its model finished loading still gets staged
   * once the model arrives. A failed install (runtime without the writable Cubism 2
   * seam, e.g. untitled-pixi-live2d-engine-cubism) is recorded per custom-motion state
   * object — otherwise updateAll would retry the (always failing) install
   * every frame.
   */
  private readonly _customMotionStageInstallAttempts = new WeakSet<object>();

  private maybeInstallCustomMotionStageOnEntry(entry: CharacterEntry): void {
    if (!entry.customMotion || !entry.customMotionHandoff || !entry.model) return;
    if (entry.customMotionStage) return;
    if (this._customMotionStageInstallAttempts.has(entry.customMotion)) return;
    this._customMotionStageInstallAttempts.add(entry.customMotion);
    this.installCustomMotionStageOnEntry(entry);
  }

  /**
   * Install the Motion-stage writer so curve values enter the SDK update pass
   * before saveParam/expression compositing — an active Expression keeps
   * layering above them until the next expression or `default` (ADR-0029).
   * When the runtime lacks the emitter seam or a writable Cubism 2 core
   * the handle stays null and the legacy post-update injection path in
   * updateAll applies instead.
   */
  private installCustomMotionStageOnEntry(entry: CharacterEntry): void {
    entry.customMotionStage?.dispose();
    entry.customMotionStage = null;
    if (!entry.model) return;
    // Concrete-target resolution and the emitter/core checks live in the
    // runtime adapter; the stage handle type is unchanged.
    entry.customMotionStage = getLive2DRuntimeAdapter(entry.runtime).getControls().installCustomMotionStage(entry.model, {
      getState: () => entry.customMotion && entry.customMotionHandoff
        ? {
            motion: entry.customMotion.motion,
            startSceneTime: entry.customMotion.startSceneTime,
            handoff: entry.customMotionHandoff,
            controlledParameterIds: entry.customMotion.controlledParameterIds,
          }
        : null,
      lipSyncParameterIds: entry.lipSyncParameterIds,
    });
  }

  /**
   * Restore parameters the custom motion does not cover to their idle values,
   * mirroring the hard reset the resource-motion path performs before starting
   * (ADR-0029: the custom motion owns only its listed tracks; the rest of the
   * body must not stay frozen in the predecessor motion's pose).
   */
  private restoreCustomMotionBaseline(entry: CharacterEntry): void {
    if (!entry.model) return;
    if (entry.runtime?.adapterId === 'untitled-pixi-live2d-engine-cubism') {
      if (entry.idleSnapshot) {
        getLive2DRuntimeAdapter(entry.runtime).getControls().applySnapshot(entry.model, entry.idleSnapshot as ModelSnapshot);
      }
      return;
    }
    // Cubism 2 often exposes its live arrays only through the private model
    // context. `restoreNeutralModelPose` handles both public and private
    // layouts and, importantly, restores every concrete model in a composite.
    restoreNeutralModelPose(entry, entry.model);
  }

  /**
   * Release the custom motion's parameter control when a newer motion takes
   * over or the character's state is reset. Parameters owned by the active
   * lip-sync effect channel are left untouched — that channel keeps running
   * in its own stage (ADR-0029) and releases them itself when it ends.
   *
   * Delegates to the shared ownership lifecycle: Live2DMotionController ends
   * custom motions through the same entries (resource-motion takeover, stop,
   * reset-to-idle), and every exit path must dispose the Motion-stage writer
   * or its eye-blink suppression and listeners leak.
   */
  releaseCustomMotion(entry: CharacterEntry): void {
    releaseCustomMotionOwnership(entry);
  }

  private captureCustomMotionHandoff(
    entry: CharacterEntry,
    snapshot?: ModelSnapshot | null,
  ): CustomMotionHandoffPose {
    const values: Record<string, number> = {};
    const state = entry.customMotion;
    if (!state) return { values };
    const controls = getLive2DRuntimeAdapter(entry.runtime).getControls();
    const parameters = controls.getParameterValues(entry.model) ?? [];
    const byName = new Map(parameters.map((parameter) => [parameter.name, parameter]));
    // Effect-channel parameters (an in-flight lip-sync mouth value) are
    // excluded so the transient effect output is not baked into the fade-in
    // source; uncovered ids fall back to the curve value at fade evaluation.
    return {
      values: selectHandoffPoseValues(
        byName,
        state.controlledParameterIds,
        snapshot?.params,
        entry.lipSyncParameterIds,
      ),
    };
  }

  private resolveCustomMotionSceneTime(entry: CharacterEntry, manualTimeMs: number | undefined): number {
    if (manualTimeMs !== undefined && Number.isFinite(manualTimeMs)) {
      return manualTimeMs / 1000;
    }
    const scriptTime = this._scriptEngine?.getCurrentTime?.();
    if (typeof scriptTime === 'number' && Number.isFinite(scriptTime)) {
      return scriptTime;
    }
    const lastManual = entry.lastManualTimeMs;
    return typeof lastManual === 'number' && Number.isFinite(lastManual) ? lastManual / 1000 : 0;
  }

  /** 清除角色的待执行动作，防止 GSAP seek 残留的 skipHardReset=false 指令污染快照状态 */
  clearPendingMotion(id: string): void {
    this.ensureMotionController();
    this.motionController!.clearPendingMotion(id);
  }

  /** 清除所有角色的待执行动作并推进 epoch，Seek 前必须调用以防止旧指令污染快照恢复 */
  clearAllPendingMotions(): void {
    this.pendingCustomMotions.clear();
    this.ensureMotionController();
    this.motionController!.clearAllPendingMotions();
  }

  /**
   * Purge every loaded character's motion/expression runtime state.
   *
   * Seek entry point for the shared purge (ADR-0029): a seek target may sit
   * before the character's current motion, so the SDK queue, the expression
   * channel, the injected-parameter replay and the seek-boundary snapshot must
   * all be dropped before the seeked frame is reconstructed. Without this the
   * previous action keeps writing its pose — most visibly inside a fade-in.
   *
   * @param restoreNeutralPose Also restore the neutral pose. On by default: a
   *   backwards seek with no snapshot before the target must not keep the old
   *   tail pose.
   */
  purgeAllCharacterRuntimeState(options: { restoreNeutralPose?: boolean } = {}): void {
    for (const entry of this.characters.values()) {
      purgeCharacterRuntimeState(entry, {
        restoreNeutralPose: options.restoreNeutralPose ?? true,
      });
    }
  }

  /** 立刻强制停止指定角色的所有动作（清空动作队列，不重置参数）。用于在暂停状态下 seek 时“冻结”角色的动作。 */
  stopAllMotions(id: string): void {
    this.ensureMotionController();
    this.motionController!.stopAllMotions(id);
  }

  /**
   * Set expression on a character.
   *
   * @param id Character ID
   * @param expressionName Expression name from model.json, e.g., "tomori/angry01", or empty string to reset
   */
  setExpression(id: string, expressionName: string | null): void {
    const entry = this.characters.get(id);
    if (!entry) {
      this.pendingExpressions.set(id, expressionName);
      return;
    }

    entry.expressionKey = expressionName;
    this.pendingExpressions.delete(id);

    if (!entry.model) {
      (entry as any)._pendingExpression = expressionName;
      return;
    }

    try {
      if (entry.runtimeHandle) {
        entry.runtimeHandle.expression.setExpression(expressionName);
      } else {
        getLive2DRuntimeAdapter(entry.runtime).getControls().setExpression(entry.model, expressionName);
      }
      hookSystem.execute('character:expression', { id, expressionName: expressionName || '' });
      console.log(expressionName
        ? `[Live2D] Set expression "${expressionName}" on "${id}"`
        : `[Live2D] Reset expression on "${id}"`);
    } catch (err) {
      console.error(`[Live2D] Failed to set expression "${expressionName}" on "${id}":`, err);
    }
  }

  /**
   * Restore an expression at a seeked position.
   *
   * `previousExpressionKey` is the expression the scene had in effect
   * immediately before the target's start time. Passing it keeps the seeked
   * frame's fade source authoritative: without it the adapter would reuse the
   * model's live `currentExpression`, which belongs to whatever position
   * playback or the previous seek left behind (ADR-0029).
   */
  async setExpressionForSeek(
    id: string,
    expressionName: string | null,
    elapsedSeconds: number,
    previousExpressionKey?: string | null,
  ): Promise<void> {
    const entry = this.characters.get(id);
    if (!entry?.model) return;

    entry.expressionKey = expressionName;
    this.pendingExpressions.delete(id);

    try {
      const controls = getLive2DRuntimeAdapter(entry.runtime).getControls();
      if (controls.setExpressionForSeek) {
        await controls.setExpressionForSeek(entry.model, expressionName, elapsedSeconds, previousExpressionKey);
      } else {
        controls.setExpression(entry.model, expressionName);
      }
      hookSystem.execute('character:expression', { id, expressionName: expressionName || '' });
    } catch (err) {
      console.error(`[Live2D] Failed to restore expression "${expressionName}" on "${id}" during seek:`, err);
    }
  }

  prepareExpressionForSeek(id: string, expressionName: string | null): void {
    const entry = this.characters.get(id);
    if (entry) entry.expressionKey = expressionName;
  }

  /**
   * True when the loaded character entry for `id` already serves `modelUrl`
   * (resolved path or URL form). Shared by preloadModel's early return, the
   * seek auto-upgrade check, and the pre-warm skip so a same-scene reload
   * never re-populates models that soft cleanup already retained.
   */
  matchesLoadedModel(id: string, modelUrl: string): boolean {
    const entry = this.getAllCharacters().get(id);
    if (!entry) return false;
    const requestedUrl = this.modelLoader.pathToUrl(modelUrl);
    return entry.modelPath === modelUrl || entry.modelUrl === modelUrl || entry.modelUrl === requestedUrl;
  }

  /**
   * Preload a model into browser/SDK cache without adding to stage.
   * Delegates to Live2DModelLoader after guard checks.
   */
  async preloadModel(id: string, modelUrl: string): Promise<void> {
    if (this.matchesLoadedModel(id, modelUrl)) return;
    // Delegate entirely to the loader — it handles ABA prevention, stale cleanup,
    // and stores the correct safeTask in preloadingModels internally.
    await this.modelLoader.preloadModel(modelUrl);
  }

  /**
   * Preload a motion for a character to avoid async stalls during baking.
   */
  async preloadMotion(id: string, motionKey: string): Promise<void> {
    this.ensureMotionController();
    return this.motionController!.preloadMotion(id, motionKey);
  }

  /**
   * Get the raw Live2D model for advanced manipulation.
   * This gives direct access to the PixiJS DisplayObject and internal Live2D core.
   */
  getModel(id: string): any | null {
    return this.characters.get(id)?.model ?? null;
  }

  /**
   * Enumerate the concrete Cubism 2.1 model sampling targets of a loaded
   * character. Composite characters expose every constituent model; plain
   * characters expose the model itself. Returns an empty list when the
   * character is not loaded, is not a Cubism 2.1 runtime, or has no usable
   * motion manager — callers treat that as "conversion not applicable".
   */
  getCubism2SamplerTargets(characterId: string): Cubism2MotionSamplerTarget[] {
    const entry = this.characters.get(characterId);
    if (!entry?.model) return [];
    if (entry.runtime?.adapterId !== 'pixi-live2d-display-cubism2') return [];

    return [...getLive2DRuntimeAdapter(entry.runtime).getControls().getMotionSamplingTargets(entry.model)];
  }

  /**
   * Get the internal Live2D core model for direct parameter manipulation.
   * This is used by LipSyncEngine to control PARAM_MOUTH_OPEN_Y.
   */
  getCoreModel(id: string): any | null {
    const entry = this.characters.get(id);
    if (!entry) return null;
    return getLive2DRuntimeAdapter(entry.runtime).getControls().getCoreModel(entry.model);
  }

  /**
   * Set a Live2D parameter value directly.
   * Used for lip sync, breathing, and other real-time parameter control.
   */
  setParameter(id: string, paramName: string, value: number): void {
    if (isNaN(value) || !isFinite(value)) {
      console.warn(`[Live2DManager] Ignored invalid parameter ${paramName}=${value} for ${id}`);
      return;
    }
    const entry = this.characters.get(id);
    if (!entry) return;
    entry.injectedParams[paramName] = value;
  }

  /**
   * Write a parameter through the real-time lip-sync effect channel and mark
   * it as channel-owned while the lip sync is active (ADR-0029: lip sync keeps
   * running in its own stage; a concurrently evaluating custom motion must not
   * overwrite or release these parameters, and ownership — not execution
   * timing — decides the winner).
   */
  setLipSyncParameter(id: string, paramName: string, value: number): void {
    if (isNaN(value) || !isFinite(value)) {
      console.warn(`[Live2DManager] Ignored invalid parameter ${paramName}=${value} for ${id}`);
      return;
    }
    const entry = this.characters.get(id);
    if (!entry) return;
    entry.injectedParams[paramName] = value;
    (entry.lipSyncParameterIds ??= new Set()).add(paramName);
    // Re-armed before the pending release was pruned: the channel owns the
    // parameter again, so the frame-end handoff must not delete this fresh
    // value.
    entry.pendingLipSyncRelease?.delete(paramName);
  }

  /**
   * Release the lip-sync channel's parameter ownership. Called when a
   * character's lip sync ends; the last written values (e.g. the closing 0)
   * stay in injectedParams so the mouth settles before any later motion or
   * effect takes the parameters over. The released ids are staged in
   * `pendingLipSyncRelease` and dropped from injectedParams at the next
   * updateAll frame boundary — after the closing values have been applied
   * exactly once — so a later owner (custom motion mouth track, resource
   * motion) can actually drive them again (ADR-0029 stage handoff).
   */
  clearLipSyncParameters(id: string): void {
    const entry = this.characters.get(id);
    if (!entry) return;
    const owned = entry.lipSyncParameterIds;
    if (owned && owned.size > 0) {
      (entry.pendingLipSyncRelease ??= new Set());
      for (const parameterId of owned) entry.pendingLipSyncRelease.add(parameterId);
    }
    entry.lipSyncParameterIds?.clear();
  }

  getParameterMetadata(id: string): readonly Live2DParameterMetadata[] {
    const entry = this.characters.get(id);
    if (!entry) return [];
    const controls = getLive2DRuntimeAdapter(entry.runtime).getControls();
    const metadata = controls.getParameterMetadata(entry.model);
    if (metadata) return metadata.map((parameter) => ({ ...parameter }));
    return (controls.getParameterValues(entry.model) ?? []).map((parameter) => ({
      id: parameter.name,
      index: parameter.index,
      defaultValue: Number.isFinite(parameter.value) ? parameter.value : undefined,
      source: 'runtime',
    }));
  }

  /**
   * Get the PIXI objects for GSAP to animate directly.
   */
  getTransformTargets(id: string): { container: PIXI.Container; model: any } | null {
    const entry = this.characters.get(id);
    if (!entry) return null;
    return {
      container: this.getContainer(id),
      model: entry.model,
    };
  }

  /**
   * Transform a character (position, scale, rotation, opacity).
   * Note: This version is now legacy as ScriptEngine uses applyProxyTransform for timeline-based tweens.
   */
  transform(id: string, config: any): void {
    const entry = this.characters.get(id);
    if (!entry) {
      if (!this.pendingConfigs.has(id)) {
        this.pendingConfigs.set(id, []);
      }
      this.pendingConfigs.get(id)!.push(config);
      return;
    }

    const container = this.getContainer(id);

    // During timeline reconstruction (e.g. backward seeking), force all transitions
    // to be instant to reflect the exact state at that frame.
    const isReconstructing = this._scriptEngine?.isReconstructing;

    if (isReconstructing) {
      // Direct set — no GSAP tweens. Avoids tween-on-destroyed-target crashes
      // during rapid seekback when models/containers may be recycled.
      if (config.position) {
        const pos = resolveVec2(config.position);
        container.x = pos.x * STAGE_WIDTH;
        container.y = pos.y * STAGE_HEIGHT;
      }
      if (config.rotation !== undefined) {
        container.angle = config.rotation;
      }
      if (config.scale !== undefined) {
        const targetHeight = STAGE_HEIGHT * config.scale;
        const modelScale = targetHeight / entry.model.height;
        const sign = entry.config.flipX ? -1 : 1;
        entry.model.scale.set(modelScale * sign, modelScale);
      }
      if (config.opacity !== undefined) {
        entry.model.alpha = config.opacity;
      }
      return;
    }

    const duration = config.duration ?? 1;
    const ease = config.ease ?? 'power2.inOut';

    const anim: any = {
      duration,
      ease,
    };

    if (config.position) {
      const pos = resolveVec2(config.position);
      anim.x = pos.x * STAGE_WIDTH;
      anim.y = pos.y * STAGE_HEIGHT;
    }

    if (config.rotation !== undefined) {
      anim.angle = config.rotation;
    }

    // Animate the container for position/rotation
    gsap.to(container, anim);

    // Animate the model for scale/opacity
    const modelAnim: any = {
      duration,
      ease,
    };

    if (config.scale !== undefined) {
      const targetHeight = STAGE_HEIGHT * (config.scale ?? 1.3);
      const modelScale = targetHeight / entry.model.height;
      modelAnim.pixi = { scale: modelScale };
    }

    if (config.opacity !== undefined) {
      modelAnim.alpha = config.opacity;
    }

    if (Object.keys(modelAnim).length > 2) {
      gsap.to(entry.model, modelAnim);
    }
  }

  /**
   * Set character focus (look at) in range [-1, 1].
   *
   * The underlying pixi-live2d-display FocusController has a fixed internal
   * acceleration model that is neither frame-rate-independent nor duration-
   * controllable. We therefore own the interpolation here with GSAP when a
   * non-zero duration is requested, and only fall back to the controller's
   * built-in physics when a caller intentionally passes duration 0 (absolute
   * seek state).
   */
  lookAt(
    id: string,
    focusX: number,
    focusY: number,
    duration: number = 0.5,
    options?: LookAtOptions,
  ): void {
    const entry = this.characters.get(id);
    if (!entry) {
      this.pendingLookAts.set(id, { focusX, focusY, duration, options });
      return;
    }

    this.pendingLookAts.delete(id);

    if (!entry.model) {
      (entry as any)._pendingLookAt = { focusX, focusY, duration, options };
      return;
    }

    // The focus-controller interpolation (GSAP ownership, frame writes, SDK
    // focus fallback) is entirely owned by the runtime adapter.
    getLive2DRuntimeAdapter(entry.runtime).getControls().applyFocus(entry.model, {
      focusX,
      focusY,
      duration,
      options,
    });
  }

  /**
   * Re-apply active target-follow gaze every playback frame. Scene timestamps
   * and character positions are resolved by RuntimeSceneState; this keeps the
   * Live2D focus following the target in real time instead of locking the gaze
   * direction captured when the lookAt action first fired.
   */
  syncLookAtFollows(characterStates: Map<string, any>): void {
    if (!this._shouldUpdate && !this._scriptEngine?.isReconstructing) return;
    for (const [id, state] of characterStates) {
      const lookAt = state?.lookAt;
      const target = typeof lookAt?.target === 'string' && lookAt.target.trim();
      if (!target) continue;
      const focus = lookAt?.focus;
      if (!Array.isArray(focus) || focus.length < 2) continue;
      const x = Number(focus[0]);
      const y = Number(focus[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        this.lookAt(id, x, y, 0);
      }
    }
  }

  /**
   * Toggle auto-blink and set the runtime interval in milliseconds.
   *
   * Semantic/UI callers use seconds and convert exactly once at the scheduler
   * boundary. Keeping this method explicitly millisecond-based preserves the
   * Cubism 2 eye-blink contract for ordinary and composed models.
   */
  setBlink(
    id: string,
    enabled: boolean,
    intervalMs: number = 4000,
    sceneTimeSeconds?: number,
    startTimeSeconds?: number,
    intervalRangeMs?: number,
  ): void {
    const entry = this.characters.get(id);
    if (!entry) {
      this.pendingBlinks.set(id, { enabled, intervalMs, sceneTimeSeconds, startTimeSeconds, intervalRangeMs });
      return;
    }

    this.pendingBlinks.delete(id);

    if (!entry.model) {
      (entry as any)._pendingBlink = { enabled, intervalMs, sceneTimeSeconds, startTimeSeconds, intervalRangeMs };
      return;
    }

    // Eye-blink channel manipulation (updater wrap, multiplier, interval) is
    // owned by the runtime adapter.
    getLive2DRuntimeAdapter(entry.runtime).getControls().setBlink(
      entry.model,
      enabled,
      intervalMs,
      sceneTimeSeconds,
      startTimeSeconds,
      intervalRangeMs,
    );
  }

  private resolvePointSourceModel(model: any, pointName: 'head' | 'chest' | 'feet' | 'center'): any {
    if (!model) return null;

    if (model instanceof Live2DCompositeModel) {
      if (pointName === 'head') {
        return model.subModels?.[0] ?? model.mainModel ?? model;
      }
      if (pointName === 'chest') {
        return model.mainModel ?? model;
      }
    }

    return model;
  }

  getPoint(id: string, pointName: 'head' | 'chest' | 'feet' | 'center', out?: { x: number; y: number }): { x: number, y: number } | null {
    const entry = this.characters.get(id);

    // 1. Prefer model-defined head hit areas when available.
    // This gives us the semantic head anchor instead of guessing from the full container bounds.
    if (entry?.model) {
      try {
        const model = this.resolvePointSourceModel(entry.model, pointName) as any;
        const bounds = typeof model?.getBounds === 'function'
          ? model.getBounds()
          : typeof model?.getLocalBounds === 'function'
            ? model.getLocalBounds()
            : null;

        if (bounds && isFinite(bounds.x) && isFinite(bounds.y) && isFinite(bounds.width) && isFinite(bounds.height) && bounds.width > 0 && bounds.height > 0) {
          const centerX = bounds.x + bounds.width * 0.5;
          const centerY = bounds.y + bounds.height * 0.5;
          const headAnchor = pointName === 'head'
            ? getLive2DRuntimeAdapter(entry.runtime).getControls().getHeadAnchor(model)
            : null;

          let x = centerX;
          let y = centerY;
          if (headAnchor && pointName === 'head') {
            x = bounds.x + bounds.width * headAnchor.x;
            y = bounds.y + bounds.height * headAnchor.y;
          } else {
            switch (pointName) {
              case 'head':
                y = bounds.y + bounds.height * 0.18;
                break;
              case 'chest':
                y = bounds.y + bounds.height * 0.42;
                break;
              case 'center':
                y = centerY;
                break;
              case 'feet':
                y = bounds.y + bounds.height * 0.95;
                break;
            }
          }

          const normalizedX = x / 1920;
          const normalizedY = y / 1080;
          if (out) {
            out.x = normalizedX;
            out.y = normalizedY;
            return out;
          }
          return { x: normalizedX, y: normalizedY };
        }
      } catch {
        // Fall back to proxy-based estimation below.
      }
    }

    // 2. When the live model cannot provide bounds, fall back to the pure proxy estimate.
    // This keeps seek/scrub stable even before the model is fully available.
    if (this._scriptEngine && this._scriptEngine.transformationProxies) {
      const proxy = this._scriptEngine.transformationProxies.get(id);
      if (proxy) {
        const nx = proxy.x / 1920;
        const ny = proxy.y / 1080;
        const scale = proxy.scale !== undefined ? proxy.scale : 1.0;
        
        let targetY = ny;
        switch (pointName) {
          case 'head':   targetY = ny - 0.60 * scale; break;
          case 'chest':  targetY = ny - 0.38 * scale; break;
          case 'center': targetY = ny - 0.40 * scale; break;
          case 'feet':   targetY = ny; break;
        }
        
        if (out) {
          out.x = nx;
          out.y = targetY;
          return out;
        }
        return { x: nx, y: targetY };
      }
    }

    // Final fallback.
    if (!entry || !entry.model) return null;
    return { x: 0.5, y: 0.5 };
  }

  getPosition(id: string): { x: number; y: number } | null {
    // Return the visual center of the character in UI space for accurate camera centering.
    return this.getPoint(id, 'center');
  }

  private getStableSampleBoundsForCamera(id: string, camera: { position: Vec2; zoom: number } | null): PIXI.Rectangle | null {
    const entry = this.characters.get(id);
    if (!entry) return null;

    const proxy = this._scriptEngine?.transformationProxies?.get(id);
    if (!proxy) return null;

    const effectiveScale = (proxy.scale ?? 1) * (camera?.zoom ?? 1);
    if (!Number.isFinite(effectiveScale) || effectiveScale <= 0) return null;

    const projected = camera
      ? projectToScreen(
          { x: proxy.x, y: proxy.y, scale: proxy.scale ?? 1, z: proxy.z ?? 0 },
          camera,
          { w: STAGE_WIDTH, h: STAGE_HEIGHT },
        )
      : {
          screenX: proxy.x,
          screenY: proxy.y,
          screenScale: effectiveScale,
        };

    const height = STAGE_HEIGHT * effectiveScale;
    const aspectRatio = entry.baseWidth && entry.baseHeight
      ? entry.baseWidth / entry.baseHeight
      : 0.58;
    const width = height * aspectRatio;

    // Stable reference frame:
    // x uses center anchor, y uses the long-lived feet anchor with a small under-foot allowance.
    const left = projected.screenX - width * 0.5;
    const top = projected.screenY - height * 0.9;
    return new PIXI.Rectangle(left, top, width, height);
  }

  getStableSampleBounds(id: string): PIXI.Rectangle | null {
    return this.getStableSampleBoundsForCamera(id, this.currentCamera);
  }

  getStableWorldSampleBounds(id: string): PIXI.Rectangle | null {
    return this.getStableSampleBoundsForCamera(id, null);
  }

  getEnvironmentLayerProxy(layerId: string): { x: number; y: number; scale: number; rotation: number; opacity: number; z: number } | null {
    const proxy = this._scriptEngine?.environmentLayerProxies?.get?.(layerId);
    if (!proxy) return null;
    return {
      x: proxy.x,
      y: proxy.y,
      scale: proxy.scale,
      rotation: proxy.rotation,
      opacity: proxy.opacity,
      z: proxy.z,
    };
  }

  /**
   * Add a directional rim light to a character using a drop shadow approach.
   */
  setRimLight(id: string, color: string | number = 0xFFFFFF, intensity: number = 1.0, thickness: number = 10, angle: number = 45, softness: number = 2, duration: number = 1.0, sceneTime?: number): void {
    const entry = this.characters.get(id);
    const commandTime = Number.isFinite(sceneTime)
      ? sceneTime
      : this._scriptEngine?.getCurrentTime?.();
    const command: Extract<PendingRimLightCommand, { mode: 'set' }> = {
      mode: 'set',
      color,
      intensity,
      thickness,
      angle,
      softness,
      duration,
      ...(Number.isFinite(commandTime) ? { startTime: commandTime } : {}),
    };
    if (!entry) {
      this.pendingRimLightCommands.set(id, command);
      this.pendingRimLightStates.delete(id);
      return;
    }

    this.pendingRimLightCommands.delete(id);
    this.pendingRimLightStates.delete(id);
    this.applyRimLightSet(id, command, this.getElapsedSince(command.startTime));
  }

  private applyRimLightSet(
    id: string,
    command: Extract<PendingRimLightCommand, { mode: 'set' }>,
    elapsed: number = 0,
  ): void {
    const entry = this.characters.get(id);
    if (!entry) return;

    const filter = this.ensureRimFilter(id, command.thickness, command.angle);
    if (!filter) return;

    this.configureRimFilter(filter, {
      color: command.color,
      thickness: command.thickness,
      angle: command.angle,
      softness: command.softness,
      alpha: (entry as any).rimProxy?.alpha ?? 0,
    });

    const proxy = (entry as any).rimProxy;
    const df = filter as any;

    // Tween only the rim alpha; the filter keeps the source pixels opaque over
    // the generated rim so the character body masks the light.
    gsap.killTweensOf(proxy);
    if ('enabled' in df) df.enabled = true;

    const applyAlpha = () => {
      df.alpha = proxy.alpha;
      if ('enabled' in df) df.enabled = proxy.alpha > 0.05;
    };

    const duration = Math.max(0, command.duration);
    if (duration <= 0 || elapsed >= duration) {
      proxy.alpha = command.intensity;
      applyAlpha();
      return;
    }

    if (elapsed > 0) {
      const progress = gsap.parseEase('power2.inOut')(Math.min(1, elapsed / duration));
      proxy.alpha = command.intensity * progress;
      applyAlpha();
    }

    gsap.to(proxy, {
      alpha: command.intensity,
      duration: Math.max(0, duration - elapsed),
      ease: elapsed > 0 ? 'none' : 'power2.inOut',
      onUpdate: applyAlpha,
      onComplete: applyAlpha,
    });
  }

  /** Fade the current character rim light out without applying default style values. */
  resetRimLight(id: string, duration: number = 0.4, baseline?: RimLightStyleState, sceneTime?: number): void {
    const entry = this.characters.get(id);
    const commandTime = Number.isFinite(sceneTime)
      ? sceneTime
      : this._scriptEngine?.getCurrentTime?.();
    const command: Extract<PendingRimLightCommand, { mode: 'reset' }> = {
      mode: 'reset',
      duration,
      ...(baseline ? { baseline } : {}),
      ...(Number.isFinite(commandTime) ? { startTime: commandTime } : {}),
    };
    if (!entry) {
      this.pendingRimLightCommands.set(id, command);
      this.pendingRimLightStates.delete(id);
      return;
    }

    this.pendingRimLightCommands.delete(id);
    this.pendingRimLightStates.delete(id);
    this.applyRimLightReset(id, duration, baseline, this.getElapsedSince(command.startTime));
  }

  private applyRimLightReset(id: string, duration: number, baseline?: RimLightStyleState, elapsed: number = 0): void {
    const entry = this.characters.get(id);
    if (!entry) return;

    let filter = (entry as any).rimFilter as RimLightFilter | undefined;
    let proxy = (entry as any).rimProxy as { alpha: number } | undefined;
    if ((!filter || !proxy) && baseline && baseline.intensity > 0) {
      filter = this.ensureRimFilter(id, baseline.thickness, baseline.angle) ?? undefined;
      proxy = (entry as any).rimProxy as { alpha: number } | undefined;
    }
    if (!filter || !proxy) return;

    const df = filter as any;
    if (baseline) {
      this.configureRimFilter(filter, {
        ...baseline,
        alpha: proxy.alpha,
      });
    }
    const applyAlpha = () => {
      df.alpha = proxy.alpha;
      if ('enabled' in df) df.enabled = proxy.alpha > 0.05;
    };

    gsap.killTweensOf(proxy);
    const targetAlpha = baseline?.intensity ?? 0;
    if (duration <= 0 || elapsed >= duration) {
      proxy.alpha = targetAlpha;
      applyAlpha();
      return;
    }

    if (elapsed > 0) {
      const progress = gsap.parseEase('power2.inOut')(Math.min(1, elapsed / duration));
      proxy.alpha += (targetAlpha - proxy.alpha) * progress;
      applyAlpha();
    }

    if (proxy.alpha > 0.05 && 'enabled' in df) df.enabled = true;
    gsap.to(proxy, {
      alpha: targetAlpha,
      duration: Math.max(0, duration - elapsed),
      ease: elapsed > 0 ? 'none' : 'power2.inOut',
      onUpdate: applyAlpha,
      onComplete: applyAlpha,
    });
  }

  /**
   * Reconcile character rim lights for absolute seek/scrubbing compatibility.
   */
  reconcileRimLights(time: number, scene: RuntimeTimelineScene): void {
    this.pendingRimLightCommands.clear();
    this.pendingRimLightStates.clear();
    for (const id of this.listCharacters()) {
      this.clearRimLight(id);
    }

    const rimStates = resolveRimLightStateAtTime(scene, time);
    for (const [id, state] of rimStates) {
      this.pendingRimLightStates.set(id, state);
      this.applyResolvedRimLightState(id, state);
    }
  }

  private applyResolvedRimLightState(id: string, state: ResolvedRimLightState): void {
    const filter = this.ensureRimFilter(id, state.thickness, state.angle);
    if (!filter) return;

    this.configureRimFilter(filter, state);
    const entry = this.characters.get(id);
    const proxy = (entry as any)?.rimProxy as { alpha: number } | undefined;
    if (!proxy) return;

    gsap.killTweensOf(proxy);
    proxy.alpha = state.alpha;
    const df = filter as any;
    df.alpha = state.alpha;
    if ('enabled' in df) df.enabled = state.alpha > 0.05;
  }

  private ensureRimFilter(id: string, thickness: number, angle: number): RimLightFilter | null {
    const entry = this.characters.get(id);
    if (!entry) return null;
    const container = this.getContainer(id);

    let filter = (entry as any).rimFilter as RimLightFilter;
    if (!filter) {
      filter = new RimLightFilter({
        distance: thickness,
        rotation: angle,
        blur: 2,
        alpha: 0,
        color: 0xFFFFFF,
      });
      (entry as any).rimFilter = filter;
      (entry as any).rimProxy = { alpha: 0 };

      const currentFilters = container.filters || [];
      container.filters = [...currentFilters, filter];
    }
    return filter;
  }

  private configureRimFilter(filter: RimLightFilter, state: {
    color: string | number;
    thickness: number;
    angle: number;
    softness: number;
    alpha: number;
  }): void {
    const df = filter as any;
    df.color = typeof state.color === 'string'
      ? parseInt((state.color || '#ffffff').replace('#', '0x'))
      : state.color;
    df.distance = state.thickness;
    df.rotation = state.angle;
    df.blur = state.softness;
    df.alpha = state.alpha;
    if ('enabled' in df) df.enabled = state.alpha > 0.05;
  }

  private clearRimLight(id: string): void {
    const entry = this.characters.get(id);
    if (!entry) return;
    const filter = (entry as any).rimFilter as RimLightFilter;
    const proxy = (entry as any).rimProxy as { alpha: number } | undefined;
    if (proxy) gsap.killTweensOf(proxy);
    if (filter) {
      filter.alpha = 0;
      if ('enabled' in filter) (filter as any).enabled = false;
      if (proxy) {
        proxy.alpha = 0;
      }
    }
  }

  getMotionDuration(id: string, motionKey: string): number {
    this.ensureMotionController();
    return this.motionController!.getMotionDuration(id, motionKey);
  }

  /**
   * Return Cubism 2.1 sampling targets used by the runtime motion curve cache.
   * The motion controller owns the concrete-model/motion-manager seam.
   */
  getMotionSamplerTargets(id: string): readonly import('./live2d/cubism2MotionSampler').Cubism2MotionSamplerTarget[] {
    this.ensureMotionController();
    return this.motionController!.getMotionSamplerTargets(id);
  }

  /**
   * Directly set a character's model scale. Used for per-frame updates
   * during Hitchcock zoom where scale must change every animation frame.
   */
  setCharacterScale(id: string, scale: number): void {
    const entry = this.characters.get(id);
    if (!entry || !entry.model) return;
    const sign = entry.model.scale.x < 0 ? -1 : 1;
    entry.model.scale.set(scale * sign, scale);
  }

  /**
   * Sync character transformation from a proxy object (used during seek/animate).
   * When `camera` is provided (or `this.currentCamera` is set), applies ECS projection
   * via projectToScreen(). Otherwise falls back to direct 2D assignment.
   */
  applyProxyTransform(
    id: string,
    proxy: any,
    modelOverride?: any,
    camera?: { position: Vec2; zoom: number },
  ): void {
    const entry = this.characters.get(id);
    if (!proxy) return;

    // Resolve effective camera: explicit param > stored currentCamera > null (2D fallback)
    const cam = camera !== undefined ? camera : this.currentCamera;

    const container = this.getContainer(id);
    if (container) {
      // ── ECS Projection (replaces old pivot-based camera) ──
      if (cam && proxy.x !== undefined && proxy.y !== undefined) {
        const projected = projectToScreen(
          { x: proxy.x, y: proxy.y, scale: proxy.scale ?? 1, z: proxy.z ?? 0 },
          cam,
          { w: STAGE_WIDTH, h: STAGE_HEIGHT },
        );
        if (isFinite(projected.screenX)) container.x = projected.screenX;
        if (isFinite(projected.screenY)) container.y = projected.screenY;
      } else {
        // 2D fallback — no camera, use raw proxy position
        if (proxy.x !== undefined && isFinite(proxy.x)) container.x = proxy.x;
        if (proxy.y !== undefined && isFinite(proxy.y)) container.y = proxy.y;
      }

      if (proxy.rotation !== undefined && isFinite(proxy.rotation)) container.angle = proxy.rotation;

      // ── Z-index for depth ordering ──
      if (proxy.z !== undefined && isFinite(proxy.z)) {
        container.zIndex = proxy.z;
      }

      // Use AlphaFilter as the single opacity authority while transparent.
      // Some Live2D draw paths can ignore container/model alpha for a frame;
      // switching this filter off during warmup causes an opaque entrance flash.
      if (proxy.opacity !== undefined && isFinite(proxy.opacity)) {
        const opacity = Math.max(0, Math.min(1, proxy.opacity));
        const isTransparent = opacity < 0.999;
        container.renderable = opacity > 0.0001;

        if (isTransparent) {
          container.alpha = 1.0;

          let alphaFilter = (container as any)._alphaFilter as any;
          if (!alphaFilter) {
            alphaFilter = new PIXI.AlphaFilter({ alpha: opacity });
            alphaFilter.padding = 50;
            (container as any)._alphaFilter = alphaFilter;
          } else {
            alphaFilter.alpha = opacity;
          }

          // PixiJS 8 freezes the array returned by the `filters` getter
          // (effectsMixin `Object.freeze(value.slice(0))`) — in-place
          // push/splice throws "Cannot delete property '0'". Mutations must
          // go through the setter with a fresh array.
          const currentFilters = container.filters as any[] | null;
          if (!currentFilters || currentFilters.length === 0) {
            container.filters = [alphaFilter];
            (container as any)._filtersDirty = true;
          } else if (currentFilters.indexOf(alphaFilter) === -1) {
            container.filters = [...currentFilters, alphaFilter];
            (container as any)._filtersDirty = true;
          }
        } else {
          container.alpha = opacity;
          container.renderable = true;

          const alphaFilter = (container as any)._alphaFilter as any;
          const currentFilters = container.filters as any[] | null;
          if (currentFilters && alphaFilter && currentFilters.indexOf(alphaFilter) !== -1) {
            const remaining = currentFilters.filter((f: any) => f !== alphaFilter);
            container.filters = remaining.length > 0 ? remaining : null;
            (container as any)._filtersDirty = true;
          }
        }
      }
    }

    const model = modelOverride || entry?.model;
    if (model) {
      if (proxy.scale !== undefined && isFinite(proxy.scale)) {
        // Apply camera zoom to scale (replicates old container-level zoom behavior)
        const effectiveScale = cam ? proxy.scale * cam.zoom : proxy.scale;
        const targetHeight = STAGE_HEIGHT * effectiveScale;
        const baseH = entry?.baseHeight || (model as any)._baseHeight || model.height;
        const modelScale = targetHeight / baseH;
        
        if (isFinite(modelScale)) {
          const flipX = entry?.config?.flipX || (model as any)._flipX;
          const sign = flipX ? -1 : 1;
          model.scale.set(modelScale * sign, modelScale);
        }
      }
      if (proxy.opacity !== undefined && isFinite(proxy.opacity)) {
        const opacity = Math.max(0, Math.min(1, proxy.opacity));
        model.alpha = opacity < 0.999 ? 1.0 : opacity;
      }
    }
  }

  canApplyContainerFilters(id: string): boolean {
    const entry = this.characters.get(id);
    return !entry?.filterWarmupFrames || entry.filterWarmupFrames <= 0;
  }

  hasActiveFilterWarmup(): boolean {
    for (const entry of this.characters.values()) {
      if (entry.filterWarmupFrames && entry.filterWarmupFrames > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get available motion keys for a loaded character.
   */
  getAvailableMotions(id: string): string[] {
    const entry = this.characters.get(id);
    if (!entry) return [];

    try {
      return entry.runtimeHandle?.motion.getAvailableMotions()
        ?? getLive2DRuntimeAdapter(entry.runtime).getControls().getAvailableMotions(entry.model);
    } catch (e) {
      console.warn(`[Live2D] Failed to get motions for "${id}":`, e);
    }
    return [];
  }

  /**
   * Static retrieval of motions/expressions from a model.json path.
   * This works even if the character is not loaded or on stage.
   */
  getModelDataFromPath(modelPath: string): Promise<{ motions: string[], expressions: string[] }> {
    return this.modelLoader.getModelDataFromPath(modelPath);
  }

  resolveMotionKeyForModel(modelPath: string, motionKey: string): Promise<string> {
    return this.modelLoader.resolveMotionKey(modelPath, motionKey);
  }

  /**
   * Get available expression keys for a loaded character.
   */
  getAvailableExpressions(id: string): string[] {
    const entry = this.characters.get(id);
    if (!entry) return [];

    try {
      return entry.runtimeHandle?.expression.getAvailableExpressions()
        ?? getLive2DRuntimeAdapter(entry.runtime).getControls().getAvailableExpressions(entry.model);
    } catch (e) {
      console.warn(`[Live2D] Failed to get expressions for "${id}":`, e);
    }
    return [];
  }

  /**
   * List all active character IDs.
   */

  /**
   * Get all character entries (for iteration).
   */
  getAllCharacters(): Map<string, CharacterEntry> {
    return this.characters;
  }

  /**
   * Capture snapshot via pure function (shared with BakeEngine).
   */
  captureSnapshot(id: string): ModelSnapshot | null {
    const entry = this.characters.get(id);
    if (!entry || !entry.model) return null;
    return entry.runtimeHandle?.snapshot.captureSnapshot(entry.motionStartTime)
      ?? getLive2DRuntimeAdapter(entry.runtime).getControls().captureSnapshot(id, entry.model, entry.motionStartTime);
  }

  /**
   * Restore a character's state from a snapshot.
   */
  applySnapshot(id: string, snapshot: ModelSnapshot): void {
    this.ensureMotionController();
    this.motionController!.applySnapshot(id, snapshot);
  }

  async restoreSeekState(
    id: string,
    input: {
      snapshot?: ModelSnapshot | null;
      handoffSnapshot?: ModelSnapshot | null;
      targetSceneTime: number;
      motion?: { key: string; priority?: number; offset: number; sceneTime: number; fadeInSeconds?: number } | null;
      expression?: { key: string | null } | null;
      isScrubbing?: boolean;
      preserveMotionForPlayback?: boolean;
    },
  ): Promise<void> {
    const entry = this.characters.get(id);
    if (!entry?.model) return;
    const lifecycleGeneration = entry.lifecycleGeneration ?? 0;
    const controls = getLive2DRuntimeAdapter(entry.runtime).getControls();
    let result;
    try {
      result = await controls.restoreSeekState(entry.model, {
        id,
        snapshot: input.snapshot ?? null,
        handoffSnapshot: input.handoffSnapshot ?? null,
        targetSceneTime: input.targetSceneTime,
        motion: input.motion ?? null,
        expression: input.expression ?? null,
        idleSnapshot: entry.idleSnapshot ?? null,
        isScrubbing: input.isScrubbing,
        preserveMotionForPlayback: input.preserveMotionForPlayback,
      });
    } catch (err) {
      if (this.characters.get(id) !== entry || (entry.lifecycleGeneration ?? 0) !== lifecycleGeneration) {
        return;
      }
      console.warn(`[Live2D] Seek restore failed for "${id}"; preserving timeline execution.`, err);
      result = {
        status: 'fallback' as const,
        tierUsed: 'unsupported' as const,
        diagnostics: [err instanceof Error ? err.message : String(err)],
      };
    }
    if (this.characters.get(id) !== entry || (entry.lifecycleGeneration ?? 0) !== lifecycleGeneration) {
      return;
    }
    if (input.snapshot) {
      entry.lastSnapshot = input.snapshot;
    }
    if (input.motion) {
      entry.motionStartTime = input.motion.sceneTime - input.motion.offset;
      entry.lastOffset = input.motion.offset;
    } else {
      entry.motionStartTime = undefined;
      entry.lastOffset = undefined;
    }
    if (result.status !== 'restored') {
      console.warn(`[Live2D] Seek restore fallback for "${id}" (${result.tierUsed}): ${(result.diagnostics ?? []).join('; ')}`);
    }
  }

  /**
   * Check if any character is currently in the middle of loading or starting a motion.
   * Used by ScriptEngine to ensure snapshots are not taken during transition.
   */
  isMotionLoading(): boolean {
    return this.motionController ? this.motionController.isMotionLoading() : this._activeMotionLoads.size > 0;
  }

  /**
   * Log all available parameters and their current values for a character.
   */
  /**
   * Log internal SDK motion state for debugging.
   */
  debugMotionState(id: string): void {
    const entry = this.characters.get(id);
    if (!entry) return;
    console.log(
      `[Live2D Debug] Motion State for "${id}":`,
      getLive2DRuntimeAdapter(entry.runtime).getControls().getMotionDebugState(entry.model),
    );
  }

  logModelParameters(id: string): void {
    const entry = this.characters.get(id);
    if (!entry) return;
    const values = getLive2DRuntimeAdapter(entry.runtime).getControls().getParameterValues(entry.model);
    if (!values) return;

    console.group(`[Live2D] Parameters for "${id}"`);
    try {
      for (const param of values) {
        console.log(`${param.index}: ${param.name} = ${param.value.toFixed(4)}`);
      }
    } catch (e) {
      console.error("[Live2D] Failed to log parameters:", e);
    }
    console.groupEnd();
  }

  setEngine(engine: any): void {
    this._scriptEngine = engine;
  }

  /**
   * Toggle cache-first evaluation for resource motions. When enabled and the
   * runtime curve cache has a per-frame entry for the motion, `playMotion`
   * routes through the shared custom-motion evaluator instead of the SDK
   * queue. SDK fallback always remains for uncached motions.
   */
  setResourceMotionCacheEnabled(flag: boolean): void {
    this.resourceMotionCacheEnabled = flag;
  }

  isResourceMotionCacheEnabled(): boolean {
    return this.resourceMotionCacheEnabled;
  }

  listCharacters(): string[] {
    return Array.from(this.characters.keys());
  }

  /**
   * Stop all active GSAP tweens on a character (breathing, focus, transforms, etc.)
   * Used during hot reloads to ensure a clean state.
   */
  stopAllCharacterTweens(id: string): void {
    this.ensureMotionController();
    this.motionController!.stopAllCharacterTweens(id);
  }

  hasCharacter(id: string): boolean {
    return this.characters.has(id);
  }

  private describeInvalidModelState(entry: CharacterEntry): string | null {
    return entry.runtimeHandle?.diagnostics.describeInvalidState()
      ?? getLive2DRuntimeAdapter(entry.runtime).getControls().describeInvalidState(entry.model);
  }

  private async repairCorruptedModel(entry: CharacterEntry, reason: string, waitForRepair: boolean): Promise<void> {
    entry.isCorrupted = true;
    entry.injectedParams = {};

    if (!entry.corruptionRepairPromise) {
      console.warn(
        `%c[Live2D] Invalid model state detected in "${entry.id}" (${reason}); clearing injected params and repairing...`,
        'color: #f00; font-weight: bold;',
      );
      this.ensureMotionController();
      entry.corruptionRepairPromise = this.motionController!._hardReset(entry.id, entry.model)
        .then(() => {
          if (this.characters.get(entry.id) !== entry) return;

          const remainingIssue = this.describeInvalidModelState(entry);
          if (remainingIssue) {
            entry.isCorrupted = true;
            console.warn(`[Live2D] Repair for "${entry.id}" completed but model is still invalid (${remainingIssue}).`);
            return;
          }

          entry.isCorrupted = false;
          console.log(`[Live2D] NaN repair complete for "${entry.id}", updates resumed.`);
        })
        .catch((err) => {
          console.warn(`[Live2D] NaN repair failed for "${entry.id}":`, err);
        })
        .finally(() => {
          if (this.characters.get(entry.id) === entry) {
            entry.corruptionRepairPromise = undefined;
          }
        });
    }

    if (waitForRepair) {
      await entry.corruptionRepairPromise;
    }
  }

  setAutoUpdate(enabled: boolean): void {
    this._shouldUpdate = enabled;
    // We explicitly keep entry.model.autoUpdate = false to prevent double-stepping,
    // and let our updateAll() drive the animation!
    for (const entry of this.characters.values()) {
      entry.model.autoUpdate = false;
    }
  }

  /**
   * Manually update all characters by a fixed delta time.
   * @param dt Delta time in milliseconds. PixiJS ticker callers must pass deltaMS.
   * @param forceStep If true, bypass the pause-throttle and perform a full update.
   */
  async updateAll(dt: number, forceStep: boolean = false, manualTimeMs?: number): Promise<void> {
    // Cubism 2 offset replay temporarily owns the process-wide SDK clock.
    // That lock must not stall official Cubism Web models, whose motion time is
    // instance-local. During a normal ticker pass, leave Cubism 2 intents and
    // frames untouched until the lock is released, but keep updating Cubism 3+
    // entries so mixed-runtime characters can animate concurrently.
    const sharedClockLocked = isUtSystemLockActive() && !forceStep && manualTimeMs === undefined;

    const targetMap = this.characters;

    // 0. 在任何时间或渲染更新之前，先结算本帧积累的最新动作指令！
    // 绝对不能在 Ticker 回调中 await —— PixiJS Ticker 是同步触发的，
    // await 会让当前帧的模型更新被推迟，而下一帧的 Ticker 又进入，
    // 造成时间步进双倍计算、物理崩溃（NaN）。
    // 将动作作为后台任务踢出，_motionMutex 负责串行化。
    this._pendingMotionCount = 0;
    for (const entry of targetMap.values()) {
      if (sharedClockLocked && entry.runtime?.adapterId !== 'untitled-pixi-live2d-engine-cubism') {
        continue;
      }
      if ((entry as any)._pendingPlayMotion) {
        const req = (entry as any)._pendingPlayMotion as any;
        (entry as any)._pendingPlayMotion = undefined;
        // 复用对象池中的对象，避免每帧分配新字面量
        if (!this._pendingMotionQueue[this._pendingMotionCount]) {
          this._pendingMotionQueue[this._pendingMotionCount] = { id: '', req: null };
        }
        const poolItem = this._pendingMotionQueue[this._pendingMotionCount];
        poolItem.id = entry.id;
        poolItem.req = req;
        this._pendingMotionCount++;
      }
    }
    const motionPromises: Promise<void>[] = [];
    for (let i = 0; i < this._pendingMotionCount; i++) {
      const { id, req } = this._pendingMotionQueue[i];
      const p = this.motionController!.dispatchMotion(id, req)
        .catch(e => console.error(`[Live2D] Background motion execution failed for ${id}:`, e));
      motionPromises.push(p);
    }
    if (forceStep && motionPromises.length > 0) {
      await Promise.all(motionPromises);
    }

    // 1. `dt` is already milliseconds for every production caller. In
    // particular, PixiJS 8 supplies ticker.deltaMS; multiplying it by the old
    // frame-factor conversion advanced every runtime (and the Cubism 2 global
    // clock) about three times per rendered frame after the 50ms safety clamp.
    let deltaInMs = dt;

    if (!this._shouldUpdate && !forceStep) {
      deltaInMs = 0.0001;
    }

    const shouldStepModels = deltaInMs > 0;
    // 核心物理稳定优化：单帧最高物理增量限制在 50ms（相当于 20FPS 下限），
    // 并且普通更新绝对禁止 dt 严格等于 0（最低为 0.001ms），彻底隔绝大帧延迟、零帧、系统瞬间卡顿造成的 Euler 物理积分 NaN/Infinity 溢出。
    // 但 seek 同步会用 updateAll(0, true, manualTimeMs) 只结算 pending motion；
    // 这个路径必须保持 0ms，不能隐藏推进到 0.001ms，否则暂停 seek 会继续步进动作。
    deltaInMs = shouldStepModels ? Math.min(50, Math.max(0.001, deltaInMs)) : 0;

    // 2. 每帧将 SDK 时钟单调递增 deltaInMs
    // 全局时钟一旦被 setUserTimeMSec 设置后就不再自动推进，必须手动驱动。
    // 物理引擎和动作管理器都依赖时钟的 getUserTimeMSec() 计算 dt 和 elapsed，
    // 如果时钟冻结：动作不播放、物理引擎看到 dt=0。
    // 条件：
    //   - 没有角色正在做锁保护的时钟跳跃（_executePlayMotion）
    //   - 调用者没有传入 manualTimeMs（传入时表示调用者已在外部管理时钟，如 _doSeek 的 utBaseline 循环）
    // SDK 时钟经 adapter 的 opaque handle 访问（no Jannchie globals here）。
    const sdkClock = cubism2Live2DAdapter.getClock();
    if (sdkClock && !sharedClockLocked && this._jumpingCharacters.size === 0 && manualTimeMs === undefined) {
      sdkClock.setUserTimeMSec(sdkClock.getUserTimeMSec() + deltaInMs);
    }

    // 保持 _currentDt 为初始值 0，确保 render 钩子在播放时不重复推进时间
    for (const entry of this.characters.values()) {
      if (sharedClockLocked && entry.runtime?.adapterId !== 'untitled-pixi-live2d-engine-cubism') {
        continue;
      }
      if (entry.filterWarmupFrames && entry.filterWarmupFrames > 0 && !this._scriptEngine?.isReconstructing) {
        entry.filterWarmupFrames = Math.max(0, entry.filterWarmupFrames - 1);
      }
      // NaN/Infinity detection before and after stepping. Export capture renders
      // immediately after updateAll(), so forceStep must wait for repair before capture.
      if (entry.isCorrupted || entry.corruptionRepairPromise) {
        await this.repairCorruptedModel(entry, 'previous invalid state', forceStep);
      } else {
        const invalidBeforeUpdate = this.describeInvalidModelState(entry);
        if (invalidBeforeUpdate) {
          await this.repairCorruptedModel(entry, invalidBeforeUpdate, forceStep);
        }
      }

      // 快照修复：如果模型处于损坏状态，绝对禁止步进，防止 NaN 扩散到 WebGL 渲染管线
      if (!entry.isCorrupted) {
        try {
          if (manualTimeMs !== undefined) {
            entry.lastManualTimeMs = manualTimeMs;
          }

          // 在 updateAll 中执行更新，确保播放/导出时能立即看到反馈。
          // 0ms seek flush 只结算动作指令，不推进模型时间。
          if (entry.customMotion) {
            // Lazy heal: a motion that took over before its model finished
            // loading gets staged on the first frame the model exists. No-op
            // once installed or after a recorded failed attempt.
            this.maybeInstallCustomMotionStageOnEntry(entry);
            entry.customMotionStage?.setSceneTime(this.resolveCustomMotionSceneTime(entry, manualTimeMs));
          }
          if (entry.pendingSeekBoundarySnapshot) {
            if (manualTimeMs === undefined) {
              entry.pendingSeekBoundarySnapshot = undefined;
              entry.pendingSeekBoundaryMotionStartTime = undefined;
              entry.pendingSeekBoundaryDuration = undefined;
            } else {
              const currentSnapshot = getLive2DRuntimeAdapter(entry.runtime).getControls().captureSnapshot(
                entry.id,
                entry.model,
                entry.motionStartTime,
              );
              // Keep the handoff only while Cubism is still exposing its
              // default pose. Once the new motion has produced any pose,
              // including face parameters, restoring the old full snapshot
              // would mask the new motion indefinitely during paused seeks.
              const shouldHoldBoundaryPose = isDefaultLive2DPose(currentSnapshot);

              if (shouldHoldBoundaryPose) {
                getLive2DRuntimeAdapter(entry.runtime).getControls().applySnapshot(entry.model, entry.pendingSeekBoundarySnapshot);
              } else {
                entry.pendingSeekBoundarySnapshot = undefined;
                entry.pendingSeekBoundaryMotionStartTime = undefined;
                entry.pendingSeekBoundaryDuration = undefined;
              }
            }
          }

          // The 0ms seek flush must not advance model time; and when a seek
          // boundary snapshot was just re-applied above, the step must come
          // after it so the handoff pose survives into the rendered frame.
          if (shouldStepModels) {
            getLive2DRuntimeAdapter(entry.runtime).getControls().advanceFrame(entry.model, deltaInMs);
          }

          const invalidAfterUpdate = this.describeInvalidModelState(entry);
          if (invalidAfterUpdate) {
            await this.repairCorruptedModel(entry, invalidAfterUpdate, forceStep);
          }
        } catch (err) {
          // Suppress
        }
      }

      if (entry.isCorrupted) {
        continue;
      }

      // Evaluate the active custom motion for the current frame and write its
      // values into the injected parameter map. The custom motion owns the
      // listed parameters until a later motion takes over — except parameters
      // owned by the active lip-sync effect channel, which keeps running in
      // its own stage (ADR-0029) and therefore wins deterministically.
      //
      // Motion-stage mode (entry.customMotionStage) already wrote this pass's
      // curve values inside the SDK update pass via afterMotionUpdate, so the
      // legacy post-update injection here would wrongly overwrite an active
      // Expression compositing above them.
      if (!entry.customMotionStage && entry.customMotion && entry.customMotionHandoff) {
        const sceneTime = this.resolveCustomMotionSceneTime(entry, manualTimeMs);
        const state = entry.customMotion;
        const evaluation = evaluateCustomMotionRuntime(
          state.motion,
          state.startSceneTime,
          sceneTime,
          entry.customMotionHandoff,
        );
        applyCustomMotionValues(entry.injectedParams, state.controlledParameterIds, evaluation.values, entry.lipSyncParameterIds);
      }

      // Re-apply lip sync and other injected params
      if (entry.injectedParams) {
        const controls = getLive2DRuntimeAdapter(entry.runtime).getControls();
        for (const key in entry.injectedParams) {
          const val = entry.injectedParams[key];
          controls.setInjectedParameter(entry.model, key, val as number);
        }
        controls.syncInputParameters(entry.model);
      }

      // Lip-sync ownership handoff: the released channel's closing values have
      // now been applied once by the re-injection above. Drop the ids so the
      // stale values stop being re-written every frame — otherwise a Motion-
      // stage writer (custom motion mouth track) or a resource motion can
      // never drive those parameters again (ADR-0029 stage handoff).
      if (entry.pendingLipSyncRelease && entry.pendingLipSyncRelease.size > 0) {
        for (const parameterId of entry.pendingLipSyncRelease) {
          delete entry.injectedParams[parameterId];
        }
        entry.pendingLipSyncRelease.clear();
      }
    }

    // 刷洗滤镜脏标记：通过数组重赋值触发 PixiJS 感知滤镜变化。
    // 必须在 updateAll（更新阶段）而非 applyRenderHook（渲染通路）中执行，
    // 避免 WebGL 状态重校验阻塞渲染导致相机动画卡顿。
    for (const container of this.containers.values()) {
      if ((container as any)._filtersDirty) {
        (container as any)._filtersDirty = false;
        container.filters = container.filters ? (container.filters as any[]).slice() : null;
      }
    }
  }

  /**
   * Reset a character to idle state without removing it from stage.
   * Stops all motions/expressions and resets all parameters to SDK defaults.
   */
  resetToIdle(id: string): void {
    this.ensureMotionController();
    this.motionController!.resetToIdle(id);
  }

  /**
   * Stop all active transformation tweens on all characters.
   */
  pauseAllTweens(): void {
    this.ensureMotionController();
    this.motionController!.pauseAllTweens();
  }

  /**
   * Resume all transformation tweens.
   */
  resumeAllTweens(): void {
    this.ensureMotionController();
    this.motionController!.resumeAllTweens();
  }

  /**
   * Public API to hard-reset a character to idle state.
   * Exposed for use by ScriptEngine during timeline reconstruction.
   */
  resetModel(id: string): void {
    this.ensureMotionController();
    this.motionController!.resetModel(id);
  }

  /**
   * Internal helper for a complete model reset.
   */
  private ensureMotionController(): void {
    if (!this.motionController) {
      this.motionController = new Live2DMotionController(
        this.characters,
        this.containers,
        this.pendingMotions,
        this.pendingConfigs,
        this._motionMutex,
        this._hardResetMutex,
        this._activeMotionLoads,
        this._jumpingCharacters,
        () => this._scriptEngine,
      );
    }
  }

  /**
   * Remove all characters but keep containers for tween stability.
   */
  clear(): void {
    for (const id of Array.from(this.characters.keys())) {
      this.removeCharacter(id);
    }
    this.characters.clear();
    this.containers.clear();
    this.pendingMotions.clear();
    this.pendingConfigs.clear();
    this.pendingExpressions.clear();
    this.pendingCustomMotions.clear();
    this.pendingLookAts.clear();
    this.pendingBlinks.clear();
    this.pendingRimLightCommands.clear();
    this.pendingRimLightStates.clear();
    this._loadingPromises.clear();
    this._activeLoadTokens.clear();
    this._abortedLoads.clear();
    this._motionMutex.clear();
    this._hardResetMutex.clear();
    this._characterGenerations.clear();
    this.modelLoader.preloadingModels.clear();

    // Completely destroy recycled models to free WebGL memory on scene change
    // (controls.disposeModel also releases adapter-owned isolated mask buffers).
    const poolControls = cubism2Live2DAdapter.getControls();
    for (const pool of this.modelLoader.preloadedModels.values()) {
      for (const model of pool) {
        try {
          poolControls.disposeModel(model, { mode: 'destroy', keepTextures: true });
        } catch (e) {
          console.warn('[Live2D] Failed to destroy recycled model during clear:', e);
        }
      }
    }
    this.modelLoader.preloadedModels.clear();

    this._activeMotionLoads.clear();
    this._jumpingCharacters.clear();
  }
}

export const live2DManager = new Live2DManager();
export default Live2DManager;
