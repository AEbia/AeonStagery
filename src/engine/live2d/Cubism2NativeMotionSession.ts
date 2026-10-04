/**
 * AeonStagery — Cubism 2 Native Motion Session
 *
 * Shared low-level runtime for starting Cubism 2.1 SDK motions and replaying
 * an offset in deterministic 50ms clock steps. Both Live2D seek/reconstruct
 * and BakeEngine use this session so the motion-start/offset/clock-spoofing
 * implementation exists in exactly one place (ADR-0033 / BakeMotionRuntime).
 *
 * The session never acquires the global UtSystem lock. Callers own the lock
 * and pass the compatible clock interface; BakeEngine uses the monotonic
 * per-tick lock, Live2DManager uses its per-character lock around seek jumps.
 */

export interface Cubism2NativeMotionTarget {
  readonly model: any;
  readonly internalModel: any;
  readonly motionManager: any;
}

export interface Cubism2NativeMotionClock {
  getUserTimeMSec(): number;
  setUserTimeMSec(ms: number): void;
}

export interface Cubism2NativeMotionStartOptions {
  readonly targets: readonly Cubism2NativeMotionTarget[];
  readonly motionKey: string;
  readonly priority: number;
  /** Motion-local offset in seconds (clamped to >= 0). */
  readonly offsetSeconds: number;
  readonly clock: Cubism2NativeMotionClock | null;
  /**
   * Invoked after every target's motion is enqueued and the clock is parked at
   * the motion start time, but BEFORE the offset fast-forward replay. Seek
   * restoration applies handoff snapshots in this window so the replay
   * evaluates from the restored pose instead of restarting at 0.
   */
  readonly beforeReplay?: (context: { motionStartUtTimeMs: number }) => void | Promise<void>;
}

export interface Cubism2NativeMotionStartResult {
  /** SDK clock space start time (utBase - offsetMs). */
  readonly motionStartUtTimeMs: number;
  /** Number of milliseconds actually replayed with 50ms steps. */
  readonly offsetReplayMs: number;
  /** True when at least one concrete target accepted the motion start. */
  readonly started: boolean;
}

export const CUBISM2_NATIVE_OFFSET_STEP_MS = 50;

function getConcreteTargets(targets: readonly Cubism2NativeMotionTarget[]): Cubism2NativeMotionTarget[] {
  const result: Cubism2NativeMotionTarget[] = [];
  for (const target of targets) {
    result.push(target);
  }
  return result;
}

/**
 * Step every target's motion queue to an absolute SDK time (`utTimeMs`) with
 * physics detached for the duration and the exact same object identities
 * restored afterwards: the clock jumps to `utTimeMs`, and Euler physics would
 * otherwise see a huge (or negative) dt and blow up into NaN.
 *
 * Shared by the offset-replay loop and `Live2DRuntimeAdapter`'s
 * advanceMotionOnly so the physics-guarded stepping exists in exactly one
 * place. A torn-down queue is skipped silently (legacy `updateCubism2MotionOnly`
 * parity — no model-wide fallback advance with an absolute time as a delta).
 */
export function stepMotionQueuesAt(targets: readonly Cubism2NativeMotionTarget[], utTimeMs: number): void {
  if (targets.length === 0) return;

  const physicsStates = targets.map(({ internalModel }) => ({
    internalModel,
    physics: internalModel?.physics,
  }));
  for (const { internalModel } of physicsStates) {
    if (internalModel) {
      internalModel.physics = null;
    }
  }

  try {
    for (const target of targets) {
      const coreModel = target.internalModel?.coreModel;
      if (!target.motionManager || !coreModel) continue;
      try {
        target.motionManager.update(coreModel, utTimeMs);
      } catch {
        try {
          target.motionManager.update(coreModel);
        } catch {
          // A torn-down queue may already be released: skip the step.
        }
      }
    }
  } finally {
    for (const { internalModel, physics } of physicsStates) {
      if (internalModel) {
        internalModel.physics = physics;
      }
    }
  }
}

export class Cubism2NativeMotionSession {
  /**
   * Start the same SDK motion on every concrete target and, when a shared
   * UtSystem clock exists, spoof the clock forward through `offsetSeconds` in
   * 50ms steps. The clock is left at `max(utBase, motionStartUtTime + offsetMs)`
   * so the caller's monotonic post-start update never moves backwards.
   *
   * Physics is temporarily disabled during replay because the clock starts at
   * `utBase - offsetMs` and would otherwise expose a negative dt to Euler
   * physics (the same guard Live2DMotionController uses).
   */
  async startMotion(options: Cubism2NativeMotionStartOptions): Promise<Cubism2NativeMotionStartResult> {
    const targets = getConcreteTargets(options.targets);
    const offsetMs = Math.max(0, options.offsetSeconds) * 1000;
    const clock = options.clock;

    const motionStartUtTimeMs = clock
      ? clock.getUserTimeMSec() - offsetMs
      : 0;

    if (clock) {
      clock.setUserTimeMSec(motionStartUtTimeMs);
    }

    // Store original physics references and disable them during the spoofed
    // replay. The same object identity must be restored after the replay.
    const physicsStates = targets.map(({ internalModel }) => ({
      internalModel,
      physics: internalModel?.physics,
    }));
    for (const { internalModel } of physicsStates) {
      if (internalModel) {
        internalModel.physics = null;
      }
    }

    try {
      const startResults = await Promise.allSettled(
        targets.map(({ motionManager }) => motionManager.startMotion(options.motionKey, 0, options.priority)),
      );
      const started = startResults.some((result) => result.status === 'fulfilled' && result.value !== false);

      // Contract: beforeReplay must NOT mutate the SDK clock. It runs while
      // the clock is parked at `motionStartUtTimeMs` (entry value - offsetMs),
      // and the replay baseline below is derived as `parked + offsetMs` — any
      // setUserTimeMSec() inside the callback would silently shift the replay
      // window. Current callers only apply snapshots (plain parameter arrays).
      // If beforeReplay throws, the finally still restores physics; the clock
      // stays parked until the engine's next per-frame monotonic advance,
      // which recovers the discipline without ever jumping backwards.
      await options.beforeReplay?.({ motionStartUtTimeMs });

      if (!clock || offsetMs <= 0) {
        return {
          motionStartUtTimeMs,
          offsetReplayMs: 0,
          started,
        };
      }

      const utBase = clock.getUserTimeMSec() + offsetMs;
      let currentMs = 0;
      while (currentMs < offsetMs) {
        const dt = Math.min(CUBISM2_NATIVE_OFFSET_STEP_MS, offsetMs - currentMs);
        currentMs += dt;
        const spoofedTime = motionStartUtTimeMs + currentMs;
        clock.setUserTimeMSec(spoofedTime);
        stepMotionQueuesAt(targets, spoofedTime);
      }

      const finalUtTime = Math.max(utBase, motionStartUtTimeMs + offsetMs);
      clock.setUserTimeMSec(finalUtTime);

      return {
        motionStartUtTimeMs,
        offsetReplayMs: offsetMs,
        started,
      };
    } finally {
      for (const { internalModel, physics } of physicsStates) {
        if (internalModel) {
          internalModel.physics = physics;
        }
      }
    }
  }
}
