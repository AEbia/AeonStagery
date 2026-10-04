import { describe, expect, it } from 'vitest';
import { resolveTimelineSnap } from '../services/timeline-interaction/TimelineSnapResolver';
import { resolveMarqueeSelection } from '../services/timeline-interaction/TimelineMarqueeResolver';
import { projectTimelinePointerPresence } from '../services/timeline-interaction/TimelinePresenceProjector';

describe('TimelineSnapResolver', () => {
  it('prefers magnetic targets within threshold over grid snapping', () => {
    const result = resolveTimelineSnap({
      initialValue: 1,
      rawDelta: 0.18,
      gridStep: 0.1,
      thresholdPx: 15,
      pixelsPerUnit: 100,
      targets: [1.2],
    });

    expect(result.delta).toBeCloseTo(0.2);
    expect(result.value).toBeCloseTo(1.2);
    expect(result.kind).toBe('magnetic');
  });

  it('uses grid snapping when no magnetic target is within threshold', () => {
    const result = resolveTimelineSnap({
      initialValue: 1,
      rawDelta: 0.16,
      gridStep: 0.1,
      thresholdPx: 5,
      pixelsPerUnit: 100,
      targets: [2],
    });

    expect(result.delta).toBeCloseTo(0.2);
    expect(result.value).toBeCloseTo(1.2);
    expect(result.kind).toBe('grid');
  });
});

describe('TimelineMarqueeResolver', () => {
  it('selects blocks intersecting the marquee rectangle', () => {
    const selected = resolveMarqueeSelection({
      start: { x: 10, y: 10 },
      end: { x: 30, y: 30 },
      blocks: [
        { id: 'inside', x1: 12, y1: 12, x2: 20, y2: 20 },
        { id: 'intersecting', x1: 25, y1: 25, x2: 40, y2: 40 },
        { id: 'outside', x1: 31, y1: 31, x2: 50, y2: 50 },
      ],
    });

    expect(selected).toEqual(['inside', 'intersecting']);
  });
});

describe('TimelinePresenceProjector', () => {
  it('projects pointer presence without lock or scene mutation fields', () => {
    const projected = projectTimelinePointerPresence({
      clientX: 250,
      clientY: 75,
      areaLeft: 100,
      pixelsPerSecond: 50,
      maxTime: 10,
      tracks: [
        { id: 'dialogue', top: 40, bottom: 100 },
      ],
    });

    expect(projected).toEqual({
      pointer: {
        surface: 'timeline',
        time: 1,
        trackId: 'dialogue',
      },
    });
    expect(JSON.stringify(projected)).not.toMatch(/lock|scene|mutation/i);
  });
});
