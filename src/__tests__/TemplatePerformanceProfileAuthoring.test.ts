import { describe, expect, it, vi } from 'vitest';
import type { LoadedTemplatePackage } from '../services/template-package';
import { TemplatePackageCatalog } from '../services/template-package/TemplatePackageCatalog';
import { TemplatePackageLoader } from '../services/template-package/TemplatePackageLoader';
import { TemplatePerformanceProfileAuthoringService } from '../services/template-package/TemplatePerformanceProfileAuthoring';

const USER_DATA = '/user-data';
const SOURCE_ROOT = '/app/templates/acting';
const SOURCE_MANIFEST = `${SOURCE_ROOT}/manifest.v2.json`;
const SOURCE_PROFILE = `${SOURCE_ROOT}/profiles/acting.json`;

const fileProfile = {
  schemaVersion: 1,
  id: 'acting.profile',
  name: 'Acting Profile',
  metadata: { keep: true },
  characters: [{
    id: 'hero',
    aliases: ['Hero', 'The Hero'],
    motions: [{ key: 'hero/smile', description: 'old motion' }],
    expressions: [{ key: 'hero/blush', description: 'old expression' }],
  }],
};

function manifest(profile: Record<string, unknown>, templateId = 'acting.template') {
  return {
    manifestSchemaVersion: 2,
    template: {
      id: templateId,
      name: 'Acting Template',
      version: '1.0.0',
      compatibility: { sceneSchemaVersion: 5 },
    },
    untouched: { preserve: true },
    performanceProfiles: [profile],
  };
}

function createMemoryFileAccess(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const directories = new Set<string>(['/', USER_DATA, `${USER_DATA}/templates`]);
  const join = (...parts: string[]) => parts.join('/').replace(/\/+/g, '/');
  const fileAccess = {
    readAsset: async (path: string) => {
      const data = files.get(path);
      if (data === undefined) throw new Error(`missing file: ${path}`);
      return { path, data };
    },
    readFile: async (path: string) => {
      const data = files.get(path);
      if (data === undefined) throw new Error(`missing file: ${path}`);
      return { path, data };
    },
    join: async (...parts: string[]) => join(...parts),
    dirname: async (path: string) => path.slice(0, path.lastIndexOf('/')) || '/',
    basename: async (path: string) => path.slice(path.lastIndexOf('/') + 1),
    extname: async (path: string) => {
      const name = path.slice(path.lastIndexOf('/') + 1);
      const dot = name.lastIndexOf('.');
      return dot > 0 ? name.slice(dot) : '';
    },
    showOpenDialog: async () => null,
    showSaveDialog: async () => null,
    writeFile: async (path: string, data: string) => { files.set(path, data); },
    replaceFile: vi.fn(async (temporaryPath: string, destinationPath: string) => {
      const data = files.get(temporaryPath);
      if (data === undefined) throw new Error(`missing temporary file: ${temporaryPath}`);
      files.set(destinationPath, data);
      files.delete(temporaryPath);
    }),
    removeFile: vi.fn(async (path: string) => { files.delete(path); }),
    ensureDir: async (path: string) => { directories.add(path); },
    copyFile: async () => undefined,
    readDir: async (path: string) => {
      const prefix = `${path.replace(/\/$/, '')}/`;
      const names = new Map<string, { name: string; isDirectory: boolean; path: string }>();
      for (const directory of directories) {
        if (!directory.startsWith(prefix)) continue;
        const remainder = directory.slice(prefix.length);
        if (!remainder || remainder.includes('/')) continue;
        names.set(remainder, { name: remainder, isDirectory: true, path: directory });
      }
      return [...names.values()];
    },
    realpath: async (path: string) => path,
    exists: async (path: string) => files.has(path) || directories.has(path),
    stat: async (path: string) => files.has(path)
      ? { isFile: true, isDirectory: false, isSymbolicLink: false, sizeBytes: files.get(path)!.length, mtimeMs: 0 }
      : directories.has(path)
        ? { isFile: false, isDirectory: true, isSymbolicLink: false, sizeBytes: 0, mtimeMs: 0 }
        : null,
  };
  return { files, directories, fileAccess };
}

async function loadPackage(
  fileAccess: ReturnType<typeof createMemoryFileAccess>['fileAccess'],
  scope: LoadedTemplatePackage['source']['scope'],
  root: string,
) {
  return new TemplatePackageLoader(fileAccess).loadFromPackageRoot(scope, root);
}

describe('TemplatePerformanceProfileAuthoringService', () => {
  it('saves a full edit of a bundled template into the unified authored library', async () => {
    const { files, directories, fileAccess } = createMemoryFileAccess({
      [SOURCE_MANIFEST]: JSON.stringify(manifest({
        id: 'acting.profile',
        name: 'Acting Profile',
        schemaVersion: 1,
        file: 'profiles/acting.json',
      })),
      [SOURCE_PROFILE]: JSON.stringify(fileProfile),
    });
    directories.add(SOURCE_ROOT);
    directories.add(`${SOURCE_ROOT}/profiles`);
    const bundled = await loadPackage(fileAccess, 'builtin', SOURCE_ROOT);
    const catalog = new TemplatePackageCatalog([bundled]);
    const authoredRoot = `${USER_DATA}/templates/acting.template`;
    const authoredManifest = `${authoredRoot}/manifest.v2.json`;
    const refresh = vi.fn(async () => {
      const authored = await loadPackage(fileAccess, 'user', authoredRoot);
      catalog.setPackages([bundled, authored]);
    });
    catalog.setRefreshHandler(refresh);
    const service = new TemplatePerformanceProfileAuthoringService(fileAccess, catalog, {
      getAuthoringRoot: async () => USER_DATA,
    });
    const target = service.listTargets()[0]!;

    await service.saveTemplate({
      originalTemplateId: target.templateId,
      originalProfileId: target.profileId,
      expectedProfileFingerprint: JSON.stringify(target.profile),
      draft: {
        ...service.createDraft(target),
        templateName: 'My Acting Template',
        profileName: 'My Acting Profile',
        characters: [{
          id: 'hero',
          aliases: ['主角', '勇者', 'Hero'],
          motions: [{ key: 'hero/smile', description: '温和地微笑' }],
          expressions: [{ key: 'hero/blush', description: '脸颊泛红' }],
        }, {
          id: 'friend',
          aliases: ['朋友', 'Friend'],
          motions: [{ key: 'friend/wave' }],
        }],
      },
    });

    const saved = JSON.parse(files.get(authoredManifest)!);
    expect(saved.template).toEqual(expect.objectContaining({
      id: 'acting.template',
      name: 'My Acting Template',
      version: '1.0.0',
    }));
    expect(saved.performanceProfiles[0]).toEqual(expect.objectContaining({
      id: 'acting.profile',
      name: 'My Acting Profile',
      characters: expect.arrayContaining([
        expect.objectContaining({ id: 'hero', aliases: ['主角', '勇者', 'Hero'] }),
        expect.objectContaining({ id: 'friend', aliases: ['朋友', 'Friend'] }),
      ]),
    }));
    expect(JSON.parse(files.get(SOURCE_PROFILE)!).metadata).toEqual({ keep: true });
    expect(refresh).toHaveBeenCalledOnce();
    expect(service.listTargets()).toHaveLength(1);
    expect(service.listTargets()[0]?.templateName).toBe('My Acting Template');
    expect(service.listTargets()[0]?.profile.characters).toHaveLength(2);
  });

  it('creates a new complete template and rejects a duplicate template id', async () => {
    const { files, directories, fileAccess } = createMemoryFileAccess();
    const catalog = new TemplatePackageCatalog();
    const root = `${USER_DATA}/templates/performance.custom.test`;
    const refresh = vi.fn(async () => {
      catalog.setPackages([await loadPackage(fileAccess, 'user', root)]);
    });
    catalog.setRefreshHandler(refresh);
    const service = new TemplatePerformanceProfileAuthoringService(fileAccess, catalog, {
      getAuthoringRoot: async () => USER_DATA,
    });
    directories.add(`${USER_DATA}/templates`);

    await service.saveTemplate({
      draft: {
        templateId: 'performance.custom.test',
        templateName: '自定义表演',
        profileId: 'performance.custom.test.profile',
        profileName: '自定义表演',
        characters: [{
          id: 'lead',
          aliases: ['主角', 'Lead'],
          motions: [{ key: 'lead/idle', description: '自然站立' }],
        }],
      },
    });

    expect(files.has(`${root}/manifest.v2.json`)).toBe(true);
    expect(service.listTargets()[0]?.profile.characters[0]).toEqual(expect.objectContaining({
      id: 'lead',
      aliases: ['主角', 'Lead'],
    }));
    await expect(service.saveTemplate({
      draft: {
        templateId: 'performance.custom.test',
        templateName: '重复模板',
        profileId: 'duplicate.profile',
        profileName: '重复',
        characters: [],
      },
    })).rejects.toThrow(/已存在/);
  });

  it('rejects a new template id that collides with an existing template alias', async () => {
    const { files, fileAccess } = createMemoryFileAccess();
    const existing: LoadedTemplatePackage = {
      manifest: {
        manifestSchemaVersion: 2,
        template: { id: 'acting', aliases: ['legacy.acting'], name: 'Acting', version: '1.0.0' },
      },
      source: { scope: 'builtin', packageRoot: '/builtin/acting' },
    };
    const service = new TemplatePerformanceProfileAuthoringService(
      fileAccess,
      new TemplatePackageCatalog([existing]),
      { getAuthoringRoot: async () => USER_DATA },
    );

    await expect(service.saveTemplate({
      draft: {
        templateId: 'legacy.acting',
        templateName: 'Legacy Acting',
        profileId: 'legacy.acting.profile',
        profileName: 'Legacy Acting',
        characters: [],
      },
    })).rejects.toThrow(/已存在/);
    expect([...files.keys()]).toEqual([]);
  });

  it('writes an effective project template back to its project package and preserves extension fields', async () => {
    const projectRoot = '/project/template/acting';
    const projectManifest = `${projectRoot}/manifest.v2.json`;
    const { files, directories, fileAccess } = createMemoryFileAccess({
      [projectManifest]: JSON.stringify({
        ...manifest({
          id: 'acting.profile',
          name: 'Acting Profile',
          schemaVersion: 1,
          characters: fileProfile.characters,
        }),
        extensionData: { keep: 'project-specific' },
      }),
    });
    directories.add('/project');
    directories.add('/project/template');
    directories.add(projectRoot);
    const projectPackage = await loadPackage(fileAccess, 'project', projectRoot);
    const catalog = new TemplatePackageCatalog([projectPackage]);
    const refresh = vi.fn(async () => {
      catalog.setPackages([await loadPackage(fileAccess, 'project', projectRoot)]);
    });
    catalog.setRefreshHandler(refresh);
    const service = new TemplatePerformanceProfileAuthoringService(fileAccess, catalog, {
      getAuthoringRoot: async () => USER_DATA,
    });
    const target = service.listTargets()[0]!;

    await service.saveTemplate({
      originalTemplateId: target.templateId,
      originalProfileId: target.profileId,
      expectedProfileFingerprint: JSON.stringify(target.profile),
      draft: {
        ...service.createDraft(target),
        templateName: 'Project Acting',
        characters: [{
          id: 'hero',
          aliases: ['项目主角', 'Project Hero'],
          motions: [{ key: 'hero/smile', description: '项目专用微笑' }],
        }],
      },
    });

    const saved = JSON.parse(files.get(projectManifest)!);
    expect(saved.extensionData).toEqual({ keep: 'project-specific' });
    expect(saved.template.name).toBe('Project Acting');
    expect(saved.performanceProfiles[0].characters[0]).toEqual(expect.objectContaining({
      aliases: ['项目主角', 'Project Hero'],
    }));
    expect(files.has(`${USER_DATA}/templates/acting.template/manifest.v2.json`)).toBe(false);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('rejects invalid character data before writing and remains unavailable outside desktop authoring', async () => {
    const { files, fileAccess } = createMemoryFileAccess();
    const catalog = new TemplatePackageCatalog();
    const service = new TemplatePerformanceProfileAuthoringService(fileAccess, catalog, {
      getAuthoringRoot: async () => USER_DATA,
    });

    await expect(service.saveTemplate({
      draft: {
        templateId: 'performance.invalid',
        templateName: 'Invalid',
        profileId: 'performance.invalid.profile',
        profileName: 'Invalid',
        characters: [{ id: '', aliases: ['角色'] }],
      },
    })).rejects.toThrow(/invalid/i);
    expect([...files.keys()].some((path) => path.includes('performance.invalid'))).toBe(false);

    const browserService = new TemplatePerformanceProfileAuthoringService({
      ...fileAccess,
      replaceFile: undefined,
    }, catalog);
    await expect(browserService.saveTemplate({
      draft: {
        templateId: 'performance.browser',
        templateName: 'Browser',
        profileId: 'performance.browser.profile',
        profileName: 'Browser',
        characters: [],
      },
    })).rejects.toThrow(/桌面应用/);
  });
});
