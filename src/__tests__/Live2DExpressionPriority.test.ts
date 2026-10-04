import { beforeEach, describe, expect, it, vi } from 'vitest';
import Live2DManager from '../engine/Live2DManager';

function createCharacter() {
  const expressionState = { current: null as string | null };
  const motionManager: any = {
    playing: false,
    state: {
      currentGroup: undefined,
      reservedGroup: undefined,
      queue: [],
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
    stopAllMotions: vi.fn(() => {
      motionManager.state.currentGroup = undefined;
      motionManager.playing = false;
    }),
  };

  const model: any = {
    destroyed: false,
    x: 0,
    y: 0,
    rotation: 0,
    alpha: 1,
    scale: { x: 1, y: 1 },
    expression: vi.fn((name: string | null) => {
      expressionState.current = name;
    }),
    update: vi.fn(),
    internalModel: {
      settings: { motions: { wave: [{}], wave2: [{}] } },
      motionManager,
      expressionManager: {
        stopAllExpressions: vi.fn(() => {
          expressionState.current = null;
        }),
      },
      parameterValues: new Float32Array([0]),
      partOpacities: new Float32Array([1]),
      coreModel: {
        getParamIndex: vi.fn(() => -1),
        getParameterValues: () => model.internalModel.parameterValues,
        getPartOpacities: () => model.internalModel.partOpacities,
      },
    },
  };

  return { model, expressionState };
}

describe('Live2D expression priority', () => {
  beforeEach(() => {
    (globalThis as any).window = {
      UtSystem: {
        getUserTimeMSec: vi.fn(() => 1000),
        setUserTimeMSec: vi.fn(),
      },
    };
  });

  it('keeps the expression over every motion started at the same time', async () => {
    const manager = new Live2DManager();
    const { model, expressionState } = createCharacter();
    const entry: any = {
      id: 'hero',
      model,
      runtime: {
        runtimeFamily: 'cubism2',
        adapterId: 'pixi-live2d-display-cubism2',
        supported: true,
      },
      config: {},
      injectedParams: {},
      motionEpoch: 0,
    };
    (manager as any).characters = new Map([['hero', entry]]);

    manager.playMotion('hero', 'wave', 3, 0, 1);
    manager.setExpression('hero', 'smile');
    await manager.updateAll(16);
    await manager.waitForAllLoaded();
    expect(expressionState.current).toBe('smile');

    manager.playMotion('hero', 'wave2', 3, 0, 2);
    manager.setExpression('hero', 'angry');
    await manager.updateAll(16);
    await manager.waitForAllLoaded();
    expect(expressionState.current).toBe('angry');
  });

  it('does not restore an expression after a same-time explicit reset', async () => {
    const manager = new Live2DManager();
    const { model, expressionState } = createCharacter();
    const entry: any = {
      id: 'hero',
      model,
      runtime: {
        runtimeFamily: 'cubism2',
        adapterId: 'pixi-live2d-display-cubism2',
        supported: true,
      },
      config: {},
      injectedParams: {},
      motionEpoch: 0,
    };
    (manager as any).characters = new Map([['hero', entry]]);

    manager.setExpression('hero', 'smile');
    manager.playMotion('hero', 'wave', 3, 0, 1);
    manager.setExpression('hero', null);
    await manager.updateAll(16);
    await manager.waitForAllLoaded();

    expect(expressionState.current).toBeNull();
  });

  it('does not restore an expression after resetToIdle before a motion', async () => {
    const manager = new Live2DManager();
    const { model, expressionState } = createCharacter();
    const entry: any = {
      id: 'hero',
      model,
      runtime: {
        runtimeFamily: 'cubism2',
        adapterId: 'pixi-live2d-display-cubism2',
        supported: true,
      },
      config: {},
      injectedParams: {},
      motionEpoch: 0,
    };
    (manager as any).characters = new Map([['hero', entry]]);

    manager.setExpression('hero', 'smile');
    manager.resetToIdle('hero');
    manager.playMotion('hero', 'wave', 3, 0, 1);
    await manager.updateAll(16);
    await manager.waitForAllLoaded();

    expect(expressionState.current).toBeNull();
  });
});
