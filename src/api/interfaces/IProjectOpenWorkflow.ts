import type { ProjectState } from '../types/project';
import type { ProjectTemplateConfiguration } from '../types/project';
import type { ValidationIssue, ValidationMountDetail } from '../types/validation';
import type { WebGalImportInput, WebGalImportReport } from '../../services/import/webgal';

export type ProjectWorkflowOutcome =
  | 'project_ready'
  | 'project_ready_with_warnings'
  | 'project_ready_degraded'
  | 'project_create_failed'
  | 'project_open_failed'
  | 'collaboration_join_project_ready'
  | 'collaboration_join_project_failed'
  | 'default_scene_load_failed';

/** Compact dependency summary attached to degraded successful opens. */
export interface ProjectOpenDependencySnapshot {
  scenesScanned: number;
  /**
   * Mounts that could not be fully resolved on this machine, shaped exactly
   * like the validation-panel detail so both surfaces render from one type.
   */
  degradedMounts: ValidationMountDetail[];
  degraded: boolean;
}

export interface ProjectWorkflowResult {
  success: boolean;
  outcome: ProjectWorkflowOutcome;
  failureKind: ProjectWorkflowOutcome | null;
  messageKey: ProjectWorkflowOutcome;
  project?: ProjectState;
  scenePath?: string;
  issues?: ValidationIssue[];
  error?: string;
  webgalReport?: WebGalImportReport;
  /** Present on successful opens when the project scan ran. */
  dependencies?: ProjectOpenDependencySnapshot;
}

export interface CreateProjectWorkflowInput {
  name: string;
  rootPath: string;
  templates?: ProjectTemplateConfiguration;
  webgal?: WebGalImportInput;
}

export interface IProjectOpenWorkflow {
  createProjectAndLoadDefaultScene(input: CreateProjectWorkflowInput): Promise<ProjectWorkflowResult>;
  openProjectAndLoadDefaultScene(projectPathOrRoot: string): Promise<ProjectWorkflowResult>;
  openRecentProjectAndLoadDefaultScene(projectFilePath: string): Promise<ProjectWorkflowResult>;
  prepareCollaborationJoinProject(input: { rootPath: string; name?: string }): Promise<ProjectWorkflowResult>;
  /** Regenerates the scene owned by the stored WebGAL import receipt and reloads it. */
  regenerateWebGalSceneAndReload(input?: { speed?: number }): Promise<ProjectWorkflowResult>;
}
