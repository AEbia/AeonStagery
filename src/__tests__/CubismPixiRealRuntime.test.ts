import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as PIXI from 'pixi.js';
import { resolveCubismWebCorePath } from './helpers/live2dRuntimeFixture';
import { installCubismPixiModelRuntime } from '../engine/CubismPixiModel';

const corePath = resolveCubismWebCorePath();
const entry = process.env.AEON_CUBISM_TEST_MODEL;
const models: any[] = [];
let engine: any;
function buffer(file: string): ArrayBuffer {
  return new Uint8Array(fs.readFileSync(file)).buffer;
}
async function createModel(eyeBlinkParameters?: string[]) {
  const root = path.dirname(entry!);
  const json = JSON.parse(fs.readFileSync(entry!, 'utf8'));
  json.url = 'file://' + entry;
  if (eyeBlinkParameters) {
    json.Groups = (json.Groups ?? []).filter((group: any) => group.Name !== 'EyeBlink');
    json.Groups.push({ Target: 'Parameter', Name: 'EyeBlink', Ids: eyeBlinkParameters });
  }
  // Model sounds are owned by the app, independently of resource motions.
  for (const defs of Object.values(json.FileReferences.Motions ?? {}) as any[]) {
    for (const definition of defs) delete definition.Sound;
  }
  const runtime = engine.Live2DFactory.runtimes[0];
  const core = runtime.createCoreModel(buffer(path.join(root, json.FileReferences.Moc)));
  const settings = runtime.createModelSettings(json);
  const internal = runtime.createInternalModel(core, settings, { motionPreload: engine.MotionPreloadStrategy.NONE, eyeBlink: false });
  const manager = internal.motionManager;
  for (const [group, definitions] of Object.entries(settings.motions) as [string, any[]][]) {
    manager.motionGroups[group] = definitions.map((definition) => manager.createMotion(buffer(path.join(root, definition.File)), group, definition));
  }
  const em = manager.expressionManager;
  if (em) em.expressions = em.definitions.map((definition: any) => em.createExpression(buffer(path.join(root, definition.File)), definition));
  const model = new engine.Live2DModel({ autoUpdate: false, autoFocus: false });
  model.internalModel = internal;
  internal.physics = json.FileReferences.Physics ? runtime.createPhysics(core, buffer(path.join(root, json.FileReferences.Physics))) : undefined;
  installCubismPixiModelRuntime(model);
  models.push(model);
  return model;
}

function addProbeExpression(model: any) {
  const manager = model.internalModel.motionManager.expressionManager;
  const definition = { Name: 'probe', File: 'probe.exp3.json' };
  const data = new TextEncoder().encode(JSON.stringify({
    FadeInTime: 1, FadeOutTime: 1,
    Parameters: [{ Id: 'ParamAngleX', Value: 20, Blend: 'Overwrite' }],
  })).buffer;
  manager.definitions.push(definition);
  manager.expressions.push(manager.createExpression(data, definition));
}

function addProbeMotion(model: any) {
  const manager = model.internalModel.motionManager;
  const definition = { File: 'probe.motion3.json' };
  manager.definitions.probe = [definition];
  const data = new TextEncoder().encode(JSON.stringify({
    Version: 3,
    Meta: { Duration: 10, Fps: 30, Loop: false, CurveCount: 1, TotalSegmentCount: 1, TotalPointCount: 2, UserDataCount: 0, TotalUserDataSize: 0 },
    Curves: [{ Target: 'Parameter', Id: 'ParamAngleY', Segments: [0, 0, 0, 10, 10] }],
  })).buffer;
  manager.motionGroups.probe = [manager.createMotion(data, 'probe', definition)];
}

describe.skipIf(!corePath || !entry || !fs.existsSync(entry))('real Cubism Core and modern engine', () => {
  beforeAll(async () => {
    const g = globalThis as any;
    vi.stubGlobal('window', g);
    vi.stubGlobal('self', g);
    vi.stubGlobal('WebGLBuffer', class {});
    if (!g.document) vi.stubGlobal('document', { createElement: () => ({ getContext: () => null, style: {} }) });
    vm.runInThisContext(fs.readFileSync(corePath!, 'utf8'), { filename: 'live2dcubismcore.min.js' });
    engine = await import('untitled-pixi-live2d-engine/cubism');
    await engine.cubismReady();
  });
  afterAll(() => { models.forEach((model) => model.destroy()); vi.unstubAllGlobals(); });
  it('loads a moc3 model with only the modern Core and exposes real parameter names and expressions', async () => {
    const model = await createModel();
    model.update(16);
    expect(model.internalModel.coreModel.getParameterIds()).toContain('ParamAngleX');
    expect(model.internalModel.motionManager.expressionManager.definitions.length).toBeGreaterThan(0);
    expect(Array.from(model.internalModel.parameterValues).every(Number.isFinite)).toBe(true);
    expect(model.deltaTime).toBe(0);
  });
  it('sorts native drawables with the Cubism 5 Core render-order API', async () => {
    const model = await createModel();
    model.update(16);
    const core = model.internalModel.coreModel;
    const nativeRenderer = model.internalModel.renderer;
    // Keep the real SDK sorting and visibility logic; only replace GPU work.
    const clippingManager = nativeRenderer._clippingManager;
    const mesh = vi.spyOn(nativeRenderer, 'drawMeshWebGL').mockImplementation(() => {});
    const preDraw = vi.spyOn(nativeRenderer, 'preDraw').mockImplementation(() => {});
    const saveProfile = vi.spyOn(nativeRenderer, 'saveProfile').mockImplementation(() => {});
    const restoreProfile = vi.spyOn(nativeRenderer, 'restoreProfile').mockImplementation(() => {});
    const renderer: any = Object.create(PIXI.WebGLRenderer.prototype);
    Object.assign(renderer, {
      gl: { getParameter: () => null, cullFace() {} }, view: { resolution: 1 },
      geometry: { resetState() {} }, shader: { resetState() {} }, texture: { resetState() {} }, state: { resetState() {} },
      globalUniforms: { globalUniformData: { projectionMatrix: new PIXI.Matrix(), worldTransformMatrix: new PIXI.Matrix(), worldColor: 0xffffffff } },
      renderTarget: { viewport: { x: 0, y: 0, width: 1920, height: 1080 }, renderTarget: { isRoot: false } },
    });
    nativeRenderer._clippingManager = null;
    nativeRenderer.gl = renderer.gl;
    model.gl = renderer.gl;
    try {
      model.renderLive2D(renderer);
      const raw = core.getModel();
      const orders = raw.drawables.renderOrders ?? raw.getRenderOrders();
      const expected = Array.from({ length: core.getDrawableCount() }, (_, i) => i)
        .sort((a, b) => orders[a] - orders[b])
        .filter((i) => core.getDrawableDynamicFlagIsVisible(i));
      expect(mesh.mock.calls.map((call) => call[1])).toEqual(expected);
      expect(expected.length).toBeGreaterThan(0);
    } finally {
      nativeRenderer.gl = null;
      nativeRenderer._clippingManager = clippingManager;
      mesh.mockRestore();
      preDraw.mockRestore();
      saveProfile.mockRestore();
      restoreProfile.mockRestore();
    }
  });
  it('seeks native motion curves and fade weights to the same pose as sequential playback', async () => {
    const model = await createModel();
    const snapshot = model.captureRuntimeSnapshot('haru');
    await model.startMotion('TapBody', 0, 3, 0, 0.5);
    for (let i = 0; i < 30; i++) model.update(1000 / 60);
    const playback = new Float32Array(model.internalModel.parameterValues);
    await model.restoreAtSceneTime({ id: 'haru', targetSceneTime: 0.5, idleSnapshot: snapshot, motion: { key: 'TapBody', offset: 0.5, sceneTime: 0.5, fadeInSeconds: 0.5 } });
    // Physics needs frame replay; authored motion parameters must match.
    const ids = model.internalModel.coreModel.getParameterIds();
    for (const id of ['ParamAngleX', 'ParamAngleY', 'ParamMouthOpenY']) {
      const index = ids.indexOf(id);
      expect(model.internalModel.parameterValues[index]).toBeCloseTo(playback[index], 3);
    }
  });
  it('holds the motion end pose and restores the file fade after a scene override', async () => {
    const model = await createModel();
    const manager = model.internalModel.motionManager;
    const definition = { File: 'probe.motion3.json' };
    manager.definitions.probe = [definition];
    const motionJson = { Version: 3, Meta: { Duration: 1, Fps: 30, Loop: false, CurveCount: 1, TotalSegmentCount: 1, TotalPointCount: 2, UserDataCount: 0, TotalUserDataSize: 0 }, Curves: [{ Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 0, 1, 25] }] };
    const motion = manager.createMotion(new TextEncoder().encode(JSON.stringify(motionJson)).buffer, 'probe', definition);
    manager.motionGroups.probe = [motion];
    const fileFade = motion.getFadeInTime();
    await model.startMotion('probe', 0, 3, 0, 0.15);
    expect(motion.getFadeInTime()).toBe(0.15);
    await model.startMotion('probe', 0, 3, 2);
    expect(motion.getFadeInTime()).toBe(fileFade);
    model.update(0);
    const index = model.internalModel.coreModel.getParameterIds().indexOf('ParamAngleX');
    expect(model.internalModel.parameterValues[index]).toBeCloseTo(25);
    model.update(16);
    expect(model.internalModel.parameterValues[index]).toBeCloseTo(25);
  });
  it.each([0, 0.25, 0.75])('holds a seeked motion fade pose at %ss while paused and continues on playback', async (offset) => {
    const model = await createModel();
    addProbeMotion(model);
    model.internalModel.physics = undefined;
    const baseline = model.captureRuntimeSnapshot('haru');
    const index = model.internalModel.coreModel.getParameterIds().indexOf('ParamAngleY');
    await model.restoreAtSceneTime({
      id: 'haru', targetSceneTime: offset, idleSnapshot: baseline,
      motion: { key: 'probe', offset, sceneTime: offset, fadeInSeconds: 1 },
    });
    const pausedPose = model.internalModel.parameterValues[index];
    expect(pausedPose).toBeCloseTo(offset * (0.5 - 0.5 * Math.cos(Math.PI * offset)), 5);
    for (let i = 0; i < 120; i++) model.update(0);
    expect(model.internalModel.parameterValues[index]).toBeCloseTo(pausedPose, 5);
    model.update(100);
    const resumedTime = offset + 0.1;
    const resumedWeight = 0.5 - 0.5 * Math.cos(Math.PI * resumedTime);
    expect(model.internalModel.parameterValues[index]).toBeCloseTo(pausedPose + (resumedTime - pausedPose) * resumedWeight, 5);
  });
  it('reapplies an expression after reset and survives a second loaded model', async () => {
    const model = await createModel();
    await model.setExpressionForSeek('F01', 1);
    model.update(16);
    await model.setExpressionForSeek(null);
    await model.setExpressionForSeek('F01', 1);
    model.update(16);
    expect(model.captureRuntimeSnapshot('haru').expression.key).toBe('F01');
    await createModel();
    model._characterEntry = { injectedParams: { ParamMouthOpenY: 0.85 } };
    model.update(16);
    const index = model.internalModel.coreModel.getParameterIds().indexOf('ParamMouthOpenY');
    expect(model.internalModel.parameterValues[index]).toBeCloseTo(0.85);
  });
  it.each([false, true])('restores expression fade independently of resource motion (motion=%s)', async (withMotion) => {
    const model = await createModel();
    addProbeExpression(model);
    if (withMotion) addProbeMotion(model);
    const baseline = model.captureRuntimeSnapshot('haru');
    const index = model.internalModel.coreModel.getParameterIds().indexOf('ParamAngleX');
    for (const elapsedSeconds of [0, 0.25, 1]) {
      await model.restoreAtSceneTime({
        id: 'haru', targetSceneTime: 5, idleSnapshot: baseline,
        motion: withMotion ? { key: 'probe', offset: 5, sceneTime: 5 } : null,
        expression: { key: 'probe', elapsedSeconds },
      });
      const weight = 0.5 - 0.5 * Math.cos(elapsedSeconds * Math.PI);
      expect(model.internalModel.parameterValues[index]).toBeCloseTo(20 * weight, 4);
      model.update(100);
      const continuedWeight = 0.5 - 0.5 * Math.cos(Math.min(1, elapsedSeconds + 0.1) * Math.PI);
      expect(model.internalModel.parameterValues[index]).toBeCloseTo(20 * continuedWeight, 4);
    }
    model.update(250);
    expect(model.internalModel.parameterValues[index]).toBeCloseTo(20, 4);
  });
  it('fully latches an expression without timing metadata and releases it on an explicit reset', async () => {
    const model = await createModel();
    addProbeExpression(model);
    const baseline = model.captureRuntimeSnapshot('haru');
    const index = model.internalModel.coreModel.getParameterIds().indexOf('ParamAngleX');
    await model.restoreAtSceneTime({ id: 'haru', targetSceneTime: 5, idleSnapshot: baseline, expression: { key: 'probe' } });
    expect(model.internalModel.parameterValues[index]).toBeCloseTo(20);
    const snapshot = model.captureRuntimeSnapshot('haru');
    await model.restoreAtSceneTime({ id: 'haru', targetSceneTime: 0, idleSnapshot: baseline, snapshot, expression: { key: null } });
    expect(model.internalModel.parameterValues[index]).toBeCloseTo(baseline.params[index]);
    expect(model.captureRuntimeSnapshot('haru').expression.key).toBeNull();
  });
  it('applies a configured EyeBlink group before native geometry evaluation', async () => {
    const model = await createModel(['ParamEyeLSmile', 'ParamEyeLSmile']);
    const core = model.internalModel.coreModel;
    const index = core.getParameterIds().indexOf('ParamEyeLSmile');
    core.setParameterValueByIndex(index, 1);
    core.saveParameters();
    model.setBlink(true, 1000, 0.75, 0);
    model.update(0);
    expect(model.internalModel.parameterValues[index]).toBeCloseTo(0.5);
    model.setBlink(false, 1000, 0.75, 0);
    model.update(0);
    expect(model.internalModel.parameterValues[index]).toBe(1);
  });
  it('composes Pixi model, parent and render-group opacity at the native draw boundary', async () => {
    const model = await createModel();
    model.update(16);
    const stage = new PIXI.Container({ isRenderGroup: true });
    const parent = new PIXI.Container();
    stage.addChild(parent);
    parent.addChild(model);
    const nativeRenderer = model.internalModel.renderer;
    let drawnAlpha = -1;
    model.internalModel.draw = () => { drawnAlpha = nativeRenderer.getModelColor().a; };
    const renderer: any = Object.create(PIXI.WebGLRenderer.prototype);
    Object.assign(renderer, {
      gl: {}, view: { resolution: 1 },
      geometry: { resetState() {} }, shader: { resetState() {} }, texture: { resetState() {} }, state: { resetState() {} },
      globalUniforms: { globalUniformData: { projectionMatrix: new PIXI.Matrix(), worldTransformMatrix: new PIXI.Matrix(), worldColor: 0xffffffff } },
      renderTarget: { viewport: { x: 0, y: 0, width: 1920, height: 1080 }, renderTarget: { isRoot: false } },
    });
    model.gl = renderer.gl;
    try {
      stage.alpha = 0.5;
      parent.alpha = 0.5;
      model.alpha = 0.25;
      PIXI.updateRenderGroupTransforms(stage.renderGroup!, true);
      renderer.globalUniforms.globalUniformData.worldColor = stage.renderGroup!.worldColorAlpha;
      model.renderLive2D(renderer);
      expect(drawnAlpha).toBeCloseTo(0.25 * 0.5 * (127 / 255), 5);
      expect(nativeRenderer.getModelColor().a).toBe(1);
      stage.alpha = parent.alpha = model.alpha = 1;
      parent.filters = [new PIXI.AlphaFilter({ alpha: 0.25 })];
      PIXI.updateRenderGroupTransforms(stage.renderGroup!, true);
      renderer.globalUniforms.globalUniformData.worldColor = stage.renderGroup!.worldColorAlpha;
      model.renderLive2D(renderer);
      // Timeline fades already use AlphaFilter; native drawing must stay opaque here.
      expect(drawnAlpha).toBe(1);

      model.alpha = 0.25;
      PIXI.updateRenderGroupTransforms(stage.renderGroup!, true);
      parent.removeChild(model);
      model.enableRenderGroup();
      PIXI.updateRenderGroupTransforms(model.renderGroup, true);
      renderer.globalUniforms.globalUniformData.worldColor = model.renderGroup.worldColorAlpha;
      model.renderLive2D(renderer);
      // Rendering the model itself to a bake target puts its alpha in the root uniform.
      expect(drawnAlpha).toBeCloseTo(63 / 255, 5);
    } finally {
      parent.filters?.forEach((filter) => filter.destroy());
      model.parent?.removeChild(model);
      stage.destroy({ children: true });
    }
  });
});
