import { describe, expect, it } from 'vitest';
import {
  ResourceAuthoringResolver,
  ResourceIndex,
  createTemplateResourceIndex,
  ResourceAuthoringIndexBuilder,
  ResourceMaterializer,
  ResourceAuthoringService,
  createProjectResourceIndex,
  parseResourceKey,
} from '../services/resource-authoring';
import { TemplatePackageCatalog } from '../services/template-package';

describe('contextual short resource names', () => {
  it('parses namespace, owner and name without assigning target semantics', () => {
    expect(parseResourceKey('mygo@soyo:idle01', 'live2dMotion')).toEqual({
      kind: 'live2dMotion',
      namespace: 'mygo',
      ownerId: 'soyo',
      name: 'idle01',
    });
  });

  it.each(['../idle', 'mygo@../idle', 'mygo@@idle', 'soyo:idle:extra', '/tmp/idle']) (
    'rejects unsafe or malformed short input %s',
    (input) => expect(() => parseResourceKey(input, 'live2dMotion')).toThrow(),
  );

  it('completes owner and outfit from semantic authoring context', () => {
    const index = new ResourceIndex();
    index.add({
      key: { kind: 'live2dModel', name: 'school_winter', ownerId: 'soyo', outfitId: 'school_winter' },
      namespace: 'mygo',
      portablePath: 'live2d/soyo/models/school_winter/model.model3.json',
      source: 'outfit',
    });
    const result = new ResourceAuthoringResolver(index).resolve('school_winter', {
      kind: 'live2dModel',
      ownerId: 'soyo',
      outfitId: 'school_winter',
      enabledNamespaces: ['mygo'],
    });
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.candidate.namespace).toBe('mygo');
      expect(result.candidate.portablePath).toBe('live2d/soyo/models/school_winter/model.model3.json');
    }
  });

  it('requires owner context for character-owned resources', () => {
    const result = new ResourceAuthoringResolver(new ResourceIndex()).resolve('idle01', { kind: 'live2dMotion' });
    expect(result).toMatchObject({ status: 'not-found', diagnostics: [{ code: 'missing-owner' }] });
  });

  it('uses explicit entries before convention candidates and diagnoses equal-rank conflicts', () => {
    const index = new ResourceIndex();
    index.add({ key: { kind: 'background', name: 'classroom' }, namespace: 'mygo', portablePath: 'background/classroom.png', source: 'convention' });
    index.add({ key: { kind: 'background', name: 'classroom' }, namespace: 'mygo', portablePath: 'special/classroom.webp', source: 'explicit' });
    let result = new ResourceAuthoringResolver(index).resolve('mygo@classroom', { kind: 'background' });
    expect(result).toMatchObject({ status: 'resolved', candidate: { portablePath: 'special/classroom.webp' } });

    index.add({ key: { kind: 'background', name: 'classroom' }, namespace: 'mygo', portablePath: 'special/classroom.png', source: 'explicit' });
    result = new ResourceAuthoringResolver(index).resolve('mygo@classroom', { kind: 'background' });
    expect(result).toMatchObject({ status: 'ambiguous', diagnostics: [{ code: 'ambiguous' }] });
  });

  it('does not let disabled namespaces participate in unqualified lookup', () => {
    const index = new ResourceIndex();
    index.add({ key: { kind: 'background', name: 'classroom' }, namespace: 'mygo', portablePath: 'classroom.png', source: 'explicit' });
    index.add({ key: { kind: 'background', name: 'classroom' }, namespace: 'other', portablePath: 'classroom.png', source: 'explicit' });
    const resolver = new ResourceAuthoringResolver(index);
    expect(resolver.resolve('classroom', { kind: 'background', enabledNamespaces: ['mygo'] })).toMatchObject({
      status: 'resolved', candidate: { namespace: 'mygo' },
    });
    expect(resolver.resolve('other@classroom', { kind: 'background', enabledNamespaces: ['mygo'] })).toMatchObject({
      status: 'resolved', candidate: { namespace: 'other' },
    });
  });

  it('prefers the project namespace before a template explicit entry', () => {
    const index = new ResourceIndex();
    index.add({ key: { kind: 'background', name: 'classroom' }, namespace: 'project', portablePath: 'background/classroom.png', source: 'convention' });
    index.add({ key: { kind: 'background', name: 'classroom' }, namespace: 'mygo', portablePath: 'background/classroom.webp', source: 'explicit' });
    const resolver = new ResourceAuthoringResolver(index);
    expect(resolver.resolve('classroom', { kind: 'background', enabledNamespaces: ['mygo'] })).toMatchObject({
      status: 'resolved', candidate: { namespace: 'project', portablePath: 'background/classroom.png' },
    });
    expect(resolver.resolve('mygo@classroom', { kind: 'background', enabledNamespaces: ['mygo'] })).toMatchObject({
      status: 'resolved', candidate: { namespace: 'mygo' },
    });
  });

  it('rejects indexed paths that escape their namespace', () => {
    const index = new ResourceIndex();
    expect(() => index.add({
      key: { kind: 'background', name: 'bad' },
      namespace: 'mygo',
      portablePath: '../outside.png',
      source: 'convention',
    })).toThrow(/inside its namespace/);
  });

  it('builds the enabled template index from explicit entries and aliases', () => {
    const index = createTemplateResourceIndex([{
      source: { scope: 'user', packageRoot: '/templates/mygo' },
      manifest: {
        manifestSchemaVersion: 2,
        template: { id: 'mygo', name: 'MyGO', version: '1.0.0' },
        assets: { index: [{
          id: 'school_winter',
          kind: 'live2dModel',
          path: 'live2d/soyo/models/school_winter/model.model3.json',
          metadata: { ownerId: 'soyo', outfitId: 'school_winter', aliases: ['winter'] },
        }] },
      },
    }], ['mygo']);
    const resolver = new ResourceAuthoringResolver(index);
    expect(resolver.resolve('mygo@soyo:winter', { kind: 'live2dModel' })).toMatchObject({
      status: 'resolved',
      candidate: { source: 'alias', portablePath: 'live2d/soyo/models/school_winter/model.model3.json' },
    });
  });

  it('builds a renamed template resource index when the project still stores its previous id', () => {
    const index = createTemplateResourceIndex([{
      source: { scope: 'user', packageRoot: '/templates/mygo' },
      manifest: {
        manifestSchemaVersion: 2,
        template: {
          id: 'aeonstagery.mygo',
          aliases: ['webgal.mygo.v3_1_0.portable'],
          name: 'Aeonstagery MyGO Template',
          version: '1.0.0',
        },
        assets: { index: [{
          id: 'room',
          kind: 'background',
          path: 'assets/backgrounds/room.png',
        }] },
      },
    }], ['webgal.mygo.v3_1_0.portable']);

    expect(new ResourceAuthoringResolver(index).resolve('aeonstagery.mygo@room', {
      kind: 'background',
    })).toMatchObject({ status: 'resolved' });
    expect(new ResourceAuthoringResolver(index).resolve('webgal.mygo.v3_1_0.portable@room', {
      kind: 'background',
    })).toMatchObject({ status: 'resolved' });
  });

  it('discovers project resources and cached template convention files deterministically', async () => {
    const tree: Record<string, Array<{ name: string; isDirectory: boolean; path: string }>> = {
      '/project/background': [{ name: 'classroom.webp', isDirectory: false, path: '/project/background/classroom.webp' }],
      '/project/images': [],
      '/project/bgm': [],
      '/project/vocal': [],
      '/project/animation': [],
      '/project/figure': [],
      '/templates/mygo/assets': [{ name: 'live2d', isDirectory: true, path: '/templates/mygo/assets/live2d' }],
      '/templates/mygo/assets/live2d': [{ name: 'soyo', isDirectory: true, path: '/templates/mygo/assets/live2d/soyo' }],
      '/templates/mygo/assets/live2d/soyo': [{ name: 'models', isDirectory: true, path: '/templates/mygo/assets/live2d/soyo/models' }],
      '/templates/mygo/assets/live2d/soyo/models': [{ name: 'winter', isDirectory: true, path: '/templates/mygo/assets/live2d/soyo/models/winter' }],
      '/templates/mygo/assets/live2d/soyo/models/winter': [{ name: 'model.model3.json', isDirectory: false, path: '/templates/mygo/assets/live2d/soyo/models/winter/model.model3.json' }],
    };
    let reads = 0;
    const fileAccess = {
      join: async (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
      readDir: async (path: string) => { reads += 1; return tree[path] ?? []; },
    };
    const project = {
      rootPath: '/project',
      projectFilePath: '/project/project.json',
      metadata: {
        projectId: 'p', name: 'P', projectVersion: 2 as const, createdAt: '', updatedAt: '', defaultSceneId: 'main', scenes: [],
        assetRoots: { figure: 'figure', background: 'background', bgm: 'bgm', vocal: 'vocal', images: 'images', animation: 'animation', project: 'project', template: 'template' },
        templates: { enabledTemplateIds: ['mygo'] },
      },
    };
    const packages = [{
      source: { scope: 'user' as const, packageRoot: '/templates/mygo' },
      manifest: {
        manifestSchemaVersion: 2 as const,
        template: { id: 'mygo', name: 'MyGO', version: '1.0.0' },
        resourceConventions: {
          live2dModel: { patterns: ['live2d/{character}/models/{outfit}/{entrypoint}'], entrypoints: ['model.model3.json'] },
        },
      },
    }];
    const builder = new ResourceAuthoringIndexBuilder(fileAccess);
    const first = await builder.build(project, packages);
    const readsAfterFirst = reads;
    const second = await builder.build(project, packages);
    expect(reads - readsAfterFirst).toBe(6); // project roots rescan; template package stays cached
    expect(new ResourceAuthoringResolver(first).resolve('classroom', { kind: 'background' })).toMatchObject({
      status: 'resolved', candidate: { namespace: 'project', portablePath: 'background/classroom.webp' },
    });
    expect(new ResourceAuthoringResolver(second).resolve('mygo@soyo:winter', { kind: 'live2dModel' })).toMatchObject({
      status: 'resolved', candidate: { portablePath: 'live2d/soyo/models/winter/model.model3.json' },
    });
  });

  it('indexes arbitrary Cubism 3 entrypoint names under nested figure catalogs', async () => {
    const tree: Record<string, Array<{ name: string; isDirectory: boolean; path: string }>> = {
      '/project/background': [],
      '/project/images': [],
      '/project/bgm': [],
      '/project/vocal': [],
      '/project/animation': [],
      '/project/figure': [{ name: 'mygo', isDirectory: true, path: '/project/figure/mygo' }],
      '/project/figure/mygo': [{ name: 'soyo', isDirectory: true, path: '/project/figure/mygo/soyo' }],
      '/project/figure/mygo/soyo': [{ name: 'live_01', isDirectory: true, path: '/project/figure/mygo/soyo/live_01' }],
      '/project/figure/mygo/soyo/live_01': [{
        name: 'adv_live2d_soyo_004_live_01.model3.json',
        isDirectory: false,
        path: '/project/figure/mygo/soyo/live_01/adv_live2d_soyo_004_live_01.model3.json',
      }],
    };
    const fileAccess = {
      join: async (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
      readDir: async (path: string) => tree[path] ?? [],
    };
    const project = {
      rootPath: '/project',
      projectFilePath: '/project/project.json',
      metadata: {
        projectId: 'p', name: 'P', projectVersion: 2 as const, createdAt: '', updatedAt: '', defaultSceneId: 'main', scenes: [],
        assetRoots: { figure: 'figure', background: 'background', bgm: 'bgm', vocal: 'vocal', images: 'images', animation: 'animation', project: 'project', template: 'template' },
      },
    };

    const index = await createProjectResourceIndex(project, fileAccess);

    expect(index.entries()).toContainEqual(expect.objectContaining({
      key: expect.objectContaining({
        kind: 'live2dModel',
        name: 'live_01',
        ownerId: 'soyo',
        outfitId: 'live_01',
      }),
      portablePath: 'figure/mygo/soyo/live_01/adv_live2d_soyo_004_live_01.model3.json',
    }));
  });

  it('materializes a template candidate through the trusted-root project boundary', async () => {
    const calls: unknown[][] = [];
    const materializer = new ResourceMaterializer(
      { join: async (...parts: string[]) => parts.join('/').replace(/\/+/g, '/') },
      {
        normalizeForStorage: async () => { throw new Error('should not normalize'); },
        importIntoProject: async () => { throw new Error('should not import'); },
        materializeFromTrustedRoot: async (...args: unknown[]) => {
          calls.push(args);
          return { mode: 'copy' as const, kind: 'background' as const, relativePath: String(args[3]) };
        },
      },
      () => [{
        source: { scope: 'user', packageRoot: '/templates/mygo' },
        manifest: {
          manifestSchemaVersion: 2,
          template: { id: 'mygo', name: 'MyGO', version: '1.0.0' },
          assets: { root: 'assets' },
        },
      }],
    );
    const result = await materializer.materialize('mygo@classroom', {
      key: { kind: 'background', name: 'classroom' },
      namespace: 'mygo',
      portablePath: 'background/classroom.webp',
      source: 'explicit',
    });
    expect(calls).toEqual([[
      '/templates/mygo',
      '/templates/mygo/assets/background/classroom.webp',
      'background',
      'background/mygo/classroom.webp',
    ]]);
    expect(result).toMatchObject({
      reference: 'background/mygo/classroom.webp',
      receipt: {
        input: 'mygo@classroom',
        namespace: 'mygo',
        operation: 'copied-template-resource',
      },
    });
  });

  it('does not copy an already-projectized candidate', async () => {
    const materializer = new ResourceMaterializer(
      { join: async (...parts: string[]) => parts.join('/') },
      {
        materializeFromTrustedRoot: async () => { throw new Error('should not copy'); },
        normalizeForStorage: async () => { throw new Error('should not normalize'); },
        importIntoProject: async () => { throw new Error('should not import'); },
      },
      () => [],
    );
    await expect(materializer.materialize('classroom', {
      key: { kind: 'background', name: 'classroom' },
      namespace: 'project',
      portablePath: 'background/classroom.webp',
      source: 'convention',
    })).resolves.toMatchObject({
      reference: 'background/classroom.webp',
      receipt: { operation: 'existing-project-reference' },
    });
  });

  it('projectizes an explicit registered-library path through the shared materializer', async () => {
    const materializer = new ResourceMaterializer(
      { join: async (...parts: string[]) => parts.join('/') },
      {
        materializeFromTrustedRoot: async () => { throw new Error('should not materialize template'); },
        normalizeForStorage: async () => { throw new Error('should import absolute path'); },
        importIntoProject: async (source: string, kind: string, mode?: string) => {
          expect([source, kind, mode]).toEqual(['/library/classroom.webp', 'background', 'copy']);
          return { mode: 'copy' as const, kind: 'background' as const, relativePath: 'background/classroom.webp' };
        },
      },
      () => [],
    );
    await expect(materializer.materialize('/library/classroom.webp', {
      key: { kind: 'background', name: '/library/classroom.webp' },
      namespace: 'path',
      portablePath: '/library/classroom.webp',
      source: 'explicit',
    })).resolves.toMatchObject({
      reference: 'background/classroom.webp',
      receipt: { operation: 'imported-explicit-path', sourcePath: '/library/classroom.webp' },
    });
  });

  it('exposes the shared resolver through an application service and invalidates on catalog changes', async () => {
    const project = {
      rootPath: '/project', projectFilePath: '/project/project.json',
      metadata: {
        projectId: 'p', name: 'P', projectVersion: 1, createdAt: '', updatedAt: '', defaultSceneId: 'main', scenes: [],
        assetRoots: { figure: 'figure', background: 'background', bgm: 'bgm', vocal: 'vocal', images: 'images', animation: 'animation', project: 'project', template: 'template' },
        templates: { enabledTemplateIds: ['mygo'] },
      },
    };
    let reads = 0;
    const fileAccess = {
      join: async (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
      readDir: async (path: string) => {
        reads += 1;
        return path === '/project/background'
          ? [{ name: 'classroom.webp', isDirectory: false, path: `${path}/classroom.webp` }]
          : [];
      },
    };
    const catalog = new TemplatePackageCatalog();
    const service = new ResourceAuthoringService(
      fileAccess as never,
      { getCurrentProject: () => project } as never,
      catalog,
    );
    await expect(service.resolve('classroom', { kind: 'background' })).resolves.toMatchObject({ status: 'resolved' });
    const readsAfterFirst = reads;
    await service.resolve('classroom', { kind: 'background' });
    expect(reads).toBe(readsAfterFirst);
    catalog.setPackages([]);
    await service.resolve('classroom', { kind: 'background' });
    expect(reads).toBeGreaterThan(readsAfterFirst);
    service.dispose();
  });

  it('uses contextual shortest display names and reveals namespaces only for conflicts', async () => {
    const project = {
      rootPath: '/project', projectFilePath: '/project/project.json',
      metadata: {
        projectId: 'p', name: 'P', projectVersion: 1, createdAt: '', updatedAt: '', defaultSceneId: 'main', scenes: [],
        assetRoots: { figure: 'figure', background: 'background', bgm: 'bgm', vocal: 'vocal', images: 'images', animation: 'animation', project: 'project', template: 'template' },
        templates: { enabledTemplateIds: ['mygo', 'other'] },
      },
    };
    const packages = ['mygo', 'other'].map((namespace) => ({
      source: { scope: 'user' as const, packageRoot: `/templates/${namespace}` },
      manifest: {
        manifestSchemaVersion: 2 as const,
        template: { id: namespace, name: namespace, version: '1.0.0' },
        assets: { index: [
          { id: 'anon:idle01', kind: 'live2dMotion', path: 'live2d/anon/motions/idle01.motion3.json', ...(namespace === 'mygo' ? { label: '静止动作' } : {}) },
          { id: 'soyo:wave', kind: 'live2dMotion', path: 'live2d/soyo/motions/wave.motion3.json' },
        ] },
      },
    }));
    const catalog = new TemplatePackageCatalog(packages);
    const service = new ResourceAuthoringService(
      { join: async (...parts: string[]) => parts.join('/'), readDir: async () => [] } as never,
      { getCurrentProject: () => project } as never,
      catalog,
    );
    const resources = await service.listCandidates({ kind: 'live2dMotion', ownerId: 'anon', includeOtherOwners: true });
    expect(resources.map((item) => item.displayName)).toEqual([
      'mygo@idle01',
      'other@idle01',
      'mygo@soyo:wave',
      'other@soyo:wave',
    ]);
    await expect(service.listCandidates({
      kind: 'live2dMotion', ownerId: 'anon', includeOtherOwners: true, text: '静止',
    })).resolves.toMatchObject([{ candidate: { namespace: 'mygo' }, displayName: 'idle01' }]);
    service.dispose();
  });
});
