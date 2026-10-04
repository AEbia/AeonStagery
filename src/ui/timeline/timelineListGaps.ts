import type { SemanticTimelineReadModelItem } from './semanticTimelineReadModel';

export const TIMELINE_LIST_INSERTION_PRECISION = 0.1;

export interface TimelineListGap {
  readonly index: number;
  readonly previous: SemanticTimelineReadModelItem;
  readonly next: SemanticTimelineReadModelItem;
  readonly time: number;
}

export function roundTimelineListInsertionTime(time: number): number {
  const rounded = Math.round((time + Number.EPSILON) / TIMELINE_LIST_INSERTION_PRECISION)
    * TIMELINE_LIST_INSERTION_PRECISION;
  return Number(rounded.toFixed(1));
}

export function getTimelineListInsertionTime(previousTime: number, nextTime: number): number {
  return roundTimelineListInsertionTime((previousTime + nextTime) / 2);
}

export function buildTimelineListGaps(
  items: readonly SemanticTimelineReadModelItem[],
): TimelineListGap[] {
  const gaps: TimelineListGap[] = [];
  for (let index = 0; index < items.length - 1; index += 1) {
    const previous = items[index];
    const next = items[index + 1];
    if (!previous || !next) continue;
    gaps.push({
      index,
      previous,
      next,
      time: getTimelineListInsertionTime(previous.time, next.time),
    });
  }
  return gaps;
}
