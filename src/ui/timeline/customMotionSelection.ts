import type { Live2DParameterMetadata } from '../../api/types/live2d-parameter-animation';
import type { CustomMotionTrack } from '../../api/types/semantic-scene';
import type { CustomMotionKeyframeRef } from '../../services/timeline-authoring/customMotionKeyframeEdits';

export const keyframeKey = (parameterId: string, time: number) => JSON.stringify([parameterId, time]);
export interface SelectionRect { left: number; top: number; right: number; bottom: number }
export function selectionRect(x1: number, y1: number, x2: number, y2: number): SelectionRect {
  return { left: Math.min(x1, x2), right: Math.max(x1, x2), top: Math.min(y1, y2), bottom: Math.max(y1, y2) };
}
export function lowerBound(points: readonly { time: number }[], time: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
export function keyframesInRect(
  tracks: readonly CustomMotionTrack[], rect: SelectionRect,
  blockTime: number, pps: number, yOf: (trackIndex: number, value: number) => number,
): CustomMotionKeyframeRef[] {
  const result: CustomMotionKeyframeRef[] = [];
  const start = rect.left / pps - blockTime;
  const end = rect.right / pps - blockTime;
  tracks.forEach((track, trackIndex) => {
    for (let index = lowerBound(track.keyframes, start); index < track.keyframes.length; index++) {
      const point = track.keyframes[index];
      if (point.time > end) break;
      const y = yOf(trackIndex, point.value);
      if (y >= rect.top && y <= rect.bottom) result.push({ parameterId: track.parameterId, time: point.time });
    }
  });
  return result;
}

/** Build once per gesture; each candidate only checks the selected points. */
export function createGroupMoveResolver(
  tracks: readonly CustomMotionTrack[], refs: readonly CustomMotionKeyframeRef[],
  duration: number, fps: number, snapSingle = false,
) {
  if (!refs.length) return () => 0;
  const chosen = new Set(refs.map((ref) => keyframeKey(ref.parameterId, ref.time)));
  const occupied = new Map(tracks.map((track) => [track.parameterId,
    new Set(track.keyframes.filter((point) => !chosen.has(keyframeKey(track.parameterId, point.time))).map((point) => point.time)),
  ]));
  // A single native point snaps its destination; groups retain subframe spacing.
  const origin = snapSingle && refs.length === 1 ? -refs[0].time * fps : 0;
  const min = Math.ceil(Math.max(...refs.map((ref) => -ref.time * fps)) - origin - 1e-9);
  const max = Math.floor(Math.min(...refs.map((ref) => (duration - ref.time) * fps)) - origin + 1e-9);
  const valid = (frames: number) => refs.every((ref) => !occupied.get(ref.parameterId)?.has(ref.time + (frames + origin) / fps));
  return (requestedFrames: number): number => {
    if (requestedFrames === 0) return 0;
    const target = Math.max(min, Math.min(max, Math.round(requestedFrames - origin)));
    if (valid(target)) return target + origin;
    for (let distance = 1; distance <= Math.max(target - min, max - target); distance++) {
      // Prefer the candidate closer to zero on a tie.
      const candidates = target + origin >= 0 ? [target - distance, target + distance] : [target + distance, target - distance];
      for (const candidate of candidates) if (candidate >= min && candidate <= max && valid(candidate)) return candidate + origin;
    }
    return 0;
  };
}

export function edgeScrollSpeed(position: number, start: number, end: number): number {
  if (position < start + 32) return -480 * Math.min(1, Math.max(0, (start + 32 - position) / 32));
  if (position > end - 32) return 480 * Math.min(1, Math.max(0, (position - end + 32) / 32));
  return 0;
}

export function resolveParameterRange(track: CustomMotionTrack | undefined, metadata?: Live2DParameterMetadata) {
  if (metadata && Number.isFinite(metadata.min) && Number.isFinite(metadata.max) && metadata.max! > metadata.min!) {
    return { min: metadata.min!, max: metadata.max!, bounded: true };
  }
  let min = Infinity;
  let max = -Infinity;
  for (const point of track?.keyframes ?? []) {
    min = Math.min(min, point.value);
    max = Math.max(max, point.value);
    if (point.segment?.type === 'bezier') for (const cp of point.segment.controlPoints) {
      min = Math.min(min, cp.value);
      max = Math.max(max, cp.value);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
  const padding = (max - min) * 0.18 || 1;
  return { min: min - padding, max: max + padding, bounded: false };
}
