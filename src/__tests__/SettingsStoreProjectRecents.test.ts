// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecentProjectEntry } from '../ui/SettingsStore';

function makeRecentProjects(count: number): RecentProjectEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `Project ${index + 1}`,
    rootPath: `/projects/${index + 1}`,
    projectFilePath: `/projects/${index + 1}/project.json`,
    lastOpenedAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
  }));
}

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('recent project history', () => {
  it('retains the latest 50 projects across reopens and settings reloads', async () => {
    const { settingsManager, upsertRecentProject } = await import('../ui/SettingsStore');
    const projects = makeRecentProjects(55);
    projects.forEach(upsertRecentProject);
    const newest = projects.slice(-50).reverse();
    expect(settingsManager.get('recentProjects')).toEqual(newest);

    const reopened = { ...projects[10], name: 'Reopened', lastOpenedAt: '2026-10-29T00:00:00.000Z' };
    upsertRecentProject(reopened);
    const expected = [reopened, ...newest.filter((entry) => entry.projectFilePath !== reopened.projectFilePath)];
    expect(settingsManager.get('recentProjects')).toEqual(expected);
    vi.resetModules();
    const reloaded = await import('../ui/SettingsStore');
    expect(reloaded.settingsManager.get('recentProjects')).toEqual(expected);
  });

  it.each([6, 55])('loads %i saved entries while enforcing the 50-entry history limit', async (count) => {
    const projects = makeRecentProjects(count);
    localStorage.setItem('aeonstagery_settings', JSON.stringify({ recentProjects: projects }));
    const { settingsManager } = await import('../ui/SettingsStore');
    expect(settingsManager.get('recentProjects')).toEqual(projects.slice(0, 50));
  });

  it('caps direct settings updates at 50 projects', async () => {
    const { settingsManager } = await import('../ui/SettingsStore');
    const projects = makeRecentProjects(55);
    settingsManager.set('recentProjects', projects);
    expect(settingsManager.get('recentProjects')).toEqual(projects.slice(0, 50));
  });

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
