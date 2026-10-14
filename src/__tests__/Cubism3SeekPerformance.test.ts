import { live2DStageState } from './helpers/live2DStageState';
import { afterEach, expect, it, vi } from 'vitest';
import type { CharacterEntry } from '../engine/Live2DConfig';
import type { CharacterMotionOutput } from '../api/types/semantic-scene';
import { CharacterSynchronizer } from '../engine/coordinators/CharacterSynchronizer';
import { ProxyRegistry } from '../engine/coordinators/ProxyRegistry';
import { SnapshotStore } from '../engine/SnapshotStore';
import Live2DManager from '../engine/Live2DManager';
import { motionCurveCache, type CachedResourceMotion } from '../engine/live2d/motionCurveCache';
import { createCubismModelFixture } from './helpers/cubismModelFixture';
import { evaluateCustomMotionRuntime } from '../engine/live2d/customMotionRuntime';

vi.mock('../ui/SettingsStore', () => ({ settingsManager: { get: vi.fn().mockReturnValue(1000) } }));
vi.mock('untitled-pixi-live2d-engine/cubism-legacy', () => ({ config: {} }));
afterEach(() => vi.restoreAllMocks());

it('does not rebuild the same Cubism 3+ fade history on every scrub request', async () => {
  let curveReads = 0;
  const endKeyframe = { time: 2, value: 30 };
  const firstControlPoint = { time: 0.5, value: 10 };
  const motion: Extract<CharacterMotionOutput, { kind: 'custom' }> = {
    kind: 'custom', durationSeconds: 2, fadeInSeconds: 1, derivedFrom: { key: 'wave' },
    tracks: Array.from({ length: 32 }, (_, index) => ({
      parameterId: `ParamProbe${index}`,
      keyframes: [
        { time: 0, get value() { curveReads++; return 0; }, segment: {
          type: 'bezier' as const, controlPoints: [firstControlPoint, { time: 1.5, value: 20 }] as const,
        } },
        endKeyframe,
      ],
    })),
  };
  const cached: CachedResourceMotion = { key: 'probe', motion, isIdle: false, evaluate: () => ({}) };
  vi.spyOn(motionCurveCache, 'get').mockReturnValue(cached);
  const { model, core, drawn } = createCubismModelFixture(motion.tracks.map(track => track.parameterId));
  core.setParameterValueByIndex(0, 0.01);
  core.saveParameters();
  const manager = new Live2DManager();
  const snapshot = model.captureRuntimeSnapshot('hero');
  const entry: CharacterEntry = {
    id: 'hero', model, modelPath: 'hero.model3.json', modelUrl: 'hero.model3.json',
    runtime: { runtimeFamily: 'cubism3-plus', adapterId: 'untitled-pixi-live2d-engine-cubism', supported: true },
    adapterId: 'untitled-pixi-live2d-engine-cubism', config: {}, injectedParams: {},
    lipSyncParameterIds: new Set(), baseHeight: 100, motionEpoch: 0, idleSnapshot: snapshot,
  };
  live2DStageState(manager).characters = new Map([[entry.id, entry]]);
  const sync = new CharacterSynchronizer(manager);
  const snapshots = new SnapshotStore();
  snapshots.insert(0, new Map([['hero', snapshot]]));
  const desiredChars = new Map([['hero', {
    id: 'hero', model: entry.modelPath, config: {},
    motion: { output: { kind: 'resource' as const, key: 'wave' }, time: 0 },
  }]]);
  async function scrub(time: number) {
    manager.purgeAllCharacterRuntimeState();
    await sync.syncTo({ time, desiredChars, transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots, shouldCancel: () => false, skipHardReset: true, isScrubbing: true });
  }
  try {
    await scrub(0.9);
    const targetPose = drawn()[0];
    expect(targetPose).toBeGreaterThan(0);
    curveReads = 0;
    const updatesBeforeScrub = core.update.mock.calls.length;
    const started = performance.now();
    for (let index = 0; index < 120; index++) await scrub(index % 2 ? 0.9 : 0.6);
    const elapsed = performance.now() - started;
    const coreUpdates = core.update.mock.calls.length - updatesBeforeScrub;
    console.log(JSON.stringify({ scrubs: 120, milliseconds: Math.round(elapsed), curveReads, coreUpdates }));
    expect(drawn()[0]).toBeCloseTo(targetPose, 5);
    // Core geometry is a frame commit; its cost must not multiply by the
    // number of controlled parameters during a motion handoff.
    expect(coreUpdates).toBeLessThanOrEqual(120 * 8);
    // A previously evaluated fade interval should be reused across backward
    // and forward seeks, rather than re-reading all its historical curves.
    expect(curveReads).toBeLessThan(120 * motion.tracks.length * 8);
    snapshot.params[0] = 15;
    await scrub(0);
    expect(drawn()[0]).toBe(15);
    await scrub(0.9);
    const beforeEdit = drawn()[0];
    endKeyframe.value = -30;
    await scrub(0.9);
    expect(drawn()[0]).not.toBeCloseTo(beforeEdit, 5);
    firstControlPoint.value = -10;
    await scrub(0.9);
    const expected = evaluateCustomMotionRuntime(motion, 0, 0.9, {
      values: Object.fromEntries(motion.tracks.map((track, index) => [track.parameterId, snapshot.params[index]])),
    });
    expect(drawn()[0]).toBeCloseTo(expected.values.ParamProbe0, 5);
  } finally {
    entry.customMotionStage?.dispose();
    model.destroy();
    live2DStageState(manager).characters = new Map();
  }
});

it('does not scan historical keyframes once all track fades have ended', () => {
  let timeReads = 0;
  const motion: Extract<CharacterMotionOutput, { kind: 'custom' }> = {
    kind: 'custom', durationSeconds: 60, fadeInSeconds: 1, derivedFrom: { key: 'dense' },
    tracks: Array.from({ length: 32 }, (_, index) => ({
      parameterId: `ParamProbe${index}`,
      keyframes: Array.from({ length: 3601 }, (_, frame) => ({
        get time() { timeReads++; return frame / 60; }, value: frame / 60,
      })),
    })),
  };
  const handoff = { values: {} };
  const started = performance.now();
  for (let index = 0; index < 120; index++) {
    const target = 30 + index / 60;
    const evaluation = evaluateCustomMotionRuntime(motion, 0, target, handoff);
    expect(evaluation.values.ParamProbe0).toBeCloseTo(target, 5);
  }
  console.log(JSON.stringify({ scrubs: 120, milliseconds: Math.round(performance.now() - started), timeReads }));
  expect(timeReads).toBeLessThan(120 * motion.tracks.length * 40);
});
