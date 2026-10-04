export interface BlockInfo {
  id: string;
  time: number;
  duration: number;
}

export interface LaneAssignment {
  id: string;
  laneIndex: number;
}

export interface PresentationFootprintBlock {
  id: string;
  ranges: readonly { start: number; end: number }[];
}

/**
 * 贪心区间划分算法 — O(N log N)
 * 按 start time 排序，每个 block 放入第一个可用的 lane
 * 硬性性能上限：N < 2000，< 2ms per call
 */
export function computeLanes(blocks: BlockInfo[]): LaneAssignment[] {
  if (blocks.length === 0) return [];

  const sorted = [...blocks].sort((a, b) => a.time - b.time);
  const laneEnds: number[] = []; // 每个 lane 的结束时间
  const result: LaneAssignment[] = [];

  for (const block of sorted) {
    let placed = false;
    for (let lane = 0; lane < laneEnds.length; lane++) {
      // Allow block to be placed on a lane if it starts after or exactly at the lane's end time
      // Using a small epsilon to avoid float rounding errors
      if (laneEnds[lane] <= block.time + 0.01) {
        laneEnds[lane] = block.time + block.duration;
        result.push({ id: block.id, laneIndex: lane });
        placed = true;
        break;
      }
    }
    if (!placed) {
      result.push({ id: block.id, laneIndex: laneEnds.length });
      laneEnds.push(block.time + block.duration);
    }
  }

  return result;
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
