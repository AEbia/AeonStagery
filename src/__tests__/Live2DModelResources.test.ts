import { afterEach, describe, expect, it, vi } from 'vitest';
import { Live2DModelResources } from '../engine/Live2DModelResources';
import * as sdk from '../engine/CubismPixiSdk';
import * as runtimeAdapter from '../engine/Live2DRuntimeAdapter';
import { mockControls, mockAdapter } from './helpers/mockLive2DRuntimeAdapter';
import { Container, ObservablePoint } from 'pixi.js';

describe('Live2DModelResources', () => {
  afterEach(() => {
    delete (global as any).window;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('resolves /figure paths against the configured base path before reading model data', async () => {
    const readTextFile = vi.fn(async () => ({
      success: true,
      data: JSON.stringify({
        motions: { idle: [{}], wave: [{}] },
        expressions: [{ name: 'smile' }],
      }),
    }));

    (global as any).window = {
      aeonStageryAPI: {
        fs: { readTextFile },
      },
    };

    const loader = new Live2DModelResources(
      () => 'D:/projects/demo',
    );

    const data = await loader.getModelDataFromPath('/figure/casual-2023/model.json');

    expect(readTextFile).toHaveBeenCalledWith('D:/projects/demo/figure/casual-2023/model.json');
    expect(data).toEqual({
      motions: ['idle', 'wave'],
      expressions: ['smile'],
    });
  });

  it('builds asset URLs for /figure paths under the configured base path', () => {
    const loader = new Live2DModelResources(
      () => 'D:/projects/demo',
    );

    expect(loader.pathToUrl('/figure/casual-2023/model.json')).toBe(
      'asset://localhost/D:/projects/demo/figure/casual-2023/model.json',
    );
  });

  it.each([
    { motions: { idle: [{}] }, expressions: [{ name: 'smile' }] },
    {},
  ])('shares in-flight and cached model reads, including empty catalogs: %j', async (json) => {
    let finishRead!: (result: { success: boolean; data: string }) => void;
    const pendingRead = new Promise<{ success: boolean; data: string }>((resolve) => { finishRead = resolve; });
    const readTextFile = vi.fn(() => pendingRead);
    (global as any).window = { aeonStageryAPI: { fs: { readTextFile } } };
    const loader = new Live2DModelResources(() => 'D:/projects/demo');

    const requests = Array.from({ length: 4 }, () => loader.getModelDataFromPath('figure/model.json'));
    await vi.waitFor(() => expect(readTextFile).toHaveBeenCalledTimes(1));
    finishRead({ success: true, data: JSON.stringify(json) });
    const results = await Promise.all(requests);
    const expected = 'motions' in json
      ? { motions: ['idle'], expressions: ['smile'] }
      : { motions: [], expressions: [] };
    results.forEach((data) => expect(data).toEqual(expected));

    expect(await loader.getModelDataFromPath('figure/model.json')).toEqual(expected);
    expect(await loader.getModelDataFromPath('asset://localhost/D:/projects/demo/figure/model.json')).toEqual(expected);
    expect(readTextFile).toHaveBeenCalledTimes(1);
  });

  it('keeps relative model catalogs separate across project roots', async () => {
    let basePath = 'D:/projects/first';
    const readTextFile = vi.fn(async (path: string) => ({
      success: true,
      data: JSON.stringify({ motions: { [path.includes('/first/') ? 'idle' : 'wave']: [{}] } }),
    }));
    (global as any).window = { aeonStageryAPI: { fs: { readTextFile } } };
    const loader = new Live2DModelResources(() => basePath);

    expect(await loader.getModelDataFromPath('figure/model.json')).toEqual({ motions: ['idle'], expressions: [] });
    basePath = 'D:/projects/second';
    expect(await loader.getModelDataFromPath('figure/model.json')).toEqual({ motions: ['wave'], expressions: [] });
    basePath = 'D:/projects/first';
    expect(await loader.getModelDataFromPath('figure/model.json')).toEqual({ motions: ['idle'], expressions: [] });
    expect(readTextFile).toHaveBeenCalledTimes(2);
  });

  it('uses the new resolved catalog when an external library mount changes', async () => {
    let resolvedPath = 'E:/first/model.json';
    const resolveForRead = vi.fn(async () => resolvedPath);
    const readTextFile = vi.fn(async (path: string) => ({
      success: true,
      data: JSON.stringify({ motions: { [path.includes('/first/') ? 'idle' : 'wave']: [{}] } }),
    }));
    (global as any).window = {
      aeonStageryAPI: { fs: { readTextFile } },
      AeonStagery: { services: { projectResources: {
        getCurrentProject: () => ({ rootPath: 'D:/projects/demo' }), resolveForRead,
      } } },
    };
    const loader = new Live2DModelResources(() => 'D:/projects/demo');

    expect(await loader.getModelDataFromPath('@mount/library/model.json')).toEqual({ motions: ['idle'], expressions: [] });
    resolvedPath = 'E:/second/model.json';
    expect(await loader.getModelDataFromPath('@mount/library/model.json')).toEqual({ motions: ['wave'], expressions: [] });
    expect(readTextFile).toHaveBeenCalledTimes(2);
  });

  it.each([
    { success: false, data: '' },
    { success: true, data: 'invalid JSON' },
  ])('retries model reads after an unsuccessful read or parse: %j', async (failure) => {
    const readTextFile = vi.fn()
      .mockResolvedValueOnce(failure)
      .mockResolvedValue({ success: true, data: JSON.stringify({ motions: { idle: [{}] } }) });
    (global as any).window = { aeonStageryAPI: { fs: { readTextFile } } };
    const loader = new Live2DModelResources(() => 'D:/projects/demo');
    const path = 'D:/projects/demo/figure/model.json';

    expect(await loader.getModelDataFromPath(path)).toEqual({ motions: [], expressions: [] });
    expect(await loader.getModelDataFromPath(path)).toEqual({ motions: ['idle'], expressions: [] });
    expect(await loader.getModelDataFromPath(path)).toEqual({ motions: ['idle'], expressions: [] });
    expect(readTextFile).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['asset://localhost//home/gamma/文档/model.json', 'asset://localhost//home/gamma/%E6%96%87%E6%A1%A3/model.json'],
    ['file:///home/gamma/文档/model.json', 'asset://localhost//home/gamma/%E6%96%87%E6%A1%A3/model.json'],
    ['file:///D:/project/model.json', 'asset://localhost/D:/project/model.json'],
  ])('preserves absolute roots when loading %s', async (path, expectedUrl) => {
    vi.stubGlobal('window', { aeonStageryAPI: { fs: {
      readTextFile: async () => ({ success: true, data: '{"model":"hero.moc"}' }),
    } } });
    const adapter = mockAdapter({ createModel: async () => Object.assign(new Container(), {
      anchor: new ObservablePoint({ _onUpdate: () => {} }, 0, 0),
    }) });
    const resources = new Live2DModelResources(() => '/home/gamma/project', () => adapter);
    await resources.loadCharacter('hero', path, async loaded => {
      expect(loaded.modelUrl).toBe(expectedUrl);
    });
  });

  it('uses project resource resolution for external-library relative model data', async () => {
    const readTextFile = vi.fn(async () => ({
      success: true,
      data: JSON.stringify({
        FileReferences: {
          Motions: { idle: [{}] },
          Expressions: [{ Name: 'smile' }],
        },
      }),
    }));
    const resolveForRead = vi.fn(async () => 'E:/Library/figure/casual-2023/model.json');

    (global as any).window = {
      aeonStageryAPI: {
        fs: { readTextFile },
      },
      AeonStagery: {
        services: {
          projectResources: {
            getCurrentProject: () => ({ rootPath: 'D:/projects/demo' }),
            resolveForRead,
          },
        },
      },
    };

    const loader = new Live2DModelResources(
      () => 'D:/projects/demo',
    );

    const data = await loader.getModelDataFromPath('figure/casual-2023/model.json');

    expect(resolveForRead).toHaveBeenCalledWith('figure/casual-2023/model.json');
    expect(readTextFile).toHaveBeenCalledWith('E:/Library/figure/casual-2023/model.json');
    expect(data).toEqual({ motions: ['idle'], expressions: ['smile'] });
  });

  it('preserves all aggregate WebGAL catalog actions for the selector', async () => {
    const readTextFile = vi.fn(async () => ({
      success: true,
      data: JSON.stringify({
        Name: 'adv_live2d_soyo_004_live_01',
        FileReferences: {
          Moc: 'adv_live2d_soyo_004_live_01.moc3',
          Motions: {
            'avemujica/mutsumi/mtn_angry01_C_live_01': [{ File: 'mutsumi.motion3.json' }],
            'mygo/soyo/mtn_smile01_C_live_01': [{ File: 'soyo-live.motion3.json' }],
            'mygo/soyo/mtn_smile01_C_school_winter_hs': [{ File: 'soyo-school.motion3.json' }],
          },
          Expressions: [
            { Name: 'avemujica/mutsumi/exp_angry01', File: 'mutsumi.exp3.json' },
            { Name: 'mygo/soyo/exp_smile01', File: 'soyo.exp3.json' },
          ],
        },
      }),
    }));

    (global as any).window = {
      aeonStageryAPI: {
        fs: { readTextFile },
      },
    };

    const loader = new Live2DModelResources(() => 'D:/projects/demo');
    const data = await loader.getModelDataFromPath(
      'C:/Games/short/game/figure/mygo/soyo/live_01/adv_live2d_soyo_004_live_01.model3.json',
    );

    expect(data).toEqual({
      motions: [
        'avemujica/mutsumi/mtn_angry01_C_live_01',
        'mygo/soyo/mtn_smile01_C_live_01',
        'mygo/soyo/mtn_smile01_C_school_winter_hs',
      ],
      expressions: ['avemujica/mutsumi/exp_angry01', 'mygo/soyo/exp_smile01'],
    });
  });

  it('resolves mounted model references without prefixing the project base path', async () => {
    const readTextFile = vi.fn(async () => ({
      success: true,
      data: JSON.stringify({ motions: { idle: [{}] } }),
    }));
    const resolveForRead = vi.fn(async () => 'E:/Library/game/figure/anon/casual-2023/model.json');

    (global as any).window = {
      aeonStageryAPI: {
        fs: { readTextFile },
      },
      AeonStagery: {
        services: {
          projectResources: {
            getCurrentProject: () => ({ rootPath: 'D:/projects/demo' }),
            resolveForRead,
          },
        },
      },
    };

    const loader = new Live2DModelResources(
      () => 'D:/projects/demo',
    );

    const data = await loader.getModelDataFromPath(
      '@mount/webgal-sv/game/figure/anon/casual-2023/model.json',
    );

    expect(resolveForRead).toHaveBeenCalledWith(
      '@mount/webgal-sv/game/figure/anon/casual-2023/model.json',
    );
    expect(readTextFile).toHaveBeenCalledWith(
      'E:/Library/game/figure/anon/casual-2023/model.json',
    );
    expect(data.motions).toEqual(['idle']);
  });

  it('does not hide mounted-reference resolution errors behind a project-relative fallback', async () => {
    const resolutionError = new Error('External library mount "webgal-sv" is not registered');
    const resolveForRead = vi.fn(async () => { throw resolutionError; });

    (global as any).window = {
      AeonStagery: {
        services: {
          projectResources: {
            getCurrentProject: () => ({ rootPath: 'D:/projects/demo' }),
            resolveForRead,
          },
        },
      },
    };

    const loader = new Live2DModelResources(
      () => 'D:/projects/demo',
    );

    await expect(loader.loadCharacter('hero',
      '@mount/webgal-sv/game/figure/anon/casual-2023/model.json', async () => {},
    )).rejects.toBe(resolutionError);
  });

  it('rejects unavailable Cubism 3 plus entries before creating a model', async () => {
    vi.spyOn(sdk, 'getCubismPixiSdkStatus').mockReturnValue({
      available: false,
      initialized: false,
      message: '官方 Cubism Web SDK Core 脚本缺失或未加载（/live2dcubismcore.min.js）。',
    });
    const readTextFile = vi.fn(async () => ({
      success: true,
      data: JSON.stringify({
        FileReferences: {
          Moc: 'tomori.moc3',
          Motions: { Idle: [{ File: 'idle.motion3.json' }] },
        },
      }),
    }));

    (global as any).window = {
      aeonStageryAPI: {
        fs: { readTextFile },
      },
    };

    const loader = new Live2DModelResources(
      () => 'D:/projects/demo',
    );

    const create = vi.spyOn(runtimeAdapter.cubism2Live2DAdapter, 'createModel');
    await expect(loader.loadCharacter('tomori', 'figure/tomori/tomori.model3.json', async () => {}))
      .rejects.toMatchObject({ message: expect.stringContaining('Cubism 3/4/5 runtime adapter') });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects unsupported WMDL children before model creation', async () => {
    vi.spyOn(sdk, 'getCubismPixiSdkStatus').mockReturnValue({
      available: true,
      initialized: false,
      message: null,
    });
    const readTextFile = vi.fn(async (path: string) => {
      if (path.endsWith('tomori.wmdl')) {
        return {
          success: true,
          data: JSON.stringify({ modelRelativePath: 'main/tomori.model3.json' }),
        };
      }
      return {
        success: true,
        data: JSON.stringify({
          FileReferences: {
            Moc: 'tomori.moc3',
          },
        }),
      };
    });

    (global as any).window = {
      aeonStageryAPI: {
        fs: { readTextFile },
      },
    };

    const loader = new Live2DModelResources(
      () => 'D:/projects/demo',
    );

    const create = vi.spyOn(runtimeAdapter.cubism2Live2DAdapter, 'createModel');
    await expect(loader.loadCharacter('tomori', 'figure/tomori/tomori.wmdl', async () => {}))
      .rejects.toMatchObject({ message: expect.stringContaining('Cubism 3/4/5 runtime adapter') });
    expect(readTextFile).toHaveBeenCalledWith('D:/projects/demo/figure/tomori/tomori.wmdl');
    expect(readTextFile).toHaveBeenCalledWith('D:/projects/demo/figure/tomori/main/tomori.model3.json');
    expect(create).not.toHaveBeenCalled();
  });

  it('preloads Cubism 3 plus models through the official adapter instead of the Cubism 2 create path', async () => {
    vi.spyOn(sdk, 'getCubismPixiSdkStatus').mockReturnValue({
      available: true,
      initialized: false,
      message: null,
    });
    const officialCreate = vi.fn(async () => ({
      visible: true,
      alpha: 1,
      update: () => {},
      internalModel: { coreModel: {}, settings: { motions: {}, expressions: {} } },
    }));
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue({
      id: 'untitled-pixi-live2d-engine-cubism',
      supported: true,
      init: async () => {},
      isReady: () => true,
      getModelClass: () => null,
      getConfig: () => null,
      getClock: () => null,
      createFallbackModel: () => null,
      disposeBakeRenderTexture: () => {},
      getControls: () => mockControls({
        getCoreModel: () => null,
      }),
      createModelHandle: (id: string, model: any, runtime: any) => ({
        id,
        runtime,
        displayObject: model,
        rawModel: model,
        capabilities: {
          runtimeFamily: runtime.runtimeFamily,
          adapterId: runtime.adapterId,
          supportsMotion: true,
          supportsExpression: true,
          supportsParameterInjection: true,
          supportsSnapshot: true,
          supportsBakeRender: true,
          usesCubism2PrivateControls: false,
        },
        lifecycle: {
          getCoreModel: () => null,
          clearMotionState: () => {},
          stopAllMotions: () => {},
        },
        motion: {
          getAvailableMotions: () => [],
          getMotionDuration: () => 0,
          getMotionDebugState: () => null,
          preloadMotion: async () => {},
        },
        expression: {
          getAvailableExpressions: () => [],
          setExpression: () => {},
        },
        parameters: {
          getParameterValues: () => null,
          getParameterMetadata: () => null,
          setInjectedParameter: () => {},
          syncInputParameters: () => {},
        },
        snapshot: {
          captureSnapshot: () => null,
          applySnapshot: () => {},
          restoreSeekState: async () => ({ status: 'restored', tierUsed: 'native' }),
        },
        render: {
          renderForBake: () => {},
        },
        diagnostics: {
          describeInvalidState: () => null,
        },
      }),
      createModel: officialCreate,
      getUnsupportedMessage: () => null,
    });

    const readTextFile = vi.fn(async () => ({
      success: true,
      data: JSON.stringify({
        FileReferences: {
          Moc: 'tomori.moc3',
        },
      }),
    }));

    (global as any).window = {
      aeonStageryAPI: {
        fs: { readTextFile },
      },
    };

    const loader = new Live2DModelResources(
      () => 'D:/projects/demo',
    );

    await loader.preloadModel('asset://localhost/D:/projects/demo/figure/tomori/tomori.model3.json');
    await loader.preloadModel('asset://localhost/D:/projects/demo/figure/tomori/tomori.model3.json');

    expect(officialCreate).toHaveBeenCalledWith(
      'asset://localhost/D:/projects/demo/figure/tomori/tomori.model3.json',
      expect.objectContaining({
        autoHitTest: false,
        autoFocus: false,
        autoUpdate: false,
      }),
    );
    expect(officialCreate).toHaveBeenCalledTimes(1);
  });

  it('rejects unreadable model paths before Live2D runtime loading', async () => {
    const readTextFile = vi.fn(async () => ({
      success: false,
      error: 'Not found',
    }));

    (global as any).window = {
      aeonStageryAPI: {
        fs: { readTextFile },
      },
    };

    const loader = new Live2DModelResources(
      () => 'D:/projects/demo',
    );

    await expect(loader.loadCharacter('hero', 'figure/casual-2023/missing-model.json', async () => {}))
      .rejects.toMatchObject({ fullPath: 'D:/projects/demo/figure/casual-2023/missing-model.json' });
  });

  it('strips asset URLs before reading model files from the filesystem', async () => {
    const readTextFile = vi.fn(async (path: string) => {
      expect(path).toBe('D:/projects/demo/figure/casual-2023/model.json');
      return {
        success: true,
        data: JSON.stringify({
          motions: { idle: [{}] },
          expressions: [{ name: 'smile' }],
        }),
      };
    });

    (global as any).window = {
      aeonStageryAPI: {
        fs: { readTextFile },
      },
    };

    const loader = new Live2DModelResources(
      () => 'D:/projects/demo',
    );

    const data = await loader.getModelDataFromPath(
      'asset://localhost/D:/projects/demo/figure/casual-2023/model.json',
    );

    expect(data).toEqual({ motions: ['idle'], expressions: ['smile'] });
    expect(readTextFile).toHaveBeenCalledTimes(1);
  });

  it('decodes encoded asset URLs before reading model files from the filesystem', async () => {
    const readTextFile = vi.fn(async (path: string) => {
      expect(path).toBe('D:/projects/demo/figure/anon/腱鞘炎/model.json');
      return {
        success: true,
        data: JSON.stringify({
          motions: { idle: [{}] },
          expressions: [],
        }),
      };
    });

    (global as any).window = {
      aeonStageryAPI: {
        fs: { readTextFile },
      },
    };

    const loader = new Live2DModelResources(
      () => 'D:/projects/demo',
    );

    const data = await loader.getModelDataFromPath(
      'asset://localhost/D:/projects/demo/figure/anon/%E8%85%B1%E9%9E%98%E7%82%8E/model.json',
    );

    expect(data).toEqual({ motions: ['idle'], expressions: [] });
    expect(readTextFile).toHaveBeenCalledTimes(1);
  });

  it('preserves POSIX absolute paths decoded from asset URLs', async () => {
    const expectedPath = '/home/gamma/文档/template/anon/model.json';
    const readTextFile = vi.fn(async (path: string) => {
      expect(path).toBe(expectedPath);
      return {
        success: true,
        data: JSON.stringify({
          motions: { idle: [{}] },
          expressions: [],
        }),
      };
    });

    (global as any).window = {
      aeonStageryAPI: {
        fs: { readTextFile },
      },
    };

    const loader = new Live2DModelResources(
      () => '/home/gamma/project',
    );

    const data = await loader.getModelDataFromPath(
      'asset://localhost//home/gamma/%E6%96%87%E6%A1%A3/template/anon/model.json',
    );

    expect(data).toEqual({ motions: ['idle'], expressions: [] });
    expect(readTextFile).toHaveBeenCalledWith(expectedPath);
  });
});
