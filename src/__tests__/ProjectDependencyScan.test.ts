import { describe, expect, it, vi } from 'vitest';
import { ProjectResourceService } from '../services/io/ProjectResourceService';
import { ProjectPathResolver } from '../services/io/ProjectPathResolver';
import { createProjectDependencyServices } from '../services/project-dependencies/ProjectDependencyComposition';
import type { ProjectDependencyIssueSink } from '../services/project-dependencies/ProjectDependencyScanService';
import { sceneDocumentCodec } from '../services/semantic-scene';
import type { IFileAccess } from '../services/io/IFileAccess';
import type { CurrentSceneDocument } from '../api/types/semantic-scene';
import type { ProjectExternalLibraryBindings, ProjectState } from '../api/types/project';

const ROOT = 'D:/projects/demo';

function makeDocument(statements: unknown[]): CurrentSceneDocument {
  return sceneDocumentCodec.parseAndValidate({
    schemaVersion: 4,
    sceneId: 'dependency-scan',
    meta: { title: 'Dependency scan', characters: [] },
    statements,
  });
}

function voiceStatement(id: string, voice: string) {
  return {
    id,
    time: 0,
    type: 'dialogue',
    params: { speakerId: 'hero', text: 'Line', durationSeconds: 1, voice },
  };
}

const project: ProjectState = {
  rootPath: ROOT,
  projectFilePath: `${ROOT}/project.json`,
  metadata: {
    projectId: 'demo',
    name: 'Demo',
    projectVersion: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    defaultSceneId: 'main',
    scenes: [
      { id: 'main', name: 'Main', path: 'project/main.scene.json' },
      { id: 'extra', name: 'Extra', path: 'project/extra.scene.json' },
    ],
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
} as unknown as ProjectState;

interface Harness {
  files: Set<string>;
  fileAccess: Pick<IFileAccess, 'join' | 'exists' | 'readFile'>;
  bindings: { value: ProjectExternalLibraryBindings };
  issues: { value: Parameters<ProjectDependencyIssueSink['setProjectDependencyIssues']>[0] };
  reproject: ReturnType<typeof vi.fn>;
  setBindings: ReturnType<typeof vi.fn>;
  scanner: ReturnType<typeof createProjectDependencyServices>['scanner'];
  scanService: ReturnType<typeof createProjectDependencyServices>['scanService'];
  bindingService: ReturnType<typeof createProjectDependencyServices>['bindingService'];
  unsaved: { value: { path: string; document: CurrentSceneDocument } | null };
  resources: ProjectResourceService;
}

function createHarness(options: { scenes?: Record<string, CurrentSceneDocument> } = {}): Harness {
  const files = new Set<string>();
  const sceneDocuments: Record<string, CurrentSceneDocument> = options.scenes ?? {
    [`${ROOT}/project/main.scene.json`]: makeDocument([
      voiceStatement('a1', '@mount/library/vocal/a.ogg'),
      voiceStatement('a2', '@mount/library/vocal/b.ogg'),
    ]),
    [`${ROOT}/project/extra.scene.json`]: makeDocument([
      voiceStatement('b1', '@mount/library/vocal/a.ogg'),
    ]),
  };

  const fileAccess = {
    readFile: vi.fn(async (path: string) => ({ data: '{}', path })),
    exists: vi.fn(async (path: string) => files.has(path.replace(/\\/g, '/'))),
    join: vi.fn(async (...parts: string[]) =>
      parts.join('/').replace(/\\/g, '/').replace(/\/+/g, '/')),
  } as unknown as Pick<IFileAccess, 'join' | 'exists' | 'readFile'>;

  const bindings = { value: {} as ProjectExternalLibraryBindings };
  const issues = { value: [] as Parameters<ProjectDependencyIssueSink['setProjectDependencyIssues']>[0] };
  const unsaved = { value: null as { path: string; document: CurrentSceneDocument } | null };
  const reproject = vi.fn(async () => undefined);
  const setBindings = vi.fn((next: ProjectExternalLibraryBindings) => {
    bindings.value = next;
  });

  const resources = new ProjectResourceService(
    fileAccess as unknown as IFileAccess,
    new ProjectPathResolver(null),
    () => [],
    () => project,
    () => bindings.value,
  );
  resources.setCurrentProject(project);

  const composed = createProjectDependencyServices({
    projectResources: resources,
    fileAccess,
    issueSink: {
      setProjectDependencyIssues: (next) => {
        issues.value = next;
      },
    },
    getBindings: () => bindings.value,
    setBindings,
    getUnsavedDocument: () => unsaved.value,
    readSceneDocumentFromPath: async (absolutePath) => sceneDocuments[absolutePath] ?? null,
    clearResolutionCaches: () => resources.invalidateReadResolution(),
    reprojectCurrentScene: reproject,
  });

  return {
    files,
    fileAccess,
    bindings,
    issues,
    reproject,
    setBindings,
    unsaved,
    resources,
    ...composed,
  };
}

describe('project dependency scanning', () => {
  it('aggregates every reference of a mount across all registered scenes', async () => {
    const harness = createHarness();

    const report = await harness.scanner.scan();

    expect(report?.scenesScanned).toBe(2);
    expect(report?.degraded).toBe(true);
    expect(report?.allMounts).toHaveLength(1);
    expect(report?.allMounts[0]).toMatchObject({
      mountId: 'library',
      status: 'mount-unbound',
      referenceCount: 2,
      sceneIds: ['extra', 'main'],
    });
    // Distinct references are deduped; `vocal/a.ogg` is shared by both scenes.
    expect(report?.allMounts[0].references.sort()).toEqual(['vocal/a.ogg', 'vocal/b.ogg']);
    expect(report?.issues).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'resource.mount.unbound',
        mount: expect.objectContaining({ mountId: 'library', referenceCount: 2, sceneCount: 2 }),
      }),
    ]);
  });

  it('publishes the dependency slice and returns a degraded open snapshot', async () => {
    const harness = createHarness();

    const snapshot = await harness.scanService.scanProjectDependencies();

    expect(snapshot).toEqual({
      scenesScanned: 2,
      degraded: true,
      degradedMounts: [{
        mountId: 'library',
        status: 'mount-unbound',
        referenceCount: 2,
        sceneCount: 2,
        sampleReferences: ['vocal/a.ogg', 'vocal/b.ogg'],
      }],
    });
    expect(harness.issues.value).toHaveLength(1);
    expect(harness.issues.value[0].code).toBe('resource.mount.unbound');
  });

  it('prefers the unsaved document over the on-disk scene for the same path', async () => {
    const harness = createHarness({
      scenes: {
        [`${ROOT}/project/main.scene.json`]: makeDocument([
          voiceStatement('disk', '@mount/library/vocal/on-disk.ogg'),
        ]),
        [`${ROOT}/project/extra.scene.json`]: makeDocument([
          voiceStatement('b1', '@mount/library/vocal/a.ogg'),
        ]),
      },
    });
    harness.unsaved.value = {
      path: 'project/main.scene.json',
      document: makeDocument([voiceStatement('live', '@mount/live-library/vocal/unsaved.ogg')]),
    };

    const report = await harness.scanner.scan();

    expect(report?.allMounts.map((mount) => mount.mountId).sort()).toEqual(['library', 'live-library']);
    expect(report?.allMounts.find((mount) => mount.mountId === 'library')?.references)
      .toEqual(['vocal/a.ogg']);
  });

  it('binds a mount only when the chosen directory really holds an expected file', async () => {
    const harness = createHarness();
    await harness.scanService.scan();

    const rejected = await harness.bindingService.bindMountDirectory('library', 'G:/Empty');
    expect(rejected).toMatchObject({ ok: false, reason: 'none-matched' });
    expect(harness.setBindings).not.toHaveBeenCalled();

    harness.files.add('F:/Lib');
    harness.files.add('F:/Lib/vocal/a.ogg');
    const accepted = await harness.bindingService.bindMountDirectory('library', 'F:/Lib');
    expect(accepted.ok).toBe(true);
    expect(harness.setBindings).toHaveBeenCalledWith({ demo: { library: 'F:/Lib' } });
    expect(harness.reproject).toHaveBeenCalledTimes(1);

    // Only `vocal/a.ogg` was copied into the bound directory: the mount is now
    // bound but one file is still missing, which stays a resource error.
    expect(accepted.report?.allMounts[0]).toMatchObject({
      mountId: 'library',
      status: 'asset-missing',
      bindingPath: 'F:/Lib',
    });
    expect(accepted.report?.issues).toEqual([
      expect.objectContaining({ severity: 'error', code: 'resource.missing' }),
    ]);
    expect(await harness.resources.resolveStatus('@mount/library/vocal/a.ogg'))
      .toMatchObject({ status: 'ready', path: 'F:/Lib/vocal/a.ogg', source: 'project-binding' });
  });

  it('removes a binding and falls back to the remaining tiers', async () => {
    const harness = createHarness();
    harness.files.add('F:/Lib');
    harness.files.add('F:/Lib/vocal/a.ogg');
    harness.files.add('F:/Lib/vocal/b.ogg');
    await harness.bindingService.bindMountDirectory('library', 'F:/Lib');
    expect(harness.bindingService.getBinding('library')).toBe('F:/Lib');

    const removed = await harness.bindingService.unbindMount('library');

    expect(removed.ok).toBe(true);
    expect(harness.bindings.value).toEqual({});
    expect(harness.bindingService.getBinding('library')).toBeUndefined();
    expect(removed.report?.allMounts[0].status).toBe('mount-unbound');
  });

  it('reports a stale bound directory as mount-root-missing instead of unbound', async () => {
    const harness = createHarness();
    harness.bindings.value = { demo: { library: 'F:/Moved Away' } };

    const report = await harness.scanner.scan();

    expect(report?.allMounts[0]).toMatchObject({
      mountId: 'library',
      status: 'mount-root-missing',
      bindingPath: 'F:/Moved Away',
      staleRoot: 'F:/Moved Away',
    });
    expect(report?.issues[0].code).toBe('resource.mount.root-missing');
  });

  it('normalizes the mount id and directory before persisting a binding', async () => {
    const harness = createHarness();
    await harness.scanService.scan();
    harness.files.add('F:/Lib');
    harness.files.add('F:/Lib/vocal/a.ogg');

    const result = await harness.bindingService.bindMountDirectory('  LIBRARY  ', '  F:/Lib/  ');

    expect(result.ok).toBe(true);
    // Local settings only ever hold ids resolution can read back; a padded or
    // mixed-case id would be pruned on the next load and silently lost.
    expect(harness.setBindings).toHaveBeenCalledWith({ demo: { library: 'F:/Lib' } });
    expect(harness.bindingService.getBinding('LiBrArY')).toBe('F:/Lib');
  });

  it('rejects a mount id that is not part of the project', async () => {
    const harness = createHarness();
    await harness.scanService.scan();

    expect(await harness.bindingService.bindMountDirectory('nope', 'F:/Lib'))
      .toMatchObject({ ok: false, reason: 'unknown-mount' });
    expect(await harness.bindingService.bindMountDirectory('Bad Id!', 'F:/Lib'))
      .toMatchObject({ ok: false, reason: 'unknown-mount' });
    expect(await harness.bindingService.unbindMount('Bad Id!'))
      .toMatchObject({ ok: false, reason: 'unknown-mount' });
    expect(harness.setBindings).not.toHaveBeenCalled();
  });

  it('reports an unreadable probe instead of blaming the reference', async () => {
    const harness = createHarness();
    harness.bindings.value = { demo: { library: 'F:/Lib' } };
    (harness.fileAccess.exists as any).mockImplementation(async () => {
      throw new Error('EACCES: permission denied');
    });

    const report = await harness.scanner.scan();

    expect(report?.degraded).toBe(true);
    expect(report?.issues).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'resource.unreadable',
        message: expect.stringContaining('EACCES'),
      }),
    ]);
  });

  it('probes a missing library once instead of once per reference', async () => {
    const harness = createHarness();
    const probe = vi.spyOn(harness.resources, 'resolveStatus');

    await harness.scanner.scan();

    // Two references share the mount; the second answer is already known.
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
