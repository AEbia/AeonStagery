import type {
  ProjectState,
  ProjectTemplateConfiguration,
  ProjectVoiceGenerationConfiguration,
  ProjectVoiceProfile,
} from '../types/project';
import type { SceneMeta } from '../types/scene-common';
import type { CreateProjectOptions, ProjectResult, WebGalRegenerateResult } from '../../services/io/ProjectWorkspaceService';

type SceneCharacter = NonNullable<SceneMeta['characters']>[number];

export interface IProjectWorkspaceService {
  getCurrentProject(): ProjectState | null;
  closeProject(): void;
  subscribe(listener: () => void): () => void;
  createProjectAt(rootPath: string, name?: string, options?: CreateProjectOptions): Promise<ProjectResult>;
  openProjectAt(projectPathOrRoot: string): Promise<ProjectResult>;
  prepareCollaborationProjectAt(rootPath: string, name?: string): Promise<ProjectResult>;
  updateTemplateConfiguration(templates: ProjectTemplateConfiguration): Promise<ProjectResult>;
  updateVoiceGenerationConfiguration(voiceGeneration: ProjectVoiceGenerationConfiguration): Promise<ProjectResult>;
  updateVoiceProfiles(voiceProfiles: ProjectVoiceProfile[]): Promise<ProjectResult>;
  prepareTemplateCharacters(templates: ProjectTemplateConfiguration): Promise<SceneCharacter[]>;
  prepareDialogueStyle(styleId: string): Promise<ProjectTemplateConfiguration>;
  regenerateWebGalScene(input?: { speed?: number }): Promise<WebGalRegenerateResult>;
}
