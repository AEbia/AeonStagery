import type { CharacterEntry } from '../Live2DConfig';
import { resetCoreParams } from '../Live2DConfig';
import type { Live2DRuntimeDescriptor } from '../Live2DRuntimeResolver';
import { getLive2DRuntimeAdapter } from '../Live2DRuntimeAdapter';
import { releaseCustomMotionOwnership } from './customMotionOwnership';
import { readPartOpacities, writePartOpacities } from './runtime/Cubism2PartOpacity';

/**
 * Single "dirty data" purge for a character's runtime state (ADR-0029).
 *
 * A seek, a scene edit, or a character teardown can leave one of the stateful
 * motion/expression channels pointing at a pose that belongs to a *different*
 * scene time. Every one of those channels keeps writing its stale value after
 * the seek has finished — the SDK motion queue holds its tail pose, the
 * expression manager keeps its resident entry, `injectedParams` is replayed
 * every frame, and the seek-boundary snapshot is re-applied inside the fade-in
 * window. The visible result is the previous action playing on the seeked
 * frame, most visibly inside a fade-in.
 *
 * This module collects the whole cleanup in one place so every entry point
 * (seek start, reset-to-idle, character removal, model recycling) purges the
 * same set of fields instead of each path clearing a different subset.
 */

export interface CharacterStatePurgeOptions {
  /**
   * Restore the neutral pose after stopping playback. Used when the model
   * outlives the purge (character removal / model recycling) so the pose
   * cannot be inherited by the next owner of the instance.
   */
  restoreNeutralPose?: boolean;
  /** Clear the SDK expression channel as well (default true). */
  clearExpression?: boolean;
  /**
   * Drop the motion bookkeeping that decides whether a queued motion is
   * "already playing" (`motionStartTime`, `lastOffset`, seek-boundary
   * snapshots…). Default true.
   */
  clearMotionBookkeeping?: boolean;
}

/**
 * Purge every motion/expression channel of `entry`.
 *
 * Safe to call without a loaded model: the entry bookkeeping and the queued
 * intent are always cleared, so a character whose model is still loading
 * cannot replay a stale intent once it arrives.
 */
export function purgeCharacterRuntimeState(
  entry: CharacterEntry,
  options: CharacterStatePurgeOptions = {},
): void {
  const {
    restoreNeutralPose = false,
    clearExpression = true,
    clearMotionBookkeeping = true,
  } = options;

  // 1. Custom motion ownership: disposes the Motion-stage writer (restores SDK
  //    eye blink, detaches its listeners) and releases the parameters it
  //    controlled. Must happen before injectedParams is cleared so the ids are
  //    removed by ownership rather than by a blanket reset (lip sync keeps its
  //    channel).
  releaseCustomMotionOwnership(entry);

  // 2. A buffered play intent from an earlier playback/seek position must never
  //    land after the purge — bumping the epoch also invalidates the in-flight
  //    `_executePlayMotion` background task.
  entry._pendingPlayMotion = undefined;
  entry.motionEpoch = (entry.motionEpoch ?? 0) + 1;

  if (clearMotionBookkeeping) {
    entry.motionStartTime = undefined;
    entry.motionStartUtTime = undefined;
    entry.lastOffset = undefined;
    // The seek-boundary snapshot is re-applied every frame while the playhead
    // sits inside the handoff window: keeping it across a seek makes the
    // fade-in of the *next* motion start from a foreign pose.
    entry.pendingSeekBoundarySnapshot = undefined;
    entry.pendingSeekBoundaryMotionStartTime = undefined;
    entry.pendingSeekBoundaryDuration = undefined;
    entry.lastSnapshot = undefined;
  }

  // 3. Injected parameter replay: the frame loop writes this map back onto the
  //    core every frame, so any leftover value outranks both a curve and an
  //    expression. Lip-sync owns its own channel and releases itself.
  for (const parameterId of Object.keys(entry.injectedParams)) {
    if (entry.lipSyncParameterIds?.has(parameterId)) continue;
    delete entry.injectedParams[parameterId];
  }

  const model = entry.model;
  if (!model) return;

  const controls = getLive2DRuntimeAdapter(entry.runtime).getControls();
  controls.stopAllMotions(model);
  controls.clearMotionState(model);

  if (clearExpression) {
    // The "latest expression intent must survive motion hard resets" rule does
    // not extend across a seek: the next sync re-declares the intent, and a
    // stale one would be restored by `_hardReset` on the following motion.
    entry.expressionKey = null;
    controls.setExpression(model, null);
  }

  if (restoreNeutralPose) {
    restoreNeutralModelPose(entry, model);
  }
}

/**
 * Return a model instance to its neutral pose before it is reused.
 *
 * Prefers the idle snapshot captured when the model was first loaded (the pose
 * the engine treats as "no motion"); falls back to the SDK's own default
 * parameters.
 */
export function restoreNeutralModelPose(entry: CharacterEntry, model: any): void {
  neutralizeModel(model, entry.idleSnapshot ?? null);
}

/**
 * Pose captured from a model instance before any motion or expression ran.
 *
 * Stored on the internal model so it survives the preload pool: an instance
 * handed to a new character still knows its own pristine pose.
 */
interface ModelNeutralPose {
  params: Float32Array;
  opacities?: Float32Array;
}

const NEUTRAL_POSE_MARK = '__aeonstageryNeutralPose';

/**
 * Capture the pristine pose of every concrete model, once per instance.
 *
 * Must run before the first `model.update()`: `Cubism2InternalModel.update()`
 * calls `coreModel.saveParam()` on every frame, so from the first frame onwards
 * the SDK's saved buffer holds the *last motion pose* instead of the idle one —
 * which makes `resetCoreParams()` restore the previous action through its
 * preferred `core.loadParam()` path.
 */
export function captureModelNeutralPoseOnce(model: any): void {
  for (const target of concreteModels(model)) {
    const internalModel = target?.internalModel;
    const coreModel = internalModel?.coreModel;
    if (!internalModel || !coreModel || internalModel[NEUTRAL_POSE_MARK]) continue;
    try {
      const params = internalModel.parameterValues
        ?? coreModel.getParameterValues?.()
        ?? coreModel.paramValues
        ?? coreModel._$5S?._$_2;
      if (!params || params.length === 0) continue;
      const opacities = readPartOpacities(internalModel);
      internalModel[NEUTRAL_POSE_MARK] = {
        params: Float32Array.from(params as ArrayLike<number>),
        opacities: opacities && opacities.length ? Float32Array.from(opacities as ArrayLike<number>) : undefined,
      };
    } catch (e) {
      /* a model whose params are unreadable falls back to resetCoreParams */
    }
  }
}

/** Write `pose` onto a concrete model. Returns false when nothing was written. */
function writePose(coreModel: any, internalModel: any, pose: ModelNeutralPose): boolean {
  const values = internalModel?.parameterValues
    ?? coreModel.getParameterValues?.()
    ?? coreModel.paramValues
    ?? coreModel._$5S?._$_2;
  let wrote = false;

  if (values && pose.params && values.length > 0) {
    const length = Math.min(values.length, pose.params.length);
    for (let i = 0; i < length; i++) values[i] = pose.params[i];
    wrote = true;
  }

  if (pose.opacities) {
    // Part opacities are the channel Cubism 2.1 uses for expression part
    // swaps; `saveParam()`/`loadParam()` never cover them, so they must be
    // restored explicitly or a recycled model keeps the last expression.
    wrote = writePartOpacities(internalModel, pose.opacities) || wrote;
  }

  if (wrote && typeof coreModel.saveParam === 'function') {
    coreModel.saveParam();
  }

  return wrote;
}

function neutralizeModel(
  model: any,
  fallbackPose: { params: Float32Array; opacities: Float32Array } | null,
): void {
  for (const target of concreteModels(model)) {
    const internalModel = target?.internalModel;
    const coreModel = internalModel?.coreModel;
    if (!coreModel) continue;
    const neutral = (internalModel?.[NEUTRAL_POSE_MARK] as ModelNeutralPose | undefined) ?? fallbackPose ?? null;
    if (neutral && writePose(coreModel, internalModel, neutral)) continue;
    resetCoreParams(coreModel);
  }
}

/**
 * Neutralise a bare model instance — no CharacterEntry required.
 *
 * Used when a model is taken from the preload pool: the instance still carries
 * the motion queue, expression and pose of its previous owner, and the engine
 * captures its "idle snapshot" right afterwards. Without this the neutral
 * baseline of the new character is the previous scene time's pose.
 */
export function resetModelToNeutralPose(model: any, runtime: Live2DRuntimeDescriptor): void {
  if (!model) return;
  // Capture before touching anything: a recycled instance was captured the
  // first time it was added, a fresh one is still pristine.
  captureModelNeutralPoseOnce(model);
  const controls = getLive2DRuntimeAdapter(runtime).getControls();
  controls.stopAllMotions(model);
  controls.clearMotionState(model);
  controls.setExpression(model, null);
  neutralizeModel(model, null);
}

function concreteModels(model: any): any[] {
  if (!model) return [];
  return typeof model.getAllModels === 'function' ? model.getAllModels() : [model];
}
