import { performance } from 'node:perf_hooks';
import { evaluateCameraChannels, type CameraAnchorTrajectory } from '../engine/CameraChannelEvaluator.ts';
import type { RuntimeTimelineAction } from '../engine/RuntimeTimelineScene.ts';

const reference = { width: 1920, height: 1080 } as const;
const action = (id: string, type: RuntimeTimelineAction['action'], time: number, params: Record<string, unknown>): RuntimeTimelineAction => ({ _id: id, action: type, time, params });
const trajectory: CameraAnchorTrajectory = {
  version: 1, revision: 1, characterId: 'hero', part: 'center', validity: [{ start: 0, end: 2 }],
  samples: [{ time: 0, position: { x: 0.2, y: 0.35 } }, { time: 2, position: { x: 0.8, y: 0.65 } }], events: [],
};
const scenarios = ['position', 'rotation', 'follow', 'reset', 'path'] as const;
const counts = [64, 128, 256];
const rows: unknown[] = [];
for (const scenario of scenarios) for (const count of counts) {
  const timeline = Array.from({ length: count }, (_, index) => {
    const start = index / count;
    if (scenario === 'position') return action(`position-${index}`, 'cameraMotion', start, { target: [0.2 + (index % 8) / 20, 0.3 + (index % 7) / 20], duration: 0.35, easing: 'linear', _cameraProperties: ['position'] });
    if (scenario === 'rotation') return action(`rotation-${index}`, 'cameraMotion', start, { angle: (index % 30) + 1, duration: 0.35, easing: 'linear', _cameraProperties: ['rotation'] });
    if (scenario === 'follow') return action(`follow-${index}`, 'cameraFollow', start, { characterId: 'hero', smoothing: 0.25 });
    if (scenario === 'reset') return action(`reset-${index}`, 'cameraReset', start, { duration: 0.35, ease: 'linear' });
    return action(`path-${index}`, 'cameraPath', start, { ease: 'linear', keyframes: [{ time: 0, position: [0.2, 0.3] }, { time: 0.35, position: [0.7, 0.6] }] });
  });
  const input = { timeline, sceneTime: 1.25, logicalReferenceSize: reference, anchorTrajectories: scenario === 'follow' ? [trajectory] : [], revision: `${scenario}-${count}-baseline` };
  const coldStarted = performance.now();
  const output = evaluateCameraChannels(input);
  const coldMs = performance.now() - coldStarted;
  const warm: number[] = [];
  for (let round = 0; round < 7; round++) {
    const started = performance.now();
    evaluateCameraChannels(input);
    warm.push(performance.now() - started);
  }
  warm.sort((a, b) => a - b);
  rows.push({ scenario, count, coldMs: Number(coldMs.toFixed(3)), warmMedianMs: Number(warm[3].toFixed(3)), warmMinMs: Number(warm[0].toFixed(3)), output: { x: output.position.x, y: output.position.y, zoom: output.zoom, rotation: output.rotation, following: output.follow?.characterId ?? null } });
}
console.log(JSON.stringify(rows, null, 2));
