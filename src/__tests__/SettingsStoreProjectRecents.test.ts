// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('recent project renaming', () => {
  it('persists a new name while preserving recent order, paths, and open times', async () => {
    const { settingsManager, renameRecentProject } = await import('../ui/SettingsStore');
    const recents = ['first', 'second'].map((id) => ({
      name: id,
      rootPath: `/projects/${id}`,
      projectFilePath: `/projects/${id}/project.json`,
      lastOpenedAt: '2026-10-15T00:00:00.000Z',
    }));
    settingsManager.set('recentProjects', recents);

    renameRecentProject(recents[1].projectFilePath, '新名称');

    const expected = [recents[0], { ...recents[1], name: '新名称' }];
    expect(settingsManager.get('recentProjects')).toEqual(expected);
    vi.resetModules();
    const reloaded = await import('../ui/SettingsStore');
    expect(reloaded.settingsManager.get('recentProjects')).toEqual(expected);
  });
});
