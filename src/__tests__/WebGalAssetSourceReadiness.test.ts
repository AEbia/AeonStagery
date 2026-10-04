import { describe, expect, it } from 'vitest';
import {
  checkFirstLessonLive2DModelReadiness,
  checkWebGalAssetSourceReadiness,
  isFirstLessonLive2DEntryName,
  type WebGalAssetSourceDirEntry,
  type WebGalAssetSourceFileAccess,
} from '../services/onboarding/WebGalAssetSourceReadiness';

function createMemoryFileAccess(files: Record<string, string>): WebGalAssetSourceFileAccess {
  const normalizedFiles = new Map(
    Object.entries(files).map(([path, value]) => [normalize(path), value]),
  );

  const directoryEntries = new Map<string, WebGalAssetSourceDirEntry[]>();
  for (const path of normalizedFiles.keys()) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const directory = parts.slice(0, index).join('/');
      const childName = parts[index];
      const childPath = parts.slice(0, index + 1).join('/');
      const isDirectory = index < parts.length - 1;
      const entries = directoryEntries.get(directory) ?? [];
      if (!entries.some((entry) => entry.name === childName)) {
        entries.push({ name: childName, isDirectory, path: childPath });
      }
      directoryEntries.set(directory, entries);
    }
  }

  return {
    readFile: async (path) => {
      const data = normalizedFiles.get(normalize(path));
      if (data === undefined) throw new Error(`Missing file ${path}`);
      return { data, path: normalize(path) };
    },
    readDir: async (path) => {
      const entries = directoryEntries.get(normalize(path));
      if (!entries) throw new Error(`Missing directory ${path}`);
      return entries;
    },
    exists: async (path) => normalizedFiles.has(normalize(path)) || directoryEntries.has(normalize(path)),
    join: (...parts) => normalize(parts.join('/')),
    dirname: (path) => {
      const normalized = normalize(path);
      return normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
    },
  };
}

describe('WebGalAssetSourceReadiness', () => {
  it('requires the selected root to directly contain figure', async () => {
    const result = await checkWebGalAssetSourceReadiness(
      'webgal-project',
      createMemoryFileAccess({
        'webgal-project/public/game/figure/anon/model.json': '{}',
      }),
    );

    expect(result).toEqual({
      status: 'needs_reselect',
      code: 'missing-figure-directory',
    });
  });

  it('finds the first loadable Cubism 2 model under figure', async () => {
    const fileAccess = createMemoryFileAccess({
      'assets/figure/anon/model.json': JSON.stringify({
        model: 'anon.moc',
        textures: ['textures/body.png'],
        motions: { idle: [{ file: 'idle.mtn' }] },
      }),
      'assets/figure/anon/anon.moc': 'moc',
      'assets/figure/anon/textures/body.png': 'png',
      'assets/figure/anon/idle.mtn': 'motion',
    });

    await expect(checkWebGalAssetSourceReadiness('assets', fileAccess)).resolves.toEqual({
      status: 'found',
      rootPath: 'assets',
      figurePath: 'assets/figure',
      modelEntryPath: 'assets/figure/anon/model.json',
      modelEntryRelativePath: 'anon/model.json',
      runtimeFamily: 'cubism2',
    });
  });

  it('rejects entries that only include the model JSON without body or textures', async () => {
    const result = await checkWebGalAssetSourceReadiness(
      'assets',
      createMemoryFileAccess({
        'assets/figure/anon/model.json': JSON.stringify({
          model: 'anon.moc',
          textures: ['textures/body.png'],
        }),
      }),
    );

    expect(result).toEqual({
      status: 'needs_reselect',
      code: 'model-body-missing',
    });
  });

  it('excludes wmdl from first lesson entry scanning', () => {
    expect(isFirstLessonLive2DEntryName('model.json')).toBe(true);
    expect(isFirstLessonLive2DEntryName('anon.model.json')).toBe(true);
    expect(isFirstLessonLive2DEntryName('anon.model3.json')).toBe(true);
    expect(isFirstLessonLive2DEntryName('anon.wmdl')).toBe(false);
    expect(isFirstLessonLive2DEntryName('data.json')).toBe(false);
  });

  it('accepts Cubism 3+ only when the packaged runtime is available', async () => {
    const fileAccess = createMemoryFileAccess({
      'assets/figure/anon/anon.model3.json': JSON.stringify({
        FileReferences: {
          Moc: 'anon.moc3',
          Textures: ['textures/body.png'],
        },
      }),
      'assets/figure/anon/anon.moc3': 'moc3',
      'assets/figure/anon/textures/body.png': 'png',
    });

    await expect(checkWebGalAssetSourceReadiness('assets', fileAccess)).resolves.toEqual({
      status: 'needs_reselect',
      code: 'model-runtime-unavailable',
    });
    await expect(checkWebGalAssetSourceReadiness('assets', fileAccess, {
      isRuntimeFamilyAvailable: (runtimeFamily) => runtimeFamily === 'cubism3-plus',
    })).resolves.toEqual({
      status: 'found',
      rootPath: 'assets',
      figurePath: 'assets/figure',
      modelEntryPath: 'assets/figure/anon/anon.model3.json',
      modelEntryRelativePath: 'anon/anon.model3.json',
      runtimeFamily: 'cubism3-plus',
    });
  });

  it('checks the exact model selected during the first lesson', async () => {
    const fileAccess = createMemoryFileAccess({
      'assets/figure/anon/model.json': JSON.stringify({
        model: 'anon.moc',
        textures: ['body.png'],
      }),
      'assets/figure/anon/anon.moc': 'moc',
      'assets/figure/anon/body.png': 'png',
      'assets/figure/anon/experimental.wmdl': '{}',
    });

    await expect(checkFirstLessonLive2DModelReadiness(
      'assets/figure/anon/model.json',
      fileAccess,
    )).resolves.toEqual({
      status: 'found',
      modelEntryPath: 'assets/figure/anon/model.json',
      runtimeFamily: 'cubism2',
    });
    await expect(checkFirstLessonLive2DModelReadiness(
      'assets/figure/anon/experimental.wmdl',
      fileAccess,
    )).resolves.toEqual({
      status: 'needs_reselect',
      code: 'model-format-unrecognized',
    });
  });
});

function normalize(path: string): string {
  return path.replace(/\\/g, '/').trim().replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/+/g, '/');
}
