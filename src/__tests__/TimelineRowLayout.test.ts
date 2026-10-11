import { describe, expect, it } from 'vitest';
import { TimelineRowLayout } from '../ui/timeline/TimelineRowLayout';

describe('timeline row prefix sums', () => {
  it('matches linear offsets and visible-row lookup after changing heights at any position', () => {
    const heights = Array.from({ length: 257 }, (_, index) => 20 + index % 19 / 4);
    const rows = heights.map((estimatedHeight, index) => ({
      id: `row-${index}`, measurementKey: `size-${index}`, estimatedHeight,
    }));
    const layout = new TimelineRowLayout(rows, new Map());
    for (const index of [0, 256, 127, 1, 128, 0]) {
      heights[index] = 100 + index / 4;
      layout.setHeight(rows[index].measurementKey, heights[index]);
      let offset = 0;
      heights.forEach((height, row) => {
        expect(layout.getOffset(row)).toBe(offset);
        expect(layout.findRow(offset)).toBe(row);
        expect(layout.findRow(offset + height / 2)).toBe(row);
        offset += height;
      });
      expect(layout.totalHeight).toBe(offset);
      expect(layout.getOffset(rows.length)).toBe(offset);
      expect(layout.findRow(offset + 100)).toBe(rows.length - 1);
      expect(layout.findRow(-100)).toBe(0);
    }
  });

  it('uses cached heights and ignores notifications for inactive measurement keys', () => {
    const layout = new TimelineRowLayout([
      { id: 'first', measurementKey: 'first:open', estimatedHeight: 700 },
      { id: 'second', measurementKey: 'second', estimatedHeight: 100 },
    ], new Map([['first:open', 250]]));
    layout.setHeight('first:closed', 40);
    expect(layout.getOffset(1)).toBe(250);
    expect(layout.indexById.get('second')).toBe(1);
    expect(layout.totalHeight).toBe(350);
    const empty = new TimelineRowLayout([], new Map());
    expect(empty.totalHeight).toBe(0);
    expect(empty.findRow(0)).toBe(0);
  });
});
