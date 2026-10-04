import { describe, expect, it } from 'vitest';
import {
  getLifecyclePairRelationshipSegments,
  resolveLifecyclePairRelationshipLaneIndices,
  TIMELINE_LANE_CENTER_LINE_TOP_PX,
} from '../ui/timeline/lifecyclePairRelationshipGeometry';

describe('lifecycle pair relationship geometry', () => {
  it('keeps a cross-track pair in the start row coordinate system', () => {
    expect(resolveLifecyclePairRelationshipLaneIndices({
      startTrackId: 'bgm',
      peerTrackId: 'audio',
      startLaneIndex: 0,
      peerLaneIndex: 2,
    })).toEqual({
      startLaneIndex: 0,
      endLaneIndex: 0,
    });
  });

  it('uses the peer lane when both actions share a track row', () => {
    expect(resolveLifecyclePairRelationshipLaneIndices({
      startTrackId: 'audio',
      peerTrackId: 'audio',
      startLaneIndex: 0,
      peerLaneIndex: 2,
    })).toEqual({
      startLaneIndex: 0,
      endLaneIndex: 2,
    });
  });

  it('keeps a same-lane pair as one horizontal segment', () => {
    expect(getLifecyclePairRelationshipSegments({
      startTime: 2,
      endTime: 5,
      pixelsPerSecond: 10,
      startLaneIndex: 1,
      endLaneIndex: 1,
    })).toEqual([{
      orientation: 'horizontal',
      left: 20,
      top: 32 + TIMELINE_LANE_CENTER_LINE_TOP_PX,
      width: 30,
      height: 2,
    }]);
  });

  it('bridges two wrapped lanes with two horizontal segments and one vertical segment', () => {
    expect(getLifecyclePairRelationshipSegments({
      startTime: 2,
      endTime: 8,
      pixelsPerSecond: 10,
      startLaneIndex: 0,
      endLaneIndex: 2,
    })).toEqual([
      {
        orientation: 'horizontal',
        left: 20,
        top: TIMELINE_LANE_CENTER_LINE_TOP_PX,
        width: 30,
        height: 2,
      },
      {
        orientation: 'horizontal',
        left: 50,
        top: 64 + TIMELINE_LANE_CENTER_LINE_TOP_PX,
        width: 30,
        height: 2,
      },
      {
        orientation: 'vertical',
        left: 49,
        top: TIMELINE_LANE_CENTER_LINE_TOP_PX,
        width: 2,
        height: 64,
      },
    ]);
  });
});
