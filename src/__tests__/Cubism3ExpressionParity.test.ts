import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { resolveCubismWebCorePath } from './helpers/live2dRuntimeFixture';
import { createCubismModelFixture } from './helpers/cubismModelFixture';
import { CubismPixiLive2DAdapter } from '../engine/Live2DRuntimeAdapter';
import { resolveCubismParameterId } from '../engine/runtime/modelMetadata';
import { submitLive2DBakeFrameBatch } from '../engine/live2d/runtime/Live2DRuntimeControlModule';

interface NativeExpressionManager {
  definitions: { Name: string; File: string }[];
  expressions: object[];
  createExpression(buffer: ArrayBuffer, definition: unknown): object;
  update(core: object, timeSeconds: number): boolean;
}
interface ExpressionSdk {
  cubismReady(): Promise<void>;
  CubismExpressionManager: new (settings: object, options: object) => NativeExpressionManager;
}
const corePath = resolveCubismWebCorePath();
let sdk: ExpressionSdk;

describe.skipIf(!corePath)('Cubism 3+ expression playback and seek', () => {
  beforeAll(async () => {
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('self', globalThis);
    vi.stubGlobal('WebGLBuffer', class {});
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => null, style: {} }) });
    vm.runInThisContext(fs.readFileSync(corePath!, 'utf8'), { filename: 'live2dcubismcore.min.js' });
    sdk = await import('untitled-pixi-live2d-engine/cubism') as unknown as ExpressionSdk;
    await sdk.cubismReady();
  });
  afterAll(() => { vi.unstubAllGlobals(); });

  function character(id: string) {
    const expressions = [{ Name: 'first', File: 'first.exp3.json' }, { Name: 'second', File: 'second.exp3.json' }];
    const manager = new sdk.CubismExpressionManager({ expressions }, {});
    manager.expressions = expressions.map((definition, index) => manager.createExpression(new TextEncoder().encode(JSON.stringify({
      FadeInTime: 1, FadeOutTime: 1,
      Parameters: [{ Id: 'ParamAngleX', Value: index === 0 ? 10 : 20, Blend: 'Overwrite' }],
    })).buffer, definition));
    const { model, internal, core } = createCubismModelFixture(undefined, [], manager);
    const handle = new CubismPixiLive2DAdapter().createModelHandle(id, model);
    const blend = (idValue: unknown, value: number, weight = 1) => {
      const idName = resolveCubismParameterId(idValue);
      const index = handle.parameters.getParameterValues()?.find((parameter) => parameter.name === idName)?.index;
      if (index !== undefined) core.setParameterValueByIndex(index, core.getParameterValueByIndex(index) * (1 - weight) + value * weight);
    };
    Object.assign(core, { setParameterValueById: blend });
    internal.on('expressionUpdate', () => manager.update(core, model.elapsedTime / 1000));
    return handle;
  }

  it.each([0, 0.3, 0.5, 1, 1.2])('reconstructs an expression transition at %ss to the same pose as playback', async (elapsed) => {
    const playback = character('playback');
    const seek = character('seek');
    try {
      await playback.performance.restoreExpression('first', Number.POSITIVE_INFINITY, undefined, () => true);
      playback.expression.setExpression('second');
      await Promise.resolve();
      await Promise.resolve();
      playback.frame.submit({ deltaMs: 0, shouldAdvance: true });
      playback.frame.submit({ deltaMs: elapsed * 1000, shouldAdvance: true });
      await seek.performance.restoreExpression('second', elapsed, 'first', () => true);
      const angle = (handle: typeof playback) => handle.parameters.getParameterValues()?.find((parameter) => parameter.name === 'ParamAngleX')?.value;
      expect(angle(playback)).toBeGreaterThanOrEqual(10);
      expect(angle(seek)).toBeCloseTo(angle(playback)!, 5);
    } finally {
      playback.dispose({ mode: 'destroy' });
      seek.dispose({ mode: 'destroy' });
    }
  });

  it('awaits the expression and commits its authored fade in the Bake frame', async () => {
    const bake = character('bake');
    const seek = character('seek');
    try {
      await submitLive2DBakeFrameBatch({
        operations: [{ handle: bake, sceneTimeSeconds: 0.3, isCurrent: () => true,
          expressionState: { key: 'second', elapsedSeconds: 0.3, previousKey: 'first' } }],
        deltaMs: 1000 / 30, isCurrent: () => true,
      });
      await seek.performance.restoreExpression('second', 0.3, 'first', () => true);
      const angle = (handle: typeof bake) => handle.parameters.getParameterValues()?.find((parameter) => parameter.name === 'ParamAngleX')?.value;
      expect(angle(bake)).toBeCloseTo(angle(seek)!, 5);
      expect(angle(bake)).toBeGreaterThan(10);
    } finally {
      bake.dispose({ mode: 'destroy' });
      seek.dispose({ mode: 'destroy' });
    }
  });
});
