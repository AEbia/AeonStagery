import { describe, expect, it } from 'vitest';
import {
  buildBatchDragUpdates,
  collectSelectedBatchDragBlocks,
  constrainBatchDeltaTime,
} from '../ui/timeline/useBatchDrag';
import type { LooseTimelineAction as SceneAction } from './fixtures/TimelineTestTypes';

function makeAction(id: string, time: number): SceneAction {
  return {
    _id: id,
    action: 'dialogue',
    time,
    params: { text: id },
  };
}

describe('timeline batch drag', () => {
  it('preserves relative offsets when a group drag reaches the timeline start', () => {
    const blocks = [
      { id: 'a1', initialTime: 1 },
      { id: 'a2', initialTime: 2.5 },
      { id: 'a3', initialTime: 4 },
    ];

    const updates = buildBatchDragUpdates(blocks, -2);

    expect(updates).toEqual([
      { id: 'a1', time: 0 },
      { id: 'a2', time: 1.5 },
      { id: 'a3', time: 3 },
    ]);
  });

  it('leaves normal group drag deltas unchanged', () => {
    const blocks = [
      { id: 'a1', initialTime: 1 },
      { id: 'a2', initialTime: 2.5 },
    ];

    expect(constrainBatchDeltaTime(blocks, 1.2)).toBe(1.2);
    expect(buildBatchDragUpdates(blocks, 1.2)).toEqual([
      { id: 'a1', time: 2.2 },
      { id: 'a2', time: 3.7 },
    ]);
  });

  it('includes selected blocks even when they are outside the rendered viewport', () => {
    const blocks = collectSelectedBatchDragBlocks(
      { a1: true, a2: true, a3: false },
      [makeAction('a1', 1), makeAction('a2', 9), makeAction('a3', 15)],
      (id) => (id === 'a1' ? ({} as HTMLElement) : undefined),
    );

    expect(blocks.map(({ id, initialTime, el }) => ({ id, initialTime, hasElement: !!el }))).toEqual([
      { id: 'a1', initialTime: 1, hasElement: true },
      { id: 'a2', initialTime: 9, hasElement: false },
    ]);
    expect(buildBatchDragUpdates(blocks, 2)).toEqual([
      { id: 'a1', time: 3 },
      { id: 'a2', time: 11 },
    ]);
  });
});
