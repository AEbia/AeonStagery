import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluateCameraChannels, type CameraAnchorTrajectory } from '../engine/CameraChannelEvaluator';
import type { RuntimeTimelineAction } from '../engine/RuntimeTimelineScene';

const knots = [
  [0, 0.2, 0.8], [0.2, 0.25, 0.7], [0.21345, 0.95, 0.1],
  [0.35, 0.9, 0.2], [0.6, 0.2, 0.7], [0.8, 0.75, 0.3], [1, 0.6, 0.5],
] as const;
const trajectory: CameraAnchorTrajectory = {
  version: 1, characterId: 'hero', part: 'center', revision: 'production-precision',
  validity: [{ start: 0, end: 0.6 }, { start: 0.8, end: 1.01 }],
  samples: knots.map(([time, x, y]) => ({ time, position: { x, y } })),
  events: [{ time: 0.35, left: { x: 0.9, y: 0.2 }, right: { x: 0.1, y: 0.8 } }],
};
// Independent authored continuous target: event sides are explicit and gaps are
// never interpolated. No production trajectory sampler/integrator is used here.
function target(time: number): readonly [number, number] | null {
  if (time >= 0.6 && time < 0.8) return null;
  if (time === 0.35) return [0.1, 0.8];
  let point: readonly [number, number] = [0.6, 0.5];
  for (let index = 0; index < knots.length - 1; index++) {
    const [start, x, y] = knots[index];
    const [end, endX, endY] = knots[index + 1];
    if (time >= start && time <= end) {
      const fromX = start === 0.35 ? 0.1 : x;
      const fromY = start === 0.35 ? 0.8 : y;
      const weight = (time - start) / (end - start);
      point = [fromX + (endX - fromX) * weight, fromY + (endY - fromY) * weight];
      break;
    }
  }
  return point;
}
function reference(time: number, smoothing: number, hz: number): readonly [number, number] {
  let position: readonly [number, number] = [0.2, 0.25];
  const rate = smoothing === 0 ? 0 : Math.LN10 / (2 * smoothing);
  const boundaries = [...new Set([0, ...knots.map(([t]) => t), 0.25, 0.5, 0.7, time])].filter(t => t <= time).sort((a, b) => a - b);
  for (let interval = 1; interval < boundaries.length; interval++) {
    const start = boundaries[interval - 1]; const end = boundaries[interval];
    const count = Math.max(1, Math.ceil((end - start) * hz)); const step = (end - start) / count;
    for (let tick = 0; tick < count; tick++) {
      const a = start + tick * step; const b = start + (tick + 1) * step;
      const first = target(a + 1e-12); const middle = target((a + b) / 2); const last = target(b - 1e-12);
      if (!first || !middle || !last) continue;
      if (smoothing === 0) { position = last; continue; }
      position = position.map((value, axis) => {
        const k1 = rate * (first[axis] - value);
        const k2 = rate * (middle[axis] - value - step * k1 / 2);
        const k3 = rate * (middle[axis] - value - step * k2 / 2);
        const k4 = rate * (last[axis] - value - step * k3);
        return value + step * (k1 + 2 * k2 + 2 * k3 + k4) / 6;
      }) as unknown as readonly [number, number];
    }
  }
  if (smoothing === 0) return target(time) ?? position;
  return position;
}
function input(time: number, smoothing: number) {
  const timeline: RuntimeTimelineAction[] = [
    { _id: 'position', action: 'cameraMotion', time: 0, params: { move: 'pan', target: [0.2, 0.25], duration: 0 } },
    { _id: 'zoom', action: 'cameraMotion', time: 0, params: { zoom: 2, duration: 0, _cameraProperties: ['zoom'] } },
    { _id: 'follow', action: 'cameraFollow', time: 0, params: { characterId: 'hero', smoothing } },
    { _id: 'zoom-down', action: 'cameraMotion', time: 0.25, params: { zoom: 1, duration: 0.25, easing: 'linear', _cameraProperties: ['zoom'] } },
    { _id: 'zoom-up', action: 'cameraMotion', time: 0.5, params: { zoom: 3, duration: 0.2, easing: 'linear', _cameraProperties: ['zoom'] } },
  ];
  return { timeline, sceneTime: time, logicalReferenceSize: { width: 1920, height: 1080 }, anchorTrajectories: [trajectory] };
}

describe('production history precision independently of deterministic parity', () => {
  it.each([0, 0.8, 1])('compares fast targets, event sides, gaps/reentry and independent zoom changes to independent RK4 at smoothing %s', smoothing => {
    let maxPixels = 0;
    for (const time of [0, 0.20123, 0.21345, 0.349999, 0.35, 0.350001, 0.599999, 0.6, 0.7, 0.8, 0.800001, 0.912345, 1]) {
      const expected = reference(time, smoothing, 15_360);
      const finer = reference(time, smoothing, 30_720);
      expect(Math.hypot((finer[0] - expected[0]) * 1920, (finer[1] - expected[1]) * 1080)).toBeLessThan(0.001);
      const actual = evaluateCameraChannels(input(time, smoothing));
      const pixels = Math.hypot((actual.position.x - finer[0]) * 1920, (actual.position.y - finer[1]) * 1080);
      maxPixels = Math.max(maxPixels, pixels);
      expect(pixels, `time=${time}, smoothing=${smoothing}`).toBeLessThan(0.5);
    }
    const left = evaluateCameraChannels({ ...input(0.35, smoothing), anchorEventSide: 'left' });
    if (smoothing === 0) expect(left.position).toEqual({ x: 0.9, y: 0.2 });
    fs.writeSync(1, `CAMERA_PRECISION smoothing=${smoothing} maxCompositionPixels=${maxPixels}\n`);
  });
});
