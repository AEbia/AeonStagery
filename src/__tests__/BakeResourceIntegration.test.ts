// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { BakeEngine } from '../engine/BakeEngine';
import { SCENE_SCHEMA_VERSION, type PreparedCompiledScene } from '../api/types/semantic-scene';
import * as runtimeAdapters from '../engine/Live2DRuntimeAdapter';
import { Live2DModelResources, type Live2DResourceModel } from '../engine/Live2DModelResources';
import { WmdlConfigRegistry } from '../engine/WmdlConfigRegistry';
import { mockAdapter, mockControls } from './helpers/mockLive2DRuntimeAdapter';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

function model(): Live2DResourceModel {
  return Object.assign(new PIXI.Container(), {
    anchor: new PIXI.ObservablePoint({ _onUpdate: () => {} }, 0, 0),
  });
}

function scene(): PreparedCompiledScene {
  return {
    kind: 'prepared-compiled-scene', sourceSchemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'resource-bake', meta: { title: 'Resource bake' }, durationSeconds: 0,
    actions: [{ id: 'enter', time: 0, action: 'addCharacter',
      params: { id: 'hero', model: { source: 'hero.model.json', runtimeUri: 'asset://localhost/project/hero.model.json' } },
      source: { statementId: 'hero', outputKey: 'primary' },
    }],
  };
}

function fixture(registry?: WmdlConfigRegistry) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ model: 'hero.moc' }) })));
  const controls = mockControls({
    captureSnapshot: () => ({ params: new Float32Array([0.25]), opacities: new Float32Array([1]) }),
  });
  const adapter = mockAdapter({ createTestControls: () => controls, createModel: vi.fn(async () => model()) });
  vi.spyOn(runtimeAdapters, 'getLive2DRuntimeAdapter').mockReturnValue(adapter);
  const engine = new BakeEngine({ renderer: {} } as unknown as PIXI.Application, registry);
  const bake = (token: number) => engine.bakePreparedRange(scene(), new Map(), token, 0, 0, 0.1, undefined, true);
  return { engine, adapter, controls, bake };
}

describe('Bake resource integration', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('permanently closes during creation without publishing models or snapshots', async () => {
    const { engine, adapter, controls, bake } = fixture();
    const ready = deferred<Live2DResourceModel>();
    vi.mocked(adapter.createModel).mockReturnValueOnce(ready.promise);
    const pending = bake(1);
    await vi.waitFor(() => expect(adapter.createModel).toHaveBeenCalledTimes(1));
    engine.destroy();
    const late = model();
    ready.resolve(late);
    expect((await pending).snapshotHistory).toEqual([]);
    await engine.waitForLoads();
    expect(controls.disposeModel).toHaveBeenCalledWith(late, expect.objectContaining({ mode: 'soft-detach' }));
    expect(controls.prepareModel).not.toHaveBeenCalled();
    expect((await bake(2)).snapshotHistory).toEqual([]);
    expect(adapter.createModel).toHaveBeenCalledTimes(1);
  });

  it('keeps a late cancelled instance reusable for another bake with the same caller token', async () => {
    const { engine, adapter, controls, bake } = fixture();
    const ready = deferred<Live2DResourceModel>();
    vi.mocked(adapter.createModel).mockReturnValueOnce(ready.promise);
    const pending = bake(1);
    await vi.waitFor(() => expect(adapter.createModel).toHaveBeenCalledTimes(1));
    engine.cancel();
    const retry = bake(1);
    ready.resolve(model());
    expect((await pending).snapshotHistory).toEqual([]);
    expect((await retry).snapshotHistory[0].models.get('hero')?.params[0]).toBe(0.25);
    expect(adapter.createModel).toHaveBeenCalledTimes(1);
    expect(controls.disposeModel).not.toHaveBeenCalled();
    engine.destroy();
  });

  it('checks validity after idle preparation and reuses its returned instance', async () => {
    const { engine, adapter, controls, bake } = fixture();
    const idle = deferred<void>();
    vi.mocked(controls.flushIdleState).mockReturnValueOnce(idle.promise);
    const pending = bake(1);
    await vi.waitFor(() => expect(controls.flushIdleState).toHaveBeenCalledTimes(1));
    engine.cancel();
    idle.resolve();
    expect((await pending).snapshotHistory).toEqual([]);
    expect(controls.prepareModel).not.toHaveBeenCalled();
    expect((await bake(2)).snapshotHistory).toHaveLength(1);
    expect(adapter.createModel).toHaveBeenCalledTimes(1);
    expect((await bake(3)).snapshotHistory).toHaveLength(1);
    expect(adapter.createModel).toHaveBeenCalledTimes(1);
    engine.destroy();
  });

  it('generates snapshots from a separate model while Stage keeps its own borrowing', async () => {
    const { engine, adapter, bake } = fixture();
    const stage = new Live2DModelResources(() => '/project', () => adapter);
    let stageModel!: Live2DResourceModel;
    await stage.loadCharacter('hero', 'hero.model.json', async loaded => { stageModel = loaded.model; });
    const result = await bake(1);
    expect(result.snapshotHistory[0].models.get('hero')?.params[0]).toBe(0.25);
    expect(adapter.createModel).toHaveBeenCalledTimes(2);
    engine.destroy();
    expect(stageModel.destroyed).toBe(false);
    stage.close();
  });

  it('uses the prepared source identity for registry lookup while loading resolved runtime paths', async () => {
    const registry = new WmdlConfigRegistry();
    registry.register('hero.wmdl', { modelRelativePath: '/project/torso.model.json' });
    const { engine, adapter } = fixture(registry);
    const prepared = scene();
    prepared.actions[0].params.model = { source: 'hero.wmdl', runtimeUri: 'asset://localhost/cache/opaque-entry' };
    const result = await engine.bakePreparedRange(prepared,
      new Map([['hero.wmdl', '/cache/opaque-entry']]), 1, 0, 0, 0.1, undefined, true);
    expect(adapter.createModel).toHaveBeenCalledWith('asset://localhost//project/torso.model.json', expect.anything());
    expect(result.snapshotHistory).toHaveLength(1);
    engine.destroy();
  });

  it('reclaims borrowed ownership immediately on close and waits for pending preparation', async () => {
    const { engine, adapter, controls, bake } = fixture();
    const idle = deferred<void>();
    vi.mocked(controls.flushIdleState).mockReturnValueOnce(idle.promise);
    const pending = bake(1);
    await vi.waitFor(() => expect(controls.flushIdleState).toHaveBeenCalledTimes(1));
    engine.destroy();
    expect(controls.disposeModel).toHaveBeenCalledTimes(1);
    const drained = vi.fn();
    const drain = engine.waitForLoads().then(drained);
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    idle.resolve();
    expect((await pending).snapshotHistory).toEqual([]);
    await drain;
    expect(controls.prepareModel).not.toHaveBeenCalled();
    expect((await bake(2)).snapshotHistory).toEqual([]);
    expect(adapter.createModel).toHaveBeenCalledTimes(1);
  });
  it.each([1, -1])('publishes no snapshots after cancellation during simulation with caller token %s', async token => {
    const { engine, controls, bake } = fixture();
    const idle = deferred<void>();
    vi.mocked(controls.restartIdleMotion).mockReturnValueOnce(idle.promise);
    const pending = bake(token);
    await vi.waitFor(() => expect(controls.restartIdleMotion).toHaveBeenCalledTimes(1));
    engine.cancel();
    idle.resolve();
    expect((await pending).snapshotHistory).toEqual([]);
    engine.destroy();
  });
});
