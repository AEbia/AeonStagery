/**
 * AeonStagery — Bake Motion Runtime
 *
 * Runtime module that owns Live2D motion intent for a Bake run.
 *
 *  - `prepare()` freezes an immutable MotionPlan before the Bake loop starts:
 *    unique (adapterId, modelRuntimePath, motionKey) cache lookups are
 *    performed once, cache hits pin the CachedResourceMotion object so later
 *    LRU eviction cannot remove it mid-bake, and permanent cache misses are
 *    preloaded on the SDK path.
 *  - `applyIntent()` evaluates curve-backed motions (authored custom + cached
 *    resource) and tracks native SDK motions using the timeline intent as its
 *    state source. It never consults the cache and never performs async work
 *    inside the Bake tick.
 *  - `pendingNativeStart()` returns a domain motion intent. The runtime-owned
 *    Bake frame batch performs its transition and records the result.
 *
 * BakeEngine therefore stops regenerating `_pendingPlayMotion` per frame and
 * stops duplicating Live2DMotionController's `_executePlayMotion`.
 */

import type { CharacterMotionOutput } from '../api/types/semantic-scene';
import {
  motionCurveCache,
  motionCurveCacheKey,
  type CachedResourceMotion,
  type MotionCurveCacheKey,
  type MotionCurveCacheSource,
} from './live2d/motionCurveCache';
import type { Live2DMotionSamplingResult, Live2DPerformanceTransitionResult } from './runtime/Live2DRuntimeContracts';
import {
  applyCustomMotionValues,
  customMotionControlledParameterIds,
  evaluateCustomMotionRuntime,
  resolveTrackFadeInSeconds,
  seedCustomMotionFadeResumeFrames,
  type CustomMotionFadeResumeFrames,
  type CustomMotionHandoffPose,
} from './live2d/customMotionRuntime';

export interface BakeMotionPlanRequest {
  readonly charId: string;
  readonly adapterId: string;
  readonly modelRuntimePath: string;
  readonly motionKey: string;
}

export type BakeMotionPlanResolution =
  | {
      readonly kind: 'curve';
      readonly cacheKey: MotionCurveCacheKey;
      readonly cacheEntry: CachedResourceMotion;
    }
  | {
      readonly kind: 'native';
      readonly cacheKey: MotionCurveCacheKey;
      readonly missReason: string | null;
    };

export interface BakeMotionPlanEntry {
  readonly charId: string;
  readonly motionKey: string;
  readonly resolution: BakeMotionPlanResolution;
}

export interface BakeMotionPlan {
  readonly entries: readonly BakeMotionPlanEntry[];
  readonly byCacheKey: ReadonlyMap<string, BakeMotionPlanResolution>;
}

export interface BakeMotionRuntimeHost {
  /** Scene frame rate used for on-demand curve cache sampling. */
  readonly fps: number;
  sampleMotion?(charId: string, motionKey: string, options: { fps: number; zeroSourceFades?: boolean; skipMissingParameters?: boolean }): Promise<Live2DMotionSamplingResult>;
  preloadMotion(charId: string, motionKey: string): Promise<void>;
  getBaseValues(
    charId: string,
    controlledParameterIds: readonly string[],
    excludeParameterIds?: ReadonlySet<string>,
  ): Record<string, number>;
  /**
   * Scene time of the seed snapshot this bake resumed from, if any.
   * A seed strictly after a curve motion's start means the current pose is
   * already mid-fade and must continue the 60Hz accumulation (ADR-0029).
   */
  getSeedSceneTime?(): number | undefined;
}

export interface BakeMotionRuntimeReport {
  readonly uniqueCurveKeys: number;
  readonly uniqueNativeKeys: number;
  readonly nativePreloads: number;
  /** Number of Bake frames that resolved a resource motion through the curve cache. */
  readonly cacheHitFrames: number;
  /** Number of Bake frames that fell back to the native SDK path. */
  readonly cacheMissFrames: number;
  readonly nativeStarts: number;
  readonly offsetReplayMs: number;
}

interface CurveDriverState {
  readonly motion: Extract<CharacterMotionOutput, { kind: 'custom' }>;
  readonly startSceneTime: number;
  readonly handoff: CustomMotionHandoffPose;
}

interface NativeDriverState {
  readonly motionKey: string;
  readonly startSceneTime: number;
  readonly priority: number;
  readonly fadeInSeconds?: number;
  lastSimTime: number;
  lastOffset: number;
  started: boolean;
}

interface PendingNativeStart {
  readonly motionKey: string;
  readonly priority: number;
  readonly fadeInSeconds?: number;
  readonly startSceneTime: number;
  readonly offset: number;
  readonly simTime: number;
  readonly missReason: string | null;
}

interface CharacterRuntimeState {
  curve?: CurveDriverState;
  native?: NativeDriverState;
  pendingNativeStart?: PendingNativeStart;
  nativeStopPending?: boolean;
}

interface CacheServiceLike {
  ensure(source: MotionCurveCacheSource): Promise<CachedResourceMotion | null>;
  missReason(key: MotionCurveCacheKey): string | null;
}

export interface BakeMotionIntent {
  readonly output: CharacterMotionOutput;
  readonly priority?: number;
  readonly time: number;
}

export interface BakeMotionApplyInput {
  readonly charId: string;
  readonly intent: BakeMotionIntent | null;
  readonly simTime: number;
  readonly injectedParams: Record<string, number>;
  readonly channelProtected?: ReadonlySet<string>;
}

export type BakeMotionApplyResult =
  | { driver: 'none'; nativeStartRequested: false; nativeStopRequested: boolean }
  | { driver: 'curve'; nativeStartRequested: false; nativeStopRequested: boolean; motion: Extract<CharacterMotionOutput, { kind: 'custom' }> }
  | { driver: 'native'; nativeStartRequested: boolean; nativeStopRequested: false; nativeKey: string; offset: number };

export interface BakeMotionNativeStart {
  readonly charId: string;
  readonly motionKey: string;
  readonly priority: number;
  readonly offsetSeconds: number;
  readonly sceneTimeSeconds: number;
  readonly fadeInSeconds?: number;
}

export interface BakeMotionStartCompletion {
  readonly status: 'started' | 'missing' | 'cancelled' | 'ignored';
  readonly offsetReplayMs: number;
}


export class BakeMotionRuntime {
  private readonly states = new Map<string, CharacterRuntimeState>();
  private readonly planByChar = new Map<string, Map<string, BakeMotionPlanEntry>>();
  private readonly planByCacheKey = new Map<string, BakeMotionPlanResolution>();
  private reportValues: BakeMotionRuntimeReport = {
    uniqueCurveKeys: 0,
    uniqueNativeKeys: 0,
    nativePreloads: 0,
    cacheHitFrames: 0,
    cacheMissFrames: 0,
    nativeStarts: 0,
    offsetReplayMs: 0,
  };

  constructor(
    private readonly host: BakeMotionRuntimeHost,
    private readonly cache: CacheServiceLike = motionCurveCache,
  ) {}

  async prepare(requests: readonly BakeMotionPlanRequest[]): Promise<BakeMotionPlan> {
    const seenCache = new Set<string>();
    const seenCharMotion = new Set<string>();
    const entries: BakeMotionPlanEntry[] = [];

    for (const request of requests) {
      const cacheKey: MotionCurveCacheKey = {
        adapterId: request.adapterId,
        modelRuntimePath: request.modelRuntimePath,
        motionKey: request.motionKey,
      };
      const cacheKeyString = motionCurveCacheKey(cacheKey);
      const charMotionKey = `${request.charId}\u0000${cacheKeyString}`;
      if (seenCharMotion.has(charMotionKey)) continue;
      seenCharMotion.add(charMotionKey);

      let resolution = this.planByCacheKey.get(cacheKeyString);
      if (!resolution) {
        if (!seenCache.has(cacheKeyString)) {
          seenCache.add(cacheKeyString);
          const source: MotionCurveCacheSource = {
            ...cacheKey,
            fps: this.host.fps,
            ...(this.host.sampleMotion
              ? { sample: (options) => this.host.sampleMotion!(request.charId, request.motionKey, options) }
              : {}),
          };
          const cacheEntry = await this.cache.ensure(source);
          if (cacheEntry) {
            resolution = { kind: 'curve', cacheKey, cacheEntry };
            this.reportValues = { ...this.reportValues, uniqueCurveKeys: this.reportValues.uniqueCurveKeys + 1 };
          } else {
            resolution = {
              kind: 'native',
              cacheKey,
              missReason: this.cache.missReason(cacheKey),
            };
            this.reportValues = { ...this.reportValues, uniqueNativeKeys: this.reportValues.uniqueNativeKeys + 1 };
          }
          this.planByCacheKey.set(cacheKeyString, resolution);
        } else {
          resolution = this.planByCacheKey.get(cacheKeyString)!;
        }
      }

      if (resolution.kind === 'native') {
        await this.host.preloadMotion(request.charId, request.motionKey);
        this.reportValues = { ...this.reportValues, nativePreloads: this.reportValues.nativePreloads + 1 };
      }

      entries.push({ charId: request.charId, motionKey: request.motionKey, resolution });
    }

    this.planByChar.clear();
    for (const entry of entries) {
      let byMotion = this.planByChar.get(entry.charId);
      if (!byMotion) {
        byMotion = new Map();
        this.planByChar.set(entry.charId, byMotion);
      }
      byMotion.set(entry.motionKey, entry);
    }

    return {
      entries,
      byCacheKey: this.planByCacheKey,
    };
  }

  report(): BakeMotionRuntimeReport {
    return this.reportValues;
  }

  applyIntent(input: BakeMotionApplyInput): BakeMotionApplyResult {
    const charId = input.charId;
    const state = this.getOrCreateState(charId);
    const { injectedParams } = input;

    if (!input.intent) {
      this.clearCurveDriver(state, injectedParams);
      const nativeStopRequested = this.resetNativeDriver(state);
      return { driver: 'none', nativeStartRequested: false, nativeStopRequested };
    }

    const motion = input.intent.output;
    if (motion.kind === 'custom') {
      const nativeStopRequested = this.resetNativeDriver(state);
      this.applyCurveDriver(state, charId, motion, input.intent.time ?? input.simTime, input.simTime, injectedParams, input.channelProtected);
      return { driver: 'curve', nativeStartRequested: false, nativeStopRequested, motion };
    }

    const planEntry = this.planByChar.get(charId)?.get(motion.key);
    if (planEntry?.resolution.kind === 'curve') {
      const nativeStopRequested = this.resetNativeDriver(state);
      this.applyCurveDriver(state, charId, planEntry.resolution.cacheEntry.motion, input.intent.time ?? input.simTime, input.simTime, injectedParams, input.channelProtected);
      this.reportValues = { ...this.reportValues, cacheHitFrames: this.reportValues.cacheHitFrames + 1 };
      return { driver: 'curve', nativeStartRequested: false, nativeStopRequested, motion: planEntry.resolution.cacheEntry.motion };
    }

    // Native SDK path: use the timeline intent as the only restart state source.
    this.clearCurveDriver(state, injectedParams);
    const startSceneTime = input.intent.time ?? input.simTime;
    const offset = Math.max(0, input.simTime - startSceneTime);
    const priority = input.intent.priority ?? 3;
    const needsStart = this.nativeNeedsStart(state.native, {
      motionKey: motion.key,
      startSceneTime,
      priority,
      fadeInSeconds: motion.fadeInSeconds,
      simTime: input.simTime,
    });

    if (needsStart) {
      state.pendingNativeStart = {
        motionKey: motion.key,
        priority,
        fadeInSeconds: motion.fadeInSeconds,
        startSceneTime,
        offset,
        simTime: input.simTime,
        missReason: planEntry?.resolution.kind === 'native' ? planEntry.resolution.missReason : 'not-cached',
      };
    }

    if (state.native) {
      state.native.lastSimTime = input.simTime;
      state.native.lastOffset = offset;
    }
    this.reportValues = { ...this.reportValues, cacheMissFrames: this.reportValues.cacheMissFrames + 1 };

    return {
      driver: 'native',
      nativeStartRequested: needsStart,
      nativeStopRequested: false,
      nativeKey: motion.key,
      offset,
    };
  }

  pendingNativeStart(charId: string): BakeMotionNativeStart | undefined {
    const state = this.states.get(charId);
    const pending = state?.pendingNativeStart;
    if (!pending) return undefined;
    return {
      charId,
      motionKey: pending.motionKey,
      priority: pending.priority,
      offsetSeconds: pending.offset,
      sceneTimeSeconds: pending.simTime,
      fadeInSeconds: pending.fadeInSeconds,
    };
  }

  hasPendingNativeStop(charId: string): boolean {
    return this.states.get(charId)?.nativeStopPending === true;
  }

  completeNativeStop(charId: string): void {
    const state = this.states.get(charId);
    if (state) state.nativeStopPending = false;
  }

  completeNativeStart(charId: string, result: Live2DPerformanceTransitionResult): BakeMotionStartCompletion {
    const state = this.states.get(charId);
    const pending = state?.pendingNativeStart;
    if (!state || !pending) {
      return { status: 'ignored', offsetReplayMs: 0 };
    }

    if (result.status !== 'started') {
      state.pendingNativeStart = undefined;
      return { status: result.status, offsetReplayMs: 0 };
    }

    const offsetReplayMs = result.offsetReplayMs;
    state.native = {
      motionKey: pending.motionKey,
      startSceneTime: pending.startSceneTime,
      priority: pending.priority,
      fadeInSeconds: pending.fadeInSeconds,
      lastSimTime: pending.simTime,
      lastOffset: pending.offset,
      started: true,
    };
    state.pendingNativeStart = undefined;
    this.reportValues = {
      ...this.reportValues,
      nativeStarts: this.reportValues.nativeStarts + 1,
      offsetReplayMs: this.reportValues.offsetReplayMs + offsetReplayMs,
    };

    return { status: 'started', offsetReplayMs };
  }

  private getOrCreateState(charId: string): CharacterRuntimeState {
    let state = this.states.get(charId);
    if (!state) {
      state = {};
      this.states.set(charId, state);
    }
    return state;
  }

  private clearCurveDriver(state: CharacterRuntimeState, injectedParams: Record<string, number>): void {
    if (!state.curve) return;
    for (const parameterId of customMotionControlledParameterIds(state.curve.motion)) {
      delete injectedParams[parameterId];
    }
    state.curve = undefined;
  }

  private resetNativeDriver(state: CharacterRuntimeState): boolean {
    const shouldStop = !!state.native || !!state.pendingNativeStart;
    state.nativeStopPending = state.nativeStopPending || shouldStop;
    state.native = undefined;
    state.pendingNativeStart = undefined;
    return state.nativeStopPending;
  }

  private applyCurveDriver(
    state: CharacterRuntimeState,
    charId: string,
    motion: Extract<CharacterMotionOutput, { kind: 'custom' }>,
    startSceneTime: number,
    simTime: number,
    injectedParams: Record<string, number>,
    channelProtected?: ReadonlySet<string>,
  ): void {
    let active = state.curve;
    if (!active || active.motion !== motion || active.startSceneTime !== startSceneTime) {
      const controlled = customMotionControlledParameterIds(motion);
      const baseValues = this.host.getBaseValues(charId, controlled, channelProtected);
      const localTime = Math.max(0, simTime - startSceneTime);
      const longestFade = motion.tracks.reduce(
        (longest, track) => Math.max(longest, resolveTrackFadeInSeconds(track, motion.fadeInSeconds)),
        motion.fadeInSeconds,
      );
      const seedSceneTime = this.host.getSeedSceneTime?.();
      const resumeFromSeed = Number.isFinite(seedSceneTime)
        && (seedSceneTime as number) > startSceneTime
        && longestFade > 0
        && localTime > 0
        && localTime < longestFade;
      // Seed the 60Hz accumulation with the SNAPSHOT CAPTURE TIME
      // (seedSceneTime - startSceneTime), not the range-start frame number.
      // The restored pose is the seed snapshot's pose; seeding by rangeStart
      // would fill every frame up to the first simulated frame with that stale
      // pose and freeze the whole interval instead of continuing the fade
      // (frames between seed and rangeStart are then never re-accumulated).
      const resumeLocalTime = Number.isFinite(seedSceneTime)
        ? Math.max(0, (seedSceneTime as number) - startSceneTime)
        : 0;
      const resumeFrames: CustomMotionFadeResumeFrames | undefined = resumeFromSeed
        ? seedCustomMotionFadeResumeFrames(resumeLocalTime, baseValues)
        : undefined;
      const handoff: CustomMotionHandoffPose = resumeFrames
        ? { values: baseValues, resumeFrames }
        : { values: baseValues };
      this.clearCurveDriver(state, injectedParams);
      active = { motion, startSceneTime, handoff };
      state.curve = active;
    }
    const evaluation = evaluateCustomMotionRuntime(motion, startSceneTime, simTime, active.handoff);
    applyCustomMotionValues(injectedParams, customMotionControlledParameterIds(motion), evaluation.values, channelProtected);
  }

  private nativeNeedsStart(
    native: NativeDriverState | undefined,
    next: { motionKey: string; startSceneTime: number; priority: number; fadeInSeconds?: number; simTime: number },
  ): boolean {
    if (!native) return true;
    if (!native.started) return true;
    if (native.motionKey !== next.motionKey) return true;
    if (native.startSceneTime !== next.startSceneTime) return true;
    if (native.priority !== next.priority) return true;
    if (native.fadeInSeconds !== next.fadeInSeconds) return true;
    if (next.simTime < native.lastSimTime - 1e-6) return true;
    return false;
  }
}
