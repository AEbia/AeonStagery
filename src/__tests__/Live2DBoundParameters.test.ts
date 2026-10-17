import { describe, expect, it } from 'vitest';
import { createLive2DModelHandle } from '../engine/live2d/runtime/Live2DRuntimeControlModule';
import { Cubism2PixiLive2DModelControls } from '../engine/runtime/Cubism2PixiLive2DModelControls';
import { CubismPixiLive2DAdapter } from '../engine/runtime/CubismPixiLive2DAdapter';
import { createCubismModelFixture } from './helpers/cubismModelFixture';

const runtime = { runtimeFamily: 'cubism2', adapterId: 'pixi-live2d-display-cubism2', supported: true } as const;

function concrete() {
  const ids = ['PARAM_ANGLE_X', 'PARAM_EYE_L_OPEN'];
  const values = new Float32Array([12, 1]);
  return {
    internalModel: {
      parameterValues: values,
      settings: { parameters: [
        { name: 'PARAM_ANGLE_X', label: 'Head angle', min: -30, max: 30 },
        { name: 'PARAM_EYE_L_OPEN' },
      ] },
      coreModel: {
        getParamIndex: (id: string) => ids.indexOf(id),
        getParamIds: () => ids,
        getParameterValues: () => values,
        // Real Cubism 2 ignores numeric writes.
        setParamFloat: (id: string | number, value: number) => {
          if (typeof id === 'string') values[ids.indexOf(id)] = value;
        },
      },
    },
  };
}

function handle(model: object) {
  return createLive2DModelHandle({ id: 'hero', model, runtime, controls: new Cubism2PixiLive2DModelControls() });
}

describe('bound parameter behaviors', () => {
  it('returns detached parameter values with stable identifiers, indices, labels and bounds', () => {
    const bound = handle(concrete());
    const parameters = bound.inspectParameters();
    expect(parameters).toEqual([
      { id: 'PARAM_ANGLE_X', index: 0, label: 'Head angle', value: 12, min: -30, max: 30, defaultValue: 0, source: 'known-cubism2-default' },
      { id: 'PARAM_EYE_L_OPEN', index: 1, label: 'PARAM_EYE_L_OPEN', value: 1, min: undefined, max: undefined, defaultValue: 1, source: 'known-cubism2-default' },
    ]);
    expect(bound.inspectParameters()).not.toBe(parameters);
    expect(handle({}).inspectParameters()).toBeNull();
  });

  it('resolves index edits to IDs and commits a composite batch once per concrete model', () => {
    const main = concrete();
    const sub = concrete();
    let mainCommits = 0;
    let subCommits = 0;
    const bound = handle({
      ...main,
      getAllModels: () => [
        { ...main, syncInputParameters: () => { mainCommits++; } },
        { ...sub, syncInputParameters: () => { subCommits++; } },
      ],
    });
    expect(bound.editParameters([{ index: 0, value: -15 }, { id: 'PARAM_EYE_L_OPEN', value: 0.5 }])).toEqual({
      appliedParameterIds: ['PARAM_ANGLE_X', 'PARAM_EYE_L_OPEN'],
    });
    expect(bound.inspectParameters()?.map(parameter => parameter.value)).toEqual([-15, 0.5]);
    expect(Array.from(sub.internalModel.parameterValues)).toEqual([-15, 0.5]);
    expect([mainCommits, subCommits]).toEqual([1, 1]);
    expect(bound.editParameters([{ index: -1, value: 0 }, { id: 'missing', value: 1 }, { index: 0, value: NaN }])).toEqual({
      appliedParameterIds: [],
    });
    expect([mainCommits, subCommits]).toEqual([1, 1]);
  });

  it('keeps Core identifiers separate from display names and reports available legacy bounds', () => {
    const model = concrete();
    model.internalModel.settings.parameters[0].name = 'Head turn';
    model.internalModel.settings.parameters[0].label = '';
    const bound = handle({
      ...model,
      internalModel: {
        ...model.internalModel,
        coreModel: {
          ...model.internalModel.coreModel,
          getModelContext: () => ({
            getParamMin: (index: number) => index === 0 ? -45 : 0,
            getParamMax: (index: number) => index === 0 ? 45 : 1,
          }),
        },
      },
    });
    expect(bound.inspectParameters()?.map(parameter => [parameter.id, parameter.label, parameter.min, parameter.max])).toEqual([
      ['PARAM_ANGLE_X', 'Head turn', -45, 45], ['PARAM_EYE_L_OPEN', 'PARAM_EYE_L_OPEN', 0, 1],
    ]);
  });

  it('submits a Cubism 3+ batch with one geometry commit and retains available bounds', () => {
    const { model, core, drawn } = createCubismModelFixture(['ParamAngleX', 'ParamEyeLOpen']);
    Object.assign(core, {
      getParameterMinimumValue: (index: number) => index === 0 ? -30 : 0,
      getParameterMaximumValue: (index: number) => index === 0 ? 30 : 1,
      getParameterDefaultValue: (index: number) => index === 0 ? 0 : 1,
    });
    const descriptor = { runtimeFamily: 'cubism3-plus', adapterId: 'untitled-pixi-live2d-engine-cubism', supported: true } as const;
    const bound = new CubismPixiLive2DAdapter().createModelHandle('hero', model, descriptor);
    bound.editParameters([{ index: 0, value: 20 }, { id: 'ParamEyeLOpen', value: 0.5 }]);
    expect(Array.from(drawn())).toEqual([20, 0.5]);
    expect(core.update).toHaveBeenCalledTimes(1);
    expect(bound.inspectParameters()?.map(parameter => [parameter.min, parameter.max, parameter.defaultValue])).toEqual([
      [-30, 30, 0], [0, 1, 1],
    ]);
    bound.editParameters([]);
    bound.editParameters([{ index: 1.5, value: 0 }, { id: 'missing', value: 1 }, { index: 0, value: Infinity }]);
    expect(core.update).toHaveBeenCalledTimes(1);
  });

  it('commits a plain legacy model once after all ID writes', () => {
    const model = concrete();
    const poses: number[][] = [];
    const bound = handle({
      ...model,
      internalModel: {
        ...model.internalModel,
        coreModel: { ...model.internalModel.coreModel, update: () => poses.push(Array.from(model.internalModel.parameterValues)) },
      },
    });
    bound.editParameters([{ index: 0, value: 15 }, { index: 1, value: 0.25 }]);
    expect(poses).toEqual([[15, 0.25]]);
  });
});
