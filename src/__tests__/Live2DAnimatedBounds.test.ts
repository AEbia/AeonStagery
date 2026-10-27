// @vitest-environment jsdom
import fs from 'node:fs';
import vm from 'node:vm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import type { Live2DModel } from 'untitled-pixi-live2d-engine';
import { installLive2DRenderPreparation, prepareLive2DGeometry } from '../engine/live2d/runtime/Live2DRenderPreparation';
import { resolveCubismWebCorePath } from './helpers/live2dRuntimeFixture';
import { createCubismModelFixture } from './helpers/cubismModelFixture';
import { installCubismPixiModelRuntime } from '../engine/CubismPixiModel';

const corePath = resolveCubismWebCorePath();
let Model: typeof Live2DModel;
beforeAll(async () => {
  if (!corePath) return;
  vm.runInThisContext(fs.readFileSync(corePath, 'utf8'));
  const sdk = globalThis as typeof globalThis & { Live2DCubismCore?: unknown };
  Object.assign(window, { Live2DCubismCore: sdk.Live2DCubismCore });
  Model = (await import('untitled-pixi-live2d-engine/cubism')).Live2DModel;
});

describe.skipIf(!corePath)('Live2D animated bounds before parent filters', () => {
  it.each([
    { nested: false, adapted: false }, { nested: true, adapted: false },
    { nested: false, adapted: true }, { nested: true, adapted: true },
  ])('includes an extended arm before the parent filter (nested=$nested, adapted=$adapted)', ({ nested, adapted }) => {
    const model = new Model({ autoUpdate: false, autoFocus: false, autoHitTest: false });
    let armRight = 100;
    const update = vi.fn(() => { armRight = 350; });
    const internal: object = adapted ? createCubismModelFixture().internal : {};
    model.internalModel = Object.assign(internal, {
      originalWidth: 100, originalHeight: 200, width: 100, height: 200,
      localTransform: new PIXI.Matrix(),
      getDrawableIDs: () => ['body'], getDrawableIndex: () => 0,
      getDrawableBounds: () => ({ x: 0, y: 0, width: armRight, height: 200 }),
      update,
    }) as unknown as Live2DModel['internalModel'];
    const native = model as unknown as { prepareForRender(): void };
    if (adapted) installCubismPixiModelRuntime(model);
    else installLive2DRenderPreparation(model, () => native.prepareForRender());
    model.anchor.set(0.5, 0.9);
    const character = new PIXI.Container();
    character.filters = [new PIXI.AlphaFilter({ alpha: 0.5 })];
    const composite = nested ? character.addChild(new PIXI.Container()) : character;
    composite.addChild(model);
    expect(character.getBounds().width).toBe(100);
    const pivot = model.pivot.clone();

    model.update(16);
    // Pixi runs onRender before calculating any ancestor's filter bounds.
    model.onRender?.({} as PIXI.Renderer);
    expect(character.getBounds().width).toBe(350);
    expect(update).toHaveBeenCalledTimes(1);
    expect(model.deltaTime).toBe(0);
    expect(model.pivot).toEqual(pivot);
    model.onRender?.({} as PIXI.Renderer);
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe('Live2D render preparation lifecycle', () => {
  it('prepares every concrete child of a composite without running frame hooks', () => {
    const composite = new PIXI.Container();
    const main = composite.addChild(new PIXI.Container());
    const face = composite.addChild(new PIXI.Container());
    const frameHook = vi.fn();
    main.onRender = frameHook;
    const prepareMain = vi.fn();
    const prepareFace = vi.fn();
    installLive2DRenderPreparation(main, prepareMain);
    installLive2DRenderPreparation(face, prepareFace);
    const renderer = {} as PIXI.Renderer;
    prepareLive2DGeometry(composite, renderer);
    expect(prepareMain).toHaveBeenCalledExactlyOnceWith(renderer);
    expect(prepareFace).toHaveBeenCalledExactlyOnceWith(renderer);
    expect(frameHook).not.toHaveBeenCalled();
  });

  it('preserves the existing frame hook and avoids duplicate installation', () => {
    const model = new PIXI.Container();
    const calls: string[] = [];
    model.onRender = function () {
      expect(this).toBe(model);
      calls.push('previous');
    };
    const prepare = vi.fn(() => { calls.push('prepare'); });
    installLive2DRenderPreparation(model, prepare);
    installLive2DRenderPreparation(model, prepare);
    model.onRender?.({} as PIXI.Renderer);
    expect(calls).toEqual(['previous', 'prepare']);
  });
});
