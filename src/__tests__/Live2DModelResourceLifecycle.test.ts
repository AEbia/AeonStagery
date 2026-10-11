import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container, ObservablePoint } from 'pixi.js';
import { Live2DCompositeModel } from '../engine/Live2DCompositeModel';
import { Live2DModelResources, type Live2DResourceModel } from '../engine/Live2DModelResources';
import { WmdlConfigRegistry } from '../engine/WmdlConfigRegistry';
import * as sdk from '../engine/CubismPixiSdk';
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

function fixture() {
  const controls = mockControls({
    getConcreteModels: model => model instanceof Live2DCompositeModel ? model.getAllModels() : [model],
    disposeModel: vi.fn((model: Live2DResourceModel) => model.destroy()),
  });
  const adapter = mockAdapter({
    getControls: () => controls,
    createModel: vi.fn(async () => makeModel()),
  });
  const resources = new Live2DModelResources(() => '/project', () => adapter);
  return { resources, adapter, controls };
}

async function borrow(resources: Live2DModelResources, id: string, path = 'hero.model.json') {
  let model!: Live2DResourceModel;
  await resources.loadCharacter(id, path, async loaded => { model = loaded.model; });
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

  it('shares concurrent character loads and resets a returned instance before reuse', async () => {
    const { resources, adapter } = fixture();
    const ready = deferred<Live2DResourceModel>();
    vi.mocked(adapter.createModel).mockReturnValueOnce(ready.promise);
    const deliver = vi.fn(async () => {});
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
    resources.releaseModel(model);
    resources.releaseModel(model);
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
    resources.releaseModel(model);
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
      resources.releaseModel(loaded.model);
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
    resources.releaseModel(composite);
    expect(await borrow(resources, 'next', 'hero.wmdl')).toBe(composite);
    resources.releaseModel(composite);
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
    composites.forEach(model => resources.releaseModel(model));
    resources.releaseModel(overflow);
    expect(controls.disposeModel).toHaveBeenCalledWith(torso, expect.objectContaining({ keepTextures: true }));
    expect(controls.disposeModel).toHaveBeenCalledWith(face, expect.objectContaining({ keepTextures: false }));
    expect(overflow.destroyed).toBe(true);
    resources.releaseModel(overflow);
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
    resources.releaseModel(legacyModel);
    resources.releaseModel(modernModel);
    resources.clear();
    expect(legacy.controls.disposeModel).toHaveBeenCalledExactlyOnceWith(legacyModel,
      expect.objectContaining({ keepTextures: true }));
    expect(modern.controls.disposeModel).toHaveBeenCalledExactlyOnceWith(modernModel,
      expect.objectContaining({ keepTextures: true }));
  });
});
