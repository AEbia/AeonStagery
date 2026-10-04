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
import {
  Cubism2MotionSamplingError,
  mergeCubism2SampledCurves,
  resolveCubism2MotionMeta,
  sampleCubism2MotionCurves,
  type Cubism2MotionCurve,
  type Cubism2MotionMeta,
  type Cubism2MotionSamplerTarget,
} from './cubism2MotionSampler';
import {
  buildCustomMotionTracks,
  type CustomMotionSamplePoint,
  type CustomMotionSampledTrack,
} from './customMotionConversion';
import { evaluateCustomMotion } from './customMotion';

export interface MotionCurveCacheKey {
  readonly adapterId: string;
  readonly modelRuntimePath: string;
  readonly motionKey: string;
}

export interface MotionCurveCacheSource extends MotionCurveCacheKey {
  /** Concrete Cubism 2 model sampling targets (composite models yield ≥1). */
  readonly targets: readonly Cubism2MotionSamplerTarget[];
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
  resolveMeta(target: Cubism2MotionSamplerTarget, motionKey: string): Promise<Cubism2MotionMeta>;
  sample(
    target: Cubism2MotionSamplerTarget,
    motionKey: string,
    options: Parameters<typeof sampleCubism2MotionCurves>[2],
  ): Promise<readonly Cubism2MotionCurve[]>;
  merge(curves: readonly (readonly Cubism2MotionCurve[])[]): readonly Cubism2MotionCurve[];
}

const DEFAULT_SAMPLER: MotionCurveCacheSampler = {
  resolveMeta: resolveCubism2MotionMeta,
  sample: sampleCubism2MotionCurves,
  merge: mergeCubism2SampledCurves,
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
  meta: Cubism2MotionMeta,
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

/**
 * Classify a failed build step into a stable miss-reason code for the seek
 * report. Cubism2 sampling errors carry their own typed codes; anything else
 * falls back to a step-specific default.
 */
function classifyMissReason(error: unknown, fallback: string): string {
  if (error instanceof Cubism2MotionSamplingError) return error.code;
  return fallback;
}

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
    if (source.targets.length === 0) {
      this.logger.warn(`[MotionCurveCache] No sampling targets for motion "${source.motionKey}"`);
      return null;
    }

    let meta: Cubism2MotionMeta;
    try {
      meta = await this.sampler.resolveMeta(source.targets[0], source.motionKey);
    } catch (error) {
      const reason = classifyMissReason(error, 'resolve-meta-failed');
      this.logger.warn(`[MotionCurveCache] resolveMeta failed for "${source.motionKey}": ${String(error)}`);
      this.reject(key, reason);
      return null;
    }

    // Parity guard: a source motion that also animates parts/layouts cannot be
    // represented by the pure parameter evaluator. Converting it would silently
    // drop those curves, so it stays a permanent miss on the SDK path.
    if (meta.hasNonParameterCurves) {
      this.logger.warn(
        `[MotionCurveCache] Motion "${source.motionKey}" carries parts/layout curves; keeping the SDK path (parity guard)`,
      );
      this.reject(key, 'parts-layout-curves');
      return null;
    }

    const samplingOptions: Parameters<typeof sampleCubism2MotionCurves>[2] = {
      fps: source.fps,
      durationSeconds: meta.durationSeconds,
      // Do NOT bake the SDK's fade from a default pose into the derived
      // curves. Keep the pure motion target values and let the shared
      // `evaluateCustomMotionRuntime` reconstruct the fade from the current
      // seek/playback handoff pose (ADR-0029/ADR-0033).
      zeroSourceFades: true,
      skipMissingParameters: true,
      ...(meta.fadeInSeconds !== undefined ? { fadeInSeconds: meta.fadeInSeconds } : {}),
      ...(meta.fadeOutSeconds !== undefined ? { fadeOutSeconds: meta.fadeOutSeconds } : {}),
    };

    let merged: readonly Cubism2MotionCurve[];
    try {
      const perModel = await Promise.all(
        source.targets.map((target) => this.sampler.sample(target, source.motionKey, samplingOptions)),
      );
      merged = this.sampler.merge(perModel);
    } catch (error) {
      const reason = classifyMissReason(error, 'sampling-failed');
      this.logger.warn(`[MotionCurveCache] Sampling failed for "${source.motionKey}": ${String(error)}`);
      this.reject(key, reason);
      return null;
    }
    if (merged.length === 0) {
      this.logger.warn(`[MotionCurveCache] Motion "${source.motionKey}" produced no convertible parameter curves`);
      this.reject(key, 'no-parameter-curves');
      return null;
    }

    const sampledTracks: CustomMotionSampledTrack[] = merged.map((curve) => ({
      parameterId: curve.parameterId,
      samples: curve.samples as readonly CustomMotionSamplePoint[],
    }));

    let fit: ReturnType<typeof buildCustomMotionTracks>;
    try {
      fit = buildCustomMotionTracks(sampledTracks, { density: 'perFrame' });
    } catch (error) {
      this.logger.warn(`[MotionCurveCache] Keyframe build failed for "${source.motionKey}": ${String(error)}`);
      this.reject(key, 'keyframe-build-failed');
      return null;
    }
    if (fit.tracks.length === 0) {
      this.logger.warn(`[MotionCurveCache] Motion "${source.motionKey}" has no buildable tracks`);
      this.reject(key, 'no-buildable-tracks');
      return null;
    }

    const fadeInSeconds = resolveEffectiveCubism2FadeInSeconds(meta, source.motionKey);
    const isIdle = isIdleMotionKey(source.motionKey);
    const motion: Extract<CharacterMotionOutput, { kind: 'custom' }> = {
      kind: 'custom',
      durationSeconds: Math.max(meta.durationSeconds, fadeInSeconds),
      fadeInSeconds,
      derivedFrom: {
        key: source.motionKey,
        ...(meta.fadeInSeconds !== undefined ? { fadeInSeconds: meta.fadeInSeconds } : {}),
        ...(meta.fadeOutSeconds !== undefined ? { fadeOutSeconds: meta.fadeOutSeconds } : {}),
      },
      tracks: fit.tracks,
    };

    const entry: CachedResourceMotion = {
      key,
      motion,
      sourceFadeInSeconds: meta.fadeInSeconds,
      sourceFadeOutSeconds: meta.fadeOutSeconds,
      isIdle,
      evaluate(localTime: number): Readonly<Record<string, number>> {
        const frame = evaluateCustomMotion(motion, localTime);
        return frame.active ? frame.values : {};
      },
    };
    return entry;
  }
}

export const motionCurveCache = new MotionCurveCacheService();