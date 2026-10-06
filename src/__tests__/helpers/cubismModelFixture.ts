import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import { installCubismPixiModelRuntime } from '../../engine/CubismPixiModel';

export function createCubismModelFixture(
  ids = ['ParamEyeLOpen', 'ParamEyeROpen', 'ParamBreath', 'ParamMouthOpenY', 'ParamAngleX'],
  eyeBlinkParameters: string[] = [],
) {
  const values = new Float32Array(ids.map((id) => id.includes('Eye') ? 1 : 0));
  let saved = values.slice();
  let drawn = values.slice();
  const opacities = new Float32Array([1]);
  const core = {
    getParameterCount: () => ids.length,
    getParameterId: (index: number) => ({ getString: () => ({ s: ids[index] }) }),
    getParameterValueByIndex: (index: number) => values[index],
    setParameterValueByIndex: (index: number, value: number) => { values[index] = value; },
    _parameterValues: values,
    _partOpacities: opacities,
    getModel: () => ({ parameters: { values }, parts: { opacities } }),
    saveParameters: vi.fn(() => { saved = values.slice(); }),
    loadParameters: vi.fn(() => values.set(saved)),
    update: vi.fn(() => { drawn = values.slice(); }),
  };
  const expressionManager: any = {
    stopAllExpressions: vi.fn(), resetExpression: vi.fn(),
    getExpressionIndex: (key: string) => key === 'smile' ? 0 : -1,
    loadExpression: vi.fn(async () => ({})),
    setExpression: vi.fn(async () => true),
    queueManager: { getCubismMotionQueueEntries: () => [] },
  };
  const motionManager: any = {
    groups: {}, state: {}, definitions: {}, motionGroups: {}, expressionManager,
    stopAllMotions: vi.fn(),
    update: vi.fn(() => false),
    loadMotion: vi.fn(async () => null),
  };
  const internal: any = new EventEmitter();
  Object.assign(internal, {
    coreModel: core, motionManager, settings: {
      motions: {}, expressions: [{ Name: 'smile', File: 'smile.exp3.json' }],
      getEyeBlinkParameters: () => eyeBlinkParameters,
    },
    updateNaturalMovements: vi.fn(),
    updateMotions: vi.fn((target: any, now: number) => {
      internal.emit('beforeMotionUpdate');
      const updated = motionManager.update(target, now);
      internal.emit('afterMotionUpdate');
      return updated;
    }),
    update: vi.fn((dt: number, now: number) => {
      internal.updateMotions(core, now);
      core.saveParameters();
      internal.emit('expressionUpdate');
      internal.updateNaturalMovements(dt, now);
      internal.emit('beforeModelUpdate');
      core.update();
      core.loadParameters();
    }),
  });
  const model: any = {
    internalModel: internal, deltaTime: 0, elapsedTime: 0,
    x: 0, y: 0, scale: { x: 1, y: 1 }, rotation: 0, alpha: 1,
    update(dt: number) { this.deltaTime += dt; this.elapsedTime += dt; },
    destroy: vi.fn(),
  };
  installCubismPixiModelRuntime(model);
  return { model, internal, core, values, motionManager, expressionManager, drawn: () => drawn, saved: () => saved };
}
