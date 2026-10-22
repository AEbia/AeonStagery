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
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'missing-focus-anchor' }));
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

  it('reconstructs follow from the center trajectory through the public evaluator', () => {
    const trajectory: CameraAnchorTrajectory = {
      version: 1,
      revision: 3,
      characterId: 'hero',
      part: 'center',
      validity: [{ start: 0, end: 4 }],
      samples: [
        { time: 0, position: { x: 0.2, y: 0.3 } },
        { time: 4, position: { x: 0.8, y: 0.7 } },
      ],
      events: [],
    };
    const headTrajectory: CameraAnchorTrajectory = {
      ...trajectory,
      part: 'head',
      samples: [{ time: 0, position: { x: 0.9, y: 0.9 } }, { time: 4, position: { x: 0.9, y: 0.9 } }],
    };
    const result = evaluateCameraChannels({
      timeline: [
        action('zoom-before-follow', 'cameraMotion', 0, { zoom: 2, _cameraProperties: ['zoom'] }),
        action('follow-center', 'cameraFollow', 0.5, { characterId: 'hero', smoothing: 0, duration: 2 }),
      ],
      sceneTime: 1,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [trajectory, headTrajectory],
    });

    expect(result.position.x).toBeCloseTo(0.35, 8);
    expect(result.position.y).toBeCloseTo(0.4, 8);
    expect(result.follow?.characterId).toBe('hero');
  });

  it('uses the historical zoom curve when clamping pursuit and retains follow through zoom-only writes', () => {
    const trajectory: CameraAnchorTrajectory = {
      version: 1,
      characterId: 'hero',
      part: 'center',
      validity: [{ start: 0, end: 4 }],
      samples: [{ time: 0, position: { x: 0.05, y: 0.05 } }, { time: 4, position: { x: 0.05, y: 0.05 } }],
      events: [],
    };
    const result = evaluateCameraChannels({
      timeline: [
        action('follow', 'cameraFollow', 0, { characterId: 'hero', smoothing: 0, duration: 3 }),
        action('zoom-during-follow', 'cameraMotion', 0, {
          zoom: 4, duration: 2, easing: 'linear', _cameraProperties: ['zoom'],
        }),
      ],
      sceneTime: 1,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [trajectory],
    });

    expect(result.zoom).toBe(2.5);
    expect(result.position.x).toBeCloseTo(0.2, 8);
    expect(result.position.y).toBeCloseTo(0.2, 8);
    expect(result.follow?.characterId).toBe('hero');
  });

  it('latches at a true position takeover and at a finite follow end', () => {
    const trajectory: CameraAnchorTrajectory = {
      version: 1,
      characterId: 'hero',
      part: 'center',
      validity: [{ start: 0, end: 5 }],
      samples: [{ time: 0, position: { x: 0.2, y: 0.3 } }, { time: 5, position: { x: 0.7, y: 0.8 } }],
      events: [],
    };
    const takenOver = evaluateCameraChannels({
      timeline: [
        action('follow', 'cameraFollow', 0, { characterId: 'hero', smoothing: 0, duration: 4 }),
        action('position-takeover', 'cameraMotion', 1, { move: 'pan', duration: 0, target: [0.9, 0.8] }),
      ],
      sceneTime: 2,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [trajectory],
    });
    const finite = evaluateCameraChannels({
      timeline: [
        action('finite-zoom', 'cameraMotion', 0, { zoom: 2, _cameraProperties: ['zoom'] }),
        action('finite-follow', 'cameraFollow', 0, { characterId: 'hero', smoothing: 0, duration: 1 }),
      ],
      sceneTime: 2,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [trajectory],
    });

    expect(takenOver.position).toEqual({ x: 0.9, y: 0.8 });
    expect(takenOver.follow).toBeNull();
    expect(finite.position).toEqual({ x: 0.3, y: 0.4 });
    expect(finite.follow).toBeNull();
  });

  it('latches an explicit zero-duration follow at its authored instant before later writers', () => {
    const trajectory: CameraAnchorTrajectory = {
      version: 1,
      characterId: 'hero',
      part: 'center',
      validity: [{ start: 0, end: 5 }],
      samples: [
        { time: 0, position: { x: 0.1, y: 0.2 } },
        { time: 5, position: { x: 0.9, y: 0.8 } },
      ],
      events: [],
    };
    const timeline = [
      action('zoom-before-follow', 'cameraMotion', 0, {
        zoom: 2, duration: 0, _cameraProperties: ['zoom'],
      }),
      action('instant-follow', 'cameraFollow', 1, { characterId: 'hero', smoothing: 0, duration: 0 }),
      action('later-pan', 'cameraMotion', 2, {
        target: [0.8, 0.7], duration: 1, easing: 'linear', _cameraProperties: ['position'],
      }),
    ];
    const evaluate = (sceneTime: number) => evaluateCameraChannels({
      timeline,
      sceneTime,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [trajectory],
    });

    const before = evaluate(0.999);
    const atEndpoint = evaluate(1);
    const afterEndpoint = evaluate(1.5);
    const duringLaterWriter = evaluate(2.5);

    expect(before.position).toEqual({ x: 0.5, y: 0.5 });
    expect(before.follow).toBeNull();
    expect(atEndpoint.position.x).toBeCloseTo(0.26, 8);
    expect(atEndpoint.position.y).toBeCloseTo(0.32, 8);
    expect(atEndpoint.follow).toBeNull();
    expect(afterEndpoint.position).toEqual(atEndpoint.position);
    expect(afterEndpoint.follow).toBeNull();
    expect(duringLaterWriter.position.x).toBeCloseTo(0.53, 8);
    expect(duringLaterWriter.position.y).toBeCloseTo(0.51, 8);
    expect(duringLaterWriter.follow).toBeNull();

    const omittedDuration = evaluateCameraChannels({
      timeline: [
        action('zoom-before-unbounded-follow', 'cameraMotion', 0, {
          zoom: 2, duration: 0, _cameraProperties: ['zoom'],
        }),
        action('unbounded-follow', 'cameraFollow', 1, { characterId: 'hero', smoothing: 0 }),
      ],
      sceneTime: 1.5,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [trajectory],
    });
    expect(omittedDuration.follow?.characterId).toBe('hero');
    expect(omittedDuration.position.x).toBeCloseTo(0.34, 8);
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
      timeline: [
        action('initial-pan', 'cameraMotion', 0, { move: 'pan', duration: 0, target: [0.8, 0.7] }),
        action('late-focus', 'cameraMotion', 2, {
          move: 'pan', duration: 1, easing: 'linear', focus: { character: 'hero', part: 'head' },
        }),
      ],
      sceneTime: 3.5,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [trajectory],
    });

    expect(result.position).toEqual({ x: 0.8, y: 0.7 });
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
      timeline: [
        action('initial-pan', 'cameraMotion', 0, { move: 'pan', duration: 0, target: [0.8, 0.7] }),
        action('focus-2', 'cameraMotion', 2, {
          move: 'zoom', duration: 1, easing: 'linear',
          focus: { character: 'missing', part: 'chest', point: [0.2, 0.3] }, zoom: 2, angle: 0.2,
        }),
      ],
      sceneTime: 2.5,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [],
    });

    expect(result.position).toEqual({ x: 0.8, y: 0.7 });
    expect(result.zoom).toBeCloseTo(1.5, 6);
    expect(result.rotation).toBeCloseTo(0.1, 6);
    expect(result.diagnostics).toMatchObject([
      { code: 'missing-focus-anchor', severity: 'warning', actionId: 'focus-2' },
    ]);
  });

  it('does not claim position ownership from a zoom move label alone', () => {
    const result = evaluateCameraChannels({
      timeline: [action('zoom-only', 'cameraMotion', 2, {
        move: 'zoom', duration: 1, easing: 'linear', zoom: 1.8, _cameraProperties: ['zoom'],
      })],
      sceneTime: 2.5,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [],
    });

    expect(result.position).toEqual({ x: 0.5, y: 0.5 });
    expect(result.coverage).toEqual({ position: false, zoom: true, rotation: false });
  });

  it.each([
    ['zoom', ['zoom']],
    ['rotate', ['rotation']],
  ] as const)('does not report a missing focus anchor for a compiled %s-only writer', (move, properties) => {
    const result = evaluateCameraChannels({
      timeline: [action(`focus-${move}`, 'cameraMotion', 1, {
        move,
        duration: 1,
        focus: { character: 'missing' },
        ...(move === 'zoom' ? { zoom: 1.5 } : { angle: 15 }),
        _cameraProperties: properties,
      })],
      sceneTime: 1.5,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [],
    });

    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'missing-focus-anchor' }));
  });

  it('retains legacy focus-anchor diagnostics when compiled property metadata is absent', () => {
    const result = evaluateCameraChannels({
      timeline: [action('legacy-focus', 'cameraMotion', 1, {
        move: 'zoom', duration: 1, focus: { character: 'missing' }, zoom: 1.5,
      })],
      sceneTime: 1.5,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [],
    });

    expect(result.diagnostics).toMatchObject([{ code: 'missing-focus-anchor', actionId: 'legacy-focus' }]);
  });

  it.each([64, 128, 256])('keeps %i dense zoom writer states independent of cold, warm, and reverse query order', (count) => {
    const timeline = Array.from({ length: count }, (_, index) => action(
      `zoom-${index}`,
      'cameraMotion',
      index / count,
      { zoom: 2 + index / count, duration: 0, _cameraProperties: ['zoom'] },
    ));
    const input = {
      timeline,
      sceneTime: 1,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [],
      revision: `dense-${count}`,
    };
    const cold = evaluateCameraChannels(input);
    const expectedFinalZoom = 2 + (count - 1) / count;

    expect(cold.zoom).toBe(expectedFinalZoom);
    for (const sceneTime of [0.5, 0.125, 0.875, 1]) {
      evaluateCameraChannels({ ...input, sceneTime });
    }
    expect(evaluateCameraChannels(input)).toEqual(cold);
  });

  it('rebuilds a prepared zoom curve when its timeline content changes in place', () => {
    const timeline = [action('zoom', 'cameraMotion', 0, {
      zoom: 1.5, duration: 0, _cameraProperties: ['zoom'],
    })];
    const input = {
      timeline,
      sceneTime: 1,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [],
      revision: 'zoom-v1',
    };

    expect(evaluateCameraChannels(input).zoom).toBe(1.5);
    timeline[0].params.zoom = 2;
    expect(evaluateCameraChannels({ ...input, revision: 'zoom-v2' }).zoom).toBe(2);
  });

  it('reuses a nonzero-duration sparse zoom plan through follow and a position takeover', () => {
    const trajectory: CameraAnchorTrajectory = {
      version: 1,
      revision: 1,
      characterId: 'hero',
      part: 'center',
      validity: [{ start: 0, end: 3 }],
      samples: [
        { time: 0, position: { x: 0.35, y: 0.4 } },
        { time: 3, position: { x: 0.35, y: 0.4 } },
      ],
      events: [],
    };
    const timeline = [
      action('zoom-seed', 'cameraMotion', 0, {
        zoom: 2, duration: 0, _cameraProperties: ['zoom'],
      }),
      action('follow', 'cameraFollow', 0.1, { characterId: 'hero', smoothing: 0.25 }),
      ...Array.from({ length: 64 }, (_, index) => action(
        `sparse-zoom-${index}`,
        'cameraMotion',
        0.2 + index / 96,
        {
          zoom: 1.8 + (index % 16) / 100,
          duration: 0.35,
          easing: 'linear',
          _cameraProperties: ['zoom'],
        },
      )),
      action('rotation-only', 'cameraMotion', 0.75, {
        angle: 35, duration: 0.25, easing: 'linear', _cameraProperties: ['rotation'],
      }),
      action('position-takeover', 'cameraMotion', 1.25, {
        target: [0.7, 0.45], duration: 0.5, easing: 'linear', _cameraProperties: ['position'],
      }),
    ];
    const evaluate = (sceneTime: number) => evaluateCameraChannels({
      timeline,
      sceneTime,
      logicalReferenceSize: referenceSize,
      anchorTrajectories: [trajectory],
      revision: 'sparse-writers-v1',
    });

    const beforeTakeover = evaluate(1);
    const afterTakeover = evaluate(1.5);
    evaluate(0.5);
    const warmReverse = evaluate(1);

    expect(beforeTakeover.follow?.characterId).toBe('hero');
    expect(beforeTakeover.zoom).toBeGreaterThan(1.8);
    expect(beforeTakeover.zoom).toBeLessThan(2);
    expect(beforeTakeover.rotation).toBeGreaterThan(0);
    expect(warmReverse).toEqual(beforeTakeover);
    expect(afterTakeover.follow).toBeNull();
    expect(afterTakeover.position.x).toBeGreaterThan(beforeTakeover.position.x);
    expect(afterTakeover.position.y).toBeGreaterThan(beforeTakeover.position.y);
  });

  it('invalidates prepared follow output for new trajectory revisions and reference sizes', () => {
    const timeline = [
      action('zoom', 'cameraMotion', 0, { zoom: 2, duration: 0, _cameraProperties: ['zoom'] }),
      action('follow', 'cameraFollow', 0.1, { characterId: 'hero', smoothing: 0 }),
    ];
    const trajectory = (x: number, revision: number): CameraAnchorTrajectory => ({
      version: 1,
      revision,
      characterId: 'hero',
      part: 'center',
      validity: [{ start: 0, end: 3 }],
      samples: [
        { time: 0, position: { x, y: 0.4 } },
        { time: 3, position: { x, y: 0.4 } },
      ],
      events: [],
    });
    const firstTrajectory = [trajectory(0.3, 1)];
    const secondTrajectory = [trajectory(0.7, 2)];
    const first = evaluateCameraChannels({
      timeline, sceneTime: 1, logicalReferenceSize: referenceSize,
      anchorTrajectories: firstTrajectory, trajectoryRevision: 'hero-v1',
    });
    const second = evaluateCameraChannels({
      timeline, sceneTime: 1, logicalReferenceSize: referenceSize,
      anchorTrajectories: secondTrajectory, trajectoryRevision: 'hero-v2',
    });

    expect(first.position.x).toBeCloseTo(0.3, 8);
    expect(second.position.x).toBeCloseTo(0.7, 8);

    const rotatedTimeline = [
      action('zoom', 'cameraMotion', 0, { zoom: 1.5, duration: 0, _cameraProperties: ['zoom'] }),
      action('rotation', 'cameraMotion', 0, { angle: 45, duration: 0, _cameraProperties: ['rotation'] }),
    ];
    const wide = evaluateCameraChannels({
      timeline: rotatedTimeline, sceneTime: 1, logicalReferenceSize: referenceSize, anchorTrajectories: [],
    });
    const square = evaluateCameraChannels({
      timeline: rotatedTimeline, sceneTime: 1, logicalReferenceSize: { width: 1080, height: 1080 }, anchorTrajectories: [],
    });

    expect(wide.diagnostics).toContainEqual(expect.objectContaining({ code: 'rotation-edge-exposure' }));
    expect(square.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'rotation-edge-exposure' }));
  });

  it('keeps an unrelated position track moving while a zoom track starts', () => {
    const result = evaluateCameraChannels({
      timeline: [
        action('pan-track', 'cameraMotion', 0, { move: 'pan', duration: 4, easing: 'linear', target: [0.2, 0.2] }),
        action('zoom-track', 'cameraMotion', 2, { move: 'zoom', duration: 2, easing: 'linear', zoom: 2, _cameraProperties: ['zoom'] }),
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
