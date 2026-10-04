/**
 * AeonStagery — Bake Engine
 *
 * Runs timeline simulation on completely independent Live2D model instances.
 * Models live on a hidden PIXI Container (alpha=0) so the normal PIXI render
 * pipeline handles WebGL initialization and the runtime model update via _render().
 *
 * Produces snapshotHistory without touching shared engine singletons.
 */

import * as PIXI from 'pixi.js';
import { ModelSnapshot, acquireUtSystemLock, releaseUtSystemLock } from './Live2DConfig';
import { computeSceneStateAtTime } from './RuntimeSceneState';
import type { RuntimeTimelineScene } from './RuntimeTimelineScene';
import type { PreparedAssetRef, PreparedCompiledScene, PreparedRuntimeValue } from '../api/types/semantic-scene';
import { resolveVec2 } from './utils/math';
import { eventBus } from '../api/events';
import { settingsManager } from '../ui/SettingsStore';
import type { Snapshot } from './SnapshotStore';
import { WmdlConfigRegistry } from './WmdlConfigRegistry';
import { Live2DCompositeModel } from './Live2DCompositeModel';
import type { Live2DRuntimeDescriptor } from './Live2DRuntimeResolver';
import { getUnsupportedLive2DRuntimeMessage, resolveLive2DRuntimeDescriptor } from './Live2DRuntimeResolver';
import {
  cubism2Live2DAdapter,
  getLive2DRuntimeAdapter,
  type Live2DRuntimeClock,
} from './Live2DRuntimeAdapter';
import { isPreparedAssetRef, preparedSceneToRuntimeTimelineScene } from './PreparedRuntimeScene';
import { BakeMotionRuntime, type BakeMotionPlanRequest, type BakeMotionRuntimeHost } from './BakeMotionRuntime';

/**
 * Mouth parameters written by the deterministic dialogue text-mouth channel.
 * While a dialogue drives a character in bake, these behave like the preview
 * lip-sync effect channel: the active custom motion must not overwrite or
 * release them (ADR-0029 — same evaluation semantics for Preview, Seek, Bake
 * and Export).
 */
const BAKE_DIALOGUE_MOUTH_PARAMS = new Set(['PARAM_MOUTH_OPEN_Y', 'ParamMouthOpenY']);

// ─── Types ────────────────────────────────────────────────────────────────

interface BakeModel {
  id: string;
  model: any;
  modelPath: string;
  modelKey: string;
  runtime: Live2DRuntimeDescriptor;
  adapterId: string;
  motionStartTime?: number;
  lastOffset?: number;
  expressionKey?: string | null;
  injectedParams: Record<string, number>;
  idleSnapshot: { params: Float32Array; opacities: Float32Array };
}

export interface BakeResult {
  snapshotHistory: { time: number; models: Map<string, ModelSnapshot> }[];
  /** Optional Bake motion-runtime observability (cacheHit/cacheMiss/nativeStart/offsetReplayMs). */
  motionReport?: import('./BakeMotionRuntime').BakeMotionRuntimeReport;
}

// ─── BakeEngine ───────────────────────────────────────────────────────────

export class BakeEngine {
  private models: Map<string, BakeModel> = new Map();
  private token = 0;
  /** Per-id lifecycle generation: bumped on every `removeModel` so a stale
   *  async `loadModel` continuation can never resurrect a replaced/removed
   *  model entry (costume swaps and scene reloads race the long `createModel`
   *  chains). A load captures the generation at start and only publishes its
   *  entry when it is still current. */
  private readonly modelGeneration = new Map<string, number>();
  private snapshotHistory: { time: number; models: Map<string, ModelSnapshot> }[] = [];
  private live2dReady = false;
  private initPromise: Promise<void> | null = null;
  private initPromises: Map<string, Promise<void>> = new Map();
  private activeMotionLoads: Set<string> = new Set();


  private container: PIXI.Container;
  private app: PIXI.Application;
  private wmdlConfigRegistry: WmdlConfigRegistry | null = null;

  constructor(app: PIXI.Application, wmdlConfigRegistry?: WmdlConfigRegistry) {
    this.app = app;
    this.container = new PIXI.Container();
    if (wmdlConfigRegistry) {
      this.wmdlConfigRegistry = wmdlConfigRegistry;
    }
    // 关键修复：不要挂载到主舞台 (app.stage)，否则会被主渲染循环 (Ticker) 劫持
    // 导致主线程在后台线程的 update() 调用之前疯狂调用 render()，从而引发 Cubism 底层报错！
    this.container.alpha = 0;
    this.container.visible = false;
  }

  /**
   * Cancel current bake task by invalidating the token.
   */
  cancel(): void {
    this.token = -1; // Any number that won't match the current task
    console.log('[BakeEngine] Cancellation requested.');
  }

  // ── Public API ────────────────────────────────────────────────────────


  async bakePrepared(
    scene: PreparedCompiledScene,
    resolvedModelPaths: Map<string, string>,
    token: number,
  ): Promise<BakeResult> {
    const step = settingsManager.get('bakePrecision');
    return this.bakeRuntimeRange(
      preparedSceneToRuntimeTimelineScene(scene),
      buildPreparedBakeModelPathMap(scene, resolvedModelPaths),
      token,
      0,
      scene.durationSeconds,
      step,
      undefined,
      false,
    );
  }

  async bakePreparedRange(
    scene: PreparedCompiledScene,
    resolvedModelPaths: Map<string, string>,
    token: number,
    rangeStart: number,
    rangeEnd: number,
    precision: number,
    seedSnapshot?: Snapshot,
    silent = false,
  ): Promise<BakeResult> {
    return this.bakeRuntimeRange(
      preparedSceneToRuntimeTimelineScene(scene),
      buildPreparedBakeModelPathMap(scene, resolvedModelPaths),
      token,
      rangeStart,
      Math.min(rangeEnd, scene.durationSeconds),
      precision,
      seedSnapshot,
      silent,
    );
  }

  /**
   * Range-based incremental bake. Only simulates [rangeStart, rangeEnd] at the given precision.
   * If a seedSnapshot is provided, model state is restored from it at rangeStart instead of
   * simulating from 0s, enabling massive speedup for long timelines.
   */
  private async bakeRuntimeRange(
    script: RuntimeTimelineScene,
    resolvedModelPaths: Map<string, string>,
    token: number,
    rangeStart: number,
    rangeEnd: number,
    precision: number,
    seedSnapshot?: Snapshot,
    silent: boolean = false,
  ): Promise<BakeResult> {
    this.token = token;

    this.snapshotHistory = [];
    
    // Reset all loaded models to their idle state to prevent parameter carryover
    this.resetAllModelsToIdle();

    const startTime = performance.now();

    const { requiredMotions } = this.scanAssets(script);

    // Load all models in parallel
    const loadPromises: Promise<void>[] = [];

    // Correct way: map CharID -> ModelPath
    const charModelMap = new Map<string, string>();
    for (const action of script.timeline) {
      if (action.action === 'addCharacter' && action.params?.id && action.params?.model) {
        charModelMap.set(action.params.id, action.params.model);
      }
    }
    if (script.meta.characters) {
      for (const char of script.meta.characters) {
        if (!charModelMap.has(char.id) && char.model) {
          charModelMap.set(char.id, char.model);
        }
      }
    }

    const runtimeDescriptors = new Map<string, Live2DRuntimeDescriptor>();
    for (const [id, modelPath] of charModelMap.entries()) {
      const resolvedPath = resolvedModelPaths.get(modelPath) ?? modelPath;
      const runtimeInfo = await this.resolveBakeRuntime(resolvedPath, modelPath);
      if (runtimeInfo.runtime) {
        runtimeDescriptors.set(id, runtimeInfo.runtime);
      }
    }

    const needsCubism2 = Array.from(runtimeDescriptors.values()).some((runtime) => runtime.adapterId === 'pixi-live2d-display-cubism2');
    if (needsCubism2) {
      await this.initLive2D();
      if (!this.live2dReady) {
        console.error('[BakeEngine] Live2D runtime not available.');
        return { snapshotHistory: [] };
      }
    }

    // 核心修复：清理不再属于当前剧本的角色模型，防止长期编辑导致模型堆积内存泄漏
    const idsToRemove: string[] = [];
    for (const id of this.models.keys()) {
      if (!charModelMap.has(id)) {
        idsToRemove.push(id);
      }
    }
    for (const id of idsToRemove) {
      this.removeModel(id);
    }

    for (const [id, modelPath] of charModelMap.entries()) {
      const path = resolvedModelPaths.get(modelPath);
      if (path) loadPromises.push(this.loadModel(id, path, modelPath));
    }

    await Promise.all(loadPromises);
    if (!this.checkToken(token)) {
      eventBus.emit(silent ? 'pb-daemon:cancel' : 'bake:cancel');
      return { snapshotHistory: [] };
    }

    // Drain pending loads and warm up
    let loadWait = 0;
    const warmupRenderer = this.app.renderer;
    while (this.activeMotionLoads.size > 0 && loadWait < 30) {
      for (const entry of this.models.values()) {
        this.stepBakeModel(entry, 16, warmupRenderer, false);
      }
      loadWait++;
      await new Promise((r) => setTimeout(r, 10));
    }
    for (let i = 0; i < 5; i++) {
      for (const entry of this.models.values()) {
        this.stepBakeModel(entry, 16, warmupRenderer, false);
      }
    }
    const motionRuntime = await this.createBakeMotionRuntime(
      requiredMotions,
      script.meta?.fps ?? 60,
      seedSnapshot && rangeStart > 0 ? seedSnapshot.time : undefined,
    );
    console.log('[BakeEngine] All assets ready. Starting timeline simulation...');

    const totalDuration = script.timeline.reduce(
      (max, a) => Math.max(max, (a.time || 0) + (a.params?.duration || 0)),
      0,
    );

    // ── Seed Snapshot Restoration ──
    // If a seed snapshot is available, restore model states from it at rangeStart
    // instead of simulating from 0s. This is the key performance optimization.
    const seededCharacters = new Set<string>();
    if (seedSnapshot && rangeStart > 0) {
      for (const [id, modelSnap] of seedSnapshot.models) {
        const entry = this.models.get(id);
        if (!entry) continue;
        const runtimeControls = getLive2DRuntimeAdapter(entry.runtime).getControls();
        runtimeControls.applySnapshot(entry.model, modelSnap);
        // Restore motion state
        if (modelSnap.motion) {
          entry.motionStartTime = modelSnap.motion.startTime;
        }
        seededCharacters.add(id);
      }
      console.log(`[BakeEngine] Restored seed snapshot at ${seedSnapshot.time.toFixed(3)}s for range start ${rangeStart.toFixed(3)}s`);
    }

    // Determine actual simulation start: if seeded, start from rangeStart; otherwise from 0
    const simStart = (seedSnapshot && rangeStart > 0) ? rangeStart : 0;
    // But we only EMIT snapshots within [rangeStart, rangeEnd]
    let simTime = simStart;
    const step = precision;
    let stepCount = 0;

    eventBus.emit(silent ? 'pb-daemon:start' : 'bake:start', { sceneId: script.sceneId, title: script.meta.title });

    const effectiveEnd = Math.min(rangeEnd, totalDuration);
    // Seeded characters are already on stage at rangeStart. Treating them as a
    // first addCharacter appearance would idle-reset the seed pose and restart
    // any in-flight Live2D fade-in from T-pose (ADR-0029 handoff).
    let lastCharacters = new Set<string>(seededCharacters);
    let lastYieldTime = performance.now();

    while (simTime <= effectiveEnd) {
      if (!this.checkToken(token)) break;

        // 1. Sync state (safe, no SDK clock required)
        const { characters, dialogue } = computeSceneStateAtTime(script, simTime);
        for (const [id, state] of characters) {
          let entry = this.models.get(id);
          const targetResolvedPath = state.model ? resolvedModelPaths.get(state.model) : undefined;

          if (entry && targetResolvedPath && entry.modelPath !== targetResolvedPath) {
            this.removeModel(id);
            await this.loadModel(id, targetResolvedPath, state.model);
          } else if (!entry && targetResolvedPath) {
            await this.loadModel(id, targetResolvedPath, state.model);
          }

          entry = this.models.get(id);
          if (entry) {
            // 核心修复：如果这个角色是刚被 addCharacter 的（无论是第一次出现，还是 remove 后重新出现）
            // 必须强制清空它可能残留的任何动作状态，恢复为 Idle。
            if (!lastCharacters.has(id)) {
              const runtimeControls = getLive2DRuntimeAdapter(entry.runtime).getControls();
              runtimeControls.stopAllMotions(entry.model);
              runtimeControls.clearMotionState(entry.model);
              runtimeControls.applySnapshot(entry.model, entry.idleSnapshot as ModelSnapshot);
              if (entry.runtime.runtimeFamily === 'cubism2') {
                await runtimeControls.restartIdleMotion(entry.model);
              }
            }

            const runtimeControls = getLive2DRuntimeAdapter(entry.runtime).getControls();

            this.applyBakeMotionState(entry, state, dialogue, simTime, motionRuntime);

            const expressionKey = state.expression?.key ?? null;
            if (entry.expressionKey !== expressionKey) {
              runtimeControls.setExpression(entry.model, expressionKey);
              entry.expressionKey = expressionKey;
            }

            this.applyDialogueInjectedParams(entry, dialogue, characters, simTime);

            if (state.position) {
              const pos = resolveVec2(state.position);
              entry.model.position.set(pos.x * 1920, pos.y * 1080);
            }
            if (state.scale !== undefined) entry.model.scale.set(state.scale, state.scale);
            if (state.rotation !== undefined) entry.model.rotation = state.rotation;
            if (state.opacity !== undefined) entry.model.alpha = state.opacity;
          }
        }

        // 绝不在此处 removeModel！避免角色被短暂 removeCharacter 后再 addCharacter 导致模型反复加载/释放引发内存泄漏。
        lastCharacters = new Set(characters.keys());

        // 2. 执行 MotionRuntime 的一次性 native start/restart，然后统一推进。
        //    这只在同一个全局 SDK 时钟锁内执行；不再每帧向 SDK 队列写入
        //    _pendingPlayMotion，也不再复制 Live2DManager._executePlayMotion。
        // === 核心修复：必须获取全局锁才能修改 SDK 时钟并执行模型物理更新 ===
        await acquireUtSystemLock();
        try {
          // NativeDriver 的 start/restart 必须在“普通帧推进”之前发生：它
          // 复用 Cubism2NativeMotionSession 在锁内完成 offset 初始化/50ms
          // 快进，随后下面的统一 update 才把 SDK 时钟推进到下一帧。
          const clocks = new Set<Live2DRuntimeClock>();
          for (const entry of this.models.values()) {
            const clock = getLive2DRuntimeAdapter(entry.runtime).getClock();
            if (clock) clocks.add(clock);
            await motionRuntime.advanceNative({ charId: entry.id, utSystem: clock });
          }
          for (const clock of clocks) {
            // 绝不能设置为 simTime * 1000（会引起时间倒流和负数 dt 导致物理坍缩）
            // 必须在当前全局时钟基础上严格单调递增
            const currentUt = clock.getUserTimeMSec();
            clock.setUserTimeMSec(currentUt + step * 1000);
          }

          // 3. 驱动更新并渲染
          const renderer = this.app.renderer;
          for (const entry of this.models.values()) {
            this.stepBakeModel(entry, step * 1000, renderer);
          }
        } finally {
          // 不再恢复 originalUt，让全局时钟严格单调递增，供主引擎和后台共同使用
          releaseUtSystemLock();
        }

        // Capture snapshots
        const models = new Map<string, ModelSnapshot>();
        for (const id of this.models.keys()) {
          const snap = this.captureSnapshot(id);
          if (snap) models.set(id, snap);
        }
        // Only store snapshots within the requested range
        if (models.size > 0 && simTime >= rangeStart) {
          this.appendSnapshot(simTime, models);
        }

      simTime += step;
      stepCount++;

      // Yield aggressively (time-based) to keep the UI at 60+ FPS (16ms budget)
      if (performance.now() - lastYieldTime > 12) {
        if (stepCount % 5 === 0) {
          eventBus.emit(silent ? 'pb-daemon:progress' : 'bake:progress', { 
            progress: Math.min(0.99, simTime / (totalDuration || 1)),
            time: simTime 
          });
        }
        
        await new Promise((r) => setTimeout(r, 0));
        lastYieldTime = performance.now();
        
        // Check if task was cancelled while we were yielding
        if (!this.checkToken(token)) {
          console.warn('[BakeEngine] Simulation aborted after yield.');
          eventBus.emit(silent ? 'pb-daemon:cancel' : 'bake:cancel');
          return { snapshotHistory: [], motionReport: motionRuntime.report() }; // 返回空，防止污染主引擎快照
        }
      }
    }

    // --- 正常完成路径 ---
    const duration = performance.now() - startTime;
    eventBus.emit(silent ? 'pb-daemon:complete' : 'bake:complete', { 
      snapshotCount: this.snapshotHistory.length,
      durationMs: duration
    });
    return { snapshotHistory: this.snapshotHistory, motionReport: motionRuntime.report() };
  }

  destroy(): void {
    for (const id of this.models.keys()) this.removeModel(id);
    this.models.clear();
    this.snapshotHistory = [];
    this.activeMotionLoads.clear();
    cubism2Live2DAdapter.disposeBakeRenderTexture();
    // Remove hidden container from stage — but do NOT destroy with children,
    // because Live2D models' WebGL resources (shaders, textures) are shared
    // with the main scene via the Cubism2 singleton shader manager.
    // Calling container.destroy({children:true}) would delete shared GL programs,
    // causing "uniformMatrix3fv: location is not from the associated program" errors.
    if (this.container.parent) {
      this.container.parent.removeChild(this.container);
    }
    // Remove all children without destroying their WebGL resources
    this.container.removeChildren();
    this.container.destroy({ children: false });
  }

  // ── Private: lifecycle ─────────────────────────────────────────────────

  private checkToken(token: number): boolean {
    if (this.token !== token) {
      console.log('[BakeEngine] Token mismatch, cancelled.');
      return false;
    }
    return true;
  }

  private async initLive2D(): Promise<void> {
    if (this.live2dReady) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        await cubism2Live2DAdapter.init();
        this.live2dReady = cubism2Live2DAdapter.isReady();
        console.log('[BakeEngine] Live2D runtime initialized.');
      } catch (err) {
        console.error('[BakeEngine] Failed to init Live2D:', err);
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  private async initRuntimeAdapter(runtime: Live2DRuntimeDescriptor): Promise<void> {
    if (runtime.adapterId === 'pixi-live2d-display-cubism2') {
      await this.initLive2D();
      return;
    }

    if (this.initPromises.has(runtime.adapterId)) {
      return this.initPromises.get(runtime.adapterId)!;
    }

    const adapter = getLive2DRuntimeAdapter(runtime);
    const initTask = adapter.init().finally(() => {
      this.initPromises.delete(runtime.adapterId);
    });
    this.initPromises.set(runtime.adapterId, initTask);
    await initTask;
  }

  private scanAssets(script: RuntimeTimelineScene) {
    const requiredMotions = new Map<string, Set<string>>(); // ModelPath -> Set of motion keys
    
    // Track the active model path for each character ID as we scan the timeline
    const activeModelMap = new Map<string, string>();

    // Initial state from scene meta
    if (script.meta.characters) {
      for (const char of script.meta.characters) {
        if (char.model) {
          activeModelMap.set(char.id, char.model);
        }
      }
    }

    for (const action of script.timeline) {
      if (action.action === 'addCharacter' && action.params?.id && action.params?.model) {
        activeModelMap.set(action.params.id, action.params.model);
      }
      if (action.action === 'playMotion' && action.params?.id && action.params.motion) {
        const motionKey = resolveMotionKey(action.params.motion);
        if (!motionKey) continue;
        const activeModel = activeModelMap.get(action.params.id);
        if (activeModel) {
          if (!requiredMotions.has(activeModel)) requiredMotions.set(activeModel, new Set());
          requiredMotions.get(activeModel)!.add(motionKey);
        }
      }
    }
    return { requiredMotions };
  }

  private async createBakeMotionRuntime(
    requiredMotions: Map<string, Set<string>>,
    fps: number,
    seedSceneTime?: number,
  ): Promise<BakeMotionRuntime> {
    const requests: BakeMotionPlanRequest[] = [];
    for (const [id, entry] of this.models) {
      const motionKeys = requiredMotions.get(entry.modelKey)
        ?? requiredMotions.get(entry.modelPath);
      if (!motionKeys) continue;
      for (const motionKey of motionKeys) {
        requests.push({
          charId: id,
          adapterId: entry.adapterId,
          modelRuntimePath: entry.modelPath,
          motionKey,
        });
      }
    }

    const host: BakeMotionRuntimeHost = {
      fps,
      getSamplingTargets: (charId) => {
        const entry = this.models.get(charId);
        if (!entry) return [];
        return getLive2DRuntimeAdapter(entry.runtime).getControls().getMotionSamplingTargets(entry.model);
      },
      preloadMotion: (charId, motionKey) => this.preloadMotion(charId, motionKey),
      getBaseValues: (charId, parameterIds, excludeParameterIds) => {
        const entry = this.models.get(charId);
        if (!entry) return {};
        return this.getBakeParameterBaseValues(entry, parameterIds, excludeParameterIds);
      },
      stopNativeMotion: (charId) => {
        const entry = this.models.get(charId);
        if (!entry) return;
        const controls = getLive2DRuntimeAdapter(entry.runtime).getControls();
        controls.stopAllMotions(entry.model);
        controls.clearMotionState(entry.model);
      },
      getModel: (charId) => {
        const entry = this.models.get(charId);
        if (!entry) return undefined;
        return {
          model: entry.model,
          runtimeFamily: entry.runtime.runtimeFamily,
          adapterId: entry.adapterId,
        };
      },
      getSeedSceneTime: () => seedSceneTime,
    };

    const runtime = new BakeMotionRuntime(host);
    await runtime.prepare(requests);
    return runtime;
  }

  // ── Private: model loading ─────────────────────────────────────────────

  private pathToUrl(modelPath: string): string {
    let fullPath = modelPath;
    const isAbsolute = fullPath.startsWith('asset://') || fullPath.startsWith('file://') || /^[a-zA-Z]:[/\\]/.test(fullPath) || fullPath.startsWith('/');
    if (!isAbsolute) {
      return modelPath;
    }
    if (fullPath.startsWith('file:///')) fullPath = fullPath.replace('file:///', '');
    return fullPath.startsWith('asset://') ? fullPath : encodeURI(`asset://localhost/${fullPath.replace(/\\/g, '/')}`);
  }

  private async loadModel(
    id: string,
    absolutePath: string,
    modelKey?: string,
  ): Promise<void> {
    if (this.models.has(id)) return;
    // Lifecycle epoch: if the character is removed/replaced while this load is
    // still in flight, the entry must not be published (and the freshly loaded
    // model must be dropped quietly instead of resurrecting a stale identity).
    const generation = this.modelGeneration.get(id) ?? 0;
    const runtimeInfo = await this.resolveBakeRuntime(absolutePath, modelKey);
    if (!runtimeInfo.supported || !runtimeInfo.runtime) {
      return;
    }
    const { runtime, assetUrl } = runtimeInfo;
    const adapter = getLive2DRuntimeAdapter(runtime);
    await this.initRuntimeAdapter(runtime);

    // Check if this is a composed model (.wmdl) - pure in-memory lookup
    let wmdlConfig = this.wmdlConfigRegistry?.get(modelKey || '');
    if (!wmdlConfig && modelKey?.endsWith('.wmdl')) {
      wmdlConfig = this.wmdlConfigRegistry?.get(absolutePath);
    }

    let model: any = null;
    if (wmdlConfig) {
      // Composed model! Load torso and submodels
      const mainModelUrl = this.pathToUrl(wmdlConfig.modelRelativePath);
      const mainModel = await adapter.createModel(mainModelUrl, {
        autoHitTest: false,
        autoFocus: false,
        autoUpdate: false,
        idleMotionGroup: '',
      });

      const subModels: any[] = [];
      if (wmdlConfig.subModels && Array.isArray(wmdlConfig.subModels)) {
        for (const sub of wmdlConfig.subModels) {
          const subUrl = this.pathToUrl(sub.modelRelativePath);
          try {
            const subModel = await adapter.createModel(subUrl, {
              autoHitTest: false,
              autoFocus: false,
              autoUpdate: false,
              idleMotionGroup: '',
            });
            subModel.x = sub.offsetX ?? 0;
            subModel.y = sub.offsetY ?? 0;
            subModel.visible = true;

            // Isolate sub-model masks to prevent glitches on Cubism 2.
            if (runtime.runtimeFamily === 'cubism2') {
              getLive2DRuntimeAdapter(runtime).getControls().isolateMask(subModel);
            }

            subModels.push(subModel);
          } catch (err) {
            console.warn(`[BakeEngine] Failed to load sub-model during pre-bake: ${subUrl}`, err);
          }
        }
      }

      model = new Live2DCompositeModel(mainModel, subModels);
      model._modelUrl = absolutePath;
    } else {
      model = await adapter.createModel(assetUrl, {
        autoHitTest: false,
        autoFocus: false,
        autoUpdate: false,
        idleMotionGroup: '',
      });
    }

    // The character was removed/replaced while this model was still loading
    // (costume swap, scene reload, cancelled bake). Drop the superseded model
    // before any further wiring so it cannot leak into the simulation or
    // publish a stale entry under the current owner's id.
    if ((this.modelGeneration.get(id) ?? 0) !== generation) {
      this.discardSupersededModel(model);
      return;
    }

    model.visible = true; // must be visible for PIXI to call _render()

    // The render guards keep the family-string gate: they interact with
    // pixi/SDK GL texture state which must not be forced onto a model
    // classified outside the cubism2 family.
    if (runtime.runtimeFamily === 'cubism2' || runtime.runtimeFamily === 'wmdl') {
      getLive2DRuntimeAdapter(runtime).getControls().installBakeRenderGuards(model);
    }

    // Add to hidden container
    this.container.addChild(model);

    const runtimeControls = getLive2DRuntimeAdapter(runtime).getControls();

    try {
      // 核心修复：先 update 后 render，符合 SDK 预期顺序，消除警告。
      // 绝对不能传入 0，否则底层 Physics 会因为除以零 (dt=0) 产生 NaN/Infinity，
      // 导致整个快照被严重污染，进而导致前台模型恢复快照时坍缩成“2个小点”。
      runtimeControls.stepBakeFrame(model, 16, this.app.renderer, id, false);
    } catch (e) {
      console.warn(`[BakeEngine] Initial render failed for ${id}`, e);
    }

    // === 核心修复：安全地洗刷初始状态遗留的 0 opacity ===
    if (runtime.runtimeFamily === 'cubism2') {
      try {
        await runtimeControls.flushIdleState(model);
        // 与旧实现一致：idle flush 结束后再推进一帧（deltaTime 已由 flush 内的
        // update 累积），随后快照捕获看到的才是洗刷后的姿态。
        runtimeControls.stepBakeFrame(model, 0, this.app.renderer, id, false);
      } catch (e) {
        // Ignore
      }
    }

    const entry: BakeModel = {
      id,
      model,
      modelPath: absolutePath, // Note: absolutePath is used here
      modelKey: modelKey || absolutePath,
      runtime,
      adapterId: runtime.adapterId,
      expressionKey: null,
      injectedParams: {},
      idleSnapshot: {
        params: new Float32Array(0),
        opacities: new Float32Array(0),
      },
    };

    // 核心修复：应用完整的行为修复，禁用 SDK 自带的、会导致参数重置的内建系统。
    // The parameter-override hook reads `_characterEntry.injectedParams`
    // during the SDK core update. It must point at this BakeModel — a throwaway
    // mockEntry would leave curve-driver fade-in values uncommitted, so
    // captureModelSnapshot would miss Live2D FadeIn (ADR-0029/0033).
    // `resolveBakeRuntime` can degrade the descriptor to `unknown` when the
    // model json cannot be fetched/parsed for classification (path-only
    // resolution), even though the model is a plain Cubism 2.1 model; the
    // adapter applies the hooks to any model exposing a writable Cubism core
    // shape so degraded descriptors still commit bake params.
    runtimeControls.prepareModel(model, {
      id,
      mode: 'bake',
      isExportMode: false,
      injectedParamsSource: entry,
    });

    const initSnap = runtimeControls.captureSnapshot(id, model);
    entry.idleSnapshot = {
      params: initSnap?.params || new Float32Array(0),
      opacities: initSnap?.opacities || new Float32Array(0),
    };
    // Authoritative lifecycle check: a removal/replacement could have landed
    // during the hook installation and idle flush above. Never publish a
    // stale entry over the current owner.
    if ((this.modelGeneration.get(id) ?? 0) !== generation) {
      this.discardSupersededModel(model);
      return;
    }
    this.models.set(id, entry);

    console.log(`[BakeEngine] Loaded model "${id}" (params=${initSnap?.params?.length ?? '?'})`);

  }

  /**
   * Drop a model whose lifecycle slot has moved on (character removed or
   * replaced while its async load was in flight). Matches `removeModel`'s
   * Cubism 2 policy: soft-detach instead of hard-destroying, so in-flight
   * SDK expression/motion XHRs are never aborted mid-state.
   */
  private discardSupersededModel(model: any): void {
    if (!model) return;
    cubism2Live2DAdapter.getControls().disposeModel(model, {
      mode: 'soft-detach',
      detach: true,
    });
  }

  private async resolveBakeRuntime(
    absolutePath: string,
    modelKey?: string,
  ): Promise<{ supported: boolean; runtime: Live2DRuntimeDescriptor | null; assetUrl: string }> {
    const assetUrl = this.pathToUrl(absolutePath);
    const wmdlConfig = modelKey?.toLowerCase().endsWith('.wmdl')
      ? (this.wmdlConfigRegistry?.get(modelKey) ?? this.wmdlConfigRegistry?.get(absolutePath))
      : null;
    if (wmdlConfig) {
      const modelPaths = [
        wmdlConfig.modelRelativePath,
        ...(Array.isArray(wmdlConfig.subModels)
          ? wmdlConfig.subModels.map((subModel: any) => subModel?.modelRelativePath).filter(Boolean)
          : []),
      ];
      for (const modelPath of modelPaths) {
        const childRuntime = await this.resolveBakeRuntime(modelPath, modelPath);
        if (!childRuntime.supported) {
          return { supported: false, runtime: childRuntime.runtime, assetUrl };
        }
      }
      return {
        supported: true,
        runtime: {
          runtimeFamily: 'wmdl',
          adapterId: 'pixi-live2d-display-cubism2',
          supported: true,
        },
        assetUrl,
      };
    }
    const modelPath = modelKey || absolutePath;
    try {
      const response = await fetch(assetUrl);
      if (!response.ok) {
        return {
          supported: true,
          runtime: resolveLive2DRuntimeDescriptor(modelPath),
          assetUrl,
        };
      }
      const parsed = await response.json();
      const runtime = resolveLive2DRuntimeDescriptor(modelPath, parsed);
      const unsupported = getUnsupportedLive2DRuntimeMessage(modelPath, runtime);
      if (unsupported) {
        console.warn(`[BakeEngine] ${unsupported}`);
        return { supported: false, runtime, assetUrl };
      }
      if (runtime.runtimeFamily === 'cubism3-plus' && modelPath.toLowerCase().endsWith('.wmdl')) {
        console.warn(
          `[BakeEngine] Live2D 模型 "${modelPath}" 已支持主舞台官方 runtime，但 Bake 尚未接入官方 runtime。`,
        );
        return { supported: false, runtime, assetUrl };
      }
    } catch {
      return {
        supported: true,
        runtime: resolveLive2DRuntimeDescriptor(modelPath),
        assetUrl,
      };
    }
    return {
      supported: true,
      runtime: resolveLive2DRuntimeDescriptor(modelPath),
      assetUrl,
    };
  }

  private removeModel(id: string): void {
    // Bump the lifecycle generation BEFORE the entry lookup: a load can be in
    // flight for this id even when no entry exists yet, and its continuation
    // must not publish a model for a character that was just removed.
    this.modelGeneration.set(id, (this.modelGeneration.get(id) ?? 0) + 1);

    const entry = this.models.get(id);
    if (!entry) return;
    try {
      // Teardown decision is adapter-based, not family-string based. A Cubism
      // 2 model whose runtimeFamily degraded to 'unknown' (asset-fetch hiccup
      // during project open) is still a pixi-live2d-display model: hard-
      // destroying it aborts its in-flight expression/motion XHRs and nulls
      // the SDK ExpressionManager caches, which later explodes in the
      // adapter's expression path (unhandled "setting '<index>'" TypeError).
      // Only composites (wmdl) hard-destroy.
      const isCubism2Concrete = entry.adapterId === 'pixi-live2d-display-cubism2'
        && entry.runtime.runtimeFamily !== 'wmdl';
      if (isCubism2Concrete) {
        // Cubism 2 runtime keeps global mask/framebuffer state inside the shared SDK singleton.
        // Fully destroying a background model can clear that global state while other models are
        // still alive, which later crashes in clipManager.setupClip() with undefined framebuffer.
        // For BakeEngine we therefore soft-detach Cubism 2 models instead of calling destroy().
        getLive2DRuntimeAdapter(entry.runtime).getControls().disposeModel(entry.model, {
          mode: 'soft-detach',
          detach: true,
        });
      } else {
        getLive2DRuntimeAdapter(entry.runtime).getControls().disposeModel(entry.model, {
          mode: 'destroy',
          keepTextures: true,
          detach: true,
        });
      }
    } catch {
      /* detach/destroy may fail if model is already partially disposed */
    }
    this.models.delete(id);
  }

  /**
   * One bake frame for one entry: everything below is delegated to the runtime
   * adapter — model advancement, internal/core flush, bake RenderTexture
   * rendering (or the Cubism 2 advance-without-render fast path) and the
   * corrupt-batch salvage around it.
   */
  private stepBakeModel(entry: BakeModel, deltaMs: number, renderer: any, flushCore: boolean = true): void {
    if (!renderer || !entry.model || entry.model.visible === false || entry.model.renderable === false) {
      // Keep the frame advance even when the model is not renderable — only
      // the render is skipped (mirrors the legacy renderBakeModel gate).
      getLive2DRuntimeAdapter(entry.runtime).getControls().stepBakeFrame(
        entry.model,
        deltaMs,
        undefined,
        entry.id,
        flushCore,
      );
      return;
    }
    getLive2DRuntimeAdapter(entry.runtime).getControls().stepBakeFrame(
      entry.model,
      deltaMs,
      renderer,
      entry.id,
      flushCore,
    );
  }

  private applyDialogueInjectedParams(
    entry: BakeModel,
    dialogue: any,
    characters: Map<string, any>,
    simTime: number,
  ): void {
    const isActiveSpeaker = dialogue?.speakerId === entry.id && characters.has(entry.id);
    const mouthValue = isActiveSpeaker
      ? this.computeTextMouthOpen(dialogue.text ?? '', dialogue.duration ?? 3, simTime - dialogue.startTime)
      : 0;

    this.setBakeInjectedParam(entry, 'PARAM_MOUTH_OPEN_Y', mouthValue);
    this.setBakeInjectedParam(entry, 'ParamMouthOpenY', mouthValue);
  }

  /**
   * Resolve the motion output for one bake frame through BakeMotionRuntime.
   *
   * - Authored custom motions and cached resource motions are evaluated by the
   *   shared CurveDriver (evaluateCustomMotionRuntime, ADR-0033).
   * - Permanent cache misses go to the NativeDriver, which uses the timeline
   *   intent as its state source and is advanced inside the BakeEngine-owned
   *   global SDK clock lock.
   *
   * The cache is only consulted by `BakeMotionRuntime.prepare()` before the
   * loop; this method never reads the cache or writes `_pendingPlayMotion`.
   */
  private applyBakeMotionState(
    entry: BakeModel,
    state: any,
    dialogue: any,
    simTime: number,
    motionRuntime: BakeMotionRuntime,
  ): void {
    const channelProtected = dialogue?.speakerId === entry.id
      ? BAKE_DIALOGUE_MOUTH_PARAMS
      : undefined;

    if (!state.motion) {
      motionRuntime.applyIntent({
        charId: entry.id,
        intent: null,
        simTime,
        injectedParams: entry.injectedParams,
      });
      return;
    }

    const result = motionRuntime.applyIntent({
      charId: entry.id,
      intent: {
        output: state.motion.output,
        priority: state.motion.priority,
        time: state.motion.time,
      },
      simTime,
      injectedParams: entry.injectedParams,
      channelProtected,
    });

    // NativeDriver owns restart decisions internally. Bake snapshot metadata
    // still needs the motion start scene time for captureModelSnapshot.
    if (result.driver === 'native') {
      entry.motionStartTime = state.motion.time ?? simTime;
      entry.lastOffset = result.offset;
    }
  }

  /**
   * Capture the parameter pose the custom motion should fade in from. Only
   * the motion's own controlled parameters are collected — the same semantic
   * as Live2DManager's handoff capture — because the fade reconstruction
   * reads handoff values only for controlled tracks; collecting every model
   * parameter would make bake and preview diverge for the same motion.
   * `excludeParameterIds` (active dialogue text-mouth parameters) are skipped
   * so transient effect output is not baked into the fade source.
   */
  private getBakeParameterBaseValues(
    entry: BakeModel,
    parameterIds: readonly string[],
    excludeParameterIds?: ReadonlySet<string>,
  ): Record<string, number> {
    const runtimeControls = getLive2DRuntimeAdapter(entry.runtime).getControls();
    const parameters = runtimeControls.getParameterValues(entry.model) ?? [];
    const wanted = new Set(parameterIds);
    const values: Record<string, number> = {};
    for (const parameter of parameters) {
      if (excludeParameterIds?.has(parameter.name)) continue;
      if (wanted.has(parameter.name) && Number.isFinite(parameter.value)) {
        values[parameter.name] = parameter.value;
      }
    }
    return values;
  }

  private setBakeInjectedParam(entry: BakeModel, paramName: string, value: number): void {
    const nextValue = Number.isFinite(value) ? value : 0;
    if (entry.injectedParams[paramName] === nextValue) return;

    const runtimeControls = getLive2DRuntimeAdapter(entry.runtime).getControls();
    runtimeControls.setInjectedParameter(entry.model, paramName, nextValue);
    runtimeControls.syncInputParameters(entry.model);
    entry.injectedParams[paramName] = nextValue;
  }

  private computeTextMouthOpen(text: string, duration: number, offset: number): number {
    if (!text || !(duration > 0) || offset < 0 || offset > duration) return 0;

    const normalized = Math.max(0, Math.min(1, offset / duration));
    const speakableChars = Array.from(text).filter((ch) => !/\s/.test(ch));
    const syllables = Math.max(1, speakableChars.length);
    const phase = (normalized * syllables) % 1;
    const envelope = Math.sin(Math.PI * phase);
    return Math.max(0, Math.min(1, envelope));
  }

  // ── Private: snapshot capture ──────────────────────────────────────────

  private captureSnapshot(id: string): ModelSnapshot | null {
    const entry = this.models.get(id);
    if (!entry) return null;
    return getLive2DRuntimeAdapter(entry.runtime).getControls().captureSnapshot(
      id,
      entry.model,
      entry.motionStartTime,
    );
  }

  private async preloadMotion(id: string, motionKey: string): Promise<void> {
    const entry = this.models.get(id);
    if (!entry) return;
    const runtimeControls = getLive2DRuntimeAdapter(entry.runtime).getControls();

    // Pre-check if the motion group exists and is not empty to prevent "Undefined motion" warnings
    if (!runtimeControls.hasMotionGroup(entry.model, motionKey)) {
      return;
    }

    this.activeMotionLoads.add(id);
    try {
      await runtimeControls.preloadMotion(entry.model, motionKey);
    } finally {
      this.activeMotionLoads.delete(id);
    }
  }

  private appendSnapshot(
    time: number,
    models: Map<string, ModelSnapshot>,
  ): void {
    const existingIdx = this.snapshotHistory.findIndex(
      (s) => Math.abs(s.time - time) < 0.01,
    );
    const snap = { time, models };
    if (existingIdx !== -1) {
      this.snapshotHistory[existingIdx] = snap;
    } else {
      let lo = 0;
      let hi = this.snapshotHistory.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.snapshotHistory[mid].time < time) lo = mid + 1;
        else hi = mid;
      }
      this.snapshotHistory.splice(lo, 0, snap);
    }
    if (this.snapshotHistory.length > 5000) this.snapshotHistory.shift();
  }



  resetAllModelsToIdle(): void {
    for (const entry of this.models.values()) {
      const runtimeControls = getLive2DRuntimeAdapter(entry.runtime).getControls();
      // A new range gets a new BakeMotionRuntime, but reuses these models.
      // The new curve driver cannot release parameters owned by the previous
      // run. Drop those writers before warmup or the core update hook writes
      // the later motion straight back over the restored entrance pose.
      for (const parameterId of Object.keys(entry.injectedParams)) {
        delete entry.injectedParams[parameterId];
      }
      runtimeControls.stopAllMotions(entry.model);
      runtimeControls.clearMotionState(entry.model);
      runtimeControls.setExpression(entry.model, null);
      entry.expressionKey = null;
      const idle = entry.idleSnapshot;
      if (idle) {
        runtimeControls.applySnapshot(entry.model, idle as ModelSnapshot);
      }
      entry.motionStartTime = undefined;
      entry.lastOffset = undefined;
    }
  }
}

function buildPreparedBakeModelPathMap(
  scene: PreparedCompiledScene,
  resolvedModelPaths: Map<string, string>,
): Map<string, string> {
  const next = new Map(resolvedModelPaths);
  for (const modelRef of collectPreparedModelRefs(scene)) {
    const resolvedPath = next.get(modelRef.source)
      ?? next.get(modelRef.runtimeUri)
      ?? modelRef.runtimeUri;
    next.set(modelRef.source, resolvedPath);
    next.set(modelRef.runtimeUri, resolvedPath);
  }
  return next;
}

function collectPreparedModelRefs(scene: PreparedCompiledScene): PreparedAssetRef[] {
  const refs: PreparedAssetRef[] = [];
  for (const action of scene.actions) {
    if (action.action === 'addCharacter') {
      pushPreparedModelRef(refs, action.params.model);
    }
  }
  return refs;
}

function pushPreparedModelRef(refs: PreparedAssetRef[], value: PreparedRuntimeValue | undefined): void {
  // Unavailable refs carry an empty runtime URI; mapping it would register
  // every degraded model under the same "" key.
  if (isPreparedAssetRef(value) && !value.unavailable) refs.push(value);
}

function resolveMotionKey(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    const candidate = value as { kind?: unknown; key?: unknown };
    if (candidate.kind === 'resource' && typeof candidate.key === 'string') return candidate.key;
    return '';
  }
  return '';
}
