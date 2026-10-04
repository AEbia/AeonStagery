import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { resolveCubismWebCorePath } from './helpers/live2dRuntimeFixture';
import { installCubismPixiModelRuntime } from '../engine/CubismPixiModel';

const corePath = resolveCubismWebCorePath();
const entry = process.env.AEON_CUBISM_TEST_MODEL;
const models: any[] = [];
let engine: any;
function buffer(file: string): ArrayBuffer {
  return new Uint8Array(fs.readFileSync(file)).buffer;
}
async function createModel() {
  const root = path.dirname(entry!);
  const json = JSON.parse(fs.readFileSync(entry!, 'utf8'));
  json.url = 'file://' + entry;
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
});
