import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container, ObservablePoint } from 'pixi.js';
import { Live2DCompositeModel } from '../engine/Live2DCompositeModel';
import { Live2DModelResources, type Live2DResourceModel, type LoadedLive2DModel } from '../engine/Live2DModelResources';
import { WmdlConfigRegistry } from '../engine/WmdlConfigRegistry';
import * as sdk from '../engine/CubismPixiSdk';
import * as runtimeResolver from '../engine/Live2DRuntimeResolver';
import { cubism2Live2DAdapter } from '../engine/Live2DRuntimeAdapter';
import { mockAdapter, mockControls } from './helpers/mockLive2DRuntimeAdapter';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeModel(): Live2DResourceModel {
  return Object.assign(new Container(), {
    anchor: new ObservablePoint({ _onUpdate: () => {} }, 0, 0),
    autoUpdate: false,
  });
}

function fixture(purpose: 'stage' | 'bake' = 'stage') {
  const controls = mockControls({
    getConcreteModels: model => model instanceof Live2DCompositeModel ? model.getAllModels() : [model],
    disposeModel: vi.fn((model: Live2DResourceModel) => model.destroy()),
  });
  const adapter = mockAdapter({
    getControls: () => controls,
    createModel: vi.fn(async () => makeModel()),
  });
  const resources = new Live2DModelResources(() => '/project', () => adapter, purpose);
  return { resources, adapter, controls };
}

// Keep the public borrowing handle while tests compare concrete SDK instances.
const returns = new WeakMap<Live2DResourceModel, LoadedLive2DModel['release']>();
function rememberBorrowing(loaded: LoadedLive2DModel): void {
  returns.set(loaded.model, loaded.release);
}
function releaseBorrowed(model: Live2DResourceModel): void {
  const release = returns.get(model);
  if (!release) throw new Error('Model was not borrowed');
  release();
}
async function borrow(resources: Live2DModelResources, id: string, path = 'hero.model.json') {
  let model!: Live2DResourceModel;
  await resources.loadCharacter(id, path, async loaded => {
    model = loaded.model;
    rememberBorrowing(loaded);
  });
  return model;
}

describe('Live2D model resource ownership', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      aeonStageryAPI: { fs: { readTextFile: vi.fn(async (path: string) => ({
        success: true,
        data: JSON.stringify(path.endsWith('.wmdl')
          ? { modelRelativePath: 'torso.model.json' }
          : path.endsWith('.model3.json')
            ? { FileReferences: { Moc: 'hero.moc3' } }
            : { model: 'hero.moc' }),
      })) } },
    });
    vi.spyOn(sdk, 'getCubismPixiSdkStatus').mockReturnValue({ available: true, initialized: true, message: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('closes synchronously, rejects future borrowing, and drains late bake creation', async () => {
    const { resources, adapter, controls } = fixture('bake');
    const borrowed = await borrow(resources, 'borrowed');
    const ready = deferred<Live2DResourceModel>();
    vi.mocked(adapter.createModel).mockReturnValueOnce(ready.promise);
    const deliver = vi.fn(async () => {});
    const pending = resources.loadCharacter('late', 'late.model.json', deliver);
    await vi.waitFor(() => expect(adapter.createModel).toHaveBeenCalledTimes(2));
    resources.close();
    expect(controls.disposeModel).toHaveBeenCalledWith(borrowed,
      expect.objectContaining({ mode: 'soft-detach', detach: true }));
    const drained = vi.fn();
    const drain = resources.waitForLoads().then(drained);
    await resources.loadCharacter('closed', 'hero.model.json', deliver);
    await resources.preloadModel(resources.pathToUrl('hero.model.json'));
    expect(adapter.createModel).toHaveBeenCalledTimes(2);
    expect(drained).not.toHaveBeenCalled();
    const late = makeModel();
    ready.resolve(late);
    await Promise.all([pending, drain]);
    expect(deliver).not.toHaveBeenCalled();
    expect(controls.disposeModel).toHaveBeenCalledWith(late,
      expect.objectContaining({ mode: 'soft-detach', detach: true }));
    resources.close();
    releaseBorrowed(borrowed);
    expect(controls.disposeModel).toHaveBeenCalledTimes(2);
    expect(resources.hasPendingLoads).toBe(false);
  });

  it('cancels a bake task without losing loaded or late instances and invalidates queued delivery', async () => {
    const { resources, adapter, controls } = fixture('bake');
    const borrowed = await borrow(resources, 'borrowed');
    const ready = deferred<Live2DResourceModel>();
    vi.mocked(adapter.createModel).mockReturnValueOnce(ready.promise);
    const deliver = vi.fn(async () => {});
    const pending = resources.loadCharacter('late', 'late.model.json', deliver);
    await vi.waitFor(() => expect(adapter.createModel).toHaveBeenCalledTimes(2));
    const queued = resources.loadCharacter('late', 'late.model.json', deliver);
    resources.cancelLoads();
    const late = makeModel();
    ready.resolve(late);
    await Promise.all([pending, queued]);
    expect(deliver).not.toHaveBeenCalled();
    expect(controls.disposeModel).not.toHaveBeenCalled();
    expect(await borrow(resources, 'retry', 'late.model.json')).toBe(late);
    releaseBorrowed(borrowed);
    expect(await borrow(resources, 'next')).toBe(borrowed);
    expect(adapter.createModel).toHaveBeenCalledTimes(2);
  });

  it('binds returns to a borrowing so an old return cannot reclaim a new owner', async () => {
    const { resources, adapter, controls } = fixture('bake');
    let old!: LoadedLive2DModel;
    await resources.loadCharacter('old', 'hero.model.json', async loaded => { old = loaded; });
    old.release();
    let next!: LoadedLive2DModel;
    await resources.loadCharacter('next', 'hero.model.json', async loaded => { next = loaded; });
    expect(next.model).toBe(old.model);
    expect(old.isCurrent()).toBe(false);
    old.release('discard');
    expect(next.isCurrent()).toBe(true);
    expect(controls.disposeModel).not.toHaveBeenCalled();
    expect(await borrow(resources, 'third')).not.toBe(next.model);
    next.release('discard');
    next.release();
    expect(controls.disposeModel).toHaveBeenCalledTimes(1);
    expect(adapter.createModel).toHaveBeenCalledTimes(2);
  });

  it('discards a superseded late modern instance with its creation adapter and preserves textures', async () => {
    const { adapter, controls } = fixture();
    adapter.id = 'untitled-pixi-live2d-engine-cubism';
    let selected = adapter;
    const resources = new Live2DModelResources(() => '/project', () => selected, 'bake');
    const ready = deferred<Live2DResourceModel>();
    vi.mocked(adapter.createModel).mockReturnValueOnce(ready.promise);
    const oldDelivery = vi.fn(async () => {});
    const pending = resources.loadCharacter('hero', 'hero.model3.json', oldDelivery);
    await vi.waitFor(() => expect(adapter.createModel).toHaveBeenCalledTimes(1));
    const staleQueued = resources.loadCharacter('hero', 'hero.model3.json', oldDelivery);
    selected = mockAdapter();
    const nextDelivery = vi.fn(async () => {});
    const replacement = resources.loadCharacter('hero', 'new.model.json', nextDelivery);
    const late = makeModel();
    ready.resolve(late);
    await Promise.all([pending, staleQueued, replacement]);
    expect(oldDelivery).not.toHaveBeenCalled();
    expect(nextDelivery).toHaveBeenCalledTimes(1);
    expect(controls.disposeModel).toHaveBeenCalledExactlyOnceWith(late,
      expect.objectContaining({ mode: 'destroy', keepTextures: true, detach: true }));
  });

  it('reclaims acquired composite children when submodel settings fail', async () => {
    const { resources, adapter, controls } = fixture('bake');
    const registry = new WmdlConfigRegistry();
    registry.register('hero.wmdl', {
      modelRelativePath: 'torso.model.json',
      subModels: [{ modelRelativePath: 'face.model.json', offsetX: 12 }],
    });
    resources.setWmdlConfigRegistry(registry);
    const torso = makeModel();
    const face = makeModel();
    Object.defineProperty(face, 'x', { set: () => { throw new Error('offset setup failed'); } });
    vi.mocked(adapter.createModel).mockResolvedValueOnce(torso).mockResolvedValueOnce(face);
    const deliver = vi.fn(async () => {});
    await expect(resources.loadCharacter('hero', 'hero.wmdl', deliver)).rejects.toThrow('offset setup failed');
    expect(deliver).not.toHaveBeenCalled();
    expect(await borrow(resources, 'torso', 'torso.model.json')).toBe(torso);
    expect(await borrow(resources, 'face', 'face.model.json')).toBe(face);
    resources.close();
    expect(controls.disposeModel).toHaveBeenCalledTimes(2);
  });

  it('removes the previous bake parameter writer before a pooled SDK model is reused', async () => {
    const controls = cubism2Live2DAdapter.getControls();
    const values = new Float32Array([0]);
    const core = {
      getParamIndex: () => 0,
      getParameterValues: () => values,
      update: vi.fn(),
      setParamFloat: (_id: string | number, value: number) => { values[0] = value; },
    };
    const instance = Object.assign(makeModel(), { internalModel: {
      coreModel: core, parameterValues: values,
      motionManager: { stopAllMotions: vi.fn() },
    } });
    const adapter = mockAdapter({ getControls: () => controls, createModel: async () => instance });
    const resources = new Live2DModelResources(() => '/project', () => adapter, 'bake');
    let old!: LoadedLive2DModel;
    await resources.loadCharacter('old', 'hero.model.json', async loaded => {
      old = loaded;
      adapter.createModelHandle('old', loaded.model, loaded.runtime).bindRuntimeSource({
        mode: 'bake', injectedParamsSource: { injectedParams: { ParamAngleX: 42 } }, isCurrent: loaded.isCurrent,
      });
    });
    old.release();
    core.update();
    expect(values[0]).toBe(0);
    await resources.loadCharacter('next', 'hero.model.json', async loaded => {
      expect(loaded.model).toBe(instance);
      const source = { injectedParams: { ParamAngleX: 42 } };
      adapter.createModelHandle('next', loaded.model, loaded.runtime).bindRuntimeSource({
        mode: 'bake', injectedParamsSource: source, isCurrent: loaded.isCurrent,
      });
      source.injectedParams = { ParamAngleX: 7 };
      core.update();
    });
    expect(values[0]).toBe(7);
    resources.close();
    values[0] = 0;
    core.update();
    expect(values[0]).toBe(0);
  });

  it('discards every acquired child when composite assembly fails after installing a sync hook', async () => {
    const { resources, adapter, controls } = fixture('bake');
    const registry = new WmdlConfigRegistry();
    registry.register('hero.wmdl', {
      modelRelativePath: 'torso.model.json',
      subModels: [{ modelRelativePath: 'face.model.json' }, { modelRelativePath: 'arms.model.json' }],
    });
    resources.setWmdlConfigRegistry(registry);
    const torso = makeModel();
    const face = Object.assign(makeModel(), { internalModel: { coreModel: { loadParam: vi.fn() } } });
    const lockedCore = {};
    Object.defineProperty(lockedCore, 'loadParam', { value: vi.fn(), writable: false });
    const arms = Object.assign(makeModel(), { internalModel: { coreModel: lockedCore } });
    vi.mocked(adapter.createModel).mockResolvedValueOnce(torso).mockResolvedValueOnce(face).mockResolvedValueOnce(arms);
    const deliver = vi.fn(async () => {});
    await expect(resources.loadCharacter('hero', 'hero.wmdl', deliver)).rejects.toThrow();
    expect(deliver).not.toHaveBeenCalled();
    expect(controls.disposeModel).toHaveBeenCalledTimes(3);
    for (const instance of [torso, face, arms]) {
      expect(controls.disposeModel).toHaveBeenCalledWith(instance, expect.objectContaining({ mode: 'soft-detach' }));
    }
    expect(await borrow(resources, 'face', 'face.model.json')).not.toBe(face);
  });

  it('keeps a cancelled partial composite reusable without repeating SDK creation', async () => {
    const { resources, adapter, controls } = fixture('bake');
    const registry = new WmdlConfigRegistry();
    registry.register('hero.wmdl', {
      modelRelativePath: 'torso.model.json', subModels: [{ modelRelativePath: 'face.model.json' }],
    });
    resources.setWmdlConfigRegistry(registry);
    const torso = makeModel();
    const face = makeModel();
    const faceReady = deferred<Live2DResourceModel>();
    vi.mocked(adapter.createModel).mockResolvedValueOnce(torso).mockReturnValueOnce(faceReady.promise);
    const deliver = vi.fn(async () => {});
    const pending = resources.loadCharacter('hero', 'hero.wmdl', deliver);
    await vi.waitFor(() => expect(adapter.createModel).toHaveBeenCalledTimes(2));
    resources.cancelLoads();
    faceReady.resolve(face);
    await pending;
    expect(deliver).not.toHaveBeenCalled();
    expect(controls.disposeModel).not.toHaveBeenCalled();
    const composite = await borrow(resources, 'hero', 'hero.wmdl');
    expect(composite).toBeInstanceOf(Live2DCompositeModel);
    expect(controls.getConcreteModels(composite)).toEqual([torso, face]);
    expect(adapter.createModel).toHaveBeenCalledTimes(2);
    resources.close();
  });

  it('stops composite acquisition when the main SDK model fails', async () => {
    const { resources, adapter, controls } = fixture('bake');
    const registry = new WmdlConfigRegistry();
    registry.register('hero.wmdl', {
      modelRelativePath: 'torso.model.json', subModels: [{ modelRelativePath: 'face.model.json' }],
    });
    resources.setWmdlConfigRegistry(registry);
    vi.mocked(adapter.createModel).mockRejectedValueOnce(new Error('main SDK failure'));
    const deliver = vi.fn(async () => {});
    await expect(resources.loadCharacter('hero', 'hero.wmdl', deliver)).rejects.toThrow('main SDK failure');
    expect(deliver).not.toHaveBeenCalled();
    expect(adapter.createModel).toHaveBeenCalledTimes(1);
    resources.close();
    expect(controls.disposeModel).not.toHaveBeenCalled();
  });

  it('continues a composite after child SDK failure and reclaims the successful children once', async () => {
    const { resources, adapter, controls } = fixture('bake');
    const registry = new WmdlConfigRegistry();
    registry.register('hero.wmdl', {
      modelRelativePath: 'torso.model.json',
      subModels: [{ modelRelativePath: 'broken.model.json' }, { modelRelativePath: 'face.model.json' }],
    });
    resources.setWmdlConfigRegistry(registry);
    const torso = makeModel();
    const face = makeModel();
    vi.mocked(adapter.createModel).mockResolvedValueOnce(torso)
      .mockRejectedValueOnce(new Error('child SDK failure')).mockResolvedValueOnce(face);
    const composite = await borrow(resources, 'hero', 'hero.wmdl');
    expect(controls.getConcreteModels(composite)).toEqual([torso, face]);
    resources.close();
    expect(controls.disposeModel).toHaveBeenCalledTimes(2);
    expect(composite.destroyed).toBe(true);
  });

  it('uses the actual Cubism 2 adapter soft-detach policy even when runtime detection is unknown', async () => {
    const { resources, controls } = fixture('bake');
    vi.spyOn(runtimeResolver, 'resolveLive2DRuntimeDescriptor').mockReturnValue({
      runtimeFamily: 'unknown', adapterId: 'unknown', supported: true,
    });
    const instance = await borrow(resources, 'hero');
    resources.close();
    expect(controls.disposeModel).toHaveBeenCalledExactlyOnceWith(instance,
      expect.objectContaining({ mode: 'soft-detach', keepTextures: true, detach: true }));
  });

  it('discards an undelivered bake instance after model preparation fails', async () => {
    const { resources, adapter, controls } = fixture('bake');
    adapter.id = 'untitled-pixi-live2d-engine-cubism';
    const instance = makeModel();
    vi.mocked(adapter.createModel).mockResolvedValueOnce(instance);
    await expect(resources.loadCharacter('hero', 'hero.model3.json', async () => {
      throw new Error('bake preparation failed');
    })).rejects.toThrow('bake preparation failed');
    expect(controls.disposeModel).toHaveBeenCalledExactlyOnceWith(instance,
      expect.objectContaining({ mode: 'destroy', keepTextures: true, detach: true }));
    expect(await borrow(resources, 'retry', 'hero.model3.json')).not.toBe(instance);
    expect(adapter.createModel).toHaveBeenCalledTimes(2);
    resources.close();
  });

  it('shares concurrent character loads and resets a returned instance before reuse', async () => {
    const { resources, adapter } = fixture();
    const ready = deferred<Live2DResourceModel>();
    vi.mocked(adapter.createModel).mockReturnValueOnce(ready.promise);
    const deliver = vi.fn(async (loaded: LoadedLive2DModel) => { rememberBorrowing(loaded); });
    const requests = Array.from({ length: 3 }, () => resources.loadCharacter('hero', 'hero.model.json', deliver));
    await vi.waitFor(() => expect(adapter.createModel).toHaveBeenCalledTimes(1));
    const model = makeModel();
    ready.resolve(model);
    await Promise.all(requests);
    expect(deliver).toHaveBeenCalledTimes(1);

    model.visible = true;
    model.alpha = 0.5;
    model.renderable = false;
    Reflect.set(model, '_characterEntry', { id: 'old-owner' });
    releaseBorrowed(model);
    releaseBorrowed(model);
    const reused = await borrow(resources, 'next');
    expect(reused).toBe(model);
    expect(reused.visible).toBe(false);
    expect(reused.alpha).toBe(0);
    expect(reused.renderable).toBe(true);
    expect(Reflect.has(reused, '_characterEntry')).toBe(false);
    expect(adapter.createModel).toHaveBeenCalledTimes(1);
  });

  it('reclaims a cancelled late creation and serializes queued replacements', async () => {
    const { resources, adapter } = fixture();
    const ready = deferred<Live2DResourceModel>();
    vi.mocked(adapter.createModel).mockReturnValueOnce(ready.promise);
    const oldDelivery = vi.fn(async () => {});
    const old = resources.loadCharacter('hero', 'hero.model.json', oldDelivery);
    await vi.waitFor(() => expect(adapter.createModel).toHaveBeenCalledTimes(1));
    resources.cancelLoad('hero');
    const replacement = vi.fn(async () => {});
    const queued = Array.from({ length: 3 }, () => resources.loadCharacter('hero', 'hero.model.json', replacement));
    const model = makeModel();
    ready.resolve(model);
    await Promise.all([old, ...queued]);
    expect(oldDelivery).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(replacement).toHaveBeenCalledWith(expect.objectContaining({ model }));
    expect(adapter.createModel).toHaveBeenCalledTimes(1);
  });

  it('waits for a shared preload and leaves it reusable when the waiting entrance is cancelled', async () => {
    const { resources, adapter } = fixture();
    const ready = deferred<Live2DResourceModel>();
    vi.mocked(adapter.createModel).mockReturnValueOnce(ready.promise);
    const url = resources.pathToUrl('hero.model.json');
    const preloads = [resources.preloadModel(url), resources.preloadModel(url)];
    await vi.waitFor(() => expect(adapter.createModel).toHaveBeenCalledTimes(1));
    const deliver = vi.fn(async () => {});
    const entrance = resources.loadCharacter('hero', 'hero.model.json', deliver);
    resources.cancelLoad('hero');
    const model = makeModel();
    ready.resolve(model);
    await Promise.all([...preloads, entrance]);
    expect(deliver).not.toHaveBeenCalled();
    expect(await borrow(resources, 'next')).toBe(model);
    expect(adapter.createModel).toHaveBeenCalledTimes(1);
  });

  it('returns an instance when stage preparation throws or is cancelled during delivery', async () => {
    const { resources, adapter } = fixture();
    await expect(resources.loadCharacter('hero', 'hero.model.json', async () => {
      throw new Error('stage setup failed');
    })).rejects.toThrow('stage setup failed');
    const model = await borrow(resources, 'retry');
    releaseBorrowed(model);
    const warmup = deferred<void>();
    const started = deferred<void>();
    const load = resources.loadCharacter('warmup', 'hero.model.json', async loaded => {
      started.resolve();
      await warmup.promise;
      expect(loaded.isCurrent()).toBe(false);
    });
    await started.promise;
    resources.cancelLoad('warmup');
    warmup.resolve();
    await load;
    expect(await borrow(resources, 'last')).toBe(model);
    expect(adapter.createModel).toHaveBeenCalledTimes(1);
  });

  it('does not reclaim a returned instance that another character borrowed before cancellation settled', async () => {
    const { resources, adapter } = fixture();
    let replacement!: Live2DResourceModel;
    await resources.loadCharacter('old', 'hero.model.json', async loaded => {
      resources.cancelLoad('old');
      loaded.release();
      replacement = await borrow(resources, 'replacement');
      expect(replacement).toBe(loaded.model);
    });
    const third = await borrow(resources, 'third');
    expect(third).not.toBe(replacement);
    expect(adapter.createModel).toHaveBeenCalledTimes(2);
  });

  it('keeps cancelled work drainable after clear and protects a newer load of the same character', async () => {
    const { resources, adapter, controls } = fixture();
    const oldReady = deferred<Live2DResourceModel>();
    const newReady = deferred<Live2DResourceModel>();
    vi.mocked(adapter.createModel).mockReturnValueOnce(oldReady.promise).mockReturnValueOnce(newReady.promise);
    const oldDelivery = vi.fn(async () => {});
    const old = resources.loadCharacter('hero', 'hero.model.json', oldDelivery);
    await vi.waitFor(() => expect(adapter.createModel).toHaveBeenCalledTimes(1));
    const staleQueuedDelivery = vi.fn(async () => {});
    const staleQueued = resources.loadCharacter('hero', 'hero.model.json', staleQueuedDelivery);
    resources.clear();
    expect(resources.hasPendingLoads).toBe(true);
    const newDelivery = vi.fn(async () => {});
    const next = resources.loadCharacter('hero', 'hero.model.json', newDelivery);
    await vi.waitFor(() => expect(adapter.createModel).toHaveBeenCalledTimes(2));
    const drained = vi.fn();
    const drain = resources.waitForLoads().then(drained);
    const oldModel = makeModel();
    oldReady.resolve(oldModel);
    await Promise.all([old, staleQueued]);
    expect(oldDelivery).not.toHaveBeenCalled();
    expect(staleQueuedDelivery).not.toHaveBeenCalled();
    expect(controls.disposeModel).toHaveBeenCalledWith(oldModel, expect.objectContaining({ keepTextures: true }));
    expect(drained).not.toHaveBeenCalled();
    resources.cancelLoad('hero');
    newReady.resolve(makeModel());
    await Promise.all([next, drain]);
    expect(newDelivery).not.toHaveBeenCalled();
    expect(resources.hasPendingLoads).toBe(false);
  });

  it('prevents a stale preload from repopulating or deleting a newer preload after clear', async () => {
    const { resources, adapter, controls } = fixture();
    const oldReady = deferred<Live2DResourceModel>();
    const newReady = deferred<Live2DResourceModel>();
    vi.mocked(adapter.createModel).mockReturnValueOnce(oldReady.promise).mockReturnValueOnce(newReady.promise);
    const url = resources.pathToUrl('hero.model.json');
    const old = resources.preloadModel(url);
    await vi.waitFor(() => expect(adapter.createModel).toHaveBeenCalledTimes(1));
    resources.clear();
    const next = resources.preloadModel(url);
    await vi.waitFor(() => expect(adapter.createModel).toHaveBeenCalledTimes(2));
    const oldModel = makeModel();
    oldReady.resolve(oldModel);
    await old;
    const joined = resources.preloadModel(url);
    const newModel = makeModel();
    newReady.resolve(newModel);
    await Promise.all([next, joined]);
    expect(controls.disposeModel).toHaveBeenCalledWith(oldModel, expect.objectContaining({ keepTextures: true }));
    expect(await borrow(resources, 'hero')).toBe(newModel);
    expect(adapter.createModel).toHaveBeenCalledTimes(2);
  });

  it('preloads composed children, reuses a whole composite, and disposes each child once', async () => {
    const { resources, adapter, controls } = fixture();
    const registry = new WmdlConfigRegistry();
    registry.register('hero.wmdl', {
      modelRelativePath: 'torso.model.json',
      subModels: [{ modelRelativePath: 'face.model.json', offsetX: 12, offsetY: 34 }],
    });
    resources.setWmdlConfigRegistry(registry);
    await resources.preloadModel(resources.pathToUrl('hero.wmdl'));
    const composite = await borrow(resources, 'hero', 'hero.wmdl');
    expect(composite).toBeInstanceOf(Live2DCompositeModel);
    if (!(composite instanceof Live2DCompositeModel)) throw new Error('Expected composite');
    expect(composite.subModels[0].position).toMatchObject({ x: 12, y: 34 });
    expect(adapter.createModel).toHaveBeenCalledTimes(2);
    const children: Live2DResourceModel[] = composite.getAllModels();
    const destroySpies = children.map(child => vi.spyOn(child, 'destroy'));
    releaseBorrowed(composite);
    expect(await borrow(resources, 'next', 'hero.wmdl')).toBe(composite);
    releaseBorrowed(composite);
    resources.clear();
    expect(composite.destroyed).toBe(true);
    expect(controls.disposeModel).toHaveBeenCalledTimes(2);
    destroySpies.forEach(destroy => expect(destroy).toHaveBeenCalledTimes(1));
  });

  it('counts pooled and borrowed textures by concrete URL when a composite pool overflows', async () => {
    const { resources, controls } = fixture();
    const registry = new WmdlConfigRegistry();
    registry.register('hero.wmdl', { modelRelativePath: 'torso.model.json' });
    resources.setWmdlConfigRegistry(registry);
    const composites: Live2DResourceModel[] = [];
    for (let index = 0; index < 10; index++) {
      composites.push(await borrow(resources, `hero-${index}`, 'hero.wmdl'));
    }
    registry.register('hero.wmdl', {
      modelRelativePath: 'torso.model.json',
      subModels: [{ modelRelativePath: 'unique-face.model.json' }],
    });
    const overflow = await borrow(resources, 'overflow', 'hero.wmdl');
    if (!(overflow instanceof Live2DCompositeModel)) throw new Error('Expected composite');
    const torso: Live2DResourceModel = overflow.mainModel;
    const face: Live2DResourceModel = overflow.subModels[0];
    composites.forEach(model => releaseBorrowed(model));
    releaseBorrowed(overflow);
    expect(controls.disposeModel).toHaveBeenCalledWith(torso, expect.objectContaining({ keepTextures: true }));
    expect(controls.disposeModel).toHaveBeenCalledWith(face, expect.objectContaining({ keepTextures: false }));
    expect(overflow.destroyed).toBe(true);
    releaseBorrowed(overflow);
    expect(controls.disposeModel).toHaveBeenCalledTimes(2);
  });

  it('reclaims every partial composite when clear interrupts submodel creation', async () => {
    const { resources, adapter, controls } = fixture();
    const registry = new WmdlConfigRegistry();
    registry.register('hero.wmdl', {
      modelRelativePath: 'torso.model.json',
      subModels: [{ modelRelativePath: 'face.model.json' }],
    });
    resources.setWmdlConfigRegistry(registry);
    const torso = makeModel();
    const face = makeModel();
    const faceReady = deferred<Live2DResourceModel>();
    vi.mocked(adapter.createModel).mockResolvedValueOnce(torso).mockReturnValueOnce(faceReady.promise);
    const deliver = vi.fn(async () => {});
    const load = resources.loadCharacter('hero', 'hero.wmdl', deliver);
    await vi.waitFor(() => expect(adapter.createModel).toHaveBeenCalledTimes(2));
    resources.clear();
    faceReady.resolve(face);
    await load;
    expect(deliver).not.toHaveBeenCalled();
    expect(controls.disposeModel).toHaveBeenCalledTimes(2);
    for (const model of [torso, face]) {
      expect(controls.disposeModel).toHaveBeenCalledWith(model, expect.objectContaining({ keepTextures: true }));
    }
  });

  it('clears each pooled runtime with its own adapter and preserves shared textures', async () => {
    const legacy = fixture();
    const modern = fixture();
    const resources = new Live2DModelResources(() => '/project', runtime =>
      runtime.runtimeFamily === 'cubism3-plus' ? modern.adapter : legacy.adapter);
    const legacyModel = await borrow(resources, 'legacy');
    const modernModel = await borrow(resources, 'modern', 'hero.model3.json');
    releaseBorrowed(legacyModel);
    releaseBorrowed(modernModel);
    resources.clear();
    expect(legacy.controls.disposeModel).toHaveBeenCalledExactlyOnceWith(legacyModel,
      expect.objectContaining({ keepTextures: true }));
    expect(modern.controls.disposeModel).toHaveBeenCalledExactlyOnceWith(modernModel,
      expect.objectContaining({ keepTextures: true }));
  });
});
