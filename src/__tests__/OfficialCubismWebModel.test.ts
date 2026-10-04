import { describe, expect, it, vi } from 'vitest';
import { resolveOfficialCubismWebSpriteLayout } from '../engine/OfficialCubismWebGeometry';

vi.mock('@cubism/model/cubismusermodel', () => ({
  CubismUserModel: class {
    release(): void {}
  },
}));
vi.mock('@cubism/cubismmodelsettingjson', () => ({
  CubismModelSettingJson: class {
    getModelFileName(): string { return 'model.moc3'; }
    getLayoutMap(): boolean { return false; }
  },
}));
vi.mock('@cubism/math/cubismmatrix44', () => ({
  CubismMatrix44: class {
    loadIdentity(): void {}
    multiplyByMatrix(): void {}
  },
}));

import { OfficialCubismUserModel, OfficialCubismWebModelInstance } from '../engine/OfficialCubismWebModel';
import { getLive2DRuntimeAdapter } from '../engine/Live2DRuntimeAdapter';

describe('Official Cubism Core memory growth', () => {
  it('keeps an already loaded model writing to native memory after another model expands the heap', async () => {
    const originalFetch = globalThis.fetch;
    const originalCore = (globalThis as any).Live2DCubismCore;
    const oldMemory = new ArrayBuffer(128);
    let currentMemory = oldMemory;
    let models: any[] = [];
    const parameterOffset = 16;
    const vertexOffset = 32;

    class Parameters {
      values = new Float32Array(currentMemory, parameterOffset, 1);
      minimumValues = new Float32Array(currentMemory, 40, 1);
      maximumValues = new Float32Array(currentMemory, 44, 1);
    }
    class Parts { opacities = new Float32Array(currentMemory, 48, 1); }
    class Drawables { vertexPositions = [new Float32Array(currentMemory, vertexOffset, 1)]; }
    class Offscreens { opacities = new Float32Array(currentMemory, 52, 1); }
    class CanvasInfo {}

    const makeSdkModel = () => {
      const raw = {
        _ptr: 8,
        parameters: new Parameters(),
        parts: new Parts(),
        drawables: new Drawables(),
        offscreens: new Offscreens(),
        canvasinfo: new CanvasInfo(),
        renderOrders: new Int32Array(currentMemory, 56, 1),
        update: () => {
          new Float32Array(currentMemory, vertexOffset, 1)[0] =
            new Float32Array(currentMemory, parameterOffset, 1)[0];
        },
      };
      return {
        _parameterValues: raw.parameters.values,
        _parameterMinimumValues: raw.parameters.minimumValues,
        _parameterMaximumValues: raw.parameters.maximumValues,
        _partOpacities: raw.parts.opacities,
        _offscreenOpacities: raw.offscreens.opacities,
        getModel: () => raw,
        loadParameters: () => undefined,
        saveParameters: () => undefined,
        setParameterValueByIndex(index: number, value: number) {
          this._parameterValues[index] = value;
        },
        update: () => raw.update(),
      };
    };

    try {
      (globalThis as any).Live2DCubismCore = { Parameters, Parts, Drawables, Offscreens, CanvasInfo };
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode('{"FileReferences":{}}').buffer,
      })) as any;
      models = [new OfficialCubismUserModel(), new OfficialCubismUserModel()] as any[];
      const sdks = models.map(() => makeSdkModel());
      for (let i = 0; i < models.length; i++) {
        models[i].loadModel = () => undefined;
        models[i].getModel = () => sdks[i];
        models[i].collectEffectIds = () => undefined;
        models[i].collectExpressions = () => undefined;
        models[i].collectMotions = () => undefined;
        models[i].preloadExpressions = async () => undefined;
        models[i].loadOptionalPhysics = async () => undefined;
        models[i].loadOptionalPose = async () => undefined;
      }

      await models[0].loadFromModelJson('model-a.model3.json');
      currentMemory = oldMemory.slice(0);
      await models[1].loadFromModelJson('model-b.model3.json');

      models[0]._motionManager = {
        isFinished: () => false,
        updateMotion: (sdk: any) => sdk.setParameterValueByIndex(0, 1.25),
        getCubismMotionQueueEntries: () => [],
      };
      models[0].updateFrame(16);

      expect(new Float32Array(currentMemory, parameterOffset, 1)[0]).toBe(1.25);
      expect(new Float32Array(currentMemory, vertexOffset, 1)[0]).toBe(1.25);
      expect(sdks[0].getModel().drawables.vertexPositions[0].buffer).toBe(currentMemory);
    } finally {
      models.forEach((model) => model.release());
      globalThis.fetch = originalFetch;
      (globalThis as any).Live2DCubismCore = originalCore;
    }
  });
});

describe('OfficialCubismWebModel geometry', () => {
  it('anchors the offscreen sprite around the wrapper origin instead of pushing it into stage space', () => {
    const layout = resolveOfficialCubismWebSpriteLayout(0.5, 0.9, 2048, 2048);

    expect(layout).toEqual({
      x: -1024,
      y: -1843.2,
      width: 2048,
      height: 2048,
    });
  });

  it('keeps the wrapper origin inside the local display bounds', () => {
    const layout = resolveOfficialCubismWebSpriteLayout(0.5, 0.9, 2048, 2048);

    expect(layout.x).toBeLessThanOrEqual(0);
    expect(layout.y).toBeLessThanOrEqual(0);
    expect(layout.x + layout.width).toBeGreaterThan(0);
    expect(layout.y + layout.height).toBeGreaterThan(0);
  });
});

describe('Official Cubism realtime parameter injection', () => {
  it('applies audio mouth values before each Core update without saving them as the motion baseline', () => {
    let mouthValue = 0;
    let savedMouthValue = 0;
    const mouthValuesSeenByCore: number[] = [];
    const coreModel = {
      getParameterCount: () => 1,
      getParameterId: () => ({ getString: () => 'ParamMouthOpenY' }),
      getParameterValueByIndex: () => mouthValue,
      setParameterValueByIndex: (_index: number, value: number) => { mouthValue = value; },
      loadParameters: () => { mouthValue = savedMouthValue; },
      saveParameters: () => { savedMouthValue = mouthValue; },
      update: () => { mouthValuesSeenByCore.push(mouthValue); },
    };
    const userModel = new OfficialCubismUserModel() as any;
    userModel.ready = true;
    userModel.getModel = () => coreModel;
    userModel._motionManager = null;
    userModel._expressionManager = null;
    userModel._physics = null;
    userModel._pose = null;

    const instance = Object.create(OfficialCubismWebModelInstance.prototype) as any;
    instance.model = userModel;
    instance.syncInternalState = vi.fn();
    const entry = { injectedParams: { ParamMouthOpenY: 0.8 } };
    getLive2DRuntimeAdapter({
      runtimeFamily: 'cubism3-plus',
      adapterId: 'official-cubism-web',
      supported: true,
    }).getControls().prepareModel(instance, {
      id: 'speaker',
      mode: 'live',
      injectedParamsSource: entry,
    });

    instance.update(16);
    entry.injectedParams.ParamMouthOpenY = 0.25;
    instance.update(16);

    expect(mouthValuesSeenByCore).toEqual([0.8, 0.25]);
    expect(savedMouthValue).toBe(0);
  });
});

describe('OfficialCubismUserModel motion seek', () => {
  it('commits a bake snapshot as the native fade-in baseline', () => {
    let value = 9;
    let savedValue = 9;
    const coreModel = {
      getParameterCount: () => 1,
      setParameterValueByIndex: (_index: number, next: number) => { value = next; },
      loadParameters: () => { value = savedValue; },
      saveParameters: () => { savedValue = value; },
    };
    const model = {
      internalModel: {
        coreModel,
        parameterValues: new Float32Array([9]),
        partOpacities: new Float32Array(0),
      },
      syncInputParameters: vi.fn(),
    };
    const controls = getLive2DRuntimeAdapter({
      runtimeFamily: 'cubism3-plus', adapterId: 'official-cubism-web', supported: true,
    }).getControls();

    controls.applySnapshot(model, { params: new Float32Array([2]) } as any);
    coreModel.loadParameters();

    expect(value).toBe(2);
  });

  it('keeps a restored baseline through the SDK loadParameters on the next frame', async () => {
    // Cubism keeps a separate saved parameter buffer. A previous motion has
    // populated both buffers before a backwards seek restores the idle pose.
    let value = 9;
    let savedValue = 9;
    const core = {
      getParameterCount: () => 1,
      setParameterValueByIndex: (_index: number, next: number) => { value = next; },
      loadParameters: () => { value = savedValue; },
      saveParameters: () => { savedValue = value; },
      update: vi.fn(),
    };
    const model = new OfficialCubismUserModel() as any;
    model.ready = true;
    model.getModel = () => core;
    model.syncMotionState = vi.fn();
    model.syncExpressionState = vi.fn();
    model.setExpression = vi.fn();
    model.stopAllMotions = vi.fn();
    const instance = Object.create(OfficialCubismWebModelInstance.prototype) as any;
    instance.model = model;
    instance.internalModel = { parameterValues: new Float32Array([9]) };
    instance.syncInternalState = vi.fn();
    instance.refreshAfterSeek = vi.fn();

    await instance.restoreAtSceneTime({
      targetSceneTime: 1,
      idleSnapshot: { params: new Float32Array([0]) },
    });
    expect(value).toBe(0);
    model.updateFrame(16);
    expect(value).toBe(0);
  });

  it('retains namespaced raw model3 motion groups when the SDK setting omits them', () => {
    const model = new OfficialCubismUserModel() as any;
    const setting = {
      getMotionGroupCount: () => 0,
      getExpressionCount: () => 0,
    };

    model.collectMotions(setting, {
      FileReferences: {
        Motions: {
          'mygo/soyo/mtn_smile01_C_live_01': [
            { File: 'motions/soyo-live.motion3.json' },
          ],
        },
      },
    });

    expect(model.getMotionSettings()).toEqual({
      'mygo/soyo/mtn_smile01_C_live_01': [
        { file: 'motions/soyo-live.motion3.json', index: 0 },
      ],
    });
  });

  it('resolves an unnamespaced action key before loading the concrete group', async () => {
    const model = new OfficialCubismUserModel() as any;
    model.motionDefinitions.set('mygo/soyo/mtn_wave', [{ file: 'wave.motion3.json', index: 0 }]);
    model.preloadMotion = vi.fn(async (group: string) => {
      expect(group).toBe('mygo/soyo/mtn_wave');
      return null;
    });

    await expect(model.startMotion('mtn_wave')).resolves.toBe(false);
    expect(model.preloadMotion).toHaveBeenCalledWith('mygo/soyo/mtn_wave', 0);
  });

  it('primes the motion queue at the seek offset instead of restarting fade-in from zero', async () => {
    const model = new OfficialCubismUserModel() as any;
    const motionQueueEntry = {
      setIsStarted: vi.fn(),
      setStartTime: vi.fn(),
      setFadeInStartTime: vi.fn(),
      setLastCheckEventSeconds: vi.fn(),
    };
    const motion = {
      setOffsetTime: vi.fn(),
      setBeganMotionHandler: vi.fn(),
      setFinishedMotionHandler: vi.fn(),
      setupMotionQueueEntry: vi.fn((entry: any) => entry.setIsStarted(true)),
    };
    const motionManager = {
      _userTimeSeconds: 10,
      setReservePriority: vi.fn(),
      startMotionPriority: vi.fn(() => 'motion-handle'),
      getCubismMotionQueueEntry: vi.fn(() => motionQueueEntry),
      getCubismMotionQueueEntries: vi.fn(() => [motionQueueEntry]),
      isFinished: vi.fn(() => false),
    };

    model._motionManager = motionManager;
    model.preloadMotion = vi.fn(async () => motion);

    await model.startMotionAtOffset('wave', 0, 3, 2);

    expect(motion.setupMotionQueueEntry).toHaveBeenCalledWith(motionQueueEntry, 10);
    expect(motionQueueEntry.setIsStarted).toHaveBeenCalledWith(true);
    expect(motionQueueEntry.setStartTime).toHaveBeenCalledWith(8);
    expect(motionQueueEntry.setFadeInStartTime).toHaveBeenCalledWith(8);
    expect(motionQueueEntry.setLastCheckEventSeconds).toHaveBeenCalledWith(8);
  });

  it('holds the exported motion end pose instead of applying Cubism fade-out', async () => {
    const model = new OfficialCubismUserModel() as any;
    const motionQueueEntry = {
      setIsStarted: vi.fn(),
      setStartTime: vi.fn(),
      setFadeInStartTime: vi.fn(),
      setLastCheckEventSeconds: vi.fn(),
    };
    const motion = {
      setOffsetTime: vi.fn(),
      setFadeOutTime: vi.fn(),
      setBeganMotionHandler: vi.fn(),
      setFinishedMotionHandler: vi.fn(),
      setupMotionQueueEntry: vi.fn((entry: any) => entry.setIsStarted(true)),
    };
    const motionManager = {
      _userTimeSeconds: 10,
      setReservePriority: vi.fn(),
      startMotionPriority: vi.fn(() => 'motion-handle'),
      getCubismMotionQueueEntry: vi.fn(() => motionQueueEntry),
      getCubismMotionQueueEntries: vi.fn(() => [motionQueueEntry]),
      isFinished: vi.fn(() => false),
    };

    model._motionManager = motionManager;
    model.preloadMotion = vi.fn(async () => motion);

    await model.startMotion('wave', 0, 3, 0);

    expect(motion.setFadeOutTime).toHaveBeenCalledWith(0);
  });

  it('applies the authored fade-in override when restoring an exported motion', async () => {
    const model = new OfficialCubismUserModel() as any;
    const motionQueueEntry = {
      setIsStarted: vi.fn(),
      setStartTime: vi.fn(),
      setFadeInStartTime: vi.fn(),
      setLastCheckEventSeconds: vi.fn(),
    };
    const motion = {
      setFadeInTime: vi.fn(),
      setFadeOutTime: vi.fn(),
      setOffsetTime: vi.fn(),
      setBeganMotionHandler: vi.fn(),
      setFinishedMotionHandler: vi.fn(),
      setupMotionQueueEntry: vi.fn((entry: any) => entry.setIsStarted(true)),
    };
    const motionManager = {
      _userTimeSeconds: 10,
      setReservePriority: vi.fn(),
      startMotionPriority: vi.fn(() => 'motion-handle'),
      getCubismMotionQueueEntry: vi.fn(() => motionQueueEntry),
      getCubismMotionQueueEntries: vi.fn(() => [motionQueueEntry]),
      isFinished: vi.fn(() => false),
    };

    model._motionManager = motionManager;
    model.preloadMotion = vi.fn(async () => motion);

    await model.startMotionAtOffset('wave', 0, 3, 0.25, 0.5);

    expect(motion.setFadeInTime).toHaveBeenCalledWith(0.5);
  });

  it('restores the file fade-in after a previous start used a scene override', async () => {
    const model = new OfficialCubismUserModel() as any;
    let fadeIn = 0.75;
    const motion = {
      getFadeInTime: () => fadeIn,
      setFadeInTime: vi.fn((seconds: number) => { fadeIn = seconds; }),
      setFadeOutTime: vi.fn(),
      setOffsetTime: vi.fn(),
      setBeganMotionHandler: vi.fn(),
      setFinishedMotionHandler: vi.fn(),
      setupMotionQueueEntry: vi.fn(),
    };
    model._motionManager = {
      _userTimeSeconds: 10,
      setReservePriority: vi.fn(),
      startMotionPriority: vi.fn(() => 'handle'),
      getCubismMotionQueueEntry: vi.fn(() => ({ setStartTime: vi.fn(), setFadeInStartTime: vi.fn() })),
      isFinished: vi.fn(() => false),
    };
    model.preloadMotion = vi.fn(async () => motion);

    await model.startMotion('wave', 0, 3, 0, 0);
    await model.startMotion('wave', 0, 3, 0);

    expect(fadeIn).toBe(0.75);
  });

  it('restores the previous action pose before applying native motion fade-in', async () => {
    const model = new OfficialCubismUserModel() as any;
    const baseline = {
      params: new Float32Array([0]),
      opacities: new Float32Array([1]),
    };
    const handoff = {
      params: new Float32Array([12]),
      opacities: new Float32Array([0.75]),
    };
    const motionQueueEntry = {
      setIsStarted: vi.fn(),
      setStartTime: vi.fn(),
      setFadeInStartTime: vi.fn(),
      setLastCheckEventSeconds: vi.fn(),
    };
    const motion = {
      setFadeInTime: vi.fn(),
      setFadeOutTime: vi.fn(),
      setOffsetTime: vi.fn(),
      setBeganMotionHandler: vi.fn(),
      setFinishedMotionHandler: vi.fn(),
      setupMotionQueueEntry: vi.fn((entry: any) => entry.setIsStarted(true)),
    };
    const motionManager = {
      _userTimeSeconds: 10,
      setReservePriority: vi.fn(),
      startMotionPriority: vi.fn(() => 'motion-handle'),
      getCubismMotionQueueEntry: vi.fn(() => motionQueueEntry),
      getCubismMotionQueueEntries: vi.fn(() => [motionQueueEntry]),
      isFinished: vi.fn(() => false),
    };
    model._motionManager = motionManager;
    model.preloadMotion = vi.fn(async () => motion);
    model.applyRuntimeSnapshot = vi.fn((snapshot: any) => {
      model._appliedSnapshot = snapshot;
    });

    const instance = Object.create(OfficialCubismWebModelInstance.prototype) as any;
    instance.model = model;
    instance.internalModel = {};
    instance.applyRuntimeSnapshot = vi.fn();
    instance.syncInternalState = vi.fn();
    instance.refreshAfterSeek = vi.fn();
    instance.drawToCanvas = vi.fn();
    instance.refreshTexture = vi.fn();

    await instance.restoreAtSceneTime({
      targetSceneTime: 0.25,
      snapshot: baseline,
      idleSnapshot: baseline,
      handoffSnapshot: handoff,
      motion: { key: 'next', priority: 3, offset: 0.25, sceneTime: 0, fadeInSeconds: 0.5 },
    });

    expect(instance.applyRuntimeSnapshot).toHaveBeenCalledWith(handoff);
  });

  it('advances an enqueued motion on every playback frame', async () => {
    const model = new OfficialCubismUserModel() as any;
    const coreModel = {
      value: 0,
      loadParameters: vi.fn(),
      saveParameters: vi.fn(),
      update: vi.fn(),
    };
    const motionQueueEntry = {
      setIsStarted: vi.fn(),
      setStartTime: vi.fn(),
      setFadeInStartTime: vi.fn(),
      setLastCheckEventSeconds: vi.fn(),
    };
    const motion = {
      setOffsetTime: vi.fn(),
      setBeganMotionHandler: vi.fn(),
      setFinishedMotionHandler: vi.fn(),
      setupMotionQueueEntry: vi.fn((entry: any) => entry.setIsStarted(true)),
    };
    const motionManager = {
      _userTimeSeconds: 0,
      setReservePriority: vi.fn(),
      startMotionPriority: vi.fn(() => 'motion-handle'),
      getCubismMotionQueueEntry: vi.fn(() => motionQueueEntry),
      getCubismMotionQueueEntries: vi.fn(() => [motionQueueEntry]),
      isFinished: vi.fn(() => false),
      updateMotion: vi.fn((target: any, deltaSeconds: number) => {
        target.value += deltaSeconds;
      }),
    };

    model.ready = true;
    model.getModel = vi.fn(() => coreModel);
    model._motionManager = motionManager;
    model._expressionManager = null;
    model._physics = null;
    model._pose = null;
    model.preloadMotion = vi.fn(async () => motion);

    await model.startMotionAtOffset('wave', 0, 3, 0);
    model.updateFrame(16);
    model.updateFrame(16);

    expect(motionManager.updateMotion).toHaveBeenCalledTimes(2);
    expect(coreModel.value).toBeCloseTo(0.032, 6);
  });

  it('keeps the standard Cubism breath parameter moving on every frame', () => {
    let breathValue = 0;
    const coreModel = {
      getParameterCount: () => 2,
      getParameterId: (index: number) => index === 1 ? 'ParamBreath' : 'ParamAngleX',
      setParameterValueByIndex: vi.fn((index: number, value: number) => {
        if (index === 1) breathValue = value;
      }),
      getParameterValueByIndex: (index: number) => index === 1 ? breathValue : 0,
      loadParameters: vi.fn(),
      saveParameters: vi.fn(),
      update: vi.fn(),
    };
    const model = new OfficialCubismUserModel() as any;

    model.ready = true;
    model.getModel = vi.fn(() => coreModel);
    model._motionManager = null;
    model._expressionManager = null;
    model._physics = null;
    model._pose = null;

    model.updateFrame(16);
    const firstValue = breathValue;
    model.updateFrame(16);

    expect(coreModel.setParameterValueByIndex).toHaveBeenCalledWith(1, expect.any(Number));
    expect(firstValue).toBeGreaterThan(0.5);
    expect(breathValue).toBeGreaterThan(firstValue);
  });

  it('keeps breathing active when an authored motion updates the same parameter', async () => {
    let breathValue = 0;
    const coreModel = {
      getParameterCount: () => 2,
      getParameterId: (index: number) => index === 1 ? 'ParamBreath' : 'ParamAngleX',
      setParameterValueByIndex: vi.fn((index: number, value: number) => {
        if (index === 1) breathValue = value;
      }),
      loadParameters: vi.fn(),
      saveParameters: vi.fn(),
      update: vi.fn(),
    };
    const motionQueueEntry = {
      setIsStarted: vi.fn(),
      setStartTime: vi.fn(),
      setFadeInStartTime: vi.fn(),
      setLastCheckEventSeconds: vi.fn(),
    };
    const motion = {
      setOffsetTime: vi.fn(),
      setBeganMotionHandler: vi.fn(),
      setFinishedMotionHandler: vi.fn(),
      setupMotionQueueEntry: vi.fn((entry: any) => entry.setIsStarted(true)),
    };
    const motionManager = {
      _userTimeSeconds: 0,
      setReservePriority: vi.fn(),
      startMotionPriority: vi.fn(() => 'motion-handle'),
      getCubismMotionQueueEntry: vi.fn(() => motionQueueEntry),
      getCubismMotionQueueEntries: vi.fn(() => [motionQueueEntry]),
      isFinished: vi.fn(() => false),
      updateMotion: vi.fn((target: any) => {
        target.setParameterValueByIndex(1, -1);
      }),
    };
    const model = new OfficialCubismUserModel() as any;

    model.ready = true;
    model.getModel = vi.fn(() => coreModel);
    model._motionManager = motionManager;
    model._expressionManager = null;
    model._physics = null;
    model._pose = null;
    model.preloadMotion = vi.fn(async () => motion);

    await model.startMotionAtOffset('wave', 0, 3, 0);
    model.updateFrame(16);

    expect(breathValue).toBeGreaterThan(0.5);
  });

  it('restores the same breathing phase when seeking to the same scene time', async () => {
    let breathValue = 0;
    let savedBreathValue = 0;
    const coreModel = {
      getParameterCount: () => 1,
      getParameterId: () => 'ParamBreath',
      setParameterValueByIndex: vi.fn((_index: number, value: number) => {
        breathValue = value;
      }),
      loadParameters: vi.fn(() => {
        breathValue = savedBreathValue;
      }),
      saveParameters: vi.fn(() => {
        savedBreathValue = breathValue;
      }),
      update: vi.fn(),
    };
    const model = new OfficialCubismUserModel() as any;
    model.ready = true;
    model.getModel = vi.fn(() => coreModel);
    model._motionManager = null;
    model._expressionManager = null;
    model._physics = null;
    model._pose = null;
    model.stopAllMotions = vi.fn();
    model.setExpression = vi.fn();
    model.syncMotionState = vi.fn();
    model.syncExpressionState = vi.fn();

    const instance = Object.create(OfficialCubismWebModelInstance.prototype) as any;
    instance.model = model;
    instance.internalModel = { parameterValues: new Float32Array([0]) };
    instance.syncInternalState = vi.fn();
    instance.refreshAfterSeek = vi.fn();

    const restoreInput = {
      id: 'character',
      targetSceneTime: 1.25,
      idleSnapshot: { params: new Float32Array([0]) },
    };

    await instance.restoreAtSceneTime(restoreInput);
    const firstSeekValue = breathValue;

    model.updateFrame(1000);
    await instance.restoreAtSceneTime(restoreInput);

    expect(breathValue).toBeCloseTo(firstSeekValue, 6);
  });

  it('fails explicitly when the official runtime does not expose the enqueued motion', async () => {
    const model = new OfficialCubismUserModel() as any;
    const motion = {
      setOffsetTime: vi.fn(),
      setBeganMotionHandler: vi.fn(),
      setFinishedMotionHandler: vi.fn(),
    };
    const stopAllMotions = vi.fn();
    const motionManager = {
      _userTimeSeconds: 0,
      setReservePriority: vi.fn(),
      startMotionPriority: vi.fn(() => undefined),
      getCubismMotionQueueEntry: vi.fn(() => null),
      getCubismMotionQueueEntries: vi.fn(() => []),
      isFinished: vi.fn(() => true),
      stopAllMotions,
    };

    model._motionManager = motionManager;
    model.preloadMotion = vi.fn(async () => motion);

    await expect(model.startMotionAtOffset('wave', 0, 3, 0)).resolves.toBe(false);
    expect(stopAllMotions).toHaveBeenCalledOnce();
  });
});

describe('OfficialCubismUserModel blink', () => {
  it('applies the same blink pose when playback and seek resolve one scene time', () => {
    let value = 1;
    const coreModel: any = {
      getParameterCount: () => 1,
      getParameterValueById: () => value,
      setParameterValueById: (_id: unknown, next: number) => { value = next; },
      setParameterValueByIndex: (_index: number, next: number) => { value = next; },
      loadParameters: () => undefined,
      saveParameters: () => undefined,
      update: () => undefined,
    };
    const model = new OfficialCubismUserModel() as any;
    model.ready = true;
    model.getModel = () => coreModel;
    model._motionManager = null;
    model._expressionManager = null;
    model._physics = null;
    model._pose = null;
    model.eyeBlinkParameterIds = ['ParamEyeLOpen'];

    model.setBlink(true, 1000, 0.8, 0);
    model.updateFrame(0.001);
    const seekValue = value;

    value = 1;
    model.setBlink(true, 1000, 0.8, 0);
    model.updateFrame(0.001);

    expect(seekValue).toBeLessThan(1);
    expect(value).toBeCloseTo(seekValue, 6);
  });
});
