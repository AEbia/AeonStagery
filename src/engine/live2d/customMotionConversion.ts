import type {
  CharacterMotionOutput,
  CustomMotionKeyframe,
  CustomMotionSegment,
  CustomMotionTrack,
} from '../../api/types/semantic-scene';

/**
 * Versioned contract for the Cubism 2.1 sampling -> linear keyframe fit.
 * Any change to error ratios, absolute tolerance or the fit steps must
 * bump this version and update deterministic tests. The version is not
 * persisted as a runtime property of the custom motion (ADR-0029).
 */
export const CUSTOM_MOTION_FIT_ALGORITHM_VERSION = 1 as const;

export type CustomMotionDensity = 'sparse' | 'standard' | 'fine' | 'perFrame';

export const CUSTOM_MOTION_DENSITY_ERROR_RATIOS: Readonly<Record<Exclude<CustomMotionDensity, 'perFrame'>, number>> = {
  sparse: 0.05,
  standard: 0.02,
  fine: 0.005,
} as const;

export const CUSTOM_MOTION_FIT_ABSOLUTE_TOLERANCE = 0.001 as const;

/**
 * Estimate the frame / keyframe count for a custom motion given duration,
 * density and scene fps.
 */
export function estimateCustomMotionKeyframes(
  durationSeconds: number,
  density: CustomMotionDensity,
  fps: number = 60,
): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  const effectiveFps = Number.isFinite(fps) && fps > 0 ? fps : 60;
  const totalFrames = Math.max(1, Math.round(durationSeconds * effectiveFps));
  if (density === 'perFrame') return totalFrames;
  const ratio = density === 'sparse' ? 0.1 : density === 'standard' ? 0.25 : 0.6;
  return Math.max(2, Math.round(totalFrames * ratio));
}

/** Default candidate point budget for the initial equal-complexity pass. */
export const CUSTOM_MOTION_FIT_INITIAL_CANDIDATE_BUDGET = 20 as const;

/** A single sample of a source motion curve at an integer scene frame. */
export interface CustomMotionSamplePoint {
  readonly time: number;
  readonly value: number;
}

export interface CustomMotionSampledTrack {
  readonly parameterId: string;
  readonly samples: readonly CustomMotionSamplePoint[];
}

export interface FitLinearKeyframesOptions {
  readonly density: CustomMotionDensity;
  /**
   * Reliable parameter scale (max - min) from the target model. When
   * missing, the sampled track's own motion amplitude is used.
   */
  readonly scale?: number;
}

export interface CustomMotionConversionInput {
  readonly durationSeconds: number;
  readonly fadeInSeconds: number;
  readonly derivedFromKey: string;
  readonly derivedFromFadeInSeconds?: number;
  readonly derivedFromFadeOutSeconds?: number;
  readonly density: CustomMotionDensity;
  readonly sampledTracks: readonly CustomMotionSampledTrack[];
}

export interface CustomMotionConversionResult {
  readonly motion: Extract<CharacterMotionOutput, { kind: 'custom' }>;
  /** Tracks whose only source curve values are constant (kept with F0 + end). */
  readonly staticTrackIds: readonly string[];
  /** Tracks whose samples were simplified below the original density. */
  readonly simplifiedTrackIds: readonly string[];
}

const LINEAR_SEGMENT: CustomMotionSegment = { type: 'linear' };

/**
 * Fit sampled integer-frame points into linear keyframes. Every non-last
 * returned keyframe carries an explicit linear segment; the last keyframe
 * omits it, matching the v3 codec contract.
 *
 * Mandatory points: F0, the motion end sample, explicit jump boundaries,
 * and extrema whose significance exceeds the allowed error. Noise-level
 * extrema are not forced.
 */
export function fitCustomMotionLinearKeyframes(
  samples: readonly CustomMotionSamplePoint[],
  options: FitLinearKeyframesOptions,
): CustomMotionKeyframe[] {
  if (samples.length === 0) return [];
  if (options.density === 'perFrame' || samples.length <= 2) {
    return toLinearKeyframes(samples);
  }

  const allowedError = resolveAllowedError(samples, options);
  const forced = new Set<number>(findForcedSampleIndices(samples, allowedError));
  let retained: number[] = [...forced].sort((a, b) => a - b);

  if (retained.length < samples.length) {
    retained = [...initialEqualComplexityCandidates(samples, retained, CUSTOM_MOTION_FIT_INITIAL_CANDIDATE_BUDGET)];
  }

  // Ensure F0 and the end sample are always present.
  retained = [...new Set([0, samples.length - 1, ...retained])].sort((a, b) => a - b);

  // Add points at the largest error until the tolerance is met.
  for (let guard = 0; guard < samples.length; guard++) {
    const worst = findWorstErrorIndex(samples, retained);
    if (worst === null) break;
    if (worst.error <= allowedError) break;
    retained = insertSorted(retained, worst.index);
  }

  // Greedily drop the non-mandatory point whose removal increases error the
  // least, while still meeting the tolerance.
  const removable = retained.filter((index) => !forced.has(index) && index !== 0 && index !== samples.length - 1);
  let changed = true;
  while (changed && removable.length > 0) {
    changed = false;
    let bestCandidate: { index: number; error: number } | null = null;
    for (const candidate of removable) {
      const trial = retained.filter((index) => index !== candidate);
      const error = maxFitError(samples, trial);
      if (error <= allowedError && (bestCandidate === null || error < bestCandidate.error)) {
        bestCandidate = { index: candidate, error };
      }
    }
    if (bestCandidate) {
      retained = retained.filter((index) => index !== bestCandidate!.index);
      removable.splice(removable.indexOf(bestCandidate.index), 1);
      changed = true;
    }
  }

  return toLinearKeyframes(retained.map((index) => samples[index]));
}

/**
 * Build codec-valid custom motion tracks from sampled source curves.
 * Constant tracks are kept with exactly two boundary keyframes (F0 + end);
 * parameter ids are unique.
 */
export function buildCustomMotionTracks(
  sampledTracks: readonly CustomMotionSampledTrack[],
  options: FitLinearKeyframesOptions,
): { readonly tracks: CustomMotionTrack[]; readonly staticTrackIds: readonly string[]; readonly simplifiedTrackIds: readonly string[] } {
  const tracks: CustomMotionTrack[] = [];
  const staticTrackIds: string[] = [];
  const simplifiedTrackIds: string[] = [];
  const seen = new Set<string>();

  for (const sampled of sampledTracks) {
    if (seen.has(sampled.parameterId)) {
      throw new Error(`Duplicate parameter track while converting: ${sampled.parameterId}`);
    }
    seen.add(sampled.parameterId);

    const isConstant = sampled.samples.every((point, index) => index === 0 || point.value === sampled.samples[0].value);
    const keyframes = isConstant
      ? toConstantKeyframes(sampled.samples)
      : fitCustomMotionLinearKeyframes(sampled.samples, options);

    tracks.push({ parameterId: sampled.parameterId, keyframes });
    if (isConstant) staticTrackIds.push(sampled.parameterId);
    else if (keyframes.length < sampled.samples.length) simplifiedTrackIds.push(sampled.parameterId);
  }

  return { tracks, staticTrackIds, simplifiedTrackIds };
}

/**
 * Assemble a full custom motion output from sampled source curves.
 * durationSeconds must already be the larger of the parsed source duration
 * and the effective fadeInSeconds.
 */
export function convertSampledMotionToCustomMotion(
  input: CustomMotionConversionInput,
): CustomMotionConversionResult {
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) {
    throw new Error('Expected a finite positive source motion duration for conversion');
  }
  if (!Number.isFinite(input.fadeInSeconds) || input.fadeInSeconds < 0) {
    throw new Error('Expected a finite non-negative fadeInSeconds for conversion');
  }
  if (input.fadeInSeconds > input.durationSeconds) {
    throw new Error('Expected fadeInSeconds <= durationSeconds for conversion');
  }
  if (input.sampledTracks.length === 0) {
    throw new Error('Expected at least one convertible parameter track for conversion');
  }

  const fit = buildCustomMotionTracks(input.sampledTracks, { density: input.density });

  const motion: Extract<CharacterMotionOutput, { kind: 'custom' }> = {
    kind: 'custom',
    durationSeconds: input.durationSeconds,
    fadeInSeconds: input.fadeInSeconds,
    derivedFrom: {
      key: input.derivedFromKey,
      ...(input.derivedFromFadeInSeconds !== undefined ? { fadeInSeconds: input.derivedFromFadeInSeconds } : {}),
      ...(input.derivedFromFadeOutSeconds !== undefined ? { fadeOutSeconds: input.derivedFromFadeOutSeconds } : {}),
    },
    tracks: fit.tracks,
  };

  return {
    motion,
    staticTrackIds: fit.staticTrackIds,
    simplifiedTrackIds: fit.simplifiedTrackIds,
  };
}

export function resolveFitScale(
  samples: readonly CustomMotionSamplePoint[],
  explicitScale: number | undefined,
): number {
  if (explicitScale !== undefined && Number.isFinite(explicitScale) && explicitScale > 0) {
    return explicitScale;
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    if (sample.value < min) min = sample.value;
    if (sample.value > max) max = sample.value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 1;
  const amplitude = max - min;
  return amplitude > 0 ? amplitude : 1;
}

function resolveAllowedError(
  samples: readonly CustomMotionSamplePoint[],
  options: FitLinearKeyframesOptions,
): number {
  if (options.density === 'perFrame') return 0;
  const ratio = CUSTOM_MOTION_DENSITY_ERROR_RATIOS[options.density];
  const scale = resolveFitScale(samples, options.scale);
  return Math.max(ratio * scale, CUSTOM_MOTION_FIT_ABSOLUTE_TOLERANCE);
}

/**
 * Mandatory sample indices: F0 (0), the end sample, explicit jump
 * boundaries (single-frame deltas far above the track's own baseline), and
 * extrema whose significance exceeds the allowed error. Noise-level
 * extrema are not forced.
 */
function findForcedSampleIndices(
  samples: readonly CustomMotionSamplePoint[],
  allowedError: number,
): number[] {
  const forced = new Set<number>([0, samples.length - 1]);

  // Baseline frame-to-frame change measured by the median delta, so smooth
  // ramps and noise are not mistaken for jumps.
  const medianDelta = medianAdjacentDelta(samples);
  // Jump threshold: a single-frame delta far above the track's own baseline
  // (and never below the error budget).
  const jumpThreshold = Math.max(medianDelta * 6, allowedError * 8, CUSTOM_MOTION_FIT_ABSOLUTE_TOLERANCE * 4);

  for (let index = 1; index < samples.length - 1; index++) {
    const previous = samples[index - 1];
    const current = samples[index];
    const next = samples[index + 1];

    const previousDelta = Math.abs(current.value - previous.value);
    const nextDelta = Math.abs(next.value - current.value);

    if (previousDelta >= jumpThreshold) forced.add(index - 1);
    if (nextDelta >= jumpThreshold) forced.add(index + 1);

    const isPeak = current.value > previous.value && current.value > next.value;
    const isValley = current.value < previous.value && current.value < next.value;
    if (isPeak || isValley) {
      const significance = Math.min(previousDelta, nextDelta);
      if (significance > allowedError) forced.add(index);
    }
  }

  return [...forced];
}

function medianAdjacentDelta(samples: readonly CustomMotionSamplePoint[]): number {
  if (samples.length < 2) return 0;
  const deltas: number[] = [];
  for (let index = 1; index < samples.length; index++) {
    deltas.push(Math.abs(samples[index].value - samples[index - 1].value));
  }
  deltas.sort((a, b) => a - b);
  const middle = Math.floor(deltas.length / 2);
  return deltas.length % 2 === 1 ? deltas[middle] : (deltas[middle - 1] + deltas[middle]) / 2;
}

/**
 * Distribute the retained sample indices evenly across the curve's local
 * complexity (sum of absolute deltas), producing the initial candidate set.
 */
function initialEqualComplexityCandidates(
  samples: readonly CustomMotionSamplePoint[],
  retained: readonly number[],
  budget: number,
): number[] {
  const complexity = new Map<number, number>();
  let total = 0;
  for (let index = 1; index < samples.length; index++) {
    total += Math.abs(samples[index].value - samples[index - 1].value);
    complexity.set(index, total);
  }
  if (total <= 0) return retained.slice();

  const existing = new Set(retained);
  const candidates = new Set(retained);
  const step = total / Math.max(1, budget);
  for (let target = step; target < total; target += step) {
    const index = nearestComplexityIndex(complexity, target);
    if (!existing.has(index)) candidates.add(index);
  }
  return [...candidates].sort((a, b) => a - b);
}

function nearestComplexityIndex(complexity: ReadonlyMap<number, number>, target: number): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [index, value] of complexity) {
    const distance = Math.abs(value - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function findWorstErrorIndex(
  samples: readonly CustomMotionSamplePoint[],
  retained: readonly number[],
): { index: number; error: number } | null {
  let worst: { index: number; error: number } | null = null;
  for (let index = 0; index < samples.length; index++) {
    const error = Math.abs(samples[index].value - interpolateAt(samples, retained, samples[index].time));
    if (worst === null || error > worst.error) {
      worst = { index, error };
    }
  }
  return worst;
}

function maxFitError(
  samples: readonly CustomMotionSamplePoint[],
  retained: readonly number[],
): number {
  let max = 0;
  for (const sample of samples) {
    const error = Math.abs(sample.value - interpolateAt(samples, retained, sample.time));
    if (error > max) max = error;
  }
  return max;
}

function interpolateAt(
  samples: readonly CustomMotionSamplePoint[],
  retained: readonly number[],
  time: number,
): number {
  if (retained.length === 0) return 0;
  if (time <= samples[retained[0]].time) return samples[retained[0]].value;
  if (time >= samples[retained[retained.length - 1]].time) return samples[retained[retained.length - 1]].value;

  for (let i = 0; i < retained.length - 1; i++) {
    const leftIndex = retained[i];
    const rightIndex = retained[i + 1];
    const left = samples[leftIndex];
    const right = samples[rightIndex];
    if (time > right.time) continue;
    const span = right.time - left.time;
    if (span <= 0) return right.value;
    const t = (time - left.time) / span;
    return left.value + (right.value - left.value) * t;
  }

  return samples[retained[retained.length - 1]].value;
}

function insertSorted(sorted: readonly number[], value: number): number[] {
  const next = [...sorted];
  const index = next.findIndex((entry) => entry >= value);
  if (index === -1) next.push(value);
  else if (next[index] !== value) next.splice(index, 0, value);
  return next;
}

function toLinearKeyframes(points: readonly CustomMotionSamplePoint[]): CustomMotionKeyframe[] {
  return points.map((point, index) => {
    const keyframe: CustomMotionKeyframe = { time: point.time, value: point.value };
    if (index < points.length - 1) {
      return { ...keyframe, segment: LINEAR_SEGMENT };
    }
    return keyframe;
  });
}

function toConstantKeyframes(samples: readonly CustomMotionSamplePoint[]): CustomMotionKeyframe[] {
  const first = samples[0];
  const last = samples[samples.length - 1];
  return [
    { time: first.time, value: first.value, segment: LINEAR_SEGMENT },
    { time: last.time, value: last.value },
  ];
}
