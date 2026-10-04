import { describe, expect, it } from 'vitest';
import type { SemanticTimelineReadModelItem } from '../ui/timeline/semanticTimelineReadModel';
import {
  buildTimelineListGaps,
  getTimelineListInsertionTime,
  roundTimelineListInsertionTime,
} from '../ui/timeline/timelineListGaps';

function item(id: string, time: number): SemanticTimelineReadModelItem {
  return {
    id,
    locator: { kind: 'statement', statementId: id },
    statementId: id,
    time,
    durationSeconds: 0,
    source: {
      id,
      time,
      type: 'dialogue',
      params: { text: id, durationSeconds: 1 },
    },
    displayAction: {
      _id: id,
      time,
      action: 'dialogue',
      params: { text: id },
    },
  };
}

describe('timeline list gaps', () => {
  it('rounds insertion times to one decimal second', () => {
    expect(roundTimelineListInsertionTime(1.04)).toBe(1);
    expect(roundTimelineListInsertionTime(1.05)).toBe(1.1);
    expect(getTimelineListInsertionTime(0.1, 0.2)).toBe(0.2);
    expect(getTimelineListInsertionTime(0.1, 0.3)).toBe(0.2);
  });

  it('creates exactly n - 1 gaps in canonical read-model order', () => {
    const gaps = buildTimelineListGaps([item('first', 0), item('second', 1), item('third', 2)]);

    expect(gaps).toHaveLength(2);
    expect(gaps.map((gap) => [gap.previous.id, gap.next.id, gap.time])).toEqual([
      ['first', 'second', 0.5],
      ['second', 'third', 1.5],
    ]);
  });

  it('returns no gaps for an empty or single-item list and preserves equal times', () => {
    expect(buildTimelineListGaps([])).toEqual([]);
    expect(buildTimelineListGaps([item('only', 2)])).toEqual([]);
    expect(buildTimelineListGaps([item('a', 2), item('b', 2)])).toMatchObject([
      { previous: { id: 'a' }, next: { id: 'b' }, time: 2 },
    ]);
  });
});
