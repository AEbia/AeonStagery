import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CharacterSynchronizer } from '../engine/coordinators/CharacterSynchronizer';
import { SnapshotStore } from '../engine/SnapshotStore';
import { ProxyRegistry } from '../engine/coordinators/ProxyRegistry';
import { evaluateCustomMotionRuntime } from '../engine/live2d/customMotionRuntime';

if (typeof window === 'undefined') {
  (global as any).window = {};
}

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

function createCustomMotion(fadeInSeconds = 0.5) {
  return {
    kind: 'custom' as const,
    durationSeconds: 3,
    fadeInSeconds,
    derivedFrom: { key: 'smile01' },
    tracks: [
      {
        parameterId: 'Angle X',
        keyframes: [
          { time: 0, value: 30 },
          { time: 1, value: 0 },
        ],
      },
    ],
  };
}

function createCubism2Model(params: Float32Array, names: string[]) {
  return {
    internalModel: {
      settings: { parameters: names.map((name) => ({ name })) },
      coreModel: { getParameterValues: () => params },
    },
  };
}

function createPlayingCubism2Model(params: Float32Array, names: string[]) {
  const stopAllMotions = vi.fn();
  const stopQueuedMotions = vi.fn();
  const model = createCubism2Model(params, names) as any;
  model.internalModel.motionManager = {
    stopAllMotions,
    _motionQueueManager: { stopAllMotions: stopQueuedMotions },
    state: {
      currentGroup: 'smile01',
      reservedGroup: 'smile01',
      queue: ['smile01'],
    },
  };
  return { model, stopAllMotions, stopQueuedMotions };
}

function createSnapshot(paramsValue: number): any {
  return {
    params: new Float32Array([paramsValue]),
    opacities: new Float32Array([1]),
  };
}

describe('Live2D custom motion fade-in handoff (root cause fix)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('restores the motion-start snapshot when seeking into the fade-in window, so the handoff is the predecessor pose instead of a curve value', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    const params = new Float32Array([10]); // 模型当前姿态（动作起点姿态）
    const model = createCubism2Model(params, ['Angle X']);
    const entry: any = { id: 'char1', model, injectedParams: {}, lipSyncParameterIds: new Set() };
    (manager as any).characters = new Map([['char1', entry]]);

    // 快照库：动作起点快照（time=5, 起点姿态 10）与动作内烘焙快照（time=5.03, 曲线值 30）
    const startSnapshot = createSnapshot(10);
    const inMotionSnapshot = createSnapshot(30);
    const snapshots = new SnapshotStore();
    snapshots.insert(5, new Map([['char1', startSnapshot]]));
    snapshots.insert(5.03, new Map([['char1', inMotionSnapshot]]));

    const live2D = {
      ...createMockLive2DManager(),
      listCharacters: vi.fn().mockReturnValue(['char1']),
      hasCharacter: vi.fn().mockReturnValue(true),
      getAllCharacters: vi.fn().mockReturnValue(new Map([['char1', entry]])),
      applySnapshot: vi.fn((_id: string, snap: any) => {
        params.set(snap.params);
      }),
      updateAll: vi.fn(async (dt: number) => {
        // Real reconstruction can advance the resource motion after restoring
        // the motion-start snapshot. Reproduce that target-time curve pose so
        // the custom handoff cannot accidentally capture it as its fade source.
        if (dt > 0) params.fill(30);
      }),
      playCustomMotion: vi.fn((id: string, motion: any, sceneTime: number, handoffSnapshot?: any) =>
        manager.playCustomMotion(id, motion, sceneTime, handoffSnapshot),
      ),
    };
    const sync = new CharacterSynchronizer(live2D as any);

    // seek 到动作起点后 0.05s：落在淡入窗口内（fadeIn 0.5s）
    await sync.syncTo({
      time: 5.05,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'm.model.json',
        config: {},
        motion: { output: createCustomMotion(), priority: 3, time: 5 },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: false,
    });

    // 画面仍恢复目标时间快照；只有淡入交接显式使用动作起点快照，
    // 避免连带回退其它未被自定义动作控制的参数。
    expect(live2D.applySnapshot).toHaveBeenCalledWith('char1', inMotionSnapshot);
    expect(live2D.playCustomMotion).toHaveBeenCalledWith(
      'char1',
      expect.objectContaining({ kind: 'custom' }),
      5,
      startSnapshot,
    );

    // 交接姿态 = 起点姿态 10，而不是曲线值 30 → 淡入混合存在过渡
    expect(entry.customMotionHandoff?.values['Angle X']).toBe(10);

    const evaluation = evaluateCustomMotionRuntime(createCustomMotion(), 5, 5.05, entry.customMotionHandoff);
    expect(evaluation.fadingIn).toBe(true);
    expect(evaluation.values['Angle X']).not.toBe(30);
    expect(evaluation.values['Angle X']).toBeGreaterThan(10);
    expect(evaluation.values['Angle X']).toBeLessThan(30);
  });

  it('keeps the target-time snapshot restore when seeking outside the fade-in window', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    const params = new Float32Array([10]);
    const model = createCubism2Model(params, ['Angle X']);
    const entry: any = { id: 'char1', model, injectedParams: {}, lipSyncParameterIds: new Set() };
    (manager as any).characters = new Map([['char1', entry]]);

    const startSnapshot = createSnapshot(10);
    const inMotionSnapshot = createSnapshot(30);
    const snapshots = new SnapshotStore();
    snapshots.insert(5, new Map([['char1', startSnapshot]]));
    snapshots.insert(5.5, new Map([['char1', inMotionSnapshot]]));

    const live2D = {
      ...createMockLive2DManager(),
      listCharacters: vi.fn().mockReturnValue(['char1']),
      hasCharacter: vi.fn().mockReturnValue(true),
      getAllCharacters: vi.fn().mockReturnValue(new Map([['char1', entry]])),
      applySnapshot: vi.fn((_id: string, snap: any) => {
        params.set(snap.params);
      }),
      playCustomMotion: vi.fn((id: string, motion: any, sceneTime: number, handoffSnapshot?: any) =>
        manager.playCustomMotion(id, motion, sceneTime, handoffSnapshot),
      ),
    };
    const sync = new CharacterSynchronizer(live2D as any);

    // seek 到起点后 1s：淡入窗口（0.5s）已过，直接用目标时间快照恢复
    await sync.syncTo({
      time: 6,
      desiredChars: new Map([['char1', {
        id: 'char1',
        model: 'm.model.json',
        config: {},
        motion: { output: createCustomMotion(), priority: 3, time: 5 },
      }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: snapshots,
      shouldCancel: () => false,
      skipHardReset: false,
      isScrubbing: false,
    });

    expect(live2D.applySnapshot).toHaveBeenCalledWith('char1', inMotionSnapshot);
  });

  it('re-captures the handoff on every normal play, so a polluted pose never persists into later plays', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    const params = new Float32Array([10]);
    const model = createCubism2Model(params, ['Angle X']);
    const entry: any = { id: 'char1', model, injectedParams: {}, lipSyncParameterIds: new Set() };
    (manager as any).characters = new Map([['char1', entry]]);

    // 模型处于曲线值姿态（如一次失败 seek 留下的状态）时发生了捕获
    params.fill(30);
    manager.playCustomMotion('char1', createCustomMotion(), 5);
    expect(entry.customMotionHandoff?.values['Angle X']).toBe(30);

    // 正常播放：模型处于动作前姿态，重新捕获 → 污染值被覆盖，不再传染
    params.fill(10);
    manager.playCustomMotion('char1', createCustomMotion(), 5);
    expect(entry.customMotionHandoff?.values['Angle X']).toBe(10);
  });

  it('stops the previous resource motion and invalidates queued starts before custom control begins', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    const params = new Float32Array([10]);
    const { model, stopAllMotions, stopQueuedMotions } = createPlayingCubism2Model(params, ['Angle X']);
    const pending = {
      key: 'smile01',
      priority: 3,
      offset: 0,
      sceneTime: 5,
      skipHardReset: false,
      reqEpoch: 4,
    };
    const entry: any = {
      id: 'char1',
      model,
      injectedParams: {},
      lipSyncParameterIds: new Set(),
      motionEpoch: 4,
      _pendingPlayMotion: pending,
      pendingSeekBoundarySnapshot: { params: new Float32Array([10]), opacities: new Float32Array([1]) },
      pendingSeekBoundaryMotionStartTime: 4.8,
      pendingSeekBoundaryDuration: 0.5,
    };
    (manager as any).characters = new Map([['char1', entry]]);

    manager.playCustomMotion('char1', createCustomMotion(), 5);

    expect(stopAllMotions).toHaveBeenCalledOnce();
    expect(stopQueuedMotions).toHaveBeenCalledOnce();
    expect(model.internalModel.motionManager.state).toEqual({
      currentGroup: undefined,
      reservedGroup: undefined,
      queue: [],
    });
    expect(entry._pendingPlayMotion).toBeUndefined();
    expect(entry.motionEpoch).toBe(5);
    expect(entry.pendingSeekBoundarySnapshot).toBeUndefined();
    expect(entry.pendingSeekBoundaryMotionStartTime).toBeUndefined();
    expect(entry.pendingSeekBoundaryDuration).toBeUndefined();
    expect(entry.customMotionHandoff?.values['Angle X']).toBe(10);
  });

  it('restores uncovered parameters to the idle baseline and re-applies the handoff on takeover', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    const params = new Float32Array([10, 20]); // [Angle X (covered), Eye Open (uncovered)]
    const opacities = new Float32Array([0.9]);
    const model = {
      internalModel: {
        settings: { parameters: [{ name: 'Angle X' }, { name: 'Eye Open' }] },
        coreModel: {
          getParameterValues: () => params,
          getPartOpacities: () => opacities,
          getParamIndex: (name: string) => (name === 'Angle X' ? 0 : name === 'Eye Open' ? 1 : -1),
          setParamFloat: (index: number, value: number) => { params[index] = value; },
        },
      },
    };
    const entry: any = {
      id: 'char1',
      model,
      injectedParams: {},
      lipSyncParameterIds: new Set(),
      motionEpoch: 0,
      idleSnapshot: { params: new Float32Array([0, 0]), opacities: new Float32Array([1]) },
    };
    (manager as any).characters = new Map([['char1', entry]]);

    manager.playCustomMotion('char1', createCustomMotion(), 5);

    // 交接姿态来自接管前模型姿态（Angle X = 10）
    expect(entry.customMotionHandoff?.values['Angle X']).toBe(10);
    // 已覆盖参数立即写回交接姿态，避免中间帧闪现 idle
    expect(params[0]).toBe(10);
    // 未覆盖参数恢复 idle 基线，而不是停留在前一动作的姿态上
    expect(params[1]).toBe(0);
    expect(opacities[0]).toBe(1);
  });

  it('releases the custom motion when seek stops or resets the model outside the motion', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const { Live2DMotionController } = await vi.importActual<typeof import('../engine/Live2DMotionController')>('../engine/Live2DMotionController');
    const manager = new Live2DManager();
    const params = new Float32Array([10]);
    const model = createCubism2Model(params, ['Angle X']);
    const entry: any = { id: 'char1', model, injectedParams: {}, lipSyncParameterIds: new Set() };
    (manager as any).characters = new Map([['char1', entry]]);
    (manager as any).motionController = new Live2DMotionController(
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

    manager.playCustomMotion('char1', createCustomMotion(), 5);
    expect(entry.customMotionHandoff?.values['Angle X']).toBe(10);

    // 暂停拖动到无动作区域时会走 stopAllMotions：旧曲线不能继续注入。
    manager.stopAllMotions('char1');
    expect(entry.customMotion).toBeUndefined();
    expect(entry.customMotionHandoff).toBeUndefined();

    // 完整重建到无动作区域时会归位 idle，同样必须释放旧曲线。
    manager.playCustomMotion('char1', createCustomMotion(), 5);
    expect(entry.customMotionHandoff?.values['Angle X']).toBe(10);
    manager.resetToIdle('char1');
    expect(entry.customMotion).toBeUndefined();
    expect(entry.customMotionHandoff).toBeUndefined();
  });

  it('captures Cubism 2 handoff values by parameter id when model settings have no parameter table', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    let sceneTime = 5;
    const params = new Float32Array([10]);
    const modelContext = {
      _$qo: 1,
      _$_2: params,
      _$pb: [{ id: 'Angle X' }],
    };
    const model: any = {
      internalModel: {
        settings: {},
        coreModel: {
          getModelContext: () => modelContext,
          getParamIndex: (name: string) => name === 'Angle X' ? 0 : -1,
          setParamFloat: (index: number, value: number) => { params[index] = value; },
        },
      },
      update: vi.fn(),
      syncInputParameters: vi.fn(),
    };
    const entry: any = {
      id: 'char1',
      model,
      injectedParams: {},
      lipSyncParameterIds: new Set(),
      idleSnapshot: { params: new Float32Array([10]), opacities: new Float32Array([1]) },
    };
    (manager as any).characters = new Map([['char1', entry]]);
    (manager as any)._scriptEngine = { getCurrentTime: () => sceneTime };

    const motion = createCustomMotion(1);
    motion.tracks[0].keyframes[0].value = 30;
    manager.playCustomMotion('char1', motion, 5);

    sceneTime = 5.1;
    await manager.updateAll(0, true);

    expect(entry.customMotionHandoff?.values['Angle X']).toBe(10);
    expect(params[0]).toBeGreaterThan(10);
    expect(params[0]).toBeLessThan(30);
  });
});
