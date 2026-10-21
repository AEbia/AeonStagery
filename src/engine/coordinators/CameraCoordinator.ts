import type { RuntimeTimelineAction } from '../RuntimeTimelineScene';
import type { CameraFollowConfig } from '../../api/types/camera';
import { computeCameraStateAtTime, type CameraStateResolverDeps } from '../CameraStateResolver';
import { computeCameraShakeAtTime, type CameraShakeOffset } from '../CameraShake';

interface ResolvedStatePatch {
  position?: { x: number; y: number };
  zoom?: number;
  rotation?: number;
}

interface CameraMuscle {
  follow(characterId: string, config?: CameraFollowConfig): void;
  unfollow(): void;
  tickFollow(forceUpdate?: boolean): void;
  applyShakeOffset(offset: CameraShakeOffset): void;
  /** Hard-set the given camera channels (baseline restoration on seeks). */
  applyResolvedState(patch: ResolvedStatePatch): void;
}

export class CameraCoordinator {
  private controller: CameraMuscle;

  constructor(controller: CameraMuscle) {
    this.controller = controller;
  }

  /**
   * Scan the timeline at the given time and determine the correct
   * camera follow + shake state.
   *
   * Channel lifecycle authority is the deterministic camera state resolver
   * (KSM-0003 runtime parity gate): channels no writer covers at/before the
   * query time are restored to their stage baseline instead of keeping
   * whatever a GSAP tween or the follow ticker last left behind.
   */
  sync(
    time: number,
    timeline: readonly RuntimeTimelineAction[],
    deps: CameraStateResolverDeps = {},
  ): void {
    const resolved = computeCameraStateAtTime(timeline, time, deps);

    // 1. Reconcile Camera Follow (ticker stays registered so forward playback
    // keeps tracking smoothly).
    if (resolved.follow) {
      this.controller.follow(resolved.follow.characterId, {
        offset: [resolved.follow.offset.x, resolved.follow.offset.y],
        smoothing: resolved.follow.smoothing,
      });
      // Snap to the live anchor first; the deterministic hard-set below wins
      // for this landing frame.
      this.controller.tickFollow(true);
    } else {
      this.controller.unfollow();
    }

    // 2. Reconstruct finite shake without killing any scheduled timeline.
    this.controller.applyShakeOffset(computeCameraShakeAtTime(timeline, time));

    // 3. Hard-set the full reconstructed state. GSAP only re-renders tweens
    // whose window the playhead actually crosses, so a jump landing in the
    // post-region of every camera tween (e.g. seeking back out of a long
    // follow) would otherwise keep whatever the follow ticker or an earlier
    // render left behind. The resolver output IS the timeline truth for
    // seek/export; GSAP remains authoritative only while playing forward.
    this.controller.applyResolvedState({
      position: { ...resolved.position },
      zoom: resolved.zoom,
      rotation: resolved.rotation,
    });
  }
}
