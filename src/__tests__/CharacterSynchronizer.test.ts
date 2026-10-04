if (typeof window === 'undefined') {
  (global as any).window = {};
}
if (typeof document === 'undefined') {
  (global as any).document = {
    documentElement: {
      style: {
        setProperty: () => {},
        getPropertyValue: () => '',
      },
    },
  };
}
if (typeof localStorage === 'undefined') {
  (global as any).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  };
}
if (typeof Audio === 'undefined') {
  (global as any).Audio = class {
    play = async () => {};
    pause = () => {};
    src = '';
  };
}

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CharacterSynchronizer } from '../engine/coordinators/CharacterSynchronizer';
import { SnapshotStore } from '../engine/SnapshotStore';
import { ProxyRegistry } from '../engine/coordinators/ProxyRegistry';
import { Live2DMotionController } from '../engine/Live2DMotionController';

vi.mock('../ui/SettingsStore', () => ({
  settingsManager: { get: vi.fn().mockReturnValue(1000), set: vi.fn(), load: vi.fn(), save: vi.fn() },
}));

vi.mock('untitled-pixi-live2d-engine/cubism-legacy', () => ({
  config: {},
}));

function createMockLive2DManager() {
  return {
    listCharacters: vi.fn().mockReturnValue([]),
    hasCharacter: vi.fn().mockReturnValue(false),
    getAllCharacters: vi.fn().mockReturnValue(new Map()),
    applySnapshot: vi.fn(),
    captureSnapshot: vi.fn().mockReturnValue(null),
    playMotion: vi.fn(),
    resetToIdle: vi.fn(),
    setExpression: vi.fn(),
    lookAt: vi.fn(),
    getPoint: vi.fn().mockReturnValue(null),
    setBlink: vi.fn(),
    applyProxyTransform: vi.fn(),
    setAutoUpdate: vi.fn(),
    updateAll: vi.fn().mockResolvedValue(undefined),
    isMotionLoading: vi.fn().mockReturnValue(false),
    clearAllPendingMotions: vi.fn(),
    stopAllMotions: vi.fn(),
    getMotionDuration: vi.fn().mockReturnValue(0),
  };
}

describe('CharacterSynchronizer', () => {
  let synchronizer: CharacterSynchronizer;
  let live2D: ReturnType<typeof createMockLive2DManager>;
  let snapshots: SnapshotStore;

  beforeEach(() => {
    live2D = createMockLive2DManager();
    snapshots = new SnapshotStore();
    synchronizer = new CharacterSynchronizer(live2D as any);
    (window as any).UtSystem = {
      getUserTimeMSec: () => 1000,
      setUserTimeMSec: vi.fn(),
    };
  });

  it('syncTo restores snapshot and updates state synchronously', async () => {
    // Setup snapshot
    const charSnap = {
      params: new Float32Array(30),
      parts: new Float32Array(30),
      motion: { key: 'idle', startTime: 0 },
    };
    snapshots.insert(1.0, new Map([['char1', charSnap as any]]));
    live2D.listCharacters.mockReturnValue(['char1']);
    live2D.hasCharacter.mockReturnValue(true);

    const desiredChars = new Map([
      ['char1', {
        id: 'char1',
        model: 'model.model3.json',
        config: {},
        expression: { key: 'happy' },
      }]
    ]);

    const proxies = new ProxyRegistry();
    proxies.set('char1', { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 });

    await synchronizer.syncTo({
      time: 1.0,
      desiredChars,
      transformationProxies: proxies,
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: false,
    });

    // Verify snapshot apply is called synchronously first
    expect(live2D.applySnapshot).toHaveBeenCalledWith('char1', charSnap);
    // The snapshot motion pre-population was removed together with the legacy
    // forward-sim path: the desired state carries no motion, so Phase 3 resets
    // the character to idle instead of replaying the snapshot's SDK queue.
    expect(live2D.playMotion).not.toHaveBeenCalled();
    expect(live2D.resetToIdle).toHaveBeenCalledWith('char1');
    
    // Verify state sync is called
    expect(live2D.setExpression).toHaveBeenCalledWith('char1', 'happy');
  });

  it('does not restore a snapshot from before the current character entrance', async () => {
    const previousEntrancePose = {
      params: new Float32Array([0.8, 0.2, -0.4]),
      opacities: new Float32Array([1, 1]),
      motion: { key: 'motion-a', startTime: 1 },
    };
    snapshots.insert(2, new Map([['char1', previousEntrancePose as any]]));
    live2D.listCharacters.mockReturnValue(['char1']);
    live2D.hasCharacter.mockReturnValue(true);

    await synchronizer.syncTo({
      time: 5.1,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'model.model.json',
        config: {},
        lifecycleStartTime: 5,
        motion: {
          output: { kind: 'resource', key: 'motion-b' },
          priority: 3,
          time: 5,
        },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: true,
      isScrubbing: true,
    });

    // The nearest snapshot belongs to the character's previous on-stage
    // lifetime. Reapplying it would make the second entrance fade from Motion
    // A instead of the model's neutral pose.
    expect(live2D.applySnapshot).not.toHaveBeenCalledWith('char1', previousEntrancePose);
    expect(live2D.playMotion).toHaveBeenCalledTimes(1);
    const [, key, priority, offset, sceneTime, skipHardReset] = live2D.playMotion.mock.calls[0];
    expect(key).toBe('motion-b');
    expect(priority).toBe(3);
    expect(offset).toBeCloseTo(0.1, 6);
    expect(sceneTime).toBe(5.1);
    expect(skipHardReset).toBe(true);
  });

  it('does not restore a snapshot captured at the current entrance boundary', async () => {
    const previousEntrancePose = {
      params: new Float32Array([0.95, -0.4, 0.7]),
      opacities: new Float32Array([1, 1]),
      motion: { key: 'motion-a', startTime: 1 },
    };
    // SnapshotStore timestamps are scene-time values, so a snapshot recorded
    // immediately before the addCharacter callback can have the exact same
    // timestamp as the new lifecycle's start. It still belongs to the old
    // incarnation and must not become the first fade-in source.
    snapshots.insert(5, new Map([['char1', previousEntrancePose as any]]));
    live2D.listCharacters.mockReturnValue(['char1']);
    live2D.hasCharacter.mockReturnValue(true);

    await synchronizer.syncTo({
      time: 5.1,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'model.model.json',
        config: {},
        lifecycleStartTime: 5,
        motion: {
          output: { kind: 'resource', key: 'motion-first' },
          priority: 3,
          time: 5,
        },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: true,
      isScrubbing: true,
    });

    expect(live2D.applySnapshot).not.toHaveBeenCalledWith('char1', previousEntrancePose);
  });

  it('does not restore a snapshot whose motion starts after the captured scene time', async () => {
    const contaminated = {
      params: new Float32Array([0.8, 0.2, -0.4]),
      opacities: new Float32Array([1, 1]),
      // This pose was captured while a later timeline motion was still
      // resident in the SDK queue. It cannot represent the first entrance at
      // t=0, even though the snapshot timestamp itself is before the target.
      motion: { key: 'motion-later', startTime: 2 },
    };
    snapshots.insert(0.4, new Map([['char1', contaminated as any]]));
    live2D.listCharacters.mockReturnValue(['char1']);
    live2D.hasCharacter.mockReturnValue(true);

    await synchronizer.syncTo({
      time: 0.5,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'model.model.json',
        config: {},
        lifecycleStartTime: 0,
        motion: {
          output: { kind: 'resource', key: 'motion-first' },
          priority: 3,
          time: 0.5,
        },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: true,
      isScrubbing: true,
    });

    expect(live2D.applySnapshot).not.toHaveBeenCalledWith('char1', contaminated);
  });

  it('rejects a post-entrance snapshot that still records the previous lifetime motion', async () => {
    const contaminated = {
      params: new Float32Array([0.7, -0.3, 0.4]),
      opacities: new Float32Array([1, 1]),
      motion: { key: 'motion-a', startTime: 1 },
    };
    // The snapshot was captured after the second entrance, but its motion
    // metadata proves it still belongs to the first lifetime.
    snapshots.insert(3.2, new Map([['char1', contaminated as any]]));
    live2D.listCharacters.mockReturnValue(['char1']);
    live2D.hasCharacter.mockReturnValue(true);

    await synchronizer.syncTo({
      time: 3.5,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'model.model.json',
        config: {},
        lifecycleStartTime: 3,
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: true,
      isScrubbing: true,
    });

    expect(live2D.applySnapshot).not.toHaveBeenCalledWith('char1', contaminated);
  });

  it('filters stale snapshots independently for two characters re-entering together', async () => {
    const oldPoseA = {
      params: new Float32Array([0.8, 0.2]),
      opacities: new Float32Array([1]),
      motion: { key: 'motion-a', startTime: 1 },
    };
    const oldPoseB = {
      params: new Float32Array([-0.6, 0.4]),
      opacities: new Float32Array([1]),
      motion: { key: 'motion-b', startTime: 1 },
    };
    snapshots.insert(2, new Map([
      ['char-a', oldPoseA as any],
      ['char-b', oldPoseB as any],
    ]));
    live2D.listCharacters.mockReturnValue(['char-a', 'char-b']);
    live2D.hasCharacter.mockReturnValue(true);

    await synchronizer.syncTo({
      time: 5.2,
      desiredChars: new Map([
        ['char-a', { id: 'char-a', model: 'a.model.json', config: {}, lifecycleStartTime: 5 }],
        ['char-b', { id: 'char-b', model: 'b.model.json', config: {}, lifecycleStartTime: 5 }],
      ]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: true,
      isScrubbing: true,
    });

    expect(live2D.applySnapshot).not.toHaveBeenCalledWith('char-a', oldPoseA);
    expect(live2D.applySnapshot).not.toHaveBeenCalledWith('char-b', oldPoseB);
  });

  it('rebuilds point look-at and blink state for direct target-time jumps', async () => {
    live2D.hasCharacter.mockReturnValue(true);
    live2D.listCharacters.mockReturnValue(['char1']);
    const proxies = new ProxyRegistry();
    proxies.set('char1', { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 });

    await synchronizer.syncTo({
      time: 1.5,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'm.model3.json',
        config: {},
        lookAt: {
          point: [0.25, -0.4],
          enabled: true,
          startTime: 0,
          duration: 0.5,
        },
        blink: { enabled: false, intervalMs: 2500 },
      }]]),
      transformationProxies: proxies,
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: true,
    });

    expect(live2D.lookAt).toHaveBeenLastCalledWith('char1', 0.25, -0.4, 0);
    expect(live2D.setBlink).toHaveBeenLastCalledWith('char1', false, 2500, 1.5, undefined);

    await synchronizer.syncTo({
      time: 2.5,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'm.model3.json',
        config: {},
        lookAt: {
          focusX: -0.2,
          focusY: 0.6,
          startTime: 2,
          duration: 0.5,
        },
        blink: { enabled: true, intervalMs: 4000 },
      }]]),
      transformationProxies: proxies,
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: true,
    });

    expect(live2D.lookAt).toHaveBeenLastCalledWith('char1', -0.2, 0.6, 0);
    expect(live2D.setBlink).toHaveBeenLastCalledWith('char1', true, 4000, 2.5, undefined);
  });

  it('keeps the in-progress look-at transition when a seek lands inside it', async () => {
    live2D.hasCharacter.mockReturnValue(true);
    live2D.listCharacters.mockReturnValue(['char1']);

    await synchronizer.syncTo({
      time: 1.5,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'm.model3.json',
        config: {},
        lookAt: {
          point: [1, 0],
          enabled: true,
          duration: 1,
          startTime: 1,
          fromFocus: [0, 0],
          toFocus: [1, 0],
          focus: [0.5, 0],
        },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: true,
    });

    expect(live2D.lookAt).toHaveBeenLastCalledWith(
      'char1',
      1,
      0,
      0.5,
      { fromX: 0, fromY: 0, elapsed: 0.5 },
    );
  });

  it('finishes a completed look-at transition after its duration elapses', async () => {
    live2D.hasCharacter.mockReturnValue(true);
    live2D.listCharacters.mockReturnValue(['char1']);

    await synchronizer.syncTo({
      time: 2.5,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'm.model3.json',
        config: {},
        lookAt: {
          point: [1, 0],
          enabled: true,
          duration: 1,
          startTime: 1,
          fromFocus: [0, 0],
          toFocus: [1, 0],
          focus: [1, 0],
        },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: true,
    });

    expect(live2D.lookAt).toHaveBeenLastCalledWith('char1', 1, 0, 0);
  });

  it('rebuilds character-target gaze during seek instead of resetting it straight ahead', async () => {
    live2D.hasCharacter.mockReturnValue(true);
    live2D.listCharacters.mockReturnValue(['char1']);
    live2D.getPoint.mockImplementation((id: string) =>
      id === 'char1' ? { x: 0.25, y: 0.5 } : id === 'anon' ? { x: 0.75, y: 0.35 } : null,
    );

    await synchronizer.syncTo({
      time: 1.5,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'm.model3.json',
        config: {},
        lookAt: { target: 'anon', point: [0, 0], enabled: true, startTime: 0, duration: 0.5 },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: true,
    });

    // anon sits right and slightly above char1 → gaze must point toward anon.
    const lastLookAt = live2D.lookAt.mock.lastCall as unknown[] | undefined;
    expect(lastLookAt?.[0]).toBe('char1');
    expect(lastLookAt?.[1]).toBeGreaterThan(0.5);
    expect(lastLookAt?.[2]).toBeGreaterThan(0);
  });

  it('freezes a target-follow seek on the resolved frame focus', async () => {
    live2D.hasCharacter.mockReturnValue(true);
    live2D.listCharacters.mockReturnValue(['char1']);

    await synchronizer.syncTo({
      time: 2,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'm.model3.json',
        config: {},
        lookAt: {
          target: 'anon',
          point: [0, 0],
          enabled: true,
          focus: [0.6, -0.2],
        },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: true,
    });

    expect(live2D.lookAt).toHaveBeenLastCalledWith('char1', 0.6, -0.2, 0);
  });

  it('keeps the manager receiver when consulting muscle getPoint for gaze targets', async () => {
    live2D.hasCharacter.mockReturnValue(true);
    live2D.listCharacters.mockReturnValue(['char1']);
    // Mimic Live2DManager.getPoint: a method that depends on `this`.
    const anchors = new Map([['char1', { x: 0.25, y: 0.5 }], ['anon', { x: 0.75, y: 0.35 }]]);
    (live2D as any).getPoint = function (this: { __anchors: Map<string, { x: number; y: number }> }, id: string) {
      if (!this || !(this.__anchors instanceof Map)) {
        throw new TypeError("Cannot read properties of undefined (reading 'characters')");
      }
      return this.__anchors.get(id) ?? null;
    };
    (live2D as any).__anchors = anchors;

    await synchronizer.syncTo({
      time: 1.5,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'm.model3.json',
        config: {},
        lookAt: { target: 'anon', enabled: true, startTime: 0, duration: 0.5 },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: true,
    });

    const lastLookAt = live2D.lookAt.mock.lastCall as unknown[] | undefined;
    expect(lastLookAt?.[0]).toBe('char1');
    expect(lastLookAt?.[1]).toBeGreaterThan(0.5);
    expect(lastLookAt?.[2]).toBeGreaterThan(0);
  });

  it('syncTo exits before Phase 3 state sync when cancellation lands during restore', async () => {
    const dummySnap = {
      params: new Float32Array(30),
      parts: new Float32Array(30),
    };
    snapshots.insert(0.5, new Map([['char1', dummySnap as any]]));
    live2D.listCharacters.mockReturnValue(['char1']);
    live2D.hasCharacter.mockReturnValue(true);

    const desiredChars = new Map([['char1', { id: 'char1', model: 'm.json', config: {} }]]);
    const proxies = new ProxyRegistry();

    let isCancelled = false;
    const shouldCancel = () => isCancelled;

    // Cancellation lands while the synchronous snapshot-restore pass runs.
    live2D.applySnapshot.mockImplementation(() => {
      isCancelled = true;
    });

    await synchronizer.syncTo({
      time: 1.5,
      desiredChars,
      transformationProxies: proxies,
      snapshotStore: snapshots,
      shouldCancel,
      skipHardReset: false,
      isScrubbing: false,
    });

    // The cancelled seek never reaches Phase 3 state sync (resetToIdle,
    // setExpression, ...).
    expect(live2D.resetToIdle).not.toHaveBeenCalled();
    expect(live2D.setExpression).not.toHaveBeenCalled();
  });

  it('syncTo applies timeline motion offsets while scrubbing without a prebaked snapshot', async () => {
    live2D.listCharacters.mockReturnValue(['char1']);
    live2D.hasCharacter.mockReturnValue(true);

    const desiredChars = new Map([['char1', {
      id: 'char1',
      model: 'm.model3.json',
      config: {},
      motion: { output: { kind: 'resource' as const, key: 'wave' }, priority: 4, time: 2.0 },
      expression: { key: 'smile' },
    }]]);
    const proxies = new ProxyRegistry();
    proxies.set('char1', { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 });

    await synchronizer.syncTo({
      time: 3.25,
      desiredChars,
      transformationProxies: proxies,
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: true,
    });

    expect(live2D.playMotion).toHaveBeenCalledWith('char1', 'wave', 4, 1.25, 3.25, true);
    expect(live2D.setExpression).toHaveBeenCalledWith('char1', 'smile');
    expect(live2D.updateAll).toHaveBeenCalledWith(0, true, 3250);
  });

  it('settles the latched expression after motion reconstruction', async () => {
    live2D.listCharacters.mockReturnValue(['char1']);
    live2D.hasCharacter.mockReturnValue(true);
    const order: string[] = [];
    live2D.playMotion.mockImplementation(() => { order.push('play'); });
    live2D.updateAll.mockImplementation(async () => { order.push('flush'); });
    const prepareExpressionForSeek = vi.fn(() => { order.push('prepare'); });
    const setExpressionForSeek = vi.fn(async () => { order.push('expression'); });
    (live2D as any).prepareExpressionForSeek = prepareExpressionForSeek;
    (live2D as any).setExpressionForSeek = setExpressionForSeek;

    await synchronizer.syncTo({
      time: 6.25,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'm.model.json',
        config: {},
        motion: { output: { kind: 'resource' as const, key: 'motion3' }, priority: 3, time: 5 },
        expression: { key: 'expression2', time: 3 },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: true,
    });

    expect(live2D.playMotion).toHaveBeenCalledWith('char1', 'motion3', 3, 1.25, 6.25, true);
    expect(prepareExpressionForSeek).toHaveBeenCalledWith('char1', 'expression2');
    expect(setExpressionForSeek).toHaveBeenCalledWith(
      'char1',
      'expression2',
      3.25,
      // No authored predecessor on a hand-built desired state: unknown, so the
      // adapter must not invent one.
      undefined,
    );
    expect(live2D.setExpression).not.toHaveBeenCalled();
    expect(order).toEqual(['prepare', 'play', 'flush', 'expression']);
  });

  it('starts the expression fade from the previous pose when a forward seek lands on its exact start time', async () => {
    live2D.listCharacters.mockReturnValue(['char1']);
    live2D.hasCharacter.mockReturnValue(true);
    const setExpressionForSeek = vi.fn().mockResolvedValue(undefined);
    (live2D as any).setExpressionForSeek = setExpressionForSeek;

    await synchronizer.syncTo({
      time: 3,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'm.model.json',
        config: {},
        expression: { key: 'expression2', time: 3 },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: true,
    });

    // Elapsed 0 reconstructs the fade-in weight at the expression's first
    // frame: the SDK keeps the previous expression pose and playback fades in
    // from there instead of snapping to the full expression.
    expect(setExpressionForSeek).toHaveBeenCalledWith(
      'char1',
      'expression2',
      0,
      undefined,
    );
  });

  it('reconstructs a mid-fade expression pose when a seek lands inside the fade window', async () => {
    live2D.listCharacters.mockReturnValue(['char1']);
    live2D.hasCharacter.mockReturnValue(true);
    const setExpressionForSeek = vi.fn().mockResolvedValue(undefined);
    (live2D as any).setExpressionForSeek = setExpressionForSeek;

    await synchronizer.syncTo({
      time: 3.2,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'm.model.json',
        config: {},
        expression: { key: 'expression2', time: 3 },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: true,
    });

    expect(setExpressionForSeek).toHaveBeenCalledWith(
      'char1',
      'expression2',
      expect.closeTo(0.2, 5),
      undefined,
    );
  });

  it('redraws the motion-controlled face when seeking before the first expression', async () => {
    live2D.listCharacters.mockReturnValue(['char1']);
    live2D.hasCharacter.mockReturnValue(true);
    const setExpressionForSeek = vi.fn().mockResolvedValue(undefined);
    (live2D as any).setExpressionForSeek = setExpressionForSeek;

    await synchronizer.syncTo({
      time: 0.5,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'm.model.json',
        config: {},
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: true,
    });

    expect(live2D.stopAllMotions).toHaveBeenCalledWith('char1');
    expect(setExpressionForSeek).toHaveBeenCalledWith('char1', null, Number.POSITIVE_INFINITY, undefined);
  });

  it('does not advance snapshot motion during a visible seek', async () => {
    const charSnap = {
      params: new Float32Array([1, 2, 3]),
      opacities: new Float32Array([1]),
      motion: { key: 'previous', startTime: 1 },
    };
    snapshots.insert(2, new Map([['char1', charSnap as any]]));
    live2D.listCharacters.mockReturnValue(['char1']);
    live2D.hasCharacter.mockReturnValue(true);

    await synchronizer.syncTo({
      time: 3.1,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'm.model.json',
        config: {},
        motion: { output: { kind: 'resource' as const, key: 'next' }, priority: 4, time: 3 },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: true,
      isScrubbing: false,
    });

    expect(live2D.applySnapshot).toHaveBeenCalledWith('char1', charSnap);
    expect(live2D.playMotion).toHaveBeenCalledTimes(1);
    expect(live2D.playMotion).toHaveBeenCalledWith('char1', 'next', 4, expect.closeTo(0.1), 3.1, true);
    expect(live2D.updateAll).toHaveBeenCalledTimes(1);
    expect(live2D.updateAll).toHaveBeenCalledWith(0, true, 3100);
  });

  it('uses preserve-current motion startup during a force-reconstruct seek', async () => {
    live2D.listCharacters.mockReturnValue(['char1']);
    live2D.hasCharacter.mockReturnValue(true);

    await synchronizer.syncTo({
      time: 10.1,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'm.model.json',
        config: {},
        motion: { output: { kind: 'resource' as const, key: 'cry02' }, priority: 3, time: 10 },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: true,
      isScrubbing: false,
    });

    expect(live2D.playMotion).toHaveBeenCalledWith('char1', 'cry02', 3, expect.closeTo(0.1), 10.1, true);
    expect(live2D.updateAll).toHaveBeenCalledWith(0, true, 10100);
  });

  it('releases a stale expression when seeking back to motion-controlled state', async () => {
    live2D.listCharacters.mockReturnValue(['char1']);
    live2D.hasCharacter.mockReturnValue(true);

    await synchronizer.syncTo({
      time: 10.003,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'm.model.json',
        config: {},
        motion: { output: { kind: 'resource' as const, key: 'cry02' }, priority: 3, time: 10 },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: true,
    });

    const playMotionCall = live2D.playMotion.mock.calls[0];
    expect(playMotionCall.slice(0, 3)).toEqual(['char1', 'cry02', 3]);
    expect(playMotionCall[3]).toBeCloseTo(0.003);
    expect(playMotionCall[4]).toBe(10.003);
    expect(playMotionCall[5]).toBe(true);
    expect(live2D.setExpression).toHaveBeenCalledWith('char1', '');
  });

  it('releases a stale expression during paused seek to motion-controlled state', async () => {
    live2D.listCharacters.mockReturnValue(['char1']);
    live2D.hasCharacter.mockReturnValue(true);

    await synchronizer.syncTo({
      time: 10,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'm.model.json',
        config: {},
        motion: { output: { kind: 'resource' as const, key: 'cry02' }, priority: 3, time: 10 },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: false,
    });

    expect(live2D.setExpression).toHaveBeenCalledWith('char1', '');
  });

  it('does not advance extra settle frames during paused seek to a motion boundary', async () => {
    live2D.listCharacters.mockReturnValue(['char1']);
    live2D.hasCharacter.mockReturnValue(true);

    await synchronizer.syncTo({
      time: 10,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'm.model.json',
        config: {},
        motion: { output: { kind: 'resource' as const, key: 'cry02' }, priority: 3, time: 10 },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: false,
    });

    expect(live2D.playMotion).toHaveBeenCalledWith('char1', 'cry02', 3, 0, 10, false);
    expect(live2D.updateAll).toHaveBeenCalledTimes(1);
    expect(live2D.updateAll).toHaveBeenCalledWith(0, true, 10000);
  });

  it.each([
    ['exactly on', 10, 0],
    ['just after', 10.005, 0.005],
  ])('keeps the handoff pose when seek lands %s a Cubism2 motion boundary', async (_label, seekTime, expectedOffset) => {
    const params = new Float32Array([1, 2, 3]);
    const opacities = new Float32Array([0.25, 0.75]);
    const motionManager = {
      playing: false,
      state: {
        currentGroup: undefined as string | undefined,
        reservedGroup: undefined as string | undefined,
      },
      _motionQueueManager: {
        stopAllMotions: vi.fn(),
      },
      loadMotion: vi.fn().mockResolvedValue(undefined),
      startMotion: vi.fn().mockImplementation(async (group: string) => {
        motionManager.state.currentGroup = group;
        motionManager.playing = true;
        return true;
      }),
      stopAllMotions: vi.fn(),
    };
    const model = {
      destroyed: false,
      x: 0,
      y: 0,
      rotation: 0,
      alpha: 1,
      scale: { x: 1, y: 1 },
      update: vi.fn((_dt?: number) => {
        params.set([0, 0, 0]);
        opacities.set([0, 0]);
      }),
      internalModel: {
        settings: {
          motions: {
            wave: [{}],
          },
        },
        motionManager,
        parameterValues: params,
        partOpacities: opacities,
        coreModel: {
          getParameterValues: () => params,
          getPartOpacities: () => opacities,
        },
      },
    };
    const entry: any = {
      id: 'char1',
      model,
      motionEpoch: 1,
      motionStartTime: 4,
      injectedParams: {},
    };
    const controller = new Live2DMotionController(
      new Map([['char1', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => ({ isReconstructing: true }),
    );
    const live2DWithRealMotion = {
      ...createMockLive2DManager(),
      listCharacters: vi.fn().mockReturnValue(['char1']),
      hasCharacter: vi.fn().mockReturnValue(true),
      getAllCharacters: vi.fn().mockReturnValue(new Map([['char1', entry]])),
      playMotion: vi.fn((id: string, key: string, priority: number, offset: number, time: number, skipHardReset: boolean) => {
        controller.playMotion(id, key, priority, offset, time, skipHardReset);
      }),
      updateAll: vi.fn(async (dt: number) => {
        if (entry._pendingPlayMotion) {
          const req = entry._pendingPlayMotion;
          entry._pendingPlayMotion = undefined;
          await controller.dispatchMotion('char1', req);
        }
        if (dt > 0) {
          model.update(dt);
        }
        if (entry.pendingSeekBoundarySnapshot) {
          const snap = entry.pendingSeekBoundarySnapshot;
          params.set(snap.params);
          opacities.set(snap.opacities);
        }
      }),
    };
    const sync = new CharacterSynchronizer(live2DWithRealMotion as any);

    await sync.syncTo({
      time: seekTime,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'm.model.json',
        config: {},
        motion: { output: { kind: 'resource' as const, key: 'wave' }, priority: 3, time: 10 },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: false,
    });

    const playMotionCall = live2DWithRealMotion.playMotion.mock.calls[0];
    expect(playMotionCall.slice(0, 3)).toEqual(['char1', 'wave', 3]);
    expect(playMotionCall[3]).toBeCloseTo(expectedOffset);
    expect(playMotionCall[4]).toBe(seekTime);
    expect(playMotionCall[5]).toBe(false);
    expect(Array.from(params)).toEqual([1, 2, 3]);
    expect(Array.from(opacities)).toEqual([0.25, 0.75]);
  });

  it('preserves the current Cubism2 pose when hot drag seek lands 0.1s into a new motion', async () => {
    let ut = 1000;
    (window as any).UtSystem = {
      getUserTimeMSec: vi.fn(() => ut),
      setUserTimeMSec: vi.fn((next: number) => { ut = next; }),
    };

    const params = new Float32Array([2, 3, 4]);
    const opacities = new Float32Array([0.25, 0.75]);
    const motionManager = {
      playing: false,
      state: {
        currentGroup: undefined as string | undefined,
        reservedGroup: undefined as string | undefined,
      },
      _motionQueueManager: {
        stopAllMotions: vi.fn(),
      },
      loadMotion: vi.fn().mockResolvedValue(undefined),
      startMotion: vi.fn().mockImplementation(async (group: string) => {
        motionManager.state.currentGroup = group;
        motionManager.playing = true;
        params.set([0, 0, 0]);
        opacities.set([0, 0]);
        return true;
      }),
      update: vi.fn(),
      stopAllMotions: vi.fn(),
    };
    const model = {
      destroyed: false,
      x: 0,
      y: 0,
      rotation: 0,
      alpha: 1,
      scale: { x: 1, y: 1 },
      update: vi.fn(),
      internalModel: {
        settings: {
          motions: {
            angry03: [{}],
            cry02: [{}],
          },
        },
        motionManager,
        parameterValues: params,
        partOpacities: opacities,
        coreModel: {
          getParameterValues: () => params,
          getPartOpacities: () => opacities,
        },
      },
    };
    const entry: any = {
      id: 'char1',
      model,
      motionEpoch: 1,
      motionStartTime: 9,
      injectedParams: {},
    };
    const controller = new Live2DMotionController(
      new Map([['char1', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => ({ isReconstructing: true }),
    );
    const live2DWithRealMotion = {
      ...createMockLive2DManager(),
      listCharacters: vi.fn().mockReturnValue(['char1']),
      hasCharacter: vi.fn().mockReturnValue(true),
      getAllCharacters: vi.fn().mockReturnValue(new Map([['char1', entry]])),
      captureSnapshot: vi.fn(() => ({
        params: new Float32Array(params),
        opacities: new Float32Array(opacities),
      })),
      playMotion: vi.fn((id: string, key: string, priority: number, offset: number, time: number, skipHardReset: boolean) => {
        controller.playMotion(id, key, priority, offset, time, skipHardReset);
      }),
      updateAll: vi.fn(async () => {
        if (entry._pendingPlayMotion) {
          const req = entry._pendingPlayMotion;
          entry._pendingPlayMotion = undefined;
          await controller.dispatchMotion('char1', req);
        }
      }),
    };
    const sync = new CharacterSynchronizer(live2DWithRealMotion as any);

    await sync.syncTo({
      time: 10.1,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'm.model.json',
        config: {},
        motion: { output: { kind: 'resource' as const, key: 'cry02' }, priority: 3, time: 10 },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: true,
    });

    expect(live2DWithRealMotion.playMotion).toHaveBeenCalledTimes(1);
    expect(live2DWithRealMotion.playMotion.mock.calls[0].slice(0, 3)).toEqual(['char1', 'cry02', 3]);
    expect(live2DWithRealMotion.playMotion.mock.calls[0][3]).toBeCloseTo(0.1);
    expect(Array.from(params)).toEqual([2, 3, 4]);
    expect(Array.from(opacities)).toEqual([0.25, 0.75]);
  });

  it('syncTo keeps raw seek offsets for single-shot resource motions', async () => {
    live2D.listCharacters.mockReturnValue(['char1']);
    live2D.hasCharacter.mockReturnValue(true);

    const desiredChars = new Map([['char1', {
      id: 'char1',
      model: 'm.model3.json',
      config: {},
      motion: { output: { kind: 'resource' as const, key: 'idle' }, priority: 3, time: 5 },
    }]]);

    await synchronizer.syncTo({
      time: 126.25,
      desiredChars,
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: true,
    });

    // v3 motions are single-shot: long seek offsets are not wrapped by a
    // loop duration (ADR-0029).
    expect(live2D.playMotion).toHaveBeenCalledWith('char1', 'idle', 3, 121.25, 126.25, true);
  });

  it('syncTo does not wrap offsets from a runtime motion duration', async () => {
    live2D.listCharacters.mockReturnValue(['char1']);
    live2D.hasCharacter.mockReturnValue(true);
    live2D.getMotionDuration.mockReturnValue(1.75);

    const desiredChars = new Map([['char1', {
      id: 'char1',
      model: 'm.model3.json',
      config: {},
      motion: { output: { kind: 'resource' as const, key: 'wave' }, priority: 4, time: 10 },
    }]]);

    await synchronizer.syncTo({
      time: 20.25,
      desiredChars,
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: true,
    });

    expect(live2D.playMotion).toHaveBeenCalledWith('char1', 'wave', 4, 10.25, 20.25, true);
  });

  it('does not stop official runtime motion during scrubbing before native seek restore', async () => {
    const charSnap = {
      params: new Float32Array(1),
      opacities: new Float32Array(1),
    };
    snapshots.insert(1, new Map([['char1', charSnap as any]]));
    live2D.listCharacters.mockReturnValue(['char1']);
    live2D.hasCharacter.mockReturnValue(true);
    live2D.getAllCharacters.mockReturnValue(new Map([[
      'char1',
      { runtime: { adapterId: 'untitled-pixi-live2d-engine-cubism' } },
    ]]));
    (live2D as any).restoreSeekState = vi.fn().mockResolvedValue(undefined);

    await synchronizer.syncTo({
      time: 1,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'm.model3.json',
        config: {},
        motion: { output: { kind: 'resource' as const, key: 'wave' }, priority: 3, time: 0.25 },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: true,
    });

    expect(live2D.stopAllMotions).not.toHaveBeenCalledWith('char1');
    expect((live2D as any).restoreSeekState).toHaveBeenCalledWith('char1', expect.objectContaining({
      targetSceneTime: 1,
      isScrubbing: true,
    }));
  });

  it('passes authored resource motion fade-in into official native seek restore', async () => {
    live2D.listCharacters.mockReturnValue(['char1']);
    live2D.hasCharacter.mockReturnValue(true);
    live2D.getAllCharacters.mockReturnValue(new Map([[
      'char1',
      { runtime: { adapterId: 'untitled-pixi-live2d-engine-cubism' } },
    ]]));
    (live2D as any).restoreSeekState = vi.fn().mockResolvedValue(undefined);

    await synchronizer.syncTo({
      time: 0.25,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'm.model3.json',
        config: {},
        motion: {
          output: { kind: 'resource' as const, key: 'wave', fadeInSeconds: 0.5 },
          priority: 3,
          time: 0,
        },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: false,
    });

    expect((live2D as any).restoreSeekState).toHaveBeenCalledWith('char1', expect.objectContaining({
      motion: expect.objectContaining({
        key: 'wave',
        offset: 0.25,
        fadeInSeconds: 0.5,
      }),
    }));
  });

  it('passes the previous action pose as the native motion fade-in handoff', async () => {
    const handoffSnapshot = {
      params: new Float32Array([12]),
      opacities: new Float32Array([1]),
      motion: { key: 'previous', startTime: -1 },
    };
    snapshots.insert(0, new Map([['char1', handoffSnapshot as any]]));
    live2D.listCharacters.mockReturnValue(['char1']);
    live2D.hasCharacter.mockReturnValue(true);
    live2D.getAllCharacters.mockReturnValue(new Map([[
      'char1',
      { runtime: { adapterId: 'untitled-pixi-live2d-engine-cubism' } },
    ]]));
    (live2D as any).restoreSeekState = vi.fn().mockResolvedValue(undefined);

    await synchronizer.syncTo({
      time: 0.25,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'm.model3.json',
        config: {},
        motion: {
          output: { kind: 'resource' as const, key: 'next', fadeInSeconds: 0.5 },
          priority: 3,
          time: 0,
        },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: false,
    });

    expect((live2D as any).restoreSeekState).toHaveBeenCalledWith('char1', expect.objectContaining({
      handoffSnapshot,
    }));
  });

  it.each([0.2, 1])('reconstructs the native handoff at the action boundary from a snapshot at %s', async (snapshotTime) => {
    const oldSnapshot = {
      params: new Float32Array([2]),
      opacities: new Float32Array([1]),
      motion: snapshotTime === 1
        ? { key: 'next', startTime: 1 }
        : { key: 'previous', startTime: 0 },
    };
    const boundaryPose = { params: new Float32Array([10]), opacities: new Float32Array([1]) };
    snapshots.insert(snapshotTime, new Map([['char1', oldSnapshot as any]]));
    live2D.listCharacters.mockReturnValue(['char1']);
    live2D.hasCharacter.mockReturnValue(true);
    live2D.getAllCharacters.mockReturnValue(new Map([['char1', {
      runtime: { adapterId: 'untitled-pixi-live2d-engine-cubism' },
    }]]));
    let renderedParameter = 2;
    (live2D as any).restoreSeekState = vi.fn(async (_id: string, restore: any) => {
      if (restore.motion?.key === 'previous') renderedParameter = 10;
      if (restore.motion?.key === 'next') {
        const source = restore.handoffSnapshot?.params[0] ?? 0;
        const progress = restore.motion.offset / restore.motion.fadeInSeconds;
        renderedParameter = source * (1 - Math.sin(Math.PI * progress / 2));
      }
    });
    live2D.captureSnapshot.mockImplementation(() => ({
      ...boundaryPose,
      params: new Float32Array([renderedParameter]),
    }));

    await synchronizer.syncTo({
      time: 1.25,
      desiredChars: new Map([['char1', {
        id: 'char1', model: 'm.model3.json', config: {},
        motion: { output: { kind: 'resource' as const, key: 'next', fadeInSeconds: 0.5 }, time: 1 },
      }]]),
      resolveStateAtTime: () => new Map([['char1', {
        id: 'char1', model: 'm.model3.json', config: {},
        motion: { output: { kind: 'resource' as const, key: 'previous' }, time: 0 },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: false,
    });

    expect((live2D as any).restoreSeekState).toHaveBeenNthCalledWith(1, 'char1', expect.objectContaining({
      targetSceneTime: 1,
      motion: expect.objectContaining({ key: 'previous', offset: 1 }),
    }));
    expect((live2D as any).restoreSeekState).toHaveBeenNthCalledWith(2, 'char1', expect.objectContaining({
      targetSceneTime: 1.25,
      handoffSnapshot: expect.objectContaining({ params: new Float32Array([10]) }),
      motion: expect.objectContaining({ key: 'next', offset: 0.25 }),
    }));
    expect(renderedParameter).toBeCloseTo(10 * (1 - Math.SQRT1_2), 5);
  });
});
