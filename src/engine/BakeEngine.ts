import { STAGE_WIDTH, STAGE_HEIGHT } from './StageDimensions';
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
import { ModelSnapshot } from './Live2DConfig';
import { computeSceneStateAtTime } from './RuntimeSceneState';
import type { RuntimeTimelineScene } from './RuntimeTimelineScene';
import type { PreparedAssetRef, PreparedCompiledScene, PreparedRuntimeValue } from '../api/types/semantic-scene';
import { resolveVec2 } from './utils/math';
import { eventBus } from '../api/events';
import { settingsManager } from '../ui/SettingsStore';
import type { Snapshot } from './SnapshotStore';
import { WmdlConfigRegistry } from './WmdlConfigRegistry';
import { Live2DModelResources, Live2DModelLoadError, type LoadedLive2DModel } from './Live2DModelResources';
import {
  cubism2Live2DAdapter,
  getLive2DRuntimeAdapter,
} from './Live2DRuntimeAdapter';
import { isPreparedAssetRef, preparedSceneToRuntimeTimelineScene } from './PreparedRuntimeScene';
import { BakeMotionRuntime, type BakeMotionPlanRequest, type BakeMotionRuntimeHost } from './BakeMotionRuntime';
import type {
  Live2DBakeFrameBatchInput,
  Live2DBakeFrameBatchResult,
  Live2DBakeFrameOperation,
  Live2DSeekExpressionState,
} from './runtime/Live2DRuntimeContracts';
import type { Live2DModelHandle } from './live2d/runtime/Live2DRuntimeControlModule';
import { submitLive2DBakeFrameBatch } from './live2d/runtime/Live2DRuntimeControlModule';
import type { CustomMotionStageHandle } from './live2d/customMotionStage';

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
  displayObject: PIXI.Container;
  release: LoadedLive2DModel['release'];
  isBorrowCurrent: () => boolean;
  modelPath: string;
  modelKey: string;
  runtimeHandle: Live2DModelHandle;
  adapterId: string;
  motionStartTime?: number;
  lastOffset?: number;
  expressionKey?: string | null;
  customMotionStage?: CustomMotionStageHandle | null;
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
  private taskVersion = 0;
  private closed = false;
  private readonly modelResources: Live2DModelResources;
  private snapshotHistory: { time: number; models: Map<string, ModelSnapshot> }[] = [];
  private activeMotionLoads: Set<string> = new Set();


  private container: PIXI.Container;
  private app: PIXI.Application;

  constructor(app: PIXI.Application, wmdlConfigRegistry?: WmdlConfigRegistry) {
    this.app = app;
    this.container = new PIXI.Container();
    this.modelResources = new Live2DModelResources(() => '', runtime => getLive2DRuntimeAdapter(runtime), 'bake');
    if (wmdlConfigRegistry) this.modelResources.setWmdlConfigRegistry(wmdlConfigRegistry);
    // 关键修复：不要挂载到主舞台 (app.stage)，否则会被主渲染循环 (Ticker) 劫持
    // 导致主线程在后台线程的 update() 调用之前疯狂调用 render()，从而引发 Cubism 底层报错！
    this.container.alpha = 0;
    this.container.visible = false;
  }

  /**
   * Cancel current bake task by invalidating the token.
   */
  cancel(): void {
    this.taskVersion++;
    this.token = -1;
    this.modelResources.cancelLoads();
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
      buildPreparedBakeModelSourceMap(scene),
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
      buildPreparedBakeModelSourceMap(scene),
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
    modelSources: ReadonlyMap<string, string> = new Map(),
  ): Promise<BakeResult> {
    if (this.closed) return { snapshotHistory: [] };
    this.modelResources.cancelLoads();
    const taskVersion = ++this.taskVersion;
    this.token = token;
    const isCurrent = () => this.checkToken(token, taskVersion);

    this.snapshotHistory = [];

    // Reset all loaded models to their idle state to prevent parameter carryover
    const reset = await this.resetAllModelsToIdle(isCurrent);
    if (!reset || !isCurrent()) return { snapshotHistory: [] };

    const startTime = performance.now();

    const { requiredMotions } = this.scanAssets(script, modelSources);

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
      if (path) loadPromises.push(this.loadModel(id, path, modelSources.get(modelPath) ?? modelPath, isCurrent));
    }

    await Promise.all(loadPromises);
    if (!isCurrent()) {
      eventBus.emit(silent ? 'pb-daemon:cancel' : 'bake:cancel');
      return { snapshotHistory: [] };
    }

    // Drain pending loads and warm up
    let loadWait = 0;
    const warmupRenderer = this.app.renderer;
    while (this.activeMotionLoads.size > 0 && loadWait < 30) {
      const result = await this.submitBakeFrameBatch({
        operations: [...this.models.values()].map((entry) => ({
          handle: entry.runtimeHandle,
          isCurrent: () => this.isEntryCurrent(entry, isCurrent),
          renderer: warmupRenderer,
          flushCore: false,
        })),
        deltaMs: 16,
        advanceClock: false,
        isCurrent,
      });
      if (result.status === 'cancelled') return { snapshotHistory: [] };
      loadWait++;
      await new Promise((r) => setTimeout(r, 10));
      if (!isCurrent()) return { snapshotHistory: [] };
    }
    for (let i = 0; i < 5; i++) {
      const result = await this.submitBakeFrameBatch({
        operations: [...this.models.values()].map((entry) => ({
          handle: entry.runtimeHandle,
          isCurrent: () => this.isEntryCurrent(entry, isCurrent),
          renderer: warmupRenderer,
          flushCore: false,
        })),
        deltaMs: 16,
        advanceClock: false,
        isCurrent,
      });
      if (result.status === 'cancelled') return { snapshotHistory: [] };
    }
    const motionRuntime = await this.createBakeMotionRuntime(
      requiredMotions,
      script.meta?.fps ?? 60,
      seedSnapshot && rangeStart > 0 ? seedSnapshot.time : undefined,
      isCurrent,
    );
    if (!isCurrent()) return { snapshotHistory: [], motionReport: motionRuntime.report() };
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
      const restoreOperations: Live2DBakeFrameOperation[] = [];
      for (const [id, modelSnap] of seedSnapshot.models) {
        const entry = this.models.get(id);
        if (!entry || !this.isEntryCurrent(entry, isCurrent)) continue;
        restoreOperations.push({
          handle: entry.runtimeHandle,
          isCurrent: () => this.isEntryCurrent(entry, isCurrent),
          restoreSnapshot: modelSnap,
          submitFrame: false,
        });
      }
      const restored = await this.submitBakeFrameBatch({
        operations: restoreOperations,
        deltaMs: 0,
        advanceClock: false,
        isCurrent,
      });
      if (restored.status !== 'submitted' || !isCurrent()) return { snapshotHistory: [] };
      for (const [id, modelSnap] of seedSnapshot.models) {
        const entry = this.models.get(id);
        if (!entry || !this.isEntryCurrent(entry, isCurrent)) continue;
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

    const effectiveEnd = rangeEnd;
    // Seeded characters are already on stage at rangeStart. Treating them as a
    // first addCharacter appearance would idle-reset the seed pose and restart
    // any in-flight Live2D fade-in from T-pose (ADR-0029 handoff).
    let lastCharacters = new Set<string>(seededCharacters);
    let lastYieldTime = performance.now();

    try {
      while (simTime <= effectiveEnd) {
        if (!isCurrent()) break;

          // 1. Prepare domain state before submitting one complete runtime frame.
          const { characters, dialogue } = computeSceneStateAtTime(script, simTime);
          const resetForPlaybackIds = new Set<string>();
          const expressionUpdates = new Map<string, Live2DSeekExpressionState & { previousKey?: string | null }>();
          for (const [id, state] of characters) {
            let entry = this.models.get(id);
            const targetResolvedPath = state.model ? resolvedModelPaths.get(state.model) : undefined;

            if (entry && targetResolvedPath && entry.modelPath !== targetResolvedPath) {
              motionRuntime.releaseCharacter(id, entry.injectedParams);
              this.removeModel(id);
              await this.loadModel(id, targetResolvedPath, modelSources.get(state.model) ?? state.model, isCurrent);
            } else if (!entry && targetResolvedPath) {
              await this.loadModel(id, targetResolvedPath, modelSources.get(state.model) ?? state.model, isCurrent);
            }

            if (!isCurrent()) break;
            entry = this.models.get(id);
            if (entry) {
              // 核心修复：如果这个角色是刚被 addCharacter 的（无论是第一次出现，还是 remove 后重新出现）
              // 必须强制清空它可能残留的任何动作状态，恢复为 Idle。
              if (!lastCharacters.has(id)) {
                resetForPlaybackIds.add(id);
              }

              this.applyBakeMotionState(entry, state, dialogue, simTime, motionRuntime);

              const expressionKey = state.expression?.key ?? null;
              if (entry.expressionKey !== expressionKey) {
                const expressionTime = state.expression?.time;
                expressionUpdates.set(id, {
                  key: expressionKey,
                  elapsedSeconds: Number.isFinite(expressionTime) ? Math.max(0, simTime - expressionTime) : Number.POSITIVE_INFINITY,
                  previousKey: state.expression?.previousKey,
                });
              }

              this.applyDialogueInjectedParams(entry, dialogue, characters, simTime);
              const focus = state.lookAt?.focus ?? [0, 0];
              entry.runtimeHandle.focus.apply({ focusX: focus[0], focusY: focus[1], duration: 0 });
              const blink = state.blink;
              entry.runtimeHandle.blink.set(blink?.enabled ?? false, blink?.intervalMs ?? 4000,
                simTime, blink?.startTime ?? 0, blink?.intervalRangeMs ?? 0);

              if (state.position) {
                const pos = resolveVec2(state.position);
                entry.displayObject.position.set(pos.x * STAGE_WIDTH, pos.y * STAGE_HEIGHT);
              }
              if (state.scale !== undefined) entry.displayObject.scale.set(state.scale, state.scale);
              if (state.rotation !== undefined) entry.displayObject.rotation = state.rotation;
              if (state.opacity !== undefined) entry.displayObject.alpha = state.opacity;
            }
          }

          // 绝不在此处 removeModel！避免角色被短暂 removeCharacter 后再 addCharacter 导致模型反复加载/释放引发内存泄漏。
          lastCharacters = new Set(characters.keys());

          if (!isCurrent()) break;

          // 2. The runtime starts native motions, coordinates the shared clock,
          //    advances it once, then submits every bound model's complete frame.
          const frameEntries = [...this.models.values()];
          const operations = frameEntries.map((entry) => {
            const pending = motionRuntime.pendingNativeStart(entry.id);
            const operation = {
              handle: entry.runtimeHandle,
              sceneTimeSeconds: simTime,
              isCurrent: () => this.isEntryCurrent(entry, isCurrent),
              renderer: this.app.renderer,
              stopMotion: motionRuntime.hasPendingNativeStop(entry.id),
              ...(expressionUpdates.has(entry.id) ? { expressionState: expressionUpdates.get(entry.id)! } : {}),
              ...(resetForPlaybackIds.has(entry.id)
                ? {
                    resetForPlayback: {
                      idleSnapshot: entry.idleSnapshot as ModelSnapshot,
                      restartIdleMotion: !entry.customMotionStage,
                    },
                  }
                : {}),
              ...(pending
                ? {
                    motionStart: {
                      motionKey: pending.motionKey,
                      priority: pending.priority,
                      offsetSeconds: pending.offsetSeconds,
                      sceneTimeSeconds: pending.sceneTimeSeconds,
                      fadeInSeconds: pending.fadeInSeconds,
                    },
                  }
                : {}),
            };
            return operation;
          });
          const batch = await this.submitBakeFrameBatch({
            operations,
            deltaMs: step * 1000,
            isCurrent,
          });
          if (batch.status !== 'submitted') {
            eventBus.emit(silent ? 'pb-daemon:cancel' : 'bake:cancel');
            return { snapshotHistory: [], motionReport: motionRuntime.report() };
          }
          for (const entry of frameEntries) {
            const transition = batch.transitions.get(entry.id);
            if (transition) motionRuntime.completeNativeStart(entry.id, transition);
            if (motionRuntime.hasPendingNativeStop(entry.id)) motionRuntime.completeNativeStop(entry.id);
            if (expressionUpdates.has(entry.id)) entry.expressionKey = expressionUpdates.get(entry.id)!.key;
          }

          if (!isCurrent()) break;

          // Capture snapshots
          const models = new Map<string, ModelSnapshot>();
          for (const entry of this.models.values()) {
            if (!this.isEntryCurrent(entry, isCurrent)) continue;
            const snap = this.captureSnapshot(entry);
            if (snap) models.set(entry.id, snap);
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
          if (!isCurrent()) {
            console.warn('[BakeEngine] Simulation aborted after yield.');
            eventBus.emit(silent ? 'pb-daemon:cancel' : 'bake:cancel');
            return { snapshotHistory: [], motionReport: motionRuntime.report() }; // 返回空，防止污染主引擎快照
          }
        }
      }

      if (!isCurrent()) {
        eventBus.emit(silent ? 'pb-daemon:cancel' : 'bake:cancel');
        return { snapshotHistory: [], motionReport: motionRuntime.report() };
      }

      // --- 正常完成路径 ---
      const duration = performance.now() - startTime;
      eventBus.emit(silent ? 'pb-daemon:complete' : 'bake:complete', {
        snapshotCount: this.snapshotHistory.length,
        durationMs: duration
      });
      return { snapshotHistory: this.snapshotHistory, motionReport: motionRuntime.report() };
    } finally {
      motionRuntime.dispose();
    }
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancel();
    this.modelResources.close();
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

  private checkToken(token: number, taskVersion: number): boolean {
    if (this.closed || this.token !== token || this.taskVersion !== taskVersion) {
      console.log('[BakeEngine] Token mismatch, cancelled.');
      return false;
    }
    return true;
  }

  /** Includes SDK requests whose task has already been cancelled or closed. */
  async waitForLoads(): Promise<void> {
    await this.modelResources.waitForLoads();
  }

  private scanAssets(script: RuntimeTimelineScene, modelSources: ReadonlyMap<string, string>) {
    const requiredMotions = new Map<string, Set<string>>(); // ModelPath -> Set of motion keys

    // Track the active model path for each character ID as we scan the timeline
    const activeModelMap = new Map<string, string>();

    // Initial state from scene meta
    if (script.meta.characters) {
      for (const char of script.meta.characters) {
        if (char.model) {
          activeModelMap.set(char.id, modelSources.get(char.model) ?? char.model);
        }
      }
    }

    for (const action of script.timeline) {
      if (action.action === 'addCharacter' && action.params?.id && action.params?.model) {
        activeModelMap.set(action.params.id, modelSources.get(action.params.model) ?? action.params.model);
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
    seedSceneTime: number | undefined,
    isCurrent: () => boolean,
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
      sampleMotion: (charId, motionKey, options) => {
        const entry = this.models.get(charId);
        if (!entry || !this.isEntryCurrent(entry, isCurrent)) {
          return Promise.resolve({ status: 'unsupported' as const, diagnostics: ['Bake model is no longer current.'] });
        }
        return entry.runtimeHandle.motion.sampleMotion(motionKey, options);
      },
      preloadMotion: (charId, motionKey) => this.preloadMotion(charId, motionKey, isCurrent),
      getBaseValues: (charId, parameterIds, excludeParameterIds) => {
        const entry = this.models.get(charId);
        if (!entry || !this.isEntryCurrent(entry, isCurrent)) return {};
        return this.getBakeParameterBaseValues(entry, parameterIds, excludeParameterIds);
      },
      getSeedSceneTime: () => seedSceneTime,
      installCustomMotionStage: (charId, input) => {
        const entry = this.models.get(charId);
        if (!entry || !this.isEntryCurrent(entry, isCurrent)) return null;
        entry.customMotionStage?.dispose();
        entry.runtimeHandle.lifecycle.stopAllMotions();
        entry.runtimeHandle.parameters.restoreIdleBaseline(entry.idleSnapshot);
        const stage = entry.runtimeHandle.customMotion.installStage(input);
        if (!stage) return null;
        const owned: CustomMotionStageHandle = {
          setSceneTime: (time) => stage.setSceneTime(time),
          dispose: () => {
            stage.dispose();
            if (entry.customMotionStage === owned) entry.customMotionStage = null;
          },
        };
        entry.customMotionStage = owned;
        return owned;
      },
    };

    const runtime = new BakeMotionRuntime(host);
    await runtime.prepare(requests);
    return runtime;
  }

  // ── Private: model loading ─────────────────────────────────────────────

  private async loadModel(
    id: string,
    absolutePath: string,
    modelKey: string,
    isTaskCurrent: () => boolean,
  ): Promise<void> {
    const existing = this.models.get(id);
    if (existing?.modelPath === absolutePath || !isTaskCurrent()) return;
    if (existing) this.removeModel(id);
    try {
      await this.modelResources.loadCharacter(id, absolutePath, async loaded => {
        const { model, runtime, isCurrent, release } = loaded;
        if (!isCurrent() || !isTaskCurrent()) return;
        const adapter = getLive2DRuntimeAdapter(runtime);
        const runtimeHandle = adapter.createModelHandle(id, model, runtime);
        const isLoadCurrent = () => isCurrent() && isTaskCurrent();
        this.container.addChild(runtimeHandle.displayObject);
        const initialized = await runtimeHandle.initialize({
          mode: 'bake', renderer: this.app.renderer, isCurrent: isLoadCurrent,
        });
        if (initialized.status !== 'ready' || !isLoadCurrent()) return;
        const borrow = { active: true, published: false, entry: null as BakeModel | null };
        const isBorrowCurrent = () => borrow.active && (
          borrow.published ? this.models.get(id) === borrow.entry : isLoadCurrent()
        );
        const releaseBorrow: LoadedLive2DModel['release'] = (disposition = 'reuse') => {
          if (!borrow.active) return;
          borrow.active = false;
          release(disposition);
        };
        const entry: BakeModel = {
          id, displayObject: runtimeHandle.displayObject, release: releaseBorrow,
          isBorrowCurrent,
          modelPath: absolutePath, modelKey,
          runtimeHandle, adapterId: runtime.adapterId, expressionKey: null,
          injectedParams: {},
          idleSnapshot: { params: new Float32Array(0), opacities: new Float32Array(0) },
        };
        borrow.entry = entry;
        if (!runtimeHandle.bindRuntimeSource({
          mode: 'bake', isExportMode: false, injectedParamsSource: entry, isCurrent: isBorrowCurrent,
        })) return;
        entry.idleSnapshot = initialized.idleSnapshot ?? entry.idleSnapshot;
        if (!isLoadCurrent()) return;
        this.models.set(id, entry);
        borrow.published = true;
      }, undefined, modelKey);
    } catch (error) {
      if (!(error instanceof Live2DModelLoadError)) throw error;
      console.warn(`[BakeEngine] ${error.message}`, error.fullPath);
    }
  }

  private removeModel(id: string): void {
    this.modelResources.cancelLoad(id, 'discard');
    const entry = this.models.get(id);
    if (!entry) return;
    entry.customMotionStage?.dispose();
    entry.release('discard');
    this.models.delete(id);
  }

  private async submitBakeFrameBatch(
    input: Live2DBakeFrameBatchInput,
  ): Promise<Live2DBakeFrameBatchResult> {
    try {
      const result = await submitLive2DBakeFrameBatch(input);
      if (result.status === 'cancelled') this.discardBakeBatchBorrows(input.operations);
      return result;
    } catch (error) {
      this.discardBakeBatchBorrows(input.operations);
      throw error;
    }
  }

  private discardBakeBatchBorrows(operations: readonly Live2DBakeFrameOperation[]): void {
    for (const operation of operations) {
      const entry = this.models.get(operation.handle.id);
      if (entry && entry.runtimeHandle === operation.handle) this.removeModel(entry.id);
    }
  }

  private isEntryCurrent(entry: BakeModel, isTaskCurrent: () => boolean): boolean {
    return isTaskCurrent()
      && this.models.get(entry.id) === entry
      && entry.isBorrowCurrent();
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
   *   intent as its state source and returns a start request for the complete
   *   runtime frame batch.
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
    const parameters = entry.runtimeHandle.parameters.getParameterValues() ?? [];
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

  private captureSnapshot(entry: BakeModel): ModelSnapshot | null {
    return entry.runtimeHandle.snapshot.captureSnapshot(entry.motionStartTime);
  }

  private async preloadMotion(id: string, motionKey: string, isTaskCurrent: () => boolean = () => true): Promise<void> {
    const entry = this.models.get(id);
    if (!entry || !this.isEntryCurrent(entry, isTaskCurrent)) return;

    // Pre-check if the motion group exists and is not empty to prevent "Undefined motion" warnings
    if (!entry.runtimeHandle.motion.hasMotionGroup(motionKey)) {
      return;
    }

    this.activeMotionLoads.add(id);
    try {
      await entry.runtimeHandle.motion.preloadMotion(motionKey, () => this.isEntryCurrent(entry, isTaskCurrent));
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



  async resetAllModelsToIdle(isTaskCurrent: () => boolean = () => true): Promise<boolean> {
    const entries = [...this.models.values()].filter(entry => this.isEntryCurrent(entry, isTaskCurrent));
    for (const entry of entries) {
      entry.customMotionStage?.dispose();
      // A new range gets a new BakeMotionRuntime, but reuses these models.
      // The new curve driver cannot release parameters owned by the previous
      // run. Drop those writers before warmup or the core update hook writes
      // the later motion straight back over the restored entrance pose.
      for (const parameterId of Object.keys(entry.injectedParams)) {
        delete entry.injectedParams[parameterId];
      }
    }
    const result = await this.submitBakeFrameBatch({
      operations: entries.map(entry => ({
        handle: entry.runtimeHandle,
        isCurrent: () => this.isEntryCurrent(entry, isTaskCurrent),
        resetRuntimeState: { pose: 'idle', idleSnapshot: entry.idleSnapshot },
        submitFrame: false,
      })),
      deltaMs: 0,
      advanceClock: false,
      isCurrent: isTaskCurrent,
    });
    if (result.status !== 'submitted' || !isTaskCurrent()) return false;
    for (const entry of entries) {
      if (!this.isEntryCurrent(entry, isTaskCurrent)) continue;
      entry.expressionKey = null;
      entry.motionStartTime = undefined;
      entry.lastOffset = undefined;
    }
    return true;
  }
}

function buildPreparedBakeModelSourceMap(scene: PreparedCompiledScene): Map<string, string> {
  return new Map(collectPreparedModelRefs(scene).map(ref => [ref.runtimeUri, ref.source]));
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
