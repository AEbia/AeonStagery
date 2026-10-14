/**
 * AeonStagery — Resource Motion Curve Cache
 *
 * Hidden runtime cache that converts ordinary resource motions into per-frame
 * linear keyframe curves (derived data only). It never mutates the scene
 * document: the scene keeps `kind: 'resource'` motion references while the
 * cache synthesizes an in-memory `kind: 'custom'` motion for evaluation.
 *
 * The cache uses the same sampler/merger as the authoring conversion command
 * but is best-effort:
 *  - parameters missing on the target model are skipped,
 *  - any sample/merge failure is a cache miss and callers keep the SDK path,
 *  - source fades are NOT baked into the curves; they are stored as metadata
 *    so the shared `evaluateCustomMotionRuntime` can reproduce the same
 *    stateful fade-in behavior from the seek/play handoff pose.
 */

import type { CharacterMotionOutput } from '../../api/types/semantic-scene';
import { getLogger } from '../Logger';
import { buildCustomMotionTracks } from './customMotionConversion';
import { evaluateCustomMotion } from './customMotion';
import type { Live2DMotionSamplingResult } from '../runtime/Live2DRuntimeContracts';

export interface MotionCurveCacheKey {
  readonly adapterId: string;
  readonly modelRuntimePath: string;
  readonly motionKey: string;
}

export interface MotionCurveCacheSource extends MotionCurveCacheKey {
  /** Bound runtime behavior that returns SDK-neutral sampled motion data. */
  readonly sample?: (options: { fps: number; zeroSourceFades?: boolean; skipMissingParameters?: boolean }) => Promise<Live2DMotionSamplingResult>;
  /** Scene frame rate for per-frame density. */
  readonly fps: number;
}

export interface CachedResourceMotion {
  readonly key: string;
  /** Synthesized per-frame custom motion (derived data, never persisted). */
  readonly motion: Extract<CharacterMotionOutput, { kind: 'custom' }>;
  readonly sourceFadeInSeconds?: number;
  readonly sourceFadeOutSeconds?: number;
  readonly isIdle: boolean;
  /** Pure curve evaluation at motion-local seconds (no fade reconstruction). */
  evaluate(localTime: number): Readonly<Record<string, number>>;
}

export interface MotionCurveCacheSampler {
  sample(input: {
    readonly adapterId: string;
    readonly modelRuntimePath: string;
    readonly motionKey: string;
    readonly fps: number;
    readonly zeroSourceFades: true;
    readonly skipMissingParameters: true;
  }): Promise<Live2DMotionSamplingResult>;
}

const DEFAULT_SAMPLER: MotionCurveCacheSampler = {
  sample: async () => ({ status: 'unsupported', diagnostics: ['No bound runtime sampler was provided.'] }),
};

export function motionCurveCacheKey(input: MotionCurveCacheKey): string {
  return `${input.adapterId}::${input.modelRuntimePath}::${input.motionKey}`;
}

export function isIdleMotionKey(motionKey: string): boolean {
  return motionKey.trim().toLowerCase() === 'idle';
}

/**
 * Effective source fade-in used by the pixi-live2d-display runtime when the
 * motion definition declares none: 0 for idle, 500ms for other motions.
 */
export function resolveEffectiveCubism2FadeInSeconds(
  meta: { durationSeconds: number; fadeInSeconds?: number },
  motionKey: string,
): number {
  return meta.fadeInSeconds ?? (isIdleMotionKey(motionKey) ? 0 : 0.5);
}

export const RESOURCE_MOTION_CACHE_BUDGET_BYTES = 512 * 1024 * 1024;

/**
 * Estimated per-keyframe byte cost used by the memory-budget eviction, kept
 * at the V8-calibrated realism level: a plain `{ time, value }` object costs
 * roughly the object header + property map + two in-object doubles +
 * array-slot overhead (~48 bytes). The optional linear segment reference is
 * amortized into the per-track overhead. Deterministic so the budget is a
 * stable contract and `budgetBytes` approximately equals the real RSS of the
 * cached keyframes rather than a 2-3x underestimate.
 */
export const MOTION_CURVE_KEYFRAME_ESTIMATED_BYTES = 48;

/** Per-track overhead (track object, id string, fade fields, keyframe array). */
export const MOTION_CURVE_TRACK_OVERHEAD_ESTIMATED_BYTES = 128;

/**
 * Deterministic memory estimate for a cached derived-motion entry. Keyframes
 * dominate; tracks contribute a fixed per-track overhead.
 */
export function estimateCachedMotionBytes(entry: CachedResourceMotion): number {
  let keyframes = 0;
  for (const track of entry.motion.tracks) keyframes += track.keyframes.length;
  return keyframes * MOTION_CURVE_KEYFRAME_ESTIMATED_BYTES
    + entry.motion.tracks.length * MOTION_CURVE_TRACK_OVERHEAD_ESTIMATED_BYTES;
}

/** Console-diagnostics snapshot of the per-frame curve cache occupancy. */
export interface MotionCurveCacheStats {
  readonly entries: number;
  /** Total derived keyframes across all cached entries. */
  readonly keyframes: number;
  readonly bytesUsed: number;
  readonly budgetBytes: number;
  readonly motions: ReadonlyArray<{
    readonly key: string;
    readonly keyframes: number;
    readonly bytes: number;
  }>;
}

/**
 * Separate capacity bound for permanently-rejected keys. A key whose sampling
 * or conversion cannot succeed is recorded here so repeated ensure() calls
 * (scene reloads, seek-side ensures) return a fast miss instead of re-attempting
 * the doomed sample on every seek.
 */
export const RESOURCE_MOTION_CACHE_MAX_REJECTED_ENTRIES = 96;

export class MotionCurveCacheService {
  private readonly logger = getLogger('MotionCurveCache');
  private readonly entries = new Map<string, CachedResourceMotion>();
  private readonly inflight = new Map<string, Promise<CachedResourceMotion | null>>();
  /** Per-entry estimated byte weight (see `estimateCachedMotionBytes`). */
  private readonly entryBytes = new Map<string, number>();
  private usedBytes = 0;
  /** Permanent-miss registry: key -> miss-reason code (never re-sampled until invalidated/cleared). */
  private readonly rejected = new Map<string, string>();

  constructor(
    private readonly sampler: MotionCurveCacheSampler = DEFAULT_SAMPLER,
    private readonly budgetBytesValue: number = RESOURCE_MOTION_CACHE_BUDGET_BYTES,
  ) {}

  /** The configured memory budget in bytes (512MB by default). */
  get budgetBytes(): number {
    return this.budgetBytesValue;
  }

  /** Total estimated bytes of the currently cached entries (≤ budget, except a single oversized entry). */
  get bytesUsed(): number {
    return this.usedBytes;
  }

  get(input: MotionCurveCacheKey): CachedResourceMotion | null {
    return this.entries.get(motionCurveCacheKey(input)) ?? null;
  }

  /**
   * Return the cached entry or sample it in the background-cache style.
   * Sampling failures are not thrown: they produce a cache miss so callers
   * can safely fall back to the SDK motion path. A key that already failed is
   * recorded as a permanent miss and returns null without re-sampling.
   */
  ensure(source: MotionCurveCacheSource): Promise<CachedResourceMotion | null> {
    const key = motionCurveCacheKey(source);
    const existing = this.entries.get(key);
    if (existing) return Promise.resolve(existing);
    if (this.rejected.has(key)) return Promise.resolve(null);

    const busy = this.inflight.get(key);
    if (busy) return busy;

    const task = this.build(source).then((entry) => {
      if (entry) this.set(key, entry);
      return entry;
    }).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, task);
    return task;
  }

  /**
   * Miss-reason code for a key that can never be converted in this session
   * (sampling failure, no convertible curves, parts/layout curves, ...).
   * Returns null when the key is cached or simply not sampled yet — callers
   * that must distinguish "permanent miss" from "not ready yet" use this.
   */
  missReason(input: MotionCurveCacheKey): string | null {
    return this.rejected.get(motionCurveCacheKey(input)) ?? null;
  }

  invalidate(input: MotionCurveCacheKey): void {
    const key = motionCurveCacheKey(input);
    this.removeEntryBytes(key);
    this.entries.delete(key);
    this.rejected.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.rejected.clear();
    this.entryBytes.clear();
    this.usedBytes = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Test helper: list cached keys. */
  keys(): readonly string[] {
    return Array.from(this.entries.keys());
  }

  /**
   * Per-frame occupancy snapshot for console diagnostics —
   * `window.__AEON_MOTION_CURVE_CACHE.stats()` (the singleton is exposed on
   * the window by main.tsx). Cheap enough to call on demand; enumerates every
   * cached entry's tracks.
   */
  stats(): MotionCurveCacheStats {
    const motions: Array<{ key: string; keyframes: number; bytes: number }> = [];
    let keyframes = 0;
    for (const [key, entry] of this.entries) {
      let entryKeyframes = 0;
      for (const track of entry.motion.tracks) entryKeyframes += track.keyframes.length;
      keyframes += entryKeyframes;
      motions.push({ key, keyframes: entryKeyframes, bytes: estimateCachedMotionBytes(entry) });
    }
    return {
      entries: this.entries.size,
      keyframes,
      bytesUsed: this.usedBytes,
      budgetBytes: this.budgetBytesValue,
      motions,
    };
  }

  private set(key: string, entry: CachedResourceMotion): void {
    this.entries.set(key, entry);
    const weight = estimateCachedMotionBytes(entry);
    this.entryBytes.set(key, weight);
    this.usedBytes += weight;
    // Memory-budget eviction: drop the oldest entries until the estimated
    // occupancy is back under the budget. A single oversized entry is kept
    // (floor of one) so a pathological motion never disappears entirely.
    while (this.usedBytes > this.budgetBytesValue && this.entries.size > 1) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.removeEntryBytes(oldest.value);
      this.entries.delete(oldest.value);
    }
  }

  private removeEntryBytes(key: string): void {
    const weight = this.entryBytes.get(key);
    if (weight !== undefined) {
      this.usedBytes -= weight;
      this.entryBytes.delete(key);
    }
  }

  private reject(key: string, reason: string): void {
    this.rejected.set(key, reason);
    while (this.rejected.size > RESOURCE_MOTION_CACHE_MAX_REJECTED_ENTRIES) {
      const oldest = this.rejected.keys().next();
      if (oldest.done) break;
      this.rejected.delete(oldest.value);
    }
  }

  private async build(source: MotionCurveCacheSource): Promise<CachedResourceMotion | null> {
    const key = motionCurveCacheKey(source);
    return this.buildFromNeutralSample(source, key);
  }

  private async buildFromNeutralSample(
    source: MotionCurveCacheSource,
    key: string,
  ): Promise<CachedResourceMotion | null> {
    let sampled: Live2DMotionSamplingResult;
    try {
      const options = { fps: source.fps, zeroSourceFades: true as const, skipMissingParameters: true as const };
      sampled = source.sample
        ? await source.sample(options)
        : await this.sampler.sample({ ...source, ...options });
    } catch (error) {
      this.logger.warn(`[MotionCurveCache] Bound sampling failed for "${source.motionKey}": ${String(error)}`);
      this.reject(key, 'sampling-failed');
      return null;
    }
    if (sampled.status !== 'sampled' || sampled.metadata?.hasNonParameterCurves) {
      this.reject(key, sampled.metadata?.hasNonParameterCurves ? 'parts-layout-curves' : 'unsupported');
      return null;
    }
    if (sampled.motion) {
      const motion = sampled.motion;
      const isIdle = isIdleMotionKey(source.motionKey);
      return {
        key,
        motion,
        sourceFadeInSeconds: sampled.metadata?.fadeInSeconds,
        sourceFadeOutSeconds: sampled.metadata?.fadeOutSeconds,
        isIdle,
        evaluate(localTime: number): Readonly<Record<string, number>> {
          const frame = evaluateCustomMotion(motion, localTime);
          return frame.active ? frame.values : {};
        },
      };
    }
    const curves = sampled.curves ?? [];
    if (curves.length === 0) {
      this.reject(key, 'no-parameter-curves');
      return null;
    }
    let fit: ReturnType<typeof buildCustomMotionTracks>;
    try {
      fit = buildCustomMotionTracks(curves.map((curve) => ({
        parameterId: curve.parameterId,
        samples: curve.samples,
      })), { density: 'perFrame' });
    } catch (error) {
      this.reject(key, 'keyframe-build-failed');
      return null;
    }
    if (fit.tracks.length === 0) {
      this.reject(key, 'no-buildable-tracks');
      return null;
    }
    const metadata = sampled.metadata;
    if (!metadata) {
      this.reject(key, 'missing-sample-metadata');
      return null;
    }
    const fadeInSeconds = resolveEffectiveCubism2FadeInSeconds(metadata, source.motionKey);
    const motion: Extract<CharacterMotionOutput, { kind: 'custom' }> = {
      kind: 'custom',
      durationSeconds: Math.max(metadata.durationSeconds, fadeInSeconds),
      fadeInSeconds,
      derivedFrom: {
        key: source.motionKey,
        ...(metadata.fadeInSeconds !== undefined ? { fadeInSeconds: metadata.fadeInSeconds } : {}),
        ...(metadata.fadeOutSeconds !== undefined ? { fadeOutSeconds: metadata.fadeOutSeconds } : {}),
      },
      tracks: fit.tracks,
    };
    const isIdle = isIdleMotionKey(source.motionKey);
    return {
      key,
      motion,
      sourceFadeInSeconds: metadata.fadeInSeconds,
      sourceFadeOutSeconds: metadata.fadeOutSeconds,
      isIdle,
      evaluate(localTime: number): Readonly<Record<string, number>> {
        const frame = evaluateCustomMotion(motion, localTime);
        return frame.active ? frame.values : {};
      },
    };
  }

}

export const motionCurveCache = new MotionCurveCacheService();
