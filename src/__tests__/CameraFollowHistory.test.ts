import { describe, expect, it } from 'vitest';
import { evaluateCameraChannels, type CameraAnchorTrajectory } from '../engine/CameraChannelEvaluator';
import type { RuntimeTimelineAction } from '../engine/RuntimeTimelineScene';

const referenceSize = { width: 1920, height: 1080 } as const;

function action(id: string, type: RuntimeTimelineAction['action'], time: number, params: Record<string, unknown>): RuntimeTimelineAction {
  return { _id: id, action: type, time, params };
}

function history(
  validity: CameraAnchorTrajectory['validity'],
  samples: CameraAnchorTrajectory['samples'],
  events: CameraAnchorTrajectory['events'] = [],
): CameraAnchorTrajectory {
  return { version: 1, revision: 'anchor-content-1', characterId: 'hero', part: 'center', validity, samples, events };
}

function makeInput(trajectory: CameraAnchorTrajectory, sceneTime: number, smoothing: number, side?: 'left' | 'right', offset: readonly [number, number] = [0, 0]) {
  const timeline = [
    action('initial-position', 'cameraMotion', 0, { move: 'pan', target: [0.2, 0.25], duration: 0 }),
    action('wide-reference', 'cameraMotion', 0, { zoom: 100, duration: 0, _cameraProperties: ['zoom'] }),
    action('follow', 'cameraFollow', 0, { characterId: 'hero', smoothing, duration: 20, offset }),
  ];
  return {
    timeline,
    sceneTime,
    logicalReferenceSize: referenceSize,
    anchorTrajectories: [trajectory],
    revision: 'timeline-1',
    trajectoryRevision: 'bundle-1',
    anchorEventSide: side,
  } as const;
}

describe('historical camera follow through the public evaluator', () => {
  it('matches the closed-form exponential pursuit for a moving linear target', () => {
    const anchors = history([{ start: 0, end: 2 }], [
      { time: 0, position: { x: 0.1, y: 0.2 } },
      { time: 2, position: { x: 0.9, y: 0.8 } },
    ]);
    const smoothing = 0.8;
    const lambda = -60 * Math.log(smoothing);
    const queryTime = 1.25;
    const slopeX = 0.4;
    const startTargetX = 0.1;
    const targetX = startTargetX + slopeX * queryTime;
    const expectedX = targetX - slopeX / lambda
      + (0.2 - startTargetX + slopeX / lambda) * Math.exp(-lambda * queryTime);
    const state = evaluateCameraChannels(makeInput(anchors, queryTime, smoothing));

    expect(state.position.x).toBeCloseTo(expectedX, 8);
  });

  it('holds through invalid gaps, samples the exclusive end from the left, and resumes on reappearance', () => {
    const anchors = history(
      [{ start: 0, end: 1 }, { start: 2, end: 4 }],
      [
        { time: 0, position: { x: 0.2, y: 0.2 } },
        { time: 1, position: { x: 0.8, y: 0.8 } },
        { time: 2, position: { x: 0.4, y: 0.4 } },
        { time: 4, position: { x: 0.8, y: 0.8 } },
      ],
    );

    expect(evaluateCameraChannels(makeInput(anchors, 1, 0)).position).toEqual({ x: 0.8, y: 0.8 });
    expect(evaluateCameraChannels(makeInput(anchors, 1.5, 0)).position).toEqual({ x: 0.8, y: 0.8 });
    expect(evaluateCameraChannels(makeInput(anchors, 2.5, 0)).position).toEqual({ x: 0.5, y: 0.5 });
  });

  it('honors smoothing endpoints and event left/right values', () => {
    const anchors = history([{ start: 0, end: 2 }], [
      { time: 0, position: { x: 0.2, y: 0.3 } },
      { time: 2, position: { x: 0.8, y: 0.7 } },
    ], [{ time: 1, left: { x: 0.4, y: 0.4 }, right: { x: 0.7, y: 0.6 } }]);

    expect(evaluateCameraChannels(makeInput(anchors, 1, 1, undefined, [0.05, 0])).position).toEqual({ x: 0.2, y: 0.25 });
    expect(evaluateCameraChannels(makeInput(anchors, 1, 0, undefined, [0.05, 0])).position).toEqual({ x: 0.75, y: 0.6 });
    expect(evaluateCameraChannels(makeInput(anchors, 1, 0, 'left', [0.05, 0])).position).toEqual({ x: 0.45, y: 0.4 });
    expect(evaluateCameraChannels(makeInput(anchors, 1, 0.8, undefined, [0.05, 0])).position.x).toBeLessThan(0.45);
  });

  it('returns the same subframe result after cold, warm, and out-of-order evaluator queries', () => {
    const anchors = history([{ start: 0, end: 4 }], [
      { time: 0, position: { x: 0.2, y: 0.2 } },
      { time: 4, position: { x: 0.8, y: 0.8 } },
    ]);
    const base = makeInput(anchors, 0, 0.85);
    const query = (sceneTime: number) => evaluateCameraChannels({ ...base, sceneTime });
    const cold = query(1.2345).position;
    query(3.7);
    query(0.151);
    expect(query(1.2345).position).toEqual(cold);
  });
});
