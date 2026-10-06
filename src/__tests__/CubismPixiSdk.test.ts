import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ ready: vi.fn(async () => undefined), load: vi.fn() }));
vi.mock('../engine/Live2DEngineBridge', () => ({ loadCubismEngineModule: mocks.load }));

describe('Cubism engine availability and initialization', () => {
  afterEach(() => { vi.resetModules(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
  it('reports and rejects a missing Core without evaluating the engine bundle', async () => {
    const sdk = await import('../engine/CubismPixiSdk');
    expect(sdk.getCubismPixiSdkStatus().available).toBe(false);
    await expect(sdk.initCubismPixiSdk()).rejects.toThrow('live2dcubismcore.min.js');
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it('waits for bootstrap then initializes the modern entry once, without Cubism 2.1', async () => {
    let complete!: () => void;
    const fakeWindow = { Live2DCubismCore: {} as any, __aeonLive2DRuntimeBootstrap: { ready: new Promise<void>((resolve) => { complete = resolve; }) } };
    vi.stubGlobal('window', fakeWindow);
    mocks.load.mockResolvedValue({ cubismReady: mocks.ready });
    const sdk = await import('../engine/CubismPixiSdk');
    const pending = [sdk.initCubismPixiSdk(), sdk.initCubismPixiSdk()];
    await Promise.resolve();
    expect(mocks.load).not.toHaveBeenCalled();
    fakeWindow.Live2DCubismCore = { Version: { csmGetVersion: () => 1 } };
    complete();
    await Promise.all(pending);
    await sdk.initCubismPixiSdk();
    expect(mocks.ready).toHaveBeenCalledOnce();
    expect(sdk.getCubismPixiSdkStatus()).toEqual({ available: true, initialized: true, message: null });
  });
});
