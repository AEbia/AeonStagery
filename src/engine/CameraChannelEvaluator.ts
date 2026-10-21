import type { RuntimeTimelineAction } from './RuntimeTimelineScene';
import {
  computeCameraStateAtTime,
  type CameraPosition,
  type CameraStateResolverDeps,
  type ResolvedCameraState,
} from './CameraStateResolver';
import { computeCameraShakeAtTime, type CameraShakeOffset } from './CameraShake';

import { sampleCameraAnchorTrajectory, type CameraAnchorEventSide, type CameraAnchorTrajectory } from './CameraFollowHistory';
export { sampleCameraAnchorTrajectory, type CameraAnchorEvent, type CameraAnchorEventSide, type CameraAnchorSample, type CameraAnchorTrajectory, type CameraAnchorValidityInterval } from './CameraFollowHistory';

export interface CameraLogicalReferenceSize {
  readonly width: number;
  readonly height: number;
}

export interface CameraEvaluationInput {
  readonly timeline: readonly Readonly<Omit<RuntimeTimelineAction, 'params'> & {
    readonly params: Readonly<Record<string, unknown>>;
  }>[];
  readonly sceneTime: number;
  readonly logicalReferenceSize: CameraLogicalReferenceSize;
  readonly anchorTrajectories: readonly CameraAnchorTrajectory[];
  readonly anchorEventSide?: CameraAnchorEventSide;
  /** Timeline content revision; distinct from trajectory schema version. */
  readonly revision?: string | number;
  readonly trajectoryRevision?: string | number;
}

export type CameraEvaluationDiagnosticCode =
  | 'missing-focus-anchor'
  | 'retired-camera-channel'
  | 'rotation-edge-exposure';

export interface CameraEvaluationDiagnostic {
  readonly code: CameraEvaluationDiagnosticCode;
  readonly severity: 'warning';
  readonly actionId?: string;
  readonly message: string;
}

export interface CameraEvaluationOutput {
  readonly position: Readonly<CameraPosition>;
  readonly zoom: number;
  readonly rotation: number;
  readonly follow: Readonly<ResolvedCameraState['follow']>;
  readonly coverage: Readonly<ResolvedCameraState['coverage']>;
  readonly shake: Readonly<CameraShakeOffset>;
  readonly diagnostics: readonly CameraEvaluationDiagnostic[];
}

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

function identityOf(value: object): number {
  const known = objectIds.get(value);
  if (known !== undefined) return known;
  const identity = nextObjectId++;
  objectIds.set(value, identity);
  return identity;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function focusCharacter(params: Record<string, unknown>): string | undefined {
  const focus = readRecord(params.focus);
  return readString(params, 'characterId') ?? (focus ? readString(focus, 'character') : undefined);
}

function focusPart(params: Record<string, unknown>): string {
  const focus = readRecord(params.focus);
  return (focus && readString(focus, 'part'))
    ?? readString(params, 'targetPart')
    ?? 'head';
}

function followPart(params: Record<string, unknown>): string {
  const part = readRecord(params.focus)?.part;
  return typeof part === 'string' && part.length > 0 ? part : 'center';
}

function getTrajectory(
  trajectories: readonly CameraAnchorTrajectory[],
  characterId: string,
  part: string,
): CameraAnchorTrajectory | undefined {
  return trajectories.find((trajectory) => trajectory.characterId === characterId && trajectory.part === part);
}

function hasFocusWriter(action: RuntimeTimelineAction, queryTime: number): boolean {
  if (action.action !== 'cameraMotion' || (action.time ?? 0) > queryTime) return false;
  const params = action.params;
  return Boolean(focusCharacter(params) && ['pan', 'push', 'pull', 'zoom', 'rotate'].includes(String(params.move)));
}

function estimateRotationEdgeExposure(
  state: ResolvedCameraState,
  reference: CameraLogicalReferenceSize,
): boolean {
  const radians = Math.abs(state.rotation) * Math.PI / 180;
  if (radians < 1e-8 || !(reference.width > 0) || !(reference.height > 0)) return false;
  const aspect = reference.width / reference.height;
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));
  const minimumZoom = Math.max(cosine + aspect * sine, cosine + sine / aspect);
  return state.zoom + 1e-8 < minimumZoom;
}

/** Pure camera channel evaluation for an arbitrary scene-time sample. */
export function evaluateCameraChannels(input: CameraEvaluationInput): CameraEvaluationOutput {
  const diagnostics: CameraEvaluationDiagnostic[] = [];
  const side = input.anchorEventSide ?? 'right';
  const anchorAt = (characterId: string, time: number, part?: string): CameraPosition | null => {
    const trajectory = getTrajectory(input.anchorTrajectories, characterId, part ?? 'head');
    return trajectory ? sampleCameraAnchorTrajectory(trajectory, time, side) : null;
  };
  const zoomTimeline = input.timeline.filter((action) => action.action === 'cameraReset'
    || (action.action === 'cameraMotion' && (action.params.zoom !== undefined || action.params.move === 'zoom'
      || action.params.move === 'push' || action.params.move === 'pull' || action.params.move === 'rotate'))
    || (action.action === 'cameraPath' && Array.isArray(action.params.keyframes)
      && action.params.keyframes.some((keyframe) => readRecord(keyframe)?.zoom !== undefined)));
  const zoomCache = new Map<number, number>();
  const zoomAt = (time: number): number => {
    const cached = zoomCache.get(time);
    if (cached !== undefined) return cached;
    const value = computeCameraStateAtTime(zoomTimeline, time, { compiledChannelOwnership: true }).zoom;
    zoomCache.set(time, value);
    return value;
  };
  const trajectoryIdentity = input.anchorTrajectories.map((trajectory) =>
    `${identityOf(trajectory)}:${trajectory.revision ?? 'unversioned'}`).join(',');
  const followCacheKey = [
    `timeline:${identityOf(input.timeline)}`,
    `timelineRevision:${input.revision ?? 'unversioned'}`,
    `trajectoryBundle:${identityOf(input.anchorTrajectories)}`,
    `trajectoryRevision:${input.trajectoryRevision ?? 'unversioned'}`,
    `trajectories:${trajectoryIdentity}`,
    `reference:${input.logicalReferenceSize.width}x${input.logicalReferenceSize.height}`,
  ].join('|');
  const deps: CameraStateResolverDeps = {
    resolveCharacterPosition: (characterId, part) => anchorAt(characterId, input.sceneTime, part),
    resolveCharacterPositionAtTime: (characterId, time, part) => anchorAt(characterId, time, part),
    compiledChannelOwnership: true,
    anchorTrajectories: input.anchorTrajectories,
    resolveZoomAtTime: zoomAt,
    followCacheKey,
    followEventSide: side,
  };

  const supportedTimeline = input.timeline.filter((action) => {
    if (action.action !== 'cameraHitchcock') return true;
    diagnostics.push({
      code: 'retired-camera-channel',
      severity: 'warning',
      actionId: action._id,
      message: 'The Hitchcock camera channel has been retired and was omitted from evaluation.',
    });
    return false;
  });
  const runtimeTimeline: readonly RuntimeTimelineAction[] = supportedTimeline;
  const state = computeCameraStateAtTime(runtimeTimeline, input.sceneTime, deps);

  for (const action of supportedTimeline) {
    if (!hasFocusWriter(action, input.sceneTime)) continue;
    const characterId = focusCharacter(action.params);
    if (!characterId) continue;
    const part = action.action === 'cameraFollow' ? followPart(action.params) : focusPart(action.params);
    const trajectory = getTrajectory(input.anchorTrajectories, characterId, part);
    const start = action.time ?? 0;
    if (!trajectory || sampleCameraAnchorTrajectory(trajectory, start, side) === null) {
      diagnostics.push({
        code: 'missing-focus-anchor',
        severity: 'warning',
        actionId: action._id,
        message: `Focus anchor ${characterId}/${part} is unavailable at the action start; position was skipped.`,
      });
    }
  }

  if (estimateRotationEdgeExposure(state, input.logicalReferenceSize)) {
    diagnostics.push({
      code: 'rotation-edge-exposure',
      severity: 'warning',
      message: 'Camera rotation and zoom may expose uncovered frame edges.',
    });
  }

  return {
    ...state,
    shake: computeCameraShakeAtTime(input.timeline, input.sceneTime),
    diagnostics,
  };
}
