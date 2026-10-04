import { describe, expect, it } from 'vitest';
import type { TimelineAction } from '../ui/timeline/semanticTimelineTypes';
import { pruneSelectedActionIdsForTimeline } from '../ui/timeline/selectionHygiene';

function makeTimeline(ids: string[]): TimelineAction[] {
  return ids.map((id, index) => ({
    _id: id,
    action: 'wait',
    time: index,
    params: {},
  }));
}

describe('timeline selection hygiene', () => {
  it('keeps selected action ids that still exist in the scene', () => {
    const selected = { a1: true, a2: true };

    expect(pruneSelectedActionIdsForTimeline(selected, makeTimeline(['a1', 'a2']))).toEqual({
      selectedActionIds: selected,
      changed: false,
    });
  });

  it('removes selected action ids that no longer exist after remote materialization', () => {
    expect(pruneSelectedActionIdsForTimeline(
      { a1: true, deleted: true, disabled: false },
      makeTimeline(['a1', 'a2']),
    )).toEqual({
      selectedActionIds: { a1: true },
      changed: true,
    });
  });

  it('clears selection when every selected action disappeared', () => {
    expect(pruneSelectedActionIdsForTimeline(
      { deleted: true },
      makeTimeline(['a1']),
    )).toEqual({
      selectedActionIds: {},
      changed: true,
    });
  });

  it('migrates selection to the new compiled action ID when statement lowering outputs change', () => {
    const oldExpressionId = 'statementId:8:char_001|outputKey:10:expression';
    const newMotionId = 'statementId:8:char_001|outputKey:6:motion';

    const timeline: TimelineAction[] = [
      {
        _id: newMotionId,
        statementId: 'char_001',
        action: 'playMotion',
        time: 0,
        params: {},
      },
    ];

    expect(pruneSelectedActionIdsForTimeline({ [oldExpressionId]: true }, timeline)).toEqual({
      selectedActionIds: { [newMotionId]: true },
      changed: true,
    });
  });

  it('migrates selection from uncompiled source ID to compiled action ID', () => {
    const uncompiledSourceId = 'char_001';
    const newMotionId = 'statementId:8:char_001|outputKey:6:motion';

    const timeline: TimelineAction[] = [
      {
        _id: newMotionId,
        statementId: 'char_001',
        action: 'playMotion',
        time: 0,
        params: {},
      },
    ];

    expect(pruneSelectedActionIdsForTimeline({ [uncompiledSourceId]: true }, timeline)).toEqual({
      selectedActionIds: { [newMotionId]: true },
      changed: true,
    });
  });

  it('prunes selection when the statement was deleted and no longer exists in timeline', () => {
    const oldExpressionId = 'statementId:8:char_001|outputKey:10:expression';

    const timeline: TimelineAction[] = [
      {
        _id: 'statementId:8:char_002|outputKey:6:motion',
        statementId: 'char_002',
        action: 'playMotion',
        time: 0,
        params: {},
      },
    ];

    expect(pruneSelectedActionIdsForTimeline({ [oldExpressionId]: true }, timeline)).toEqual({
      selectedActionIds: {},
      changed: true,
    });
  });
});
