/**
 * AeonStagery — Live2D Motion Controller
 *
 * Extracted from Live2DManager. Holds motion execution, hard reset, snapshot
 * application, and tween management. Shares state Maps/Sets by reference
 * with Live2DManager — no copying.
 */

import { getLive2DRuntimeCapabilities } from './live2d/runtime/Live2DRuntimeControlModule';
import gsap from 'gsap';
import type { CharacterEntry, ModelSnapshot } from './Live2DConfig';
import { describeInvalidModelSnapshot } from './Live2DConfig';
import { hookSystem } from '../api/hooks';
import { getBoundRuntimeHandle } from './live2d/runtime/BoundRuntimeAccess';
import { releaseCustomMotionOwnership } from './live2d/customMotionOwnership';
import { purgeCharacterRuntimeState } from './live2d/characterStatePurge';
import {
  decideLive2DMotionRestart,
  getLive2DSnapshotRestorePolicy,
  LIVE2D_MOTION_HANDOFF_OFFSET_SECONDS,
  isLive2DMotionHandoffOffset,
  isLive2DEpochStale,
  normalizeLive2DMotionOffset,
} from './Live2DFrameEvaluation';

function isDefaultPoseSnapshot(snapshot: ModelSnapshot | null): boolean {
  if (!snapshot?.params?.length) return true;
  for (let i = 0; i < snapshot.params.length; i++) {
    if (snapshot.params[i] !== 0) return false;
  }
  return true;
}

function selectValidHandoffSnapshot(
  captured: ModelSnapshot | null,
  fallback: ModelSnapshot | undefined,
  current: ModelSnapshot | null = null,
): ModelSnapshot | null {
  if (captured && !isDefaultPoseSnapshot(captured)) return captured;
  if (fallback && !isDefaultPoseSnapshot(fallback)) return fallback;
  if (current && !isDefaultPoseSnapshot(current)) return current;
  return null;
}

function clearPendingSeekBoundary(entry: CharacterEntry): void {
  entry.pendingSeekBoundarySnapshot = undefined;
  entry.pendingSeekBoundaryMotionStartTime = undefined;
  entry.pendingSeekBoundaryDuration = undefined;
}

export interface MotionRequest {
  key: string;
  priority: number;
  offset?: number;
  sceneTime?: number;
  skipHardReset?: boolean;
  handoffSnapshot?: ModelSnapshot | null;
  reqEpoch: number;
}

export class Live2DMotionController {
  constructor(
    private characters: Map<string, CharacterEntry>,
    private containers: Map<string, any>,
    private pendingMotions: Map<string, MotionRequest[]>,
    private pendingConfigs: Map<string, unknown[]>,
    private motionMutex: Map<string, Promise<void>>,
    private hardResetMutex: Map<string, Promise<void>>,
    private activeMotionLoads: Set<string>,
    _jumpingCharacters: Set<string>,
    private getScriptEngine: () => any,
  ) {}

  private usesPrivateMotionControls(entry: CharacterEntry): boolean {
    return getLive2DRuntimeCapabilities(entry).usesCubism2PrivateControls;
  }

  private getGeneration(entry: CharacterEntry): number {
    return entry.lifecycleGeneration ?? 0;
  }

  private isEntryCurrent(id: string, entry: CharacterEntry, generation: number, model: any = entry.model): boolean {
    return this.characters.get(id) === entry
      && this.getGeneration(entry) === generation
      && !!entry.model
      && entry.model === model
      && !entry.model.destroyed;
  }

  /**
   * Get the duration (in seconds) of a motion group for a character.
   * Returns 0 if the motion or model cannot be found.
   */
  getMotionDuration(id: string, motionKey: string): number {
    const entry = this.characters.get(id);
    if (!entry?.model) return 0;

    try {
      return getBoundRuntimeHandle(entry)?.motion.getMotionDuration(motionKey) ?? 0;
    } catch (e) {
      console.warn(`[Live2D] Cannot get motion duration for ${id}/${motionKey}:`, e);
      return 0;
    }
  }

  /**
   * Public dispatch — called from Live2DManager.updateAll().
   */
  dispatchMotion(id: string, req: MotionRequest): Promise<void> {
    return this._executePlayMotion(
      id, req.key, req.priority,
      req.offset ?? 0, req.sceneTime ?? 0,
      req.skipHardReset ?? false, req.reqEpoch, req.handoffSnapshot ?? null,
    );
  }

  playMotion(id: string, motionKey: string, priority: number = 3, offset: number = 0, sceneTime: number = 0, skipHardReset: boolean = false): void {
    // A resource motion fully takes over from an active custom motion.
    const entry = this.characters.get(id);
    if (entry?.customMotion) {
      this.releaseCustomMotion(entry);
    }

    // Normal playback filters tiny onStart offsets to avoid unnecessary SDK-clock
    // spoofing; seek/scrub preserves them so action-start frames do not collapse
    // back to the Cubism2 default pose.
    const scriptEngine = this.getScriptEngine();
    const preserveTinyOffset = skipHardReset || scriptEngine?.isReconstructing === true;
    const targetOffset = normalizeLive2DMotionOffset(offset, { preserveTinyOffset });
    const shouldCaptureHandoffAtIntent =
      (entry && getLive2DRuntimeCapabilities(entry).supportsMotionHandoff)
      || (preserveTinyOffset && isLive2DMotionHandoffOffset(targetOffset));

    if (!entry) {
      // 核心修复：如果模型连 entry 都没有（还没开始加载或正在加载第一阶段），存入 pendingMotions
      // 只保留最新的动作，防止 Seek 时队列爆炸
      this.pendingMotions.set(id, [{ key: motionKey, priority, offset: targetOffset, sceneTime, skipHardReset, reqEpoch: 0 }]);
      return;
    }

    // 如果模型正在加载中（已有 entry 但 model 为空），同步存入 entry 的缓冲
    if (!entry.model) {
      const reqEpoch = ++entry.motionEpoch; // 意图产生时立刻推进版本
      entry._pendingPlayMotion = { key: motionKey, priority, offset: targetOffset, sceneTime, skipHardReset, reqEpoch };
      return;
    }

    // 核心修复：同步缓冲器（Buffer）
    // GSAP 的 seek 会在一帧内同步调用这个方法几十次。
    // 我们只把最后的指令存下来，交由下一帧 of updateAll 去执行，彻底避开微任务的时序陷阱。
    const reqEpoch = ++entry.motionEpoch; // 意图产生时立刻推进版本
    const handoffSnapshot = shouldCaptureHandoffAtIntent
      ? getBoundRuntimeHandle(entry)?.snapshot.captureSnapshot(entry.motionStartTime) ?? null
      : null;
    entry._pendingPlayMotion = { key: motionKey, priority, offset: targetOffset, sceneTime, skipHardReset, handoffSnapshot, reqEpoch };
  }

  /**
   * Delegate to the shared ownership lifecycle (ADR-0029). This used to
   * duplicate the manager's release logic and leak the Motion-stage writer:
   * its afterMotionUpdate listeners stayed attached and a motion whose tracks
   * owned the blink parameters left SDK eye blink permanently suppressed
   * whenever a resource motion took over, a motion was stopped, or
   * resetToIdle ran.
   */
  private releaseCustomMotion(entry: import('./Live2DConfig').CharacterEntry): void {
    releaseCustomMotionOwnership(entry);
  }

  /** 清除角色的待执行动作，防止 GSAP seek 残留的 skipHardReset=false 指令污染快照状态 */
  clearPendingMotion(id: string): void {
    const entry = this.characters.get(id);
    if (entry) {
      entry._pendingPlayMotion = undefined;
      // Advance epoch to invalidate any in-flight _executePlayMotion background tasks
      entry.motionEpoch++;
    }
  }

  /** 清除所有角色的待执行动作并推进 epoch，Seek 前必须调用以防止旧指令污染快照恢复 */
  clearAllPendingMotions(): void {
    for (const entry of this.characters.values()) {
      entry._pendingPlayMotion = undefined;
      entry.motionEpoch++; // invalidate in-flight background _executePlayMotion tasks
      entry.lastOffset = undefined; // reset so _executePlayMotion doesn't think we're playing
      // Clear every concrete model's motion state so composite sub-models do not
      // carry stale queued frames into seek reconstruction.
      getBoundRuntimeHandle(entry)?.lifecycle.clearMotionState();
    }
  }

  /** 立刻强制停止指定角色的所有动作（清空动作队列，不重置参数）。用于在暂停状态下 seek 时“冻结”角色的动作。 */
  stopAllMotions(id: string): void {
    // The character entry may not exist while its model is loading. Clear the
    // manager-level request too, otherwise a preview can replay on load.
    this.pendingMotions.delete(id);
    const entry = this.characters.get(id);
    if (!entry) return;
    // 停止时清除缓冲意图并推进 epoch，与 clearPendingMotion 保持一致：
    // 否则上一帧缓冲的预览动作会在下一帧 updateAll 中执行，或模型加载完成后才执行。
    entry._pendingPlayMotion = undefined;
    entry.motionEpoch++; // invalidate in-flight _executePlayMotion background tasks
    // 模型冻结在没有该自定义动作的目标时间：释放旧动作，否则每帧仍会注入
    // 曲线值，把无动作区域的姿态污染成动作姿态，破坏后续播放的淡入交接。
    this.releaseCustomMotion(entry);
    if (!entry.model) return;
    getBoundRuntimeHandle(entry)?.lifecycle.stopAllMotions();
  }

  /**
   * 核心重构：彻底解决"立正"的同步切割法
   */
  async _executePlayMotion(
    id: string,
    motionKey: string,
    priority: number,
    offset: number,
    sceneTime: number,
    skipHardReset: boolean = false,
    reqEpoch: number = 0,
    requestHandoffSnapshot: ModelSnapshot | null = null,
  ): Promise<void> {
    const prevMutex = this.motionMutex.get(id) || Promise.resolve();
    let releaseMutex: () => void;
    const nextMutex = new Promise<void>(resolve => { releaseMutex = resolve; });
    this.motionMutex.set(id, nextMutex);

    await prevMutex;
    try {
      const entry = this.characters.get(id);
      if (!entry?.model) return;
      const runtime = getBoundRuntimeHandle(entry);
      if (!runtime) return;

      const normalizedRequestedKey = motionKey.trim();
      const availableGroups = runtime.motion.getAvailableMotions();
      if (!availableGroups.includes(normalizedRequestedKey)) {
        const leaf = normalizedRequestedKey.split('/').at(-1) ?? normalizedRequestedKey;
        const matches = availableGroups.filter((group) => (group.split('/').at(-1) ?? group) === leaf);
        if (matches.length === 1) motionKey = matches[0];
      }

      const generation = this.getGeneration(entry);
      const isCurrent = () => this.isEntryCurrent(id, entry, generation)
        && !isLive2DEpochStale({ currentEpoch: entry.motionEpoch, requestEpoch: reqEpoch });
      if (!isCurrent()) return;

      this.activeMotionLoads.add(id);
      try {
        const isReconstructing = this.getScriptEngine()?.isReconstructing;
        const skipReset = getLive2DSnapshotRestorePolicy({ skipHardReset, isReconstructing }) === 'preserve-current';
        const playback = runtime.motion.getPlaybackState();
        const restartDecision = decideLive2DMotionRestart({
          currentMotionGroup: playback.currentGroup ?? undefined,
          targetMotionGroup: motionKey,
          isMotionActuallyPlaying: isReconstructing
            ? playback.currentGroup === motionKey
            : playback.currentGroup === motionKey && playback.playing,
          previousOffset: entry.lastOffset,
          requestedOffset: offset,
          motionStartTime: entry.motionStartTime,
          sceneTime,
        });
        if (restartDecision.needsRestart) {
          const isCubism2 = runtime.capabilities.usesCubism2PrivateControls;
          const firstMotionAfterPurge = skipReset
            && entry.motionStartTime === undefined
            && entry.lastSnapshot === undefined
            && requestHandoffSnapshot === null;
          if (firstMotionAfterPurge) runtime.resetRuntimeState({ pose: 'neutral' });

          const currentHandoffSnapshot = skipReset && isLive2DMotionHandoffOffset(offset)
            ? runtime.snapshot.captureSnapshot(entry.motionStartTime)
            : null;
          const handoffSnapshot = skipReset
            ? selectValidHandoffSnapshot(
                requestHandoffSnapshot ?? currentHandoffSnapshot,
                entry.lastSnapshot,
                currentHandoffSnapshot,
              )
            : null;

          let expressionWasReset = false;
          if (!skipReset) {
            await this._hardReset(id, entry.model, true);
            if (!isCurrent()) return;
            expressionWasReset = true;
          }
          if (!isCurrent()) return;

          const motionStartTime = sceneTime - offset;
          const transition = await runtime.performance.transition({
            motionKey,
            priority,
            offsetSeconds: offset,
            sceneTimeSeconds: motionStartTime,
            clearQueueFirst: skipReset,
            fadeInSeconds: undefined,
            handoffSnapshot,
            finalSnapshot: !isCubism2 && skipReset ? handoffSnapshot ?? entry.lastSnapshot : undefined,
            expressionKey: expressionWasReset ? entry.expressionKey : undefined,
            restoreHandoffBoundary: skipReset && isLive2DMotionHandoffOffset(offset),
            stepAfterStartMs: isCubism2 && !skipReset && offset <= 0 ? 16 : undefined,
            isCurrent,
          });
          if (transition.status === 'cancelled' || !isCurrent()) return;
          if (transition.status === 'missing') {
            if (!skipReset) console.warn(`[Live2D] Motion group "${motionKey}" failed to start for character "${id}".`);
            return;
          }

          entry.motionStartTime = sceneTime - offset;
          entry.motionStartUtTime = transition.motionStartUtTimeMs;
          if (handoffSnapshot && skipReset) entry.lastSnapshot = handoffSnapshot;
          if (transition.retainedHandoffBoundary && handoffSnapshot) {
            entry.pendingSeekBoundarySnapshot = handoffSnapshot;
            entry.pendingSeekBoundaryMotionStartTime = entry.motionStartTime;
            entry.pendingSeekBoundaryDuration = LIVE2D_MOTION_HANDOFF_OFFSET_SECONDS;
          } else {
            clearPendingSeekBoundary(entry);
          }
        } else if (skipReset && runtime.capabilities.usesSharedSdkClock) {
          const seekResult = await runtime.performance.seekMotionOffset({
            motionStartUtTimeMs: entry.motionStartUtTime,
            offsetSeconds: offset,
            handoffBoundarySnapshot: entry.pendingSeekBoundarySnapshot,
            isCurrent,
          });
          if (seekResult.status === 'cancelled' || !isCurrent()) return;
          if (seekResult.status === 'advanced') {
            entry.motionStartUtTime = seekResult.motionStartUtTimeMs;
            if (entry.pendingSeekBoundarySnapshot && !seekResult.retainedHandoffBoundary) {
              clearPendingSeekBoundary(entry);
            }
          }
        }

        if (isCurrent()) {
          entry.lastOffset = offset;
          hookSystem.execute('character:motion', { id, motionKey, offset });
        }
      } finally {
        this.activeMotionLoads.delete(id);
      }
    } finally {
      releaseMutex!();
      if (this.motionMutex.get(id) === nextMutex) this.motionMutex.delete(id);
    }
  }

  /**
   * Restore a character's state from a snapshot.
   */
  applySnapshot(id: string, snapshot: ModelSnapshot): void {
    const invalidSnapshotField = describeInvalidModelSnapshot(snapshot);
    if (invalidSnapshotField) {
      console.warn(`[Live2D] Ignored invalid snapshot for "${id}" (${invalidSnapshotField} is not finite).`);
      return;
    }

    const entry = this.characters.get(id);
    if (!entry || !entry.model) return;

    if (!getLive2DRuntimeCapabilities(entry).supportsSnapshot) return;
    getBoundRuntimeHandle(entry)?.snapshot.applySnapshot(snapshot);

    // Restore motion context (don't play the motion — syncAllStates handles that).
    // CRITICAL: Do NOT set the motion queue's current group here.  Setting it
    // without loading/starting the motion causes the Cubism SDK to see a phantom
    // motion during the model update in the simulation-forward loop, which may
    // reset parameters to defaults (T-pose, eyes closed).
    if (snapshot.motion) {
      entry.motionStartTime = snapshot.motion.startTime;
    } else {
    }

    // Restore stage transform
    // Note: In live playback, the character's stage transform (x, y, scale, rotation, alpha)
    // is entirely managed by the GSAP timeline and transformationProxies system. Restoring them
    // directly from a snapshot here overwrites the newly evaluated timeline state, causing
    // PixiJS updateTransform matrix lag and resulting in single-frame giant/displaced visual glitches during seeks.
    /*
    if (snapshot.position) entry.model.position.set(snapshot.position.x, snapshot.position.y);
    if (snapshot.scale) entry.model.scale.set(snapshot.scale.x, snapshot.scale.y);
    if (snapshot.rotation !== undefined) entry.model.rotation = snapshot.rotation;
    if (snapshot.alpha !== undefined) entry.model.alpha = snapshot.alpha;
    */

    // Store for re-application after motion restarts
    entry.lastSnapshot = snapshot;

    // 核心修复：坚决不能在这里直接步进模型！
    // 因为此时全局 SDK 时钟还未推进，如果在这里调用更新，底层物理引擎算出的 dt 必定是 0！
    // Cubism 2 物理引力计算包含 1/dt，这会立刻导致除零错误，爆出 NaN 毁掉角色模型。
    // 更新将由 ScriptEngine 后续的 forward simulation 通过 updateAll 统一推进。
  }

  /**
   * Reset a character to idle state without removing it from stage.
   * Stops all motions/expressions and resets all parameters to SDK defaults.
   */
  resetToIdle(id: string): void {
    const entry = this.characters.get(id);
    if (!entry) return;
    entry.expressionKey = null;
    // 模型归位 idle：释放自定义动作及其交接姿态，停止曲线注入。
    // 否则模型停在动作内时，每帧仍会被拉回曲线值，seek 到动作起点前
    // 的显示与后续播放的淡入都会被污染。
    this.releaseCustomMotion(entry);
    const scriptEngine = this.getScriptEngine();
    if (scriptEngine?.isReconstructing) {
      // Skip the heavy asynchronous _hardReset during active reconstruct seeks
      // to prevent visual T-pose flashes — but still drop every retained
      // channel synchronously. Clearing injectedParams alone left the SDK
      // motion queue playing the previous action into the seeked frame.
      purgeCharacterRuntimeState(entry, { restoreNeutralPose: true });
      return;
    }
    this._hardReset(id, entry.model);
    purgeCharacterRuntimeState(entry, { restoreNeutralPose: true });
    console.log(`[Live2D] Character "${id}" reset to idle.`);
  }

  /**
   * Public API to hard-reset a character to idle state.
   * Exposed for use by ScriptEngine during timeline reconstruction.
   */
  resetModel(id: string): void {
    const entry = this.characters.get(id);
    if (!entry) return;
    const scriptEngine = this.getScriptEngine();
    if (scriptEngine?.isReconstructing) {
      return;
    }
    this._hardReset(id, entry.model);
  }

  /**
   * Stop all active GSAP tweens on a character (breathing, focus, transforms, etc.)
   * Used during hot reloads to ensure a clean state.
   */
  stopAllCharacterTweens(id: string): void {
    const entry = this.characters.get(id);
    if (!entry) return;

    // 1. Kill internal idle tweens
    if (entry.breathTween) {
      entry.breathTween.kill();
      entry.breathTween = undefined;
    }

    // 2. Kill all GSAP tweens targeting the model or its internal components
    gsap.killTweensOf(entry.model);
    getBoundRuntimeHandle(entry)?.focus.manageAnimations('stop');
  }

  /**
   * Stop all active transformation tweens on all characters.
   */
  pauseAllTweens(): void {
    for (const id of this.characters.keys()) {
      const entry = this.characters.get(id);
      if (entry) {
        gsap.getTweensOf(entry.model).forEach((t: any) => t.pause());
        getBoundRuntimeHandle(entry)?.focus.manageAnimations('pause');
        const container = this.containers.get(id);
        if (container) gsap.getTweensOf(container).forEach((t: any) => t.pause());
        const rimProxy = (entry as any).rimProxy;
        if (rimProxy) gsap.getTweensOf(rimProxy).forEach((t: any) => t.pause());
      }
    }
  }

  /**
   * Resume all transformation tweens.
   */
  resumeAllTweens(): void {
    for (const id of this.characters.keys()) {
      const entry = this.characters.get(id);
      if (entry) {
        gsap.getTweensOf(entry.model).forEach((t: any) => t.resume());
        getBoundRuntimeHandle(entry)?.focus.manageAnimations('resume');
        const container = this.containers.get(id);
        if (container) gsap.getTweensOf(container).forEach((t: any) => t.resume());
        const rimProxy = (entry as any).rimProxy;
        if (rimProxy) gsap.getTweensOf(rimProxy).forEach((t: any) => t.resume());
      }
    }
  }

  /**
   * Preload a motion for a character to avoid async stalls during baking.
   */
  async preloadMotion(id: string, motionKey: string): Promise<void> {
    const entry = this.characters.get(id);
    if (!entry || !entry.model) return;
    if (!getLive2DRuntimeCapabilities(entry).supportsMotion) return;

    this.activeMotionLoads.add(id);
    try {
      const runtime = getBoundRuntimeHandle(entry);
      if (!runtime) return;
      const generation = this.getGeneration(entry);
      await runtime.motion.preloadMotion(motionKey, () => this.isEntryCurrent(id, entry, generation));
    } finally {
      this.activeMotionLoads.delete(id);
    }
  }

  /**
   * Check if any character is currently in the middle of loading or starting a motion.
   * Used by ScriptEngine to ensure snapshots are not taken during transition.
   */
  isMotionLoading(): boolean {
    return this.activeMotionLoads.size > 0;
  }

  /**
   * Internal helper for a complete model reset.
   */
  async _hardReset(id: string, model: any, keepFocus: boolean = false): Promise<void> {
    const entryAtRequest = this.characters.get(id);
    const generationAtRequest = entryAtRequest ? this.getGeneration(entryAtRequest) : 0;
    // Serialize per character — prevents overlapping resets from NaN path, seek, and motion execution
    const prevMutex = this.hardResetMutex.get(id) || Promise.resolve();
    let releaseMutex: () => void;
    const nextMutex = new Promise<void>(r => { releaseMutex = r; });
    this.hardResetMutex.set(id, nextMutex);

    await prevMutex;
    const entry = this.characters.get(id);
    // After releasing the async lock, the model may have been destroyed
    // by a synchronous removeCharacter() call. Check before touching anything.
    if (!entry || entry !== entryAtRequest || this.getGeneration(entry) !== generationAtRequest || entry.model !== model || !model || model.destroyed) {
      releaseMutex!();
      if (this.hardResetMutex.get(id) === nextMutex) {
        this.hardResetMutex.delete(id);
      }
      return;
    }
    try {
      // Clear any pending actions for this ID
      this.pendingMotions.delete(id);
      this.pendingConfigs.delete(id);

      // Runtime reset semantics live in the adapter (motion/expression queue
      // teardown, idle-group flush, idle pose restore, focus reset, step).
      const runtime = getBoundRuntimeHandle(entry);
      if (!runtime) return;
      const reset = await runtime.lifecycle.resetToIdle({
        keepFocus,
        idleSnapshot: entry?.idleSnapshot ? entry.idleSnapshot as ModelSnapshot : null,
      }, () => this.isEntryCurrent(id, entry, generationAtRequest, model));
      if (!reset || !this.isEntryCurrent(id, entry, generationAtRequest, model)) return;

      if (entry) {
        if (!this.usesPrivateMotionControls(entry)) {
          entry.motionStartTime = undefined;
          entry.lastOffset = undefined;
          entry.lastSnapshot = undefined;
        }
        entry.lastManualTimeMs = undefined;
      }

      // Unified soft-tween teardown for BOTH runtimes. HEAD only killed these
      // on the non-cubism2 branch; the refactor deliberately unifies the tail
      // so a stale GSAP tween cannot fight the just-restored pose. Focus
      // tweens are NOT affected (they target the focusController — handled by
      // resetModelToIdle / applyFocus ownership), and stage-transform tweens
      // are timeline-owned, so they are re-evaluated on the next frame.
      gsap.killTweensOf(model);
      gsap.killTweensOf(model.scale);
      const container = this.containers.get(id);
      if (container) gsap.killTweensOf(container);
    } catch (e) {
      console.warn(`[Live2D] Hard reset failed for "${id}":`, e);
    } finally {
      releaseMutex!();
      // Remove resolved mutex from map so waitForAllLoaded can rely on size
      if (this.hardResetMutex.get(id) === nextMutex) {
        this.hardResetMutex.delete(id);
      }
    }
  }
}
