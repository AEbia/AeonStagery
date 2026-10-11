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
import { STAGE_WIDTH, STAGE_HEIGHT } from './Live2DConfig';
import type { CharacterEntry, ModelSnapshot } from './Live2DConfig';
import type { RimLightStyleState } from '../api/types/visual';
import { setScriptEngineForSetup } from './Live2DSetupState';
import { Live2DMotionController, MotionRequest } from './Live2DMotionController';
import { Live2DModelResources, Live2DModelLoadError } from './Live2DModelResources';
import { RimLightFilter } from './RimLightFilter';
import { projectToScreen } from './Projection';
import { WmdlConfigRegistry } from './WmdlConfigRegistry';
import { Live2DCompositeModel } from './Live2DCompositeModel';
import { cubism2Live2DAdapter, getLive2DRuntimeAdapter } from './Live2DRuntimeAdapter';
import type { Live2DSeekExpressionState } from './Live2DRuntimeAdapter';
import {
  resolveRimLightStateAtTime,
} from './RimLightResolver';
import type { ResolvedRimLightState } from './RimLightResolver';
import type { RuntimeTimelineScene } from './RuntimeTimelineScene';
import type { CharacterMotionOutput } from '../api/types/semantic-scene';
import {
  customMotionControlledParameterIds,
  selectHandoffPoseValues,
  type CustomMotionHandoffPose,
} from './live2d/customMotionRuntime';
import type { Cubism2MotionSamplerTarget } from './live2d/cubism2MotionSampler';
import { motionCurveCache } from './live2d/motionCurveCache';
import { releaseCustomMotionOwnership, reclaimControlledInjectedParams } from './live2d/customMotionOwnership';
import { purgeCharacterRuntimeState, resetModelToNeutralPose, restoreNeutralModelPose } from './live2d/characterStatePurge';
import { Live2DStageRuntime } from './Live2DStageRuntime';

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
  public setWmdlConfigRegistry(registry: WmdlConfigRegistry): void {
    this.modelResources.setWmdlConfigRegistry(registry);
  }

  private readonly stageRuntime: Live2DStageRuntime;
  private basePath: string = '';
  private _isExportMode: boolean = false; // Only used by ExportDialog (fast export path). Bake uses BakeEngine with independent models.
  private _initPromise: Promise<void> | null = null;
  private _scriptEngine: any = null;

  /**
   * Current camera state — set by ScriptEngine before each render pass.
   * Used as fallback by applyProxyTransform when no explicit camera is passed.
   * Avoids circular imports with CameraController.
   */
  public currentCamera: { position: Vec2; zoom: number } | null = null;
  private motionController: Live2DMotionController | null = null;
  private readonly modelResources: Live2DModelResources;
  private resourceMotionCacheEnabled = true;
  private readonly logger = getLogger('Live2DManager');

  constructor() {
    this.stageRuntime = new Live2DStageRuntime({
      dispatchMotion: (id, request) => {
        this.ensureMotionController();
        return this.motionController!.dispatchMotion(id, request);
      },
      describeInvalidModelState: (entry) => this.describeInvalidModelState(entry),
      repairCorruptedModel: (entry, reason, waitForRepair) => this.repairCorruptedModel(entry, reason, waitForRepair),
      maybeInstallCustomMotionStage: (entry) => this.maybeInstallCustomMotionStageOnEntry(entry),
      resolveCustomMotionSceneTime: (entry, manualTimeMs) => this.resolveCustomMotionSceneTime(entry, manualTimeMs),
      getScriptEngine: () => this._scriptEngine,
    });
    this.modelResources = new Live2DModelResources(
      () => this.basePath,
    );
  }

  private get characters(): Map<string, CharacterEntry> { return this.stageRuntime.characters; }
  private set characters(value: Map<string, CharacterEntry>) { this.stageRuntime.replaceCharacters(value); }
  private get containers(): Map<string, PIXI.Container> { return this.stageRuntime.containers; }
  private set containers(value: Map<string, PIXI.Container>) { this.stageRuntime.replaceContainers(value); }
  private get pendingMotions(): Map<string, MotionRequest[]> { return this.stageRuntime.pendingMotions; }
  private get pendingConfigs(): Map<string, unknown[]> { return this.stageRuntime.pendingConfigs; }
  private get pendingExpressions(): Map<string, string | null> { return this.stageRuntime.pendingExpressions; }
  private get pendingCustomMotions(): Map<string, PendingCustomMotion> { return this.stageRuntime.pendingCustomMotions; }
  private get pendingLookAts(): Map<string, PendingLookAt> { return this.stageRuntime.pendingLookAts; }
  private get pendingBlinks(): Map<string, PendingBlink> { return this.stageRuntime.pendingBlinks; }
  private get pendingRimLightCommands(): Map<string, PendingRimLightCommand> { return this.stageRuntime.pendingRimLightCommands; }
  private get pendingRimLightStates(): Map<string, ResolvedRimLightState> { return this.stageRuntime.pendingRimLightStates; }
  private get _jumpingCharacters(): Set<string> { return this.stageRuntime.jumpingCharacters; }
  private get _motionMutex(): Map<string, Promise<void>> { return this.stageRuntime.motionMutex; }
  private get _hardResetMutex(): Map<string, Promise<void>> { return this.stageRuntime.hardResetMutex; }
  private get _activeMotionLoads(): Set<string> { return this.stageRuntime.activeMotionLoads; }
  private get _shouldUpdate(): boolean { return this.stageRuntime.isUpdating; }
  private get _tickerAdded(): boolean { return this.stageRuntime.hasTicker; }
  private set _tickerAdded(value: boolean) { if (value) this.stageRuntime.markTickerAdded(); }

  private nextCharacterGeneration(id: string): number {
    return this.stageRuntime.nextCharacterGeneration(id);
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
    await this.stageRuntime.waitForQuiescence(() => this.modelResources.waitForLoads());
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
    if (targetMap.has(id)) this.removeCharacter(id);
    const staging: { container?: PIXI.Container; entry?: CharacterEntry } = {};
    try {
      await this.modelResources.loadCharacter(id, modelJsonPath, async ({ model, modelUrl, runtime, isCurrent }) => {
        const lifecycleGeneration = this.nextCharacterGeneration(id);
        const adapter = getLive2DRuntimeAdapter(runtime);
        const isCubism2Runtime = runtime.adapterId === 'pixi-live2d-display-cubism2';
        // A pooled instance keeps the motion queue, expression and pose of its
        // previous owner. The idle snapshot captured below is the pose every
        // later hard reset and custom-motion baseline restores to, so it must
        // be taken from a neutralised model — otherwise the character's neutral
        // pose is the previous scene time's action.
        resetModelToNeutralPose(model, runtime);
        adapter.getControls().advanceFrame(model, 100);

        if (isCubism2Runtime) {
          // === 核心修复：安全地洗刷初始状态遗留的 0 opacity ===
          // SDK 时钟在 adapter 的锁内单调前进一小步，避免一次超长模型更新
          // 带来的巨大 dt 导致物理系统 NaN 爆炸（flush 在 adapter 内完成）。
          await adapter.getControls().flushIdleState(model);
        } else {
          try {
            adapter.getControls().stopAllMotions(model);
            adapter.getControls().advanceFrame(model, 16);
          } catch {
            // Ignore errors
          }
        }

        if (!isCurrent()) return;

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

        const idleSnapshot = adapter.getControls().captureIdleSnapshot(model);

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
        staging.container = container;
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
        if (!isCurrent()) {
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
        };
        staging.entry = entry;

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
        if (!isCurrent()) {
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
      }, () => stageManager.getApp().renderer);
    } catch (err) {
      if (staging.entry && targetMap.get(id) === staging.entry) this.removeCharacter(id);
      else if (staging.container && this.containers.get(id) === staging.container) {
        gsap.killTweensOf(staging.container);
        staging.container.parent?.removeChild(staging.container);
        staging.container.destroy({ children: true });
        this.containers.delete(id);
      }
      console.error(`[Live2D] Failed to load model "${modelJsonPath}":`, err);
      if (err instanceof Live2DModelLoadError) {
        showRuntimeErrorToast(`Live2D 模型加载失败：角色 "${id}"。\n${err.message}\n${err.fullPath}`);
        return;
      }
      throw err;
    }
  }

  /**
   * Remove a character from the stage.
   */
  removeCharacter(id: string): void {
    this.modelResources.cancelLoad(id);
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

      this.modelResources.releaseModel(entry.model);

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

  /** Preview replacements reuse the block's start pose, never saved fade frames. */
  getCustomMotionPreviewHandoff(id: string, sceneTime: number): CustomMotionHandoffPose | undefined {
    const entry = this.characters.get(id);
    if (entry?.customMotion?.startSceneTime !== sceneTime || !entry.customMotionHandoff) return;
    return { values: Object.fromEntries(Object.entries(entry.customMotionHandoff.values)
      .filter(([parameterId]) => !entry.lipSyncParameterIds?.has(parameterId))) };
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
    previewHandoff?: CustomMotionHandoffPose,
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
    entry.customMotionHandoff = previewHandoff ?? this.captureCustomMotionHandoff(entry, handoffSnapshot);
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
      const controls = getLive2DRuntimeAdapter(entry.runtime).getControls();
      if (!this._shouldUpdate
        && entry.runtime?.adapterId === 'untitled-pixi-live2d-engine-cubism'
        && controls.setExpressionForSeek) {
        // An explicit inspector preview should show the final expression while
        // the timeline is paused. Re-evaluate at the same motion timestamp so
        // displaying it does not advance the scene or accumulate motion fades.
        const model = entry.model;
        void controls.setExpressionForSeek(model, expressionName, Number.POSITIVE_INFINITY)
          .then(() => {
            if (this.characters.get(id) === entry && entry.model === model && entry.expressionKey === expressionName) {
              controls.advanceFrame(model, 0);
            }
          })
          .catch((err) => console.error(`[Live2D] Failed to preview expression on "${id}":`, err));
      } else if (entry.runtimeHandle) {
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
    const requestedUrl = this.modelResources.pathToUrl(modelUrl);
    return entry.modelPath === modelUrl || entry.modelUrl === modelUrl || entry.modelUrl === requestedUrl;
  }

  /**
   * Preload a model into browser/SDK cache without adding to stage.
   * Delegates to Live2DModelResources after guard checks.
   */
  async preloadModel(id: string, modelUrl: string): Promise<void> {
    if (this.matchesLoadedModel(id, modelUrl)) return;
    await this.modelResources.preloadModel(modelUrl);
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
    return this.modelResources.getModelDataFromPath(modelPath);
  }

  resolveMotionKeyForModel(modelPath: string, motionKey: string): Promise<string> {
    return this.modelResources.resolveMotionKey(modelPath, motionKey);
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
      expression?: Live2DSeekExpressionState | null;
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
    this.stageRuntime.setAutoUpdate(enabled);
  }

  /**
   * Manually update all characters by a fixed delta time.
   * @param dt Delta time in milliseconds. PixiJS ticker callers must pass deltaMS.
   * @param forceStep If true, bypass the pause-throttle and perform a full update.
   */
  async updateAll(dt: number, forceStep: boolean = false, manualTimeMs?: number): Promise<void> {
    await this.stageRuntime.step(dt, forceStep, manualTimeMs);
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
    this.modelResources.clear();
    this.stageRuntime.clear();
  }
}

export const live2DManager = new Live2DManager();
export default Live2DManager;
