import { describe, expect, it, vi } from 'vitest';
import { Live2DPerformanceRegistry } from '../engine/runtime/Live2DPerformanceRegistry';
import type { Live2DPerformanceResource } from '../engine/runtime/Live2DRuntimeContracts';
import { mockAdapter, mockControls } from './helpers/mockLive2DRuntimeAdapter';

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

describe('Live2DPerformanceRegistry', () => {
  it('registers external performances and releases all keys for a model', async () => {
    const controls = mockControls();
    const adapter = mockAdapter({ getControls: vi.fn(() => controls) });
    const registry = new Live2DPerformanceRegistry({ adapter });
    const model = { id: 'anon' };
    registry.bindModel('anon', { model, runtimeFamily: 'cubism3-plus' });

    const prepared = await registry.prepare('anon', resource());

    expect(prepared.registered).toBe(true);
    expect(prepared.compatibility.status).toBe('compatible');
    expect(controls.registerExternalMotion).toHaveBeenCalledWith(model, 'wave', asset, undefined);

    registry.releaseModel('anon');
    expect(controls.unregisterExternalPerformance).toHaveBeenCalledWith(model, 'wave');
  });

  it('reports family mismatches without calling the runtime registration seam', async () => {
    const controls = mockControls();
    const adapter = mockAdapter({ getControls: vi.fn(() => controls) });
    const registry = new Live2DPerformanceRegistry({ adapter });
    const model = {};
    registry.bindModel('anon', { model, runtimeFamily: 'cubism2' });

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
    const adapter = mockAdapter({ getControls: vi.fn(() => controls) });
    const registry = new Live2DPerformanceRegistry({ adapter });
    registry.bindModel('anon', { model: {}, runtimeFamily: 'cubism3-plus' });

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
