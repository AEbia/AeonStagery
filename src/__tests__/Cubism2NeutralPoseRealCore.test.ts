// @vitest-environment jsdom
import fs from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getLive2DRuntimeAdapter } from '../engine/Live2DRuntimeAdapter';
import { captureModelNeutralPoseOnce, resetModelToNeutralPose } from '../engine/live2d/characterStatePurge';
import Live2DManager from '../engine/Live2DManager';
import { CharacterSynchronizer } from '../engine/coordinators/CharacterSynchronizer';
import { ProxyRegistry } from '../engine/coordinators/ProxyRegistry';
import { loadLive2DEngineModule } from '../engine/Live2DEngineBridge';
import { resolveCubism2CorePath } from './helpers/live2dRuntimeFixture';

const runtime = { runtimeFamily: 'cubism2', adapterId: 'pixi-live2d-display-cubism2', supported: true } as const;

// The Cubism 2.1 core is not committed (ADR-0035). Without a staged runtime the
// contract this file pins cannot be exercised, so the suite skips instead of
// failing — but it stays active whenever a runtime is staged.
const cubism2CorePath = resolveCubism2CorePath();

let VendorModel: any;
beforeAll(async () => {
  if (!cubism2CorePath) return;
  new Function(fs.readFileSync(cubism2CorePath, 'utf8'))();
  (window as any).Live2D = (globalThis as any).Live2D;
  VendorModel = (await loadLive2DEngineModule()).Live2DModel;
});

function createModel() {
  const core = new (globalThis as any).Live2DModelWebGL();
  core.setParamFloat('PARAM_ANGLE_X', 0);
  core.setParamFloat('PARAM_EYE_L_OPEN', 1);
  // Use the real SDK's indexed parts API; only the drawable part storage is
  // synthetic so this regression does not depend on a proprietary .moc file.
  let opacity = 1;
  core.getModelContext()._$Hr.push({
    getPartsOpacity: () => opacity,
    setPartsOpacity: (value: number) => { opacity = value; },
  });
  return {
    core,
    model: { x: 0, y: 0, rotation: 0, alpha: 1, scale: { x: 1, y: 1 }, internalModel: { coreModel: core } },
  };
}

describe.skipIf(!cubism2CorePath)('neutral pose through the packaged Cubism 2.1 SDK', () => {
  it('restores entrance parameters and visible parts after a motion without corrupting parameter IDs', () => {
    const { core, model } = createModel();
    const eyeIndex = core.getParamIndex('PARAM_EYE_L_OPEN');
    captureModelNeutralPoseOnce(model);
    core.setParamFloat('PARAM_ANGLE_X', 30);
    core.setParamFloat('PARAM_EYE_L_OPEN', 0);
    core.setPartsOpacity(0, 0);
    core.saveParam();

    resetModelToNeutralPose(model, runtime);
    core.loadParam();

    expect.soft(core.getPartsOpacity(0)).toBe(1);
    expect.soft(core.getParamIndex('PARAM_EYE_L_OPEN')).toBe(eyeIndex);
    expect.soft(core.getParamFloat('PARAM_EYE_L_OPEN')).toBe(1);
    expect(core.getParamFloat('PARAM_ANGLE_X')).toBe(0);
  });

  it('snapshot restoration restores parts and keeps parameter lookup stable over repeated seeks', () => {
    const { core, model } = createModel();
    const controls = getLive2DRuntimeAdapter(runtime).getControls();
    const snapshot = controls.captureIdleSnapshot(model)!;
    expect(snapshot).not.toBeNull();
    expect(Array.from(snapshot.opacities)).toEqual([1]);
    expect(Array.from(controls.captureSnapshot('hero', model)!.opacities)).toEqual([1]);
    expect(controls.describeInvalidState(model)).toBeNull();
    const eyeIndex = core.getParamIndex('PARAM_EYE_L_OPEN');
    for (let i = 0; i < 3; i++) {
      core.setParamFloat('PARAM_ANGLE_X', 30);
      core.setParamFloat('PARAM_EYE_L_OPEN', 0);
      core.setPartsOpacity(0, 0);
      controls.applySnapshot(model, snapshot as any);
      expect(core.getPartsOpacity(0)).toBe(1);
      expect(core.getParamIndex('PARAM_EYE_L_OPEN')).toBe(eyeIndex);
      expect(core.getParamFloat('PARAM_EYE_L_OPEN')).toBe(1);
      expect(core.getParamFloat('PARAM_ANGLE_X')).toBe(0);
    }
  });

  it.each([false, true])('refreshes the rendered pose when seeking before the first motion without an expression manager (scrubbing=%s)', async (isScrubbing) => {
    const { core } = createModel();
    const model = new VendorModel({ autoUpdate: false });
    let renderedAngle = 0;
    model.internalModel = {
      coreModel: core,
      // Observe the pose consumed at the vendor's actual deferred-update seam.
      // No expression manager is created for models without expressions.
      update: () => { renderedAngle = core.getParamFloat('PARAM_ANGLE_X'); },
    };
    model.updateDrawableBounds = vi.fn();
    captureModelNeutralPoseOnce(model);
    const controls = getLive2DRuntimeAdapter(runtime).getControls();
    const manager = new Live2DManager();
    const entry: any = { id: 'hero', model, runtime, modelPath: 'hero.model.json', config: {}, injectedParams: {}, lipSyncParameterIds: new Set(), idleSnapshot: controls.captureIdleSnapshot(model) };
    (manager as any).characters.set('hero', entry);
    manager.setScriptEngine({ isReconstructing: true, getCurrentTime: () => 1 } as any);

    core.setParamFloat('PARAM_ANGLE_X', 30);
    core.saveParam();
    model.update(16);
    model.prepareForRender();
    expect(renderedAngle).toBe(30);

    manager.clearAllPendingMotions();
    manager.purgeAllCharacterRuntimeState();
    await new CharacterSynchronizer(manager).syncTo({
      time: 1,
      desiredChars: new Map([['hero', { id: 'hero', model: 'hero.model.json', config: {} }]]),
      transformationProxies: new ProxyRegistry(),
      snapshotStore: { findBefore: () => null } as any,
      shouldCancel: () => false,
      skipHardReset: true,
      isScrubbing,
    });
    expect(core.getParamFloat('PARAM_ANGLE_X')).toBe(0);
    model.prepareForRender();
    expect(renderedAngle).toBe(0);
    model.prepareForRender();
    expect(renderedAngle).toBe(0);
  });
});
