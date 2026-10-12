/**
 * Coordinates stage characters across Cubism 2 and Cubism 3+ runtimes.
 *
 * Model resources and frame commits live in their own modules. Custom-motion
 * takeover, geometry/opacity and rim lights each hide their implementation
 * behind an internal interface; this manager owns entrance/removal ordering
 * and keeps the existing caller interface.
 * Runtime imports stay lazy inside the adapters.
 */

import { getLive2DRuntimeCapabilities } from './live2d/runtime/Live2DRuntimeControlModule';
import * as PIXI from 'pixi.js';
import gsap from 'gsap';
import { stageManager } from './StageManager';
import { hookSystem } from '../api/hooks';
import { eventBus } from '../api/events';
import { getLogger } from './Logger';
import type { CharacterConfig, CharacterTransformConfig } from '../api/types/character';
import type { Vec2 } from '../api/types/common';
import type {
  Live2DParameterMetadata,
} from '../api/types/live2d-parameter-animation';
import { resolveVec2 } from './utils/math';
import type { CharacterEntry, ModelSnapshot } from './Live2DConfig';
import type { RimLightStyleState } from '../api/types/visual';
import { setScriptEngineForSetup } from './Live2DSetupState';
import { Live2DMotionController, MotionRequest } from './Live2DMotionController';
import { Live2DModelResources, Live2DModelLoadError } from './Live2DModelResources';
import { WmdlConfigRegistry } from './WmdlConfigRegistry';
import { cubism2Live2DAdapter, getLive2DRuntimeAdapter } from './Live2DRuntimeAdapter';
import type { Live2DSeekExpressionState } from './Live2DRuntimeAdapter';
import type { RuntimeTimelineScene } from './RuntimeTimelineScene';
import type { CharacterMotionOutput } from '../api/types/semantic-scene';
import type { CustomMotionHandoffPose } from './live2d/customMotionRuntime';
import type { Cubism2MotionSamplerTarget } from './live2d/cubism2MotionSampler';
import { motionCurveCache } from './live2d/motionCurveCache';
import { releaseCustomMotionOwnership } from './live2d/customMotionOwnership';
import { purgeCharacterRuntimeState } from './live2d/characterStatePurge';
import { Live2DStageRuntime, type PendingLookAt, type PendingBlink, type PendingCustomMotion } from './Live2DStageRuntime';
import { Live2DCustomMotionRuntime } from './live2d/Live2DCustomMotionRuntime';
import { Live2DCharacterGeometry } from './Live2DCharacterGeometry';
import { Live2DRimLightController } from './Live2DRimLightController';

export interface LookAtOptions {
  fromX?: number;
  fromY?: number;
  elapsed?: number;
  ease?: string;
}

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
  private readonly customMotionRuntime = new Live2DCustomMotionRuntime(() => this._scriptEngine?.getCurrentTime?.());
  private readonly characterGeometry: Live2DCharacterGeometry;
  private readonly rimLights: Live2DRimLightController;
  private readonly logger = getLogger('Live2DManager');

  constructor() {
    this.stageRuntime = new Live2DStageRuntime({
      dispatchMotion: (id, request) => {
        this.ensureMotionController();
        return this.motionController!.dispatchMotion(id, request);
      },
      describeInvalidModelState: (entry) => this.describeInvalidModelState(entry),
      repairCorruptedModel: (entry, reason, waitForRepair) => this.repairCorruptedModel(entry, reason, waitForRepair),
      maybeInstallCustomMotionStage: (entry) => this.customMotionRuntime.ensureStage(entry),
      resolveCustomMotionSceneTime: (entry, manualTimeMs) => this.customMotionRuntime.resolveSceneTime(entry, manualTimeMs),
      getScriptEngine: () => this._scriptEngine,
    });
    this.characterGeometry = new Live2DCharacterGeometry(
      this.characters,
      this.stageRuntime.pendingConfigs,
      (id) => this.getContainer(id),
      () => this._scriptEngine,
      () => this.currentCamera,
    );
    this.rimLights = new Live2DRimLightController(
      this.characters,
      (id) => this.getContainer(id),
      () => this._scriptEngine?.getCurrentTime?.(),
      this.stageRuntime.pendingRimLightCommands,
      this.stageRuntime.pendingRimLightStates,
    );
    this.modelResources = new Live2DModelResources(
      () => this.basePath,
    );
  }

  private get characters(): Map<string, CharacterEntry> { return this.stageRuntime.characters; }
  private set characters(value: Map<string, CharacterEntry>) { this.stageRuntime.replaceCharacters(value); }
  private get containers(): Map<string, PIXI.Container> { return this.stageRuntime.containers; }
  private set containers(value: Map<string, PIXI.Container>) { this.stageRuntime.replaceContainers(value); }
  private get pendingMotions(): Map<string, MotionRequest[]> { return this.stageRuntime.pendingMotions; }
  private get pendingConfigs(): Map<string, Partial<CharacterTransformConfig>[]> { return this.stageRuntime.pendingConfigs; }
  private get pendingExpressions(): Map<string, string | null> { return this.stageRuntime.pendingExpressions; }
  private get pendingCustomMotions(): Map<string, PendingCustomMotion> { return this.stageRuntime.pendingCustomMotions; }
  private get pendingLookAts(): Map<string, PendingLookAt> { return this.stageRuntime.pendingLookAts; }
  private get pendingBlinks(): Map<string, PendingBlink> { return this.stageRuntime.pendingBlinks; }
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
      await this.modelResources.loadCharacter(id, modelJsonPath, async ({ model, modelUrl, runtime, isCurrent, release }) => {
        const lifecycleGeneration = this.nextCharacterGeneration(id);
        const adapter = getLive2DRuntimeAdapter(runtime);
        const runtimeHandle = adapter.createModelHandle(id, model, runtime);
        const initialized = await runtimeHandle.initialize({ mode: 'live', isCurrent });
        if (initialized.status !== 'ready' || !isCurrent()) return;
        const idleSnapshot = initialized.idleSnapshot;

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
          releaseModel: release,
          runtime,
          adapterId: runtime.adapterId,
          runtimeHandle,
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

        if (idleSnapshot) entry.idleSnapshot = idleSnapshot;
        // Warmup precedes entry creation; binding retains the live source and
        // installs runtime protections before the first stage render.
        if (!runtimeHandle.bindRuntimeSource({
          mode: 'live', isExportMode: this._isExportMode, injectedParamsSource: entry,
          applyProxyTransform: (proxyId, proxy) => this.applyProxyTransform(proxyId, proxy), isCurrent,
        })) return;

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
    this.rimLights.removeCharacter(id);

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

      entry.releaseModel?.();

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

    this.rimLights.applyPending(id);
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
    return this.customMotionRuntime.getPreviewHandoff(this.characters.get(id), sceneTime);
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

    this.customMotionRuntime.start(entry, motion, sceneTime, handoffSnapshot, previewHandoff);
  }

  /** Shared ownership exit used by resource-motion takeover and resets. */
  releaseCustomMotion(entry: CharacterEntry): void {
    releaseCustomMotionOwnership(entry);
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
        && getLive2DRuntimeCapabilities(entry).evaluatesPoseOnZeroDelta
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
    if (!getLive2DRuntimeCapabilities(entry).usesCubism2PrivateControls) return [];

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
  transform(id: string, config: Partial<CharacterTransformConfig>): void {
    this.characterGeometry.transform(id, config);
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

  getPoint(id: string, pointName: 'head' | 'chest' | 'feet' | 'center', out?: { x: number; y: number }): { x: number; y: number } | null {
    return this.characterGeometry.getPoint(id, pointName, out);
  }

  getPosition(id: string): { x: number; y: number } | null {
    return this.getPoint(id, 'center');
  }

  getStableSampleBounds(id: string): PIXI.Rectangle | null {
    return this.characterGeometry.getStableSampleBounds(id, this.currentCamera);
  }

  getStableWorldSampleBounds(id: string): PIXI.Rectangle | null {
    return this.characterGeometry.getStableSampleBounds(id, null);
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
    this.rimLights.setRimLight(id, { color, intensity, thickness, angle, softness, duration }, sceneTime);
  }

  /** Fade the current character rim light out without applying default style values. */
  resetRimLight(id: string, duration: number = 0.4, baseline?: RimLightStyleState, sceneTime?: number): void {
    this.rimLights.resetRimLight(id, duration, baseline, sceneTime);
  }

  /** Reconcile rim lights at an absolute scene time for seek/scrubbing. */
  reconcileRimLights(time: number, scene: RuntimeTimelineScene): void {
    this.rimLights.reconcileRimLights(time, scene);
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
    proxy: Parameters<Live2DCharacterGeometry['applyProxyTransform']>[1],
    modelOverride?: Parameters<Live2DCharacterGeometry['applyProxyTransform']>[2],
    camera?: { position: Vec2; zoom: number },
  ): void {
    this.characterGeometry.applyProxyTransform(id, proxy, modelOverride, camera);
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
    if (!getLive2DRuntimeCapabilities(entry).supportsSnapshot) return null;
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
      focus?: readonly [number, number];
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
      const restoreInput = {
        id,
        snapshot: input.snapshot ?? null,
        handoffSnapshot: input.handoffSnapshot ?? null,
        targetSceneTime: input.targetSceneTime,
        focus: input.focus,
        motion: input.motion ?? null,
        expression: input.expression ?? null,
        idleSnapshot: entry.idleSnapshot ?? null,
        isScrubbing: input.isScrubbing,
        preserveMotionForPlayback: input.preserveMotionForPlayback,
      };
      result = entry.runtimeHandle
        ? await entry.runtimeHandle.snapshot.restoreSeekState(restoreInput)
        : await controls.restoreSeekState(entry.model, restoreInput);
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
