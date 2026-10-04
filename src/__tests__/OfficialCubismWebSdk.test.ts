import { afterEach, describe, expect, it, vi } from 'vitest';

const frameworkMocks = vi.hoisted(() => ({
  startUp: vi.fn(),
  initialize: vi.fn(),
}));

async function loadSdk() {
  return import('../engine/OfficialCubismWebSdk');
}

describe('OfficialCubismWebSdk', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@cubism/live2dcubismframework');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    frameworkMocks.startUp.mockReset();
    frameworkMocks.initialize.mockReset();
  });

  it('reports the official runtime as unavailable when the core script is missing', async () => {
    const { getOfficialCubismSdkStatus } = await loadSdk();

    expect(getOfficialCubismSdkStatus()).toEqual({
      available: false,
      initialized: false,
      message: '官方 Cubism Web SDK Core 脚本缺失或未加载（/live2dcubismcore.min.js）。',
    });
  });

  it('rejects initialization before attempting framework startup when core is missing', async () => {
    const { getOfficialCubismSdkStatus, initOfficialCubismWebSdk } = await loadSdk();

    await expect(initOfficialCubismWebSdk()).rejects.toThrow(
      '官方 Cubism Web SDK Core 脚本缺失或未加载（/live2dcubismcore.min.js）。',
    );
    expect(getOfficialCubismSdkStatus()).toEqual({
      available: false,
      initialized: false,
      message: '官方 Cubism Web SDK Core 脚本缺失或未加载（/live2dcubismcore.min.js）。',
    });
  });

  it('starts and initializes the official framework once when the core script is available', async () => {
    vi.doMock('@cubism/live2dcubismframework', () => ({
      CubismFramework: {
        startUp: frameworkMocks.startUp,
        initialize: frameworkMocks.initialize,
      },
      Option: class TestCubismOption {
        logFunction?: (message: string) => void;
        loggingLevel?: number;
      },
    }));
    vi.stubGlobal('window', {
      Live2DCubismCore: {
        Version: {
          csmGetVersion: () => 1234,
        },
      },
    });

    const { getOfficialCubismSdkStatus, initOfficialCubismWebSdk } = await loadSdk();

    await initOfficialCubismWebSdk();
    await initOfficialCubismWebSdk();

    expect(frameworkMocks.startUp).toHaveBeenCalledTimes(1);
    expect(frameworkMocks.initialize).toHaveBeenCalledTimes(1);
    expect(frameworkMocks.startUp.mock.calls[0][0]).toEqual(expect.objectContaining({
      loggingLevel: 1,
      logFunction: expect.any(Function),
    }));
    expect(getOfficialCubismSdkStatus()).toEqual({
      available: true,
      initialized: true,
      message: null,
    });
  });
});
