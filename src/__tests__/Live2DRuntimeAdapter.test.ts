import { afterEach, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import {
  Cubism2PixiLive2DModelControls,
  Cubism2PixiLive2DAdapter,
  getLive2DRuntimeAdapter,
  CubismPixiLive2DAdapter,
} from '../engine/Live2DRuntimeAdapter';
import { createLive2DModelHandle } from '../engine/live2d/runtime/Live2DRuntimeControlModule';
import { Cubism2BakeRenderCore } from '../engine/live2d/runtime/Cubism2BakeRenderCore';
import * as sdk from '../engine/CubismPixiSdk';
import { setLive2DCubism2RuntimeAvailable } from '../engine/Live2DRuntimeResolver';
import { createCubismPixiModel } from '../engine/CubismPixiModel';
import { applyRenderHook } from '../engine/Live2DModelSetup';

vi.mock('../engine/CubismPixiModel', () => ({
  createCubismPixiModel: vi.fn(async (modelUrl: string) => ({ modelUrl, internalModel: { coreModel: {}, settings: { motions: {}, expressions: {} } } })),
}));
vi.mock('../engine/Live2DEngineBridge', () => ({
  loadCubismEngineModule: vi.fn(async () => ({ Live2DModel: {}, config: {} })),
  loadLive2DEngineModule: vi.fn(),
}));

describe('Live2DRuntimeAdapter', () => {
  afterEach(() => {
    setLive2DCubism2RuntimeAvailable(true);
  });

  it('initializes Cubism 2 through the adapter and preserves the mask-size compatibility fix', async () => {
    const from = vi.fn(async (modelUrl: string, options: any) => ({ modelUrl, options }));
    const Live2DModel = {
      config: { cubism2: { maskSize: 256 } },
      from,
    };
    const adapter = new Cubism2PixiLive2DAdapter(async () => ({ Live2DModel }));

    await adapter.init();
    const model = await adapter.createModel('asset://localhost/model.json', {
      autoHitTest: false,
      autoFocus: false,
      autoUpdate: false,
    });

    expect(adapter.id).toBe('pixi-live2d-display-cubism2');
    expect(adapter.supported).toBe(true);
    expect(adapter.isReady()).toBe(true);
    expect(adapter.getModelClass()).toBe(Live2DModel);
    expect(adapter.getConfig().cubism2.maskSize).toBe(1024);
    expect(from).toHaveBeenCalledWith('asset://localhost/model.json', {
      autoHitTest: false,
      autoFocus: false,
      autoUpdate: false,
    });
    expect(model).toEqual({
      modelUrl: 'asset://localhost/model.json',
      options: {
        autoHitTest: false,
        autoFocus: false,
        autoUpdate: false,
      },
    });
  });

  it('fails Cubism 2 init with an explicit runtime-missing error without touching the module loader', async () => {
    setLive2DCubism2RuntimeAvailable(false);
    const loadModule = vi.fn(async () => ({ Live2DModel: {} }));
    const adapter = new Cubism2PixiLive2DAdapter(loadModule);

    await expect(adapter.init()).rejects.toThrow('live2d.min.js');
    expect(loadModule).not.toHaveBeenCalled();
    expect(adapter.isReady()).toBe(false);
  });

  it('reports the missing Cubism 2 runtime through the preload error path', () => {
    setLive2DCubism2RuntimeAvailable(false);
    const adapter = new Cubism2PixiLive2DAdapter();

    expect(adapter.getUnsupportedMessage('figure/tomori/model.json')).toContain('live2d.min.js');
  });

  it('waits for the runtime bootstrap before evaluating the Cubism 2 module', async () => {
    let resolveBootstrap!: (detail: { cubism2Loaded: boolean; cubismCoreLoaded: boolean }) => void;
    const globalRef = globalThis as Record<string, unknown>;
    const originalWindow = globalRef.window;
    try {
      globalRef.window = {
        __aeonLive2DRuntimeBootstrap: {
          ready: new Promise((resolve) => { resolveBootstrap = resolve; }),
        },
      } as never;
      const loadModule = vi.fn(async () => ({ Live2DModel: {} }));
      const adapter = new Cubism2PixiLive2DAdapter(loadModule);

      const init = adapter.init();
      await Promise.resolve();
      expect(loadModule).not.toHaveBeenCalled();

      resolveBootstrap({ cubism2Loaded: true, cubismCoreLoaded: false });
      await init;
      expect(loadModule).toHaveBeenCalledOnce();
    } finally {
      globalRef.window = originalWindow;
    }
  });

  it('can initialize for Cubism 2 config-only consumers without requiring a model class', async () => {
    const adapter = new Cubism2PixiLive2DAdapter(async () => ({
      config: { cubism2: { maskSize: 512 } },
    }));

    await adapter.init();

    expect(adapter.isReady()).toBe(true);
    expect(adapter.getModelClass()).toBeNull();
    expect(adapter.getConfig().cubism2.maskSize).toBe(1024);
    await expect(adapter.createModel('asset://localhost/model.json', {}))
      .rejects.toThrow('Live2DModel class is not available');
  });

  it('returns a clear error when the official Cubism Web SDK is unavailable', async () => {
    vi.spyOn(sdk, 'getCubismPixiSdkStatus').mockReturnValue({
      available: false,
      initialized: false,
      message: '官方 Cubism Web SDK Core 脚本缺失或未加载（/live2dcubismcore.min.js）。',
    });
    vi.spyOn(sdk, 'initCubismPixiSdk').mockRejectedValue(
      new Error('官方 Cubism Web SDK Core 脚本缺失或未加载（/live2dcubismcore.min.js）。'),
    );

    const adapter = new CubismPixiLive2DAdapter();

    expect(adapter.id).toBe('untitled-pixi-live2d-engine-cubism');
    expect(adapter.supported).toBe(false);
    expect(adapter.isReady()).toBe(false);
    expect(adapter.getUnsupportedMessage('figure/tomori/tomori.model3.json'))
      .toContain('live2dcubismcore.min.js');
    await expect(adapter.createModel('figure/tomori/tomori.model3.json'))
      .rejects.toThrow('live2dcubismcore.min.js');
  });

  it('initializes the official Cubism Web runtime once and creates a real model wrapper when SDK is available', async () => {
    const initCubismPixiSdk = vi.spyOn(sdk, 'initCubismPixiSdk').mockResolvedValue(undefined);
    vi.spyOn(sdk, 'getCubismPixiSdkStatus').mockReturnValue({
      available: true,
      initialized: false,
      message: null,
    });

    const adapter = new CubismPixiLive2DAdapter();

    await adapter.init();
    await adapter.init();
    const model = await adapter.createModel('asset://localhost/figure/tomori/tomori.model3.json');

    expect(adapter.supported).toBe(true);
    expect(adapter.isReady()).toBe(true);
    expect(initCubismPixiSdk.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(createCubismPixiModel).toHaveBeenCalledWith(
      'asset://localhost/figure/tomori/tomori.model3.json', {},
    );
    expect(model).toEqual(expect.objectContaining({
      modelUrl: 'asset://localhost/figure/tomori/tomori.model3.json',
    }));
  });

  it('selects adapters from runtime descriptors without leaking runtime internals to callers', () => {
    expect(getLive2DRuntimeAdapter({
      runtimeFamily: 'cubism2',
      adapterId: 'pixi-live2d-display-cubism2',
      supported: true,
    }).id).toBe('pixi-live2d-display-cubism2');

    expect(getLive2DRuntimeAdapter({
      runtimeFamily: 'cubism3-plus',
      adapterId: 'untitled-pixi-live2d-engine-cubism',
      supported: false,
    }).id).toBe('untitled-pixi-live2d-engine-cubism');
  });

  it('creates a Cubism 2 model handle facade that delegates low-risk controls', () => {
    const controls = new Cubism2PixiLive2DModelControls();
    const adapter = new Cubism2PixiLive2DAdapter(async () => ({ config: { cubism2: { maskSize: 512 } } }));
    const setExpression = vi.fn();
    const model = {
      expression: setExpression,
      x: 10,
      y: 20,
      rotation: 0,
      alpha: 1,
      scale: { x: 1, y: 1 },
      internalModel: {
        parameterValues: new Float32Array([0.1]),
        partOpacities: new Float32Array([1]),
        settings: {
          motions: { idle: [], wave: [] },
          expressions: { smile: {}, angry: {} },
        },
        motionManager: {
          state: { currentGroup: 'idle' },
        },
        coreModel: {},
      },
    };
    const handle = adapter.createModelHandle('tomori', model, {
      runtimeFamily: 'cubism2',
      adapterId: 'pixi-live2d-display-cubism2',
      supported: true,
    });
    const directHandle = createLive2DModelHandle({
      id: 'tomori-direct',
      model,
      runtime: {
        runtimeFamily: 'cubism2',
        adapterId: 'pixi-live2d-display-cubism2',
        supported: true,
      },
      controls,
    });

    expect(handle.id).toBe('tomori');
    expect(handle.capabilities.usesCubism2PrivateControls).toBe(true);
    expect(handle.displayObject).toBe(model);
    expect(handle.motion.getAvailableMotions()).toEqual(['idle', 'wave']);
    expect(handle.expression.getAvailableExpressions()).toEqual(['smile', 'angry']);
    handle.expression.setExpression('smile');
    expect(setExpression).toHaveBeenCalledWith('smile');
    expect(handle.snapshot.captureSnapshot(2.5)?.motion).toEqual({ key: 'idle', startTime: 2.5 });
    expect(directHandle.motion.getAvailableMotions()).toEqual(['idle', 'wave']);
  });

  it('creates an official Cubism Web model handle facade that delegates low-risk controls', () => {
    const adapter = new CubismPixiLive2DAdapter();
    const setExpression = vi.fn();
    const setParameterValueByIndex = vi.fn();
    const parameterValues = new Float32Array([0, Number.NaN]);
    const partOpacities = new Float32Array([1]);
    const model = {
      setExpression,
      syncInputParameters: vi.fn(),
      x: 0,
      y: 0,
      rotation: 0,
      alpha: 1,
      scale: { x: 1, y: 1 },
      internalModel: {
        parameterValues,
        partOpacities,
        settings: {
          motions: { TapBody: [] },
          expressions: { smile: {} },
        },
        motionManager: {
          playing: false,
          state: { currentGroup: undefined, reservedGroup: undefined, queue: [] },
        },
        coreModel: {
          getParameterCount: () => 2,
          getParameterId: (index: number) => ({
            getString: () => index === 1 ? 'PARAM_BROKEN' : 'PARAM_OK',
          }),
          getParameterValues: () => parameterValues,
          setParameterValueByIndex,
        },
      },
    };
    const handle = adapter.createModelHandle('rana', model, {
      runtimeFamily: 'cubism3-plus',
      adapterId: 'untitled-pixi-live2d-engine-cubism',
      supported: true,
    });

    expect(handle.id).toBe('rana');
    expect(handle.capabilities.usesCubism2PrivateControls).toBe(false);
    expect(handle.motion.getAvailableMotions()).toEqual(['TapBody']);
    expect(handle.expression.getAvailableExpressions()).toEqual(['smile']);
    expect(handle.diagnostics.describeInvalidState()).toBe('primary param[1] (PARAM_BROKEN)=NaN');
    handle.expression.setExpression('smile');
    handle.snapshot.applySnapshot({ params: new Float32Array([0.2, 0.4]) } as any);
    expect(setExpression).toHaveBeenCalledWith('smile');
    expect(setParameterValueByIndex.mock.calls[0][0]).toBe(0);
    expect(setParameterValueByIndex.mock.calls[0][1]).toBeCloseTo(0.2);
    expect(setParameterValueByIndex.mock.calls[1][0]).toBe(1);
    expect(setParameterValueByIndex.mock.calls[1][1]).toBeCloseTo(0.4);
  });

  it('keeps Cubism 2 expression reset details inside runtime controls', () => {
    const resetExpression = vi.fn();
    const stopAllMotions = vi.fn();
    const restoreExpression = vi.fn();
    const stopQueue = vi.fn();
    const stopPublicQueue = vi.fn();
    const defaultExpression = { params: [] };
    const expressionManager: any = {
      resetExpression,
      stopAllMotions,
      restoreExpression,
      defaultExpression,
      currentExpression: 'smile',
      _currentExpression: 'smile',
      activeExpression: 'smile',
      _motions: ['old'],
      motions: ['old'],
      state: {
        currentGroup: 'smile',
        reservedGroup: 'smile',
      },
      _motionQueueManager: {
        stopAllMotions: stopQueue,
        _motions: ['old'],
      },
      queueManager: {
        stopAllMotions: stopPublicQueue,
      },
    };
    const controls = new Cubism2PixiLive2DModelControls();

    controls.setExpression({
      internalModel: {
        motionManager: { expressionManager },
      },
    }, null);

    expect(resetExpression).not.toHaveBeenCalled();
    expect(stopAllMotions).not.toHaveBeenCalled();
    expect(restoreExpression).not.toHaveBeenCalled();
    expect(stopQueue).toHaveBeenCalled();
    expect(stopPublicQueue).toHaveBeenCalled();
    expect(expressionManager.currentExpression).toBe(defaultExpression);
    expect(expressionManager._currentExpression).toBeNull();
    expect(expressionManager.activeExpression).toBeNull();
    expect(expressionManager._motions).toEqual([]);
    expect(expressionManager.motions).toEqual([]);
    expect(expressionManager.state.currentGroup).toBeUndefined();
    expect(expressionManager.state.reservedGroup).toBeUndefined();
    expect(expressionManager._motionQueueManager._motions).toEqual([]);
  });

  it('restores an already-current Cubism 2 expression after motion override', () => {
    const expression = { params: [] };
    const restoreExpression = vi.fn();
    const setExpression = vi.fn();
    const controls = new Cubism2PixiLive2DModelControls();

    controls.setExpression({
      expression: setExpression,
      internalModel: {
        motionManager: {
          expressionManager: {
            expressions: [expression],
            currentExpression: expression,
            getExpressionIndex: () => 0,
            restoreExpression,
          },
        },
      },
    }, 'smile');

    expect(restoreExpression).toHaveBeenCalledTimes(1);
    expect(setExpression).not.toHaveBeenCalled();
  });

  it('evaluates Cubism 2 expressions at absolute seek time without accumulating across repeated seeks', async () => {
    let utTime = 10_000;
    (globalThis as any).window = {
      UtSystem: {
        getUserTimeMSec: () => utTime,
        setUserTimeMSec: (value: number) => { utTime = value; },
      },
    };

    const parameterValues = new Float32Array([0.25]);
    let savedParameter = parameterValues[0];
    const renderedValues: number[] = [];
    const coreModel = {
      getParamFloat: () => parameterValues[0],
      setParamFloat: (_id: string | number, value: number) => { parameterValues[0] = value; },
      getParameterValues: () => parameterValues,
      saveParam: () => { savedParameter = parameterValues[0]; },
      loadParam: () => { parameterValues[0] = savedParameter; },
      update: vi.fn(() => { renderedValues.push(parameterValues[0]); }),
    };
    const expression = {
      updateParamExe: (model: typeof coreModel, _time: number, weight: number) => {
        const base = model.getParamFloat();
        model.setParamFloat('PARAM_MOUTH_FORM', base + (0.9 - base) * weight);
      },
    };
    let expressionStartTime: number | null = null;
    const defaultExpression = { params: [] };
    const expressionManager = {
      expressions: [expression],
      currentExpression: defaultExpression,
      defaultExpression,
      reserveExpressionIndex: -1,
      queueManager: { stopAllMotions: vi.fn() },
      getExpressionIndex: (name: string) => name === 'smile' ? 0 : -1,
      loadExpression: vi.fn(async () => expression),
      _setExpression: vi.fn(() => { expressionStartTime = null; }),
      update: (model: typeof coreModel) => {
        // Cubism 2 initializes a queue entry's start time on its first update,
        // not when the expression is enqueued.
        if (expressionStartTime === null) expressionStartTime = utTime;
        const weight = Math.max(0, Math.min(1, (utTime - expressionStartTime) / 500));
        expression.updateParamExe(model, utTime, weight);
      },
    };
    const internalModel = {
      parameterValues,
      coreModel,
      motionManager: { expressionManager },
    };
    let pendingDelta = 0;
    const model = {
      update: (delta: number) => { pendingDelta += delta; },
      render: vi.fn((_renderer?: any) => {
        if (pendingDelta <= 0) return;
        coreModel.saveParam();
        if (expressionManager.currentExpression !== defaultExpression) {
          expressionManager.update(coreModel);
        }
        coreModel.update();
        coreModel.loadParam();
        pendingDelta = 0;
      }),
      internalModel,
    };
    const renderer = {
      gl: {
        SCISSOR_TEST: 0x0c11,
        isEnabled: () => false,
        disable: vi.fn(),
        enable: vi.fn(),
      },
      shader: { resetState: vi.fn() },
    };
    const controls = new Cubism2PixiLive2DModelControls();
    applyRenderHook('hero', model, vi.fn());

    await controls.setExpressionForSeek(model, 'smile', 1);
    expect(coreModel.update).not.toHaveBeenCalled();
    model.render(renderer);
    parameterValues[0] = 0.4;
    await controls.setExpressionForSeek(model, 'smile', 1);
    model.render(renderer);
    await controls.setExpressionForSeek(model, null, 0);
    model.render(renderer);

    expect(renderedValues).toHaveLength(3);
    expect(renderedValues[0]).toBeCloseTo(0.9);
    expect(renderedValues[1]).toBeCloseTo(0.9);
    expect(renderedValues[2]).toBeCloseTo(0.4);
    expect(parameterValues[0]).toBeCloseTo(0.4);
    expect(utTime).toBe(10_000);
  });

  it('prevents an older Cubism 2 expression request from landing after seek restoration', async () => {
    let resolveOldExpression!: (expression: any) => void;
    const oldExpression = { name: 'old' };
    const targetExpression = { name: 'target' };
    const applied: any[] = [];
    const expressionManager: any = {
      expressions: [],
      currentExpression: null,
      defaultExpression: { name: 'default' },
      reserveExpressionIndex: -1,
      queueManager: { stopAllMotions: vi.fn() },
      getExpressionIndex: (name: string) => name === 'old' ? 0 : 1,
      loadExpression: vi.fn((index: number) => index === 0
        ? new Promise(resolve => { resolveOldExpression = resolve; })
        : Promise.resolve(targetExpression)),
      _setExpression: vi.fn((expression: any) => { applied.push(expression); }),
    };
    const model = {
      update: vi.fn(),
      expression: vi.fn((name: string) => {
        void (async () => {
          const index = expressionManager.getExpressionIndex(name);
          expressionManager.reserveExpressionIndex = index;
          const expression = await expressionManager.loadExpression(index);
          if (expressionManager.reserveExpressionIndex !== index) return;
          expressionManager.reserveExpressionIndex = -1;
          expressionManager.currentExpression = expression;
          expressionManager._setExpression(expression);
        })();
      }),
      internalModel: {
        coreModel: {},
        motionManager: { expressionManager },
      },
    };
    const controls = new Cubism2PixiLive2DModelControls();

    controls.setExpression(model, 'old');
    await controls.setExpressionForSeek(model, 'target', 1);
    resolveOldExpression(oldExpression);
    await Promise.resolve();

    expect(applied).toEqual([targetExpression]);
    expect(expressionManager.currentExpression).toBe(targetExpression);
  });

  it('keeps the newest Cubism 2 seek expression when loads finish out of order', async () => {
    let resolveOlderSeek!: (expression: any) => void;
    const olderExpression = { name: 'older' };
    const newestExpression = { name: 'newest' };
    const applied: any[] = [];
    const expressionManager: any = {
      expressions: [],
      currentExpression: null,
      defaultExpression: { name: 'default' },
      reserveExpressionIndex: -1,
      queueManager: { stopAllMotions: vi.fn() },
      getExpressionIndex: (name: string) => name === 'older' ? 0 : 1,
      loadExpression: vi.fn((index: number) => index === 0
        ? new Promise(resolve => { resolveOlderSeek = resolve; })
        : Promise.resolve(newestExpression)),
      _setExpression: vi.fn((expression: any) => { applied.push(expression); }),
    };
    const model = {
      update: vi.fn(),
      internalModel: {
        coreModel: {},
        motionManager: { expressionManager },
      },
    };
    const controls = new Cubism2PixiLive2DModelControls();

    const olderSeek = controls.setExpressionForSeek(model, 'older', 2);
    const newestSeek = controls.setExpressionForSeek(model, 'newest', 1);
    await newestSeek;
    resolveOlderSeek(olderExpression);
    await olderSeek;

    expect(applied).toEqual([newestExpression]);
    expect(expressionManager.currentExpression).toBe(newestExpression);
    expect(model.update).toHaveBeenCalledTimes(1);
  });

  it('applies Cubism 2 parameter injection and syncs input parameters through runtime controls', () => {
    const values = new Map<number, number>();
    // Index-keyed runtime double (the numeric-overload contract).
    const setParamFloat = vi.fn((id: string | number, value: number) => {
      if (typeof id === 'number') values.set(id, value);
    });
    const syncInputParameters = vi.fn();
    const controls = new Cubism2PixiLive2DModelControls();
    const model = {
      syncInputParameters,
      internalModel: {
        coreModel: {
          getParamIndex: (name: string) => name === 'PARAM_MOUTH_OPEN_Y' ? 7 : -1,
          setParamFloat,
          getParamFloat: (index: number) => values.get(index) ?? 0,
        },
      },
    };

    controls.setInjectedParameter(model, 'PARAM_MOUTH_OPEN_Y', 0.75);
    controls.setInjectedParameter(model, 'UNKNOWN_PARAM', 1);
    controls.syncInputParameters(model);

    // The id-keyed write lands first; the index write is the fallback form
    // for index-keyed runtimes (a no-op on the real SDK).
    expect(setParamFloat).toHaveBeenCalledTimes(2);
    expect(setParamFloat).toHaveBeenNthCalledWith(1, 'PARAM_MOUTH_OPEN_Y', 0.75);
    expect(setParamFloat).toHaveBeenNthCalledWith(2, 7, 0.75);
    expect(syncInputParameters).toHaveBeenCalled();
  });

  it('captures Cubism 2 snapshots through runtime controls', () => {
    const controls = new Cubism2PixiLive2DModelControls();
    const model = {
      x: 10,
      y: 20,
      rotation: 0.25,
      alpha: 0.8,
      scale: { x: 1.2, y: 1.2 },
      internalModel: {
        parameterValues: new Float32Array([0.1, 0.2]),
        partOpacities: new Float32Array([1, 0.5]),
        motionManager: {
          state: { currentGroup: 'wave' },
        },
        coreModel: {},
      },
    };

    const snapshot = controls.captureSnapshot('tomori', model, 3.5);

    expect(snapshot?.motion).toEqual({ key: 'wave', startTime: 3.5 });
    expect(Array.from(snapshot?.params ?? [])).toEqual([0.10000000149011612, 0.20000000298023224]);
    expect(Array.from(snapshot?.opacities ?? [])).toEqual([1, 0.5]);
    expect(snapshot?.position).toEqual({ x: 10, y: 20 });
  });

  it('applies official Cubism Web snapshots and injected parameters through runtime controls', () => {
    const adapter = new CubismPixiLive2DAdapter();
    const controls = adapter.getControls();
    const setParameterValueByIndex = vi.fn();
    const setPartOpacityByIndex = vi.fn();
    const syncInputParameters = vi.fn();
    const parameterValues = new Float32Array([0, 0]);
    const partOpacities = new Float32Array([1, 1]);
    const model = {
      syncInputParameters,
      internalModel: {
        parameterValues,
        partOpacities,
        coreModel: {
          getParameterCount: () => 2,
          getParameterId: (index: number) => ({
            getString: () => index === 0 ? 'PARAM_ANGLE_X' : 'PARAM_MOUTH_OPEN_Y',
          }),
          getParameterMinimumValue: (index: number) => index === 0 ? -30 : 0,
          getParameterMaximumValue: (index: number) => index === 0 ? 30 : 1,
          getParameterDefaultValue: () => 0,
          getParameterValues: () => parameterValues,
          setParameterValueByIndex,
          setPartOpacityByIndex,
        },
      },
    };

    controls.setInjectedParameter(model, 'PARAM_MOUTH_OPEN_Y', 0.75);
    controls.applySnapshot(model, {
      params: new Float32Array([0.25, 0.5]),
      opacities: new Float32Array([0.2, 0.9]),
    } as any);

    expect(setParameterValueByIndex).toHaveBeenCalledWith(1, 0.75);
    expect(setParameterValueByIndex).toHaveBeenCalledWith(0, 0.25);
    expect(setParameterValueByIndex).toHaveBeenCalledWith(1, 0.5);
    expect(setPartOpacityByIndex.mock.calls[0][0]).toBe(0);
    expect(setPartOpacityByIndex.mock.calls[0][1]).toBeCloseTo(0.2);
    expect(setPartOpacityByIndex.mock.calls[1][0]).toBe(1);
    expect(setPartOpacityByIndex.mock.calls[1][1]).toBeCloseTo(0.9);
    expect(Array.from(parameterValues)).toEqual([0.25, 0.5]);
    expect(partOpacities[0]).toBeCloseTo(0.2);
    expect(partOpacities[1]).toBeCloseTo(0.9);
    expect(syncInputParameters).toHaveBeenCalled();
    expect(controls.getParameterMetadata(model)).toEqual([
      {
        id: 'PARAM_ANGLE_X',
        index: 0,
        min: -30,
        max: 30,
        defaultValue: 0,
        source: 'runtime',
      },
      {
        id: 'PARAM_MOUTH_OPEN_Y',
        index: 1,
        min: 0,
        max: 1,
        defaultValue: 0,
        source: 'runtime',
      },
    ]);
  });

  it('describes invalid official Cubism Web state through runtime controls', () => {
    const adapter = new CubismPixiLive2DAdapter();
    const controls = adapter.getControls();

    expect(controls.describeInvalidState({
      internalModel: {
        parameterValues: new Float32Array([0, Number.NaN]),
        partOpacities: new Float32Array([1]),
        coreModel: {
          getParameterId: (index: number) => ({
            getString: () => index === 1 ? 'PARAM_BROKEN' : 'PARAM_OK',
          }),
        },
      },
    })).toBe('primary param[1] (PARAM_BROKEN)=NaN');
  });

  it('routes official Cubism Web motion and expression controls through the model instance wrapper', async () => {
    const adapter = new CubismPixiLive2DAdapter();
    const controls = adapter.getControls();
    const preloadMotion = vi.fn().mockResolvedValue(undefined);
    const stopAllMotions = vi.fn();
    const setExpression = vi.fn();
    const model = {
      preloadMotion,
      stopAllMotions,
      setExpression,
      getMotionDuration: vi.fn(() => 1.75),
      internalModel: {
        motionManager: {
          playing: true,
          state: {
            currentGroup: 'idle',
            reservedGroup: undefined,
            queue: ['motion-a'],
          },
        },
      },
    };

    expect(controls.getMotionDuration(model, 'idle')).toBe(1.75);
    expect(controls.getMotionDebugState(model)).toEqual({
      currentGroup: 'idle',
      reservedGroup: undefined,
      isFinished: false,
      playing: true,
      queueLength: 1,
      internalModel: model.internalModel,
      motionManager: model.internalModel.motionManager,
      queueManager: ['motion-a'],
    });

    await controls.preloadMotion(model, 'idle');
    controls.setExpression(model, 'smile');
    controls.stopAllMotions(model);
    controls.clearMotionState(model);

    expect(preloadMotion).toHaveBeenCalledWith('idle', 0);
    expect(setExpression).toHaveBeenCalledWith('smile');
    expect(stopAllMotions).toHaveBeenCalled();
    expect(model.internalModel.motionManager.state.currentGroup).toBeUndefined();
    expect(model.internalModel.motionManager.state.queue).toEqual([]);
  });

  it('routes bake rendering through runtime controls', () => {
    const cubism2Controls = new Cubism2PixiLive2DModelControls();
    const renderer = { id: 'renderer' };
    const cubism2Render = vi.fn();
    cubism2Controls.renderForBake({ render: cubism2Render }, renderer);
    expect(cubism2Render).toHaveBeenCalledWith(renderer);

    const officialControls = new CubismPixiLive2DAdapter().getControls();
    const renderForBake = vi.fn();
    const render = vi.fn();
    const renderTexture = { id: 'offscreen' };
    officialControls.renderForBake({ renderForBake, render }, renderer, 'rana', renderTexture);
    expect(renderForBake).toHaveBeenCalledWith(renderer, renderTexture);
    expect(render).not.toHaveBeenCalled();
  });

  it('resets PIXI renderer state around Cubism 2 offscreen bake renders', () => {
    const controls = new Cubism2PixiLive2DModelControls();
    const cubismProgram = { id: 'cubism' };
    const backgroundProgram = { id: 'background' };
    const cubismUniform = { program: cubismProgram };
    let activeProgram: object | null = backgroundProgram;
    const glErrors: string[] = [];

    const renderer = {
      // v8 renderer-level seam: resetState() emits the resetState runner
      // (the v7-era name `reset()` no longer exists on the renderer).
      resetState: vi.fn(() => {
        activeProgram = null;
      }),
      render: vi.fn((model: any) => {
        // The offscreen pass must begin without the background filter program
        // cached by PIXI. Cubism owns this raw WebGL program and uniform.
        if (activeProgram !== null) {
          glErrors.push('uniformMatrix3fv: location is not from the associated program');
          return;
        }
        model.render({
          gl: {
            useProgram: (program: object) => {
              activeProgram = program;
            },
            uniformMatrix3fv: (location: { program: object }) => {
              if (activeProgram !== location.program) {
                glErrors.push('uniformMatrix3fv: location is not from the associated program');
              }
            },
          },
        });
      }),
    };
    const model = {
      render: ({ gl }: any) => {
        gl.useProgram(cubismProgram);
        gl.uniformMatrix3fv(cubismUniform);
      },
    };

    controls.renderForBake(model, renderer, 'character', { id: 'bake-target' });

    expect(glErrors).toEqual([]);
    expect(renderer.resetState).toHaveBeenCalledTimes(2);
    expect(renderer.render).toHaveBeenCalledWith(model, {
      renderTexture: { id: 'bake-target' },
      clear: true,
    });
  });

  it('lists Cubism 2 motions and expressions across composite-like models', () => {
    const controls = new Cubism2PixiLive2DModelControls();
    const model = {
      getAllModels: () => [
        {
          internalModel: {
            settings: {
              motions: { idle: [], wave: [] },
              expressions: { smile: {}, blush: {} },
            },
          },
        },
        {
          internalModel: {
            settings: {
              motions: { wave: [], angry: [] },
              expressions: { blush: {}, cry: {} },
            },
          },
        },
      ],
    };

    expect(controls.getAvailableMotions(model)).toEqual(['idle', 'wave', 'angry']);
    expect(controls.getAvailableExpressions(model)).toEqual(['smile', 'blush', 'cry']);
  });

  it('returns Cubism 2 motion debug state and parameter values through runtime controls', () => {
    const controls = new Cubism2PixiLive2DModelControls();
    const queue = {
      isFinished: vi.fn(() => false),
      _motions: ['motion-instance'],
    };
    const motionManager = {
      state: {
        currentGroup: 'wave',
        reservedGroup: 'idle',
      },
      _motionQueueManager: queue,
    };
    const model = {
      internalModel: {
        motionManager,
        settings: {
          parameters: [{ name: 'PARAM_ANGLE_X' }, { name: 'PARAM_MOUTH_OPEN_Y' }],
        },
        coreModel: {
          getParameterValues: () => new Float32Array([0.25, 0.75]),
        },
      },
    };

    expect(controls.getMotionDebugState(model)).toEqual({
      currentGroup: 'wave',
      reservedGroup: 'idle',
      isFinished: false,
      queueLength: 1,
      internalModel: model.internalModel,
      motionManager,
      queueManager: queue,
    });
    expect(controls.getParameterValues(model)).toEqual([
      { index: 0, name: 'PARAM_ANGLE_X', value: 0.25 },
      { index: 1, name: 'PARAM_MOUTH_OPEN_Y', value: 0.75 },
    ]);
    expect(controls.getParameterMetadata(model)).toEqual([
      {
        id: 'PARAM_ANGLE_X',
        index: 0,
        defaultValue: 0,
        source: 'known-cubism2-default',
      },
      {
        id: 'PARAM_MOUTH_OPEN_Y',
        index: 1,
        defaultValue: 0,
        source: 'known-cubism2-default',
      },
    ]);
  });

  it('resolves Cubism 2 parameter ids from the core model when settings omit them', () => {
    const controls = new Cubism2PixiLive2DModelControls();
    const parameterValues = new Float32Array(32);
    parameterValues.set([0.25, 0.75]);
    const modelContext = {
      _$qo: 2,
      _$_2: parameterValues,
      _$pb: [
        { id: 'PARAM_ANGLE_X' },
        { id: 'PARAM_MOUTH_OPEN_Y' },
      ],
    };
    const model = {
      internalModel: {
        settings: {},
        coreModel: {
          getModelContext: () => modelContext,
        },
      },
    };

    expect(controls.getParameterValues(model)).toEqual([
      { index: 0, name: 'PARAM_ANGLE_X', value: 0.25 },
      { index: 1, name: 'PARAM_MOUTH_OPEN_Y', value: 0.75 },
    ]);
  });

  it('handles Cubism 2 motion duration, clearing, stopping, and preloading through runtime controls', async () => {
    const controls = new Cubism2PixiLive2DModelControls();
    const loadMotion = vi.fn().mockResolvedValue(undefined);
    const stopAllMotions = vi.fn();
    const stopQueueMotions = vi.fn();
    const mainMotionManager = {
      state: {
        currentGroup: 'wave',
        reservedGroup: 'idle',
        queue: ['queued'],
      },
      _motionQueueManager: {
        stopAllMotions: stopQueueMotions,
      },
      stopAllMotions,
      loadMotion,
    };
    const subLoadMotion = vi.fn().mockResolvedValue(undefined);
    const subMotionManager = {
      state: {
        currentGroup: 'wave',
        reservedGroup: 'idle',
      },
      stopAllMotions: vi.fn(),
      loadMotion: subLoadMotion,
    };
    const model = {
      internalModel: {
        getMotionManager: () => ({
          getMotionGroupIndex: (key: string) => key === 'wave' ? 1 : -1,
          motions: [
            null,
            { _duration: 2.5 },
          ],
        }),
        settings: {
          motions: { wave: [{}] },
        },
        motionManager: mainMotionManager,
      },
      getAllModels: () => [
        {
          internalModel: {
            settings: { motions: { wave: [{}] } },
            motionManager: mainMotionManager,
          },
        },
        {
          internalModel: {
            settings: { motions: { wave: [{}] } },
            motionManager: subMotionManager,
          },
        },
      ],
    };

    expect(controls.getMotionDuration(model, 'wave')).toBe(2.5);
    expect(controls.getMotionDuration(model, 'missing')).toBe(0);

    controls.clearMotionState(model);
    expect(mainMotionManager.state.currentGroup).toBeUndefined();
    expect(mainMotionManager.state.reservedGroup).toBeUndefined();
    expect(mainMotionManager.state.queue).toEqual([]);
    expect(subMotionManager.state.currentGroup).toBeUndefined();

    controls.stopAllMotions(model);
    expect(stopAllMotions).toHaveBeenCalled();
    expect(stopQueueMotions).toHaveBeenCalled();
    expect(subMotionManager.stopAllMotions).toHaveBeenCalled();

    await controls.preloadMotion(model, 'wave');
    expect(loadMotion).toHaveBeenCalledWith('wave', 0);
    expect(subLoadMotion).toHaveBeenCalledWith('wave', 0);
  });

  it('describes invalid Cubism 2 parameter and opacity state through runtime controls', () => {
    const controls = new Cubism2PixiLive2DModelControls();

    expect(controls.describeInvalidState({
      internalModel: {
        parameterValues: new Float32Array([0, Number.NaN]),
        partOpacities: new Float32Array([1]),
        coreModel: {
          getParamIds: () => ['PARAM_ANGLE_X', 'PARAM_BROKEN'],
        },
      },
    })).toBe('primary param[1] (PARAM_BROKEN)=NaN');

    expect(controls.describeInvalidState({
      getAllModels: () => [
        {
          internalModel: {
            parameterValues: new Float32Array([0]),
            partOpacities: new Float32Array([1]),
            coreModel: {},
          },
        },
        {
          internalModel: {
            parameterValues: new Float32Array([0]),
            partOpacities: new Float32Array([Number.POSITIVE_INFINITY]),
            coreModel: {},
          },
        },
      ],
    })).toBe('submodel 1 opacity[0]=Infinity');
  });

  describe('deep runtime surface (frame stepping, bake frames, lifecycle, focus, blink)', () => {
    function cubism2DeepModel() {
      const params = new Float32Array([0, 0]);
      const opacities = new Float32Array([1, 1]);
      const motionManager = {
        playing: false,
        state: {
          currentGroup: undefined as string | undefined,
          reservedGroup: undefined as string | undefined,
          queue: [] as unknown[],
        },
        loadMotion: vi.fn(async () => undefined),
        startMotion: vi.fn(async () => true),
        stopAllMotions: vi.fn(),
        update: vi.fn(),
        _motionQueueManager: {
          stopAllMotions: vi.fn(),
          _userTimeMSec: 0,
        },
        expressionManager: {
          stopAllExpressions: vi.fn(),
          state: { currentGroup: undefined },
          resetExpression: vi.fn(),
        },
      };
      const coreModel = {
        getParamIndex: (name: string) => (name === 'PARAM_ANGLE_X' ? 0 : name === 'PARAM_MOUTH_OPEN_Y' ? 1 : -1),
        setParamFloat: (index: number | string, value: number) => {
          if (typeof index === 'string') {
            const idx = coreModel.getParamIndex(index);
            if (idx !== -1) params[idx] = value;
          } else if (index >= 0 && index < params.length) {
            params[index] = value;
          }
        },
        getParamFloat: (index: number) => (index >= 0 && index < params.length ? params[index] : 0),
        getParameterValues: () => params,
        getPartOpacities: () => opacities,
        loadParam: vi.fn(),
        saveParam: vi.fn(),
        update: vi.fn(),
      };
      const internalModel: any = {
        coreModel,
        motionManager,
        settings: {
          motions: { idle: [{}], wave: [{}] },
          parameters: [{ name: 'PARAM_ANGLE_X' }, { name: 'PARAM_MOUTH_OPEN_Y' }],
        },
        parameterValues: params,
        partOpacities: opacities,
        physics: { update: vi.fn() },
        eyeBlink: {
          update: vi.fn(),
          enabled: true,
          blinkInterval: 4000,
          nextBlinkTimeLeft: 4000,
          blinkingState: 1,
        },
        focusController: {
          focus: vi.fn(),
          update: vi.fn(),
          x: 0,
          y: 0,
          targetX: 0,
          targetY: 0,
          vx: 0,
          vy: 0,
        },
        expressionManager: {
          stopAllExpressions: vi.fn(),
          state: { currentGroup: undefined },
          resetExpression: vi.fn(),
        },
        on: () => {},
        off: () => {},
        update: vi.fn(),
        updateWebGLContext: vi.fn(),
      };
      const model: any = {
        internalModel,
        update: vi.fn((dt?: number) => {
          internalModel.update(dt ?? 16, (model.elapsedTime = (model.elapsedTime ?? 0) + (dt ?? 16)));
          coreModel.update();
        }),
        visible: true,
        renderable: true,
        alpha: 1,
        parent: undefined,
        render: vi.fn(),
      };
      return { model, internalModel, coreModel, motionManager, params, opacities };
    }

    it('advances frames and resolves concrete cubism2 targets through controls', () => {
      const controls = new Cubism2PixiLive2DModelControls();
      const { model } = cubism2DeepModel();

      controls.advanceFrame(model, 16);

      expect(model.update).toHaveBeenCalledWith(16);
      expect(controls.getConcreteModels(model)).toEqual([model]);
    });

    it('steps motion queues with physics disabled and restores identities afterwards', () => {
      const controls = new Cubism2PixiLive2DModelControls();
      const { model, internalModel, motionManager } = cubism2DeepModel();

      controls.advanceMotionOnly(model, 5016);

      expect(internalModel.physics).toEqual({ update: expect.any(Function) });
      expect(motionManager.update).toHaveBeenCalledTimes(1);
      expect(motionManager.update).toHaveBeenCalledWith(internalModel.coreModel, 5016);
    });

    it('advances bake frames without rendering and flushes the core only on demand', () => {
      const controls = new Cubism2PixiLive2DModelControls();
      const { model, internalModel, coreModel } = cubism2DeepModel();

      // No renderer → the legacy advance-without-render fast path.
      controls.stepBakeFrame(model, 16, undefined as any, 'soyo', true);
      expect(model.update).toHaveBeenCalledWith(16);
      expect(coreModel.update).toHaveBeenCalled();

      // flushCore=false mirrors the warm-up / initial-render positions.
      coreModel.update.mockClear();
      model.update.mockClear();
      controls.stepBakeFrame(model, 0, undefined as any, 'soyo', false);
      expect(model.update).not.toHaveBeenCalled();
      expect(coreModel.update).not.toHaveBeenCalled();

      // With a renderer and an accumulated delta the cubism2 fast path
      // advances internals instead of issuing any GL render.
      model.update.mockClear();
      (model as any).deltaTime = 16;
      (model as any).elapsedTime = 16;
      const renderer = { render: vi.fn() };
      controls.stepBakeFrame(model, 16, renderer, 'soyo', true);
      expect(internalModel.update).toHaveBeenCalledWith(16, 16);
      expect(model.render).not.toHaveBeenCalled();
      expect(renderer.render).not.toHaveBeenCalled();
      expect((model as any).deltaTime).toBe(0);
    });

    it('binds the bake GL context before the first advance-without-render model step', () => {
      // Regression: the vendor only binds drawParamWebGL.gl inside
      // renderLive2D(). The advance-without-render fast path skips the real
      // render, so a fresh model's first internalModel.update() used to reach
      // the SDK shader compilation with an unbound context and crash in
      // loadShaders2 ("Cannot read properties of undefined (reading
      // 'createProgram')").
      const controls = new Cubism2PixiLive2DModelControls({ bakeCore: new Cubism2BakeRenderCore() });
      const { model, internalModel } = cubism2DeepModel();
      // v8 Live2DModel starts with `gl === null`; that is the vendor's own
      // unbound marker (renderLive2D re-binds on `this.gl !== renderer.gl`).
      (model as any).gl = null;
      (model as any).deltaTime = 16;
      (model as any).elapsedTime = 16;
      const gl = { createProgram: vi.fn(() => ({})) };
      const renderer = { render: vi.fn(), gl };

      controls.stepBakeFrame(model, 16, renderer as any, 'soyo', true);

      // Bound once to the stable bake slot, exactly like renderLive2D would do.
      expect(internalModel.updateWebGLContext).toHaveBeenCalledTimes(1);
      expect(internalModel.updateWebGLContext).toHaveBeenCalledWith(gl, expect.any(Number));
      expect((model as any).gl).toBe(gl);
      // The step itself still advances internally without issuing any GL render
      // (the model helper bumps elapsedTime 16 -> 32 on its own update pass).
      expect(internalModel.update).toHaveBeenLastCalledWith(16, 32);
      expect(renderer.render).not.toHaveBeenCalled();

      // A second step keeps the existing binding (no re-bind churn).
      (model as any).deltaTime = 16;
      (model as any).elapsedTime = 32;
      internalModel.update.mockClear();
      controls.stepBakeFrame(model, 16, renderer as any, 'soyo', true);
      expect(internalModel.updateWebGLContext).toHaveBeenCalledTimes(1);
      expect(internalModel.update).toHaveBeenLastCalledWith(16, 48);

      // Without a bake core (plain controls) the binding step is skipped — the
      // legacy unbound behavior only applies to tests/diagnostics, never the
      // real cubism2 adapter (which always owns a bake core).
      const plainControls = new Cubism2PixiLive2DModelControls();
      const { model: plainModel, internalModel: plainInternal } = cubism2DeepModel();
      (plainModel as any).gl = null;
      (plainModel as any).deltaTime = 16;
      (plainModel as any).elapsedTime = 16;
      plainControls.stepBakeFrame(plainModel, 16, renderer as any, 'soyo', true);
      expect(plainInternal.updateWebGLContext).not.toHaveBeenCalled();
    });

    it('starts only playable motion groups and replays offsets in the adapter lock window', async () => {
      const controls = new Cubism2PixiLive2DModelControls();
      const { model, internalModel, motionManager } = cubism2DeepModel();

      const missing = await controls.startMotion(model, 'missing', 3, 0, { clock: null });
      expect(missing).toEqual({ ok: false, offsetReplayMs: 0 });

      let beforeReplayCalled = false;
      const result = await controls.startMotion(model, 'wave', 3, 0.25, {
        clock: {
          getUserTimeMSec: () => 10_000,
          setUserTimeMSec: vi.fn(),
        },
        beforeReplay: () => { beforeReplayCalled = true; },
      });

      expect(motionManager.startMotion).toHaveBeenCalledWith('wave', 0, 3);
      expect(beforeReplayCalled).toBe(true);
      expect(result.ok).toBe(true);
      expect(result.offsetReplayMs).toBe(250);
      expect(result.motionStartUtTimeMs).toBe(9750);
      expect(internalModel.physics).toEqual({ update: expect.any(Function) });

      // clearQueueFirst resets the shared queue state before enqueuing.
      motionManager.state.currentGroup = 'wave';
      motionManager.playing = true;
      await controls.startMotion(model, 'idle', 3, 0, {
        clock: null,
        clearQueueFirst: true,
      });
      expect(motionManager.state.currentGroup).toBeUndefined();
      expect(motionManager.playing).toBe(false);
      expect(motionManager._motionQueueManager.stopAllMotions).toHaveBeenCalled();
    });

    it('reports motion groups and sampling targets from concrete models', () => {
      const controls = new Cubism2PixiLive2DModelControls();
      const { model, internalModel, motionManager } = cubism2DeepModel();

      expect(controls.hasMotionGroup(model, 'wave')).toBe(true);
      expect(controls.hasMotionGroup(model, 'sad')).toBe(false);
      expect(controls.getMotionSamplingTargets(model)).toEqual([{ internalModel, motionManager }]);
    });

    it('flushes the idle state inside the global SDK clock lock', async () => {
      const controls = new Cubism2PixiLive2DModelControls();
      let utTime = 1000;
      (globalThis as any).window = {
        UtSystem: {
          getUserTimeMSec: () => utTime,
          setUserTimeMSec: (value: number) => { utTime = value; },
        },
      };
      const { model, motionManager } = cubism2DeepModel();

      await controls.flushIdleState(model);

      expect(motionManager.loadMotion).toHaveBeenCalledWith('idle', 0);
      expect(motionManager.startMotion).toHaveBeenCalledWith('idle', 0, 3);
      expect(model.update).toHaveBeenCalledWith(16);
      expect(motionManager.stopAllMotions).toHaveBeenCalled();
      expect(motionManager._motionQueueManager.stopAllMotions).toHaveBeenCalled();
      expect(utTime).toBe(1016);
    });

    it('restarts the idle motion group through real concrete managers', async () => {
      const controls = new Cubism2PixiLive2DModelControls();
      const { model, motionManager } = cubism2DeepModel();

      await controls.restartIdleMotion(model);

      expect(motionManager.startMotion).toHaveBeenCalledWith('idle', 0, 3);
    });

    it('resets a cubism2 model to idle and restores the deep idle snapshot', async () => {
      const controls = new Cubism2PixiLive2DModelControls();
      (globalThis as any).window = { UtSystem: undefined };
      const { model, internalModel, motionManager, params, opacities } = cubism2DeepModel();
      motionManager.state.currentGroup = 'wave';
      params[0] = 0.75;
      opacities[0] = 0.5;

      await controls.resetModelToIdle(model, {
        keepFocus: false,
        idleSnapshot: {
          params: new Float32Array([0.1, 0.2]),
          opacities: new Float32Array([0.9, 0.8]),
        },
      });

      expect(motionManager.stopAllMotions).toHaveBeenCalled();
      expect(motionManager.state.currentGroup).toBeUndefined();
      expect(motionManager._motionQueueManager._userTimeMSec).toBe(0);
      // Idle-start → one 16ms step → stop (legacy ordering preserved).
      expect(motionManager.startMotion).toHaveBeenCalledWith('idle', 0, 3);
      expect(model.update).toHaveBeenCalledWith(16);
      // Deep snapshot values land on the live arrays (Float32 rounding).
      expect(params[0]).toBeCloseTo(0.1, 5);
      expect(params[1]).toBeCloseTo(0.2, 5);
      expect(opacities[0]).toBeCloseTo(0.9, 5);
      expect(opacities[1]).toBeCloseTo(0.8, 5);
      expect(internalModel.expressionManager.stopAllExpressions).toHaveBeenCalled();
      expect(internalModel.focusController.focus).toHaveBeenCalledWith(0, 0, true);
    });

    it('resets core parameters when no idle snapshot exists and keeps focus on request', async () => {
      const controls = new Cubism2PixiLive2DModelControls();
      const { model, coreModel, internalModel } = cubism2DeepModel();
      coreModel.loadParam.mockImplementation(() => {
        coreModel.setParamFloat(0, 0);
      });

      await controls.resetModelToIdle(model, { keepFocus: true, idleSnapshot: null });

      expect(coreModel.loadParam).toHaveBeenCalled();
      expect(internalModel.focusController.focus).not.toHaveBeenCalled();
      expect(model.update).toHaveBeenCalled();
    });

    it('captures idle snapshots and applies idle baselines to concrete cores', () => {
      const controls = new Cubism2PixiLive2DModelControls();
      const { model, coreModel, params, opacities } = cubism2DeepModel();

      const snap = controls.captureIdleSnapshot(model);
      expect(snap).toEqual({
        params: Float32Array.from([0, 0]),
        opacities: Float32Array.from([1, 1]),
      });
      expect(coreModel.saveParam).toHaveBeenCalled();

      params[0] = 0.6;
      opacities[0] = 0.4;
      controls.applyIdleBaseline(model, { params: new Float32Array([0.2, 0.3]), opacities: new Float32Array([1, 1]) });
      expect(params[0]).toBeCloseTo(0.2, 5);
      expect(params[1]).toBeCloseTo(0.3, 5);
      expect(opacities[0]).toBeCloseTo(1, 5);
      expect(opacities[1]).toBeCloseTo(1, 5);
    });

    it('soft-detaches models and destroys them with texture retention options', () => {
      const controls = new Cubism2PixiLive2DModelControls();
      const { model, motionManager } = cubism2DeepModel();
      const parent = { removeChild: vi.fn() };
      model.parent = parent;
      model.destroy = vi.fn();
      model.stopAllMotions = vi.fn();

      controls.disposeModel(model, { mode: 'soft-detach', keepTextures: true, detach: true });
      expect(parent.removeChild).toHaveBeenCalledWith(model);
      expect(model.visible).toBe(false);
      expect(model.renderable).toBe(false);
      expect(model.alpha).toBe(0);
      expect(model.destroy).not.toHaveBeenCalled();
      expect(model.stopAllMotions).toHaveBeenCalled();
      expect(motionManager._motionQueueManager.stopAllMotions).toHaveBeenCalled();

      controls.disposeModel(model, { mode: 'destroy', keepTextures: true, detach: false });
      expect(model.destroy).toHaveBeenCalledWith({
        children: true,
        texture: false,
        baseTexture: false,
      });

      controls.disposeModel(model, { mode: 'destroy', keepTextures: false, detach: false });
      expect(model.destroy).toHaveBeenLastCalledWith({
        children: true,
        texture: true,
        baseTexture: true,
      });
    });

    it('prepares models by wiring the injected-parameter override into the core update', () => {
      const controls = new Cubism2PixiLive2DModelControls();
      const { model, internalModel, coreModel, params } = cubism2DeepModel();
      const source = { id: 'soyo', injectedParams: {} };

      controls.prepareModel(model, {
        id: 'soyo',
        mode: 'bake',
        isExportMode: true,
        injectedParamsSource: source as any,
        applyProxyTransform: () => {},
      });

      expect(model._characterEntry).toBe(source);
      expect((coreModel as any).__aeonstageryParameterOverrideApplied).toBe(true);

      source.injectedParams = { PARAM_ANGLE_X: 0.5 };
      controls.advanceFrame(model, 16);
      expect(params[0]).toBe(0.5);
      expect(internalModel._characterEntry).toBe(source);
    });

    it('quiesces a model by stopping motions and expressions', () => {
      const controls = new Cubism2PixiLive2DModelControls();
      const { model, internalModel, motionManager } = cubism2DeepModel();

      controls.quiesceModel(model);

      expect(motionManager.stopAllMotions).toHaveBeenCalled();
      expect(motionManager._motionQueueManager.stopAllMotions).toHaveBeenCalled();
      expect(motionManager.expressionManager.resetExpression).toHaveBeenCalled();
      expect(internalModel.motionManager).toBe(motionManager);
    });

    it('disables and re-enables the Cubism 2 eye blink through controls', () => {
      const controls = new Cubism2PixiLive2DModelControls();
      const { model, internalModel } = cubism2DeepModel();
      const eyeBlink = internalModel.eyeBlink;
      const originalUpdate = eyeBlink.update;

      controls.setBlink(model, false, 4000);
      expect(eyeBlink.enabled).toBe(false);
      expect(eyeBlink.blinkingState).toBe(0);
      expect(eyeBlink.update).not.toBe(originalUpdate);
      expect(eyeBlink.__aeonOriginalUpdate).toBe(originalUpdate);

      controls.setBlink(model, true, 3000);
      expect(eyeBlink.update).toBe(originalUpdate);
      expect(eyeBlink.enabled).toBe(true);
      expect(eyeBlink.blinkInterval).toBe(3000);
      expect(eyeBlink.nextBlinkTimeLeft).toBe(3000);
    });

    it('applies focus, exposes focus controllers, and resolves head anchors from hit areas', () => {
      const controls = new Cubism2PixiLive2DModelControls();
      const { model, internalModel } = cubism2DeepModel();
      internalModel.settings.hit_areas_custom = {
        head_x: [-0.35, 0.6],
        head_y: [0.19, -0.2],
      };
      internalModel.settings.layout = { center_x: 0, center_y: -0.16, width: 1.8 };

      controls.applyFocus(model, { focusX: 0.25, focusY: -0.4, duration: 0 });
      expect(internalModel.focusController.targetX).toBe(0.25);
      expect(internalModel.focusController.targetY).toBe(-0.4);
      expect(controls.getFocusControllers(model)).toEqual([internalModel.focusController]);

      const anchor = controls.getHeadAnchor(model);
      expect(anchor).not.toBeNull();
      expect(anchor!.x).toBeCloseTo(0.5 + ((-0.35 + 0.6) / 2 - 0) / 1.8, 6);
      expect(anchor!.y).toBeCloseTo(0.5 - ((0.19 + -0.2) / 2 - -0.16) / 1.8, 6);

      delete internalModel.settings.hit_areas_custom;
      expect(controls.getHeadAnchor(model)).toBeNull();
    });

    it('exposes the SDK clock handle and bake texture disposal on the adapter', async () => {
      delete (globalThis as any).window;
      const adapter = new Cubism2PixiLive2DAdapter(async () => ({
        config: { cubism2: { maskSize: 1024 } },
        from: async () => ({}),
      }));
      await adapter.init();

      expect(adapter.getClock()).toBeNull();

      const utSystem = { getUserTimeMSec: () => 42, setUserTimeMSec: vi.fn() };
      (globalThis as any).window = { UtSystem: utSystem };
      expect(adapter.getClock()).toBe(utSystem);

      expect(() => adapter.disposeBakeRenderTexture()).not.toThrow();
    });
  });

  describe('isolateMask buffer lifecycle (recycled-model renewal)', () => {
    it('renews the isolated clipping texture when a model is reused', () => {
      const first = { destroy: vi.fn() } as any;
      const second = { destroy: vi.fn() } as any;
      const create = vi.spyOn(PIXI.RenderTexture, 'create')
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second);
      const maskSprite: any = { texture: null };
      const model: any = { internalModel: { clippingManager: { maskSprite } } };
      const controls = new Cubism2PixiLive2DModelControls();

      controls.isolateMask(model);
      controls.isolateMask(model);

      expect(create).toHaveBeenCalledTimes(2);
      expect(first.destroy).toHaveBeenCalledWith(true);
      expect(maskSprite.texture).toBe(second);
      create.mockRestore();
    });

    it('releases the isolated clipping texture when the model is destroyed', () => {
      const created = { destroy: vi.fn() } as any;
      const create = vi.spyOn(PIXI.RenderTexture, 'create').mockReturnValueOnce(created);
      const maskSprite: any = { texture: null };
      const model: any = {
        internalModel: { clippingManager: { maskSprite } },
        destroy: vi.fn(),
      };
      const controls = new Cubism2PixiLive2DModelControls();

      controls.isolateMask(model);
      create.mockRestore();
      controls.disposeModel(model, { mode: 'destroy', keepTextures: true });

      expect(created.destroy).toHaveBeenCalledWith(true);
      expect(maskSprite.texture).toBe(PIXI.Texture.EMPTY);
    });
  });
});
