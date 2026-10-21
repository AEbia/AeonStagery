import { describe, expect, it } from 'vitest';
import { evaluateCameraChannels, type CameraAnchorTrajectory } from '../engine/CameraChannelEvaluator';
import type { RuntimeTimelineAction } from '../engine/RuntimeTimelineScene';

const referenceSize = { width: 1920, height: 1080 } as const;

function action(
  id: string,
  type: RuntimeTimelineAction['action'],
  time: number,
  params: Record<string, unknown>,
): RuntimeTimelineAction {
  return { _id: id, action: type, time, params };
}

describe('evaluateCameraChannels', () => {
  it('captures the selected side of a focus discontinuity at its action start', () => {
    const trajectory: CameraAnchorTrajectory = {
      version: 1,
      characterId: 'hero',
      part: 'head',
      validity: [{ start: 0, end: 10 }],
      samples: [
        { time: 0, position: { x: 0.2, y: 0.4 } },
        { time: 5, position: { x: 0.8, y: 0.6 } },
      ],
      events: [{ time: 2, left: { x: 0.3, y: 0.4 }, right: { x: 0.7, y: 0.6 } }],
    };
    const result = evaluateCameraChannels({
      timeline: [action('focus-1', 'cameraMotion', 2, {
        move: 'pan', duration: 1, easing: 'linear', focus: { character: 'hero', part: 'head' },
      })],
      sceneTime: 2.5,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [trajectory],
      anchorEventSide: 'left',
    });

    expect(result.position.x).toBeCloseTo(0.4, 6);
    expect(result.position.y).toBeCloseTo(0.45, 6);
    expect(result.diagnostics).toEqual([]);
  });

  it('continues interpolation from a discontinuity right side after the event', () => {
    const trajectory: CameraAnchorTrajectory = {
      version: 1,
      characterId: 'hero',
      part: 'head',
      validity: [{ start: 0, end: 10 }],
      samples: [
        { time: 0, position: { x: 0.2, y: 0.4 } },
        { time: 5, position: { x: 0.8, y: 0.6 } },
      ],
      events: [{ time: 2, left: { x: 0.3, y: 0.4 }, right: { x: 0.7, y: 0.6 } }],
    };
    const result = evaluateCameraChannels({
      timeline: [action('focus-after-event', 'cameraMotion', 3, {
        move: 'pan', duration: 1, easing: 'linear', focus: { character: 'hero', part: 'head' },
      })],
      sceneTime: 3.5,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [trajectory],
    });

    // At t=3, the anchor is 0.7333 on the segment from the event's right value
    // at t=2 (0.7) to the next sample at t=5 (0.8).
    expect(result.position.x).toBeCloseTo(0.6166667, 6);
    expect(result.position.y).toBeCloseTo(0.55, 6);
  });

  it('does not late-capture a focus anchor that became valid after the action start', () => {
    const trajectory: CameraAnchorTrajectory = {
      version: 1,
      characterId: 'hero',
      part: 'head',
      validity: [{ start: 3, end: 10 }],
      samples: [{ time: 3, position: { x: 0.9, y: 0.8 } }],
      events: [],
    };
    const result = evaluateCameraChannels({
      timeline: [action('late-focus', 'cameraMotion', 2, {
        move: 'pan', duration: 1, easing: 'linear', focus: { character: 'hero', part: 'head' },
      })],
      sceneTime: 3.5,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [trajectory],
    });

    expect(result.position).toEqual({ x: 0.5, y: 0.5 });
    expect(result.diagnostics).toMatchObject([{ code: 'missing-focus-anchor', actionId: 'late-focus' }]);
  });

  it('does not interpolate a focus anchor across a gap between valid intervals', () => {
    const trajectory: CameraAnchorTrajectory = {
      version: 1,
      characterId: 'hero',
      part: 'head',
      validity: [
        { start: 0, end: 1 },
        { start: 2, end: 4 },
      ],
      samples: [
        { time: 0, position: { x: 0.1, y: 0.2 } },
        { time: 3, position: { x: 0.9, y: 0.8 } },
      ],
      events: [
        { time: 0.5, left: { x: 0.2, y: 0.3 }, right: { x: 0.7, y: 0.6 } },
        { time: 2.5, left: { x: 0.4, y: 0.5 }, right: { x: 0.6, y: 0.7 } },
      ],
    };
    const result = evaluateCameraChannels({
      timeline: [action('focus-gap', 'cameraMotion', 2.4, {
        move: 'pan', duration: 1, easing: 'linear', focus: { character: 'hero', part: 'head' },
      })],
      sceneTime: 2.9,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [trajectory],
    });

    // No sample on the left side exists in the selected [2, 4) interval, so
    // the earlier interval's event cannot be used to interpolate across gap.
    expect(result.position).toEqual({ x: 0.5, y: 0.5 });
    expect(result.diagnostics).toMatchObject([{ code: 'missing-focus-anchor', actionId: 'focus-gap' }]);
  });

  it('skips only an unresolved focus position while continuing the zoom channel', () => {
    const result = evaluateCameraChannels({
      timeline: [action('focus-2', 'cameraMotion', 2, {
        move: 'zoom', duration: 1, easing: 'linear', focus: { character: 'missing', part: 'chest' }, zoom: 2,
      })],
      sceneTime: 2.5,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [],
    });

    expect(result.position).toEqual({ x: 0.5, y: 0.5 });
    expect(result.zoom).toBeCloseTo(1.5, 6);
    expect(result.diagnostics).toMatchObject([
      { code: 'missing-focus-anchor', severity: 'warning', actionId: 'focus-2' },
    ]);
  });

  it('does not claim position ownership from a zoom move label alone', () => {
    const result = evaluateCameraChannels({
      timeline: [action('zoom-only', 'cameraMotion', 2, {
        move: 'zoom', duration: 1, easing: 'linear', focus: {}, zoom: 1.8,
      })],
      sceneTime: 2.5,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [],
    });

    expect(result.position).toEqual({ x: 0.5, y: 0.5 });
    expect(result.coverage).toEqual({ position: false, zoom: true, rotation: false });
  });

  it('keeps an unrelated position track moving while a zoom track starts', () => {
    const result = evaluateCameraChannels({
      timeline: [
        action('pan-track', 'cameraMotion', 0, { move: 'pan', duration: 4, easing: 'linear', target: [0.2, 0.2] }),
        action('zoom-track', 'cameraMotion', 2, { move: 'zoom', duration: 2, easing: 'linear', zoom: 2, focus: {} }),
      ],
      sceneTime: 3,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [],
    });

    expect(result.position.x).toBeCloseTo(0.275, 6);
    expect(result.position.y).toBeCloseTo(0.275, 6);
    expect(result.zoom).toBeCloseTo(1.5, 6);
  });

  it('returns deterministic additive shake as a separate output channel', () => {
    const timeline = [
      action('shake-1', 'cameraShake', 1, { intensity: 0.7, frequency: 9, duration: 1 }),
      action('shake-2', 'cameraShake', 1, { intensity: 0.2, frequency: 9, duration: 1 }),
    ];
    const input = {
      timeline,
      sceneTime: 1.4,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [],
    } as const;

    const first = evaluateCameraChannels(input);
    const second = evaluateCameraChannels(input);

    expect(first.shake).toEqual(second.shake);
    expect(first.shake).not.toEqual({ x: 0, y: 0 });
    expect(first.position).toEqual({ x: 0.5, y: 0.5 });
  });

  it('reports rotation edge exposure without changing the evaluated pose', () => {
    const result = evaluateCameraChannels({
      timeline: [action('rotate-1', 'cameraMotion', 1, { duration: 0, angle: 45 })],
      sceneTime: 1,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [],
    });

    expect(result.rotation).toBe(45);
    expect(result.position).toEqual({ x: 0.5, y: 0.5 });
    expect(result.zoom).toBe(1);
    expect(result.diagnostics).toMatchObject([{ code: 'rotation-edge-exposure', severity: 'warning' }]);
  });

  it('omits the retired Hitchcock channel and returns a structured diagnostic', () => {
    const result = evaluateCameraChannels({
      timeline: [action('retired-hitchcock', 'cameraHitchcock', 1, { zoomEnd: 2, duration: 1 })],
      sceneTime: 1.5,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [],
    });

    expect(result.zoom).toBe(1);
    expect(result.position).toEqual({ x: 0.5, y: 0.5 });
    expect(result.diagnostics).toMatchObject([{ code: 'retired-camera-channel', actionId: 'retired-hitchcock' }]);
  });

  it('resolves a modest sequence of 30 start-time channel writers', () => {
    const timeline = Array.from({ length: 30 }, (_, index) => action(
      `writer-${index}`,
      'cameraMotion',
      index,
      { duration: 0, target: [0.2 + index * 0.01, 0.6] },
    ));
    const result = evaluateCameraChannels({
      timeline,
      sceneTime: 30,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [],
    });

    expect(result.position).toEqual({ x: 0.49, y: 0.6 });
  });
});
