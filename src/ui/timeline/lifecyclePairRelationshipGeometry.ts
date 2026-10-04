export const TIMELINE_LANE_HEIGHT_PX = 32;
export const TIMELINE_LANE_CENTER_LINE_TOP_PX = 15;
export const RELATIONSHIP_LINE_THICKNESS_PX = 2;

export interface LifecyclePairRelationshipSegment {
  readonly orientation: 'horizontal' | 'vertical';
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface LifecyclePairRelationshipGeometryInput {
  readonly startTime: number;
  readonly endTime: number;
  readonly pixelsPerSecond: number;
  readonly startLaneIndex: number;
  readonly endLaneIndex: number;
}

export interface LifecyclePairRelationshipLaneInput {
  readonly startTrackId?: string;
  readonly peerTrackId?: string;
  readonly startLaneIndex?: number;
  readonly peerLaneIndex?: number;
}

export interface TimelineRelationshipGeometryInput {
  readonly startTime: number;
  readonly endTime: number;
  readonly pixelsPerSecond: number;
  readonly startY: number;
  readonly endY: number;
  readonly contentOffsetPx?: number;
}

export interface TimelineRelationshipCurve {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly path: string;
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
}

/**
 * Lane indices are local to a track row. A cross-track rail stays in the
 * start row, so the peer lane is only meaningful when both actions share it.
 */
export function resolveLifecyclePairRelationshipLaneIndices({
  startTrackId,
  peerTrackId,
  startLaneIndex,
  peerLaneIndex,
}: LifecyclePairRelationshipLaneInput): Pick<LifecyclePairRelationshipGeometryInput, 'startLaneIndex' | 'endLaneIndex'> {
  const safeStartLaneIndex = startLaneIndex ?? 0;
  return {
    startLaneIndex: safeStartLaneIndex,
    endLaneIndex: startTrackId && startTrackId === peerTrackId
      ? peerLaneIndex ?? 0
      : safeStartLaneIndex,
  };
}

/**
 * Builds a relationship line that follows the visual lanes of both lifecycle blocks.
 * Horizontal segments are centered on each block lane and the vertical segment
 * bridges the lane gap at the midpoint between the two statement times.
 */
export function getLifecyclePairRelationshipSegments({
  startTime,
  endTime,
  pixelsPerSecond,
  startLaneIndex,
  endLaneIndex,
}: LifecyclePairRelationshipGeometryInput): LifecyclePairRelationshipSegment[] {
  const pps = Math.max(0, pixelsPerSecond);
  const startX = startTime * pps;
  const endX = endTime * pps;
  const startY = startLaneIndex * TIMELINE_LANE_HEIGHT_PX + TIMELINE_LANE_CENTER_LINE_TOP_PX;
  const endY = endLaneIndex * TIMELINE_LANE_HEIGHT_PX + TIMELINE_LANE_CENTER_LINE_TOP_PX;

  if (startLaneIndex === endLaneIndex) {
    const left = Math.min(startX, endX);
    return endX === startX
      ? []
      : [{
          orientation: 'horizontal',
          left,
          top: startY,
          width: Math.abs(endX - startX),
          height: RELATIONSHIP_LINE_THICKNESS_PX,
        }];
  }

  const bendX = (startX + endX) / 2;
  const segments: LifecyclePairRelationshipSegment[] = [];
  const startWidth = Math.abs(bendX - startX);
  const endWidth = Math.abs(endX - bendX);

  if (startWidth > 0) {
    segments.push({
      orientation: 'horizontal',
      left: Math.min(startX, bendX),
      top: startY,
      width: startWidth,
      height: RELATIONSHIP_LINE_THICKNESS_PX,
    });
  }
  if (endWidth > 0) {
    segments.push({
      orientation: 'horizontal',
      left: Math.min(endX, bendX),
      top: endY,
      width: endWidth,
      height: RELATIONSHIP_LINE_THICKNESS_PX,
    });
  }

  segments.push({
    orientation: 'vertical',
    left: bendX - RELATIONSHIP_LINE_THICKNESS_PX / 2,
    top: Math.min(startY, endY),
    width: RELATIONSHIP_LINE_THICKNESS_PX,
    height: Math.abs(endY - startY),
  });

  return segments;
}

/**
 * Smooth relationship geometry for objects on different timeline rows.
 * Coordinates include the track label gutter through contentOffsetPx.
 */
export function getTimelineRelationshipCurve({
  startTime,
  endTime,
  pixelsPerSecond,
  startY,
  endY,
  contentOffsetPx = 0,
}: TimelineRelationshipGeometryInput): TimelineRelationshipCurve | undefined {
  const pps = Math.max(0, pixelsPerSecond);
  const absoluteStartX = contentOffsetPx + startTime * pps;
  const absoluteEndX = contentOffsetPx + endTime * pps;
  if (absoluteStartX === absoluteEndX && startY === endY) return undefined;

  const deltaX = absoluteEndX - absoluteStartX;
  const deltaY = endY - startY;
  const bendX = -Math.min(14, Math.abs(deltaY) * 0.35);
  const controlStartX = absoluteStartX + deltaX / 3 + bendX;
  const controlEndX = absoluteStartX + (deltaX * 2) / 3 + bendX;
  const controlStartY = startY + deltaY / 3;
  const controlEndY = startY + (deltaY * 2) / 3;
  const padding = 5;
  const left = Math.min(absoluteStartX, absoluteEndX, controlStartX, controlEndX) - padding;
  const right = Math.max(absoluteStartX, absoluteEndX, controlStartX, controlEndX) + padding;
  const top = Math.min(startY, endY, controlStartY, controlEndY) - padding;
  const bottom = Math.max(startY, endY, controlStartY, controlEndY) + padding;
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const localStartX = absoluteStartX - left;
  const localEndX = absoluteEndX - left;
  const localStartY = startY - top;
  const localEndY = endY - top;
  const localControlStartX = controlStartX - left;
  const localControlEndX = controlEndX - left;
  const localControlStartY = controlStartY - top;
  const localControlEndY = controlEndY - top;

  return {
    left,
    top,
    width,
    height,
    path: `M ${localStartX} ${localStartY} C ${localControlStartX} ${localControlStartY}, ${localControlEndX} ${localControlEndY}, ${localEndX} ${localEndY}`,
    startX: localStartX,
    startY: localStartY,
    endX: localEndX,
    endY: localEndY,
  };
}
