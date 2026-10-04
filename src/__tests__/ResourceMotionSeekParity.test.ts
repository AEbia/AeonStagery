/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CharacterSynchronizer } from '../engine/coordinators/CharacterSynchronizer';
import { SnapshotStore } from '../engine/SnapshotStore';
import { ProxyRegistry } from '../engine/coordinators/ProxyRegistry';
import { motionCurveCache, type CachedResourceMotion } from '../engine/live2d/motionCurveCache';
import { seekProfiler } from '../engine/SeekProfiler';
import type { CharacterMotionOutput } from '../api/types/semantic-scene';

vi.mock('../ui/SettingsStore', () => ({
  settingsManager: { get: vi.fn().mockReturnValue(1000), set: vi.fn(), load: vi.fn(), save: vi.fn() },
}));

vi.mock('untitled-pixi-live2d-engine/cubism-legacy', () => ({
  config: {},
}));

const cachedMotion: Extract<CharacterMotionOutput, { kind: 'custom' }> = {
  kind: 'custom',
  durationSeconds: 2,
  fadeInSeconds: 0.5,
  derivedFrom: { key: 'wave', fadeInSeconds: 0.5, fadeOutSeconds: 0.25 },
  tracks: [
    {
      parameterId: 'PARAM_ANGLE_X',
      keyframes: [
        { time: 0, value: 0, segment: { type: 'linear' } },
        { time: 0.1, value: 10 },
        { time: 0.2, value: 20 },
        { time: 0.3, value: 10 },
        { time: 2, value: 30 },
      ],
    },
  ],
};

const cachedEntry: CachedResourceMotion = {
  key: 'pixi-live2d-display-cubism2::asset://models/char.model3.json::wave',
  motion: cachedMotion,
  sourceFadeInSeconds: 0.5,
  sourceFadeOutSeconds: 0.25,
  isIdle: false,
  evaluate: () => ({}),
};

const fakeSamplerTarget = { internalModel: {}, motionManager: {} } as any;

function createMockLive2D() {
  const characterEntry = {
    id: 'char1',
    model: {},
    modelPath: 'asset://models/char.model3.json',
    runtime: { adapterId: 'pixi-live2d-display-cubism2' },
  };
  const live2D = {
    listCharacters: vi.fn().mockReturnValue(['char1']),
    hasCharacter: vi.fn().mockReturnValue(true),
    getAllCharacters: vi.fn().mockReturnValue(new Map([['char1', characterEntry]])),
    applySnapshot: vi.fn(),
    captureSnapshot: vi.fn().mockReturnValue(null),
    playMotion: vi.fn(),
    playCustomMotion: vi.fn(),
    resetToIdle: vi.fn(),
    setExpression: vi.fn(),
    setExpressionForSeek: vi.fn(),
    prepareExpressionForSeek: vi.fn(),
    lookAt: vi.fn(),
    getPoint: vi.fn().mockReturnValue(null),
    setBlink: vi.fn(),
    applyProxyTransform: vi.fn(),
    setAutoUpdate: vi.fn(),
    updateAll: vi.fn().mockResolvedValue(undefined),
    isMotionLoading: vi.fn().mockReturnValue(false),
    clearAllPendingMotions: vi.fn(),
    stopAllMotions: vi.fn(),
    getMotionDuration: vi.fn().mockReturnValue(2),
    getMotionSamplerTargets: vi.fn(),
  };
  return live2D;
}

describe('CharacterSynchronizer cache-first resource motion seek', () => {
  let synchronizer: CharacterSynchronizer;
  let live2D: ReturnType<typeof createMockLive2D>;
  let snapshots: SnapshotStore;

  beforeEach(() => {
    vi.restoreAllMocks();
    live2D = createMockLive2D();
    snapshots = new SnapshotStore();
    synchronizer = new CharacterSynchronizer(live2D as any);
    (global as any).window = { UtSystem: {
      getUserTimeMSec: () => 1000,
      setUserTimeMSec: vi.fn(),
    }};
  });

  it('skips legacy SDK stepping and hands the motion start snapshot to the shared evaluator', async () => {
    vi.spyOn(motionCurveCache, 'get').mockReturnValue(cachedEntry);

    const charSnap = {
      params: new Float32Array([0, 0, 0, 0]),
      parts: new Float32Array([1, 1, 1, 1]),
      motion: { key: 'wave', startTime: 0 },
      expression: { key: null },
    };
    snapshots.insert(0, new Map([['char1', charSnap as any]]));

    const proxies = new ProxyRegistry();
    proxies.set('char1', { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 });

    await synchronizer.syncTo({
      time: 0.2, // inside the 0.5s fade-in window
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'asset://models/char.model3.json',
        config: {},
        motion: {
          output: { kind: 'resource', key: 'wave', fadeInSeconds: 0.5 } as CharacterMotionOutput,
          priority: 3,
          time: 0,
        },
      }]]),
      transformationProxies: proxies,
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: false,
    });

    // No SDK pre-population from the snapshot for cache-covered characters.
    expect(live2D.playMotion).toHaveBeenCalledTimes(1);
    // The single playMotion call is the Phase-3 desired-motion request with the
    // motion-start snapshot as the fade handoff:
    expect(live2D.playMotion).toHaveBeenCalledWith(
      'char1',
      'wave',
      3,
      0.2,
      0.2,
      false,
      charSnap,
    );
    expect(live2D.playCustomMotion).not.toHaveBeenCalled(); // routing happens in Live2DManager
    // The legacy motion-queue pre-population and its 16ms prefill flush were
    // removed together with the forward-sim path; only the post-sync 0ms flush
    // runs.
    const updateCalls = live2D.updateAll.mock.calls.map((call) => call[0]);
    expect(updateCalls).toEqual([0]);
    expect(live2D.updateAll.mock.calls.length).toBe(1);
  });

  it('keeps the curve cache disjoint from the scene document: cache-backed seek never rewrites scene-derived motion references', async () => {
    vi.spyOn(motionCurveCache, 'get').mockReturnValue(cachedEntry);

    const charSnap = {
      params: new Float32Array([0, 0, 0, 0]),
      parts: new Float32Array([1, 1, 1, 1]),
      motion: { key: 'wave', startTime: 0 },
      expression: { key: null },
    };
    snapshots.insert(0, new Map([['char1', charSnap as any]]));

    const proxies = new ProxyRegistry();
    proxies.set('char1', { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 });

    // ADR-0033 isolation guard: the curve cache is derived runtime data only.
    // Freeze the scene-derived motion reference so any write-back from the
    // cache/seek path would throw in strict mode (parity assertion that the
    // seek never touches the persisting scene document domain).
    const motionRef: CharacterMotionOutput = { kind: 'resource', key: 'wave', fadeInSeconds: 0.5 };
    Object.freeze(motionRef);
    const desiredChars = new Map([['char1', {
      id: 'char1',
      model: 'asset://models/char.model3.json',
      config: {},
      motion: Object.freeze({ output: motionRef, priority: 3, time: 0 }),
    }]]);

    await expect(
      synchronizer.syncTo({
        time: 0.2,
        desiredChars,
        transformationProxies: proxies,
        snapshotStore: snapshots,
        shouldCancel: () => false,
        skipHardReset: false,
        isScrubbing: false,
      }),
    ).resolves.toBeUndefined();

    // The scene keeps an ordinary resource reference; nothing was rewritten to
    // a persisted custom motion (DocumentCodec domain untouched).
    const output = desiredChars.get('char1')!.motion!.output;
    expect(output.kind).toBe('resource');
    expect(output).toBe(motionRef);
  });

  it('falls back to the legacy SDK stepping path when the cache misses', async () => {
    vi.spyOn(motionCurveCache, 'get').mockReturnValue(null);

    const charSnap = {
      params: new Float32Array([0, 0, 0, 0]),
      parts: new Float32Array([1, 1, 1, 1]),
      motion: { key: 'wave', startTime: 0 },
      expression: { key: null },
    };
    snapshots.insert(0, new Map([['char1', charSnap as any]]));

    const proxies = new ProxyRegistry();
    proxies.set('char1', { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 });

    await synchronizer.syncTo({
      time: 0.2,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'asset://models/char.model3.json',
        config: {},
        motion: {
          output: { kind: 'resource', key: 'wave', fadeInSeconds: 0.5 } as CharacterMotionOutput,
          priority: 3,
          time: 0,
        },
      }]]),
      transformationProxies: proxies,
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: false,
    });

    // One call: the Phase-3 desired-motion start (skipHardReset=false). The
    // snapshot motion pre-population was removed with the legacy forward-sim
    // path.
    expect(live2D.playMotion).toHaveBeenCalledTimes(1);
    expect(live2D.playMotion).toHaveBeenCalledWith('char1', 'wave', 3, 0.2, 0.2, false);
    // updateAll receives only the post-sync 0ms flush — the 16ms prefill flush
    // is gone together with simulateForward.
    const updateCalls = live2D.updateAll.mock.calls.map((call) => call[0]);
    expect(updateCalls).toEqual([0]);
  });

  it('samples a not-yet-cached convertible motion once during seek and lands on the pure evaluator', async () => {
    vi.spyOn(motionCurveCache, 'get').mockReturnValue(null);
    vi.spyOn(motionCurveCache, 'missReason').mockReturnValue(null);
    const ensure = vi.spyOn(motionCurveCache, 'ensure').mockResolvedValue(cachedEntry);
    live2D.getMotionSamplerTargets.mockReturnValue([fakeSamplerTarget]);

    const charSnap = {
      params: new Float32Array([0, 0, 0, 0]),
      parts: new Float32Array([1, 1, 1, 1]),
      motion: { key: 'wave', startTime: 0 },
      expression: { key: null },
    };
    snapshots.insert(0, new Map([['char1', charSnap as any]]));

    const proxies = new ProxyRegistry();
    proxies.set('char1', { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 });

    await synchronizer.syncTo({
      time: 0.2, // inside the 0.5s fade-in window
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'asset://models/char.model3.json',
        config: {},
        motion: {
          output: { kind: 'resource', key: 'wave', fadeInSeconds: 0.5 } as CharacterMotionOutput,
          priority: 3,
          time: 0,
        },
      }]]),
      transformationProxies: proxies,
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: false,
      fps: 30,
    });

    // The seek resolves the convertible miss through the shared sampler once:
    expect(live2D.getMotionSamplerTargets).toHaveBeenCalledWith('char1');
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith({
      adapterId: 'pixi-live2d-display-cubism2',
      modelRuntimePath: 'asset://models/char.model3.json',
      motionKey: 'wave',
      targets: [fakeSamplerTarget],
      fps: 30,
    });
    // The freshly built curve entry feeds Phase 3 exactly like a pre-warmed
    // hit: one desired-motion playMotion with the motion-start handoff.
    expect(live2D.playMotion).toHaveBeenCalledTimes(1);
    expect(live2D.playMotion).toHaveBeenCalledWith('char1', 'wave', 3, 0.2, 0.2, false, charSnap);
    const updateCalls = live2D.updateAll.mock.calls.map((call) => call[0]);
    expect(updateCalls).toEqual([0]);
  });

  it('never re-samples a permanently-rejected motion during seek (SDK fallback)', async () => {
    vi.spyOn(motionCurveCache, 'get').mockReturnValue(null);
    vi.spyOn(motionCurveCache, 'missReason').mockReturnValue('parts-layout-curves');
    const ensure = vi.spyOn(motionCurveCache, 'ensure');
    live2D.getMotionSamplerTargets.mockReturnValue([fakeSamplerTarget]);

    await synchronizer.syncTo({
      time: 0.2,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'asset://models/char.model3.json',
        config: {},
        motion: {
          output: { kind: 'resource', key: 'wave', fadeInSeconds: 0.5 } as CharacterMotionOutput,
          priority: 3,
          time: 0,
        },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: false,
      fps: 30,
    });

    // A permanently-rejected key never re-attempts its doomed sample; the seek
    // goes straight to the SDK fallback in Phase 3.
    expect(ensure).not.toHaveBeenCalled();
    expect(live2D.playMotion).toHaveBeenCalledTimes(1);
    expect(live2D.playMotion).toHaveBeenCalledWith('char1', 'wave', 3, 0.2, 0.2, false);
  });

  it('reports which resource motions still fall back to the SDK path', async () => {
    vi.spyOn(motionCurveCache, 'get').mockReturnValue(null);
    vi.spyOn(motionCurveCache, 'missReason').mockReturnValue('parts-layout-curves');
    vi.spyOn(motionCurveCache, 'ensure');

    seekProfiler.reset();
    seekProfiler.setEnabled(true);
    const listener = vi.fn();
    seekProfiler.onReport(listener);
    // Mirror the real wiring: ScriptEngine._doSeek opens the profile before
    // CharacterSynchronizer.syncTo runs.
    seekProfiler.startSeek({ time: 0.2, forceReconstruct: false });

    try {
      await synchronizer.syncTo({
        time: 0.2,
        desiredChars: new Map([['char1', {
          id: 'char1',
          model: 'asset://models/char.model3.json',
          config: {},
          motion: {
            output: { kind: 'resource', key: 'wave', fadeInSeconds: 0.5 } as CharacterMotionOutput,
            priority: 3,
            time: 0,
          },
        }]]),
        transformationProxies: new ProxyRegistry(),
        snapshotStore: snapshots,
        shouldCancel: () => false,
        skipHardReset: false,
        isScrubbing: false,
        fps: 30,
      });
      // Mirror the real wiring: ScriptEngine._doSeek closes the profile after
      // syncAllStates returns, which is what emits the report.
      seekProfiler.finishSeek(1);
    } finally {
      seekProfiler.setEnabled(false);
    }

    // The seek report records the permanent-miss reason so a non-zero
    // motionStep can be explained ("wave stays on the SDK path because ...").
    const lastReport = seekProfiler.getLastReport();
    expect(lastReport?.cacheMissKeys).toContain('wave(parts-layout-curves)');
  });
});
