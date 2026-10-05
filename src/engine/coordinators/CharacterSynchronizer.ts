import type { SnapshotStore } from '../SnapshotStore';
import type { ProxyRegistry } from './ProxyRegistry';
import type { CharacterMotionOutput } from '../../api/types/semantic-scene';
import type { ModelSnapshot } from '../Live2DConfig';
import type { Live2DSeekExpressionState } from '../Live2DRuntimeAdapter';
import { resolveLookAtFocus } from '../lookAtFocus';
import { seekProfiler } from '../SeekProfiler';
import { motionCurveCache, type CachedResourceMotion, type MotionCurveCacheSource } from '../live2d/motionCurveCache';
import type { Cubism2MotionSamplerTarget } from '../live2d/cubism2MotionSampler';

interface DesiredCharState {
  id: string;
  model: string;
  config: Record<string, any>;
  /** Scene time of the latest addCharacter for this on-stage lifetime. */
  lifecycleStartTime?: number;
  position?: [number, number];
  scale?: number;
  rotation?: number;
  opacity?: number;
  motion?: { output: CharacterMotionOutput; priority?: number; time: number };
  expression?: {
    key: string;
    time?: number;
    /** Expression in effect immediately before the target's start time. */
    previousKey?: string | null;
  };
  lookAt?: {
    /** Gaze target: another character's id (“注视目标”). */
    target?: string;
    point?: readonly [number, number];
    /** Runtime actions written before the point tuple contract. */
    focusX?: number;
    focusY?: number;
    enabled?: boolean;
    intensity?: number;
    /** Reconstruction metadata for rendering an in-progress gaze transition. */
    startTime?: number;
    duration?: number;
    fromFocus?: readonly [number, number];
    toFocus?: readonly [number, number];
    focus?: readonly [number, number];
  };
  blink?: { enabled: boolean; intervalMs: number; startTime?: number; intervalRangeMs?: number };
  z?: number;
}

interface CharSyncInput {
  time: number;
  desiredChars: Map<string, DesiredCharState>;
  transformationProxies: ProxyRegistry;
  snapshotStore: SnapshotStore;
  shouldCancel: () => boolean;
  skipHardReset: boolean;
  isScrubbing: boolean;
  /** Scene state immediately before a motion boundary, used to rebuild its fade source. */
  resolveStateAtTime?: (time: number) => ReadonlyMap<string, Pick<DesiredCharState, 'model' | 'lifecycleStartTime' | 'motion' | 'expression'>>;
  /** Scene frame rate for on-demand curve sampling (ADR-0033). */
  fps?: number;
}

function resolveSeekExpression(expression: DesiredCharState['expression'], sceneTime: number): Live2DSeekExpressionState {
  const startTime = expression?.time;
  return {
    key: expression?.key ?? null,
    elapsedSeconds: typeof startTime === 'number' && Number.isFinite(startTime)
      ? Math.max(0, sceneTime - startTime)
      : Number.POSITIVE_INFINITY,
  };
}

function snapshotBelongsToLifecycle(
  snapshotTime: number,
  modelSnapshot: ModelSnapshot | undefined,
  targetTime: number,
  lifecycleStartTime?: number,
): boolean {
  // A snapshot at the exact addCharacter timestamp may have been captured by
  // the previous lifecycle just before the entrance callback ran. Treat the
  // boundary as belonging to the new model only after it has advanced beyond
  // that timestamp; otherwise the old pose becomes the first fade-in source.
  if (typeof lifecycleStartTime === 'number' && snapshotTime <= lifecycleStartTime + 1e-6) {
    return false;
  }

  const motionStartTime = modelSnapshot?.motion?.startTime;
  if (typeof motionStartTime === 'number' && Number.isFinite(motionStartTime)) {
    // A stale snapshot can carry a future motion even when its store timestamp
    // is before the seek target (for example after editing and seeking back).
    if (motionStartTime > targetTime + 1e-6) return false;
    if (typeof lifecycleStartTime === 'number' && motionStartTime < lifecycleStartTime - 1e-6) {
      return false;
    }
  }

  return true;
}

interface Live2DMuscle {
  listCharacters(): string[];
  hasCharacter(id: string): boolean;
  getAllCharacters?(): Map<string, any>;
  applySnapshot(id: string, snap: any): void;
  captureSnapshot(id: string): any;
  restoreSeekState?(id: string, input: {
    snapshot?: any;
    handoffSnapshot?: any;
    targetSceneTime: number;
    motion?: { key: string; priority?: number; offset: number; sceneTime: number; fadeInSeconds?: number } | null;
    expression?: Live2DSeekExpressionState | null;
    isScrubbing?: boolean;
    preserveMotionForPlayback?: boolean;
  }): Promise<any>;
  playMotion(
    id: string,
    key: string,
    priority: number,
    offset: number,
    time: number,
    skipHardReset: boolean,
    handoffSnapshot?: ModelSnapshot | null,
  ): void;
  playCustomMotion?(
    id: string,
    motion: Extract<CharacterMotionOutput, { kind: 'custom' }>,
    sceneTime: number,
    handoffSnapshot?: ModelSnapshot | null,
  ): void;
  resetToIdle(id: string): void;
  setExpression(id: string, key: string): void;
  prepareExpressionForSeek?(id: string, key: string | null): void;
  setExpressionForSeek?(id: string, key: string | null, elapsedSeconds: number, previousKey?: string | null): Promise<void>;
  /**
   * Concrete Cubism 2 sampling targets of a loaded character. Used by the
   * seek-side `motionCurveCache.ensure` to convert a not-yet-cached resource
   * motion on demand (ADR-0033). Absent on runtimes without the sampler.
   */
  getMotionSamplerTargets?(id: string): readonly Cubism2MotionSamplerTarget[];
  lookAt(id: string, x: number, y: number, duration: number, options?: {
    fromX?: number;
    fromY?: number;
    elapsed?: number;
  }): void;
  getPoint?(id: string, pointName: 'head' | 'chest' | 'feet' | 'center'): { x: number; y: number } | null;
  setBlink?(
    id: string,
    enabled: boolean,
    intervalMs: number,
    sceneTimeSeconds?: number,
    startTimeSeconds?: number,
    intervalRangeMs?: number,
  ): void;
  applyProxyTransform(id: string, proxy: any, modelOverride?: any, camera?: any): void;
  setAutoUpdate(enabled: boolean): void;
  updateAll(dt: number, forceStep: boolean, manualTimeMs?: number): Promise<void>;
  isMotionLoading(): boolean;
  clearAllPendingMotions(): void;
  stopAllMotions(id: string): void;
  getMotionDuration?(id: string, key: string): number;
}

declare const UtSystem: {
  getUserTimeMSec(): number;
  setUserTimeMSec(ms: number): void;
} | undefined;

export class CharacterSynchronizer {
  private live2D: Live2DMuscle;

  constructor(live2D: Live2DMuscle) {
    this.live2D = live2D;
  }

  /**
   * Unified character synchronization for seek.
   *
   * Phases:
   *  1. Snapshot restore [Strictly Synchronous] — apply nearest snapshot
   *  2. State sync [Strictly Synchronous] — motion/expression/lookAt/proxy per character
   *
   * The legacy snapshot motion pre-population and 16ms forward simulation were
   * removed: every desired resource motion resolves to its target offset
   * directly in Phase 2, from the derived curve cache (pure evaluation) or from
   * the SDK fast-forward fallback for permanent misses.
   */
  async syncTo(input: CharSyncInput): Promise<void> {
    const { time, desiredChars, transformationProxies, snapshotStore, shouldCancel, skipHardReset, isScrubbing } = input;

    // Resolve cache-backed resource motions once so the legacy snapshot-forward
    // path can be skipped for characters whose motion is already available as
    // per-frame derived curves (ADR-0033).
    const cachedResourceMotions = new Map<string, CachedResourceMotion>();
    const ensureTargets: Array<{ id: string; source: MotionCurveCacheSource }> = [];
    for (const [id, state] of desiredChars) {
      const motion = state.motion;
      if (!motion || motion.output.kind !== 'resource') continue;
      const entry = this.live2D.getAllCharacters?.().get(id);
      if (!entry) continue;
      const cacheKey = {
        adapterId: entry.runtime?.adapterId ?? entry.adapterId ?? '',
        modelRuntimePath: entry.modelPath,
        motionKey: motion.output.key,
      };
      const cached = motionCurveCache.get(cacheKey);
      if (cached) {
        cachedResourceMotions.set(id, cached);
        continue;
      }
      // Permanently-rejected keys stay on the SDK path without re-sampling.
      if (motionCurveCache.missReason(cacheKey)) continue;
      const targets = this.live2D.getMotionSamplerTargets?.(id) ?? [];
      if (targets.length === 0) continue;
      ensureTargets.push({ id, source: { ...cacheKey, targets, fps: input.fps ?? 60 } });
    }

    // Seek-side ensure: a not-yet-sampled but convertible resource motion is
    // sampled once during the seek so the target frame resolves on the shared
    // pure evaluator instead of the SDK fast-forward. Permanently-rejected keys
    // were excluded above, so this never re-attempts a doomed sample and a
    // genuine conversion failure still falls back to the SDK path.
    if (ensureTargets.length > 0) {
      const results = await Promise.allSettled(
        ensureTargets.map(({ source }) => motionCurveCache.ensure(source)),
      );
      if (shouldCancel()) return;
      results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value) {
          cachedResourceMotions.set(ensureTargets[index].id, result.value);
        }
      });
    }

    // Report which desired resource motions still fall back to the SDK path so
    // the seek report can explain a non-zero motionStep (ADR-0033).
    for (const [id, state] of desiredChars) {
      const motion = state.motion;
      if (!motion || motion.output.kind !== 'resource') continue;
      if (cachedResourceMotions.has(id)) continue;
      const entry = this.live2D.getAllCharacters?.().get(id);
      if (!entry) continue;
      const reason = motionCurveCache.missReason({
        adapterId: entry.runtime?.adapterId ?? entry.adapterId ?? '',
        modelRuntimePath: entry.modelPath,
        motionKey: motion.output.key,
      }) ?? 'not-cached';
      seekProfiler.addCacheMiss(motion.output.key, reason);
    }

    // ── Phase 1: Snapshot Restore ──
    const snapshotRestoreStart = performance.now();
    const snap = snapshotStore.findBefore(time);
    // When the seek target lands inside a motion's fade-in window, keep the
    // motion-start snapshot as the handoff source; the seek frame's curve pose
    // must not become both ends of the fade (ADR-0029). Cache-backed resource
    // motions use the same handoff rule as authored custom motions.
    const customMotionHandoffSnapshots = new Map<string, ModelSnapshot>();
    const nativeMotionHandoffSnapshots = new Map<string, ModelSnapshot>();
    for (const [id, state] of desiredChars) {
      const motion = state.motion;
      const resolvedMotion = motion?.output.kind === 'custom'
        ? motion.output
        : cachedResourceMotions.get(id)?.motion;
      if (!motion || !resolvedMotion) continue;
      const fadeInSeconds = resolvedMotion.tracks.reduce(
        (longest, track) => Math.max(longest, track.fadeInSeconds ?? resolvedMotion.fadeInSeconds),
        resolvedMotion.fadeInSeconds,
      );
      const startTime = motion.time;
      if (fadeInSeconds > 0 && time >= startTime && time - startTime < fadeInSeconds) {
        const startSnap = snapshotStore.findBefore(startTime);
        const candidate = startSnap?.models.get(id);
        const modelSnap = startSnap && snapshotBelongsToLifecycle(
          startSnap.time,
          candidate,
          startTime,
          state.lifecycleStartTime,
        ) ? candidate : undefined;
        if (modelSnap) customMotionHandoffSnapshots.set(id, modelSnap);
      }
    }
    for (const [id, state] of desiredChars) {
      const motion = state.motion;
      if (!motion || motion.output.kind !== 'resource') continue;
      const startSnap = snapshotStore.findBefore(motion.time);
      const candidate = startSnap?.models.get(id);
      const modelSnap = startSnap && snapshotBelongsToLifecycle(
        startSnap.time,
        candidate,
        time,
        state.lifecycleStartTime,
      ) && (!candidate?.motion
        || typeof candidate.motion.startTime !== 'number'
        || candidate.motion.startTime < motion.time - 1e-6)
        ? candidate
        : undefined;
      if (modelSnap) nativeMotionHandoffSnapshots.set(id, modelSnap);
    }
    const nativeSeekInputs = new Map<string, {
      snapshot?: any;
      handoffSnapshot?: any;
      targetSceneTime: number;
      motion?: { key: string; priority?: number; offset: number; sceneTime: number } | null;
      expression?: Live2DSeekExpressionState | null;
      isScrubbing?: boolean;
      preserveMotionForPlayback?: boolean;
    }>();
    const nativeSeekIds = new Set<string>();
    const pendingSeekExpressions: Array<{
      id: string;
      key: string | null;
      elapsedSeconds: number;
      previousKey?: string | null;
    }> = [];

    for (const [id, state] of desiredChars) {
      const entry = this.live2D.getAllCharacters?.().get(id);
      if (entry?.runtime?.adapterId !== 'untitled-pixi-live2d-engine-cubism' || !this.live2D.restoreSeekState || !this.live2D.hasCharacter(id)) {
        continue;
      }
      const motion = state.motion && state.motion.output.kind === 'resource'
        ? {
          key: state.motion.output.key,
          priority: state.motion.priority ?? 3,
          offset: this.getMotionOffset(id, state.motion, time),
          sceneTime: time,
          ...(state.motion.output.fadeInSeconds !== undefined
            ? { fadeInSeconds: state.motion.output.fadeInSeconds }
            : {}),
        }
        : null;
      nativeSeekInputs.set(id, {
        snapshot: snap?.models.get(id) ?? null,
        handoffSnapshot: nativeMotionHandoffSnapshots.get(id) ?? null,
        targetSceneTime: time,
        motion,
        expression: resolveSeekExpression(state.expression, time),
        isScrubbing,
        preserveMotionForPlayback: !isScrubbing,
      });
    }

    const restoredSnapshotIds = new Set<string>();
    if (snap) {
      // Synchronously apply snapshots to all loaded models. The legacy motion
      // pre-population and forward simulation (freeze=false path) were removed:
      // every desired resource motion is resolved to its target offset directly
      // in Phase 3, either from the derived curve cache (pure evaluation) or
      // from the SDK fast-forward fallback for permanent misses.
      for (const [id, modelSnap] of snap.models) {
        if (nativeSeekInputs.has(id)) continue;
        const state = desiredChars.get(id);
        const belongsToCurrentLifecycle = snapshotBelongsToLifecycle(
          snap.time,
          modelSnap,
          time,
          state?.lifecycleStartTime,
        );
        if (belongsToCurrentLifecycle && this.live2D.hasCharacter(id)) {
          this.live2D.applySnapshot(id, modelSnap);
          restoredSnapshotIds.add(id);
        }
      }
    }

    seekProfiler.addTime('snapshot-restore', performance.now() - snapshotRestoreStart);
    const nativeRestoreStart = performance.now();

    // Restore Cubism 5 after any legacy Cubism 2.1 forward simulation so mixed
    // seek steps cannot advance the official runtime away from the target time.
    for (const [id, restoreInput] of nativeSeekInputs) {
      const current = desiredChars.get(id);
      const motionStartTime = current?.motion?.time;
      const startSnap = motionStartTime === undefined ? null : snapshotStore.findBefore(motionStartTime);
      // A snapshot taken earlier in the previous action is not its pose at
      // this handoff. Rebuild that action at the boundary before starting the
      // new one, so paused seek and per-frame export use the same fade source
      // as continuous playback.
      if (current?.motion?.output.kind === 'resource'
        && motionStartTime !== undefined
        && (!startSnap || startSnap.time < motionStartTime - 1e-6 || !nativeMotionHandoffSnapshots.has(id))
        && input.resolveStateAtTime) {
        const previous = input.resolveStateAtTime(motionStartTime - 1e-6).get(id);
        const previousMotion = previous?.motion;
        if (previous?.model === current.model
          && previous?.lifecycleStartTime === current.lifecycleStartTime
          && previousMotion?.output.kind === 'resource'
          && previousMotion.time < motionStartTime - 1e-6) {
          const previousStartSnap = snapshotStore.findBefore(previousMotion.time);
          const previousStartCandidate = previousStartSnap?.models.get(id);
          const previousHandoff = previousStartSnap && snapshotBelongsToLifecycle(
            previousStartSnap.time,
            previousStartCandidate,
            previousMotion.time,
            current.lifecycleStartTime,
          ) && (!previousStartCandidate?.motion
            || typeof previousStartCandidate.motion.startTime !== 'number'
            || previousStartCandidate.motion.startTime < previousMotion.time - 1e-6)
            ? previousStartCandidate
            : null;
          await this.live2D.restoreSeekState?.(id, {
            snapshot: previousHandoff,
            handoffSnapshot: previousHandoff,
            targetSceneTime: motionStartTime,
            motion: {
              key: previousMotion.output.key,
              priority: previousMotion.priority ?? 3,
              offset: motionStartTime - previousMotion.time,
              sceneTime: motionStartTime,
              ...(previousMotion.output.fadeInSeconds !== undefined
                ? { fadeInSeconds: previousMotion.output.fadeInSeconds }
                : {}),
            },
            expression: resolveSeekExpression(previous.expression, motionStartTime),
            isScrubbing: true,
          });
          if (shouldCancel()) return;
          restoreInput.handoffSnapshot = this.live2D.captureSnapshot(id) ?? restoreInput.handoffSnapshot;
        }
      }
      await this.live2D.restoreSeekState?.(id, restoreInput);
      nativeSeekIds.add(id);
      if (shouldCancel()) {
        seekProfiler.addTime('native-restore', performance.now() - nativeRestoreStart);
        return;
      }
    }
    seekProfiler.addTime('native-restore', performance.now() - nativeRestoreStart);

    // Native Cubism 5 restore touches the model internals only. Timeline-owned
    // transforms, especially entrance opacity proxies, must remain authoritative
    // after restore so playback can continue fading from the seeked frame.
    for (const id of nativeSeekIds) {
      const proxy = transformationProxies.get(id);
      if (proxy && this.live2D.hasCharacter(id)) {
        this.live2D.applyProxyTransform(id, proxy);
      }
    }

    // ── Phase 3: State Sync [Strictly Synchronous] ──
    const stateSyncStart = performance.now();
    if (shouldCancel()) return;
    // Reset opacities of transformation proxies whose characters are no longer in the desired state
    transformationProxies.forEach((proxy, id) => {
      if (shouldCancel()) return;
      if (!desiredChars.has(id)) {
        proxy.opacity = 0;
      }
      if (this.live2D.hasCharacter(id)) {
        this.live2D.applyProxyTransform(id, proxy);
      }
    });

    for (const [id, state] of desiredChars) {
      if (shouldCancel()) return;
      if (this.live2D.hasCharacter(id)) {
        const expressionKey = state.expression?.key ?? null;
        if (!nativeSeekIds.has(id)) {
          this.live2D.prepareExpressionForSeek?.(id, expressionKey);
        }
        if (state.motion) {
          const offset = this.getMotionOffset(id, state.motion, time);
          if (!nativeSeekIds.has(id)) {
            this.playDesiredMotion(
              id,
              state.motion,
              offset,
              time,
              skipHardReset || isScrubbing,
              customMotionHandoffSnapshots.get(id),
            );
          }
        } else if (!isScrubbing) {
          if (!nativeSeekIds.has(id)) this.live2D.resetToIdle(id);
        } else {
          if (!nativeSeekIds.has(id)) {
            this.live2D.stopAllMotions(id);
            if (!restoredSnapshotIds.has(id)) {
              this.live2D.resetToIdle(id);
            }
          }
        }
        if (!nativeSeekIds.has(id)) {
          // Expressions fade in from their start scene time with the SDK
          // fade-in window. Seek reconstruction passes the real elapsed time
          // so the seeked frame shows the fade-in progress (previous pose at
          // the expression's first frame, partial blend inside the window),
          // matching how motion seeks resume in-flight fades (ADR-0029).
          // States without a recorded start time (hand-built/legacy) keep the
          // full latch so they always resolve to the final expression.
          const expressionTime = state.expression?.time;
          const elapsedSeconds = typeof expressionTime === 'number' && Number.isFinite(expressionTime)
            ? Math.max(0, time - expressionTime)
            : Number.POSITIVE_INFINITY;
          if (this.live2D.setExpressionForSeek) {
            pendingSeekExpressions.push({
              id,
              key: expressionKey,
              elapsedSeconds,
              previousKey: state.expression?.previousKey,
            });
          } else if (state.expression) {
            this.live2D.setExpression(id, expressionKey!);
          } else {
            this.live2D.setExpression(id, '');
          }
        }
        // bind keeps Live2DManager.getPoint's `this` intact when the lookup
        // closure invokes it; a bare extraction would crash on `this.characters`.
        const lookup = this.live2D.getPoint?.bind(this.live2D);
        if (!state.lookAt) {
          this.live2D.lookAt(id, 0, 0, 0);
        } else {
          const isTargetFollow = typeof state.lookAt.target === 'string' && state.lookAt.target.trim();
          const targetFollowFocus = isTargetFollow && Array.isArray(state.lookAt.focus)
            ? state.lookAt.focus
            : null;
          if (targetFollowFocus) {
            // Target-follow gaze is resolved continuously by RuntimeSceneState;
            // a seek must freeze exactly on that frame's target direction.
            this.live2D.lookAt(id, targetFollowFocus[0], targetFollowFocus[1], 0);
          } else {
            const toFocus = Array.isArray(state.lookAt.toFocus)
              ? state.lookAt.toFocus
              : resolveLookAtFocus(state.lookAt, lookup, id);
            const startTime = state.lookAt.startTime;
            const duration = state.lookAt.duration;
            if (typeof startTime !== 'number' || typeof duration !== 'number') {
              // Hand-built/legacy desired states carry no transition metadata:
              // fall back to the previous absolute seek behavior.
              this.live2D.lookAt(id, toFocus[0], toFocus[1], 0);
            } else {
              const elapsed = Math.max(0, time - startTime);
              const remaining = Math.max(0, duration - elapsed);
              if (remaining <= 0) {
                this.live2D.lookAt(id, toFocus[0], toFocus[1], 0);
              } else {
                const fromFocus = Array.isArray(state.lookAt.fromFocus)
                  ? state.lookAt.fromFocus
                  : [0, 0] as const;
                this.live2D.lookAt(
                  id,
                  toFocus[0],
                  toFocus[1],
                  remaining,
                  {
                    fromX: fromFocus[0],
                    fromY: fromFocus[1],
                    elapsed,
                  },
                );
              }
            }
          }
        }
        if (state.blink) {
          if (state.blink.intervalRangeMs !== undefined) {
            this.live2D.setBlink?.(
              id,
              state.blink.enabled,
              state.blink.intervalMs,
              time,
              state.blink.startTime,
              state.blink.intervalRangeMs,
            );
          } else {
            this.live2D.setBlink?.(
              id,
              state.blink.enabled,
              state.blink.intervalMs,
              time,
              state.blink.startTime,
            );
          }
        } else {
          this.live2D.setBlink?.(id, false, 4000, time, 0);
        }

        // Sync proxy state
        const proxy = transformationProxies.get(id);
        if (proxy) {
          if (state.position !== undefined) {
            proxy.x = state.position[0] * 1920;
            proxy.y = state.position[1] * 1080;
          }
          if (state.scale !== undefined) proxy.scale = state.scale;
          if (state.rotation !== undefined) proxy.rotation = state.rotation;
          if (state.opacity !== undefined) proxy.opacity = state.opacity;
          if (state.z !== undefined) proxy.z = state.z;
          this.live2D.applyProxyTransform(id, proxy);
        }
      }
    }

    // ── Post-sync Flush ──
    // Seek/scrub synchronization must resolve queued motion commands for the
    // target frame before the expression overlay is applied. Advancing here
    // would visibly step a paused seek.
    if (shouldCancel()) return;
    await this.live2D.updateAll(0, true, time * 1000);
    if (shouldCancel()) return;
    for (const expression of pendingSeekExpressions) {
      await this.live2D.setExpressionForSeek?.(
        expression.id,
        expression.key,
        // The SDK expression pipeline is a point-in-time latch seeded at its
        // start time: passing the scene elapsed lets the fade weight be
        // reconstructed at the seeked position (first frame keeps the previous
        // pose, the window blends, past the window latches fully), while
        // playback continues the fade from that very progress.
        expression.elapsedSeconds,
        expression.previousKey,
      );
      if (shouldCancel()) return;
    }
    seekProfiler.addTime('state-sync', performance.now() - stateSyncStart);
    this.live2D.setAutoUpdate(false);
  }

  private getMotionOffset(
    _id: string,
    motion: NonNullable<DesiredCharState['motion']>,
    time: number,
  ): number {
    // v3 motions are single-shot: seek offsets are not wrapped by any loop or
    // runtime duration (ADR-0029). The SDK motion holds its tail pose instead
    // of auto-replaying.
    return Math.max(0, time - motion.time);
  }

  private playDesiredMotion(
    id: string,
    motion: NonNullable<DesiredCharState['motion']>,
    offset: number,
    time: number,
    skipHardReset: boolean,
    handoffSnapshot?: ModelSnapshot,
  ): void {
    if (motion.output.kind === 'custom') {
      if (this.live2D.playCustomMotion) {
        this.live2D.playCustomMotion(id, motion.output, time - offset, handoffSnapshot);
        return;
      }
      return;
    }
    if (handoffSnapshot) {
      this.live2D.playMotion(id, motion.output.key, motion.priority ?? 3, offset, time, skipHardReset, handoffSnapshot);
    } else {
      this.live2D.playMotion(id, motion.output.key, motion.priority ?? 3, offset, time, skipHardReset);
    }
  }
}
