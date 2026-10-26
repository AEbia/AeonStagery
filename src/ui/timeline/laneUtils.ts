export interface LaneAssignment {
  id: string;
  laneIndex: number;
}

export interface PresentationFootprintBlock {
  id: string;
  ranges: readonly { start: number; end: number }[];
}

export function computePresentationFootprintLanes(
  blocks: readonly PresentationFootprintBlock[],
): LaneAssignment[] {
  const sorted = [...blocks].sort((left, right) => (
    firstRangeStart(left) - firstRangeStart(right) || left.id.localeCompare(right.id)
  ));
  const laneRanges: Array<Array<{ start: number; end: number }>> = [];
  const assignments: LaneAssignment[] = [];

  for (const block of sorted) {
    const ranges = block.ranges
      .map((range) => ({ start: Math.min(range.start, range.end), end: Math.max(range.start, range.end) }))
      .sort((left, right) => left.start - right.start || left.end - right.end);
    let laneIndex = laneRanges.findIndex((occupied) => ranges.every((range) => (
      occupied.every((existing) => !rangesOverlap(range, existing))
    )));
    if (laneIndex < 0) {
      laneIndex = laneRanges.length;
      laneRanges.push([]);
    }
    laneRanges[laneIndex].push(...ranges);
    laneRanges[laneIndex].sort((left, right) => left.start - right.start || left.end - right.end);
    assignments.push({ id: block.id, laneIndex });
  }

  return assignments;
}

function firstRangeStart(block: PresentationFootprintBlock): number {
  return block.ranges.reduce((minimum, range) => Math.min(minimum, range.start, range.end), Number.POSITIVE_INFINITY);
}

function rangesOverlap(
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean {
  return left.start < right.end - 0.01 && right.start < left.end - 0.01;
}
