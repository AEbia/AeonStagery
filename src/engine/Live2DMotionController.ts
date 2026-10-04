/**
 * AeonStagery — Live2D Motion Controller
 *
 * Extracted from Live2DManager. Holds motion execution, hard reset, snapshot
 * application, and tween management. Shares state Maps/Sets by reference
 * with Live2DManager — no copying.
 */

import gsap from 'gsap';
import type { CharacterEntry, ModelSnapshot } from './Live2DConfig';
import { acquireUtSystemLock, describeInvalidModelSnapshot, releaseUtSystemLock } from './Live2DConfig';
import { hookSystem } from '../api/hooks';
import { cubism2Live2DAdapter, getLive2DRuntimeAdapter } from './Live2DRuntimeAdapter';
import type { Cubism2MotionSamplerTarget } from './live2d/cubism2MotionSampler';
import { releaseCustomMotionOwnership } from './live2d/customMotionOwnership';
import { purgeCharacterRuntimeState, restoreNeutralModelPose } from './live2d/characterStatePurge';
import {
  decideLive2DMotionRestart,
  getLive2DSnapshotRestorePolicy,
  LIVE2D_MOTION_HANDOFF_OFFSET_SECONDS,
  isLive2DMotionHandoffOffset,
  isLive2DEpochStale,
  normalizeLive2DMotionOffset,
} from './Live2DFrameEvaluation';
import { seekProfiler } from './SeekProfiler';

let cubism2ConfigPromise: Promise<any> | null = null;

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

async function loadCubism2Config(): Promise<any> {
  if (!cubism2ConfigPromise) {
    cubism2ConfigPromise = cubism2Live2DAdapter.init().then(() => cubism2Live2DAdapter.getConfig());
  }
  return cubism2ConfigPromise;
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
    private pendingConfigs: Map<string, any[]>,
    private motionMutex: Map<string, Promise<void>>,
    private hardResetMutex: Map<string, Promise<void>>,
    private activeMotionLoads: Set<string>,
    private jumpingCharacters: Set<string>,
    private getScriptEngine: () => any,
  ) {}

  private isCubism2Runtime(entry: CharacterEntry): boolean {
    return (entry.runtime?.adapterId ?? 'pixi-live2d-display-cubism2') === 'pixi-live2d-display-cubism2';
  }

  private restoreExpressionAfterMotionReset(entry: CharacterEntry): void {
    if (entry.expressionKey === undefined) return;

    if (entry.runtimeHandle) {
      entry.runtimeHandle.expression.setExpression(entry.expressionKey);
      return;
    }

    getLive2DRuntimeAdapter(entry.runtime).getControls().setExpression(entry.model, entry.expressionKey);
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
      return getLive2DRuntimeAdapter(entry.runtime).getControls().getMotionDuration(entry.model, motionKey);
    } catch (e) {
      console.warn(`[Live2D] Cannot get motion duration for ${id}/${motionKey}:`, e);
      return 0;
    }
  }

  /**
   * Return the concrete Cubism 2.1 sampling targets for a loaded character.
   * Used by the runtime motion curve cache pre-warm and seek integration.
   */
  getMotionSamplerTargets(id: string): readonly Cubism2MotionSamplerTarget[] {
    const entry = this.characters.get(id);
    if (!entry?.model) return [];
    return getLive2DRuntimeAdapter(entry.runtime).getControls().getMotionSamplingTargets(entry.model);
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
      entry?.runtime?.adapterId === 'official-cubism-web'
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
      ? getLive2DRuntimeAdapter(entry.runtime).getControls().captureSnapshot(id, entry.model, entry.motionStartTime)
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
      getLive2DRuntimeAdapter(entry.runtime).getControls().clearMotionState(entry.model);
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
    getLive2DRuntimeAdapter(entry.runtime).getControls().stopAllMotions(entry.model);
  }

  /**
   * 核心重构：彻底解决"立正"的同步切割法
   */
  async _executePlayMotion(id: string, motionKey: string, priority: number, offset: number, sceneTime: number, skipHardReset: boolean = false, reqEpoch: number = 0, requestHandoffSnapshot: ModelSnapshot | null = null): Promise<void> {
    // Serialize per character — only one motion operation at a time per ID
    const prevMutex = this.motionMutex.get(id) || Promise.resolve();
    let releaseMutex: () => void;
    const nextMutex = new Promise<void>(r => { releaseMutex = r; });
    this.motionMutex.set(id, nextMutex);

    await prevMutex;
    try {
      const targetMap = this.characters;
      const entry = targetMap.get(id);
      if (!entry || !entry.model) return;
      // Resource selectors may expose aggregate keys (for example
      // `mygo/soyo/mtn_smile...`) while the runtime model uses the exact group
      // name from its own model.json. Resolve the key before probing/starting.
      const normalizedRequestedKey = motionKey.trim();
      const availableGroups = getLive2DRuntimeAdapter(entry.runtime).getControls().getAvailableMotions(entry.model) as string[];
      if (!availableGroups.includes(normalizedRequestedKey)) {
        const leaf = normalizedRequestedKey.split('/').at(-1) ?? normalizedRequestedKey;
        const matches = availableGroups.filter((group) => {
          const groupLeaf = group.split('/').at(-1) ?? group;
          return groupLeaf === leaf;
        });
        if (matches.length === 1) motionKey = matches[0];
      }
      const generation = this.getGeneration(entry);

      // 拿到锁后第一时间校验：如果外头产生过更新的 playMotion 意图，立刻丢弃旧指令
      if (isLive2DEpochStale({ currentEpoch: entry.motionEpoch, requestEpoch: reqEpoch })) return;

      if (!this.isCubism2Runtime(entry)) {
        this.activeMotionLoads.add(id);
        try {
          if (!skipHardReset) {
            await this._hardReset(id, entry.model, true);
            if (!this.isEntryCurrent(id, entry, generation) || isLive2DEpochStale({ currentEpoch: entry.motionEpoch, requestEpoch: reqEpoch })) {
              return;
            }
          }

          await getLive2DRuntimeAdapter(entry.runtime).getControls().preloadMotion(entry.model, motionKey);
          if (!this.isEntryCurrent(id, entry, generation) || isLive2DEpochStale({ currentEpoch: entry.motionEpoch, requestEpoch: reqEpoch })) {
            return;
          }

          // Native Cubism 3+/4/5 motion fade-in is stateful: it blends the new
          // curve from the parameters that existed when the action took over.
          // A hard reset clears that source, so restore the captured handoff
          // after reset and before the first motion update.
          if (requestHandoffSnapshot) {
            this.applySnapshot(id, requestHandoffSnapshot);
            entry.lastSnapshot = requestHandoffSnapshot;
          }

          const started = await entry.model.startMotion?.(motionKey, 0, priority, offset);
          if (!this.isEntryCurrent(id, entry, generation) || isLive2DEpochStale({ currentEpoch: entry.motionEpoch, requestEpoch: reqEpoch })) {
            return;
          }
          if (!started) {
            console.warn(`[Live2D] Motion group "${motionKey}" not found for character "${id}".`);
            return;
          }
          entry.motionStartTime = sceneTime - offset;
          entry.lastOffset = offset;

          if (skipHardReset && entry.lastSnapshot) {
            this.applySnapshot(id, entry.lastSnapshot);
          }

          hookSystem.execute('character:motion', { id, motionKey, offset });
        } finally {
          this.activeMotionLoads.delete(id);
        }
        return;
      }

      const controls = getLive2DRuntimeAdapter(entry.runtime).getControls();
      const targetGroup = motionKey; // 恢复精确匹配
      if (!controls.hasMotionGroup(entry.model, targetGroup)) {
        console.warn(`[Live2D] Motion group "${motionKey}" not found for character "${id}".`);
        this.activeMotionLoads.delete(id);
        return;
      }

      // 第一阶段：静默、异步地在后台加载 .mtn 文件
      // (epoch 已在 playMotion 中推进，这里直接使用 reqEpoch 做校验)
      this.activeMotionLoads.add(id);
      try {
        await controls.preloadMotion(entry.model, targetGroup);
      } catch (e) {
        this.activeMotionLoads.delete(id);
        return;
      }

      // --- 核心修复：检查实例是否依然有效 ---
      // 如果在 await 期间角色被销毁重建了，entry 将不再是 Map 中的那个对象
      if (!this.isEntryCurrent(id, entry, generation) || isLive2DEpochStale({ currentEpoch: entry.motionEpoch, requestEpoch: reqEpoch })) {
        this.activeMotionLoads.delete(id);
        return;
      }

      // 第二阶段：进入同步临界区，瞬间完成 [重置 -> 塞动作 -> 偏移时间]
      const scriptEngine = this.getScriptEngine();
      const isReconstructing = scriptEngine?.isReconstructing;
      // 核心修复：Cubism 2 的 MotionManager 直接暴露了 playing 属性。
      // 在重建期间只要 Group 匹配我们就认为在播放；非重建期间额外校验 playing。
      // 通过 runtime controls 读取（不触碰运行时内部实现）。
      const motionDebug = controls.getMotionDebugState(entry.model);
      const currentMotionGroup = motionDebug?.currentGroup as string | undefined;
      const isMotionActuallyPlaying = isReconstructing
        ? (currentMotionGroup === targetGroup)
        : (currentMotionGroup === targetGroup && motionDebug?.playing === true);

      const restartDecision = decideLive2DMotionRestart({
        currentMotionGroup,
        targetMotionGroup: targetGroup,
        isMotionActuallyPlaying,
        previousOffset: entry.lastOffset,
        requestedOffset: offset,
        motionStartTime: entry.motionStartTime,
        sceneTime,
      });
      entry.lastOffset = offset;
      let expressionWasReset = false;

      if (restartDecision.needsRestart) {
        const skipReset = getLive2DSnapshotRestorePolicy({ skipHardReset, isReconstructing }) === 'preserve-current';
        // A seek purge clears motion bookkeeping before rebuilding the target
        // state. In that case there is no legitimate handoff pose: this is
        // the character's first motion at the target time and must fade from
        // the model instance's captured neutral pose. Existing motion
        // switches retain the live pose through the normal handoff path.
        const firstMotionAfterPurge = skipReset
          && entry.motionStartTime === undefined
          && entry.lastSnapshot === undefined
          && requestHandoffSnapshot === null;
        if (firstMotionAfterPurge && entry.model) {
          restoreNeutralModelPose(entry, entry.model);
        }
        const currentHandoffSnapshot = skipReset && isLive2DMotionHandoffOffset(offset)
          ? getLive2DRuntimeAdapter(entry.runtime).getControls().captureSnapshot(id, entry.model, entry.motionStartTime)
          : null;
        const capturedHandoffSnapshot = skipReset
          ? requestHandoffSnapshot ?? currentHandoffSnapshot
          : null;
        const handoffSnapshot = skipReset
          ? selectValidHandoffSnapshot(capturedHandoffSnapshot, entry.lastSnapshot, currentHandoffSnapshot)
          : null;
          if (skipReset) {
            await loadCubism2Config();
            if (!this.isEntryCurrent(id, entry, generation) || isLive2DEpochStale({ currentEpoch: entry.motionEpoch, requestEpoch: reqEpoch })) {
              this.activeMotionLoads.delete(id);
              return;
            }
          }
        // 1. 同步进行物理和参数硬重置
        if (!skipReset) {
          await this._hardReset(id, entry.model, true);
          // 有意统一为无条件恢复：HEAD 只在 cubism2 时置位，导致官方 runtime
          // 硬重置后当前表情丢失；resetModelToIdle 现对两个 runtime 都执行
          // 表情/队列收尾，因此恢复表达式对两者都成立（无 expressionKey 时
          // restoreExpressionAfterMotionReset 是 no-op）。
          expressionWasReset = true;

          // 再次检查实例有效性（因为 _hardReset 内部也有 await）
          if (!this.isEntryCurrent(id, entry, generation) || isLive2DEpochStale({ currentEpoch: entry.motionEpoch, requestEpoch: reqEpoch })) {
            this.activeMotionLoads.delete(id);
            return;
          }
        }

        // 2. 预加载动作 (mtn 已经在上面 loadMotion 了，这里是二次确认)
        if (!this.isEntryCurrent(id, entry, generation) || isLive2DEpochStale({ currentEpoch: entry.motionEpoch, requestEpoch: reqEpoch })) {
          this.activeMotionLoads.delete(id);
          return;
        }

        entry.motionStartTime = sceneTime - offset;

        const clock = getLive2DRuntimeAdapter(entry.runtime).getClock();
        if (clock) {
          this.jumpingCharacters.add(id);
          // Acquire GLOBAL SDK clock lock — only ONE character across the entire app
          // may spoof the Cubism SDK clock at a time, including BakeEngine.
          await acquireUtSystemLock();
          try {
            if (!this.isEntryCurrent(id, entry, generation) || isLive2DEpochStale({ currentEpoch: entry.motionEpoch, requestEpoch: reqEpoch })) {
              return;
            }
            // 核心修复：以 SDK 时钟当前值为锚点，所有操作只在其基础上递增。
            // 时钟回拨、动作入队、快进回放与 physics 摘除全部由 runtime adapter
            // 在锁内完成（等效旧代码的第一~四步）。

            // 快照注入窗口：动作入队、时钟停在动作起始时刻之后、快进回放之前。
            // 必须在此之前应用恢复快照，否则快进计算出的平滑目标参数会被旧快照
            // 覆盖，导致严重的视觉步进感（等效旧代码的第 2.5 步）。
            const snapshotToRestore = selectValidHandoffSnapshot(handoffSnapshot, entry.lastSnapshot);
            const isHandoffOffset = isLive2DMotionHandoffOffset(offset);

            const startResult = await controls.startMotion(entry.model, targetGroup, priority, offset, {
              clock,
              clearQueueFirst: skipReset,
              stepAfterStartMs: !skipReset && offset <= 0 ? 16 : undefined,
              beforeReplay: () => {
                if (!this.isEntryCurrent(id, entry, generation) || isLive2DEpochStale({ currentEpoch: entry.motionEpoch, requestEpoch: reqEpoch })) {
                  return;
                }
                if (skipReset && snapshotToRestore) {
                  controls.applySnapshot(entry.model, snapshotToRestore);
                  entry.lastSnapshot = snapshotToRestore;
                  entry.pendingSeekBoundarySnapshot = isHandoffOffset ? snapshotToRestore : undefined;
                  entry.pendingSeekBoundaryMotionStartTime = isHandoffOffset ? entry.motionStartTime : undefined;
                  entry.pendingSeekBoundaryDuration = isHandoffOffset ? LIVE2D_MOTION_HANDOFF_OFFSET_SECONDS : undefined;
                } else {
                  clearPendingSeekBoundary(entry);
                }
              },
            });
            if (!startResult.ok && !skipReset) {
              console.warn(`[Live2D] Motion group "${targetGroup}" failed to start for character "${id}".`);
            }
            entry.motionStartUtTime = startResult.motionStartUtTimeMs;

            // 快进后处理：handoff 边界快照的“快进结果是否回到默认姿态”检查。
            if (isHandoffOffset && skipReset && snapshotToRestore) {
              const advancedSnapshot = controls.captureSnapshot(id, entry.model, entry.motionStartTime);
              if (isDefaultPoseSnapshot(advancedSnapshot)) {
                controls.applySnapshot(entry.model, snapshotToRestore);
              } else {
                entry.pendingSeekBoundarySnapshot = snapshotToRestore;
                entry.pendingSeekBoundaryMotionStartTime = entry.motionStartTime;
                entry.pendingSeekBoundaryDuration = LIVE2D_MOTION_HANDOFF_OFFSET_SECONDS;
              }
            }
            // console.log(`[Live2D] Motion ${targetGroup} started with spoofed offset ${offset}s for ${id} (skipReset=${skipReset})`);
          } finally {
            releaseUtSystemLock();
            this.jumpingCharacters.delete(id);
            this.activeMotionLoads.delete(id);
          }
        } else {
          if (!this.isEntryCurrent(id, entry, generation) || isLive2DEpochStale({ currentEpoch: entry.motionEpoch, requestEpoch: reqEpoch })) {
            this.activeMotionLoads.delete(id);
            return;
          }
          try {
            const startResult = await controls.startMotion(entry.model, targetGroup, priority, offset, { clock: null });
            if (!startResult.ok && !skipReset) {
              console.warn(`[Live2D] Motion group "${targetGroup}" failed to start for character "${id}".`);
            }
            entry.motionStartUtTime = startResult.motionStartUtTimeMs;
            // console.log(`[Live2D] Motion ${targetGroup} started (no spoofing) for ${id}`);
            if (!this.isEntryCurrent(id, entry, generation) || isLive2DEpochStale({ currentEpoch: entry.motionEpoch, requestEpoch: reqEpoch })) {
              return;
            }
          } finally {
            this.activeMotionLoads.delete(id);
          }
        }
      } else {
        const skipReset = getLive2DSnapshotRestorePolicy({ skipHardReset, isReconstructing }) === 'preserve-current';
        const clock = getLive2DRuntimeAdapter(entry.runtime).getClock();
        if (skipReset && clock) {
          this.jumpingCharacters.add(id);
          await acquireUtSystemLock();
          try {
            if (!this.isEntryCurrent(id, entry, generation) || isLive2DEpochStale({ currentEpoch: entry.motionEpoch, requestEpoch: reqEpoch })) {
              return;
            }

            const motionStartUtTime = entry.motionStartUtTime ?? (clock.getUserTimeMSec() - offset * 1000);
            entry.motionStartUtTime = motionStartUtTime;
            const targetUtTime = motionStartUtTime + offset * 1000;
            clock.setUserTimeMSec(targetUtTime);

            const motionStepStart = performance.now();
            // 仅推进 Cubism2 动作队列（adapter 内做 physics 摘除保护），避免在
            // Pixi 渲染边界之外运行模型完整更新路径。
            controls.advanceMotionOnly(entry.model, targetUtTime);
            seekProfiler.addTime('motion-step', performance.now() - motionStepStart);

            if (entry.pendingSeekBoundarySnapshot) {
              const currentSnapshot = controls.captureSnapshot(id, entry.model, entry.motionStartTime);
              if (isDefaultPoseSnapshot(currentSnapshot)) {
                controls.applySnapshot(entry.model, entry.pendingSeekBoundarySnapshot);
              } else {
                clearPendingSeekBoundary(entry);
              }
            }
          } finally {
            releaseUtSystemLock();
            this.jumpingCharacters.delete(id);
            this.activeMotionLoads.delete(id);
          }
        } else {
          this.activeMotionLoads.delete(id);
        }
      }

      if (expressionWasReset && this.isEntryCurrent(id, entry, generation)) {
        this.restoreExpressionAfterMotionReset(entry);
      }

      hookSystem.execute('character:motion', { id, motionKey: targetGroup, offset });
    } finally {
      releaseMutex!();
      // Remove resolved mutex from map so waitForAllLoaded can rely on size
      if (this.motionMutex.get(id) === nextMutex) {
        this.motionMutex.delete(id);
      }
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

    if (entry.runtimeHandle) {
      entry.runtimeHandle.snapshot.applySnapshot(snapshot);
    } else {
      getLive2DRuntimeAdapter(entry.runtime).getControls().applySnapshot(entry.model, snapshot);
    }

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
    for (const focusController of getLive2DRuntimeAdapter(entry.runtime).getControls().getFocusControllers(entry.model)) {
      gsap.killTweensOf(focusController);
      if (focusController.__aeonOriginalFocusUpdate) {
        focusController.update = focusController.__aeonOriginalFocusUpdate;
        delete focusController.__aeonOriginalFocusUpdate;
      }
    }
  }

  /**
   * Stop all active transformation tweens on all characters.
   */
  pauseAllTweens(): void {
    for (const id of this.characters.keys()) {
      const entry = this.characters.get(id);
      if (entry) {
        gsap.getTweensOf(entry.model).forEach((t: any) => t.pause());
        for (const focusController of getLive2DRuntimeAdapter(entry.runtime).getControls().getFocusControllers(entry.model)) {
          gsap.getTweensOf(focusController).forEach((t: any) => t.pause());
        }
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
        for (const focusController of getLive2DRuntimeAdapter(entry.runtime).getControls().getFocusControllers(entry.model)) {
          gsap.getTweensOf(focusController).forEach((t: any) => t.resume());
        }
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
    if (entry.runtime.adapterId !== 'pixi-live2d-display-cubism2') return;

    this.activeMotionLoads.add(id);
    try {
      await getLive2DRuntimeAdapter(entry.runtime).getControls().preloadMotion(entry.model, motionKey);
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
      const controls = getLive2DRuntimeAdapter(entry.runtime).getControls();
      await controls.resetModelToIdle(model, {
        keepFocus,
        idleSnapshot: entry?.idleSnapshot ? entry.idleSnapshot as ModelSnapshot : null,
      });

      if (entry) {
        if (!this.isCubism2Runtime(entry)) {
          entry.motionStartTime = undefined;
          entry.lastOffset = undefined;
          entry.lastSnapshot = undefined;
        }
        entry.lastManualTimeMs = undefined;
      }

      // The legacy Cubism 2 reset ended with one wrapper-level advance after
      // the per-concrete steps; keep that final frame.
      if (this.isCubism2Runtime(entry)) {
        controls.advanceFrame(model, 16);
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
