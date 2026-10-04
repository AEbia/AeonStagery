import { describe, expect, it } from 'vitest';
import {
  sanitizeProjectAgentOverview,
  type ProjectAgentOverviewSource,
} from '../services/project-agent-service/ProjectAgentOverviewPort';

function overviewSource(overrides: Partial<ProjectAgentOverviewSource> = {}): ProjectAgentOverviewSource {
  return {
    name: '  My   Project  ',
    projectVersion: 3,
    activeScene: { name: 'Main', path: 'scenes/main.scene.json' },
    scenes: [
      { id: 'scene-entry-1', name: 'Main', path: 'scenes/main.scene.json' },
      { id: 'scene-entry-2', name: 'Intro', path: 'scenes/intro.scene.json' },
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
    templates: {
      enabledTemplateIds: ['aeonstagery.default'],
      defaults: { dialogueStyleId: 'glass' },
    },
    ...overrides,
  };
}

describe('sanitizeProjectAgentOverview', () => {
  it('cleans the project name and preserves version, scenes, roots and template info', () => {
    const overview = sanitizeProjectAgentOverview(overviewSource());
    expect(overview.name).toBe('My Project');
    expect(overview.projectVersion).toBe(3);
    expect(overview.activeScene).toEqual({
      name: 'Main',
      relativePath: 'scenes/main.scene.json',
    });
    expect(overview.scenes).toEqual([
      { name: 'Main', relativePath: 'scenes/main.scene.json' },
      { name: 'Intro', relativePath: 'scenes/intro.scene.json' },
    ]);
    expect(overview.assetRoots.figure).toBe('figure');
    expect(overview.templates?.enabledTemplateIds).toEqual(['aeonstagery.default']);
    expect(overview.templates?.defaults).toEqual({ dialogueStyleId: 'glass' });
  });

  it('never exposes projectId, scene entry ids, defaultSceneId or absolute paths', () => {
    const source = overviewSource({
      ...({} as ProjectAgentOverviewSource),
    });
    const serialized = JSON.stringify(sanitizeProjectAgentOverview(source));
    expect(serialized).not.toContain('scene-entry-1');
    expect(serialized).not.toContain('scene-entry-2');
    expect(serialized).not.toContain('projectId');
    expect(serialized).not.toContain('defaultSceneId');
    expect(serialized).not.toContain('/home/');
    expect(serialized).not.toContain('C:');
  });

  it('drops scene ids and keeps only name and relative path per scene', () => {
    const overview = sanitizeProjectAgentOverview(overviewSource());
    const keys = Object.keys(overview.scenes[0] ?? {});
    expect(keys.sort()).toEqual(['name', 'relativePath']);
  });

  it('omits activeScene when no scene is active', () => {
    const overview = sanitizeProjectAgentOverview(overviewSource({ activeScene: undefined }));
    expect('activeScene' in overview).toBe(false);
  });

  it('excludes voice generation configuration entirely', () => {
    const overview = sanitizeProjectAgentOverview(overviewSource());
    const serialized = JSON.stringify(overview);
    expect(serialized).not.toContain('voiceGeneration');
    expect(serialized).not.toContain('gptSovits');
    expect(serialized).not.toContain('selectedPresetId');
  });

  it('drops absolute and traversal scene paths and asset roots (fail closed)', () => {
    const overview = sanitizeProjectAgentOverview(
      overviewSource({
        activeScene: { name: 'Main', path: '/home/user/project/scenes/main.scene.json' },
        scenes: [
          { id: 'a', name: 'Absolute', path: 'C:\\Windows\\secret.scene.json' },
          { id: 'b', name: 'Traversal', path: '../outside/scene.json' },
          { id: 'c', name: 'Ok', path: 'scenes/ok.scene.json' },
        ],
        assetRoots: {
          figure: '/home/user/figures',
          background: 'background',
          images: '../shared/images',
        },
      }),
    );
    expect('activeScene' in overview).toBe(false);
    expect(overview.scenes).toEqual([{ name: 'Ok', relativePath: 'scenes/ok.scene.json' }]);
    expect(overview.assetRoots).toEqual({ background: 'background' });
  });
});
