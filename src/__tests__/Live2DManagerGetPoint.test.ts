import { describe, expect, it, vi, afterEach } from 'vitest';
import * as PIXI from 'pixi.js';
import gsap from 'gsap';
import { Live2DCompositeModel } from '../engine/Live2DCompositeModel';
import { mockAdapter, mockControls } from './helpers/mockLive2DRuntimeAdapter';

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

describe('Live2DManager.getPoint', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prefers model hit areas for the head anchor when available', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    vi.spyOn(manager, 'init').mockResolvedValue();

    const entry = {
      id: 'soyo',
      model: {
        getBounds: () => ({ x: 192, y: 108, width: 960, height: 540 }),
        internalModel: {
          settings: {
            layout: {
              center_x: 0,
              center_y: -0.16,
              width: 1.8,
            },
            hit_areas_custom: {
              head_x: [-0.35, 0.6],
              head_y: [0.19, -0.2],
            },
          },
          focusController: {
            x: 0.5,
            y: -0.25,
          },
        },
      },
    } as any;

    (manager as any).characters = new Map([['soyo', entry]]);

    const point = manager.getPoint('soyo', 'head');

    const localX = 0.5 + (((( -0.35 + 0.6) / 2) - 0) / 1.8);
    const localY = 0.5 - ((((0.19 + -0.2) / 2) - (-0.16)) / 1.8);

    expect(point).toBeTruthy();
    expect(point!.x).toBeCloseTo((192 + 960 * localX) / 1920, 6);
    expect(point!.y).toBeCloseTo((108 + 540 * localY) / 1080, 6);
  });

  it('falls back to bounds when hit areas are unavailable', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();

    const entry = {
      id: 'soyo',
      model: {
        getBounds: () => ({ x: 200, y: 120, width: 800, height: 400 }),
        internalModel: {},
      },
    } as any;

    (manager as any).characters = new Map([['soyo', entry]]);

    const point = manager.getPoint('soyo', 'head');

    expect(point).toBeTruthy();
    expect(point!.x).toBeCloseTo((200 + 800 * 0.5) / 1920, 6);
    expect(point!.y).toBeCloseTo((120 + 400 * 0.18) / 1080, 6);
  });

  it('returns each semantic bounds anchor and supports a caller-owned output object', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    const entry = {
      id: 'soyo',
      model: {
        getBounds: () => ({ x: 100, y: 200, width: 1000, height: 800 }),
        internalModel: {},
      },
    } as any;
    (manager as any).characters = new Map([['soyo', entry]]);

    const out = { x: 0, y: 0 };
    expect(manager.getPoint('soyo', 'head', out)).toBe(out);
    expect(out).toEqual({
      x: (100 + 1000 * 0.5) / 1920,
      y: (200 + 800 * 0.18) / 1080,
    });
    expect(manager.getPoint('soyo', 'chest')!.y).toBeCloseTo((200 + 800 * 0.42) / 1080, 6);
    expect(manager.getPoint('soyo', 'center')!.y).toBeCloseTo((200 + 800 * 0.5) / 1080, 6);
    expect(manager.getPoint('soyo', 'feet')!.y).toBeCloseTo((200 + 800 * 0.95) / 1080, 6);
  });

  it('uses the head sub-model and main model as composite semantic anchors', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    const headModel = {
      getBounds: () => ({ x: 300, y: 100, width: 200, height: 300 }),
    };
    const mainModel = {
      getBounds: () => ({ x: 500, y: 200, width: 600, height: 700 }),
    };
    const composite = Object.create(Live2DCompositeModel.prototype);
    composite.mainModel = mainModel;
    composite.subModels = [headModel];
    (manager as any).characters = new Map([['soyo', { id: 'soyo', model: composite }]]);

    expect(manager.getPoint('soyo', 'head')).toEqual({
      x: (300 + 200 * 0.5) / 1920,
      y: (100 + 300 * 0.18) / 1080,
    });
    expect(manager.getPoint('soyo', 'chest')).toEqual({
      x: (500 + 600 * 0.5) / 1920,
      y: (200 + 700 * 0.42) / 1080,
    });
  });

  it('falls back to transformation proxies when model bounds are invalid and returns null for an unknown character', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    (manager as any).characters = new Map([[
      'soyo',
      {
        id: 'soyo',
        model: { getBounds: () => ({ x: 0, y: 0, width: 0, height: 100 }) },
      },
    ]]);
    (manager as any)._scriptEngine = {
      transformationProxies: new Map([['soyo', { x: 960, y: 900, scale: 1.5 }]]),
    };

    expect(manager.getPoint('soyo', 'head')).toEqual({
      x: 0.5,
      y: 900 / 1080 - 0.6 * 1.5,
    });
    expect(manager.getPoint('missing', 'center')).toBeNull();
  });

  it('propagates lookAt to composite sub-models', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();

    const createFocusController = () => ({
      focus: vi.fn(),
      x: 0,
      y: 0,
      targetX: 0,
      targetY: 0,
      faceX: 0,
      faceY: 0,
      faceTargetX: 0,
      faceTargetY: 0,
      _x: 0,
      _y: 0,
      _targetX: 0,
      _targetY: 0,
    });

    const mainFocus = createFocusController();
    const subFocusA = createFocusController();
    const subFocusB = createFocusController();

    const composite = Object.create(Live2DCompositeModel.prototype);
    composite.internalModel = { focusController: mainFocus };
    composite.mainModel = { internalModel: { focusController: mainFocus } };
    composite.subModels = [
      { internalModel: { focusController: subFocusA } },
      { internalModel: { focusController: subFocusB } },
    ];

    (manager as any).characters = new Map([['soyo', { id: 'soyo', model: composite }]]);

    manager.lookAt('soyo', 0.25, -0.4, 0);

    expect(mainFocus.focus).toHaveBeenCalledWith(0.25, -0.4);
    expect(subFocusA.focus).toHaveBeenCalledWith(0.25, -0.4);
    expect(subFocusB.focus).toHaveBeenCalledWith(0.25, -0.4);
  });

  it('does not replace sub-model natural movement hooks', async () => {
    const { Live2DCompositeModel } = await import('../engine/Live2DCompositeModel');

    const mainModel = new PIXI.Container() as any;
    mainModel.name = 'main';
    mainModel.internalModel = {};
    const naturalMovement = vi.fn();
    const subModel = new PIXI.Container() as any;
    subModel.internalModel = {
      focusController: { update: vi.fn(), focus: vi.fn() },
      eyeBlink: { update: vi.fn() },
      updateNaturalMovements: naturalMovement,
      coreModel: { loadParam: vi.fn() },
    };

    new Live2DCompositeModel(mainModel, [subModel]);

    expect(subModel.internalModel.updateNaturalMovements).toBe(naturalMovement);
  });

  it('keeps AlphaFilter as the opacity guard during character filter warmup', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    const container = new PIXI.Container();
    const model = new PIXI.Container() as any;
    const alphaFilter = { alpha: 1, padding: 50 } as any;
    const entry = {
      id: 'soyo',
      model,
      config: {},
      baseHeight: 1000,
      filterWarmupFrames: 6,
    } as any;

    (manager as any).characters = new Map([['soyo', entry]]);
    (container as any)._alphaFilter = alphaFilter;
    container.filters = [alphaFilter];
    vi.spyOn(manager, 'getContainer').mockReturnValue(container);

    manager.applyProxyTransform('soyo', {
      x: 960,
      y: 540,
      scale: 1,
      rotation: 0,
      opacity: 0,
      z: 0,
    });

    expect(alphaFilter).toBeTruthy();
    expect(container.filters).toContain(alphaFilter);
    expect(alphaFilter.alpha).toBe(0);
    expect(container.renderable).toBe(false);
    expect(model.alpha).toBe(1);

    manager.applyProxyTransform('soyo', {
      x: 960,
      y: 540,
      scale: 1,
      rotation: 0,
      opacity: 0.5,
      z: 0,
    });

    expect(container.filters).toContain(alphaFilter);
    expect(alphaFilter.alpha).toBeCloseTo(0.5);
    expect(container.renderable).toBe(true);
    expect(model.alpha).toBe(1);
  });

  it('keeps independent models aligned when their intrinsic heights differ', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    const firstContainer = new PIXI.Container();
    const secondContainer = new PIXI.Container();
    const firstModel = new PIXI.Container() as any;
    const secondModel = new PIXI.Container() as any;
    const firstEntry = {
      id: 'soyo',
      model: firstModel,
      config: {},
      baseHeight: 1000,
      baseWidth: 580,
    } as any;
    const secondEntry = {
      id: 'soyo',
      model: secondModel,
      config: {},
      baseHeight: 1600,
      baseWidth: 700,
    } as any;
    (manager as any).characters = new Map([
      ['main', { ...firstEntry, id: 'main' }],
      ['variant', { ...secondEntry, id: 'variant' }],
    ]);
    (manager as any).containers = new Map([
      ['main', firstContainer],
      ['variant', secondContainer],
    ]);
    manager.currentCamera = { position: { x: 0.2, y: 0.35 }, zoom: 1.25 };

    const proxy = { x: 960, y: 820, scale: 1.1, rotation: 0, opacity: 1, z: 0 };
    manager.applyProxyTransform('main', proxy);
    manager.applyProxyTransform('variant', proxy);

    expect(secondContainer.x).toBeCloseTo(firstContainer.x);
    expect(secondContainer.y).toBeCloseTo(firstContainer.y);
    expect(secondModel.scale.y * 1600).toBeCloseTo(firstModel.scale.y * 1000);
  });

  it('preserves sub-model motion output after update', async () => {
    const { Live2DCompositeModel } = await import('../engine/Live2DCompositeModel');

    const createCore = (initial = 0) => {
      const values = new Map<string, number>([
        ['PARAM_ANGLE_X', initial],
        ['PARAM_ANGLE_Y', initial],
        ['PARAM_BODY_ANGLE_X', initial],
        ['PARAM_BODY_ANGLE_Y', initial],
        ['PARAM_BODY_ANGLE_Z', initial],
      ]);
      return {
        gl: true,
        update: vi.fn(),
        loadParam: vi.fn(),
        getParamIndex: (name: string) => values.has(name) ? name : -1,
        getParamFloat: (name: string) => values.get(name) ?? 0,
        setParamFloat: (name: string, value: number) => values.set(name, value),
      };
    };

    const mainCore = createCore(0.1);
    const subCore = createCore(0);
    const mainModel = new PIXI.Container() as any;
    mainModel.name = 'main';
    mainModel.internalModel = { coreModel: mainCore, focusController: { focus: vi.fn() } };
    mainModel.update = vi.fn();

    const subModel = new PIXI.Container() as any;
    subModel.internalModel = {
      coreModel: subCore,
      gl: true,
      focusController: { update: vi.fn(), focus: vi.fn() },
      eyeBlink: { update: vi.fn() },
      updateNaturalMovements: vi.fn(),
    };
    subModel.update = vi.fn(() => {
      subCore.setParamFloat('PARAM_ANGLE_X', 0.75);
    });

    const composite = new Live2DCompositeModel(mainModel, [subModel]);
    composite.update(16);

    expect(subCore.getParamFloat('PARAM_ANGLE_X')).toBeCloseTo(0.75);
  });

  it('waits for repair before returning from force updates when a model update creates NaN parameters', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();

    const params = new Float32Array([0, 0]);
    const opacities = new Float32Array([1]);
    const model = {
      internalModel: {
        coreModel: {
          getParameterValues: () => params,
          getPartOpacities: () => opacities,
        },
      },
      update: vi.fn(() => {
        params[0] = Number.NaN;
      }),
    } as any;
    const entry = {
      id: 'soyo',
      model,
      injectedParams: {},
      config: {},
      motionEpoch: 0,
    } as any;
    const hardReset = vi.fn(async () => {
      params[0] = 0;
    });

    (manager as any).characters = new Map([['soyo', entry]]);
    (manager as any).motionController = {
      dispatchMotion: vi.fn(),
      _hardReset: hardReset,
    };

    await manager.updateAll(16, true, 1000);

    expect(hardReset).toHaveBeenCalledWith('soyo', model);
    expect(entry.isCorrupted).toBe(false);
    expect(params[0]).toBe(0);
  });

  it('does not repair when Cubism exposes non-numeric opacity metadata', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();

    const params = new Float32Array([0, 0]);
    const model = {
      internalModel: {
        partOpacities: ['PARAM_ANGLE_X'],
        coreModel: {
          getParameterValues: () => params,
        },
      },
      update: vi.fn(),
    } as any;
    const entry = {
      id: 'soyo',
      model,
      injectedParams: {},
      config: {},
      motionEpoch: 0,
    } as any;
    const hardReset = vi.fn(async () => {});

    (manager as any).characters = new Map([['soyo', entry]]);
    (manager as any).motionController = {
      dispatchMotion: vi.fn(),
      _hardReset: hardReset,
    };

    await manager.updateAll(16, true, 1000);

    expect(hardReset).not.toHaveBeenCalled();
    expect(entry.isCorrupted).not.toBe(true);
  });

  it('re-applies injected params through the character runtime adapter during updateAll', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const runtimeAdapter = await import('../engine/Live2DRuntimeAdapter');
    const manager = new Live2DManager();

    const setInjectedParameter = vi.fn();
    const syncInputParameters = vi.fn();
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue(mockAdapter({
      id: 'untitled-pixi-live2d-engine-cubism',
      getControls: () => mockControls({
        setInjectedParameter,
        syncInputParameters,
      }),
    }) as any);

    const model = { update: vi.fn(), internalModel: { coreModel: {} } } as any;
    const entry = {
      id: 'rana',
      model,
      runtime: {
        runtimeFamily: 'cubism3-plus',
        adapterId: 'untitled-pixi-live2d-engine-cubism',
        supported: true,
      },
      injectedParams: { PARAM_MOUTH_OPEN_Y: 0.6 },
      config: {},
      motionEpoch: 0,
    } as any;

    (manager as any).characters = new Map([['rana', entry]]);
    (manager as any).motionController = {
      dispatchMotion: vi.fn(),
      _hardReset: vi.fn(async () => {}),
    };

    await manager.updateAll(16, true, 1000);

    expect(setInjectedParameter).toHaveBeenCalledWith(model, 'PARAM_MOUTH_OPEN_Y', 0.6);
    expect(syncInputParameters).toHaveBeenCalledWith(model);
  });

  it('advances mixed Cubism runtimes by the Pixi ticker delta in milliseconds', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const runtimeAdapter = await import('../engine/Live2DRuntimeAdapter');
    const manager = new Live2DManager();

    const cubism2AdvanceFrame = vi.fn();
    const cubism5AdvanceFrame = vi.fn();
    const cubism2Controls = mockControls({ advanceFrame: cubism2AdvanceFrame });
    const cubism5Controls = mockControls({ advanceFrame: cubism5AdvanceFrame });
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockImplementation((runtime) => (
      runtime?.adapterId === 'untitled-pixi-live2d-engine-cubism'
        ? mockAdapter({ id: 'untitled-pixi-live2d-engine-cubism', getControls: () => cubism5Controls })
        : mockAdapter({ getControls: () => cubism2Controls })
    ) as any);

    let cubism2ClockMs = 1_000;
    vi.spyOn(runtimeAdapter.cubism2Live2DAdapter, 'getClock').mockReturnValue({
      getUserTimeMSec: () => cubism2ClockMs,
      setUserTimeMSec: (value: number) => { cubism2ClockMs = value; },
    });

    const createEntry = (id: string, adapterId: string, runtimeFamily: string) => ({
      id,
      model: { internalModel: { coreModel: {} } },
      runtime: { adapterId, runtimeFamily, supported: true },
      injectedParams: {},
      config: {},
      motionEpoch: 0,
    });
    const cubism2Model = createEntry('soyo', 'pixi-live2d-display-cubism2', 'cubism2');
    const cubism5Model = createEntry('rana', 'untitled-pixi-live2d-engine-cubism', 'cubism3-plus');
    (manager as any).characters = new Map([
      ['soyo', cubism2Model],
      ['rana', cubism5Model],
    ]);
    (manager as any).motionController = {
      dispatchMotion: vi.fn(),
      _hardReset: vi.fn(async () => {}),
    };

    await manager.updateAll(16.666);

    expect(cubism2AdvanceFrame).toHaveBeenCalledWith(cubism2Model.model, 16.666);
    expect(cubism5AdvanceFrame).toHaveBeenCalledWith(cubism5Model.model, 16.666);
    expect(cubism2ClockMs).toBeCloseTo(1_016.666, 6);
  });

  it('skips ordinary ticker updates while the global UtSystem lock is active but allows force updates', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const { acquireUtSystemLock, releaseUtSystemLock } = await import('../engine/Live2DConfig');
    const manager = new Live2DManager();
    const model = {
      update: vi.fn(),
      internalModel: {
        coreModel: {
          getParameterValues: () => new Float32Array([0]),
          getPartOpacities: () => new Float32Array([1]),
        },
      },
    } as any;
    const entry = {
      id: 'soyo',
      model,
      injectedParams: {},
      config: {},
      motionEpoch: 0,
    } as any;
    (manager as any).characters = new Map([['soyo', entry]]);
    (manager as any).motionController = {
      dispatchMotion: vi.fn(),
      _hardReset: vi.fn(async () => {}),
    };

    await acquireUtSystemLock();
    try {
      await manager.updateAll(1);
      expect(model.update).not.toHaveBeenCalled();

      await manager.updateAll(16, true, 1000);
      expect(model.update).toHaveBeenCalledWith(16);
    } finally {
      releaseUtSystemLock();
    }
  });

  it('keeps the official Cubism Web model updating while Cubism 2 owns the global clock lock', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const runtimeAdapter = await import('../engine/Live2DRuntimeAdapter');
    const { acquireUtSystemLock, releaseUtSystemLock } = await import('../engine/Live2DConfig');
    const manager = new Live2DManager();

    const cubism2AdvanceFrame = vi.fn();
    const cubism5AdvanceFrame = vi.fn();
    const cubism2Controls = mockControls({ advanceFrame: cubism2AdvanceFrame });
    const cubism5Controls = mockControls({ advanceFrame: cubism5AdvanceFrame });
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockImplementation((runtime) => (
      runtime?.adapterId === 'untitled-pixi-live2d-engine-cubism'
        ? mockAdapter({ id: 'untitled-pixi-live2d-engine-cubism', getControls: () => cubism5Controls })
        : mockAdapter({ getControls: () => cubism2Controls })
    ) as any);

    const createEntry = (id: string, adapterId: string, runtimeFamily: string) => ({
      id,
      model: { internalModel: { coreModel: {} } },
      runtime: { adapterId, runtimeFamily, supported: true },
      injectedParams: {},
      config: {},
      motionEpoch: 0,
    });
    const cubism2Model = createEntry('soyo', 'pixi-live2d-display-cubism2', 'cubism2') as any;
    const cubism5Model = createEntry('rana', 'untitled-pixi-live2d-engine-cubism', 'cubism3-plus');
    cubism2Model._pendingPlayMotion = {
      key: 'wave',
      priority: 3,
      offset: 0,
      sceneTime: 1,
      skipHardReset: false,
      reqEpoch: 1,
    };
    (manager as any).characters = new Map([
      ['soyo', cubism2Model],
      ['rana', cubism5Model],
    ]);
    const dispatchMotion = vi.fn(async () => {});
    (manager as any).motionController = {
      dispatchMotion,
      _hardReset: vi.fn(async () => {}),
    };

    await acquireUtSystemLock();
    try {
      await manager.updateAll(16);
    } finally {
      releaseUtSystemLock();
    }

    expect(cubism2AdvanceFrame).not.toHaveBeenCalled();
    expect(cubism5AdvanceFrame).toHaveBeenCalledWith(cubism5Model.model, 16);
    expect(cubism2Model._pendingPlayMotion).toBeDefined();

    await manager.updateAll(0, true);
    expect(dispatchMotion).toHaveBeenCalledWith('soyo', expect.objectContaining({ key: 'wave' }));
  });

  it('flushes pending motions without stepping the model when updateAll receives zero dt', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    const model = {
      update: vi.fn(),
      internalModel: {
        coreModel: {
          getParameterValues: () => new Float32Array([0]),
          getPartOpacities: () => new Float32Array([1]),
        },
      },
    } as any;
    const entry = {
      id: 'soyo',
      model,
      injectedParams: {},
      config: {},
      motionEpoch: 0,
      _pendingPlayMotion: { key: 'cry02', priority: 3, offset: 0, sceneTime: 10, skipHardReset: false, reqEpoch: 1 },
    } as any;
    const dispatchMotion = vi.fn(async () => {});
    (manager as any).characters = new Map([['soyo', entry]]);
    (manager as any).motionController = {
      dispatchMotion,
      _hardReset: vi.fn(async () => {}),
    };

    await manager.updateAll(0, true, 10000);

    expect(dispatchMotion).toHaveBeenCalledWith('soyo', expect.objectContaining({ key: 'cry02' }));
    expect(model.update).not.toHaveBeenCalled();
  });

  it('exposes parameter metadata through the runtime adapter seam', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const runtimeAdapter = await import('../engine/Live2DRuntimeAdapter');
    const manager = new Live2DManager();
    const model = {};
    let metadata: any = [{
      id: 'PARAM_ARM_R',
      index: 0,
      min: -1,
      max: 1,
      defaultValue: 0,
      source: 'runtime',
    }];
    const adapterSpy = vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue(mockAdapter({
      id: 'untitled-pixi-live2d-engine-cubism',
      getControls: () => mockControls({
        getParameterValues: () => [{ index: 2, name: 'PARAM_FALLBACK', value: 0.25 }],
        getParameterMetadata: () => metadata,
      }),
    }) as any);

    try {
      (manager as any).characters = new Map([['rana', {
        id: 'rana',
        model,
        runtime: {
          runtimeFamily: 'cubism3-plus',
          adapterId: 'untitled-pixi-live2d-engine-cubism',
          supported: true,
        },
        injectedParams: {},
        config: {},
        motionEpoch: 0,
      }]]);

      const first = manager.getParameterMetadata('rana');
      expect(first).toEqual(metadata);
      expect(first).not.toBe(metadata);
      (first as any)[0].id = 'MUTATED';
      expect(manager.getParameterMetadata('rana')[0].id).toBe('PARAM_ARM_R');

      metadata = null;
      expect(manager.getParameterMetadata('rana')).toEqual([{
        id: 'PARAM_FALLBACK',
        index: 2,
        defaultValue: 0.25,
        source: 'runtime',
      }]);
      expect(manager.getParameterMetadata('missing')).toEqual([]);
    } finally {
      adapterSpy.mockRestore();
    }
  });

  it('lookAt starts a duration-controlled transition from the provided from-focus', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    vi.spyOn(manager, 'init').mockResolvedValue();

    const fc = {
      focus: vi.fn(),
      update: vi.fn(),
      x: 0,
      y: 0,
      targetX: 0,
      targetY: 0,
      vx: 0,
      vy: 0,
    };
    const entry = {
      id: 'soyo',
      model: { internalModel: { focusController: fc } },
    } as any;
    (manager as any).characters = new Map([['soyo', entry]]);

    manager.lookAt('soyo', 0.25, -0.4, 1, { fromX: 0, fromY: 0, elapsed: 0.5 });

    // The current focus must already be the eased midpoint, not the final gaze.
    expect(fc.targetX).toBeCloseTo(0.25);
    expect(fc.targetY).toBeCloseTo(-0.4);
    expect(fc.x).toBeGreaterThan(0);
    expect(fc.x).toBeLessThan(0.25);
    expect(fc.y).toBeLessThan(0);
    expect(fc.y).toBeGreaterThan(-0.4);
    // The tween must own interpolation instead of the fixed-speed integrator.
    const originalUpdate = (fc as any).__aeonOriginalFocusUpdate;
    expect(originalUpdate).toBeTypeOf('function');
    expect(originalUpdate).not.toHaveBeenCalled();
    expect(fc.update).not.toBe(originalUpdate);
    expect(gsap.getTweensOf(fc as any).length).toBeGreaterThan(0);
  });

  it('lookAt with zero duration applies the final focus immediately', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    vi.spyOn(manager, 'init').mockResolvedValue();

    const fc = {
      focus: vi.fn(),
      update: vi.fn(),
      x: 0,
      y: 0,
      targetX: 0,
      targetY: 0,
      vx: 0,
      vy: 0,
    };
    const entry = {
      id: 'soyo',
      model: { internalModel: { focusController: fc } },
    } as any;
    (manager as any).characters = new Map([['soyo', entry]]);

    manager.lookAt('soyo', 0.25, -0.4, 0);

    expect(fc.x).toBeCloseTo(0.25);
    expect(fc.y).toBeCloseTo(-0.4);
    expect(fc.targetX).toBeCloseTo(0.25);
    expect(fc.targetY).toBeCloseTo(-0.4);
  });

  it('syncLookAtFollows applies current target-follow focus during playback frames', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    vi.spyOn(manager, 'init').mockResolvedValue();

    const fc = {
      focus: vi.fn(),
      update: vi.fn(),
      x: 0,
      y: 0,
      targetX: 0,
      targetY: 0,
      vx: 0,
      vy: 0,
    };
    const entry = {
      id: 'self',
      model: { internalModel: { focusController: fc } },
    } as any;
    (manager as any).characters = new Map([['self', entry]]);

    (manager as any).syncLookAtFollows(
      new Map([['self', { lookAt: { target: 'target', focus: [1, 0] } }]]),
    );

    expect(fc.x).toBeCloseTo(1);
    expect(fc.y).toBeCloseTo(0);
    expect(fc.targetX).toBeCloseTo(1);
    expect(fc.targetY).toBeCloseTo(0);
  });
});
