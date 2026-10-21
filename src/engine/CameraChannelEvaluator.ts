import type { RuntimeTimelineAction } from './RuntimeTimelineScene';
import {
  computeCameraStateAtTime,
  type CameraPosition,
  type CameraStateResolverDeps,
  type ResolvedCameraState,
} from './CameraStateResolver';
import { computeCameraShakeAtTime, type CameraShakeOffset } from './CameraShake';

export interface CameraAnchorValidityInterval {
  /** Inclusive scene-time start. */
  readonly start: number;
  /** Exclusive scene-time end. */
  readonly end: number;
}

export interface CameraAnchorSample {
  readonly time: number;
  readonly position: CameraPosition;
}

/** A known jump in an anchor trajectory, with values on both sides. */
export interface CameraAnchorEvent {
  readonly time: number;
  readonly left: CameraPosition;
  readonly right: CameraPosition;
}

/**
 * Versioned, immutable character anchor history. Samples interpolate linearly
 * only inside a declared validity interval. At an event timestamp, the caller
 * chooses the left or right value; normal camera evaluation uses the right.
 */
export interface CameraAnchorTrajectory {
  readonly version: 1;
  readonly characterId: string;
  readonly part: string;
  readonly validity: readonly CameraAnchorValidityInterval[];
  readonly samples: readonly CameraAnchorSample[];
  readonly events: readonly CameraAnchorEvent[];
}

export type CameraAnchorEventSide = 'left' | 'right';

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

function containsTime(intervals: readonly CameraAnchorValidityInterval[], time: number): boolean {
  return intervals.some((interval) => time >= interval.start && time < interval.end);
}

/** Return a trajectory value without extrapolating beyond its validity. */
export function sampleCameraAnchorTrajectory(
  trajectory: CameraAnchorTrajectory,
  time: number,
  side: CameraAnchorEventSide = 'right',
): CameraPosition | null {
  if (!containsTime(trajectory.validity, time)) return null;
  const event = trajectory.events.find((candidate) => candidate.time === time);
  if (event) return { ...event[side] };

  let before: { time: number; position: CameraPosition } | undefined;
  let after: { time: number; position: CameraPosition } | undefined;
  for (const sample of trajectory.samples) {
    if (sample.time <= time && (!before || sample.time > before.time)) before = sample;
    if (sample.time >= time && (!after || sample.time < after.time)) after = sample;
  }
  for (const knownEvent of trajectory.events) {
    if (knownEvent.time < time && (!before || knownEvent.time >= before.time)) {
      before = { time: knownEvent.time, position: knownEvent.right };
    }
    if (knownEvent.time > time && (!after || knownEvent.time <= after.time)) {
      after = { time: knownEvent.time, position: knownEvent.left };
    }
  }
  if (!before || !after) return null;
  if (before.time === after.time) return { ...before.position };
  const progress = (time - before.time) / (after.time - before.time);
  return {
    x: before.position.x + (after.position.x - before.position.x) * progress,
    y: before.position.y + (after.position.y - before.position.y) * progress,
  };
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
  const deps: CameraStateResolverDeps = {
    resolveCharacterPosition: (characterId, part) => anchorAt(characterId, input.sceneTime, part),
    resolveCharacterPositionAtTime: (characterId, time, part) => anchorAt(characterId, time, part),
    compiledChannelOwnership: true,
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
    const part = focusPart(action.params);
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
