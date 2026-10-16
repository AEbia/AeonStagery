import { describe, expect, it } from 'vitest';
import type * as PIXI from 'pixi.js';
import { Cubism2PixiLive2DModelControls } from '../engine/runtime/Cubism2PixiLive2DModelControls';
import { createLive2DModelHandle } from '../engine/live2d/runtime/Live2DRuntimeControlModule';

const runtime = { runtimeFamily: 'cubism2', adapterId: 'pixi-live2d-display-cubism2', supported: true } as const;

function concrete(initial: number) {
  const params = new Float32Array([initial]);
  const opacities = new Float32Array([1]);
  const internalModel = {
    parameterValues: params, partOpacities: opacities,
    coreModel: { getParameterValues: () => params, saveParam: () => {} },
  };
  return { x: 0, y: 0, scale: { x: 1, y: 1 }, rotation: 0, alpha: 1, internalModel, update: () => { params[0] = 99; opacities[0] = 0; } };
}

function handle(model: object) {
  return createLive2DModelHandle({ id: 'hero', model, runtime, controls: new Cubism2PixiLive2DModelControls() });
}

describe('bound model initialization', () => {
  it('keeps each composite neutral pose across warmup and another borrower', async () => {
    const main = concrete(3);
    const sub = concrete(7);
    const model = {
      visible: true, internalModel: main.internalModel,
      getAllModels: () => [main, sub],
      update: () => { main.update(); sub.update(); },
    };
    const first = handle(model);
    const initialized = await first.initialize({ mode: 'live', isCurrent: () => true });
    expect(initialized.status).toBe('ready');
    if (initialized.status !== 'ready') throw new Error('Expected initialization');
    expect(Array.from(initialized.idleSnapshot!.params)).toEqual([3]);
    expect([main.internalModel.parameterValues[0], sub.internalModel.parameterValues[0]]).toEqual([3, 7]);
    expect(model.visible).toBe(false);
    main.update(); sub.update();
    const borrowed = handle(model);
    await borrowed.initialize({ mode: 'live', isCurrent: () => true });
    expect([main.internalModel.parameterValues[0], sub.internalModel.parameterValues[0]]).toEqual([3, 7]);
    expect([main.internalModel.partOpacities[0], sub.internalModel.partOpacities[0]]).toEqual([1, 1]);
  });
  it('does not start a late idle motion after its lease is cancelled', async () => {
    const main = concrete(3);
    let resolveLoad!: () => void;
    const loaded = new Promise<void>(resolve => { resolveLoad = resolve; });
    const model = {
      ...main,
      internalModel: {
        ...main.internalModel,
        settings: { motions: { idle: [{}] } },
        motionManager: {
          loadMotion: () => loaded,
          startMotion: async () => { main.internalModel.parameterValues[0] = 35; },
          stopAllMotions: () => {},
        },
      },
    };
    let current = true;
    const pending = handle(model).initialize({ mode: 'live', isCurrent: () => current });
    current = false;
    main.internalModel.parameterValues[0] = 65;
    resolveLoad();
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(main.internalModel.parameterValues[0]).toBe(65);
  });

  it('warms Bake before capturing its main-model baseline', async () => {
    const main = concrete(3);
    const initialized = await handle(main).initialize({
      mode: 'bake', renderer: {} as PIXI.Renderer, isCurrent: () => true,
    });
    expect(initialized.status).toBe('ready');
    if (initialized.status !== 'ready') throw new Error('Expected initialization');
    expect(Array.from(initialized.idleSnapshot!.params)).toEqual([99]);
  });

  it('resets Bake to its captured idle pose while retaining submodel neutral poses', async () => {
    const main = concrete(3);
    const sub = concrete(7);
    const model = { ...main, getAllModels: () => [main, sub], update: () => { main.update(); sub.update(); } };
    const bound = handle(model);
    const initialized = await bound.initialize({ mode: 'bake', renderer: {} as PIXI.Renderer, isCurrent: () => true });
    if (initialized.status !== 'ready') throw new Error('Expected initialization');
    main.internalModel.parameterValues[0] = 25;
    sub.internalModel.parameterValues[0] = 35;
    bound.resetRuntimeState({ pose: 'idle', idleSnapshot: initialized.idleSnapshot });
    expect([main.internalModel.parameterValues[0], sub.internalModel.parameterValues[0]]).toEqual([99, 7]);
  });

});
