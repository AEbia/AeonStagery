import { describe, expect, it, vi } from 'vitest';
import type { IFileAccess } from '../services/io/IFileAccess';
import { ProjectPathResolver } from '../services/io/ProjectPathResolver';
import { ProjectResourceService } from '../services/io/ProjectResourceService';
import { SceneAssetService, type AssetReferenceScene } from '../services/io/SceneAssetService';
import { WmdlConfigRegistry } from '../engine/WmdlConfigRegistry';
import type { ProjectState } from '../api/types/project';
import {
  SCENE_SCHEMA_VERSION,
  SCENE_SCHEMA_VERSION_V4,
  type PreparedCompiledScene,
} from '../api/types/semantic-scene';

function createFileAccess(): Record<keyof IFileAccess, any> {
  return {
    readAsset: vi.fn(),
    readFile: vi.fn(),
    readBinaryFile: vi.fn(),
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    writeFile: vi.fn(),
    writeBinaryFile: vi.fn(),
    replaceFile: vi.fn(),
    ensureDir: vi.fn(),
    copyFile: vi.fn(),
    readDir: vi.fn(),
    exists: vi.fn(async () => true),
    stat: vi.fn(async () => null),
    realpath: vi.fn(async (pathValue: string) => pathValue),
    join: vi.fn(async (...parts: string[]) => parts.join('/').replace(/\\/g, '/').replace(/\/+/g, '/')),
    dirname: vi.fn(async (pathValue: string) => pathValue.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || '.'),
    basename: vi.fn(async (pathValue: string) => pathValue.replace(/\\/g, '/').split('/').pop() || pathValue),
    extname: vi.fn(async (pathValue: string) => {
      const base = pathValue.replace(/\\/g, '/').split('/').pop() || pathValue;
      const index = base.lastIndexOf('.');
      return index === -1 ? '' : base.slice(index);
    }),
  };
}

function createProject(): ProjectState {
  return {
    rootPath: 'D:/projects/demo',
    projectFilePath: 'D:/projects/demo/project.json',
    metadata: {
      projectId: 'demo',
      name: 'Demo',
      projectVersion: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      defaultSceneId: 'main',
      scenes: [{ id: 'main', name: 'Main', path: 'project/main.scene.json' }],
      assetRoots: {
        figure: 'figure',
        background: 'background',
        bgm: 'bgm',
        vocal: 'vocal',
        images: 'images',
        animation: 'animation',
        project: 'project',
        template: 'template',
      },
    },
  };
}

describe('SceneAssetService collaborative asset preparation', () => {
  it('stores stable mounted references during normal editing imports', async () => {
    const fileAccess = createFileAccess();
    const projectResources = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
      () => [{ id: 'shared-library', path: 'E:/Library' }],
    );
    projectResources.setCurrentProject(createProject());
    const service = new SceneAssetService(
      fileAccess as unknown as IFileAccess,
      new WmdlConfigRegistry(),
      projectResources,
      () => '',
    );

    const modelPath = await service.importAssetPath('E:/Library/figure/rana/model.json', 'figure');

    expect(modelPath).toBe('@mount/shared-library/figure/rana/model.json');
    expect(fileAccess.copyFile).not.toHaveBeenCalled();
  });

  it('copies shared Live2D bundle dependencies only once across template variants', async () => {
    const fileAccess = createFileAccess();
    fileAccess.readFile.mockImplementation(async (pathValue: string) => ({
      path: pathValue.replace(/\\/g, '/'),
      data: JSON.stringify({ textures: ['../shared/texture.png'] }),
    }));
    const projectResources = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
      () => [{ id: 'shared-library', path: 'E:/Library' }],
    );
    projectResources.setCurrentProject(createProject());
    const service = new SceneAssetService(
      fileAccess as unknown as IFileAccess,
      new WmdlConfigRegistry(),
      projectResources,
      () => '',
    );

    await service.importAssetPath('E:/Library/figure/anon/v1/model.json', 'figure', 'copy');
    await service.importAssetPath('E:/Library/figure/anon/v2/model.json', 'figure', 'copy');

    const sharedCopies = fileAccess.copyFile.mock.calls.filter(([, targetPath]: [string, string]) => (
      targetPath.replace(/\\/g, '/').endsWith('/figure/anon/shared/texture.png')
    ));
    expect(sharedCopies).toHaveLength(1);
  });

  it('does not copy Live2D bundle dependencies when the model is already inside the project', async () => {
    const fileAccess = createFileAccess();
    fileAccess.readFile.mockImplementation(async (pathValue: string) => {
      if (pathValue === 'D:/projects/demo/figure/rana/model.json') {
        return {
          path: pathValue,
          data: JSON.stringify({
            FileReferences: {
              Expressions: [{ File: 'expressions/smile.exp.json' }],
            },
          }),
        };
      }
      return { path: pathValue, data: '{}' };
    });
    const projectResources = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
      () => [],
    );
    projectResources.setCurrentProject(createProject());
    const service = new SceneAssetService(
      fileAccess as unknown as IFileAccess,
      new WmdlConfigRegistry(),
      projectResources,
      () => '',
    );

    const modelPath = await service.importAssetPath('D:/projects/demo/figure/rana/model.json', 'figure', 'copy');

    expect(modelPath).toBe('figure/rana/model.json');
    expect(fileAccess.copyFile).not.toHaveBeenCalled();
  });

  it('copies an app-installed template model without registering userData as an external library', async () => {
    const fileAccess = createFileAccess();
    fileAccess.readFile.mockImplementation(async (pathValue: string) => ({
      path: pathValue.replace(/\\/g, '/'),
      data: '{}',
    }));
    const projectResources = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
      () => [],
    );
    projectResources.setCurrentProject(createProject());
    const service = new SceneAssetService(
      fileAccess as unknown as IFileAccess,
      new WmdlConfigRegistry(),
      projectResources,
      () => '',
    );
    const templateRoot = 'C:/Users/test/AppData/Roaming/AeonStagery/templates/aeonstagery.mygo';
    const sourcePath = `${templateRoot}/assets/live2d/anon/model.json`;

    const modelPath = await service.importTemplateAssetPath(sourcePath, templateRoot, 'figure');

    expect(modelPath).toBe(
      'figure/templates/aeonstagery.mygo/assets/live2d/anon/model.json',
    );
    expect(fileAccess.copyFile).toHaveBeenCalledWith(
      sourcePath,
      'D:/projects/demo/figure/templates/aeonstagery.mygo/assets/live2d/anon/model.json',
    );
    await expect(service.importTemplateAssetPath(
      'C:/Users/test/AppData/Roaming/AeonStagery/secrets/model.json',
      templateRoot,
      'figure',
    )).rejects.toThrow('escapes its declared root');
  });

  it('migrates registered external absolute paths when saving a non-collaborative scene', async () => {
    const fileAccess = createFileAccess();
    const projectResources = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
      () => [{ id: 'shared-library', path: 'E:/Library' }],
    );
    projectResources.setCurrentProject(createProject());
    const service = new SceneAssetService(
      fileAccess as unknown as IFileAccess,
      new WmdlConfigRegistry(),
      projectResources,
      () => '',
    );
    const scene: AssetReferenceScene = {
      sceneId: 'scene_1',
      meta: {
        title: 'External Assets',
        characters: [
          { id: 'rana', name: 'Rana', model: 'E:/Library/figure/rana/model.json' },
        ],
      },
      timeline: [
        { _id: 'a1', action: 'addCharacter', time: 0, params: { id: 'rana', model: 'E:/Library/figure/rana/model.json' } },
        { _id: 'a2', action: 'setBackground', time: 0, params: { image: 'E:/Library/background/livehouse.png' } },
      ],
    };

    const prepared = await service.prepareForSave(scene, 'D:/projects/demo/project/main.scene.json');

    expect(prepared.meta.characters?.[0].model).toBe('@mount/shared-library/figure/rana/model.json');
    expect(prepared.timeline[0].params.model).toBe('@mount/shared-library/figure/rana/model.json');
    expect(prepared.timeline[1].params.image).toBe('@mount/shared-library/background/livehouse.png');
    expect(fileAccess.copyFile).not.toHaveBeenCalled();
  });

  it('normalizes legacy absolute character metadata before semantic compilation', async () => {
    const fileAccess = createFileAccess();
    const projectResources = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
      () => [{ id: 'webgal-sv', path: 'E:/Library' }],
    );
    projectResources.setCurrentProject(createProject());
    const service = new SceneAssetService(
      fileAccess as unknown as IFileAccess,
      new WmdlConfigRegistry(),
      projectResources,
      () => '',
    );

    const normalized = await service.normalizeSemanticSource({
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'semantic-scene',
      meta: {
        title: 'External character',
        characters: [{ id: '1', name: 'Character', model: 'E:/Library/game/figure/anon/model.json' }],
      },
      statements: [],
    });

    expect(normalized.meta.characters?.[0].model)
      .toBe('@mount/webgal-sv/game/figure/anon/model.json');
  });

  it('projectizes mounted semantic references before collaboration manifest building', async () => {
    const fileAccess = createFileAccess();
    fileAccess.readFile.mockImplementation(async (pathValue: string) => ({
      path: pathValue.replace(/\\/g, '/'),
      data: '{}',
    }));
    const projectResources = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
      () => [{ id: 'webgal-sv', path: 'E:/Library' }],
    );
    projectResources.setCurrentProject(createProject());
    const service = new SceneAssetService(
      fileAccess as unknown as IFileAccess,
      new WmdlConfigRegistry(),
      projectResources,
      () => '',
    );

    const projectized = await service.prepareCollaborativeV2SceneDocumentAssetReferences({
      schemaVersion: SCENE_SCHEMA_VERSION_V4,
      sceneId: 'semantic-scene',
      meta: {
        title: 'Mounted assets',
        characters: [{ id: '1', name: 'Character', model: '@mount/webgal-sv/figure/anon/model.json' }],
      },
      statements: [
        {
          id: 'enter',
          time: 0,
          type: 'characterPresence',
          params: { mode: 'enter', id: '1', model: '@mount/webgal-sv/figure/anon/model.json' },
        },
        {
          id: 'line',
          time: 1,
          type: 'dialogue',
          params: { text: 'hello', durationSeconds: 1, voice: '@mount/webgal-sv/vocal/hello.wav' },
        },
      ],
    });

    expect(projectized.meta.characters?.[0].model)
      .toBe('figure/external/webgal-sv/anon/model.json');
    expect(projectized.statements[0].params).toMatchObject({
      model: 'figure/external/webgal-sv/anon/model.json',
    });
    expect(projectized.statements[1].params).toMatchObject({
      voice: 'vocal/external/webgal-sv/hello.wav',
    });
    expect(fileAccess.copyFile).toHaveBeenCalledWith(
      'E:/Library/figure/anon/model.json',
      'D:/projects/demo/figure/external/webgal-sv/anon/model.json',
    );
    expect(fileAccess.copyFile).toHaveBeenCalledWith(
      'E:/Library/vocal/hello.wav',
      'D:/projects/demo/vocal/external/webgal-sv/hello.wav',
    );
  });

  it('projectizes mounted V5 semantic references and copies Live2D expression bundle files before collaboration', async () => {
    const fileAccess = createFileAccess();
    fileAccess.readFile.mockImplementation(async (pathValue: string) => ({
      path: pathValue.replace(/\\/g, '/'),
      data: pathValue.replace(/\\/g, '/').endsWith('/figure/anon/casual-2023/main/model.json')
        ? JSON.stringify({
            expressions: [
              { name: 'angry', file: '../../.mtn_exp/expressions/__base__/anon/angry01.exp.json' },
            ],
          })
        : '{}',
    }));
    const projectResources = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
      () => [{ id: 'webgal-sv', path: 'E:/Library' }],
    );
    projectResources.setCurrentProject(createProject());
    const service = new SceneAssetService(
      fileAccess as unknown as IFileAccess,
      new WmdlConfigRegistry(),
      projectResources,
      () => '',
    );

    const projectized = await service.prepareCollaborativeV5SceneDocumentAssetReferences({
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'semantic-scene',
      meta: {
        title: 'Mounted assets',
        characters: [{ id: '1', name: 'Character', model: '@mount/webgal-sv/figure/anon/casual-2023/main/model.json' }],
      },
      statements: [
        {
          id: 'enter',
          time: 0,
          type: 'characterPresence',
          params: { mode: 'enter', id: '1', model: '@mount/webgal-sv/figure/anon/casual-2023/main/model.json' },
        },
        {
          id: 'line',
          time: 1,
          type: 'dialogue',
          params: { text: 'hello', durationSeconds: 1, voice: '@mount/webgal-sv/vocal/hello.wav' },
        },
      ],
    });

    expect(projectized.meta.characters?.[0].model)
      .toBe('figure/external/webgal-sv/anon/casual-2023/main/model.json');
    expect(projectized.statements[0].params).toMatchObject({
      model: 'figure/external/webgal-sv/anon/casual-2023/main/model.json',
    });
    expect(projectized.statements[1].params).toMatchObject({
      voice: 'vocal/external/webgal-sv/hello.wav',
    });
    expect(fileAccess.copyFile).toHaveBeenCalledWith(
      'E:/Library/figure/anon/casual-2023/main/model.json',
      'D:/projects/demo/figure/external/webgal-sv/anon/casual-2023/main/model.json',
    );
    expect(fileAccess.copyFile).toHaveBeenCalledWith(
      'E:/Library/figure/anon/casual-2023/main/../../.mtn_exp/expressions/__base__/anon/angry01.exp.json',
      'D:/projects/demo/figure/external/webgal-sv/anon/.mtn_exp/expressions/__base__/anon/angry01.exp.json',
    );
    expect(fileAccess.copyFile).toHaveBeenCalledWith(
      'E:/Library/vocal/hello.wav',
      'D:/projects/demo/vocal/external/webgal-sv/hello.wav',
    );
  });

  it('keeps same-relative-path assets from different mounts distinct during collaboration', async () => {
    const fileAccess = createFileAccess();
    const projectResources = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
      () => [
        { id: 'library-a', path: 'E:/Library A' },
        { id: 'library-b', path: 'F:/Library B' },
      ],
    );
    projectResources.setCurrentProject(createProject());
    const service = new SceneAssetService(
      fileAccess as unknown as IFileAccess,
      new WmdlConfigRegistry(),
      projectResources,
      () => '',
    );

    const projectized = await service.prepareCollaborativeV2SceneDocumentAssetReferences({
      schemaVersion: SCENE_SCHEMA_VERSION_V4,
      sceneId: 'semantic-scene',
      meta: { title: 'Mounted collision' },
      statements: [
        {
          id: 'background-a',
          time: 0,
          type: 'environmentLayer',
          params: {
            mode: 'set',
            layerId: 'a',
            image: '@mount/library-a/background/shared.png',
          },
        },
        {
          id: 'background-b',
          time: 1,
          type: 'environmentLayer',
          params: {
            mode: 'set',
            layerId: 'b',
            image: '@mount/library-b/background/shared.png',
          },
        },
      ],
    });

    const firstReference = (projectized.statements[0].params as { image?: string }).image;
    const secondReference = (projectized.statements[1].params as { image?: string }).image;
    expect(firstReference).not.toBe(secondReference);
    expect(fileAccess.copyFile).toHaveBeenCalledWith(
      'E:/Library A/background/shared.png',
      `D:/projects/demo/${firstReference}`,
    );
    expect(fileAccess.copyFile).toHaveBeenCalledWith(
      'F:/Library B/background/shared.png',
      `D:/projects/demo/${secondReference}`,
    );
  });

  it('copies external Live2D bundles and backgrounds into the project before collaboration', async () => {
    const fileAccess = createFileAccess();
    fileAccess.readFile.mockImplementation(async (pathValue: string) => {
      const normalized = pathValue.replace(/\\/g, '/');
      if (normalized === 'E:/Library/figure/rana/model.json') {
        return {
          path: normalized,
          data: JSON.stringify({
            FileReferences: {
              Moc: 'rana.moc3',
              Textures: ['textures/rana.00.png'],
              Motions: {
                Idle: [{ File: 'motions/idle.motion3.json' }],
              },
              Expressions: [{ File: 'expressions/smile.exp3.json' }],
            },
          }),
        };
      }
      if (normalized === 'E:/Library/figure/rana/motions/idle.motion3.json') {
        return {
          path: normalized,
          data: JSON.stringify({ Version: 3, Meta: {}, Curves: [] }),
        };
      }
      return { path: normalized, data: '{}' };
    });
    const projectResources = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
      () => [{ id: 'shared-library', path: 'E:/Library' }],
    );
    projectResources.setCurrentProject(createProject());
    const service = new SceneAssetService(
      fileAccess as unknown as IFileAccess,
      new WmdlConfigRegistry(),
      projectResources,
      () => '',
    );
    const scene: AssetReferenceScene = {
      sceneId: 'scene_1',
      meta: {
        title: 'External Assets',
        characters: [
          { id: 'rana', name: 'Rana', model: 'E:/Library/figure/rana/model.json' },
        ],
      },
      timeline: [
        { _id: 'a1', action: 'addCharacter', time: 0, params: { id: 'rana', model: 'E:/Library/figure/rana/model.json' } },
        { _id: 'a2', action: 'setBackground', time: 0, params: { image: 'E:/Library/background/livehouse.png' } },
      ],
    };

    const prepared = await service.prepareCollaborativeAssetReferences(scene);

    expect(prepared.meta.characters?.[0].model)
      .toBe('figure/external/shared-library/rana/model.json');
    expect(prepared.timeline[0].params.model)
      .toBe('figure/external/shared-library/rana/model.json');
    expect(prepared.timeline[1].params.image)
      .toBe('background/external/shared-library/livehouse.png');
    expect(fileAccess.copyFile).toHaveBeenCalledWith(
      'E:/Library/figure/rana/model.json',
      'D:/projects/demo/figure/external/shared-library/rana/model.json',
    );
    expect(fileAccess.copyFile).toHaveBeenCalledWith(
      'E:/Library/figure/rana/rana.moc3',
      'D:/projects/demo/figure/external/shared-library/rana/rana.moc3',
    );
    expect(fileAccess.copyFile).toHaveBeenCalledWith(
      'E:/Library/figure/rana/textures/rana.00.png',
      'D:/projects/demo/figure/external/shared-library/rana/textures/rana.00.png',
    );
    expect(fileAccess.copyFile).toHaveBeenCalledWith(
      'E:/Library/background/livehouse.png',
      'D:/projects/demo/background/external/shared-library/livehouse.png',
    );
  });

  it('projectizes legacy root-relative external references before collaboration', async () => {
    const fileAccess = createFileAccess();
    fileAccess.exists.mockImplementation(async (pathValue: string) => {
      const normalized = pathValue.replace(/\\/g, '/');
      return normalized.startsWith('E:/Library/');
    });
    fileAccess.readFile.mockImplementation(async (pathValue: string) => ({
      path: pathValue.replace(/\\/g, '/'),
      data: JSON.stringify({
        FileReferences: {
          Moc: 'rana.moc3',
          Textures: ['textures/rana.00.png'],
        },
      }),
    }));
    const projectResources = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
      () => [{ id: 'shared-library', path: 'E:/Library' }],
    );
    projectResources.setCurrentProject(createProject());
    const service = new SceneAssetService(
      fileAccess as unknown as IFileAccess,
      new WmdlConfigRegistry(),
      projectResources,
      () => '',
    );
    const scene: AssetReferenceScene = {
      sceneId: 'scene_1',
      meta: { title: 'Mounted Assets' },
      timeline: [
        { _id: 'a1', action: 'addCharacter', time: 0, params: { id: 'rana', model: 'figure/rana/model.json' } },
        { _id: 'a2', action: 'setBackground', time: 0, params: { image: 'background/livehouse.png' } },
      ],
    };

    const prepared = await service.prepareCollaborativeAssetReferences(scene);

    expect(prepared.timeline[0].params.model).toBe('figure/rana/model.json');
    expect(prepared.timeline[1].params.image).toBe('background/livehouse.png');
    expect(fileAccess.copyFile).toHaveBeenCalledWith(
      'E:/Library/figure/rana/model.json',
      'D:/projects/demo/figure/rana/model.json',
    );
    expect(fileAccess.copyFile).toHaveBeenCalledWith(
      'E:/Library/background/livehouse.png',
      'D:/projects/demo/background/livehouse.png',
    );
  });

  it('hydrates prepared .wmdl runtime configs without projecting back through a legacy scene adapter', async () => {
    const fileAccess = createFileAccess();
    fileAccess.readFile.mockImplementation(async (pathValue: string) => ({
      path: pathValue.replace(/\\/g, '/'),
      data: JSON.stringify({
        modelRelativePath: 'model.json',
        subModels: [
          { id: 'face', modelRelativePath: 'face/model.json' },
        ],
      }),
    }));
    const projectResources = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
      () => [],
    );
    projectResources.setCurrentProject(createProject());
    const registry = new WmdlConfigRegistry();
    const service = new SceneAssetService(
      fileAccess as unknown as IFileAccess,
      registry,
      projectResources,
      () => '',
    );
    const runtimeUri = 'asset://localhost/D:/projects/demo/figure/rana/rana.wmdl';
    const scene: PreparedCompiledScene = {
      kind: 'prepared-compiled-scene',
      sourceSchemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'scene_1',
      meta: { title: 'Prepared Runtime' },
      durationSeconds: 1,
      actions: [
        {
          id: 'compiled:add-character',
          time: 0,
          action: 'addCharacter',
          params: {
            id: 'rana',
            model: {
              source: 'figure/rana/rana.wmdl',
              runtimeUri,
            },
          },
          source: {
            statementId: 'stmt-rana',
            outputKey: 'primary',
          },
        },
      ],
    };

    await service.hydratePreparedRuntimeConfigs(scene);

    expect(fileAccess.readFile).toHaveBeenCalledWith('D:/projects/demo/figure/rana/rana.wmdl');
    expect(registry.get('figure/rana/rana.wmdl')?.modelRelativePath).toBe('D:/projects/demo/figure/rana/model.json');
    expect(registry.get(runtimeUri)?.subModels[0].modelRelativePath).toBe('D:/projects/demo/figure/rana/face/model.json');
  });
});
