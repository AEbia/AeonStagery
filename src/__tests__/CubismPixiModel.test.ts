import { describe, expect, it, vi } from 'vitest';
import { createCubismModelFixture } from './helpers/cubismModelFixture';
import { CubismPixiLive2DAdapter } from '../engine/Live2DRuntimeAdapter';
import { refreshCubismCoreViews } from '../engine/CubismPixiModel';

describe('Cubism Pixi runtime controls', () => {
  it('computes geometry before render and applies mouth injection after expressions without saving it', () => {
    const { model, internal, core, drawn, saved } = createCubismModelFixture();
    internal.on('expressionUpdate', () => core.setParameterValueByIndex(3, 0.2));
    model._characterEntry = { injectedParams: { ParamMouthOpenY: 0.85 } };
    model.update(16);
    expect(drawn()[3]).toBeCloseTo(0.85);
    expect(saved()[3]).toBeCloseTo(0);
    expect(core.update).toHaveBeenCalledOnce();
    expect(model.deltaTime).toBe(0);
  });
  it('preserves a restored motion baseline across native loadParameters calls', () => {
    const { model, drawn, saved } = createCubismModelFixture();
    const snapshot = { params: new Float32Array([1, 1, 0, 0, 12]), opacities: new Float32Array([0.6]) };
    model.applyRuntimeSnapshot(snapshot);
    model.update(16);
    expect(drawn()[4]).toBeCloseTo(12);
    expect(saved()[4]).toBeCloseTo(12);
    expect(model.internalModel.partOpacities[0]).toBeCloseTo(0.6);
  });
  it('returns native parameter names, expression names and runtime identity through the existing handle', () => {
    const { model } = createCubismModelFixture();
    const handle = new CubismPixiLive2DAdapter().createModelHandle('haru', model);
    expect(handle.parameters.getParameterValues()?.[0].name).toBe('ParamEyeLOpen');
    expect(handle.expression.getAvailableExpressions()).toEqual(['smile']);
    expect(handle.snapshot.captureSnapshot()?.adapterId).toBe('untitled-pixi-live2d-engine-cubism');
  });
  it('starts with blink disabled and matches blink and breath poses on repeated seeks', async () => {
    const { model, drawn } = createCubismModelFixture();
    model.update(800);
    expect(drawn()[0]).toBe(1);
    model.setBlink(true, 1000, 0.8, 0);
    await model.restoreAtSceneTime({ id: 'haru', targetSceneTime: 0.8 });
    const first = drawn().slice();
    await model.restoreAtSceneTime({ id: 'haru', targetSceneTime: 0.8 });
    expect(drawn()).toEqual(first);
    expect(first[0]).toBeCloseTo(0);
    model.setBlink(false, 1000, 0.8, 0);
    model.update(0);
    expect(drawn()[0]).toBe(1);
  });
  it('evaluates breath every frame even when a resource motion writes that parameter', () => {
    const { model, internal, core, drawn } = createCubismModelFixture();
    internal.on('afterMotionUpdate', () => core.setParameterValueByIndex(2, 0));
    model.update(16);
    const first = drawn()[2];
    model.update(100);
    expect(drawn()[2]).not.toBe(first);
    expect(drawn()[2]).toBeGreaterThan(0.5);
  });
  it('cancels an expression load when a newer expression reset takes ownership', async () => {
    const { model, expressionManager } = createCubismModelFixture();
    let resolve!: (value: object) => void;
    expressionManager.loadExpression.mockReturnValue(new Promise((done) => { resolve = done; }));
    const pending = model.setExpressionForSeek('smile');
    await model.setExpressionForSeek(null);
    resolve({});
    await pending;
    expect(expressionManager.setExpression).not.toHaveBeenCalled();
    expect(model.captureRuntimeSnapshot('haru').expression.key).toBeNull();
  });
  it('cancels in-flight expression writes when the model is disposed', async () => {
    const { model, expressionManager, internal } = createCubismModelFixture();
    let resolve!: (value: object) => void;
    expressionManager.loadExpression.mockReturnValue(new Promise((done) => { resolve = done; }));
    const pending = model.setExpressionForSeek('smile');
    model.destroy();
    resolve({});
    await pending;
    expect(expressionManager.setExpression).not.toHaveBeenCalled();
    expect(internal.listenerCount('beforeModelUpdate')).toBe(0);
  });
  it('uses the Pixi v8 render target contract for bake and releases its private target on disposal', () => {
    const { model } = createCubismModelFixture();
    const renderer = { render: vi.fn() };
    model.renderForBake(renderer);
    const target = renderer.render.mock.calls[0][0].target;
    expect(renderer.render).toHaveBeenCalledWith({ container: model, target, clear: true });
    model.destroy();
    expect(target.destroyed).toBe(true);
  });
  it('reports a missing motion instead of silently claiming a native seek succeeded', async () => {
    const { model } = createCubismModelFixture();
    const result = await model.restoreAtSceneTime({ id: 'haru', targetSceneTime: 1, motion: { key: 'missing', offset: 1, sceneTime: 1 } });
    expect(result.status).toBe('fallback');
    expect(result.diagnostics).toEqual(['Motion "missing" was not available.']);
  });
  it('refreshes all cached Core views when the heap grows for another model', () => {
    const initial = new ArrayBuffer(256);
    const grown = initial.slice(0);
    const raw = { _ptr: 8, parameters: { values: new Float32Array(initial, 16, 1) }, renderOrders: new Int32Array(initial, 32, 1) };
    const core: any = { getModel: () => raw };
    class Parameters {
      values = new Float32Array(grown, 16, 1);
      minimumValues = new Float32Array(grown, 40, 1);
      maximumValues = new Float32Array(grown, 44, 1);
    }
    class Parts { opacities = new Float32Array(grown, 48, 1); }
    class Drawables { vertexPositions = [new Float32Array(grown, 64, 1)]; }
    vi.stubGlobal('Live2DCubismCore', { Parameters, Parts, Drawables, CanvasInfo: class {} });
    try {
      refreshCubismCoreViews(core);
      core._parameterValues[0] = 1.25;
      expect(new Float32Array(grown, 16, 1)[0]).toBe(1.25);
      expect((raw as any).drawables.vertexPositions[0].buffer).toBe(grown);
      expect(raw.renderOrders.buffer).toBe(grown);
    } finally { vi.unstubAllGlobals(); }
  });
});
