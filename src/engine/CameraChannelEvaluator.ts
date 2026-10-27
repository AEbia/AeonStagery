import type { RuntimeTimelineAction } from './RuntimeTimelineScene';
import {
  computeCameraStateAtTime,
  prepareCameraZoomResolver,
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
  const properties = params._cameraProperties;
  const writesPosition = properties === undefined
    ? ['pan', 'push', 'pull', 'zoom', 'rotate'].includes(String(params.move))
    : Array.isArray(properties) && properties.includes('position');
  return Boolean(focusCharacter(params) && writesPosition);
}

interface PreparedZoomResolverEntry {
  readonly signature: string;
  readonly resolveAt: ReturnType<typeof prepareCameraZoomResolver>;
}

const preparedZoomResolvers = new WeakMap<object, PreparedZoomResolverEntry>();

/** Shared authored zoom curve for pure evaluation and live character cameras. */
export function getPreparedCameraZoomResolver(
  input: Pick<CameraEvaluationInput, 'timeline' | 'revision'>,
): ReturnType<typeof prepareCameraZoomResolver> {
  const zoomTimeline = input.timeline.filter((action) => action.action === 'cameraReset'
    || (action.action === 'cameraMotion' && (action.params.zoom !== undefined || action.params.move === 'zoom'
      || action.params.move === 'push' || action.params.move === 'pull' || action.params.move === 'rotate'))
    || (action.action === 'cameraPath' && Array.isArray(action.params.keyframes)
      && action.params.keyframes.some((keyframe) => readRecord(keyframe)?.zoom !== undefined)));

  let signature: string | undefined;
  try {
    signature = JSON.stringify([input.revision, zoomTimeline]);
  } catch {
    // Runtime timelines are normally compiled JSON. Cyclic or otherwise
    // non-serializable input stays correct by rebuilding its derived curve.
  }

  if (signature !== undefined) {
    const cached = preparedZoomResolvers.get(input.timeline);
    if (cached?.signature === signature) return cached.resolveAt;
  }

  const resolveAt = prepareCameraZoomResolver(zoomTimeline);
  if (signature !== undefined) preparedZoomResolvers.set(input.timeline, { signature, resolveAt });
  return resolveAt;
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

/** Share diagnostics between explicit trajectories and captured live anchors. */
export function collectCameraDiagnostics(
  input: Pick<CameraEvaluationInput, 'timeline' | 'sceneTime' | 'logicalReferenceSize'>,
  state: ResolvedCameraState,
  resolveFocusPosition: NonNullable<CameraStateResolverDeps['resolveFocusPosition']>,
): readonly CameraEvaluationDiagnostic[] {
  const diagnostics: CameraEvaluationDiagnostic[] = [];
  for (const action of input.timeline) {
    if (action.action !== 'cameraHitchcock') continue;
    diagnostics.push({ code: 'retired-camera-channel', severity: 'warning', actionId: action._id,
      message: 'The Hitchcock camera channel has been retired and was omitted from evaluation.' });
  }
  for (const action of input.timeline) {
    if (!hasFocusWriter(action, input.sceneTime)) continue;
    const characterId = focusCharacter(action.params);
    if (!characterId) continue;
    const part = focusPart(action.params);
    const anchor = resolveFocusPosition(characterId, action.time ?? 0, part);
    if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) {
      diagnostics.push({
        code: 'missing-focus-anchor', severity: 'warning', actionId: action._id,
        message: `Focus anchor ${characterId}/${part} is unavailable at the action start; position was skipped.`,
      });
    }
  }
  if (estimateRotationEdgeExposure(state, input.logicalReferenceSize)) {
    diagnostics.push({ code: 'rotation-edge-exposure', severity: 'warning',
      message: 'Camera rotation and zoom may expose uncovered frame edges.' });
  }
  return diagnostics;
}

/** Pure camera channel evaluation for an arbitrary scene-time sample. */
export function evaluateCameraChannels(input: CameraEvaluationInput): CameraEvaluationOutput {
  const side = input.anchorEventSide ?? 'right';
  const anchorAt = (characterId: string, time: number, part?: string): CameraPosition | null => {
    const trajectory = getTrajectory(input.anchorTrajectories, characterId, part ?? 'head');
    return trajectory ? sampleCameraAnchorTrajectory(trajectory, time, side) : null;
  };
  const zoomAt = getPreparedCameraZoomResolver(input);
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

  const supportedTimeline = input.timeline.filter((action) => action.action !== 'cameraHitchcock');
  const runtimeTimeline: readonly RuntimeTimelineAction[] = supportedTimeline;
  const state = computeCameraStateAtTime(runtimeTimeline, input.sceneTime, deps);

  return {
    ...state,
    shake: computeCameraShakeAtTime(input.timeline, input.sceneTime),
    diagnostics: collectCameraDiagnostics(input, state, anchorAt),
  };
}
