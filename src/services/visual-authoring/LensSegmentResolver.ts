import type { SceneMarker, SceneMeta } from '../../api/types/scene-common';

export interface LensSegmentTimelineAction {
  readonly time?: number;
  readonly params: Record<string, any>;
}

export interface LensSegmentScene {
  readonly meta: Readonly<SceneMeta>;
  readonly timeline: readonly LensSegmentTimelineAction[];
}

export interface ResolvedLensSegment {
  segmentId: string;
  start: number;
  end: number;
  startMarkerId?: string;
}

function isLensBoundaryMarker(marker: SceneMarker): boolean {
  return marker.role === 'lens-boundary';
}

function compareMarkers(a: SceneMarker, b: SceneMarker): number {
  if (a.time !== b.time) return a.time - b.time;
  return a.markerId.localeCompare(b.markerId);
}

export function resolveSceneEnd(scene: LensSegmentScene): number {
  const timelineEnd = scene.timeline
    .map((action) => (action.time ?? 0) + (Number(action.params?.duration) || 0))
    .reduce((max, value) => Math.max(max, value), 0);

  const markerEnd = (scene.meta.markers || [])
    .map((marker) => marker.time)
    .reduce((max, value) => Math.max(max, value), 0);

  return Math.max(timelineEnd, markerEnd, 0);
}

export function resolveLensSegments(scene: LensSegmentScene): ResolvedLensSegment[] {
  const sceneEnd = resolveSceneEnd(scene);
  const boundaryMarkers = [...(scene.meta.markers || [])]
    .filter(isLensBoundaryMarker)
    .sort(compareMarkers);

  const segments: ResolvedLensSegment[] = [];

  if (boundaryMarkers.length === 0 || boundaryMarkers[0].time > 0) {
    segments.push({
      segmentId: 'segment:opening',
      start: 0,
      end: boundaryMarkers[0]?.time ?? sceneEnd,
    });
  }

  for (let index = 0; index < boundaryMarkers.length; index += 1) {
    const marker = boundaryMarkers[index];
    const nextMarker = boundaryMarkers[index + 1];
    segments.push({
      segmentId: `segment:${marker.markerId}`,
      start: marker.time,
      end: nextMarker?.time ?? sceneEnd,
      startMarkerId: marker.markerId,
    });
  }

  if (segments.length === 0) {
    segments.push({
      segmentId: 'segment:opening',
      start: 0,
      end: sceneEnd,
    });
  }

  return segments;
}

export function resolveLensSegmentAtTime(scene: LensSegmentScene, time: number): ResolvedLensSegment {
  const segments = resolveLensSegments(scene);
  const clampedTime = Math.max(0, time);
  const found = segments.find((segment) => clampedTime >= segment.start && clampedTime < segment.end);
  return found ?? segments[segments.length - 1];
}
