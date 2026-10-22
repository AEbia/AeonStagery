import type { RuntimeTimelineAction } from '../RuntimeTimelineScene';
import type { CameraFollowConfig } from '../../api/types/camera';
import { computeCameraStateAtTime, type CameraStateResolverDeps } from '../CameraStateResolver';
import { computeCameraShakeAtTime, type CameraShakeOffset } from '../CameraShake';
import { evaluateCameraChannels, type CameraEvaluationOutput, type CameraLogicalReferenceSize } from '../CameraChannelEvaluator';

/** Transitional boundary: role framing still needs the live-anchor runtime. */
export function usesUnifiedCameraChannels(timeline: readonly RuntimeTimelineAction[]): boolean {
  return !timeline.some(({ action, params }) => {
    if (action === 'cameraFollow' || action === 'cameraUnfollow' || action === 'cameraHitchcock') return true;
    if (action !== 'cameraMotion') return false;
    const focus: unknown = params.focus;
    return params.move === 'follow' || params.move === 'dolly'
      || typeof params.characterId === 'string' || typeof params.targetCharacter === 'string'
      || (typeof focus === 'object' && focus !== null && 'character' in focus
        && typeof focus.character === 'string');
  });
}

interface CameraCoordinatorDeps extends CameraStateResolverDeps {
  logicalReferenceSize?: CameraLogicalReferenceSize;
}

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
   * Anchor-independent scenes share one authority for playback and seek.
   * Role-dependent scenes retain live focus/follow until historical anchor
   * preparation is wired into this runtime boundary.
   */
  sync(
    time: number,
    timeline: readonly RuntimeTimelineAction[],
    deps: CameraCoordinatorDeps = {},
  ): CameraEvaluationOutput | undefined {
    if (usesUnifiedCameraChannels(timeline)) {
      const resolved = evaluateCameraChannels({
        timeline,
        sceneTime: time,
        logicalReferenceSize: deps.logicalReferenceSize ?? { width: 1920, height: 1080 },
        anchorTrajectories: [],
      });
      this.controller.unfollow();
      this.controller.applyShakeOffset(resolved.shake);
      this.controller.applyResolvedState(resolved);
      return resolved;
    }
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
    return undefined;
  }
}
