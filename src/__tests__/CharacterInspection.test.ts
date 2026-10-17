import { live2DStageState } from './helpers/live2DStageState';
import { describe, expect, it } from 'vitest';
import Live2DManager from '../engine/Live2DManager';
import { CharacterAdapter } from '../api/adapters/CharacterAdapter';
import type { CharacterEntry } from '../engine/Live2DConfig';
import { CubismPixiLive2DAdapter } from '../engine/runtime/CubismPixiLive2DAdapter';
import { createCubismModelFixture } from './helpers/cubismModelFixture';

function setup() {
  const manager = new Live2DManager();
  const { model, drawn } = createCubismModelFixture(['ParamAngleX', 'ParamEyeLOpen']);
  const runtime = { runtimeFamily: 'cubism3-plus', adapterId: 'untitled-pixi-live2d-engine-cubism', supported: true } as const;
  const entry: CharacterEntry = {
    id: 'hero', model, modelPath: 'hero.model3.json', modelUrl: 'file:///hero.model3.json',
    runtime, adapterId: runtime.adapterId,
    runtimeHandle: new CubismPixiLive2DAdapter().createModelHandle('hero', model, runtime),
    config: { position: [0.3, 0.8], scale: 1.2 }, injectedParams: {}, lipSyncParameterIds: new Set(),
    baseHeight: 1000, motionEpoch: 0,
  };
  live2DStageState(manager).characters = new Map([['hero', entry]]);
  return { adapter: new CharacterAdapter(manager), drawn, entry };
}

describe('neutral character inspection', () => {
  it('reads and edits parameters through the character interface without receiving Core', () => {
    const { adapter, drawn } = setup();
    expect(adapter.inspectParameters('hero')?.map(parameter => [parameter.id, parameter.index, parameter.value])).toEqual([
      ['ParamAngleX', 0, 0], ['ParamEyeLOpen', 1, 1],
    ]);
    adapter.editParameters('hero', [{ index: 0, value: 18 }, { id: 'ParamEyeLOpen', value: 0.5 }]);
    expect(Array.from(drawn())).toEqual([18, 0.5]);
    expect(adapter.inspectParameters('hero')?.map(parameter => parameter.value)).toEqual([18, 0.5]);
    expect(adapter.inspectParameters('missing')).toBeNull();
    expect(adapter.editParameters('missing', [{ index: 0, value: 1 }])).toEqual({ appliedParameterIds: [] });
  });

  it('lists detached reload information and exposes only typed display access', () => {
    const { adapter, entry } = setup();
    const info = adapter.getCharacterInfo('hero');
    expect(info).toEqual({
      id: 'hero', modelPath: 'hero.model3.json', adapterId: 'untitled-pixi-live2d-engine-cubism',
      config: { position: [0.3, 0.8], scale: 1.2 },
      determinism: entry.runtimeHandle?.capabilities.determinism,
    });
    expect(adapter.listCharacterInfo()).toEqual([info]);
    expect(info?.config).not.toBe(entry.config);
    expect(info?.config.position).not.toBe(entry.config.position);
    entry.config.scale = 2;
    expect(info?.config.scale).toBe(1.2);
    expect(adapter.getCharacterInfo('hero')?.config.scale).toBe(2);
    expect(adapter.getDisplayObject('hero')).toBe(entry.runtimeHandle?.displayObject);
    expect(adapter.getCharacterInfo('missing')).toBeNull();
    expect(adapter.getDisplayObject('missing')).toBeNull();
    expect(['getModel', 'getCoreModel', 'getAllCharacters'].filter(key => key in adapter)).toEqual([]);
  });
});
