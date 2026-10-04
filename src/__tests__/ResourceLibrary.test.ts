/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readMergedDirectory, readRootDirectories } from '../ui/ResourceLibrary';

vi.mock('../ui/SettingsStore', () => ({ settingsManager: { get: () => [{ path: '/external' }] } }));

describe('merged resource file directories', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('merges same-name directories and preserves same-name files from projects, libraries and templates', async () => {
    const templateResource = { templateId: 'demo', packageRelativePath: 'assets/background/room.png' };
    vi.stubGlobal('AeonStagery', { services: {
      projectWorkspace: { getCurrentProject: () => ({ rootPath: '/project' }) },
      templateResourceFiles: { readDirectory: vi.fn().mockResolvedValue([
        { name: 'nested', isDirectory: true, path: '/templates/demo/assets/background/nested', source: '模板：Demo' },
        { name: 'room.png', isDirectory: false, path: '/templates/demo/assets/background/room.png', source: '模板：Demo', templateResource },
      ]) },
    } });
    vi.stubGlobal('aeonStageryAPI', { fs: { readDir: vi.fn(async (path: string) => ({ success: true, data: [
      { name: 'nested', isDirectory: true, path: `${path}/nested` },
      { name: 'room.png', isDirectory: false, path: `${path}/room.png` },
    ] })) } });
    const entries = await readMergedDirectory('background');
    expect(entries.map((entry) => entry.isDirectory)).toEqual([true, false, false, false]);
    expect(entries.filter((entry) => entry.isDirectory)).toEqual([
      expect.objectContaining({ name: 'nested', path: 'background/nested', source: '多个来源' }),
    ]);
    expect(new Set(entries.filter((entry) => !entry.isDirectory).map((entry) => entry.path)).size).toBe(3);
    expect(entries.find((entry) => entry.templateResource)).toMatchObject({ templateResource, source: '模板：Demo' });
  });

  it('can list template files without renderer directory APIs', async () => {
    const readDirectory = vi.fn().mockResolvedValue([{ name: 'model.json', isDirectory: false, path: '/templates/demo/model.json', source: '模板：Demo' }]);
    vi.stubGlobal('AeonStagery', { services: { templateResourceFiles: { readDirectory } } });
    vi.stubGlobal('aeonStageryAPI', undefined);
    expect(await readMergedDirectory('figure')).toHaveLength(1);
    expect(readDirectory).toHaveBeenCalledWith('figure');
  });

  it('keeps existing empty directories and includes virtual template categories at the root', async () => {
    vi.stubGlobal('AeonStagery', { services: {
      projectWorkspace: { getCurrentProject: () => ({ rootPath: '/project' }) },
      templateResourceFiles: { readDirectory: vi.fn(async (directory: string) => directory === 'figure'
        ? [{ name: 'characters', isDirectory: true, path: '/templates/demo/assets/characters', source: '模板：Demo' }] : []) },
    } });
    vi.stubGlobal('aeonStageryAPI', { fs: { exists: vi.fn(async (path: string) => path === '/project/background') } });
    expect(await readRootDirectories()).toEqual([
      { name: 'background', isDirectory: true, path: '/project/background' },
      { name: 'figure', isDirectory: true, path: 'figure' },
    ]);
  });
});
