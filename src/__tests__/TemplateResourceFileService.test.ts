import { describe, expect, it, vi } from 'vitest';
import { posix } from 'node:path';
import { DEFAULT_PROJECT_ASSET_ROOTS, DEFAULT_PROJECT_TEMPLATE_CONFIGURATION, type ProjectState } from '../api/types/project';
import { SCENE_SCHEMA_VERSION } from '../api/types/semantic-scene';
import { WmdlConfigRegistry } from '../engine/WmdlConfigRegistry';
import type { IFileAccess } from '../services/io/IFileAccess';
import { ProjectPathResolver } from '../services/io/ProjectPathResolver';
import { ProjectResourceService } from '../services/io/ProjectResourceService';
import { ProjectSession } from '../services/io/ProjectSession';
import { SceneAssetService } from '../services/io/SceneAssetService';
import { TemplatePackageCatalog } from '../services/template-package/TemplatePackageCatalog';
import type { LoadedTemplatePackage, TemplatePackageManifest } from '../services/template-package/TemplatePackageManifest';
import { TemplateResourceFileService } from '../services/template-package/TemplateResourceFileService';

function project(enabledTemplateIds = ['demo']): ProjectState {
  return {
    rootPath: '/project', projectFilePath: '/project/project.json',
    metadata: {
      projectId: 'project', name: 'Project', projectVersion: 2,
      createdAt: '', updatedAt: '', defaultSceneId: 'main', scenes: [],
      assetRoots: { ...DEFAULT_PROJECT_ASSET_ROOTS },
      templates: { ...DEFAULT_PROJECT_TEMPLATE_CONFIGURATION, enabledTemplateIds },
    },
  };
}

function template(manifest: Partial<TemplatePackageManifest> = {}, root = '/templates/demo', scope: LoadedTemplatePackage['source']['scope'] = 'user'): LoadedTemplatePackage {
  return {
    source: { scope, packageRoot: root },
    manifest: { template: { id: 'demo', aliases: ['old-demo'], name: 'Demo', version: '1' }, ...manifest },
  };
}

function setup(packages: LoadedTemplatePackage[], contents: Record<string, string> = {}) {
  const files = new Map(Object.entries(contents));
  const fileAccess = {
    join: vi.fn(async (...parts: string[]) => posix.join(...parts.map((part) => part.replace(/\\/g, '/')))),
    exists: vi.fn(async (path: string) => files.has(path) || [...files.keys()].some((file) => file.startsWith(`${path}/`))),
    readDir: vi.fn(async (path: string) => {
      const entries = new Map<string, { name: string; path: string; isDirectory: boolean }>();
      for (const file of files.keys()) {
        if (!file.startsWith(`${path}/`)) continue;
        const parts = file.slice(path.length + 1).split('/');
        entries.set(parts[0], { name: parts[0], path: `${path}/${parts[0]}`, isDirectory: parts.length > 1 });
      }
      return [...entries.values()];
    }),
    readFile: vi.fn(async (path: string) => {
      if (!files.has(path)) throw new Error(`Missing file: ${path}`);
      return { path, data: files.get(path)! };
    }),
    copyFile: vi.fn(async (source: string, target: string) => {
      if (!files.has(source)) throw new Error(`Missing file: ${source}`);
      files.set(target, files.get(source)!);
    }),
    ensureDir: vi.fn(async () => {}),
    basename: vi.fn(async (path: string) => posix.basename(path)),
    dirname: vi.fn(async (path: string) => posix.dirname(path)),
    extname: vi.fn(async (path: string) => posix.extname(path)),
  };
  const session = new ProjectSession();
  session.setCurrentProject(project());
  const catalog = new TemplatePackageCatalog(packages);
  const resources = new ProjectResourceService(fileAccess as unknown as IFileAccess, new ProjectPathResolver(null), () => [], () => session.getCurrentProject());
  const assets = new SceneAssetService(fileAccess as unknown as IFileAccess, new WmdlConfigRegistry(), resources, () => '');
  const service = new TemplateResourceFileService(fileAccess, catalog, session, assets);
  return { service, catalog, session, files, fileAccess, resources, assets };
}

describe('TemplateResourceFileService', () => {
  it('merges explicit and convention entrypoints, deduplicates aliases and hides model dependencies', async () => {
    const pkg = template({
      assets: { root: 'content', index: [
        { id: 'actor', kind: 'live2dModel', path: 'live2d/actor/model.model3.json', metadata: { aliases: ['hero'] } },
        { id: 'room', kind: 'background', path: 'background/room.png' },
        { id: 'missing', kind: 'background', path: 'background/missing.png' },
      ] },
      resourceConventions: {
        live2dModel: { patterns: ['live2d/{character}/{entrypoint}'], entrypoints: ['model.model3.json'] },
        live2dMotion: { patterns: ['live2d/{character}/motions/{name}.{extension}'], extensions: ['motion3.json'] },
        bgm: { patterns: ['music/{name}.{extension}'], extensions: ['ogg'] },
      },
    });
    const { service } = setup([pkg], {
      '/templates/demo/content/live2d/actor/model.model3.json': '{}',
      '/templates/demo/content/live2d/actor/model.moc3': '',
      '/templates/demo/content/live2d/actor/textures/0.png': '',
      '/templates/demo/content/live2d/actor/motions/idle.motion3.json': '{}',
      '/templates/demo/content/background/room.png': '',
      '/templates/demo/content/music/song.ogg': '',
    });
    expect(await service.readDirectory('figure')).toMatchObject([{ name: 'live2d', isDirectory: true, source: '模板：Demo' }]);
    const models = await service.readDirectory('figure/live2d/actor');
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ name: 'model.model3.json', templateResource: { templateId: 'demo', packageRelativePath: 'content/live2d/actor/model.model3.json' } });
    expect(await service.readDirectory('background')).toMatchObject([{ name: 'room.png' }]);
    expect(await service.readDirectory('bgm/music')).toMatchObject([{ name: 'song.ogg' }]);
  });

  it('includes all preset variants with package-relative paths even without an asset index', async () => {
    const { service } = setup([template({
      assets: { root: 'content' },
      characterPresets: [{ id: 'actor', name: 'Actor', model: 'content/characters/primary.model3.json', variants: [
        { id: 'stage', name: 'Stage', model: 'content/characters/stage.model3.json' },
      ] }],
    })], {
      '/templates/demo/content/characters/primary.model3.json': '{}',
      '/templates/demo/content/characters/stage.model3.json': '{}',
    });
    expect((await service.readDirectory('figure/characters')).map((entry) => entry.name)).toEqual(['primary.model3.json', 'stage.model3.json']);
  });

  it('supports enabled aliases, prefers project packages and refreshes on configuration changes', async () => {
    const manifest = { assets: { index: [{ id: 'room', kind: 'background', path: 'background/room.png' }] } };
    const { service, session, catalog, fileAccess } = setup([
      template(manifest, '/builtin/demo', 'builtin'), template(manifest, '/user/demo', 'user'), template(manifest, '/project/templates/demo', 'project'),
    ], {
      '/builtin/demo/assets/background/room.png': '', '/user/demo/assets/background/room.png': '', '/project/templates/demo/assets/background/room.png': '',
    });
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);
    session.setCurrentProject(project(['old-demo']));
    expect(await service.readDirectory('background')).toMatchObject([{ path: '/project/templates/demo/assets/background/room.png' }]);
    fileAccess.exists.mockClear();
    await service.readDirectory('background');
    expect(fileAccess.exists).not.toHaveBeenCalled();
    catalog.setPackages([template(manifest, '/user/demo', 'user')]);
    expect(await service.readDirectory('background')).toMatchObject([{ path: '/user/demo/assets/background/room.png' }]);
    session.setCurrentProject(project([]));
    expect(await service.readDirectory('background')).toEqual([]);
    session.setCurrentProject(null);
    expect(await service.readDirectory('background')).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
    service.dispose();
    catalog.setPackages([]);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('maps audio and image entrypoints to standard categories while preserving nested paths', async () => {
    const kinds = { voice: 'vocal', sfx: 'sfx', image: 'images', icon: 'images', font: 'images', animation: 'animation', bgm: 'bgm' };
    const index = Object.keys(kinds).map((kind) => ({ id: kind, kind, path: `nested/${kind}.file` }));
    const { service } = setup([template({ assets: { index } })], Object.fromEntries(index.map((asset) => [`/templates/demo/assets/${asset.path}`, ''])));
    for (const [kind, directory] of Object.entries(kinds)) {
      expect(await service.readDirectory(`${directory}/nested`)).toEqual(expect.arrayContaining([expect.objectContaining({ name: `${kind}.file` })]));
    }
  });

  it('imports a complete model bundle and keeps saved scene references usable without the template', async () => {
    const root = '/templates/demo/assets/characters/actor';
    const { service, files, resources, assets, catalog } = setup([template({ assets: { index: [
      { id: 'actor', kind: 'live2dModel', path: 'characters/actor/model.model3.json' },
    ] } })], {
      [`${root}/model.model3.json`]: JSON.stringify({ FileReferences: {
        Moc: 'model.moc3', Textures: ['textures/0.png'],
        Motions: { Idle: [{ File: 'motions/idle.motion3.json' }] },
        Expressions: [{ Name: 'smile', File: 'expressions/smile.exp3.json' }],
      } }),
      [`${root}/model.moc3`]: 'moc', [`${root}/textures/0.png`]: 'texture',
      [`${root}/motions/idle.motion3.json`]: '{}', [`${root}/expressions/smile.exp3.json`]: '{}',
    });
    const [entry] = await service.readDirectory('figure/characters/actor');
    const reference = await service.importFile(entry.templateResource!, entry.path, 'figure');
    expect(reference).toBe('figure/templates/demo/assets/characters/actor/model.model3.json');
    for (const suffix of ['model.moc3', 'textures/0.png', 'motions/idle.motion3.json', 'expressions/smile.exp3.json']) {
      expect(files.has(`/project/${posix.dirname(reference)}/${suffix}`)).toBe(true);
    }
    const scene = await assets.normalizeSemanticSource({ schemaVersion: SCENE_SCHEMA_VERSION, sceneId: 'scene', meta: { title: 'Scene', characters: [{ id: 'actor', name: 'Actor', model: reference }] }, statements: [] });
    const reopened = JSON.parse(JSON.stringify(scene));
    catalog.setPackages([]);
    for (const path of files.keys()) if (path.startsWith('/templates/')) files.delete(path);
    expect(await resources.resolveForRead(reopened.meta.characters[0].model)).toBe(`/project/${reference}`);
  });

  it('rejects removed files, disabled templates, mismatched sources and escaping paths before copying', async () => {
    const path = '/templates/demo/assets/background/room.png';
    const { service, files, session, fileAccess } = setup([template({ assets: { index: [{ id: 'room', kind: 'background', path: 'background/room.png' }] } })], { [path]: '' });
    const [entry] = await service.readDirectory('background');
    await expect(service.importFile(entry.templateResource!, '/elsewhere/room.png', 'background')).rejects.toThrow('不可用');
    await expect(service.importFile({ templateId: 'demo', packageRelativePath: '../secret.png' }, path, 'background')).rejects.toThrow('escapes');
    files.delete(path);
    await expect(service.importFile(entry.templateResource!, path, 'background')).rejects.toThrow('不存在');
    files.set(path, '');
    session.setCurrentProject(project([]));
    await expect(service.importFile(entry.templateResource!, path, 'background')).rejects.toThrow('不可用');
    expect(fileAccess.copyFile).not.toHaveBeenCalled();
  });

  it('aborts a pending import if the template configuration changes during the file probe', async () => {
    const path = '/templates/demo/assets/background/room.png';
    const { service, catalog, fileAccess } = setup([template({ assets: { index: [{ id: 'room', kind: 'background', path: 'background/room.png' }] } })], { [path]: '' });
    const [entry] = await service.readDirectory('background');
    let resolveProbe!: (exists: boolean) => void;
    const probing = new Promise<void>((resolve) => {
      fileAccess.exists.mockImplementationOnce(() => {
        resolve();
        return new Promise<boolean>((complete) => { resolveProbe = complete; });
      });
    });
    const imported = service.importFile(entry.templateResource!, path, 'background');
    await probing;
    catalog.setPackages([]);
    resolveProbe(true);
    await expect(imported).rejects.toThrow('配置已变化');
    expect(fileAccess.copyFile).not.toHaveBeenCalled();
  });
});
