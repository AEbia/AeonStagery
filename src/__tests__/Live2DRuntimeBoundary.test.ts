import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cubism2PixiLive2DAdapter } from '../engine/runtime/Cubism2PixiLive2DAdapter';
import { CubismPixiLive2DAdapter } from '../engine/runtime/CubismPixiLive2DAdapter';
import { getSharedRuntimeClock } from '../engine/live2d/runtime/Live2DRuntimeClockCoordinator';
import { setLive2DCubism2RuntimeAvailable } from '../engine/Live2DRuntimeResolver';

vi.mock('../engine/Live2DEngineBridge', () => ({
  loadLive2DEngineModule: vi.fn(),
  loadCubismEngineModule: vi.fn(),
}));

describe('Live2D adapter SDK boundaries', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setLive2DCubism2RuntimeAvailable(true);
  });

  it('rejects non-callable legacy model factories with the adapter diagnostic', async () => {
    const adapter = new Cubism2PixiLive2DAdapter(async () => ({ Live2DModel: { from: 1 } }));

    await expect(adapter.createModel('model.json', {}))
      .rejects.toThrow('Cubism 2 Live2DModel class is not available.');
  });

  it('requires both shared-clock operations before exposing the SDK clock', () => {
    vi.stubGlobal('window', { UtSystem: { getUserTimeMSec: () => 10 } });
    new Cubism2PixiLive2DAdapter();

    expect(getSharedRuntimeClock()).toBeNull();

    const clock = { getUserTimeMSec: () => 10, setUserTimeMSec: vi.fn() };
    vi.stubGlobal('window', { UtSystem: clock });
    expect(getSharedRuntimeClock()).toBe(clock);
  });

  it('extracts only named expressions from unknown SDK definitions', () => {
    const handle = new CubismPixiLive2DAdapter().createModelHandle('hero', {
      internalModel: { settings: { expressions: [null, {}, { Name: 4 }, { Name: '' }, { Name: 'smile' }] } },
    });

    expect(handle.expression.getAvailableExpressions()).toEqual(['smile']);
  });

  it('checks SDK registration reports and preserves the registration receiver', async () => {
    const source = { source: 'wave.motion3.json', runtimeUri: 'asset://wave.motion3.json' };
    const model = {
      registerExternalMotion: vi.fn(function (this: unknown) {
        expect(this).toBe(model);
        return { status: 'partial' };
      }),
    };
    const handle = new CubismPixiLive2DAdapter().createModelHandle('hero', model);

    const result = await handle.externalPerformances.register({
      kind: 'motion', runtimeKey: 'wave', asset: source, runtimeFamily: 'cubism3-plus',
    });

    expect(model.registerExternalMotion).toHaveBeenCalledWith('wave', source, undefined);
    expect(result.status).toBe('incompatible');
    expect(result.diagnostics).toEqual([expect.stringContaining('invalid compatibility report')]);
  });

  it.each(['motion', 'expression'] as const)('preserves generic %s registration and complete compatibility reports', async (kind) => {
    const source = { source: 'performance.json', runtimeUri: 'asset://performance.json' };
    const report = {
      status: 'partial' as const,
      missingParameterIds: ['ParamEyeLOpen'], ignoredParameterIds: [], diagnostics: ['Unavailable parameter'],
    };
    const model = {
      registerExternalPerformance: vi.fn(function (this: unknown) {
        expect(this).toBe(model);
        return Promise.resolve(report);
      }),
    };
    const handle = new CubismPixiLive2DAdapter().createModelHandle('hero', model);

    const result = await handle.externalPerformances.register({
      kind, runtimeKey: 'performance', asset: source, runtimeFamily: 'cubism3-plus',
    });

    expect(model.registerExternalPerformance).toHaveBeenCalledWith(kind, 'performance', source, undefined);
    expect(result).toBe(report);
  });

  it('uses module config when a legacy model constructor has no static config', async () => {
    const config = { cubism2: { maskSize: 256 } };
    const adapter = new Cubism2PixiLive2DAdapter(async () => ({ Live2DModel: {}, config }));

    await adapter.init();

    expect(config.cubism2.maskSize).toBe(1024);
  });
});
