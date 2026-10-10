/**
 * AeonStagery — Script Engine & Timeline Sequencer
 * Created by White_AE
 *
 * Executes projected scene scripts as linear timelines.
 * All actions are scheduled on a GSAP master timeline for frame-precise playback.
 */

import gsap from 'gsap';
import { stageManager } from './StageManager';
import { live2DManager } from './Live2DManager';
import { ModelSnapshot } from './Live2DConfig';
import { lipSyncEngine } from './LipSyncEngine';
import { subtitleRenderer } from './SubtitleRenderer';
import { lightingSystem } from './LightingSystem';
import { customAnimHost } from './CustomAnimHost';
import { textLayerManager } from './TextLayerManager';
import { cameraController } from './CameraController';
import { hookSystem } from '../api/hooks';
import { eventBus } from '../api/events';
import type { RuntimeTimelineAction, RuntimeTimelineScene } from './RuntimeTimelineScene';
import type { PreparedCompiledScene } from '../api/types/semantic-scene';
import type { CameraState } from '../api/types/camera';
import { resolveVec2 } from './utils/math';
import { computeSceneStateAtTime } from './RuntimeSceneState';
import { getLogger } from './Logger';
import { seekProfiler } from './SeekProfiler';
import { motionCurveCache } from './live2d/motionCurveCache';
import { actionSchedulers } from './actions';
import { scheduleSetBGM } from './actions/audioActions';
import type { TransformationProxy } from './actions/types';
import type { RimLightStyleState } from '../api/types/visual';
import { SnapshotStore } from './SnapshotStore';
import { preBakeDaemon } from './daemons/PreBakeDaemon';
import { CameraCoordinator } from './coordinators/CameraCoordinator';
import type { CameraStateResolverDeps } from './CameraStateResolver';
import { createStageAnchorResolver } from './cameraAnchorResolver';
import { CharacterSynchronizer } from './coordinators/CharacterSynchronizer';
import { DialogueCoordinator } from './coordinators/DialogueCoordinator';
import { AudioCoordinator } from './coordinators/AudioCoordinator';
import { ProxyRegistry } from './coordinators/ProxyRegistry';
import { resolveVisualLightingOverlay } from './visual-runtime/VisualRuntimeResolver';
import { sceneRequiresVisualSync } from './visual-runtime/visualSyncPolicy';
import { objectCompositeRuntimeController } from './visual-runtime/ObjectCompositeRuntimeController';
import { resolveVisualStateAtTime } from '../services/visual-authoring/VisualStateResolver';
import { BACKGROUND_LAYER_ID, type EnvironmentLayerRenderState } from './environmentLayerModel';
import { toEnvironmentRenderPlan } from './EnvironmentLayerRuntime';
import { preparedSceneToRuntimeTimelineScene } from './PreparedRuntimeScene';

class ScriptEngine {
  private logger = getLogger('ScriptEngine');
  private environmentPlaybackErrors = new Map<string, string>();
  public isReconstructing = false;
  private masterTimeline: gsap.core.Timeline | null = null;
  private currentScene: RuntimeTimelineScene | null = null;
  private currentSceneDurationOverride: number | undefined;
  /** Per-action content signatures of `currentScene` (one JSON round trip per
   * action, computed on load) — the sound diff base for the next reload. */
  private currentSceneActionSignatures: Map<RuntimeTimelineAction['_id'], string> | null = null;
  /** Signature of the non-action scene header fields (meta/audio/visual). */
  private currentSceneAuxSignature: string | null = null;
  private playing = false;
  private basePath = '';
  private _seekVersion = 0;
  private _isSeeking = false;
  private _pendingSeek: { time: number; forceReconstruct: boolean; suppressSeekSideEffects: boolean; resolve: () => void; reject: (err: any) => void } | null = null;
  public transformationProxies = new ProxyRegistry();
  private loopStart: number = 0;
  private loopEnd: number = 0;
  private loopEnabled: boolean = false;
  private isSilent = false;
  private backgroundProxy: TransformationProxy = { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, z: 0 };
  private environmentLayerProxies = new Map<string, TransformationProxy>();
  /** Unified snapshot storage — shared between real-time capture and pre-bake daemon */
  private snapshotStore = new SnapshotStore();
  private lastSnapshotTime: number = -1;

  private cameraCoordinator = new CameraCoordinator(cameraController);
  private characterSynchronizer = new CharacterSynchronizer(live2DManager);
  private dialogueCoordinator = new DialogueCoordinator(subtitleRenderer, lipSyncEngine);
  private audioCoordinator = new AudioCoordinator(() => lipSyncEngine.resumeAudioDrivenSyncs());
  private _timeCallbacks = new Set<(time: number) => void>();
  private _pauseCallbacks = new Set<(time: number) => void>();
  private _playingCallbacks = new Set<(playing: boolean) => void>();
  private _seekCompleteCallbacks = new Set<(time: number) => void>();
  private lastVisualOverlayKey: string | null = null;
  private readonly live2DTransformSync = () => {
    this.syncLive2DTransformsFromTimeline();
  };

  constructor() {
    live2DManager.setScriptEngine(this);
  }

  setSilentMode(silent: boolean): void {
    this.isSilent = silent;
    this.logger.info(`Silent mode: ${silent ? 'ON' : 'OFF'}`);
  }

  isPlaying(): boolean { return this.playing; }
  getCurrentTime(): number { return this.masterTimeline?.time() ?? 0; }
  getDuration(): number { return this.masterTimeline?.duration() ?? 0; }
  getMasterTimeline(): gsap.core.Timeline | null { return this.masterTimeline; }
  getCurrentCamera(): CameraState {
    return cameraController.getState();
  }
  setBasePath(path: string): void { this.basePath = path; }
  getBasePath(): string { return this.basePath; }

  onTimeUpdate(callback: (time: number) => void): () => void {
    this._timeCallbacks.add(callback);
    return () => this._timeCallbacks.delete(callback);
  }

  onPause(callback: (time: number) => void): () => void {
    this._pauseCallbacks.add(callback);
    return () => this._pauseCallbacks.delete(callback);
  }

  onPlayingChange(callback: (playing: boolean) => void): () => void {
    this._playingCallbacks.add(callback);
    return () => { this._playingCallbacks.delete(callback); };
  }

  private setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    this._playingCallbacks.forEach(callback => callback(playing));
  }

  onSeekComplete(callback: (time: number) => void): () => void {
    this._seekCompleteCallbacks.add(callback);
    return () => this._seekCompleteCallbacks.delete(callback);
  }

  previewTransform(id: string, updates: Partial<TransformationProxy>): void {
    const proxy = this.transformationProxies.get(id);
    if (!proxy) return;
    Object.assign(proxy, updates);
    if (live2DManager.hasCharacter(id)) {
      const cam = cameraController.getState();
      live2DManager.currentCamera = cam;
      live2DManager.applyProxyTransform(id, proxy, undefined, cam);
    }
  }

  setLoopRegion(start: number, end: number): void {
    const dur = this.getDuration();
    this.loopStart = Math.max(0, Math.min(start, dur));
    this.loopEnd = Math.max(this.loopStart + 0.1, Math.min(end, dur || 999));
  }

  setLoopEnabled(enabled: boolean): void {
    this.loopEnabled = enabled;
  }

  setPlaybackSpeed(speed: number): void {
    if (this.masterTimeline) {
      this.masterTimeline.timeScale(speed);
    }
  }

  async loadPreparedScene(scene: PreparedCompiledScene): Promise<void> {
    try {
      await subtitleRenderer.preloadPreparedScene(scene);
    } catch (error) {
      // Dialogue images and fonts are optional presentation resources. Their
      // preload failure should not reject the document projection; the scene
      // can still commit and use runtime fallbacks for the missing resource.
      this.logger.warn(`Failed to preload dialogue resources for scene "${scene.sceneId}"; continuing projection: ${String(error)}`);
    }
    try {
      await this.loadRuntimeScene(preparedSceneToRuntimeTimelineScene(scene), scene);
    } catch (error) {
      // A projection can fail after the incoming scene has populated these
      // diff caches. Clear both runtime state and identity caches so a
      // coordinator rollback is never mistaken for an unchanged reload.
      this.resetAfterProjectionFailure();
      throw error;
    }
  }

  private resetAfterProjectionFailure(): void {
    try {
      this.cleanup(true);
    } catch (cleanupError) {
      this.logger.warn(`Failed to fully clean up after scene projection failure: ${String(cleanupError)}`);
    }
    this.currentScene = null;
    this.currentSceneActionSignatures = null;
    this.currentSceneAuxSignature = null;
    this.currentSceneDurationOverride = undefined;
  }

  private async loadRuntimeScene(
    compiledScript: RuntimeTimelineScene,
    preparedScene: PreparedCompiledScene,
  ): Promise<void> {
    const durationOverride = preparedScene.durationSeconds;
    const previousScene = this.currentScene;
    const isSameScene = previousScene?.sceneId === compiledScript.sceneId;

    // Single-pass diff: one JSON round trip per incoming action builds the
    // signature map that serves BOTH the content-identity skip check and the
    // earliest edit point (snapshot invalidation). Previously this cost two
    // full-scene serializations per commit (deep-compare + per-action pairs).
    // Keys are `_id`, which the prepared-scene converter always populates and
    // is assumed unique per timeline (see RuntimeTimelineAction).
    const signatures = new Map<RuntimeTimelineAction['_id'], string>();
    for (const action of compiledScript.timeline) {
      signatures.set(action._id, JSON.stringify(action));
    }
    let changedActionCount = 0;
    let invalidationTime = 0;
    if (previousScene && isSameScene) {
      invalidationTime = Number.MAX_VALUE;
      const oldMap = new Map(previousScene.timeline.map(action => [action._id, action]));
      const previousSignatures = this.currentSceneActionSignatures;
      for (const action of compiledScript.timeline) {
        const old = oldMap.get(action._id);
        if (!old || previousSignatures?.get(action._id) !== signatures.get(action._id)) {
          changedActionCount++;
          invalidationTime = Math.min(
            invalidationTime,
            action.time || 0,
            old ? (old.time || 0) : Number.MAX_VALUE,
          );
        }
      }
      for (const old of previousScene.timeline) {
        if (!signatures.has(old._id)) {
          changedActionCount++;
          invalidationTime = Math.min(invalidationTime, old.time || 0);
        }
      }
      if (invalidationTime === Number.MAX_VALUE) invalidationTime = 0;
      // Deduct a tiny margin to ensure we don't keep a snapshot taken at the
      // exact millisecond of the edit.
      invalidationTime = Math.max(0, invalidationTime - 0.001);
    }

    // Critical: skip the reload when the projected content is unchanged. The
    // signature diff covers every action; the aux signature covers the scene
    // header fields (meta/audio/visual) that are not part of any action.
    if (
      isSameScene
      && previousScene !== null
      && this.currentSceneDurationOverride === durationOverride
      && this.currentSceneAuxSignature === sceneAuxSignature(compiledScript)
      && changedActionCount === 0
      && previousScene.timeline.length === compiledScript.timeline.length
    ) {
      this.logger.info('Scene content identical, skipping reload.');
      return;
    }

    const oldTime = this.getCurrentTime();
    const wasPlaying = this.playing;

    this.currentScene = compiledScript;
    this.currentSceneActionSignatures = signatures;
    this.currentSceneAuxSignature = sceneAuxSignature(compiledScript);
    this.currentSceneDurationOverride = durationOverride;
    // Full cleanup if SceneID changed; soft cleanup otherwise (retain models for speed)
    this.cleanup(!isSameScene, invalidationTime);
    this.initMasterTimeline(compiledScript, durationOverride);

    // Entrance tweens are timeline-driven, but addCharacter model creation is async.
    // Warm the Live2D instances before the first seek/play so the first visible
    // entrance frame is controlled by the proxy tween instead of model load time.
    await this.prewarmModels();

    // Restore state for the editor. Incomplete image drafts are a script
    // diagnostic, not a runtime failure, so the seek path simply skips them.
    // A light seek suffices here: soft cleanup retained the loaded models and
    // _doSeek auto-upgrades to a full reconstruct when the character set or a
    // model resource actually changed.
    await this.seek(oldTime, false);

    // Background curve-cache pre-warm AFTER the initial seek: it is that seek's
    // addCharacter pass which creates the sampled model entries, so running
    // here (instead of before the seek) is what makes the warm-up effective on
    // a fresh project open. Sampling is best-effort and never blocks the first
    // seek; a not-yet-cached key is covered by the seek-side ensure in
    // CharacterSynchronizer and otherwise keeps the SDK path (ADR-0033).
    void this.prewarmMotionCurves(compiledScript);

    if (wasPlaying) {
      this.play();
    }

    // Attach PreBakeDaemon — it handles all background snapshot scheduling
    preBakeDaemon.attach(
      this.snapshotStore,
      preparedScene,
    );
    // Start with a cold scan to establish baseline coverage
    preBakeDaemon.triggerColdScan();

    hookSystem.execute('scene:load', { sceneId: compiledScript.sceneId });
  }



  private initMasterTimeline(script: RuntimeTimelineScene, durationOverride?: number): void {
    if (this.masterTimeline) this.masterTimeline.kill();

    // ─── Soft reset active states when rebuilding the timeline ───
    // Dialogue/audio/lip-sync/custom-anim/camera state was already reset by
    // cleanup() immediately before this call; only the render-layer states
    // that cleanup intentionally leaves alone are reset here. Image sprites
    // are NOT cleared (the seek reconciliation diffs them), so a same-scene
    // reload never flashes the stage empty.
    subtitleRenderer.clear();
    textLayerManager.clearAll();

    this.masterTimeline = gsap.timeline({
      paused: true,
      onComplete: () => {
        this.setPlaying(false);
        const time = this.getCurrentTime();
        this._pauseCallbacks.forEach((cb) => cb(time));
        hookSystem.execute('scene:end', { sceneId: script.sceneId });
        eventBus.emit('scene:end');
        // PreBakeDaemon auto-resumes via scene:end event listener
      },
      onUpdate: () => {
        const cam = this.syncLive2DTransformsFromTimeline();
        const time = this.masterTimeline?.time() ?? 0;
        const stateAtTime = this.isReconstructing ? null : this.computeStateAtTime(time);
        if (stateAtTime) {
          void this.syncEnvironmentLayers(stateAtTime.environmentLayers, cam, false).catch((error) => {
            this.logger.error('Failed to reconcile environment playback:', error);
          });
        }
        this.syncLightingState(time);
        this.syncVisualState(time);
        stageManager.updateImages(cam);

        const currentTime = time;
        // Audio is driven by the master timeline on every update so fades,
        // stops, pause, and seeks all use the same interval reconstruction.
        this.audioCoordinator.sync(currentTime, this.playing && !this.isSilent);

        if (this.isSilent) return;

        this._timeCallbacks.forEach(cb => cb(time));

        if (!stateAtTime) return;

        // ── DIALOGUE SYNC ──
        const dialogueState = stateAtTime.dialogue;
        live2DManager.syncLookAtFollows?.(stateAtTime.characters);
        this.dialogueCoordinator.sync(
          currentTime,
          dialogueState as any,
          false,
          (src: string) => this.createRuntimeAudio(src),
          (p: string) => this.resolvePathAsync(p),
          (voiceKey, audio, startTime, duration) => {
            this.audioCoordinator.scheduleAudio(voiceKey, audio, startTime, duration);
            this.audioCoordinator.sync(currentTime, this.playing);
          },
          stateAtTime.dialogueVisible,
          stateAtTime.dialogueOpacity,
        );

        // Only take incremental snapshots when no cached snapshot exists at this time
        if (!this.snapshotStore.hasAt(currentTime, 0.05) && (currentTime - this.lastSnapshotTime >= 0.1)) {
          this.takeSnapshot(currentTime);
        }

        // A/B Loop region: loop playback between markers
        if (this.loopEnabled && this.playing && this.loopEnd > this.loopStart) {
          if (currentTime >= this.loopEnd) {
            this.masterTimeline?.seek(this.loopStart, false);
          }
        }
      },
    });

    this.transformationProxies.clear();
    this.backgroundProxy = { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, z: 0 };
    this.environmentLayerProxies.clear();
    this.environmentLayerProxies.set(BACKGROUND_LAYER_ID, this.backgroundProxy);

    // Camera state was reset by cleanup() before this timeline rebuild so the
    // .to() tweens have correct "from" values.
    const charIds = new Set<string>();
    script.meta.characters?.forEach(c => charIds.add(c.id));
    script.timeline.forEach(a => { 
      if ((a as any).params?.id) charIds.add((a as any).params.id); 
      if ((a as any).params?.characterId) charIds.add((a as any).params.characterId);
      if ((a as any).params?.targetCharacter) charIds.add((a as any).params.targetCharacter);
    });
    for (const id of charIds) {
      this.transformationProxies.set(id, { x: 960, y: 540, scale: 1, rotation: 0, opacity: 1, z: 0 });
    }

    for (const action of script.timeline) {
      if (action.action === 'addCharacter' && action.params?.id) {
        const proxy = this.transformationProxies.get(action.params.id);
        if (proxy) {
          if (action.params.position) {
            const pos = resolveVec2(action.params.position);
            proxy.x = pos.x * 1920; proxy.y = pos.y * 1080;
          }
          if (action.params.scale !== undefined) proxy.scale = action.params.scale;
          if (action.params.rotation !== undefined) proxy.rotation = action.params.rotation;

          const hasEntrance = action.params.enter !== 'none' && (
            (action.params.enter && action.params.enter !== 'none') ||
            action.params.duration !== undefined ||
            action.params.enterDuration !== undefined
          );
          if (hasEntrance) {
            proxy.opacity = 0;
          } else {
            proxy.opacity = action.params.opacity ?? 1;
          }
        }
      }
    }

    for (const action of script.timeline) this.scheduleAction(action);

    // Guarantee the GSAP timeline spans the full scene.
    // Some actions (like 'wait') are pure timing markers with no scheduler.
    // Without an explicit duration GSAP may truncate the timeline to the last
    // scheduled child, dropping all trailing time.
    const actionEnd = script.timeline
      .map(a => (a.time || 0) + (a.params.duration || 0))
      .reduce((max, v) => Math.max(max, v), 0);
    const sceneEnd = Math.max(actionEnd, durationOverride ?? 0);
    if (sceneEnd > 0) {
      this.masterTimeline.to({}, { duration: 0.001 }, sceneEnd);
    }

    // Scene-level BGM is a fallback — skip if timeline has setBGM actions
    const hasTimelineBGM = script.timeline.some(a => a.action === 'setBGM');
    if (script.audio?.bgm && !hasTimelineBGM) this.setupBGM(script.audio.bgm);
  }

  private scheduleAction(action: RuntimeTimelineAction): void {
    if (!this.masterTimeline) return;

    const scheduler = actionSchedulers[action.action];
    if (scheduler) {
      try {
        scheduler(this.getSchedulerContext(), action);
      } catch (err) {
        this.logger.error(`Failed to schedule action "${action.action}" at time=${action.time}:`, err);
        // Don't let one bad action block the entire timeline
      }
    } else {
      this.logger.warn(`Unknown action: ${action.action}`);
    }
  }

  private getSchedulerContext() {
    return {
      tl: this.masterTimeline!,
      resolvePath: (p: string) => this.resolvePath(p),
      resolvePathAsync: (p: string) => this.resolvePathAsync(p),
      transformationProxies: this.transformationProxies,
      environmentLayerProxies: this.environmentLayerProxies,
      backgroundProxy: this.backgroundProxy,
      isReconstructing: () => this.isReconstructing,
      environmentStateDriven: true,
      isPlaying: () => this.playing,
      audioElements: {
        set: (key: string, entry: { audio: HTMLAudioElement; startTime: number; duration: number }) =>
          this.audioCoordinator.scheduleAudio(key, entry.audio, entry.startTime, entry.duration),
        get: (key: string) => {
          const item = this.audioCoordinator.getEntries().get(key);
          return item ? { audio: item.audio, startTime: item.startTime, duration: item.duration } : undefined;
        },
        delete: (key: string) => {
          const item = this.audioCoordinator.getEntries().get(key);
          if (item) {
            item.audio.pause();
            this.audioCoordinator.getEntries().delete(key);
            return true;
          }
          return false;
        },
        clear: () => this.audioCoordinator.clear(),
        values: () => Array.from(this.audioCoordinator.getEntries().values()),
      } as any,
      takeSnapshot: (t: number) => this.takeSnapshot(t),
      getCurrentTime: () => this.getCurrentTime(),
      getCharacterMeta: (id: string) => this.currentScene?.meta.characters?.find(c => c.id === id),
      getRimLightBaseline: (id: string): RimLightStyleState | undefined =>
        this.currentScene?.visual?.visualTargets?.[id]?.rimLightBaseline,
    };
  }

  private setupBGM(bgm: any): void {
    if (!this.masterTimeline) return;
    // Legacy scene-level BGM has no semantic action to compile, but it can
    // still use the same resolver, interval metadata, and linear envelope as
    // a timeline setBGM action.
    scheduleSetBGM(this.getSchedulerContext(), { time: 0, params: bgm });
  }

  play(): void {
    if (!this.masterTimeline) return;

    // PreBakeDaemon listens for 'scene:play' and auto-suspends all baking
    this.setPlaying(true); live2DManager.setAutoUpdate(true);
    gsap.ticker.remove(this.live2DTransformSync);
    gsap.ticker.add(this.live2DTransformSync);
    this.masterTimeline.play();
    if (typeof (customAnimHost as any).resume === 'function') {
      (customAnimHost as any).resume();
    }
    for (const data of this.audioCoordinator.getEntries().values()) data.audio.play().catch(() => { });
    live2DManager.resumeAllTweens(); eventBus.emit('scene:play');
  }

  pause(): void {
    this.setPlaying(false); live2DManager.setAutoUpdate(false); live2DManager.pauseAllTweens();
    gsap.ticker.remove(this.live2DTransformSync);
    this.masterTimeline?.pause();
    if (typeof (customAnimHost as any).pause === 'function') {
      (customAnimHost as any).pause();
    }
    for (const data of this.audioCoordinator.getEntries().values()) data.audio.pause();
    const time = this.getCurrentTime();
    this._pauseCallbacks.forEach((cb) => cb(time));
    eventBus.emit('scene:pause');
    // PreBakeDaemon listens for 'scene:pause' and auto-resumes baking
  }

  private pauseForSeek({ emitLifecycle }: { emitLifecycle: boolean }): void {
    this.setPlaying(false);
    live2DManager.setAutoUpdate(false);
    live2DManager.pauseAllTweens();
    gsap.ticker.remove(this.live2DTransformSync);
    this.masterTimeline?.pause();
    if (typeof (customAnimHost as any).pause === 'function') {
      (customAnimHost as any).pause();
    }
    for (const data of this.audioCoordinator.getEntries().values()) data.audio.pause();

    if (!emitLifecycle) {
      return;
    }

    const time = this.getCurrentTime();
    this._pauseCallbacks.forEach((cb) => cb(time));
    eventBus.emit('scene:pause');
  }

  private syncLive2DTransformsFromTimeline(): { position: any; zoom: number } {
    const cam = cameraController.getState();
    live2DManager.currentCamera = cam;

    this.transformationProxies.forEach((proxy, id) => {
      if (live2DManager.hasCharacter(id)) {
        live2DManager.applyProxyTransform(id, proxy, undefined, cam);
      }
    });

    return cam;
  }



  private takeSnapshot(time: number): void {
    const charIds = live2DManager.listCharacters();
    if (charIds.length === 0) return;
    const models = new Map<string, ModelSnapshot>();

    for (const id of charIds) {
      const snap = live2DManager.captureSnapshot(id);
      if (!snap) continue;
      models.set(id, snap);
    }

    // DEBUG: checksum snapshots to track parameter corruption across seeks
    if (models.size > 0 && Math.round(time * 10) % 10 === 0) {
      const parts: string[] = [];
      for (const [id, snap] of models) {
        let sum = 0, nonZero = 0;
        for (let i = 0; i < Math.min(snap.params.length, 30); i++) { sum += Math.abs(snap.params[i]); if (snap.params[i] !== 0) nonZero++; }
        parts.push(`${id}:cs=${sum.toFixed(3)} nz=${nonZero} m=${snap.motion?.key ?? 'none'}`);
      }
      this.logger.trace(`take @ ${time.toFixed(3)}s | ${parts.join(' | ')}`, `color: #0af;`);
    }

    if (models.size > 0) {
      // Delegate to SnapshotStore — handles dedup, ordering, and capacity
      this.snapshotStore.insert(time, models);
      this.lastSnapshotTime = time;
    }
  }

  async seek(time: number, forceReconstruct: boolean = true): Promise<void> {
    const suppressSeekSideEffects = forceReconstruct === false;
    if (this._isSeeking) {
      return new Promise((resolve, reject) => {
        if (this._pendingSeek) {
          // Scrubbing intentionally coalesces queued seeks. A request that is
          // replaced will not run, so cancellation is a successful settlement
          // rather than a runtime failure for fire-and-forget UI callers.
          this._pendingSeek.resolve();
        }
        this._pendingSeek = { time, forceReconstruct, suppressSeekSideEffects, resolve, reject };
      });
    }

    this._isSeeking = true;
    try {
      await this._doSeek(time, forceReconstruct, suppressSeekSideEffects);

      while (this._pendingSeek) {
        const next = this._pendingSeek;
        this._pendingSeek = null;
        try {
          await this._doSeek(next.time, next.forceReconstruct, next.suppressSeekSideEffects);
          next.resolve();
        } catch (err) {
          next.reject(err);
          this.rejectPendingSeek(err);
          throw err;
        }
      }
    } catch (error) {
      // A failed materialization must settle the active seek and every queued
      // seek. Leaving _pendingSeek in place here strands callers forever.
      this.rejectPendingSeek(error);
      throw error;
    } finally {
      this._isSeeking = false;
    }
  }

  private rejectPendingSeek(error: unknown): void {
    const pending = this._pendingSeek;
    this._pendingSeek = null;
    pending?.reject(error);
  }

  private async _doSeek(time: number, forceReconstruct: boolean, suppressSeekSideEffects: boolean): Promise<void> {
    if (!this.masterTimeline) return;

    const seekVersion = ++this._seekVersion;
    const wasPlaying = this.playing;
    eventBus.emit('scene:seek:start', { time });

    // 核心优化：即使外部请求了 forceReconstruct = false，
    // 如果我们检测到目标时间点 desired 角色集合与当前已加载角色集合不一致，
    // 我们必须自动提升为 forceReconstruct = true，以确保角色能正确登场/退场！
    // 集合一致还不够：同一 id 的模型资源若已更换（重选模型/换变体），
    // 也必须重载，否则轻 seek 会一直渲染旧模型。
    if (!forceReconstruct) {
      const { characters: desiredChars } = this.computeStateAtTime(time);
      let needsReconstruct = false;
      for (const [id, charState] of desiredChars) {
        if (!live2DManager.hasCharacter(id)) { needsReconstruct = true; break; }
        if (typeof charState.model === 'string' && charState.model.trim()) {
          try {
            const desiredPath = await this.resolvePathAsync(charState.model);
            if (!live2DManager.matchesLoadedModel?.(id, desiredPath)) {
              needsReconstruct = true;
              break;
            }
          } catch {
            // Resolution failures are surfaced on the reconstruct path.
            needsReconstruct = true;
            break;
          }
        }
      }
      if (!needsReconstruct) {
        for (const id of live2DManager.listCharacters()) {
          if (!desiredChars.has(id)) { needsReconstruct = true; break; }
        }
      }
      if (needsReconstruct) {
        forceReconstruct = true;
      }
    }

    seekProfiler.startSeek({ time, forceReconstruct });

    try {
      if (forceReconstruct) {
        this.logger.trace(`═══ SEEK to ${time.toFixed(3)}s forceReconstruct=${forceReconstruct} ═══`, 'color: #ff0; font-weight: bold;');
        const storeRange = this.snapshotStore.timeRange;
        this.logger.trace(`snapshotStore range: [${storeRange?.min.toFixed(3) ?? 'N/A'} .. ${storeRange?.max.toFixed(3) ?? 'N/A'}] count=${this.snapshotStore.size}`, 'color: #fff');
      }
      this.pauseForSeek({ emitLifecycle: !suppressSeekSideEffects });

      if (forceReconstruct) {
        this.isReconstructing = true;

        // Evaluate timeline-owned camera/proxy values before asynchronous model
        // creation. The first visible frame must use the same camera that the
        // post-load synchronization pass will use.
        this.masterTimeline.seek(time, true);
        this.cameraCoordinator.sync(time, this.currentScene?.timeline ?? [], this.buildCameraResolverDeps(time));
        live2DManager.currentCamera = cameraController.getState();

        // ─── Maginot Line: All Character asset load must completely finish first ───
        // A missing or unresolvable model resource is a SCRIPT-level defect, not a
        // runtime failure: the prepared scene already unwraps unavailable refs to an
        // empty path (RuntimeAssetPreparer), and the validation panel flags the
        // statement. Like missing image layers, the character is DEGRADED — it stays
        // off stage while the rest of the scene projects. Throwing here would roll
        // the whole commit back, so under collaboration one bad peer-authored path
        // would reject every subsequent state change and stall the session.
        const modelLoadStart = performance.now();
        const { characters: desiredChars } = this.computeStateAtTime(time);
        const resolvedModelPaths = new Map<string, string>();
        await Promise.all(Array.from(desiredChars.entries()).map(async ([id, charState]) => {
          const model = typeof charState.model === 'string' ? charState.model.trim() : '';
          if (!model) {
            this.logger.warn(`Character "${id}" has no model resource; leaving it off stage. Choose a Live2D model to restore it.`);
            desiredChars.delete(id);
            return;
          }
          try {
            resolvedModelPaths.set(id, await this.resolvePathAsync(model));
          } catch (error) {
            this.logger.warn(`Character "${id}" model "${model}" could not be resolved; leaving it off stage: ${String(error)}`);
            desiredChars.delete(id);
          }
        }));
        for (const id of live2DManager.listCharacters()) {
          const desired = desiredChars.get(id);
          if (!desired) {
            live2DManager.removeCharacter(id);
          } else {
            // Character consistency check: reload if the model path changed
            const currentEntry = live2DManager.getAllCharacters().get(id);
            if (currentEntry && currentEntry.modelPath !== resolvedModelPaths.get(id)) {
              live2DManager.removeCharacter(id);
            }
          }
        }

        const addPromises: Promise<void>[] = [];
        for (const [id, charState] of desiredChars) {
          const proxy = this.transformationProxies.get(id);
          if (proxy) {
            if (charState.position !== undefined) {
              proxy.x = charState.position[0] * 1920;
              proxy.y = charState.position[1] * 1080;
            }
            if (charState.scale !== undefined) proxy.scale = charState.scale;
            if (charState.rotation !== undefined) proxy.rotation = charState.rotation;
            if (charState.opacity !== undefined) proxy.opacity = charState.opacity;
            if (charState.z !== undefined) proxy.z = charState.z;
          }
          if (!live2DManager.hasCharacter(id)) {
            addPromises.push(live2DManager.addCharacter(id, resolvedModelPaths.get(id)!, charState.config));
          }
        }

        if (addPromises.length > 0) {
          try {
            await Promise.all(addPromises);
          } catch (err) {
            this.logger.error('Failed to load models during seek:', err);
          }
        }
        seekProfiler.addTime('model-load', performance.now() - modelLoadStart);

        if (this._seekVersion !== seekVersion) {
          seekProfiler.cancel();
          return;
        }

        // ─── Phase 2: Orchestration state synchronization (Purely Synchronous) ───
        // Clear all dynamic triggers, play motion offsets, etc.
        // Purge first: every retained channel (SDK motion queue, expression,
        // injected-parameter replay, seek-boundary snapshot) writes a pose that
        // belongs to another scene time and would survive into the seeked frame.
        live2DManager.clearAllPendingMotions();
        live2DManager.purgeAllCharacterRuntimeState();
        this.masterTimeline.seek(time, true);

        objectCompositeRuntimeController.invalidateEnvironmentSamples();
        // skipHardReset=true keeps preserve-current motion startup on the
        // reconstruct seek (previously expressed via freezeVisibleMotionDuringSeek,
        // which was removed with the legacy forward-simulation path).
        await this.syncAllStates(time, true, false);
        if (this._seekVersion !== seekVersion) {
          seekProfiler.cancel();
          return;
        }

        this.isReconstructing = false;
        this.lastSnapshotTime = time;
        if (!this.playing && !this._pendingSeek) {
          this.logger.trace(`post-seek takeSnapshot @ ${time.toFixed(3)} (forceReconstruct)`, 'color: #f0f;');
          this.takeSnapshot(time);
        }
        this.logger.trace(`═══ SEEK DONE @ ${time.toFixed(3)}s ═══`, 'color: #ff0; font-weight: bold;');
      } else {
        this.masterTimeline.seek(time, true);
        // Light seek: no model rebuild, so the retained motion/expression
        // channels are the only thing that can carry a foreign pose into the
        // seeked frame (this is the path a scene edit takes). Purge before the
        // state sync rebuilds them from the target time.
        live2DManager.clearAllPendingMotions();
        live2DManager.purgeAllCharacterRuntimeState();
        await this.syncAllStates(time, true, true); // isScrubbing = true
        this.isReconstructing = false;
        this.lastSnapshotTime = time;
      }
    } finally {
      if (this._seekVersion === seekVersion) {
        this.isReconstructing = false;
      }
    }

    seekProfiler.finishSeek(live2DManager.listCharacters().length);

    if (this._pendingSeek) return;

    // Crucial race-condition fix: only set playing to false if we haven't clicked Play during seek
    if (this._seekVersion === seekVersion) {
      if (wasPlaying || this.playing) {
        this.play();
      } else {
        this.setPlaying(false);
        // 核心修复：响应用户的“全暂停”诉求。拖拽/Seek 结束后保持 Ticker 关闭，
        // 彻底冻结角色画面（包括呼吸眨眼 and 任何遗留动作），实现绝对的单帧定格。
        live2DManager.setAutoUpdate(false);
        live2DManager.pauseAllTweens();
      }
    }
    eventBus.emit('scene:seek:end', { time });
    if (suppressSeekSideEffects) {
      return;
    }

    hookSystem.execute('scene:seek', { time });
    this._seekCompleteCallbacks.forEach((cb) => cb(time));

    // Notify PreBakeDaemon of the new edit position so it can
    // re-prioritize baking around where the user is working
    if (!this.playing) {
      preBakeDaemon.notifyEditPosition(time);
    }
  }

  private computeStateAtTime(time: number) {
    return computeSceneStateAtTime(
      this.currentScene!,
      time,
      typeof live2DManager.getPoint === 'function'
        ? (id, part) => live2DManager.getPoint(id, part)
        : undefined,
    );
  }

  /**
   * Deterministic anchor source for camera state reconstruction. Playback
   * camera moves target live part anchors; reconstruction composes the
   * statement-derived position (valid at any time) with the part offset
   * measured from the current model state, so scrubbed framing matches
   * playback without depending on model transforms being current.
   */
  private buildCameraResolverDeps(time: number): CameraStateResolverDeps {
    const desiredCharacters = this.computeStateAtTime(time).characters;
    return {
      resolveCharacterPosition: createStageAnchorResolver({
        desiredPosition: (characterId) => {
          const desired = desiredCharacters.get(characterId);
          return desired?.position ? { x: desired.position[0], y: desired.position[1] } : null;
        },
        getPoint: (characterId, pointName) =>
          typeof live2DManager.getPoint === 'function'
            ? live2DManager.getPoint(characterId, pointName)
            : null,
        getPosition: (characterId) =>
          typeof live2DManager.getPosition === 'function'
            ? live2DManager.getPosition(characterId)
            : null,
      }),
      // Follow entry transient: capture the followed character's statement
      // position at the follow start so seek reconstruction decays from where
      // playback began gliding (body anchor — tickFollow() tracks getPosition).
      resolveCharacterPositionAtTime: (characterId, atTime) => {
        const desired = this.computeStateAtTime(atTime).characters.get(characterId);
        return desired?.position ? { x: desired.position[0], y: desired.position[1] } : null;
      },
    };
  }

  private resolveVisualLightingOverlayAtTime(time: number) {
    if (!sceneRequiresVisualSync(this.currentScene)) {
      return null;
    }
    const scene = this.currentScene;
    if (!scene) return null;
    const visualState = resolveVisualStateAtTime(scene, time);
    return resolveVisualLightingOverlay(visualState, scene);
  }

  private syncLightingState(time: number): void {
    const scene = this.currentScene;
    if (!scene) {
      lightingSystem.applySnapshot(lightingSystem.deriveLightingSnapshotAtTime(time, [], null));
      return;
    }
    const overlay = this.resolveVisualLightingOverlayAtTime(time);
    const snapshot = lightingSystem.deriveLightingSnapshotAtTime(time, scene.timeline, overlay);
    lightingSystem.applySnapshot(snapshot);
  }

  private syncVisualState(time: number): void {
    if (!sceneRequiresVisualSync(this.currentScene)) {
      if (this.lastVisualOverlayKey !== null) {
        this.lastVisualOverlayKey = null;
      }
      objectCompositeRuntimeController.clearAll(this.currentScene ?? null);
      return;
    }

    const scene = this.currentScene;
    if (!scene) return;
    const visualState = resolveVisualStateAtTime(scene, time);
    const overlay = resolveVisualLightingOverlay(visualState, scene);
    const nextKey = overlay ? JSON.stringify(overlay) : null;
    if (nextKey !== this.lastVisualOverlayKey) {
      this.lastVisualOverlayKey = nextKey;
    }
    objectCompositeRuntimeController.apply(scene, visualState, time);
  }

  private async syncEnvironmentLayers(
    environmentLayers: Map<string, EnvironmentLayerRenderState>,
    camera: Pick<CameraState, 'position' | 'zoom'>,
    syncProxies: boolean,
  ): Promise<void> {
    if (syncProxies) this.environmentPlaybackErrors.clear();
    const environmentRenderPlan = toEnvironmentRenderPlan({
      background: environmentLayers.get(BACKGROUND_LAYER_ID) ?? null,
      environmentLayers,
    });
    const activeLayerIds = new Set(environmentRenderPlan.entries.map((entry) => entry.layerId));
    for (const layerId of this.environmentLayerProxies.keys()) {
      if (!activeLayerIds.has(layerId)) {
        stageManager.clearEnvironmentLayer(layerId);
        this.environmentPlaybackErrors.delete(layerId);
      }
    }

    await Promise.all(environmentRenderPlan.entries.map((layerState) => {
      const layerId = layerState.layerId;
      const imageSignature = JSON.stringify(layerState.images.map((entry) => entry.image));
      // A missing resource should report once during playback, then retry on
      // an explicit seek or a different image rather than toast on every frame.
      if (!syncProxies && this.environmentPlaybackErrors.get(layerId) === imageSignature) return;
      const proxy = this.environmentLayerProxies.get(layerId) ?? {
        x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, z: 0,
      };
      // Keep the proxy identity: scheduled tweens still reference it when a
      // seek crosses a layer's entrance/removal and playback resumes.
      this.environmentLayerProxies.set(layerId, proxy);
      if (syncProxies) {
        if (layerState.x !== undefined) proxy.x = layerState.x;
        if (layerState.y !== undefined) proxy.y = layerState.y;
        if (layerState.scale !== undefined) proxy.scale = layerState.scale;
        if (layerState.rotation !== undefined) proxy.rotation = layerState.rotation;
        if (layerState.opacity !== undefined) proxy.opacity = layerState.opacity;
        if (layerState.z !== undefined) proxy.z = layerState.z;
      }
      return stageManager.renderEnvironmentLayer({
        ...layerState,
        ...proxy,
        images: layerState.images.map((entry) => ({
          ...entry,
          image: this.resolvePath(entry.image),
        })),
      }, camera).catch((error) => {
        if (syncProxies) throw error;
        if (this.environmentPlaybackErrors.get(layerId) !== imageSignature) {
          this.environmentPlaybackErrors.set(layerId, imageSignature);
          this.logger.error(`Failed to reconcile environment layer "${layerId}":`, error);
        }
      });
    }));
  }

  private async syncAllStates(
    time: number,
    skipHardReset: boolean = false,
    isScrubbing: boolean = false,
  ): Promise<void> {
    // 1. Reconcile Camera Controller & transform immediately
    if (this.currentScene) {
      this.cameraCoordinator.sync(time, this.currentScene.timeline, this.buildCameraResolverDeps(time));
    }
    const cam = cameraController.getState();
    live2DManager.currentCamera = cam;

    // 2. Reconcile non-character environment states
    if (this.currentScene) {
      live2DManager.reconcileRimLights(time, this.currentScene);
    }

    const {
      characters: desiredState,
      environmentLayers,
      dialogue: desiredDialogue,
      dialogueVisible,
      dialogueOpacity,
    } = this.computeStateAtTime(time);

    // 3. Apply the same absolute environment state used during playback.
    await this.syncEnvironmentLayers(environmentLayers, cam, true);

    // Environment target containers are created by renderEnvironmentLayer.
    // Reconcile after that awaited materialization so target-scoped filters are
    // applied in the same sync pass, even when character loading is delayed.
    if (this.currentScene) {
      this.syncLightingState(time);
    }

    // 3.5. Materialize image/text layers from the same absolute runtime state
    // used by seek/export.  Their GSAP callbacks are intentionally suppressed
    // during reconstruction, so relying on timeline onStart would leave a
    // middle-timestamp seek visually empty or stale.
    await this.syncGraphicLayers(time);

    // 4. Synchronize characters using CharacterSynchronizer
    // Convert desiredState Map values to DesiredCharState structure
    const desiredChars = new Map<string, any>();
    // The expression a seeked frame must fade *out of* is the one the scene had
    // in effect just before the target expression started. Resolving it from
    // the scene (instead of leaving it to the model's live state) keeps a
    // backwards seek from blending out of an expression that only exists later
    // in the timeline. Keyed by the target's start time: one state evaluation
    // per distinct expression start, not per character.
    const predecessors = resolveExpressionPredecessors(
      desiredState,
      (atTime) => this.computeStateAtTime(atTime).characters,
    );
    for (const [id, state] of desiredState) {
      const expression = state.expression
        ? { ...state.expression, previousKey: predecessors.get(id) ?? null }
        : state.expression;
      desiredChars.set(id, {
        id,
        model: state.model,
        config: state.config || {},
        lifecycleStartTime: state.lifecycleStartTime,
        position: state.position,
        scale: state.scale,
        rotation: state.rotation,
        opacity: state.opacity,
        motion: state.motion,
        expression,
        lookAt: state.lookAt,
        blink: state.blink,
        z: state.z,
      });
    }

    await this.characterSynchronizer.syncTo({
      time,
      desiredChars,
      transformationProxies: this.transformationProxies,
      snapshotStore: this.snapshotStore,
      shouldCancel: () => !!this._pendingSeek,
      skipHardReset,
      isScrubbing,
      fps: this.currentScene?.meta?.fps ?? 60,
      resolveStateAtTime: (atTime) => this.computeStateAtTime(atTime).characters,
    });

    if (this.currentScene) {
      this.syncLightingState(time);
      this.syncVisualState(time);
    }

    // 5. Synchronize dialogue (takes LipSync + schedules voice audio)
    this.dialogueCoordinator.sync(
      time,
      desiredDialogue as any,
      isScrubbing,
      (src) => this.createRuntimeAudio(src),
      (p) => this.resolvePathAsync(p),
      (voiceKey, audio, startTime, duration) => {
        this.audioCoordinator.scheduleAudio(voiceKey, audio, startTime, duration);
      },
      dialogueVisible,
      dialogueOpacity,
    );

    // 6. Synchronize active audios
    this.audioCoordinator.sync(time, this.playing);

    // Post-Sync camera transform adjustment
    cameraController.applyTransform();
  }

  private async syncGraphicLayers(time: number): Promise<void> {
    try {
      await this.syncGraphicLayersInternal(time);
    } catch (error) {
      // Invalidate before rethrowing. Other image promises from the failed
      // pass may still settle later; the new epoch prevents stale sprites from
      // attaching after a failed seek/export.
      const stageWithImageState = stageManager as typeof stageManager & {
        invalidateImageReconciliation?: () => void;
      };
      stageWithImageState.invalidateImageReconciliation?.();
      if (typeof (customAnimHost as any).clear === 'function') {
        (customAnimHost as any).clear();
      }
      throw error;
    }
  }

  private async syncGraphicLayersInternal(time: number): Promise<void> {
    if (!this.currentScene) return;

    const { images, textLayers } = this.computeStateAtTime(time);
    textLayerManager.reconcileLayers(textLayers);

    const customHost = customAnimHost as typeof customAnimHost & {
      reconcileAtTime?: (entries: ReadonlyArray<{
        key: string;
        file: string;
        duration: number;
        layer: any;
        elapsed: number;
        startTime: number;
      }>) => Promise<void>;
    };
    if (customHost.reconcileAtTime) {
      const activeCustomAnimations: Array<{
        key: string;
        file: string;
        duration: number;
        layer: any;
        elapsed: number;
        startTime: number;
      }> = [];
      for (let index = 0; index < this.currentScene.timeline.length; index += 1) {
        const action = this.currentScene.timeline[index];
        if (action.action !== 'playCustomAnimation') continue;
        const startTime = action.time || 0;
        const duration = Math.max(0, typeof action.params.duration === 'number' ? action.params.duration : 5);
        if (time < startTime || time >= startTime + duration) continue;
        const file = typeof action.params.file === 'string' ? action.params.file.trim() : '';
        if (!file) {
          // Unavailable resources (missing external library entries) unwrap to
          // an empty path: skip the layer and let diagnostics explain it —
          // playback, seek, and export must keep running over degraded media.
          this.logger.warn(`Skipping custom animation at ${startTime}s: resource unavailable`);
          continue;
        }
        try {
          activeCustomAnimations.push({
            key: action._id ?? `custom-animation-${index}`,
            file: await this.resolvePathAsync(file),
            duration,
            layer: action.params.layer ?? 'overlay',
            elapsed: Math.max(0, time - startTime),
            startTime,
          });
        } catch (error) {
          const message = `Failed to resolve custom animation asset "${file}": ${String(error)}. Choose an available animation resource and retry.`;
          this.logger.error(message, error);
          void eventBus.emit('toast:show', {
            id: `custom_asset_${Date.now()}_${index}`,
            message,
            type: 'error',
          });
          throw new Error(message);
        }
      }
      await customHost.reconcileAtTime(activeCustomAnimations);
    }

    const stageWithImageState = stageManager as typeof stageManager & {
      beginImageReconciliation?: (activeIds: ReadonlySet<string>) => number;
      getImageLoadError?: (id: string) => string | null;
      reportImageError?: (id: string | undefined, file: string, error: unknown) => string;
      materializeImage?: (config: {
        id: string;
        file: string;
        position?: [number, number] | { x: number; y: number };
        scale?: number;
        rotation?: number;
        opacity?: number;
        zIndex?: number;
        z?: number;
      }, epoch?: number) => Promise<unknown>;
      updateImages?: (camera: { position: any; zoom: number }) => void;
    };

    // Keep the existing lightweight mocks/host integrations usable while the
    // real StageManager supplies the full async image state seam.
    if (!stageWithImageState.beginImageReconciliation || !stageWithImageState.materializeImage) {
      return;
    }

    const validImages = new Map<string, any>();
    for (const [id, state] of images) {
      if (!state.file.trim()) {
        // Empty resource paths are authoring drafts. The validation daemon
        // reports them; runtime reconciliation leaves the layer absent.
        continue;
      }
      validImages.set(id, state);
    }

    const epoch = stageWithImageState.beginImageReconciliation(new Set(validImages.keys()));
    await Promise.all(Array.from(validImages.values()).map(async (state: any) => {
      try {
        const runtimeFile = await this.resolvePathAsync(state.file);
        const materialized = await stageWithImageState.materializeImage!({
          id: state.id,
          file: runtimeFile,
          position: state.position,
          scale: state.scale,
          rotation: state.rotation,
          opacity: state.opacity,
          zIndex: state.zIndex,
          z: state.z,
        }, epoch);
        if (!materialized) {
          throw new Error(
            stageWithImageState.getImageLoadError?.(state.id)
              ?? `Image layer "${state.id}" could not be materialized for seek/export. Choose an available image resource and retry.`,
          );
        }
      } catch (error) {
        if (!stageWithImageState.getImageLoadError?.(state.id)) {
          stageWithImageState.reportImageError?.(state.id, state.file, error);
        }
        this.logger.error(`Failed to materialize image layer "${state.id}": ${String(error)}`, error);
        throw error instanceof Error ? error : new Error(String(error));
      }
    }));

    stageWithImageState.updateImages?.(cameraController.getState());
  }

  private resolvePath(relativePath: string): string {
    if (!relativePath || relativePath.startsWith('asset://') || relativePath.startsWith('file://') || relativePath.startsWith('http')) return relativePath;
    if (relativePath.replace(/\\/g, '/').trim().startsWith('@mount/')) {
      throw new Error(`Mounted asset references require asynchronous project resolution: "${relativePath}"`);
    }
    const base = this.basePath.replace(/\\/g, '/');
    let absolutePath = this.normalizeRuntimeAssetPath(relativePath);
    if (absolutePath.startsWith('./')) {
      absolutePath = absolutePath.substring(2);
    }
    if (!absolutePath.match(/^[a-zA-Z]:\//) && !absolutePath.startsWith('/')) absolutePath = `${base}/${absolutePath}`;
    
    // Thoroughly scrub relative dot segments from the final URL path
    let cleanUrlPath = absolutePath.replace(/\/+/g, '/');
    if (cleanUrlPath.startsWith('./')) {
      cleanUrlPath = cleanUrlPath.substring(2);
    }
    cleanUrlPath = cleanUrlPath.replace(/\/\.\//g, '/');
    
    return encodeURI(`asset://localhost/${cleanUrlPath}`);
  }

  private createRuntimeAudio(src: string): HTMLAudioElement {
    const audio = document.createElement('audio');
    audio.crossOrigin = 'anonymous';
    audio.preload = 'auto';
    audio.src = src;
    return audio;
  }

  private async resolvePathAsync(relativePath: string): Promise<string> {
    const normalized = this.normalizeRuntimeAssetPath(relativePath);
    if (!normalized || normalized.startsWith('asset://') || normalized.startsWith('http')) return normalized;
    const projectResources = (window as any).AeonStagery?.services?.projectResources;
    const isFileSystemAbsolute = /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('//');

    if (projectResources?.getCurrentProject?.() && !normalized.startsWith('file://') && !isFileSystemAbsolute) {
      return projectResources.resolveForRuntime(normalized);
    }

    return this.resolvePath(normalized);
  }

  private normalizeRuntimeAssetPath(pathValue: string): string {
    const normalized = (pathValue || '').replace(/\\/g, '/').trim();
    const standardRoots = new Set(['animation', 'background', 'bgm', 'figure', 'project', 'template', 'vocal', 'images']);
    const withoutLeadingSlash = normalized.replace(/^\/+/, '');
    const topLevel = withoutLeadingSlash.split('/')[0];
    if (normalized.startsWith('/') && !normalized.startsWith('//') && !/^\/[a-zA-Z]:\//.test(normalized) && standardRoots.has(topLevel)) {
      return withoutLeadingSlash;
    }
    return normalized;
  }

  private cleanup(full: boolean = true, invalidationTime: number = 0): void {
    this.masterTimeline?.kill(); this.masterTimeline = null; this.setPlaying(false);
    gsap.ticker.remove(this.live2DTransformSync);
    this.lastVisualOverlayKey = null;
    
    if (invalidationTime > 0) {
      this.snapshotStore.invalidateAfter(invalidationTime);
      if (this.lastSnapshotTime >= invalidationTime) this.lastSnapshotTime = -1;
    } else {
      this.snapshotStore.clear(); 
      this.lastSnapshotTime = -1;
    }
    
    this.dialogueCoordinator.reset();
    this.audioCoordinator.clear();
    lipSyncEngine.clear();
    customAnimHost.clear();
    cameraController.init();

    if (full) {
      // Full cleanup (scene switch / teardown): release everything, including
      // the pre-bake daemon's BakeEngine and all image/environment sprites.
      preBakeDaemon.dispose();
      stageManager.clearEnvironmentLayers();
      stageManager.clearImages();
      live2DManager.clear();
      motionCurveCache.clear();
      lightingSystem.resetRuntimeState();
      objectCompositeRuntimeController.clearAll(this.currentScene);
      subtitleRenderer.hideDialogue(false);
    } else {
      // Soft cleanup: reset UI, audio, lighting; stop all running tweens on
      // models. Image/environment sprites are deliberately RETAINED — the
      // seek reconciliation pass diffs them (StageManager.beginImageReconciliation
      // / renderEnvironmentLayer reuse), so unchanged artwork never disappears
      // and the stage never flashes black between cleanup and re-materialization.
      // The pre-bake daemon is detached (timers/listeners/cancel) but its
      // BakeEngine stays alive to avoid CppHeap churn per commit.
      preBakeDaemon.detach();
      lightingSystem.resetRuntimeState();
      objectCompositeRuntimeController.clearAll(this.currentScene);
      subtitleRenderer.hideDialogue(false);

      // Critical: retain models but wipe dynamic state (stop breathing, look-at, and all tweens)
      for (const id of live2DManager.listCharacters()) {
        live2DManager.stopAllCharacterTweens(id);
      }
    }
  }

  private async prewarmModels(): Promise<void> {
    if (!this.currentScene) return;

    const modelsToLoad = new Map<string, string>();
    for (const action of this.currentScene.timeline) {
      if (action.action === 'addCharacter' && action.params?.id && action.params?.model) {
        try {
          const runtimePath = await this.resolvePathAsync(action.params.model);
          const normalizedPath = runtimePath.replace(/\\/g, '/').trim();
          if (!modelsToLoad.has(normalizedPath)) {
            modelsToLoad.set(normalizedPath, action.params.id);
          }
        } catch (error) {
          this.logger.warn(`Failed to resolve model for pre-warming "${action.params.model}": ${String(error)}`);
        }
      }
    }

    if (modelsToLoad.size === 0) return;

    this.logger.trace(`Pre-warming ${modelsToLoad.size} unique model resources in background...`, 'color: #0f0; font-weight: bold;');

    // Don't call addCharacter directly (it would add to the stage).
    // Trigger low-level Live2DModel.from via Live2DManager instead.
    // Live2DManager.init() ensures SDK readiness; browser cache + Promise locks handle the rest.
    // Use silent preload for deeper background warming.
    // Models the soft cleanup already retained are skipped entirely, so a
    // same-scene reload resolves within microtasks instead of awaiting new
    // model loads (no black-frame paint gap before the restore seek).
    await Promise.all(Array.from(modelsToLoad.entries()).map(async ([runtimePath, id]) => {
      if (live2DManager.matchesLoadedModel?.(id, runtimePath)) return;
      try {
        await live2DManager.preloadModel(id, runtimePath);
      } catch (error) {
        this.logger.warn(`Failed to pre-warm model "${runtimePath}": ${String(error)}`);
      }
    }));
  }

  private async prewarmMotionCurves(script: RuntimeTimelineScene): Promise<void> {
    const requiredByCharacter = new Map<string, Set<string>>();

    for (const action of script.timeline) {
      if (action.action !== 'playMotion') continue;
      const id = typeof action.params?.id === 'string' ? action.params.id : '';
      const motionKey = resolveResourceMotionKey(action.params?.motion);
      if (!id || !motionKey) continue;
      let keys = requiredByCharacter.get(id);
      if (!keys) {
        keys = new Set();
        requiredByCharacter.set(id, keys);
      }
      keys.add(motionKey);
    }

    if (requiredByCharacter.size === 0) return;

    const fps = script.meta.fps ?? 60;
    const tasks: Promise<void>[] = [];
    for (const [id, keys] of requiredByCharacter) {
      const entry = live2DManager.getAllCharacters().get(id);
      if (!entry?.model) continue;
      const targets = live2DManager.getMotionSamplerTargets(id);
      if (targets.length === 0) continue;
      for (const motionKey of keys) {
        tasks.push(
          motionCurveCache.ensure({
            adapterId: entry.runtime.adapterId,
            modelRuntimePath: entry.modelPath,
            motionKey,
            targets,
            fps,
          }).then(() => undefined, (error) => {
            this.logger.warn(`[MotionCurveCache] Pre-warm failed for "${id}/${motionKey}": ${String(error)}`);
          }),
        );
      }
    }

    if (tasks.length > 0) {
      this.logger.debug(`Pre-warming ${tasks.length} resource motion curve cache entr${tasks.length === 1 ? 'y' : 'ies'}...`);
      await Promise.all(tasks);
      const cached = motionCurveCache.size;
      this.logger.debug(`Resource motion curve cache pre-warm complete: ${cached} entr${cached === 1 ? 'y' : 'ies'} cached (of ${tasks.length} requested)`);
    }
  }

  destroy(): void { this.cleanup(); }
}

function resolveResourceMotionKey(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    const candidate = value as { kind?: unknown; key?: unknown };
    if (candidate.kind === 'resource' && typeof candidate.key === 'string') return candidate.key.trim();
  }
  return '';
}

/**
 * Signature of the non-action scene header fields. Compared during the reload
 * diff so a change in meta/audio/visual still triggers a rebuild even when no
 * action content changed.
 */
function sceneAuxSignature(scene: RuntimeTimelineScene): string {
  return JSON.stringify({ meta: scene.meta, audio: scene.audio, visual: scene.visual });
}

/**
 * Look-back used to resolve the expression that was in effect immediately
 * before a target expression's start time. Small enough to stay inside the same
 * authored frame, large enough to not land on the target itself.
 */
const EXPRESSION_PREDECESSOR_EPSILON_SECONDS = 0.001;

/**
 * Resolve, per character, the expression that was in effect immediately before
 * its target expression started.
 *
 * The seeked frame's expression fade must blend out of *that* expression — not
 * out of whatever the model happens to hold, which belongs to the previous
 * playback position. Characters without a recorded start time get `null`
 * (nothing to blend out of) so a stale expression can never become the fade
 * source.
 */
export function resolveExpressionPredecessors(
  desiredState: ReadonlyMap<string, { expression?: { key: string; time?: number } | null }>,
  charactersAtTime: (time: number) => ReadonlyMap<string, { expression?: { key: string } | null }>,
): Map<string, string | null> {
  const result = new Map<string, string | null>();
  const byStartTime = new Map<number, Map<string, string | null>>();
  for (const [id, state] of desiredState) {
    const startTime = state.expression?.time;
    if (typeof startTime !== 'number' || !Number.isFinite(startTime)) {
      result.set(id, null);
      continue;
    }
    let atStart = byStartTime.get(startTime);
    if (!atStart) {
      const previous = charactersAtTime(Math.max(0, startTime - EXPRESSION_PREDECESSOR_EPSILON_SECONDS));
      atStart = new Map();
      for (const [characterId, characterState] of previous) {
        atStart.set(characterId, typeof characterState.expression?.key === 'string' ? characterState.expression.key : null);
      }
      byStartTime.set(startTime, atStart);
    }
    result.set(id, atStart.get(id) ?? null);
  }
  return result;
}

export const scriptEngine = new ScriptEngine();
export default ScriptEngine;
