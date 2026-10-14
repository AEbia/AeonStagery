/**
 * Live2D Stage Runtime
 *
 * Owns stage character state, command mailboxes, and the deterministic frame
 * commit used by the Live2D facade. Model loading/texture ownership remains in
 * Live2DModelResources; motion policy remains in Live2DMotionController.
 */

import { advanceLive2DStageClock, getLive2DRuntimeCapabilities } from './live2d/runtime/Live2DRuntimeControlModule';
import * as PIXI from 'pixi.js';
import {
  isSharedRuntimeClockLocked,
} from './live2d/runtime/Live2DRuntimeClockCoordinator';
import type { CharacterConfig, CharacterTransformConfig } from '../api/types/character';
import type { CharacterEntry } from './Live2DConfig';
import type { ModelSnapshot } from './Live2DConfig';
import type { CharacterMotionOutput } from '../api/types/semantic-scene';
import type { RimLightStyleState } from '../api/types/visual';
import type { ResolvedRimLightState } from './RimLightResolver';
import { getBoundRuntimeHandle } from './live2d/runtime/BoundRuntimeAccess';
import { applyCustomMotionValues, evaluateCustomMotionRuntime } from './live2d/customMotionRuntime';
import { Live2DMotionController, type MotionRequest } from './Live2DMotionController';
import { Live2DModelResources, type Live2DResourceModel } from './Live2DModelResources';
import { getLive2DRuntimeAdapter } from './Live2DRuntimeAdapter';
import { Live2DCharacterGeometry, type Live2DGeometrySceneContext } from './Live2DCharacterGeometry';
import { Live2DRimLightController } from './Live2DRimLightController';
import { stageManager } from './StageManager';
import { hookSystem } from '../api/hooks';
import { resolveVec2 } from './utils/math';
import { purgeCharacterRuntimeState } from './live2d/characterStatePurge';
import type { Vec2 } from '../api/types/common';
import gsap from 'gsap';

export type PendingCustomMotion = {
  motion: Extract<CharacterMotionOutput, { kind: 'custom' }>;
  sceneTime: number;
  handoffSnapshot?: ModelSnapshot | null;
};

export type PendingLookAt = {
  focusX: number;
  focusY: number;
  duration: number;
  options?: { fromX?: number; fromY?: number; elapsed?: number; ease?: string };
};

export type PendingBlink = {
  enabled: boolean;
  intervalMs: number;
  sceneTimeSeconds?: number;
  startTimeSeconds?: number;
  intervalRangeMs?: number;
};

export type PendingRimLightCommand =
  | { mode: 'set'; color: string | number; intensity: number; thickness: number; angle: number; softness: number; duration: number; startTime?: number }
  | { mode: 'reset'; duration: number; baseline?: RimLightStyleState; startTime?: number };

export type Live2DStageIntent =
  | { kind: 'motion'; request: MotionRequest }
  | { kind: 'customMotion'; request: PendingCustomMotion }
  | { kind: 'expression'; expression: string | null }
  | { kind: 'lookAt'; request: PendingLookAt }
  | { kind: 'blink'; request: PendingBlink };

type StageSceneContext = Live2DGeometrySceneContext & {
  getCurrentTime?: () => number;
};

type MotionQueueItem = { id: string; req: MotionRequest };

export interface Live2DStageRuntimeCallbacks {
  dispatchMotion: (id: string, request: MotionRequest) => Promise<void>;
  describeInvalidModelState: (entry: CharacterEntry) => string | null;
  repairCorruptedModel: (entry: CharacterEntry, reason: string, waitForRepair: boolean) => Promise<void>;
  maybeInstallCustomMotionStage: (entry: CharacterEntry) => void;
  resolveCustomMotionSceneTime: (entry: CharacterEntry, manualTimeMs?: number) => number;
  getScriptEngine: () => StageSceneContext | null;
  getCamera: () => { position: Vec2; zoom: number } | null;
  isExportMode: () => boolean;
  applyIntent: (id: string, intent: Live2DStageIntent) => void;
}

export class Live2DStageRuntime {
  private readonly characters = new Map<string, CharacterEntry>();
  private readonly containers = new Map<string, PIXI.Container>();
  private readonly pendingMotions = new Map<string, MotionRequest[]>();
  private readonly characterGenerations = new Map<string, number>();
  private readonly jumpingCharacters = new Set<string>();
  private readonly motionMutex = new Map<string, Promise<void>>();
  private readonly hardResetMutex = new Map<string, Promise<void>>();
  private readonly pendingConfigs = new Map<string, Partial<CharacterTransformConfig>[]>();
  private readonly activeMotionLoads = new Set<string>();
  private readonly pendingIntents = new Map<string, Map<Live2DStageIntent['kind'], Live2DStageIntent>>();
  private readonly pendingRimLightCommands = new Map<string, PendingRimLightCommand>();
  private readonly pendingRimLightStates = new Map<string, ResolvedRimLightState>();
  private stageEpoch = 0;
  private motions: Live2DMotionController | null = null;
  readonly geometry: Live2DCharacterGeometry;
  readonly rimLights: Live2DRimLightController;

  private readonly pendingMotionQueue: MotionQueueItem[] = [];
  private pendingMotionCount = 0;
  private shouldUpdate = true;
  private tickerAdded = false;

  constructor(
    private readonly callbacks: Live2DStageRuntimeCallbacks,
    private readonly resources: Live2DModelResources,
  ) {
    this.geometry = new Live2DCharacterGeometry(
      this.characters, this.pendingConfigs, (id) => this.getContainer(id),
      callbacks.getScriptEngine, callbacks.getCamera,
    );
    this.rimLights = new Live2DRimLightController(
      this.characters, (id) => this.getContainer(id),
      () => callbacks.getScriptEngine()?.getCurrentTime?.(),
      this.pendingRimLightCommands, this.pendingRimLightStates,
    );
  }

  get isUpdating(): boolean { return this.shouldUpdate; }

  getCharacter(id: string): CharacterEntry | undefined { return this.characters.get(id); }
  getCharacterIds(): string[] { return [...this.characters.keys()]; }
  getCharacterEntries(): IterableIterator<CharacterEntry> { return this.characters.values(); }

  get motionController(): Live2DMotionController {
    return this.motions ??= new Live2DMotionController(
      this.characters, this.containers, this.pendingMotions, this.pendingConfigs,
      this.motionMutex, this.hardResetMutex, this.activeMotionLoads, this.jumpingCharacters,
      this.callbacks.getScriptEngine,
    );
  }

  bufferIntent(id: string, intent: Live2DStageIntent): void {
    let intents = this.pendingIntents.get(id);
    if (!intents) this.pendingIntents.set(id, intents = new Map());
    intents.set(intent.kind, intent);
  }

  discardIntent(id: string, kind: Live2DStageIntent['kind']): void {
    const intents = this.pendingIntents.get(id);
    intents?.delete(kind);
    if (intents?.size === 0) this.pendingIntents.delete(id);
  }

  clearPendingCustomMotions(): void {
    for (const id of this.pendingIntents.keys()) this.discardIntent(id, 'customMotion');
  }

  getContainer(id: string): PIXI.Container {
    let container = this.containers.get(id);
    if (!container) {
      container = new PIXI.Container();
      container.name = `character-container-${id}`;
      container.alpha = 0;
      this.containers.set(id, container);
      stageManager.getLayer('characters').addChild(container);
    }
    return container;
  }

  async addCharacter(id: string, modelJsonPath: string, config: CharacterConfig = {}): Promise<void> {
    const targetMap = this.characters;
    const epoch = this.stageEpoch;
    if (targetMap.has(id)) this.removeCharacter(id);
    await this.resources.loadCharacter(id, modelJsonPath, async ({ model, modelUrl, runtime, isCurrent: resourceIsCurrent, release }) => {
        const staging = { model } as { model: Live2DResourceModel; container?: PIXI.Container; entry?: CharacterEntry };
        try {
          const isCurrent = () => resourceIsCurrent() && epoch === this.stageEpoch
            && this.characterGenerations.get(id) === lifecycleGeneration;
          const lifecycleGeneration = this.nextCharacterGeneration(id);
          const adapter = getLive2DRuntimeAdapter(runtime);
          const runtimeHandle = adapter.createModelHandle(id, model, runtime);
          const initialized = await runtimeHandle.initialize({ mode: 'live', isCurrent });
          if (initialized.status !== 'ready' || !isCurrent()) { release(); return; }
          const idleSnapshot = initialized.idleSnapshot;

          // Start our manual ticker if this is the first character
          if (!this.tickerAdded) {
            const app = stageManager.getApp();
            app.ticker.add((ticker) => void this.step(ticker.deltaMS));
            this.tickerAdded = true;
          }

          // Apply positioning
          const camera = this.syncCurrentCamera();
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
          Reflect.set(model, '_baseHeight', baseHeight);

          const targetHeight = 1080 * (config.scale ?? 1.3);
          const modelScale = targetHeight / baseHeight;
          model.scale.set(modelScale);
          const baseWidth = (model.width && modelScale !== 0)
            ? model.width / modelScale
            : baseHeight * 0.58;

          // Flip
          if (config.flipX) {
            model.scale.x *= -1;
            Reflect.set(model, '_flipX', true);
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
          if (this.callbacks.getScriptEngine()) {
            const proxy = this.callbacks.getScriptEngine()?.transformationProxies?.get(id);
            if (proxy) this.geometry.applyProxyTransform(id, proxy, model, camera ?? undefined);
          }

          model.visible = true; // 现在可以安全显示了

          // --- 核心修复：生命周期校验 ---
          // 如果在 await 加载期间角色已经被删除了（例如连续 Seek），则直接丢弃这个模型
          if (!isCurrent()) {
            console.warn(`[Live2D] Model for "${id}" loaded but character was already removed. Skip display.`);
            this.rollbackEntrance(id, staging);
            release();
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
            mode: 'live', isExportMode: this.callbacks.isExportMode(), injectedParamsSource: entry,
            applyProxyTransform: (proxyId, proxy) => this.geometry.applyProxyTransform(proxyId, proxy), isCurrent,
          })) { this.rollbackEntrance(id, staging); release(); return; }

          targetMap.set(id, entry);

          // Abort if character was removed during async loading / setup
          if (!isCurrent()) {
            this.rollbackEntrance(id, staging);
            release();
            return;
          }

          // 核心修复：加载完成后，立即对齐 ScriptEngine 的代理状态（透明度、位置等）
          // 这样即便在 fadeIn 补间过程中加载完成，模型也会立刻跳到当前的正确不透明度
          if (this.callbacks.getScriptEngine()) {
            const proxy = this.callbacks.getScriptEngine()?.transformationProxies?.get(id);
            if (proxy) {
              const latestCamera = this.syncCurrentCamera();
              this.geometry.applyProxyTransform(id, proxy, undefined, latestCamera ?? undefined);
            }
          }

          this.replayPendingIntents(id, entry, isCurrent);
          if (!isCurrent() || this.characters.get(id) !== entry) return;

          // Fire hook
          hookSystem.execute('character:add', { id, modelPath: modelJsonPath });

          console.log(`[Live2D] Character "${id}" added to stage.`);
        } catch (error) {
          // Roll back before Resources can recycle the borrowed instance. Keep
          // its request current so a preparation/replay failure still propagates.
          this.rollbackEntrance(id, staging);
          throw error;
        }
      }, () => stageManager.getApp().renderer);
  }

  private syncCurrentCamera(): { position: Vec2; zoom: number } | null {
    return this.callbacks.getCamera();
  }

  private destroyContainer(id: string, container: PIXI.Container): void {
    if (this.containers.get(id) !== container) return;
    gsap.killTweensOf(container);
    container.parent?.removeChild(container);
    container.destroy({ children: true });
    this.containers.delete(id);
  }

  private rollbackEntrance(id: string, staging: { model: Live2DResourceModel; container?: PIXI.Container; entry?: CharacterEntry }): void {
    if (staging.entry && this.characters.get(id) === staging.entry) {
      this.withdrawCharacter(id);
    } else if (staging.container && this.containers.get(id) === staging.container) {
      // Detach the borrowed model before destroying its stage container.
      const model = staging.model;
      if (model?.parent === staging.container) staging.container.removeChild(model);
      this.destroyContainer(id, staging.container);
    }
  }

  removeCharacter(id: string): void {
    this.resources.cancelLoad(id);
    this.withdrawCharacter(id);
  }

  private withdrawCharacter(id: string): void {
    this.nextCharacterGeneration(id);
    this.pendingIntents.delete(id);
    this.pendingMotions.delete(id);
    this.pendingConfigs.delete(id);
    this.rimLights.removeCharacter(id);
    this.pendingRimLightStates.delete(id);

    const entry = this.characters.get(id);
    if (entry) {
      entry.lifecycleGeneration = (entry.lifecycleGeneration ?? 0) + 1;
      purgeCharacterRuntimeState(entry, { restoreNeutralPose: true });
      gsap.killTweensOf(entry.model);
      gsap.killTweensOf(entry.model.scale);
      entry.breathTween?.kill();
      // Borrowed models outlive their stage container and retain shared textures.
      entry.model?.parent?.removeChild(entry.model);
    }
    const container = this.containers.get(id);
    if (container) this.destroyContainer(id, container);
    if (entry) {
      entry.releaseModel?.();
      this.characters.delete(id);
      hookSystem.execute('character:remove', { id });
      console.log(`[Live2D] Character "${id}" removed from stage.`);
    }
  }

  private replayPendingIntents(id: string, entry: CharacterEntry, isCurrent: () => boolean): void {
    // Consume before dispatch. Resource replay itself supersedes custom intents,
    // so retain the later custom intent locally until resource replay completes.
    const intents = this.pendingIntents.get(id);
    const motions = this.pendingMotions.get(id);
    const transforms = this.pendingConfigs.get(id);
    this.pendingIntents.delete(id);
    this.pendingMotions.delete(id);
    this.pendingConfigs.delete(id);
    const current = () => isCurrent() && this.characters.get(id) === entry;
    for (const kind of ['expression', 'lookAt', 'blink'] as const) {
      const intent = intents?.get(kind);
      if (intent && current()) this.callbacks.applyIntent(id, intent);
    }
    if (current()) this.rimLights.applyPending(id);
    for (const request of motions ?? []) {
      if (current()) this.callbacks.applyIntent(id, { kind: 'motion', request });
    }
    const customMotion = intents?.get('customMotion');
    if (customMotion && current()) this.callbacks.applyIntent(id, customMotion);
    for (const config of transforms ?? []) {
      if (current()) this.geometry.transform(id, config);
    }
  }

  setAutoUpdate(enabled: boolean): void {
    this.shouldUpdate = enabled;
    for (const entry of this.characters.values()) {
      entry.model.autoUpdate = false;
    }
  }

  private nextCharacterGeneration(id: string): number {
    const next = (this.characterGenerations.get(id) ?? 0) + 1;
    this.characterGenerations.set(id, next);
    return next;
  }

  async waitForQuiescence(waitForResources: () => Promise<void>): Promise<void> {
    while (this.motionMutex.size > 0 || this.hardResetMutex.size > 0) {
      await Promise.allSettled([
        waitForResources(),
        ...this.motionMutex.values(),
        ...this.hardResetMutex.values(),
      ]);
    }
    await waitForResources();
  }

  async step(
    dt: number,
    forceStep: boolean = false,
    manualTimeMs?: number,
  ): Promise<void> {
    const sharedClockLocked = isSharedRuntimeClockLocked();

    this.pendingMotionCount = 0;
    for (const entry of this.characters.values()) {
      if (sharedClockLocked) {
        const runtime = getBoundRuntimeHandle(entry);
        if (!runtime || runtime.frame.shouldDeferPreview()) continue;
      }
      const request = entry._pendingPlayMotion;
      if (!request) continue;
      entry._pendingPlayMotion = undefined;
      if (!this.pendingMotionQueue[this.pendingMotionCount]) {
        this.pendingMotionQueue[this.pendingMotionCount] = { id: '', req: request };
      }
      const item = this.pendingMotionQueue[this.pendingMotionCount];
      item.id = entry.id;
      item.req = request;
      this.pendingMotionCount++;
    }

    const motionPromises: Promise<void>[] = [];
    for (let i = 0; i < this.pendingMotionCount; i++) {
      const { id, req } = this.pendingMotionQueue[i];
      const promise = this.callbacks.dispatchMotion(id, req)
        .catch(error => console.error(`[Live2D] Background motion execution failed for ${id}:`, error));
      motionPromises.push(promise);
    }
    if (forceStep && motionPromises.length > 0) await Promise.all(motionPromises);

    let deltaInMs = dt;
    if (!this.shouldUpdate && !forceStep) deltaInMs = 0.0001;
    const shouldStepModels = deltaInMs > 0;
    deltaInMs = shouldStepModels ? Math.min(50, Math.max(0.001, deltaInMs)) : 0;

    if (!sharedClockLocked && this.jumpingCharacters.size === 0 && manualTimeMs === undefined) {
      advanceLive2DStageClock(deltaInMs);
    }

    const scriptEngine = this.callbacks.getScriptEngine();
    for (const entry of this.characters.values()) {
      const capabilities = getLive2DRuntimeCapabilities(entry);
      if (sharedClockLocked && !capabilities.supportsMotion) continue;
      if (!entry.model) continue;
      let runtime = getBoundRuntimeHandle(entry);
      if (!runtime || runtime.frame.shouldDeferPreview()) continue;
      if (entry.filterWarmupFrames && entry.filterWarmupFrames > 0 && !scriptEngine?.isReconstructing) {
        entry.filterWarmupFrames = Math.max(0, entry.filterWarmupFrames - 1);
      }

      if (entry.isCorrupted || entry.corruptionRepairPromise) {
        await this.callbacks.repairCorruptedModel(entry, 'previous invalid state', forceStep);
      } else {
        const invalidBeforeUpdate = this.callbacks.describeInvalidModelState(entry);
        if (invalidBeforeUpdate) await this.callbacks.repairCorruptedModel(entry, invalidBeforeUpdate, forceStep);
      }
      if (!entry.model) continue;
      runtime = getBoundRuntimeHandle(entry);
      if (!runtime || runtime.frame.shouldDeferPreview()) continue;

      if (!entry.isCorrupted) {
        try {
          if (manualTimeMs !== undefined) entry.lastManualTimeMs = manualTimeMs;
          if (entry.customMotion) {
            this.callbacks.maybeInstallCustomMotionStage(entry);
            entry.customMotionStage?.setSceneTime(this.callbacks.resolveCustomMotionSceneTime(entry, manualTimeMs));
          }
          const boundarySnapshot = entry.pendingSeekBoundarySnapshot;
          if (boundarySnapshot && manualTimeMs === undefined) {
            entry.pendingSeekBoundarySnapshot = undefined;
            entry.pendingSeekBoundaryMotionStartTime = undefined;
            entry.pendingSeekBoundaryDuration = undefined;
          }

          const freezeNativeMotion = !this.shouldUpdate
            && !forceStep
            && capabilities.evaluatesPoseOnZeroDelta;
          // Cubism 3+ evaluates cached motion writers and native queues inside
          // update(), including at delta 0. A forced seek flush must commit
          // that pose before rendering without advancing the paused clock.
          const commitNativeSeek = forceStep
            && manualTimeMs !== undefined
            && capabilities.evaluatesPoseOnZeroDelta;
          const injectedParameters = entry.injectedParams;
          if (!entry.customMotionStage && entry.customMotion && entry.customMotionHandoff) {
            const sceneTime = this.callbacks.resolveCustomMotionSceneTime(entry, manualTimeMs);
            const evaluation = evaluateCustomMotionRuntime(
              entry.customMotion.motion,
              entry.customMotion.startSceneTime,
              sceneTime,
              entry.customMotionHandoff,
            );
            applyCustomMotionValues(
              entry.injectedParams,
              entry.customMotion.controlledParameterIds,
              evaluation.values,
              entry.lipSyncParameterIds,
            );
          }

          const frameResult = runtime.frame.submit({
            deltaMs: deltaInMs,
            shouldAdvance: (shouldStepModels || commitNativeSeek) && !freezeNativeMotion,
            forceZeroDeltaCommit: commitNativeSeek,
            forceStep,
            manualTimeMs,
            injectedParameters,
            handoffBoundarySnapshot: manualTimeMs === undefined ? null : boundarySnapshot,
            isCurrent: () => this.characters.get(entry.id) === entry && entry.model === runtime.displayObject,
          });
          if (boundarySnapshot && frameResult.status === 'submitted' && !frameResult.retainedHandoffBoundary) {
            entry.pendingSeekBoundarySnapshot = undefined;
            entry.pendingSeekBoundaryMotionStartTime = undefined;
            entry.pendingSeekBoundaryDuration = undefined;
          }

          const invalidAfterUpdate = this.callbacks.describeInvalidModelState(entry);
          if (invalidAfterUpdate) await this.callbacks.repairCorruptedModel(entry, invalidAfterUpdate, forceStep);
        } catch {
          // Keep the existing per-character isolation: one SDK failure must not stop the frame.
        }
      }

      if (entry.isCorrupted) continue;

      if (entry.pendingLipSyncRelease && entry.pendingLipSyncRelease.size > 0) {
        for (const parameterId of entry.pendingLipSyncRelease) delete entry.injectedParams[parameterId];
        entry.pendingLipSyncRelease.clear();
      }
    }

    for (const container of this.containers.values()) {
      const filteredContainer = container as PIXI.Container & { _filtersDirty?: boolean };
      if (filteredContainer._filtersDirty) {
        filteredContainer._filtersDirty = false;
        container.filters = container.filters ? [...container.filters] : null;
      }
    }
  }

  clear(): void {
    this.stageEpoch++;
    for (const id of this.getCharacterIds()) this.removeCharacter(id);
    this.resources.clear();
    // Containers can exist before a model enters (timeline transform targets).
    for (const [id, container] of this.containers) this.destroyContainer(id, container);
    this.pendingMotions.clear();
    this.pendingConfigs.clear();
    this.pendingIntents.clear();
    this.pendingRimLightCommands.clear();
    this.pendingRimLightStates.clear();
    this.motionMutex.clear();
    this.hardResetMutex.clear();
    this.characterGenerations.clear();
    this.activeMotionLoads.clear();
    this.jumpingCharacters.clear();
    this.pendingMotionCount = 0;
  }
}
