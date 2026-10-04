import { describe, expect, it } from 'vitest';
import type { LooseTimelineScene as SceneScript } from './fixtures/TimelineTestTypes';
import { resolveLensSegmentAtTime, resolveLensSegments } from '../services/visual-authoring/LensSegmentResolver';

function makeScene(): SceneScript {
  return {
    sceneId: 'scene',
    meta: {
      title: 'Scene',
      markers: [
        { markerId: 'm2', time: 5, label: 'Verse', role: 'lens-boundary' },
        { markerId: 'm1', time: 2, label: 'Intro', role: 'lens-boundary' },
        { markerId: 'note', time: 3, label: 'Note', role: 'note' },
      ],
    },
    timeline: [
      { action: 'wait', time: 8, params: { duration: 1 } },
    ],
  };
}

describe('LensSegmentResolver', () => {
  it('builds opening and marker-backed segments from boundary markers', () => {
    const segments = resolveLensSegments(makeScene());

    expect(segments).toEqual([
      { segmentId: 'segment:opening', start: 0, end: 2 },
      { segmentId: 'segment:m1', start: 2, end: 5, startMarkerId: 'm1' },
      { segmentId: 'segment:m2', start: 5, end: 9, startMarkerId: 'm2' },
    ]);
  });

  it('resolves the active segment at a given time', () => {
    const scene = makeScene();
    expect(resolveLensSegmentAtTime(scene, 1).segmentId).toBe('segment:opening');
    expect(resolveLensSegmentAtTime(scene, 3).segmentId).toBe('segment:m1');
    expect(resolveLensSegmentAtTime(scene, 6).segmentId).toBe('segment:m2');
  });
});
