import type { CharacterEntry } from '../Live2DConfig';

/**
 * Single ownership lifecycle for inline custom motions (ADR-0029).
 *
 * Live2DManager and Live2DMotionController share the same CharacterEntry
 * instances by reference, and either side can end a custom motion (manager:
 * explicit release / character removal; controller: resource-motion takeover,
 * motion stop, reset-to-idle). Two divergent copies of the release logic
 * leaked the Motion-stage writer: its listeners stayed attached and a motion
 * whose tracks owned the blink parameters left SDK eye blink permanently
 * suppressed until a later takeover reinstalled the stage. Both sides must
 * release through `releaseCustomMotionOwnership`.
 */

/**
 * Exit path: end the active custom motion's parameter ownership.
 *
 * Disposes the Motion-stage writer first — detaching its afterMotionUpdate
 * listeners and restoring SDK eye blink — then clears the runtime state and
 * removes the controlled parameters from the injected map. Lip-sync-owned
 * parameters stay untouched: that effect channel keeps running in its own
 * stage and releases them itself when it ends (ADR-0029 stage separation).
 */
export function releaseCustomMotionOwnership(entry: CharacterEntry): void {
  entry.customMotionStage?.dispose();
  entry.customMotionStage = null;
  if (!entry.customMotion) return;
  const state = entry.customMotion;
  entry.customMotion = undefined;
  entry.customMotionHandoff = undefined;
  for (const parameterId of state.controlledParameterIds) {
    if (entry.lipSyncParameterIds?.has(parameterId)) continue;
    delete entry.injectedParams[parameterId];
  }
}

/**
 * Entry path companion: purge injected-parameter entries for parameters the
 * incoming custom motion controls.
 *
 * In Motion-stage mode curve values are written inside model.update()
 * (afterMotionUpdate), so any stale value left in injectedParams would be
 * re-applied post-update by updateAll's re-injection loop and win over both
 * the curve and an active Expression every frame — reintroducing exactly the
 * bare-write override the stage was introduced to fix. The legacy evaluation
 * path self-healed this by rewriting injectedParams per frame; the stage does
 * not, so the takeover must reclaim these ids up front. Lip-sync-owned
 * parameters are exempt — that channel outranks the motion by ownership, not
 * execution timing (ADR-0029).
 */
export function reclaimControlledInjectedParams(entry: CharacterEntry): void {
  const state = entry.customMotion;
  if (!state) return;
  for (const parameterId of state.controlledParameterIds) {
    if (entry.lipSyncParameterIds?.has(parameterId)) continue;
    delete entry.injectedParams[parameterId];
  }
}
