import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectOpenWorkflow } from '../services/project/ProjectOpenWorkflow';
import type { IProjectWorkspaceService } from '../api/interfaces/IProjectWorkspaceService';
import type { ISceneFileService } from '../api/interfaces/ISceneFileService';
import type { ProjectState } from '../api/types/project';
import type { ProjectOpenDependencySnapshot } from '../api/interfaces/IProjectOpenWorkflow';
import type { ProjectRecentsPort, ProjectWorkflowSettingsPort } from '../services/project/ProjectWorkflowPorts';

describe('ProjectOpenWorkflow', () => {
  let projectWorkspace: IProjectWorkspaceService;
  let sceneFile: ISceneFileService;
  let recents: ProjectRecentsPort;
  let settings: ProjectWorkflowSettingsPort;
  let workflow: ProjectOpenWorkflow;

  const project: ProjectState = {
    projectId: 'p1',
    rootPath: 'D:/demo',
    projectFilePath: 'D:/demo/project.json',
    metadata: {
      id: 'p1',
      name: 'Demo',
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
    },
  } as any;

  beforeEach(() => {
    projectWorkspace = {
      getCurrentProject: vi.fn(),
      closeProject: vi.fn(),
      subscribe: vi.fn(),
      createProjectAt: vi.fn(),
      openProjectAt: vi.fn(),
      prepareCollaborationProjectAt: vi.fn(),
      updateTemplateConfiguration: vi.fn(),
      updateVoiceGenerationConfiguration: vi.fn(),
      updateVoiceProfiles: vi.fn(),
      prepareTemplateCharacters: vi.fn(),
      prepareDialogueStyle: vi.fn(),
      regenerateWebGalScene: vi.fn(),
    };
    sceneFile = {
      loadExample: vi.fn(),
      loadFile: vi.fn(),
      loadFromPath: vi.fn(),
      loadFromRawJson: vi.fn(),
      save: vi.fn(),
      saveAs: vi.fn(),
    };
    recents = { upsertRecentProject: vi.fn<(entry: any) => void>() };
    settings = { setAssetsPath: vi.fn<(path: string) => void>() };
    workflow = new ProjectOpenWorkflow(projectWorkspace, sceneFile, recents, settings);
  });

  it('creates a project, updates recents/settings, and loads default scene', async () => {
    vi.mocked(projectWorkspace.createProjectAt).mockResolvedValue({
      success: true,
      project,
      scenePath: 'D:/demo/project/main.scene.json',
    });
    vi.mocked(sceneFile.loadFromPath).mockResolvedValue({
      success: true,
      path: 'D:/demo/project/main.scene.json',
      issues: [],
    });

    const result = await workflow.createProjectAndLoadDefaultScene({ name: 'Demo', rootPath: 'D:/demo' });

    expect(result.success).toBe(true);
    expect(result.outcome).toBe('project_ready');
    expect(projectWorkspace.createProjectAt).toHaveBeenCalledWith(
      'D:/demo',
      'Demo',
      { templates: undefined },
    );
    expect(recents.upsertRecentProject).toHaveBeenCalled();
    expect(settings.setAssetsPath).toHaveBeenCalledWith('D:/demo');
    expect(sceneFile.loadFromPath).toHaveBeenCalledWith('D:/demo/project/main.scene.json');
  });

  it('passes template configuration through project creation', async () => {
    vi.mocked(projectWorkspace.createProjectAt).mockResolvedValue({
      success: true,
      project,
      scenePath: 'D:/demo/project/main.scene.json',
    });
    vi.mocked(sceneFile.loadFromPath).mockResolvedValue({
      success: true,
      path: 'D:/demo/project/main.scene.json',
      issues: [],
    });

    await workflow.createProjectAndLoadDefaultScene({
      name: 'Demo',
      rootPath: 'D:/demo',
      templates: {
        enabledTemplateIds: ['mygo', 'mujica'],
        defaults: { dialogueStyleId: 'mujica.glass' },
        selectedCharacterPresetIds: ['tomori'],
      },
    });

    expect(projectWorkspace.createProjectAt).toHaveBeenCalledWith(
      'D:/demo',
      'Demo',
      {
        templates: {
          enabledTemplateIds: ['mygo', 'mujica'],
          defaults: { dialogueStyleId: 'mujica.glass' },
          selectedCharacterPresetIds: ['tomori'],
        },
      },
    );
  });

  it('returns project_open_failed without touching recents/settings/load', async () => {
    vi.mocked(projectWorkspace.openProjectAt).mockResolvedValue({
      success: false,
      error: 'boom',
    });

    const result = await workflow.openProjectAndLoadDefaultScene('D:/demo/project.json');

    expect(result.success).toBe(false);
    expect(result.outcome).toBe('project_open_failed');
    expect(recents.upsertRecentProject).not.toHaveBeenCalled();
    expect(settings.setAssetsPath).not.toHaveBeenCalled();
    expect(sceneFile.loadFromPath).not.toHaveBeenCalled();
  });

  it('rolls back project session and does not pollute recents when default scene load fails', async () => {
    vi.mocked(projectWorkspace.openProjectAt).mockResolvedValue({
      success: true,
      project,
      scenePath: 'D:/demo/project/main.scene.json',
    });
    vi.mocked(sceneFile.loadFromPath).mockResolvedValue({
      success: false,
      path: 'D:/demo/project/main.scene.json',
      error: 'bad scene schema',
    } as any);

    const result = await workflow.openProjectAndLoadDefaultScene('D:/demo/project.json');

    expect(result.success).toBe(false);
    expect(result.outcome).toBe('default_scene_load_failed');
    expect(projectWorkspace.closeProject).toHaveBeenCalledTimes(1);
    expect(recents.upsertRecentProject).not.toHaveBeenCalled();
    expect(settings.setAssetsPath).not.toHaveBeenCalled();
  });

  it('returns project_ready_with_warnings when load issues are present', async () => {
    vi.mocked(projectWorkspace.openProjectAt).mockResolvedValue({
      success: true,
      project,
      scenePath: 'D:/demo/project/main.scene.json',
    });
    vi.mocked(sceneFile.loadFromPath).mockResolvedValue({
      success: true,
      path: 'D:/demo/project/main.scene.json',
      issues: [{ severity: 'warning', message: 'warn' }],
    } as any);

    const result = await workflow.openRecentProjectAndLoadDefaultScene('D:/demo/project.json');

    expect(result.success).toBe(true);
    expect(result.outcome).toBe('project_ready_with_warnings');
    expect(result.issues).toHaveLength(1);
  });

  it('prepares a collaboration join project without loading its default scene', async () => {
    vi.mocked(projectWorkspace.prepareCollaborationProjectAt).mockResolvedValue({
      success: true,
      project,
      scenePath: 'D:/demo/project/main.scene.json',
    });

    const result = await workflow.prepareCollaborationJoinProject({
      rootPath: 'D:/demo',
      name: 'Join Session',
    });

    expect(result.success).toBe(true);
    expect(result.outcome).toBe('collaboration_join_project_ready');
    expect(recents.upsertRecentProject).toHaveBeenCalledWith(expect.objectContaining({
      projectFilePath: 'D:/demo/project.json',
      rootPath: 'D:/demo',
    }));
    expect(settings.setAssetsPath).toHaveBeenCalledWith('D:/demo');
    expect(sceneFile.loadFromPath).not.toHaveBeenCalled();
  });

  it('rejects an invalid collaboration join directory without touching recents/settings/load', async () => {
    vi.mocked(projectWorkspace.prepareCollaborationProjectAt).mockResolvedValue({
      success: false,
      error: '请选择空目录',
    });

    const result = await workflow.prepareCollaborationJoinProject({ rootPath: 'D:/bad' });

    expect(result.success).toBe(false);
    expect(result.outcome).toBe('collaboration_join_project_failed');
    expect(recents.upsertRecentProject).not.toHaveBeenCalled();
    expect(settings.setAssetsPath).not.toHaveBeenCalled();
    expect(sceneFile.loadFromPath).not.toHaveBeenCalled();
  });

  it('regenerates the WebGAL scene and reloads it', async () => {
    vi.mocked(projectWorkspace.regenerateWebGalScene).mockResolvedValue({
      success: true,
      scenePath: 'D:/demo/project/main.scene.json',
      webgalReport: {
        stats: {
          narrationCount: 1, dialogueCount: 1, multiSpeakerCount: 0,
          backgroundChanges: 1, figureEnters: 1, figureExits: 0,
          transforms: 0, performances: 0, cameraFocuses: 0,
          bgmCount: 0, sfxCount: 0,
        },
        characters: [],
        notes: [],
        unsupportedCommands: [],
      },
    });
    vi.mocked(projectWorkspace.getCurrentProject).mockReturnValue(project);
    vi.mocked(sceneFile.loadFromPath).mockResolvedValue({
      success: true,
      path: 'D:/demo/project/main.scene.json',
      issues: [],
    });

    const result = await workflow.regenerateWebGalSceneAndReload({ speed: 2 });

    expect(projectWorkspace.regenerateWebGalScene).toHaveBeenCalledWith({ speed: 2 });
    expect(sceneFile.loadFromPath).toHaveBeenCalledWith('D:/demo/project/main.scene.json');
    expect(result.success).toBe(true);
    expect(result.outcome).toBe('project_ready');
    expect(result.webgalReport).toBeDefined();
  });

  it('reports a failed regeneration without touching the scene file', async () => {
    vi.mocked(projectWorkspace.regenerateWebGalScene).mockResolvedValue({
      success: false,
      error: '该项目没有可重新生成的 WebGAL 导入凭据',
    });

    const result = await workflow.regenerateWebGalSceneAndReload();

    expect(result.success).toBe(false);
    expect(sceneFile.loadFromPath).not.toHaveBeenCalled();
  });

  describe('with a dependency scan port', () => {
    function openWithDependencies(
      scanProjectDependencies: () => Promise<ProjectOpenDependencySnapshot | null>,
    ) {
      const scoped = new ProjectOpenWorkflow(
        projectWorkspace,
        sceneFile,
        recents,
        settings,
        { scanProjectDependencies },
      );
      vi.mocked(projectWorkspace.openProjectAt).mockResolvedValue({
        success: true,
        project,
        scenePath: 'D:/demo/project/main.scene.json',
      });
      vi.mocked(sceneFile.loadFromPath).mockResolvedValue({
        success: true,
        path: 'D:/demo/project/main.scene.json',
        issues: [],
      });
      return scoped.openProjectAndLoadDefaultScene('D:/demo/project.json');
    }

    it('degrades to project_ready_degraded without closing the project', async () => {
      const result = await openWithDependencies(async () => ({
        scenesScanned: 2,
        degraded: true,
        degradedMounts: [{
          mountId: 'library',
          status: 'mount-unbound',
          referenceCount: 4,
          sceneCount: 2,
          sampleReferences: ['vocal/a.ogg'],
        }],
      }));

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('project_ready_degraded');
      expect(result.messageKey).toBe('project_ready_degraded');
      expect(result.dependencies?.degradedMounts).toEqual([
        expect.objectContaining({ mountId: 'library', status: 'mount-unbound' }),
      ]);
      // Missing external content must never roll the opened project back.
      expect(projectWorkspace.closeProject).not.toHaveBeenCalled();
      expect(recents.upsertRecentProject).toHaveBeenCalled();
      expect(settings.setAssetsPath).toHaveBeenCalledWith('D:/demo');
    });

    it('stays project_ready when every dependency resolves', async () => {
      const result = await openWithDependencies(async () => ({
        scenesScanned: 2,
        degraded: false,
        degradedMounts: [],
      }));

      expect(result.outcome).toBe('project_ready');
      expect(result.dependencies?.degraded).toBe(false);
    });

    it('survives a failing scan instead of failing the open', async () => {
      const result = await openWithDependencies(async () => {
        throw new Error('scan exploded');
      });

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('project_ready');
      expect(result.dependencies).toBeUndefined();
    });
  });
});
