import { describe, expect, it, vi } from 'vitest';
import type { CharacterMotionOutput } from '../api/types/semantic-scene';
import * as runtimeAdapter from '../engine/Live2DRuntimeAdapter';
import { mockAdapter, mockControls } from './helpers/mockLive2DRuntimeAdapter';

/**
 * 用户关注点回归：启用了口型同步的对话与同一角色的自定义 Motion 重叠时，
 * 角色必须仍然张嘴 —— 自定义 Motion 不得阻止或覆盖口型通道的嘴巴参数。
 *
 * ADR-0029 stage separation：口型在独立效果通道运行，自定义 Motion 只在
 * Motion 求值阶段工作；嘴巴参数的胜负由通道所有权决定，而不是执行时序。
 * 本文件在 Live2DManager.updateAll 层面组合整条管线，验证：
 *   A. legacy 路径（无 emitter seam 的 runtime，如 untitled-pixi-live2d-engine-cubism）——
 *      口型活动期间 Motion 的嘴巴轨道被跳过，口型值存活；
 *   B. legacy 路径——口型结束后 Motion 重新接管嘴巴（stage handoff）；
 *   C. Motion 舞台路径——安装阶段口型已在活动，舞台不写嘴巴；
 *   D. Motion 舞台路径——口型在 Motion 播放中途启动（live Set 变异），
 *      嘴巴立即开口并持续赢过 Motion 曲线。
 */
vi.mock('../engine/Live2DMotionController', () => ({
  Live2DMotionController: class {
    dispatchMotion() {
      return Promise.resolve();
    }

    _hardReset() {
      return Promise.resolve();
    }

    stopAllCharacterTweens() {}
    pauseAllTweens() {}
    resumeAllTweens() {}
    resetModel() {}
    setScriptEngine() {}
  },
}));

/** 含嘴巴轨道的自定义 Motion：PARAM_MOUTH_OPEN_Y 恒 0.1，PARAM_ANGLE_X 30→0。 */
function createMouthOwnedMotion(): Extract<CharacterMotionOutput, { kind: 'custom' }> {
  return {
    kind: 'custom',
    durationSeconds: 3,
    fadeInSeconds: 0,
    derivedFrom: { key: 'talk' },
    tracks: [
      {
        parameterId: 'PARAM_MOUTH_OPEN_Y',
        keyframes: [
          { time: 0, value: 0.1 },
          { time: 2, value: 0.1 },
        ],
      },
      {
        parameterId: 'PARAM_ANGLE_X',
        keyframes: [
          { time: 0, value: 30 },
          { time: 2, value: 0 },
        ],
      },
    ],
  };
}

/** 模拟 pixi-live2d-display InternalModel：可订阅 afterMotionUpdate + 可写 Cubism 2 core。 */
function createStageCapableModel(initial: Record<string, number>) {
  const names = Object.keys(initial);
  const values: Record<string, number> = { ...initial };
  const listeners = new Map<string, Set<() => void>>();
  const internalModel: any = {
    on: (event: string, handler: () => void) => {
      (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(handler);
    },
    off: (event: string, handler: () => void) => {
      listeners.get(event)?.delete(handler);
    },
    emit: (event: string) => {
      listeners.get(event)?.forEach((handler) => handler());
    },
    coreModel: {
      getParamIndex: (name: string) => names.indexOf(name),
      setParamFloat: (index: number, value: number) => {
        if (index >= 0 && index < names.length) values[names[index]!] = value;
      },
    },
  };
  const model: any = {
    internalModel,
    update: vi.fn(() => internalModel.emit('afterMotionUpdate')),
  };
  return { model, internalModel, values };
}

function makeAdapterCoreControls(overrides: Record<string, unknown>) {
  // The stage installer lives inside the runtime adapter; delegate to the real
  // cubism2 controls so the emitter-seam model gets a working stage handle.
  const realControls = runtimeAdapter.cubism2Live2DAdapter.getControls();
  // The manager's updateAll advances via controls.advanceFrame; drive the
  // model update so the afterMotionUpdate emitter fires (ADR-0029 stage).
  const advanceFrame = (model: any, deltaMs: number) => {
    if (model && typeof model.update === 'function') {
      model.update(deltaMs);
    }
  };
  return mockControls({
    installCustomMotionStage: (...args: any[]) => realControls.installCustomMotionStage(...(args as [any, any])),
    advanceFrame,
    ...overrides,
  });
}

function makeManager(entry: any, controls: any) {
  return (async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    const spy = vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue(
      mockAdapter({
        id: 'pixi-live2d-display-cubism2',
        getControls: () => controls,
      }) as any,
    );
    (manager as any).characters = new Map([['char1', entry]]);
    (manager as any).motionController = {
      dispatchMotion: vi.fn(),
      _hardReset: vi.fn(async () => {}),
      stopAllCharacterTweens: vi.fn(),
      setScriptEngine: vi.fn(),
    };
    return { manager, spy };
  })();
}

function makeCustomMotionState(entry: any) {
  return {
    id: 'char1',
    model: entry.model,
    injectedParams: {},
    config: {},
    motionEpoch: 0,
    lipSyncParameterIds: new Set<string>(),
    ...entry,
  };
}

describe('custom motion vs active lip sync (mouth must keep opening)', () => {
  it('legacy path: does not overwrite or release the lip-sync mouth value while overlap', async () => {
    const setInjectedParameter = vi.fn();
    const controls = makeAdapterCoreControls({ setInjectedParameter });
    const model = { update: vi.fn() }; // no emitter seam → installCustomMotionStage returns null → legacy path
    const entry = makeCustomMotionState({
      model,
      injectedParams: { PARAM_MOUTH_OPEN_Y: 0.6, ParamMouthOpenY: 0.6 },
      lipSyncParameterIds: new Set(['PARAM_MOUTH_OPEN_Y', 'ParamMouthOpenY']),
      customMotion: {
        motion: createMouthOwnedMotion(),
        startSceneTime: 0,
        controlledParameterIds: ['PARAM_MOUTH_OPEN_Y', 'PARAM_ANGLE_X'],
      },
      customMotionHandoff: { values: {} },
    });
    const { manager } = await makeManager(entry, controls);

    await manager.updateAll(16, true, 1000);

    // 口型值存活，Motion 的嘴巴曲线（0.1）没有覆盖它；身体轨道正常写入。
    expect(entry.injectedParams.PARAM_MOUTH_OPEN_Y).toBe(0.6);
    expect(entry.injectedParams.PARAM_ANGLE_X).toBe(15); // 30→0 @ 1.0s
    expect(setInjectedParameter).toHaveBeenCalledWith(model, 'PARAM_MOUTH_OPEN_Y', 0.6);
    expect(setInjectedParameter).not.toHaveBeenCalledWith(model, 'PARAM_MOUTH_OPEN_Y', 0.1);
    expect(entry.customMotionStage).toBeNull();
  });

  it('legacy path: after lip sync ends the motion re-owns the mouth (stage handoff)', async () => {
    const setInjectedParameter = vi.fn();
    const controls = makeAdapterCoreControls({ setInjectedParameter });
    const model = { update: vi.fn() };
    const entry = makeCustomMotionState({
      model,
      injectedParams: { PARAM_MOUTH_OPEN_Y: 0, ParamMouthOpenY: 0 }, // closeMouthAndRelease 后的收尾 0
      lipSyncParameterIds: new Set(['PARAM_MOUTH_OPEN_Y', 'ParamMouthOpenY']),
      customMotion: {
        motion: createMouthOwnedMotion(),
        startSceneTime: 0,
        controlledParameterIds: ['PARAM_MOUTH_OPEN_Y', 'PARAM_ANGLE_X'],
      },
      customMotionHandoff: { values: {} },
    });
    const { manager } = await makeManager(entry, controls);

    // 真实生命周期：通道释放（closeMouthAndRelease → clearLipSyncParameters）
    manager.setLipSyncParameter('char1', 'PARAM_MOUTH_OPEN_Y', 0); //（模拟在帧外写入收尾 0）
    manager.setLipSyncParameter('char1', 'ParamMouthOpenY', 0);
    manager.clearLipSyncParameters('char1');

    await manager.updateAll(16, true, 1000);

    // 通道已释放：Motion 现在可以（并且会）接管嘴巴。
    expect(setInjectedParameter).toHaveBeenCalledWith(model, 'PARAM_MOUTH_OPEN_Y', 0.1);
    expect(setInjectedParameter).toHaveBeenCalledWith(model, 'PARAM_ANGLE_X', 15);
  });

  it('stage path: mouth already owned by lip sync when the motion installs — stage never writes it', async () => {
    const { model, values } = createStageCapableModel({
      PARAM_ANGLE_X: 0,
      PARAM_MOUTH_OPEN_Y: 2,
      ParamMouthOpenY: 2,
    });
    const setInjectedParameter = vi.fn((_m: any, name: string, value: number) => {
      const index = model.internalModel.coreModel.getParamIndex(name);
      model.internalModel.coreModel.setParamFloat(index, value);
    });
    const controls = makeAdapterCoreControls({ setInjectedParameter });
    const entry = makeCustomMotionState({
      model,
      injectedParams: { PARAM_MOUTH_OPEN_Y: 0.6, ParamMouthOpenY: 0.6 },
      lipSyncParameterIds: new Set(['PARAM_MOUTH_OPEN_Y', 'ParamMouthOpenY']),
      customMotion: {
        motion: createMouthOwnedMotion(),
        startSceneTime: 0,
        controlledParameterIds: ['PARAM_MOUTH_OPEN_Y', 'PARAM_ANGLE_X'],
      },
      customMotionHandoff: { values: {} },
    });
    const { manager } = await makeManager(entry, controls);

    await manager.updateAll(16, true, 1000); // 安装舞台 → model.update → afterMotionUpdate

    expect(entry.customMotionStage).not.toBeNull(); // 真走了舞台路径
    expect(values.PARAM_ANGLE_X).toBe(15); // 舞台写了身体轨道
    expect(values.PARAM_MOUTH_OPEN_Y).toBe(0.6); // 舞台没写嘴巴；口型重注入后保持开口
  });

  it('stage path: lip sync starting mid-motion opens the mouth and stays the winner', async () => {
    const { model, values } = createStageCapableModel({
      PARAM_ANGLE_X: 0,
      PARAM_MOUTH_OPEN_Y: 0,
      ParamMouthOpenY: 0,
    });
    const setInjectedParameter = vi.fn((_m: any, name: string, value: number) => {
      const index = model.internalModel.coreModel.getParamIndex(name);
      model.internalModel.coreModel.setParamFloat(index, value);
    });
    const controls = makeAdapterCoreControls({ setInjectedParameter });
    const entry = makeCustomMotionState({
      model,
      injectedParams: {},
      lipSyncParameterIds: new Set<string>(), // 口型尚未启动
      customMotion: {
        motion: createMouthOwnedMotion(),
        startSceneTime: 0,
        controlledParameterIds: ['PARAM_MOUTH_OPEN_Y', 'PARAM_ANGLE_X'],
      },
      customMotionHandoff: { values: {} },
    });
    const { manager } = await makeManager(entry, controls);

    // 第一阶段：只有 Motion 在播 —— 嘴巴被 Motion 曲线压着（0.1）。
    await manager.updateAll(16, true, 1000);
    expect(values.PARAM_MOUTH_OPEN_Y).toBe(0.1);

    // 第二阶段：对话口型同步启动（同一角色）—— 注册嘴巴通道。
    manager.setLipSyncParameter('char1', 'PARAM_MOUTH_OPEN_Y', 0.6);
    manager.setLipSyncParameter('char1', 'ParamMouthOpenY', 0.6);

    // 下一帧：设备 Stage 的 live Set 已包含嘴巴 → 舞台跳过嘴巴轨道，
    // 帧末重注入把口型值 0.6 写回 —— 角色张嘴，Motion 不再把它按回 0.1。
    await manager.updateAll(16, true, 1000);
    expect(values.PARAM_MOUTH_OPEN_Y).toBe(0.6);
    expect(values.PARAM_ANGLE_X).toBe(15); // Motion 身体轨道持续驱动
  });

  it('stage path: lip sync ending mid-motion hands the mouth back to the motion curve (ADR-0029 stage handoff)', async () => {
    const { model, values } = createStageCapableModel({
      PARAM_ANGLE_X: 0,
      PARAM_MOUTH_OPEN_Y: 0,
      ParamMouthOpenY: 0,
    });
    const setInjectedParameter = vi.fn((_m: any, name: string, value: number) => {
      const index = model.internalModel.coreModel.getParamIndex(name);
      model.internalModel.coreModel.setParamFloat(index, value);
    });
    const controls = makeAdapterCoreControls({ setInjectedParameter });
    const entry = makeCustomMotionState({
      model,
      injectedParams: { PARAM_MOUTH_OPEN_Y: 0, ParamMouthOpenY: 0 }, // closeMouthAndRelease 的收尾 0
      lipSyncParameterIds: new Set(['PARAM_MOUTH_OPEN_Y', 'ParamMouthOpenY']),
      customMotion: {
        motion: createMouthOwnedMotion(),
        startSceneTime: 0,
        controlledParameterIds: ['PARAM_MOUTH_OPEN_Y', 'PARAM_ANGLE_X'],
      },
      customMotionHandoff: { values: {} },
    });
    const { manager } = await makeManager(entry, controls);

    // 口型活动期间：嘴巴被口型通道压住（0）。
    await manager.updateAll(16, true, 1000);
    expect(values.PARAM_MOUTH_OPEN_Y).toBe(0);
    expect(entry.customMotionStage).not.toBeNull();

    // 对话结束：通道释放（closeMouthAndRelease → clearLipSyncParameters）。
    manager.clearLipSyncParameters('char1');

    // 下一帧：收尾 0 先落一帧（settle），随后参数从 injectedParams 移交——
    // 不再每帧重写，舞台的嘴巴曲线从下一帧起真正接管。
    await manager.updateAll(16, true, 1000);
    expect(values.PARAM_MOUTH_OPEN_Y).toBe(0);

    await manager.updateAll(16, true, 1000);
    expect(values.PARAM_MOUTH_OPEN_Y).toBe(0.1);
    expect(values.PARAM_ANGLE_X).toBe(15);
  });
});