import { describe, expect, it } from 'vitest';
import type { CharacterMotionOutput, CustomMotionKeyframe } from '../api/types/semantic-scene';
import { applyCustomMotionKeyframeEdits, assertValidCustomMotionEdit } from '../services/timeline-authoring/customMotionKeyframeEdits';
import { createGroupMoveResolver, edgeScrollSpeed, keyframesInRect, selectionRect } from '../ui/timeline/customMotionSelection';

type Motion = Extract<CharacterMotionOutput, { kind: 'custom' }>;
const motion = (): Motion => ({
  kind: 'custom', durationSeconds: 3, fadeInSeconds: 0, derivedFrom: { key: 'test', fadeInSeconds: 0, fadeOutSeconds: 0 },
  tracks: [
    { parameterId: 'x', keyframes: [{ time: 0, value: 1, segment: { type: 'linear' } }, { time: 1, value: 2, segment: { type: 'linear' } }, { time: 2, value: 3 }] },
    { parameterId: 'y', keyframes: [{ time: 0, value: 0, segment: { type: 'linear' } }, { time: 1, value: 4 }] },
  ],
});

function withFirstTrackPoint(update: (point: CustomMotionKeyframe) => CustomMotionKeyframe): Motion {
  const source = motion();
  return { ...source, tracks: source.tracks.map((track, index) => index === 0 ? { ...track, keyframes: track.keyframes.map((point, pointIndex) => pointIndex === 1 ? update(point) : point) } : track) };
}

describe('custom motion group editing', () => {
  it('moves simultaneously into a selected point’s old time without a false collision', () => {
    const source = motion();
    const result = applyCustomMotionKeyframeEdits(source, [{ type: 'move-keyframes', keyframes: [{ parameterId: 'x', time: 1 }, { parameterId: 'x', time: 2 }], deltaTime: 1 }]);
    expect(result.tracks[0].keyframes.map((point) => point.time)).toEqual([0, 2, 3]);
    expect(result.tracks[1]).toBe(source.tracks[1]);
    expect(source.tracks[0].keyframes.map((point) => point.time)).toEqual([0, 1, 2]);
    assertValidCustomMotionEdit(result);
  });
  it('leaves an equal-value F0 and moves cross-track points by the same offset', () => {
    const result = applyCustomMotionKeyframeEdits(motion(), [{ type: 'move-keyframes', keyframes: [{ parameterId: 'x', time: 0 }, { parameterId: 'y', time: 1 }], deltaTime: 0.5 }]);
    expect(result.tracks[0].keyframes.slice(0, 2).map((point) => [point.time, point.value])).toEqual([[0, 1], [0.5, 1]]);
    expect(result.tracks[1].keyframes[1].time).toBe(1.5);
  });
  it('rejects collisions, bounds violations and cross-parameter value movement atomically', () => {
    const source = motion();
    expect(() => applyCustomMotionKeyframeEdits(source, [{ type: 'move-keyframes', keyframes: [{ parameterId: 'x', time: 1 }], deltaTime: 1 }])).toThrow(/occupied/);
    expect(() => applyCustomMotionKeyframeEdits(source, [{ type: 'move-keyframes', keyframes: [{ parameterId: 'x', time: 2 }], deltaTime: 2 }])).toThrow();
    expect(() => applyCustomMotionKeyframeEdits(source, [{ type: 'move-keyframes', keyframes: [{ parameterId: 'x', time: 1 }, { parameterId: 'y', time: 1 }], deltaTime: 0, deltaValue: 1 }])).toThrow(/one parameter/);
    expect(source.tracks[0].keyframes[1].time).toBe(1);
  });
  it('translates Bezier control points and preserves the original source', () => {
    const source = withFirstTrackPoint((point) => ({ ...point, segment: { type: 'bezier', controlPoints: [{ time: 1.2, value: 4 }, { time: 1.8, value: 5 }] } }));
    const result = applyCustomMotionKeyframeEdits(source, [{ type: 'move-keyframes', keyframes: [{ parameterId: 'x', time: 1 }, { parameterId: 'x', time: 2 }], deltaTime: 0.5, deltaValue: 2 }]);
    expect(result.tracks[0].keyframes[1].segment).toEqual({ type: 'bezier', controlPoints: [{ time: 1.7, value: 6 }, { time: 2.3, value: 7 }] });
    assertValidCustomMotionEdit(result);
  });
  it.each([30, 60])('resolves the nearest legal group offset at %i fps', (fps) => {
    const source = motion();
    const resolve = createGroupMoveResolver(source.tracks, [{ parameterId: 'x', time: 1 }, { parameterId: 'y', time: 1 }], 3, fps);
    expect(resolve(fps)).toBe(fps - 1);
    expect(resolve(-fps * 10)).toBe(-fps + 1);
    expect(resolve(fps * 10)).toBe(fps * 2);
  });
  it('snaps a single native point to a frame while value-only gestures keep its precise time', () => {
    const source = withFirstTrackPoint((point) => ({ ...point, time: 1.003 }));
    const resolve = createGroupMoveResolver(source.tracks, [{ parameterId: 'x', time: 1.003 }], 3, 60, true);
    expect(1.003 + resolve(10) / 60).toBeCloseTo(70 / 60, 12);
    expect(resolve(0)).toBe(0);
  });
  it('preserves subframe spacing when applying an integer frame offset', () => {
    const source = withFirstTrackPoint((point) => ({ ...point, time: 1.003 }));
    const result = applyCustomMotionKeyframeEdits(source, [{ type: 'move-keyframes', keyframes: [{ parameterId: 'x', time: 1.003 }, { parameterId: 'y', time: 1 }], deltaTime: 1 / 60 }]);
    expect(result.tracks[0].keyframes[1].time - result.tracks[1].keyframes[1].time).toBeCloseTo(0.003, 12);
  });
});

describe('marquee geometry and scrolling', () => {
  it('uses inclusive point centres and handles reversed rectangles across lanes', () => {
    const rect = selectionRect(150, 43, 100, 14);
    expect(keyframesInRect(motion().tracks, rect, 0, 100, (index) => index * 28 + 14)).toEqual([{ parameterId: 'x', time: 1 }, { parameterId: 'y', time: 1 }]);
  });
  it('uses curve values instead of lane positions', () => {
    expect(keyframesInRect([motion().tracks[0]], selectionRect(50, 15, 250, 25), 0, 100, (_, value) => value * 10)).toEqual([{ parameterId: 'x', time: 1 }]);
  });
  it('queries 20,000 points without DOM geometry', () => {
    const tracks = Array.from({ length: 100 }, (_, index) => ({ parameterId: String(index), keyframes: Array.from({ length: 200 }, (_, time) => ({ time, value: 0 })) }));
    expect(keyframesInRect(tracks, selectionRect(1000, 0, 1100, 2800), 0, 100, (index) => index * 28 + 14)).toHaveLength(200);
  });
  it('scales speed at the edges and stays still in the centre', () => {
    expect(edgeScrollSpeed(16, 0, 200)).toBe(-240);
    expect(edgeScrollSpeed(200, 0, 200)).toBe(480);
    expect(edgeScrollSpeed(100, 0, 200)).toBe(0);
  });
});
