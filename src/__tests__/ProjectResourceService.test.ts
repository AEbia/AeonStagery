import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectResourceService } from '../services/io/ProjectResourceService';
import { ProjectPathResolver } from '../services/io/ProjectPathResolver';
import type { IFileAccess } from '../services/io/IFileAccess';
import type { ProjectState } from '../api/types/project';
import { NoActiveProjectError } from '../api/types/project';

describe('ProjectResourceService', () => {
  let fileAccess: Record<keyof IFileAccess, any>;
  let service: ProjectResourceService;

  const project: ProjectState = {
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

  beforeEach(() => {
    fileAccess = {
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
      stat: vi.fn(async () => null),
      realpath: vi.fn(async (pathValue: string) => pathValue),
      exists: vi.fn(async (pathValue: string) => pathValue.replace(/\\/g, '/') === 'E:/Library/figure/casual-2023/model.json'),
      join: vi.fn(async (...parts: string[]) => parts.join('/').replace(/\\/g, '/').replace(/\/+/g, '/')),
      dirname: vi.fn(async (pathValue: string) => pathValue.split('/').slice(0, -1).join('/') || '.'),
      basename: vi.fn(async (pathValue: string) => pathValue.split('/').pop() || pathValue),
      extname: vi.fn(async (pathValue: string) => {
        const idx = pathValue.lastIndexOf('.');
        return idx === -1 ? '' : pathValue.slice(idx);
      }),
    };
    // removeFile is service-optional and absent from IFileAccess; the resource
    // cache invalidation test needs it on the concrete mock.
    (fileAccess as any).removeFile = vi.fn(async () => undefined);

    service = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
      () => [{ id: 'shared-library', path: 'E:/Library' }],
    );
    service.setCurrentProject(project);
  });

  it('mounts external library assets for normal project storage without copying', async () => {
    const result = await service.normalizeForStorage('E:/Library/figure/casual-2023/model.json', 'figure');

    expect(result).toEqual({
      mode: 'mount',
      kind: 'figure',
      relativePath: '@mount/shared-library/figure/casual-2023/model.json',
    });
    expect(fileAccess.ensureDir).not.toHaveBeenCalled();
    expect(fileAccess.copyFile).not.toHaveBeenCalled();
  });

  it('never falls back to copying unregistered absolute asset paths', async () => {
    await expect(
      service.normalizeForStorage('F:/Downloads/casual-2023/model.json', 'figure'),
    ).rejects.toThrow('outside the active project and registered external libraries');

    expect(fileAccess.copyFile).not.toHaveBeenCalled();
    expect(fileAccess.ensureDir).not.toHaveBeenCalled();
  });

  it('copies when importIntoProject receives an external-library asset path', async () => {
    const result = await service.importIntoProject('E:/Library/figure/casual-2023/model.json', 'figure');

    expect(result).toEqual({
      mode: 'copy',
      kind: 'figure',
      relativePath: 'figure/casual-2023/model.json',
    });
    expect(fileAccess.ensureDir).toHaveBeenCalledWith('D:/projects/demo/figure/casual-2023');
    expect(fileAccess.copyFile).toHaveBeenCalledWith(
      'E:/Library/figure/casual-2023/model.json',
      'D:/projects/demo/figure/casual-2023/model.json',
    );
  });

  it('materializes a source only when it remains inside the trusted template root', async () => {
    await expect(service.materializeFromTrustedRoot(
      'C:/templates/mygo',
      'C:/templates/mygo/assets/background/classroom.webp',
      'background',
      'background/mygo/classroom.webp',
    )).resolves.toEqual({
      mode: 'copy',
      kind: 'background',
      relativePath: 'background/mygo/classroom.webp',
    });
    expect(fileAccess.copyFile).toHaveBeenCalledWith(
      'C:/templates/mygo/assets/background/classroom.webp',
      'D:/projects/demo/background/mygo/classroom.webp',
    );

    await expect(service.materializeFromTrustedRoot(
      'C:/templates/mygo',
      'C:/templates/other/assets/background/classroom.webp',
      'background',
      'background/mygo/classroom.webp',
    )).rejects.toThrow('escapes its declared root');
  });

  it('copies external-library assets into the project when importIntoProject is forced to copy', async () => {
    const result = await service.importIntoProject('E:/Library/figure/casual-2023/model.json', 'figure', 'copy');

    expect(result).toEqual({
      mode: 'copy',
      kind: 'figure',
      relativePath: 'figure/casual-2023/model.json',
    });
    expect(fileAccess.ensureDir).toHaveBeenCalledWith('D:/projects/demo/figure/casual-2023');
    expect(fileAccess.copyFile).toHaveBeenCalledWith(
      'E:/Library/figure/casual-2023/model.json',
      'D:/projects/demo/figure/casual-2023/model.json',
    );
  });

  it('resolves project-relative paths through external library roots when the project copy is absent', async () => {
    const resolved = await service.resolveForRead('figure/casual-2023/model.json');

    expect(resolved).toBe('E:/Library/figure/casual-2023/model.json');
  });

  it('resolves a mounted reference through its exact registered root', async () => {
    const resolved = await service.resolveForRead('@mount/shared-library/figure/casual-2023/model.json');

    expect(resolved).toBe('E:/Library/figure/casual-2023/model.json');
  });

  it('builds mounted runtime URLs from the resolved external-library path', async () => {
    const runtimeUrl = await service.resolveForRuntime(
      '@mount/shared-library/figure/casual-2023/model.json',
    );

    expect(runtimeUrl).toBe('asset://localhost/E:/Library/figure/casual-2023/model.json');
    expect(runtimeUrl).not.toContain('D:/projects/demo/@mount');
  });

  it.each([
    ['E:/Library', '@mount/figure/figure/casual-2023/model.json'],
    ['E:/Library/figure', '@mount/figure/casual-2023/model.json'],
  ])('round-trips a figure mount rooted at %s without adding a figure directory', async (rootPath, reference) => {
    const resources = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
      () => [{ id: 'figure', path: rootPath }],
    );
    resources.setCurrentProject(project);

    const stored = await resources.normalizeForStorage('E:/Library/figure/casual-2023/model.json', 'figure');
    expect(stored.relativePath).toBe(reference);
    expect(await resources.resolveForRuntime(stored.relativePath))
      .toBe('asset://localhost/E:/Library/figure/casual-2023/model.json');
  });

  it('reports an unavailable project asset instead of returning a runtime URL for its fallback path', async () => {
    fileAccess.exists.mockResolvedValue(false);
    const reference = 'figure/ghost.model3.json';

    await expect(service.resolveForReadWithStatus(reference)).resolves.toMatchObject({
      status: 'project-asset-missing',
      reference,
      relativePath: reference,
      path: 'D:/projects/demo/figure/ghost.model3.json',
    });
    await expect(service.resolveForRuntime(reference)).rejects.toMatchObject({
      name: 'ProjectResourceResolutionError',
      resolution: { status: 'project-asset-missing', reference },
    });
  });

  it('reports a missing mounted root instead of searching other libraries', async () => {
    await expect(
      service.resolveForRead('@mount/missing-library/figure/casual-2023/model.json'),
    ).rejects.toThrow('External library mount "missing-library" is not registered');
  });

  it('reports an unbound mount as a structured resolution status', async () => {
    await expect(
      service.resolveForReadWithStatus('@mount/missing-library/figure/casual-2023/model.json'),
    ).resolves.toEqual({
      status: 'mount-unbound',
      mountId: 'missing-library',
      reference: '@mount/missing-library/figure/casual-2023/model.json',
      relativePath: 'figure/casual-2023/model.json',
    });
  });

  it('reports an invalid mount reference without throwing from the status API', async () => {
    await expect(
      service.resolveForReadWithStatus('@mount/Bad Id!/figure/model.json'),
    ).resolves.toMatchObject({ status: 'invalid-reference' });
    await expect(
      service.resolveForReadWithStatus('@mount/shared-library/../escape.json'),
    ).resolves.toMatchObject({ status: 'invalid-reference' });
  });

  it('resolves mounted references by embedded mount, project binding, then exact global mount', async () => {
    const reference = '@mount/shared-library/figure/casual-2023/model.json';
    const embeddedFile = 'D:/projects/demo/.aeonstagery/embedded/shared-library/figure/casual-2023/model.json';
    const bindingFile = 'F:/Project Binding/figure/casual-2023/model.json';
    const globalFile = 'E:/Library/figure/casual-2023/model.json';
    fileAccess.exists.mockImplementation(async (pathValue: string) => {
      const normalized = pathValue.replace(/\\/g, '/');
      return normalized === embeddedFile || normalized === bindingFile || normalized === globalFile
        || normalized === 'F:/Project Binding' || normalized === 'E:/Library';
    });
    const boundService = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
      () => [{ id: 'shared-library', path: 'E:/Library' }],
      () => null,
      () => ({ demo: { 'shared-library': 'F:/Project Binding' } }),
    );

    boundService.setCurrentProject({
      ...project,
      metadata: {
        ...project.metadata,
        embeddedLibraryMounts: [{ id: 'shared-library', path: '.aeonstagery/embedded/shared-library' }],
      },
    });
    await expect(boundService.resolveForReadWithStatus(reference)).resolves.toMatchObject({
      status: 'ready',
      source: 'embedded-mount',
      path: embeddedFile,
    });

    // A single missing file inside the embedded copy is repaired by the
    // project binding tier.
    boundService.setCurrentProject(project);
    await expect(boundService.resolveForReadWithStatus(reference)).resolves.toMatchObject({
      status: 'ready',
      source: 'project-binding',
      path: bindingFile,
    });

    // The project binding shadows the global library even when the bound
    // directory moved away: the failure must name the stale binding, not
    // quietly switch machines' libraries underneath the user.
    fileAccess.exists.mockImplementation(async (pathValue: string) => {
      const normalized = pathValue.replace(/\\/g, '/');
      return normalized === globalFile || normalized === 'E:/Library';
    });
    const reboundBound = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
      () => [{ id: 'shared-library', path: 'E:/Library' }],
      () => null,
      () => ({ demo: { 'shared-library': 'F:/Project Binding' } }),
    );
    reboundBound.setCurrentProject(project);
    await expect(reboundBound.resolveForReadWithStatus(reference)).resolves.toMatchObject({
      status: 'mount-root-missing',
      mountId: 'shared-library',
      root: 'F:/Project Binding',
      boundVia: 'project-binding',
    });

    const globalOnlyService = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
      () => [{ id: 'shared-library', path: 'E:/Library' }],
    );
    globalOnlyService.setCurrentProject(project);
    await expect(globalOnlyService.resolveForReadWithStatus(reference)).resolves.toMatchObject({
      status: 'ready',
      source: 'global-mount',
      path: globalFile,
    });
  });

  it('distinguishes a missing file inside an existing bound root from a missing root', async () => {
    const reference = '@mount/shared-library/figure/absent.json';
    fileAccess.exists.mockImplementation(async (pathValue: string) => {
      const normalized = pathValue.replace(/\\/g, '/');
      return normalized === 'E:/Library' || normalized === 'E:/Library/figure/casual-2023/model.json';
    });
    const scoped = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
      () => [{ id: 'shared-library', path: 'E:/Library' }],
      () => null,
      () => ({ demo: { 'shared-library': 'E:/Library' } }),
    );
    scoped.setCurrentProject(project);
    await expect(scoped.resolveForReadWithStatus(reference)).resolves.toMatchObject({
      status: 'asset-missing',
      mountId: 'shared-library',
      relativePath: 'figure/absent.json',
      path: 'E:/Library/figure/absent.json',
      root: 'E:/Library',
      boundVia: 'project-binding',
    });
  });

  it('converts mounted references to project-relative collaboration references', () => {
    expect(service.toCollaborationReference('@mount/shared-library/figure/casual-2023/model.json'))
      .toBe('.aeonstagery/mounts/shared-library/figure/casual-2023/model.json');
  });

  it('keeps the source reference stable when a mount is rebound to another local path', async () => {
    fileAccess.exists.mockImplementation(async (pathValue: string) => {
      const normalized = pathValue.replace(/\\/g, '/');
      return normalized === 'E:/Library'
        || normalized === 'F:/Moved Library'
        || normalized === 'E:/Library/figure/casual-2023/model.json'
        || normalized === 'F:/Moved Library/figure/casual-2023/model.json';
    });
    let mounts = [{ id: 'shared-library', path: 'E:/Library' }];
    const reboundService = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
      () => mounts,
    );
    reboundService.setCurrentProject(project);
    const reference = '@mount/shared-library/figure/casual-2023/model.json';

    expect(await reboundService.resolveForRead(reference)).toBe('E:/Library/figure/casual-2023/model.json');
    mounts = [{ id: 'shared-library', path: 'F:/Moved Library' }];
    expect(await reboundService.resolveForRead(reference)).toBe('F:/Moved Library/figure/casual-2023/model.json');
  });

  it('treats /figure style asset references as root-relative project assets', async () => {
    const normalized = await service.normalizeForStorage('/figure/casual-2023/model.json', 'figure');
    const resolved = await service.resolveForRead('/figure/casual-2023/model.json');

    expect(normalized.relativePath).toBe('figure/casual-2023/model.json');
    expect(resolved).toBe('E:/Library/figure/casual-2023/model.json');
  });

  it('prefers the project copy for standard asset paths when a project copy exists', async () => {
    fileAccess.exists.mockImplementation(async (pathValue: string) => {
      const normalized = pathValue.replace(/\\/g, '/');
      return normalized === 'D:/projects/demo/figure/casual-2023/model.json'
        || normalized === 'E:/Library/figure/casual-2023/model.json';
    });

    const resolved = await service.resolveForRead('figure/casual-2023/model.json');

    expect(resolved).toBe('D:/projects/demo/figure/casual-2023/model.json');
  });

  it('resolves collaborative asset downloads into the active project root', async () => {
    const resolved = await service.resolveForProjectWrite('figure/casual-2023/model.json');

    expect(resolved).toBe('D:/projects/demo/figure/casual-2023/model.json');
  });

  describe('project metadata v2 automatic upgrade and compatibility', () => {
    it('automatically upgrades v1 project.json to v2 on disk and in loaded state', async () => {
      const v1Data = {
        projectId: 'demo-v1',
        name: 'Demo V1',
        projectVersion: 1,
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
        futureMetadataKey: 'custom-val',
      };

      fileAccess.readFile.mockResolvedValue({
        path: 'D:/projects/demo/project.json',
        data: JSON.stringify(v1Data),
      });

      const loaded = await service.loadProject('D:/projects/demo/project.json');

      expect(loaded.metadata.projectVersion).toBe(2);
      expect(loaded.metadata.name).toBe('Demo V1');
      expect(fileAccess.writeFile).toHaveBeenCalledWith(
        'D:/projects/demo/project.json',
        expect.stringContaining('"projectVersion": 2'),
      );
      // Serialized output retains unknown fields
      const writtenContent = JSON.parse(fileAccess.writeFile.mock.calls[0][1]);
      expect(writtenContent.futureMetadataKey).toBe('custom-val');
    });

    it('automatically upgrades unversioned legacy metadata to v2 on disk', async () => {
      const legacyData = {
        projectId: 'legacy-demo',
        name: 'Legacy Demo',
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
      };

      fileAccess.readFile.mockResolvedValue({
        path: 'D:/projects/legacy/project.json',
        data: JSON.stringify(legacyData),
      });

      const loaded = await service.loadProject('D:/projects/legacy/project.json');

      expect(loaded.metadata.projectVersion).toBe(2);
      expect(loaded.metadata.name).toBe('Legacy Demo');
      expect(fileAccess.writeFile).toHaveBeenCalledWith(
        'D:/projects/legacy/project.json',
        expect.stringContaining('"projectVersion": 2'),
      );
    });

    it('rejects future schema epoch without touching disk', async () => {
      const futureData = {
        projectId: 'future-demo',
        name: 'Future Demo',
        projectVersion: 3,
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
      };

      fileAccess.readFile.mockResolvedValue({
        path: 'D:/projects/future/project.json',
        data: JSON.stringify(futureData),
      });

      await expect(service.loadProject('D:/projects/future/project.json')).rejects.toThrow(
        'Unsupported project schema epoch 3; expected 2',
      );
      expect(fileAccess.writeFile).not.toHaveBeenCalled();
    });

    it('rejects invalid or malformed metadata without touching disk', async () => {
      fileAccess.readFile.mockResolvedValue({
        path: 'D:/projects/invalid/project.json',
        data: '{"not valid json',
      });

      await expect(service.loadProject('D:/projects/invalid/project.json')).rejects.toThrow(
        'invalid JSON',
      );
      expect(fileAccess.writeFile).not.toHaveBeenCalled();

      fileAccess.readFile.mockResolvedValue({
        path: 'D:/projects/malformed/project.json',
        data: JSON.stringify({ projectVersion: -5 }),
      });

      await expect(service.loadProject('D:/projects/malformed/project.json')).rejects.toThrow(
        'Expected a positive integer',
      );
      expect(fileAccess.writeFile).not.toHaveBeenCalled();
    });

    it('preserves unknown fields through load and save cycles', async () => {
      const v2DataWithUnknowns = {
        projectId: 'demo-v2',
        name: 'Demo V2',
        projectVersion: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        defaultSceneId: 'main',
        scenes: [{
          id: 'main',
          name: 'Main',
          path: 'project/main.scene.json',
          futureSceneOption: 'keep-nested',
        }],
        assetRoots: {
          figure: 'figure',
          background: 'background',
          bgm: 'bgm',
          vocal: 'vocal',
          images: 'images',
          animation: 'animation',
          project: 'project',
          template: 'template',
          customRoot: 'custom/path',
        },
        topLevelExtra: { foo: 'bar' },
      };

      fileAccess.readFile.mockResolvedValue({
        path: 'D:/projects/demo/project.json',
        data: JSON.stringify(v2DataWithUnknowns),
      });

      const loaded = await service.loadProject('D:/projects/demo/project.json');
      expect(loaded.metadata.name).toBe('Demo V2');

      // Edit typed property and save
      const updated = await service.saveProjectMetadata(loaded, {
        ...loaded.metadata,
        name: 'Renamed Demo V2',
      });

      expect(updated.metadata.name).toBe('Renamed Demo V2');
      const projectJsonWrite = fileAccess.writeFile.mock.calls.find(([callPath]: [string]) => callPath.endsWith('project.json'));
      expect(projectJsonWrite).toBeDefined();
      const writtenJson = JSON.parse(projectJsonWrite![1]);

      expect(writtenJson.name).toBe('Renamed Demo V2');
      expect(writtenJson.topLevelExtra).toEqual({ foo: 'bar' });
      expect(writtenJson.assetRoots.customRoot).toBe('custom/path');
      expect(writtenJson.scenes[0].futureSceneOption).toBe('keep-nested');
    });
  });

  describe('read-resolution cache', () => {
    it('caches positive read resolutions across repeated resolves', async () => {
      const first = await service.resolveForRead('figure/casual-2023/model.json');
      const statCountAfterFirst = (fileAccess.exists as any).mock.calls.length;

      const second = await service.resolveForRead('figure/casual-2023/model.json');

      expect(second).toBe(first);
      expect((fileAccess.exists as any).mock.calls.length).toBe(statCountAfterFirst);
    });

    it('re-resolves after switching projects without serving stale results', async () => {
      (fileAccess.exists as any).mockImplementation(async (pathValue: string) =>
        pathValue.replace(/\\/g, '/') === 'D:/projects/demo/figure/local.model3.json'
        || pathValue.replace(/\\/g, '/') === 'F:/other/figure/local.model3.json',
      );
      await service.resolveForRead('figure/local.model3.json');

      service.setCurrentProject({ ...project, rootPath: 'F:/other' });
      const resolved = await service.resolveForRead('figure/local.model3.json');
      expect(resolved).toBe('F:/other/figure/local.model3.json');

      const statCountAfterSwitch = (fileAccess.exists as any).mock.calls.length;
      await service.resolveForRead('figure/local.model3.json');
      expect((fileAccess.exists as any).mock.calls.length).toBe(statCountAfterSwitch);
    });

    it('does not cache fallback resolutions so later-available files are found', async () => {
      const statCountBefore = (fileAccess.exists as any).mock.calls.length;
      await expect(service.resolveForReadWithStatus('figure/ghost.model3.json'))
        .resolves.toMatchObject({ status: 'project-asset-missing' });
      const statCountAfterFallback = (fileAccess.exists as any).mock.calls.length;
      expect(statCountAfterFallback).toBeGreaterThan(statCountBefore);

      (fileAccess.exists as any).mockImplementation(async (pathValue: string) =>
        pathValue.replace(/\\/g, '/') === 'D:/projects/demo/figure/ghost.model3.json',
      );
      const resolved = await service.resolveForRead('figure/ghost.model3.json');

      expect(resolved).toBe('D:/projects/demo/figure/ghost.model3.json');
      expect((fileAccess.exists as any).mock.calls.length).toBe(statCountAfterFallback + 1);
    });

    it('re-stats after removeProjectResource invalidates a cached positive', async () => {
      (fileAccess.exists as any).mockImplementation(async (pathValue: string) =>
        pathValue.replace(/\\/g, '/') === 'D:/projects/demo/figure/local.model3.json',
      );
      await service.resolveForRead('figure/local.model3.json');
      const statCount = (fileAccess.exists as any).mock.calls.length;

      await service.removeProjectResource('figure/local.model3.json');
      const resolved = await service.resolveForRead('figure/local.model3.json');

      expect(resolved).toBe('D:/projects/demo/figure/local.model3.json');
      expect((fileAccess.exists as any).mock.calls.length).toBe(statCount + 1);
    });

    it('keyed invalidation drops only the targeted resolution', async () => {
      (fileAccess.exists as any).mockImplementation(async (pathValue: string) =>
        pathValue.replace(/\\/g, '/') === 'D:/projects/demo/figure/local.model3.json'
        || pathValue.replace(/\\/g, '/') === 'D:/projects/demo/figure/sibling.model3.json',
      );
      await service.resolveForRead('figure/local.model3.json');
      await service.resolveForRead('figure/sibling.model3.json');
      const statCount = (fileAccess.exists as any).mock.calls.length;

      service.invalidateReadResolution('figure/local.model3.json');
      const reread = await service.resolveForRead('figure/local.model3.json');

      expect(reread).toBe('D:/projects/demo/figure/local.model3.json');
      expect((fileAccess.exists as any).mock.calls.length).toBe(statCount + 1);

      // The sibling's cached positive stays warm: no additional stat.
      await service.resolveForRead('figure/sibling.model3.json');
      expect((fileAccess.exists as any).mock.calls.length).toBe(statCount + 1);
    });

    it('clears the whole resolution cache when invalidated without a path', async () => {
      (fileAccess.exists as any).mockImplementation(async (pathValue: string) =>
        pathValue.replace(/\\/g, '/') === 'D:/projects/demo/figure/local.model3.json',
      );
      await service.resolveForRead('figure/local.model3.json');
      const statCount = (fileAccess.exists as any).mock.calls.length;

      service.invalidateReadResolution();
      await service.resolveForRead('figure/local.model3.json');

      expect((fileAccess.exists as any).mock.calls.length).toBe(statCount + 1);
    });
  });
  it('propagates a filesystem failure instead of blaming the reference', async () => {
    fileAccess.exists.mockImplementation(async () => {
      throw new Error('EACCES: permission denied');
    });

    await expect(service.resolveStatus('@mount/shared-library/figure/casual-2023/model.json'))
      .rejects.toThrow('EACCES');
  });

  it('reports a missing project as NoActiveProjectError, not a broken reference', async () => {
    const orphan = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
    );

    await expect(orphan.resolveStatus('@mount/shared-library/figure/casual-2023/model.json'))
      .rejects.toBeInstanceOf(NoActiveProjectError);
  });

  it('names a broken embedded copy instead of calling it unconfigured', async () => {
    const embeddedRoot = 'D:/projects/demo/.aeonstagery/embedded/shared-library';
    fileAccess.exists.mockImplementation(async (pathValue: string) =>
      pathValue.replace(/\\/g, '/') === embeddedRoot);
    const embeddedService = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
    );
    embeddedService.setCurrentProject({
      ...project,
      metadata: {
        ...(project.metadata as any),
        embeddedLibraryMounts: [{ id: 'shared-library', path: '.aeonstagery/embedded/shared-library' }],
      },
    });

    await expect(embeddedService.resolveStatus('@mount/shared-library/figure/absent.json'))
      .resolves.toMatchObject({
        status: 'asset-missing',
        mountId: 'shared-library',
        boundVia: 'embedded-mount',
        root: embeddedRoot,
        path: `${embeddedRoot}/figure/absent.json`,
      });
  });

  it('reports a missing embedded mount root as mount-root-missing', async () => {
    fileAccess.exists.mockImplementation(async () => false);
    const embeddedService = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
    );
    embeddedService.setCurrentProject({
      ...project,
      metadata: {
        ...(project.metadata as any),
        embeddedLibraryMounts: [{ id: 'shared-library', path: '.aeonstagery/embedded/shared-library' }],
      },
    });

    await expect(embeddedService.resolveStatus('@mount/shared-library/figure/absent.json'))
      .resolves.toMatchObject({
        status: 'mount-root-missing',
        mountId: 'shared-library',
        boundVia: 'embedded-mount',
      });
  });

  it('shares one cache entry between equivalent reference spellings', async () => {
    fileAccess.exists.mockImplementation(async (pathValue: string) =>
      pathValue.replace(/\\/g, '/') === 'E:/Library/figure/casual-2023/model.json');
    await service.resolveForReadWithStatus('@mount/shared-library/figure/casual-2023/model.json');
    fileAccess.exists.mockClear();

    await service.resolveForReadWithStatus(' @mount/shared-library/figure/casual-2023/model.json ');

    expect(fileAccess.exists).not.toHaveBeenCalled();
  });

});
