/**
 * Coordinates stage characters across Cubism 2 and Cubism 3+ runtimes.
 *
 * Model resources and frame commits live in their own modules. Custom-motion
 * takeover, geometry/opacity and rim lights each hide their implementation
 * behind an internal interface. Stage Runtime owns publication, withdrawal and
 * pending-intent consumption; this manager keeps the existing caller interface.
 * Runtime imports stay lazy inside the adapters.
 */

import { getLive2DRuntimeCapabilities } from './live2d/runtime/Live2DRuntimeControlModule';
import { getBoundRuntimeHandle } from './live2d/runtime/BoundRuntimeAccess';
import * as PIXI from 'pixi.js';
import { hookSystem } from '../api/hooks';
import { eventBus } from '../api/events';
import { getLogger } from './Logger';
import type { CharacterConfig, CharacterInfo, CharacterTransformConfig } from '../api/types/character';
import type { Vec2 } from '../api/types/common';
import type {
  Live2DParameterMetadata,
  Live2DParameterEdit,
  Live2DParameterEditResult,
  Live2DParameterInspection,
} from '../api/types/live2d-parameter-animation';
import type { CharacterEntry, ModelSnapshot } from './Live2DConfig';
import type { RimLightStyleState } from '../api/types/visual';
import { setScriptEngineForSetup } from './Live2DSetupState';
import type { Live2DMotionController } from './Live2DMotionController';
import { Live2DModelResources, Live2DModelLoadError } from './Live2DModelResources';
import { WmdlConfigRegistry } from './WmdlConfigRegistry';
import { cubism2Live2DAdapter, getLive2DRuntimeAdapter } from './Live2DRuntimeAdapter';
import type { Live2DSeekExpressionState } from './Live2DRuntimeAdapter';
import type { RuntimeTimelineScene } from './RuntimeTimelineScene';
import type { CharacterMotionOutput } from '../api/types/semantic-scene';
import type { CustomMotionHandoffPose } from './live2d/customMotionRuntime';
import { motionCurveCache } from './live2d/motionCurveCache';
import { releaseCustomMotionOwnership } from './live2d/customMotionOwnership';
import { purgeCharacterRuntimeState } from './live2d/characterStatePurge';
import { Live2DStageRuntime, type Live2DStageIntent } from './Live2DStageRuntime';
import { Live2DCustomMotionRuntime } from './live2d/Live2DCustomMotionRuntime';
import type { Live2DCharacterGeometry } from './Live2DCharacterGeometry';
import type { Live2DRimLightController } from './Live2DRimLightController';

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- The legacy scene bridge accesses private transform registries as well as the scene clock; retain this narrow duck-typed boundary without exposing private engine state.
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
    this.modelResources = new Live2DModelResources(() => this.basePath);
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
      getCamera: () => this.syncCurrentCameraFromScriptEngine(),
      isExportMode: () => this._isExportMode,
      applyIntent: (id, intent) => this.applyStageIntent(id, intent),
    }, this.modelResources);
    this.characterGeometry = this.stageRuntime.geometry;
    this.rimLights = this.stageRuntime.rimLights;
  }

  private get _shouldUpdate(): boolean { return this.stageRuntime.isUpdating; }

  private applyStageIntent(id: string, intent: Live2DStageIntent): void {
    switch (intent.kind) {
      case 'motion': {
        const m = intent.request;
        this.playMotion(id, m.key, m.priority, m.offset, m.sceneTime, m.skipHardReset, m.handoffSnapshot);
        break;
      }
      case 'customMotion': {
        const m = intent.request;
        this.playCustomMotion(id, m.motion, m.sceneTime, m.handoffSnapshot);
        break;
      }
      case 'expression': this.setExpression(id, intent.expression); break;
      case 'lookAt': {
        const l = intent.request;
        this.lookAt(id, l.focusX, l.focusY, l.duration, l.options);
        break;
      }
      case 'blink': {
        const b = intent.request;
        this.setBlink(id, b.enabled, b.intervalMs, b.sceneTimeSeconds, b.startTimeSeconds, b.intervalRangeMs);
        break;
      }
    }
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- The legacy scene bridge accesses private transform registries as well as the scene clock; retain this narrow duck-typed boundary without exposing private engine state.
  setScriptEngine(engine: any): void {
    this._scriptEngine = engine;
    setScriptEngineForSetup(engine);
  }

  private syncCurrentCameraFromScriptEngine(): { position: Vec2; zoom: number } | null {
    const camera = this._scriptEngine?.getCurrentCamera?.();
    if (camera?.position && Number.isFinite(camera.zoom)) this.currentCamera = camera;
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
    try {
      await this.stageRuntime.addCharacter(id, modelJsonPath, config);
    } catch (err) {
      console.error(`[Live2D] Failed to load model "${modelJsonPath}":`, err);
      if (err instanceof Live2DModelLoadError) {
        showRuntimeErrorToast(`Live2D 模型加载失败：角色 "${id}"。\n${err.message}\n${err.fullPath}`);
        return;
      }
      throw err;
    }
  }

  removeCharacter(id: string): void {
    this.stageRuntime.removeCharacter(id);
  }

  getContainer(id: string): PIXI.Container {
    return this.stageRuntime.getContainer(id);
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
    this.stageRuntime.discardIntent(id, 'customMotion');

    const entry = this.stageRuntime.getCharacter(id);
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
    return this.customMotionRuntime.getPreviewHandoff(this.stageRuntime.getCharacter(id), sceneTime);
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
    const entry = this.stageRuntime.getCharacter(id);
    if (!entry) {
      // No character on stage yet: a statement can pair the custom motion with
      // the entrance that creates the character (角色登场 + 角色动作 at the same
      // time), and the entrance registers its entry only after the asynchronous
      // model load. Buffer the intent — the same way resource motions wait in
      // `pendingMotions` — and replay it on load, keeping the authored start
      // time so the curve resumes at the frame the playhead is actually on.
      this.stageRuntime.bufferIntent(id, { kind: 'customMotion', request: { motion, sceneTime, handoffSnapshot } });
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
    this.stageRuntime.clearPendingCustomMotions();
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
    for (const entry of this.stageRuntime.getCharacterEntries()) {
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
    const entry = this.stageRuntime.getCharacter(id);
    if (!entry?.model) {
      this.stageRuntime.bufferIntent(id, { kind: 'expression', expression: expressionName });
      return;
    }

    entry.expressionKey = expressionName;
    this.stageRuntime.discardIntent(id, 'expression');



    try {
      const runtime = getBoundRuntimeHandle(entry);
      if (!runtime) return;
      if (!this._shouldUpdate
        && getLive2DRuntimeCapabilities(entry).evaluatesPoseOnZeroDelta
      ) {
        // An explicit inspector preview should show the final expression while
        // the timeline is paused. Re-evaluate at the same motion timestamp so
        // displaying it does not advance the scene or accumulate motion fades.
        const generation = entry.lifecycleGeneration ?? 0;
        void runtime.performance.restoreExpression(
          expressionName,
          Number.POSITIVE_INFINITY,
          undefined,
          () => this.stageRuntime.getCharacter(id) === entry
            && (entry.lifecycleGeneration ?? 0) === generation
            && entry.expressionKey === expressionName,
        )
          .catch((err) => console.error(`[Live2D] Failed to preview expression on "${id}":`, err));
      } else {
        runtime.expression.setExpression(expressionName);
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
    isCurrentOperation: () => boolean = () => true,
  ): Promise<void> {
    const entry = this.stageRuntime.getCharacter(id);
    if (!entry?.model) return;

    entry.expressionKey = expressionName;
    this.stageRuntime.discardIntent(id, 'expression');

    try {
      const runtime = getBoundRuntimeHandle(entry);
      if (!runtime) return;
      const generation = entry.lifecycleGeneration ?? 0;
      await runtime.expression.restoreAtSceneTime(
        expressionName,
        elapsedSeconds,
        previousExpressionKey,
        () => this.stageRuntime.getCharacter(id) === entry
          && (entry.lifecycleGeneration ?? 0) === generation
          && isCurrentOperation(),
      );
      if (this.stageRuntime.getCharacter(id) !== entry || (entry.lifecycleGeneration ?? 0) !== generation || !isCurrentOperation()) return;
      hookSystem.execute('character:expression', { id, expressionName: expressionName || '' });
    } catch (err) {
      console.error(`[Live2D] Failed to restore expression "${expressionName}" on "${id}" during seek:`, err);
    }
  }

  prepareExpressionForSeek(id: string, expressionName: string | null): void {
    const entry = this.stageRuntime.getCharacter(id);
    if (entry) entry.expressionKey = expressionName;
  }

  /**
   * True when the loaded character entry for `id` already serves `modelUrl`
   * (resolved path or URL form). Shared by preloadModel's early return, the
   * seek auto-upgrade check, and the pre-warm skip so a same-scene reload
   * never re-populates models that soft cleanup already retained.
   */
  matchesLoadedModel(id: string, modelUrl: string): boolean {
    const entry = this.stageRuntime.getCharacter(id);
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
   * Display capabilities for animation; SDK operations stay on the handle.
   */
  getDisplayObject(id: string): PIXI.Container | null {
    const entry = this.stageRuntime.getCharacter(id);
    return entry?.runtimeHandle?.displayObject ?? entry?.model ?? null;
  }

  async sampleMotion(
    characterId: string,
    motionKey: string,
    options: import('./runtime/Live2DRuntimeContracts').Live2DMotionSamplingOptions,
  ): Promise<import('./runtime/Live2DRuntimeContracts').Live2DMotionSamplingResult> {
    const entry = this.stageRuntime.getCharacter(characterId);
    if (!entry?.model) {
      return { status: 'unsupported', diagnostics: [`Character "${characterId}" is not loaded.`] };
    }
    const handle = getBoundRuntimeHandle(entry);
    if (!handle) return { status: 'unsupported', diagnostics: [`Character "${characterId}" is not loaded.`] };
    return handle.motion.sampleMotion(motionKey, options);
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
    const entry = this.stageRuntime.getCharacter(id);
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
    const entry = this.stageRuntime.getCharacter(id);
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
    const entry = this.stageRuntime.getCharacter(id);
    if (!entry) return;
    const owned = entry.lipSyncParameterIds;
    if (owned && owned.size > 0) {
      (entry.pendingLipSyncRelease ??= new Set());
      for (const parameterId of owned) entry.pendingLipSyncRelease.add(parameterId);
    }
    entry.lipSyncParameterIds?.clear();
  }

  getParameterMetadata(id: string): readonly Live2DParameterMetadata[] {
    const entry = this.stageRuntime.getCharacter(id);
    if (!entry) return [];
    const handle = entry.runtimeHandle ?? getLive2DRuntimeAdapter(entry.runtime).createModelHandle(id, entry.model, entry.runtime);
    const metadata = handle.parameters.getParameterMetadata();
    if (metadata) return metadata.map(parameter => ({ ...parameter }));
    return (handle.inspectParameters() ?? []).map(parameter => ({
      id: parameter.id,
      index: parameter.index,
      defaultValue: Number.isFinite(parameter.value) ? parameter.value : undefined,
      source: 'runtime',
    }));
  }

  inspectParameters(id: string): readonly Live2DParameterInspection[] | null {
    const entry = this.stageRuntime.getCharacter(id);
    if (!entry) return null;
    const handle = entry.runtimeHandle ?? getLive2DRuntimeAdapter(entry.runtime).createModelHandle(id, entry.model, entry.runtime);
    return handle.inspectParameters();
  }

  editParameters(id: string, edits: readonly Live2DParameterEdit[]): Live2DParameterEditResult {
    const entry = this.stageRuntime.getCharacter(id);
    if (!entry) return { appliedParameterIds: [] };
    const handle = entry.runtimeHandle ?? getLive2DRuntimeAdapter(entry.runtime).createModelHandle(id, entry.model, entry.runtime);
    return handle.editParameters(edits);
  }

  /**
   * Get the PIXI objects for GSAP to animate directly.
   */
  getTransformTargets(id: string): { container: PIXI.Container; model: PIXI.Container } | null {
    const display = this.getDisplayObject(id);
    if (!display) return null;
    return {
      container: this.getContainer(id),
      model: display,
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
    const entry = this.stageRuntime.getCharacter(id);
    if (!entry?.model) {
      this.stageRuntime.bufferIntent(id, { kind: 'lookAt', request: { focusX, focusY, duration, options } });
      return;
    }

    this.stageRuntime.discardIntent(id, 'lookAt');



    // The focus-controller interpolation (GSAP ownership, frame writes, SDK
    // focus fallback) is entirely owned by the runtime adapter.
    getBoundRuntimeHandle(entry)?.focus.apply({
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
  syncLookAtFollows(characterStates: ReadonlyMap<string, { lookAt?: { target?: string; focus?: readonly [number, number] } | null }>): void {
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
    const entry = this.stageRuntime.getCharacter(id);
    if (!entry?.model) {
      this.stageRuntime.bufferIntent(id, { kind: 'blink', request: { enabled, intervalMs, sceneTimeSeconds, startTimeSeconds, intervalRangeMs } });
      return;
    }

    this.stageRuntime.discardIntent(id, 'blink');



    // Eye-blink channel manipulation (updater wrap, multiplier, interval) is
    // owned by the runtime adapter.
    getBoundRuntimeHandle(entry)?.blink.set(
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

  getScreenPoint(id: string, pointName: 'head' | 'chest' | 'feet' | 'center', out?: { x: number; y: number }): { x: number; y: number } | null {
    return this.characterGeometry.getScreenPoint(id, pointName, out);
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
   * Add a directional highlight along the character's inner contour.
   */
  setRimLight(id: string, color: string | number = 0xFFFFFF, intensity: number = 1.0, thickness: number = 6, angle: number = 45, softness: number = 2, duration: number = 1.0, sceneTime?: number): void {
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
   * Directly set a character's model scale. Used for per-frame updates
   * during Hitchcock zoom where scale must change every animation frame.
   */
  setCharacterScale(id: string, scale: number): void {
    const entry = this.stageRuntime.getCharacter(id);
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
    const entry = this.stageRuntime.getCharacter(id);
    return !entry?.filterWarmupFrames || entry.filterWarmupFrames <= 0;
  }

  hasActiveFilterWarmup(): boolean {
    for (const entry of this.stageRuntime.getCharacterEntries()) {
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
    const entry = this.stageRuntime.getCharacter(id);
    if (!entry) return [];

    try {
      return getBoundRuntimeHandle(entry)?.motion.getAvailableMotions() ?? [];
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
    const entry = this.stageRuntime.getCharacter(id);
    if (!entry) return [];

    try {
      return getBoundRuntimeHandle(entry)?.expression.getAvailableExpressions() ?? [];
    } catch (e) {
      console.warn(`[Live2D] Failed to get expressions for "${id}":`, e);
    }
    return [];
  }

  /**
   * List all active character IDs.
   */

  /**
   * Detached character information for listing and reload.
   */
  getCharacterInfo(id: string): CharacterInfo | null {
    const entry = this.stageRuntime.getCharacter(id);
    if (!entry) return null;
    return {
      id: entry.id,
      modelPath: entry.modelPath,
      adapterId: entry.runtime?.adapterId ?? entry.adapterId,
      config: structuredClone(entry.config),
      determinism: structuredClone(getLive2DRuntimeCapabilities(entry).determinism),
    };
  }

  listCharacterInfo(): readonly CharacterInfo[] {
    return [...this.stageRuntime.getCharacterIds()].flatMap(id => {
      const info = this.getCharacterInfo(id);
      return info ? [info] : [];
    });
  }

  /**
   * Capture snapshot via pure function (shared with BakeEngine).
   */
  captureSnapshot(id: string): ModelSnapshot | null {
    const entry = this.stageRuntime.getCharacter(id);
    if (!entry || !entry.model) return null;
    if (!getLive2DRuntimeCapabilities(entry).supportsSnapshot) return null;
    return getBoundRuntimeHandle(entry)?.snapshot.captureSnapshot(entry.motionStartTime) ?? null;
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
      isCurrent?: () => boolean;
    },
  ): Promise<void> {
    const entry = this.stageRuntime.getCharacter(id);
    if (!entry?.model) return;
    const lifecycleGeneration = entry.lifecycleGeneration ?? 0;
    const runtime = getBoundRuntimeHandle(entry);
    if (!runtime) return;
    const isCurrent = () => this.stageRuntime.getCharacter(id) === entry
      && (entry.lifecycleGeneration ?? 0) === lifecycleGeneration
      && (input.isCurrent?.() ?? true);
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
        isCurrent,
      };
      result = await runtime.performance.restoreSeekState(restoreInput);
    } catch (err) {
      if (!isCurrent()) {
        return;
      }
      console.warn(`[Live2D] Seek restore failed for "${id}"; preserving timeline execution.`, err);
      result = {
        status: 'fallback' as const,
        tierUsed: 'unsupported' as const,
        diagnostics: [err instanceof Error ? err.message : String(err)],
      };
    }
    if (!isCurrent() || result.status === 'cancelled') return;
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
    return this.stageRuntime.motionController.isMotionLoading();
  }

  /**
   * Log all available parameters and their current values for a character.
   */
  /**
   * Log internal SDK motion state for debugging.
   */
  debugMotionState(id: string): void {
    const entry = this.stageRuntime.getCharacter(id);
    if (!entry) return;
    console.log(
      `[Live2D Debug] Motion State for "${id}":`,
      getBoundRuntimeHandle(entry)?.motion.getMotionDebugState() ?? null,
    );
  }

  logModelParameters(id: string): void {
    const entry = this.stageRuntime.getCharacter(id);
    if (!entry) return;
    const values = getBoundRuntimeHandle(entry)?.parameters.getParameterValues();
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- The legacy scene bridge accesses private transform registries as well as the scene clock; retain this narrow duck-typed boundary without exposing private engine state.
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
    return Array.from(this.stageRuntime.getCharacterIds());
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
    return !!this.stageRuntime.getCharacter(id);
  }

  private describeInvalidModelState(entry: CharacterEntry): string | null {
    return getBoundRuntimeHandle(entry)?.diagnostics.describeInvalidState() ?? null;
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
          if (this.stageRuntime.getCharacter(entry.id) !== entry) return;

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
          if (this.stageRuntime.getCharacter(entry.id) === entry) {
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
  async updateAll(
    dt: number,
    forceStep: boolean = false,
    manualTimeMs?: number,
  ): Promise<void> {
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
    this.motionController ??= this.stageRuntime.motionController;
  }

  /**
   * Withdraw all characters and clear stage intents and resources.
   */
  clear(): void {
    this.stageRuntime.clear();
  }
}

export const live2DManager = new Live2DManager();
export default Live2DManager;
