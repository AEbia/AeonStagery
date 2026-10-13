import type { CharacterEntry } from '../Live2DConfig';
import { captureModelNeutralPoseOnce } from './runtime/BoundModelInitialization';
import type { Live2DRuntimeDescriptor } from '../Live2DRuntimeResolver';
import { getLive2DRuntimeAdapter } from '../Live2DRuntimeAdapter';
import { releaseCustomMotionOwnership } from './customMotionOwnership';
// Temporary compatibility export for remaining migration callers.
export { captureModelNeutralPoseOnce } from './runtime/BoundModelInitialization';

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

  if (clearExpression) entry.expressionKey = null;
  const handle = entry.runtimeHandle ?? getLive2DRuntimeAdapter(entry.runtime).createModelHandle(entry.id, model, entry.runtime);
  handle.resetRuntimeState({
    pose: restoreNeutralPose ? 'neutral' : 'preserve',
    clearExpression, idleSnapshot: entry.idleSnapshot ?? null,
  });
}

/** Compatibility helper for performance callers migrated in later tickets. */
export function restoreNeutralModelPose(entry: CharacterEntry, model: object): void {
  // Pose-only handoffs must preserve the newly enqueued motion and expression.
  const handle = entry.runtimeHandle ?? getLive2DRuntimeAdapter(entry.runtime).createModelHandle(entry.id, model, entry.runtime);
  handle.resetRuntimeState({ pose: 'neutral', stopPlayback: false, clearExpression: false, idleSnapshot: entry.idleSnapshot ?? null });
}

/** Compatibility helper for existing tests and private migration callers. */
export function resetModelToNeutralPose(model: object, runtime: Live2DRuntimeDescriptor): void {
  captureModelNeutralPoseOnce(model);
  getLive2DRuntimeAdapter(runtime).createModelHandle('neutral-reset', model, runtime)
    .resetRuntimeState({ pose: 'neutral' });
}
