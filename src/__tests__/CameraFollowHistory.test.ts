import { describe, expect, it } from 'vitest';
import { evaluateCameraChannels, type CameraAnchorTrajectory } from '../engine/CameraChannelEvaluator';
import { getCameraFollowHistoryDiagnostics } from '../engine/CameraFollowHistory';
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

  it('follows a valid anchor at the exact zero-smoothing start but holds without a usable start anchor', () => {
    const anchors = history([{ start: 0, end: 2 }], [
      { time: 0, position: { x: 0.8, y: 0.7 } },
      { time: 2, position: { x: 0.8, y: 0.7 } },
    ]);
    const missingStartAnchor = history([], []);

    expect(evaluateCameraChannels(makeInput(anchors, 0, 0)).position).toEqual({ x: 0.8, y: 0.7 });
    expect(evaluateCameraChannels(makeInput(anchors, 0, 1)).position).toEqual({ x: 0.2, y: 0.25 });
    expect(evaluateCameraChannels(makeInput(missingStartAnchor, 0, 0)).position).toEqual({ x: 0.2, y: 0.25 });
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

describe('prepared history query work', () => {
  it('reuses the immutable trajectory index across repeated public evaluations', () => {
    let reads = 0;
    const samples = Array.from({ length: 151 }, (_, index) => {
      const sample = { time: index / 15, position: { x: 0.7, y: 0.6 } };
      return Object.defineProperty(sample, 'time', { get: () => { reads++; return index / 15; } });
    });
    const trajectory = history([{ start: 0, end: 11 }], samples);
    const input = makeInput(trajectory, 9.12345, 0.8);
    const first = evaluateCameraChannels(input);
    reads = 0;
    expect(evaluateCameraChannels(input)).toEqual(first);
    // A warmed partial second may perform many anchor queries, but none scan
    // the 151 source samples again. This is a work bound, not a timing assertion.
    expect(reads).toBeLessThan(500);
  });
});


describe('chronological checkpoint reuse', () => {
  it('continues from the preceding complete checkpoint when entering a new second at a subframe', () => {
    const trajectory = history([{ start: 0, end: 21 }], [
      { time: 0, position: { x: 0.7, y: 0.6 } }, { time: 21, position: { x: 0.7, y: 0.6 } },
    ]);
    const input = makeInput(trajectory, 9.99, 0.8);
    evaluateCameraChannels(input);
    const before = getCameraFollowHistoryDiagnostics(trajectory).anchorQueries;
    const result = evaluateCameraChannels({ ...input, sceneTime: 10.00123 });
    const work = getCameraFollowHistoryDiagnostics(trajectory).anchorQueries - before;
    expect(work).toBeLessThan(2500);
    expect(result.position.x).toBeCloseTo(0.7, 12);
    expect(evaluateCameraChannels({ ...input, sceneTime: 9.99 })).toEqual(evaluateCameraChannels(input));
  });
});

it('bounds retained complete checkpoints during integer-only export schedules', () => {
  const trajectory = history([{ start: 0, end: 301 }], [
    { time: 0, position: { x: 0.7, y: 0.6 } }, { time: 301, position: { x: 0.7, y: 0.6 } },
  ]);
  const input = makeInput(trajectory, 0, 0.8);
  // Keep one unbounded follow for a long schedule, rather than the fixture's
  // default finite twenty-second follow.
  input.timeline[2].params.duration = undefined;
  for (let time = 1; time <= 300; time++) evaluateCameraChannels({ ...input, sceneTime: time });
  expect(getCameraFollowHistoryDiagnostics(trajectory).checkpoints).toBeLessThanOrEqual(256);
});

it('keeps an event left-side query independent of a warmed checkpoint at the same instant', () => {
  const trajectory = history([{ start: 0, end: 3 }], [
    { time: 0, position: { x: 0.25, y: 0.3 } }, { time: 3, position: { x: 0.75, y: 0.8 } },
  ], [{ time: 1, left: { x: 0.25, y: 0.3 }, right: { x: 0.75, y: 0.8 } }]);
  const input = makeInput(trajectory, 1.25, 0, 'left');
  evaluateCameraChannels(input);
  expect(evaluateCameraChannels({ ...input, sceneTime: 1 }).position).toEqual({ x: 0.25, y: 0.3 });
  expect(evaluateCameraChannels(input).position).toEqual({ x: 0.75, y: 0.8 });
});

it('preserves existing exact-event priority when external history contains coincident events', () => {
  const trajectory = history([{ start: 0, end: 3 }], [
    { time: 3, position: { x: 0.8, y: 0.8 } }, { time: 0, position: { x: 0.2, y: 0.2 } },
  ], [
    { time: 1, left: { x: 0.25, y: 0.3 }, right: { x: 0.75, y: 0.8 } },
    { time: 1, left: { x: 0.35, y: 0.4 }, right: { x: 0.65, y: 0.7 } },
  ]);
  expect(evaluateCameraChannels(makeInput(trajectory, 1, 0, 'left')).position).toEqual({ x: 0.25, y: 0.3 });
  expect(evaluateCameraChannels(makeInput(trajectory, 1, 0, 'right')).position).toEqual({ x: 0.75, y: 0.8 });
});
