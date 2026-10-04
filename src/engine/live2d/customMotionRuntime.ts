import type { CharacterMotionOutput, CustomMotionTrack } from '../../api/types/semantic-scene';
import { evaluateCustomMotion, evaluateCustomMotionTrack } from './customMotion';

/**
 * Runtime evaluation of an inline custom motion with statement-level fade-in.
 *
 * The custom motion owns the character's motion output from its start scene
 * time until a later motion (resource or custom) takes over. Fade-in follows
 * Cubism's saved-parameter behaviour: each SDK frame blends the previously
 * accumulated value toward that frame's curve value using the sine weight
 * `0.5 - 0.5 * cos(progress * PI)`. After the transition the curve is used
 * verbatim. Past the last keyframe the tail value is held (ADR-0029).
 */

const CUBISM_FADE_EVALUATION_FPS = 60;
const FRAME_EPSILON = 1e-7;

interface TrackFadeCache {
  readonly accumulatedFrames: number[];
}

interface MotionFadeCache {
  readonly motion: Extract<CharacterMotionOutput, { kind: 'custom' }>;
  /**
   * Content signature of `motion` when the accumulated frames were built.
   * The cache is keyed by the handoff pose, which outlives an edit that
   * mutates the motion in place; without this check the fade-in would keep
   * replaying the pre-edit curve for the whole window (the edited motion only
   * appearing after the fade completed).
   */
  signature: number;
  readonly tracks: Map<string, TrackFadeCache>;
}

/**
 * Cheap content signature of the fade-relevant motion data: track set, fade
 * durations and every keyframe time/value. Recomputed per evaluation (a few
 * dozen numbers) so an in-place keyframe edit invalidates the accumulation.
 */
function motionFadeSignature(motion: Extract<CharacterMotionOutput, { kind: 'custom' }>): number {
  let hash = motion.tracks.length * 31 + Math.round((motion.fadeInSeconds ?? 0) * 1000);
  for (const track of motion.tracks) {
    hash = (hash * 31 + track.parameterId.length) | 0;
    hash = (hash * 31 + Math.round((track.fadeInSeconds ?? -1) * 1000)) | 0;
    for (const keyframe of track.keyframes) {
      hash = (hash * 31 + Math.round(keyframe.time * 1000)) | 0;
      hash = (hash * 31 + Math.round(keyframe.value * 1000)) | 0;
    }
  }
  return hash;
}

const fadeCacheByHandoff = new WeakMap<CustomMotionHandoffPose, MotionFadeCache>();

/**
 * Already-accumulated Cubism fade-in frames for a later reconstruction of the
 * same motion. Used when bake/seek resumes inside an in-flight fade window so
 * the 60Hz sine blend continues from the saved pose instead of treating that
 * pose as a new frame-0 handoff (ADR-0029).
 */
export type CustomMotionFadeResumeFrames = Readonly<Record<string, readonly number[]>>;

export interface CustomMotionHandoffPose {
  /** Parameter id -> value at the moment the custom motion took over. */
  readonly values: Readonly<Record<string, number>>;
  /**
   * Optional already-accumulated 60Hz fade frames. When present, fade-in
   * reconstruction continues from these frames instead of blending from
   * `values` at localTime 0 — used when bake/seek resumes inside an in-flight
   * fade window (ADR-0029).
   */
  readonly resumeFrames?: CustomMotionFadeResumeFrames;
}

export interface CustomMotionRuntimeEvaluation {
  readonly values: Readonly<Record<string, number>>;
  /** True while the statement fade-in transition is still running. */
  readonly fadingIn: boolean;
}

export function cubismSineFadeWeight(progress: number): number {
  const clamped = Math.max(0, Math.min(1, progress));
  return 0.5 - 0.5 * Math.cos(clamped * Math.PI);
}

export function resolveTrackFadeInSeconds(
  track: CustomMotionTrack,
  motionFadeInSeconds: number,
): number {
  return track.fadeInSeconds ?? motionFadeInSeconds;
}

/**
 * Evaluate a custom motion at a scene time against its start time.
 * localTime is clamped to [0, durationSeconds]; past the tail the last
 * keyframe value is held. Values are the absolute target values from the
 * curve, not yet clamped to the target model's parameter ranges.
 */
export function evaluateCustomMotionRuntime(
  motion: Extract<CharacterMotionOutput, { kind: 'custom' }>,
  startSceneTime: number,
  sceneTime: number,
  handoff: CustomMotionHandoffPose,
  resumeFrames?: CustomMotionFadeResumeFrames,
): CustomMotionRuntimeEvaluation {
  if (!Number.isFinite(sceneTime) || sceneTime < startSceneTime) {
    return { values: {}, fadingIn: false };
  }
  const localTime = sceneTime - startSceneTime;
  const frame = evaluateCustomMotion(motion, localTime);
  if (!frame.active) {
    return { values: {}, fadingIn: false };
  }

  const values: Record<string, number> = {};
  let anyFading = false;
  const fadeCache = resolveMotionFadeCache(handoff, motion, resumeFrames ?? handoff.resumeFrames);
  for (const track of motion.tracks) {
    const curveValue = frame.values[track.parameterId];
    if (curveValue === undefined) continue;

    const fadeInSeconds = resolveTrackFadeInSeconds(track, motion.fadeInSeconds);
    const fading = fadeInSeconds > 0 && localTime < fadeInSeconds;
    if (fading) {
      const handoffValue = handoff.values[track.parameterId] ?? curveValue;
      values[track.parameterId] = evaluateCubismFadeIn(
        track,
        handoffValue,
        localTime,
        fadeInSeconds,
        fadeCache,
      );
      anyFading = true;
    } else {
      values[track.parameterId] = curveValue;
    }
  }

  return { values, fadingIn: anyFading };
}

/**
 * Reconstruct Cubism's stateful fade deterministically at the canonical 60Hz
 * evaluation cadence. Cubism saves each blended parameter and uses it as the
 * source of the next frame; a single blend from the original handoff pose is
 * visibly slower and does not match the source resource motion.
 *
 * The reconstruction follows Cubism's discrete frame semantics: the value for
 * any instant in a frame interval is the accumulated value of the frame whose
 * boundary is <= that instant — no extra fractional-step blend is appended
 * between frame boundaries (Cubism never renders such intermediate values).
 */
function evaluateCubismFadeIn(
  track: CustomMotionTrack,
  handoffValue: number,
  localTime: number,
  fadeInSeconds: number,
  motionCache: MotionFadeCache,
): number {
  const wholeFrame = Math.floor(localTime * CUBISM_FADE_EVALUATION_FPS + FRAME_EPSILON);
  let trackCache = motionCache.tracks.get(track.parameterId);
  if (!trackCache) {
    trackCache = { accumulatedFrames: [] };
    motionCache.tracks.set(track.parameterId, trackCache);
  }

  for (let frame = trackCache.accumulatedFrames.length; frame <= wholeFrame; frame++) {
    const frameTime = frame / CUBISM_FADE_EVALUATION_FPS;
    const curveValue = evaluateCustomMotionTrack(track, frameTime);
    const previous = frame === 0
      ? handoffValue
      : trackCache.accumulatedFrames[frame - 1] ?? handoffValue;
    if (curveValue === null || !Number.isFinite(curveValue)) {
      trackCache.accumulatedFrames.push(previous);
      continue;
    }
    const weight = cubismSineFadeWeight(frameTime / fadeInSeconds);
    trackCache.accumulatedFrames.push(previous + (curveValue - previous) * weight);
  }

  return trackCache.accumulatedFrames[wholeFrame] ?? handoffValue;
}

function resolveMotionFadeCache(
  handoff: CustomMotionHandoffPose,
  motion: Extract<CharacterMotionOutput, { kind: 'custom' }>,
  resumeFrames?: CustomMotionFadeResumeFrames,
): MotionFadeCache {
  const signature = motionFadeSignature(motion);
  const existing = fadeCacheByHandoff.get(handoff);
  if (existing?.motion === motion && existing.signature === signature) return existing;
  const created: MotionFadeCache = { motion, signature, tracks: new Map() };
  if (resumeFrames) {
    for (const [parameterId, frames] of Object.entries(resumeFrames)) {
      if (frames.length === 0) continue;
      created.tracks.set(parameterId, { accumulatedFrames: [...frames] });
    }
  }
  fadeCacheByHandoff.set(handoff, created);
  return created;
}

/**
 * Seed a 60Hz fade-accumulation prefix so a later `evaluateCustomMotionRuntime`
 * call continues from `localTime` instead of restarting at frame 0. The last
 * stored frame is `currentValue`; earlier slots are filled with that value so
 * reconstruction never re-blends from the original handoff.
 */
export function seedCustomMotionFadeResumeFrames(
  localTime: number,
  currentValues: Readonly<Record<string, number>>,
): Record<string, number[]> {
  const wholeFrame = Math.max(0, Math.floor(localTime * CUBISM_FADE_EVALUATION_FPS + FRAME_EPSILON));
  const resume: Record<string, number[]> = {};
  for (const [parameterId, value] of Object.entries(currentValues)) {
    if (!Number.isFinite(value)) continue;
    resume[parameterId] = Array.from({ length: wholeFrame + 1 }, () => value);
  }
  return resume;
}

/**
 * Apply evaluated values into the injected parameter map, releasing ids that
 * the motion no longer controls.
 */
/**
 * Write the evaluated custom-motion values into the injected parameter map and
 * release ids the motion no longer controls.
 *
 * `protectedParameterIds` are parameters owned by an active real-time effect
 * channel (today: lip sync). Per ADR-0029 the custom motion works in the
 * Motion evaluation stage while breathing, blinking, lip sync and physics keep
 * running in their normal stages, so the motion must neither overwrite nor
 * release those parameters — the winner is decided by declared channel
 * ownership, never by execution timing (KSM-0005).
 */
export function applyCustomMotionValues(
  injectedParams: Record<string, number>,
  controlledParameterIds: readonly string[],
  values: Readonly<Record<string, number>>,
  protectedParameterIds?: ReadonlySet<string>,
): void {
  const nextIds = new Set<string>();
  for (const [parameterId, value] of Object.entries(values)) {
    if (!Number.isFinite(value)) continue;
    if (protectedParameterIds?.has(parameterId)) continue;
    injectedParams[parameterId] = value;
    nextIds.add(parameterId);
  }
  for (const parameterId of controlledParameterIds) {
    if (nextIds.has(parameterId)) continue;
    if (protectedParameterIds?.has(parameterId)) continue;
    delete injectedParams[parameterId];
  }
}

export function customMotionControlledParameterIds(
  motion: Extract<CharacterMotionOutput, { kind: 'custom' }>,
): readonly string[] {
  // A track without keyframes drives nothing; claiming its parameter would let
  // the per-frame release wipe values owned by other channels (e.g. lip sync).
  return motion.tracks
    .filter((track) => track.keyframes.length > 0)
    .map((track) => track.parameterId);
}

/**
 * Capture the handoff pose a custom motion fades in from. Reads only the
 * motion's controlled parameters; `excludeParameterIds` (active effect-channel
 * parameters such as a live lip-sync mouth value) are skipped so transient
 * effect output is not baked into the fade-in source (ADR-0029).
 */
export function selectHandoffPoseValues(
  parametersByName: ReadonlyMap<string, { index: number; value?: number }>,
  controlledParameterIds: readonly string[],
  snapshotParams?: ArrayLike<number> | null,
  excludeParameterIds?: ReadonlySet<string>,
): Record<string, number> {
  const values: Record<string, number> = {};
  for (const parameterId of controlledParameterIds) {
    if (excludeParameterIds?.has(parameterId)) continue;
    const parameter = parametersByName.get(parameterId);
    if (!parameter) continue;
    const snapshotValue = snapshotParams?.[parameter.index];
    const value = Number.isFinite(snapshotValue) ? snapshotValue : parameter.value;
    if (value !== undefined && Number.isFinite(value)) {
      values[parameterId] = value;
    }
  }
  return values;
}
