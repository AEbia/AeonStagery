import type { IProjectWorkspaceService } from '../../api/interfaces/IProjectWorkspaceService';
import type { ISceneFileService } from '../../api/interfaces/ISceneFileService';
import type {
  CreateProjectWorkflowInput,
  IProjectOpenWorkflow,
  ProjectOpenDependencySnapshot,
  ProjectWorkflowResult,
} from '../../api/interfaces/IProjectOpenWorkflow';
import type { ProjectState } from '../../api/types/project';
import type { ValidationIssue } from '../../api/types/validation';
import type { ProjectRecentsPort, ProjectWorkflowSettingsPort } from './ProjectWorkflowPorts';

/**
 * Optional seam to the project dependency scanner. Successful opens run it so
 * missing external-library resources become a diagnosable degraded state —
 * never a "project failed to open" rollback.
 */
export interface ProjectDependencyScanPort {
  scanProjectDependencies(): Promise<ProjectOpenDependencySnapshot | null>;
}

export class ProjectOpenWorkflow implements IProjectOpenWorkflow {
  constructor(
    private projectWorkspace: IProjectWorkspaceService,
    private sceneFile: ISceneFileService,
    private recents: ProjectRecentsPort,
    private settings: ProjectWorkflowSettingsPort,
    private dependencies?: ProjectDependencyScanPort,
  ) {}

  async createProjectAndLoadDefaultScene(input: CreateProjectWorkflowInput): Promise<ProjectWorkflowResult> {
    const result = await this.projectWorkspace.createProjectAt(
      input.rootPath,
      input.name || 'AeonStagery Project',
      { templates: input.templates, webgal: input.webgal },
    );
    if (!result.success) {
      return {
        success: false,
        outcome: 'project_create_failed',
        failureKind: 'project_create_failed',
        messageKey: 'project_create_failed',
        error: result.error,
      };
    }

    const workflow = await this.finishOpenFlow(result.project, result.scenePath);
    return result.webgalReport ? { ...workflow, webgalReport: result.webgalReport } : workflow;
  }

  async openProjectAndLoadDefaultScene(projectPathOrRoot: string): Promise<ProjectWorkflowResult> {
    const result = await this.projectWorkspace.openProjectAt(projectPathOrRoot);
    if (!result.success) {
      return {
        success: false,
        outcome: 'project_open_failed',
        failureKind: 'project_open_failed',
        messageKey: 'project_open_failed',
        error: result.error,
      };
    }

    return this.finishOpenFlow(result.project, result.scenePath);
  }

  async openRecentProjectAndLoadDefaultScene(projectFilePath: string): Promise<ProjectWorkflowResult> {
    return this.openProjectAndLoadDefaultScene(projectFilePath);
  }

  async prepareCollaborationJoinProject(input: { rootPath: string; name?: string }): Promise<ProjectWorkflowResult> {
    const result = await this.projectWorkspace.prepareCollaborationProjectAt(
      input.rootPath,
      input.name || 'AeonStagery Collaboration',
    );
    if (!result.success) {
      return {
        success: false,
        outcome: 'collaboration_join_project_failed',
        failureKind: 'collaboration_join_project_failed',
        messageKey: 'collaboration_join_project_failed',
        error: result.error,
      };
    }

    this.recents.upsertRecentProject({
      name: result.project.metadata.name,
      projectFilePath: result.project.projectFilePath,
      rootPath: result.project.rootPath,
      lastOpenedAt: new Date().toISOString(),
    });
    this.settings.setAssetsPath(result.project.rootPath);

    return {
      success: true,
      outcome: 'collaboration_join_project_ready',
      failureKind: null,
      messageKey: 'collaboration_join_project_ready',
      project: result.project,
      scenePath: result.scenePath,
      issues: [],
    };
  }

  async regenerateWebGalSceneAndReload(input: { speed?: number } = {}): Promise<ProjectWorkflowResult> {
    const result = await this.projectWorkspace.regenerateWebGalScene(input);
    if (!result.success) {
      return {
        success: false,
        outcome: 'project_open_failed',
        failureKind: 'project_open_failed',
        messageKey: 'project_open_failed',
        error: result.error,
      };
    }

    const project = this.projectWorkspace.getCurrentProject();
    const loadResult = await this.sceneFile.loadFromPath(result.scenePath);
    if (!loadResult.success) {
      return {
        success: false,
        outcome: 'default_scene_load_failed',
        failureKind: 'default_scene_load_failed',
        messageKey: 'default_scene_load_failed',
        project: project ?? undefined,
        scenePath: result.scenePath,
        error: 'error' in loadResult ? loadResult.error : 'Failed to reload regenerated scene',
      };
    }

    const hasWarnings = loadResult.issues.length > 0;
    return {
      success: true,
      outcome: hasWarnings ? 'project_ready_with_warnings' : 'project_ready',
      failureKind: null,
      messageKey: hasWarnings ? 'project_ready_with_warnings' : 'project_ready',
      project: project ?? undefined,
      scenePath: result.scenePath,
      issues: loadResult.issues,
      webgalReport: result.webgalReport,
    };
  }

  private async finishOpenFlow(project: ProjectState, scenePath: string): Promise<ProjectWorkflowResult> {
    const loadResult = await this.sceneFile.loadFromPath(scenePath);
    if (!loadResult.success) {
      // Only genuine document/format failures roll the opened project back;
      // degraded resources load and project normally (see degraded outcome).
      this.projectWorkspace.closeProject();
      return {
        success: false,
        outcome: 'default_scene_load_failed',
        failureKind: 'default_scene_load_failed',
        messageKey: 'default_scene_load_failed',
        project,
        scenePath,
        error: 'error' in loadResult ? loadResult.error : 'Failed to load default scene',
      };
    }

    this.recents.upsertRecentProject({
      name: project.metadata.name,
      projectFilePath: project.projectFilePath,
      rootPath: project.rootPath,
      lastOpenedAt: new Date().toISOString(),
    });
    this.settings.setAssetsPath(project.rootPath);

    return this.buildSuccess(project, scenePath, loadResult.issues);
  }

  private async buildSuccess(
    project: ProjectState,
    scenePath: string,
    issues: ValidationIssue[],
  ): Promise<ProjectWorkflowResult> {
    const dependencies = await this.dependencies?.scanProjectDependencies().catch((error) => {
      // A failed scan only costs diagnostics; the project itself opened fine.
      console.warn('[ProjectOpenWorkflow] Dependency scan failed:', error);
      return null;
    });
    const hasWarnings = issues.length > 0;
    const outcome: ProjectWorkflowResult['outcome'] = dependencies?.degraded
      ? 'project_ready_degraded'
      : (hasWarnings ? 'project_ready_with_warnings' : 'project_ready');
    return {
      success: true,
      outcome,
      failureKind: null,
      messageKey: outcome,
      project,
      scenePath,
      issues,
      ...(dependencies ? { dependencies } : {}),
    };
  }
}
