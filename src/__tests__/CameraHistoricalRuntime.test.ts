/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { CameraHistoricalRuntime } from '../engine/CameraHistoricalRuntime';
import { SemanticScenePipeline } from '../services/semantic-scene/SemanticScenePipeline';
import type { CurrentSceneDocument } from '../api/types/semantic-scene';

async function scene(statements: CurrentSceneDocument['statements']) {
  return (await new SemanticScenePipeline({ resolveAsset: value => value }).processDocument({
    schemaVersion: 5, sceneId: 'demand-history',
    meta: { title: 'Demand history', durationSeconds: 600,
      characters: [{ id: 'hero', name: 'Hero', model: 'hero.model3.json' }] },
    statements,
  })).prepared;
}

function history() {
  const requests: number[] = [];
  const runtime = new CameraHistoricalRuntime(() => ({
    prepareCameraAnchorsPrepared: async (_scene, _paths, _token, options) => {
      const time = options?.throughTime ?? 600;
      requests.push(time);
      return { snapshotHistory: [], anchorTrajectories: [], anchorRevision: requests.length, preparedThroughTime: time };
    },
    cancel: () => {}, destroy: () => {},
  }));
  return { runtime, requests };
}

describe('on-demand camera history independent of snapshot Bake', () => {
  it('prepares focus at its authored start, without evaluating the scene tail', async () => {
    const { runtime, requests } = history();
    const input = await scene([{ id: 'focus', type: 'camera', time: 2,
      params: { mode: 'focus', target: 'hero', durationSeconds: 1 } }]);
    await runtime.prepare(input, true, 0);
    expect(requests).toEqual([]);
    await runtime.ensureAt(600);
    expect(requests).toEqual([2]);
    expect(runtime.covers(600)).toBe(true);
    await runtime.ensureAt(3);
    expect(requests).toEqual([2]);
    const previous = runtime.input;
    await runtime.prepare(input, true, 3);
    expect(requests).toEqual([2, 2]);
    expect(runtime.input).not.toBe(previous);
    runtime.dispose();
  });

  it.each([0, 2])('bounds a finite follow at its explicit duration %s', async duration => {
    const { runtime, requests } = history();
    const input = await scene([{ id: 'follow', type: 'camera', time: 1,
      params: { mode: 'follow', operation: 'start', target: 'hero', durationSeconds: duration } }]);
    await runtime.prepare(input, true, 0);
    await runtime.ensureAt(600);
    expect(requests).toEqual([1 + duration]);
    runtime.dispose();
  });

  it('retains history through sparse zoom/rotation writers until actual position takeover', async () => {
    const { runtime, requests } = history();
    const input = await scene([
      { id: 'follow', type: 'camera', time: 1, params: { mode: 'follow', operation: 'start', target: 'hero' } },
      { id: 'zoom', type: 'camera', time: 2, params: { mode: 'move', zoom: { kind: 'absolute', value: 2 }, durationSeconds: 1 } },
      { id: 'rotate', type: 'camera', time: 2, params: { mode: 'move', rotation: 30, durationSeconds: 1 } },
      { id: 'pan', type: 'camera', time: 4, params: { mode: 'move', position: [0.3, 0.7], durationSeconds: 1 } },
    ]);
    await runtime.prepare(input, true, 0);
    await runtime.ensureAt(3);
    await runtime.ensureAt(600);
    expect(requests).toEqual([3, 4]);
    runtime.dispose();
  });
});
