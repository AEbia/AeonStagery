import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SnapshotStore } from '../engine/SnapshotStore';
import { SCENE_SCHEMA_VERSION, type PreparedCompiledScene } from '../api/types/semantic-scene';

const mocks = vi.hoisted(() => ({
  bakePreparedRange: vi.fn(),
  cancel: vi.fn(),
  destroy: vi.fn(),
  getApp: vi.fn(() => ({ renderer: {} })),
}));

vi.mock('../engine/BakeEngine', () => ({
  BakeEngine: vi.fn(function BakeEngineMock(this: any) {
    this.bakePreparedRange = mocks.bakePreparedRange;
    this.cancel = mocks.cancel;
    this.destroy = mocks.destroy;
  }),
}));

vi.mock('../engine/StageManager', () => ({
  stageManager: {
    getApp: mocks.getApp,
  },
}));

vi.mock('../ui/SettingsStore', () => ({
  settingsManager: {
    get: vi.fn((key: string) => {
      const values: Record<string, number | boolean> = {
        preBakeEnabled: true,
        preBakeDebounce: 1,
        preBakeHotRadius: 1,
        preBakeWarmRadius: 2,
        preBakeHotPrecision: 0.5,
        preBakeWarmPrecision: 1,
        preBakeColdPrecision: 2,
        snapshotMaxCount: 5000,
      };
      return values[key];
    }),
  },
}));

function createScene(): PreparedCompiledScene {
  return {
    kind: 'prepared-compiled-scene',
    sourceSchemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'mixed-runtime',
    meta: {
      title: 'Mixed Runtime PreBake',
      characters: [
        { id: 'cubism2', name: 'Cubism 2', model: 'figure/soyo/model.json' },
        { id: 'cubism5', name: 'Cubism 5', model: 'figure/rana/rana.model3.json' },
      ],
    },
    durationSeconds: 6,
    actions: [
      {
        id: 'compiled:cubism2',
        time: 0,
        action: 'addCharacter',
        params: {
          id: 'cubism2',
          model: {
            source: '@mount/game/figure/soyo/model.json',
            runtimeUri: 'asset://localhost/E:/Library/game/figure/soyo/model.json',
          },
        },
        source: { statementId: 'stmt-cubism2', outputKey: 'primary' },
      },
      {
        id: 'compiled:cubism5',
        time: 0,
        action: 'addCharacter',
        params: {
          id: 'cubism5',
          model: {
            source: '@mount/game/figure/rana/rana.model3.json',
            runtimeUri: 'asset://localhost/E:/Library/game/figure/rana/rana.model3.json',
          },
        },
        source: { statementId: 'stmt-cubism5', outputKey: 'primary' },
      },
      {
        id: 'compiled:motion',
        time: 4,
        action: 'playMotion',
        params: { id: 'cubism5', motion: 'idle', duration: 2, loop: true },
        source: { statementId: 'stmt-motion', outputKey: 'motion' },
      },
    ],
  };
}

describe('PreBakeDaemon', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    mocks.bakePreparedRange.mockReset();
    mocks.cancel.mockReset();
    mocks.destroy.mockReset();
    mocks.getApp.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('continues queued mixed-runtime tasks after a bake failure and resets to idle', async () => {
    const { PreBakeDaemon } = await import('../engine/daemons/PreBakeDaemon');
    const daemon = new PreBakeDaemon();
    const store = new SnapshotStore();
    const scene = createScene();

    mocks.bakePreparedRange
      .mockRejectedValueOnce(new Error('cubism5 render failed'))
      .mockResolvedValueOnce({
        snapshotHistory: [
          {
            time: 2,
            models: new Map([['cubism5', { params: new Float32Array([0.5]), opacities: new Float32Array([1]) }]]),
          },
        ],
      });

    daemon.attach(store, scene);
    (daemon as any).taskQueue = [
      { priority: 'hot', rangeStart: 0, rangeEnd: 2, precision: 0.5 },
      { priority: 'warm', rangeStart: 2, rangeEnd: 4, precision: 1 },
    ];

    (daemon as any).ensureProcessing();
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.bakePreparedRange).toHaveBeenCalledTimes(2);
    expect(mocks.bakePreparedRange).toHaveBeenNthCalledWith(
      1,
      scene,
      expect.any(Map),
      expect.any(Number),
      0,
      2,
      0.5,
      undefined,
      true,
    );
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
    expect((daemon as any).state).toBe('idle');
    expect((daemon as any).taskQueue).toEqual([]);

    daemon.dispose();
  });

  it('coalesces repeated process requests into a single active bake loop', async () => {
    const { PreBakeDaemon } = await import('../engine/daemons/PreBakeDaemon');
    const daemon = new PreBakeDaemon();
    const store = new SnapshotStore();
    const scene = createScene();
    let resolveBake: ((value: unknown) => void) = () => {};

    mocks.bakePreparedRange.mockReturnValue(new Promise((resolve) => {
      resolveBake = resolve;
    }));

    daemon.attach(store, scene);
    (daemon as any).taskQueue = [
      { priority: 'hot', rangeStart: 0, rangeEnd: 2, precision: 0.5 },
    ];

    (daemon as any).ensureProcessing();
    (daemon as any).ensureProcessing();
    await Promise.resolve();

    expect(mocks.bakePreparedRange).toHaveBeenCalledTimes(1);

    resolveBake({ snapshotHistory: [] });
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect((daemon as any).state).toBe('idle');
    daemon.dispose();
  });

  it('keeps background baking suspended while a seek is in progress', async () => {
    const { eventBus } = await import('../api/events');
    const { PreBakeDaemon } = await import('../engine/daemons/PreBakeDaemon');
    const daemon = new PreBakeDaemon();
    const store = new SnapshotStore();
    const scene = createScene();

    mocks.bakePreparedRange.mockResolvedValue({ snapshotHistory: [] });
    daemon.attach(store, scene);
    eventBus.emit('scene:seek:start', { time: 2 });
    eventBus.emit('scene:pause');

    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();

    expect(mocks.bakePreparedRange).not.toHaveBeenCalled();

    eventBus.emit('scene:seek:end', { time: 2 });
    daemon.notifyEditPosition(2);
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();

    expect(mocks.bakePreparedRange).toHaveBeenCalled();
    daemon.dispose();
  });
});
