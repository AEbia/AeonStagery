import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import { installCubismPixiModelRuntime } from '../../engine/CubismPixiModel';

export function createCubismModelFixture(
  ids = ['ParamEyeLOpen', 'ParamEyeROpen', 'ParamBreath', 'ParamMouthOpenY', 'ParamAngleX'],
  eyeBlinkParameters: string[] = [],
  suppliedExpressionManager?: object,
) {
  const values = new Float32Array(ids.map((id) => id.includes('Eye') && id.includes('Open') ? 1 : 0));
  let saved = values.slice();
  let drawn = values.slice();
  const opacities = new Float32Array([1]);
  const focusController = {
    x: 0, y: 0, targetX: 0, targetY: 0, vx: 0, vy: 0,
    focus(x: number, y: number, instant = false) {
      this.targetX = Math.max(-1, Math.min(1, x));
      this.targetY = Math.max(-1, Math.min(1, y));
      if (instant) { this.x = this.targetX; this.y = this.targetY; }
    },
    update: vi.fn(),
  };
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
  const expressionManager: any = suppliedExpressionManager ?? {
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
    focusController,
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
      focusController.update();
      for (const [id, value] of Object.entries({
        ParamEyeBallX: focusController.x, ParamEyeBallY: focusController.y,
        ParamAngleX: focusController.x * 30, ParamAngleY: focusController.y * 30,
        ParamAngleZ: focusController.x * focusController.y * -30,
        ParamBodyAngleX: focusController.x * 10,
      })) {
        const index = ids.indexOf(id);
        if (index >= 0) values[index] += value;
      }
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
