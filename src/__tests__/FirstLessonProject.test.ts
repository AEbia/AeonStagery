import { describe, expect, it, vi } from 'vitest';
import type { IProjectOpenWorkflow, ProjectWorkflowResult } from '../api/interfaces/IProjectOpenWorkflow';
import { FirstLessonProgressStore } from '../services/onboarding/FirstLessonProgress';
import {
  createUniqueFirstLessonProjectRoot,
  FirstLessonProjectService,
} from '../services/onboarding/FirstLessonProject';

function createMemoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe('FirstLessonProject', () => {
  it('creates a unique tutorial project root with timestamp and suffix', async () => {
    const existing = new Set([
      'D:/projects/教程练习-20260729-103011',
      'D:/projects/教程练习-20260729-103011-2',
    ]);
    const fileAccess = {
      exists: vi.fn(async (path: string) => existing.has(path)),
      join: vi.fn((...parts: string[]) => parts.join('/').replace(/\/+/g, '/')),
    };

    await expect(createUniqueFirstLessonProjectRoot(
      'D:/projects',
      fileAccess,
      new Date('2026-07-29T10:30:11'),
    )).resolves.toBe('D:/projects/教程练习-20260729-103011-3');
  });

  it('creates and loads a fresh tutorial project, then stores only durable tutorial progress', async () => {
    const storage = createMemoryStorage();
    const progressStore = new FirstLessonProgressStore(storage);
    const createProjectAndLoadDefaultScene = vi.fn<IProjectOpenWorkflow['createProjectAndLoadDefaultScene']>(async (input) => ({
      success: true,
      outcome: 'project_ready',
      failureKind: null,
      messageKey: 'project_ready',
      project: {
        rootPath: input.rootPath,
        projectFilePath: `${input.rootPath}/project.json`,
        metadata: {
          projectId: 'tutorial-project',
          name: input.name,
          projectVersion: 2,
          createdAt: '2026-07-29T10:30:11.000Z',
          updatedAt: '2026-07-29T10:30:11.000Z',
          defaultSceneId: 'main',
          scenes: [{ id: 'main', name: 'Main Scene', path: 'project/main.scene.json' }],
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
      },
      scenePath: `${input.rootPath}/project/main.scene.json`,
      issues: [],
    }));
    const service = new FirstLessonProjectService(
      {
        exists: vi.fn(async () => false),
        join: vi.fn((...parts: string[]) => parts.join('/').replace(/\/+/g, '/')),
      },
      { createProjectAndLoadDefaultScene },
      progressStore,
      { now: () => new Date('2026-07-29T10:30:11') },
    );

    const result = await service.createTutorialProject({ defaultProjectDirectory: 'D:/projects' });

    expect(createProjectAndLoadDefaultScene).toHaveBeenCalledWith({
      name: '教程练习',
      rootPath: 'D:/projects/教程练习-20260729-103011',
      templates: undefined,
    });
    expect(result.success).toBe(true);
    expect(progressStore.load()).toEqual({
      currentStep: 'create-character',
      hasStartedPreview: false,
      completed: false,
      tutorialProjectPath: 'D:/projects/教程练习-20260729-103011',
    });
  });

  it('does not update progress when project creation fails', async () => {
    const progressStore = new FirstLessonProgressStore(createMemoryStorage());
    const service = new FirstLessonProjectService(
      {
        exists: vi.fn(async () => false),
        join: vi.fn((...parts: string[]) => parts.join('/').replace(/\/+/g, '/')),
      },
      {
        createProjectAndLoadDefaultScene: vi.fn(async (): Promise<ProjectWorkflowResult> => ({
          success: false,
          outcome: 'project_create_failed',
          failureKind: 'project_create_failed',
          messageKey: 'project_create_failed',
          error: 'disk full',
        })),
      },
      progressStore,
      { now: () => new Date('2026-07-29T10:30:11') },
    );

    await expect(service.createTutorialProject({ defaultProjectDirectory: 'D:/projects' }))
      .resolves.toMatchObject({ success: false, error: 'disk full' });
    expect(progressStore.load()).toEqual({
      currentStep: 'prepare-asset-source',
      hasStartedPreview: false,
      completed: false,
    });
  });
});
