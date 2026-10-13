import { describe, expect, it, vi } from 'vitest';
import { createLive2DModelHandle } from '../engine/live2d/runtime/Live2DRuntimeControlModule';
import { Live2DPerformanceRegistry } from '../engine/runtime/Live2DPerformanceRegistry';
import type { Live2DPerformanceResource } from '../engine/runtime/Live2DRuntimeContracts';
import { mockControls } from './helpers/mockLive2DRuntimeAdapter';

const asset = { source: 'motions/wave.motion3.json', runtimeUri: 'asset://motions/wave.motion3.json' } as const;

function resource(overrides: Partial<Live2DPerformanceResource> = {}): Live2DPerformanceResource {
  return {
    runtimeKey: 'wave',
    kind: 'motion',
    asset,
    runtimeFamily: 'cubism3-plus',
    ...overrides,
  };
}

function bindRuntime(
  runtimeFamily: 'cubism2' | 'cubism3-plus',
  controls = mockControls(),
) {
  const model = { id: 'anon' };
  const runtime = runtimeFamily === 'cubism2'
    ? { runtimeFamily, adapterId: 'pixi-live2d-display-cubism2' as const, supported: true }
    : { runtimeFamily, adapterId: 'untitled-pixi-live2d-engine-cubism' as const, supported: true };
  const handle = createLive2DModelHandle({ id: 'anon', model, runtime, controls });
  const registry = new Live2DPerformanceRegistry();
  registry.bindModel('anon', { handle, runtimeFamily });
  return { controls, handle, registry };
}

describe('Live2DPerformanceRegistry', () => {
  it('registers external performances through bound runtime behavior and releases all keys', async () => {
    const { controls, registry, handle } = bindRuntime('cubism3-plus');

    const prepared = await registry.prepare('anon', resource());

    expect(prepared.registered).toBe(true);
    expect(prepared.compatibility.status).toBe('compatible');
    expect(controls.registerExternalMotion).toHaveBeenCalledWith(handle.displayObject, 'wave', asset, undefined);

    registry.releaseModel('anon');
    expect(controls.unregisterExternalPerformance).toHaveBeenCalledWith(handle.displayObject, 'wave');
  });

  it('reports family mismatches without calling the runtime registration behavior', async () => {
    const { controls, registry } = bindRuntime('cubism2');

    const prepared = await registry.prepare('anon', resource());

    expect(prepared.registered).toBe(false);
    expect(prepared.compatibility.status).toBe('incompatible');
    expect(prepared.compatibility.diagnostics.join(' ')).toContain('runtime family');
    expect(controls.registerExternalMotion).not.toHaveBeenCalled();
  });

  it('rejects missing required parameters unless partial registration is explicit', async () => {
    const controls = mockControls({
      getParameterMetadata: vi.fn(() => [{ id: 'PARAM_ANGLE_X', index: 0, source: 'runtime' as const }]),
    });
    const { registry } = bindRuntime('cubism3-plus', controls);

    const required = resource({ metadata: { requiredParameterIds: ['PARAM_ANGLE_X', 'PARAM_MISSING'] } });
    const rejected = await registry.prepare('anon', required);
    expect(rejected.registered).toBe(false);
    expect(rejected.compatibility.missingParameterIds).toEqual(['PARAM_MISSING']);

    const partial = await registry.prepare('anon', resource({
      runtimeKey: 'wave-partial',
      metadata: { requiredParameterIds: ['PARAM_ANGLE_X', 'PARAM_MISSING'], allowPartial: true },
    }));
    expect(partial.registered).toBe(true);
    expect(partial.compatibility.status).toBe('partial');
  });
});
