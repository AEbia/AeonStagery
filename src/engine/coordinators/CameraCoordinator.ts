import type { RuntimeTimelineAction } from '../RuntimeTimelineScene';
import type { CameraFollowConfig, CameraState } from '../../api/types/camera';
import { computeCameraStateAtTime, findFollowReleaseInstant, type CameraPosition, type CameraStateResolverDeps } from '../CameraStateResolver';
import { resolveVec2 } from '../utils/math';
import { computeCameraShakeAtTime, type CameraShakeOffset } from '../CameraShake';
import { evaluateCameraChannels, getPreparedCameraZoomResolver, type CameraEvaluationOutput, type CameraLogicalReferenceSize } from '../CameraChannelEvaluator';

/** Whether all camera channels can be evaluated without live character geometry. */
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
  revision?: string | number;
  trajectoryRevision?: string | number;
  /** Preliminary seeks run before visible models have been materialized. */
  captureFocus?: boolean;
  /** Frame reads retain live pursuit, including its frozen position on pause. */
  retainFollowPosition?: boolean;
}

interface ResolvedStatePatch {
  position?: { x: number; y: number };
  zoom?: number;
  rotation?: number;
}

interface CameraMuscle {
  getState(): CameraState;
  follow(characterId: string, config?: CameraFollowConfig): void;
  unfollow(): void;
  tickFollow(forceUpdate?: boolean): void;
  applyShakeOffset(offset: CameraShakeOffset): void;
  /** Hard-set the given camera channels (baseline restoration on seeks). */
  applyResolvedState(patch: ResolvedStatePatch): void;
}

export class CameraCoordinator {
  private controller: CameraMuscle;
  private focusTimeline?: readonly RuntimeTimelineAction[];
  private focusRevision?: string | number;
  private readonly focusAnchors = new Map<string, CameraPosition | null>();
  private activeFollowKey?: string;
  // Only the current pursuit and its last release frame are retained. These
  // are live playback state, never a prepared trajectory or a seek history.
  private liveFollow?: { action: RuntimeTimelineAction; releaseTime: number };
  private followRelease?: { action: RuntimeTimelineAction; releaseTime: number; position: CameraPosition };

  constructor(controller: CameraMuscle) {
    this.controller = controller;
  }

  private withCapturedFocus(timeline: readonly RuntimeTimelineAction[], deps: CameraCoordinatorDeps): CameraStateResolverDeps {
    if (this.focusTimeline !== timeline || this.focusRevision !== deps.revision) {
      this.focusAnchors.clear();
      this.focusTimeline = timeline;
      this.focusRevision = deps.revision;
      this.activeFollowKey = undefined;
      this.liveFollow = undefined;
      this.followRelease = undefined;
    }
    return {
      ...deps,
      resolveFocusPosition: (characterId, start, part) => {
        const key = JSON.stringify([characterId, start, part]);
        if (!this.focusAnchors.has(key)) {
          const anchor = deps.resolveFocusPosition
            ? deps.resolveFocusPosition(characterId, start, part)
            : deps.resolveCharacterPositionAtTime
              ? deps.resolveCharacterPositionAtTime(characterId, start, part)
              : deps.resolveCharacterPosition?.(characterId, part) ?? null;
          if (deps.captureFocus === false) return anchor;
          this.focusAnchors.set(key, anchor ? { ...anchor } : null);
        }
        return this.focusAnchors.get(key) ?? null;
      },
    };
  }

  /**
   * Scan the timeline at the given time and determine the correct
   * camera follow + shake state.
   *
   * Basic channels use pure evaluation. Character cameras use the visible
   * stage anchors and the existing follow controller; they never request
   * isolated model simulation. Explicit trajectory callers remain supported.
   */
  sync(
    time: number,
    timeline: readonly RuntimeTimelineAction[],
    deps: CameraCoordinatorDeps = {},
  ): CameraEvaluationOutput | undefined {
    if (deps.anchorTrajectories !== undefined || usesUnifiedCameraChannels(timeline)) {
      const resolved = evaluateCameraChannels({
        timeline,
        sceneTime: time,
        logicalReferenceSize: deps.logicalReferenceSize ?? { width: 1920, height: 1080 },
        anchorTrajectories: deps.anchorTrajectories ?? [],
        revision: deps.revision,
        trajectoryRevision: deps.trajectoryRevision,
      });
      this.controller.unfollow();
      this.activeFollowKey = undefined;
      this.controller.applyShakeOffset(resolved.shake);
      this.controller.applyResolvedState(resolved);
      return resolved;
    }
    const evaluationDeps = this.withCapturedFocus(timeline, deps);
    if (!deps.retainFollowPosition) {
      this.liveFollow = undefined;
      this.followRelease = undefined;
    } else if (this.liveFollow && time >= this.liveFollow.releaseTime) {
      this.followRelease = { ...this.liveFollow, position: resolveVec2(this.controller.getState().position) };
      this.liveFollow = undefined;
    }
    const resolved = computeCameraStateAtTime(timeline, time, {
      ...evaluationDeps,
      resolveZoomAtTime: deps.resolveZoomAtTime ?? getPreparedCameraZoomResolver({ timeline, revision: deps.revision }),
      resolveLiveFollowRelease: (action, atTime) => this.followRelease?.action === action && atTime >= this.followRelease.releaseTime
        ? this.followRelease.position : null,
    });

    // Keep pursuit on the live follow ticker. Scene-time reads must not snap
    // it to the reconstruction approximation or re-register it every frame.
    if (resolved.follow) {
      const followKey = JSON.stringify(resolved.follow);
      if (!deps.retainFollowPosition || this.activeFollowKey !== followKey) {
        this.controller.follow(resolved.follow.characterId, {
          offset: [resolved.follow.offset.x, resolved.follow.offset.y],
          smoothing: resolved.follow.smoothing,
        });
        this.activeFollowKey = followKey;
      }
      if (!deps.retainFollowPosition) this.controller.tickFollow(true);
      if (deps.retainFollowPosition && !this.liveFollow) {
        const action = timeline.filter(candidate => candidate.action === 'cameraFollow' && (candidate.time ?? 0) <= time)
          .sort((left, right) => (left.time ?? 0) - (right.time ?? 0)).at(-1);
        if (action) {
          const duration = typeof action.params.duration === 'number' ? action.params.duration : Infinity;
          this.liveFollow = { action, releaseTime: Math.min((action.time ?? 0) + duration, findFollowReleaseInstant(timeline, action)) };
        }
      }
    } else {
      this.controller.unfollow();
      this.activeFollowKey = undefined;
      this.liveFollow = undefined;
    }

    // 2. Reconstruct finite shake without killing any scheduled timeline.
    this.controller.applyShakeOffset(computeCameraShakeAtTime(timeline, time));

    // Property tracks and captured focus destinations share the same current-
    // time evaluation for playback and seeks. Only live pursuit owns position
    // during frame reads; a seek/export restores its approximate landing frame.
    this.controller.applyResolvedState({
      ...(!deps.retainFollowPosition || !resolved.follow ? { position: { ...resolved.position } } : {}),
      zoom: resolved.zoom,
      rotation: resolved.rotation,
    });
    return undefined;
  }
}
