import { describe, expect, it } from 'vitest';
import {
  buildSummarySegmentsFromBuckets,
  buildTimeBucketIndex,
  calculateNextLOD,
  getPlayheadSpotlightRange,
  pickTimeBucketSeconds,
  queryVisibleBucketActions,
  queryVisibleBuckets,
  quantizeTimeToBucket,
} from '../ui/timeline/timelineDensity';
import type { LooseTimelineAction as SceneAction } from './fixtures/TimelineTestTypes';

function action(id: string, time: number, duration = 0.2): { action: SceneAction; id: string } {
  return {
    id,
    action: {
      _id: id,
      action: 'dialogue',
      time,
      params: { text: id, duration },
    } as SceneAction,
  };
}

describe('timeline density view', () => {
  it('enters summary mode when zoomed out with many visible actions', () => {
    expect(calculateNextLOD('detail', 20, 10, 'zoom')).toBe('detail');
    expect(calculateNextLOD('detail', 50, 10, 'zoom')).toBe('summary');
    expect(calculateNextLOD('detail', 200, 40, 'zoom')).toBe('summary');
  });

  it('exits summary mode after data shrinks below the safety threshold', () => {
    expect(calculateNextLOD('summary', 70, 15, 'data')).toBe('detail');
    expect(calculateNextLOD('summary', 70, 10, 'zoom')).toBe('summary');
    expect(calculateNextLOD('summary', 90, 17, 'zoom')).toBe('summary');
    expect(calculateNextLOD('summary', 90, 18, 'zoom')).toBe('detail');
  });

  it('uses stable time bucket levels for zoom-dependent queries', () => {
    expect(pickTimeBucketSeconds(100)).toBe(0.25);
    expect(pickTimeBucketSeconds(8)).toBe(5);
    expect(pickTimeBucketSeconds(0.2)).toBe(120);
  });

  it('queries visible actions from overlapping time buckets without duplicates', () => {
    const actions = [
      action('a', 0, 10),
      action('b', 12, 1),
      action('c', 30, 1),
    ];
    const index = buildTimeBucketIndex(actions, 5);
    const visible = queryVisibleBucketActions(index, { start: 8, end: 13 }, 0);

    expect(visible.map(item => item.id).sort()).toEqual(['a', 'b']);
  });

  it('builds summary segments directly from visible buckets while excluding anchors', () => {
    const actions = [
      action('a0', 0, 0.05),
      { id: 'a1', action: { _id: 'a1', action: 'cameraMove', time: 0.2, params: { duration: 0.05 } } as SceneAction },
      action('a2', 0.3, 0.05),
      action('a3', 1.1, 0.05),
    ];
    const index = buildTimeBucketIndex(actions, 1);
    const buckets = queryVisibleBuckets(index, { start: 0, end: 2 }, 0);
    const segments = buildSummarySegmentsFromBuckets(buckets, {
      anchorIds: new Set(['a0']),
      hasValidationIssue: (id) => id === 'a0',
      hasRepeatWarning: (id) => id === 'a3',
    });

    expect(segments).toHaveLength(2);
    expect(segments[0].count).toBe(2);
    expect(segments[0].dominantActionType).toBe('cameraMove');
    expect(segments[0].hasValidationIssue).toBe(true);
    expect(segments[1].hasRepeatWarning).toBe(true);
  });

  it('does not let a cross-boundary warning bleed into the following summary bucket', () => {
    const actions = [
      action('clean-early', 0.1, 0.1),
      action('repeat-late', 0.95, 0.4),
      action('clean-late', 1.1, 0.1),
    ];
    const index = buildTimeBucketIndex(actions, 1);
    const buckets = queryVisibleBuckets(index, { start: 0, end: 2 }, 0);
    const segments = buildSummarySegmentsFromBuckets(buckets, {
      hasRepeatWarning: (id) => id === 'repeat-late',
    });

    expect(segments).toHaveLength(2);
    expect(segments[0].hasRepeatWarning).toBe(true);
    expect(segments[1].hasRepeatWarning).toBe(false);
  });

  it('quantizes playhead spotlight updates instead of following every frame', () => {
    expect(quantizeTimeToBucket(0.24)).toBe(0);
    expect(quantizeTimeToBucket(0.74)).toBe(0.5);

    const spotlight = getPlayheadSpotlightRange(2.49);
    expect(spotlight.start).toBe(0.5);
    expect(spotlight.end).toBe(3.5);
  });
});
