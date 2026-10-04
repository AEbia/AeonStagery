import { AUTHORING_SCHEMA_VERSION, type SemanticAuthorIntent } from '../../api/types/authoring';
import type { CharacterDirectoryCommand } from '../../api/types/character-directory';
import type { ProjectResourceService } from '../io/ProjectResourceService';
import type { IProjectWorkspaceService } from '../../api/interfaces/IProjectWorkspaceService';
import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import type {
  GenerateVoiceCandidateRequest,
  LocalVoicePresetResult,
  SaveLocalVoicePresetRequest,
  ScanVoiceCatalogRequest,
  VoiceCandidateResult,
  VoiceCatalogResult,
  VoiceLibraryResult,
  PublishTemplateVoiceProfileResult,
  LocalVoicePreset,
  ProjectVoiceProfile,
} from './VoiceAuthoringTypes';
import { createModelSelector } from './VoiceAuthoringTypes';

export interface VoiceAuthoringElectronPort {
  scanCatalog(request: ScanVoiceCatalogRequest): Promise<VoiceCatalogResult>;
  pickReferenceAudio(multiple: boolean): Promise<string[]>;
  listPresets(): Promise<VoiceLibraryResult>;
  resolveReference(presetId: string, referenceId: string): Promise<{ success: boolean; absolutePath?: string; error?: string }>;
  savePreset(request: SaveLocalVoicePresetRequest): Promise<LocalVoicePresetResult>;
  renamePreset(presetId: string, name: string): Promise<LocalVoicePresetResult>;
  duplicatePreset(presetId: string, name?: string): Promise<LocalVoicePresetResult>;
  deletePreset(presetId: string): Promise<VoiceLibraryResult>;
  publishTemplateProfile(presetId: string): Promise<PublishTemplateVoiceProfileResult>;
  generateCandidate(request: GenerateVoiceCandidateRequest): Promise<VoiceCandidateResult>;
  clearSession(sessionId: string): Promise<{ success: boolean; error?: string }>;
}

export interface AdoptVoiceCandidateCommand {
  candidatePath: string;
  candidateId: string;
  candidateText: string;
  dialogueText?: string;
  statementId?: string;
  projectId: string;
  mode: 'apply' | 'sync-and-apply' | 'save-only';
}

export interface VoiceSemanticAuthoringPort {
  getDocumentSnapshot(): CurrentSceneDocument;
  author(intent: SemanticAuthorIntent): Promise<unknown>;
  applyCharacterCommand(command: CharacterDirectoryCommand): Promise<unknown>;
}

export interface VoiceAdoptionReceipt {
  success: boolean;
  relativePath?: string;
  error?: string;
}

export class VoiceAuthoringService {
  constructor(
    private electron: VoiceAuthoringElectronPort,
    private projectResources: Pick<ProjectResourceService, 'getCurrentProject' | 'importGeneratedVoiceCandidate' | 'importVoiceReference' | 'removeProjectResource' | 'resolveForRead'>,
    private semanticAuthoring: VoiceSemanticAuthoringPort,
    private projectWorkspace?: Pick<IProjectWorkspaceService, 'updateVoiceProfiles'>,
  ) {}

  scanCatalog(request: ScanVoiceCatalogRequest): Promise<VoiceCatalogResult> {
    return this.electron.scanCatalog(request);
  }

  pickReferenceAudio(multiple: boolean): Promise<string[]> { return this.electron.pickReferenceAudio(multiple); }

  async setCharacterDefault(preset: LocalVoicePreset, characterId: string): Promise<{ success: boolean; profile?: ProjectVoiceProfile; error?: string }> {
    const importedReferencePaths: string[] = [];
    let previousProfiles: ProjectVoiceProfile[] = [];
    let profilesPersisted = false;
    try {
      if (!this.projectWorkspace) {
        throw new Error('角色默认音色服务未配置。');
      }
      const currentProject = this.projectResources.getCurrentProject();
      if (!currentProject) throw new Error('当前没有打开项目。');
      previousProfiles = [...(currentProject.metadata.voiceProfiles ?? [])];
      const references = [] as ProjectVoiceProfile['references'];
      for (const reference of preset.references) {
        const resolved = await this.electron.resolveReference(preset.id, reference.id);
        if (!resolved.success || !resolved.absolutePath) throw new Error(resolved.error || `参考音频不可用：${reference.label}`);
        const imported = await this.projectResources.importVoiceReference(resolved.absolutePath, preset.id, reference.id);
        importedReferencePaths.push(imported.relativePath);
        references.push({
          id: reference.id,
          label: reference.label,
          role: reference.role,
          promptText: reference.promptText,
          promptLang: reference.promptLang,
          tags: reference.tags,
          projectPath: imported.relativePath,
        });
      }
      const profile: ProjectVoiceProfile = {
        id: preset.id,
        name: preset.name,
        gptModel: createModelSelector(preset.gptModel),
        sovitsModel: createModelSelector(preset.sovitsModel),
        references,
        inferenceDefaults: { ...preset.inferenceDefaults },
      };
      const nextProfiles = [...previousProfiles.filter((item) => item.id !== profile.id), profile];
      const saved = await this.projectWorkspace.updateVoiceProfiles(nextProfiles);
      if (!saved.success) throw new Error(saved.error || '保存项目音色配置失败。');
      profilesPersisted = true;
      await this.semanticAuthoring.applyCharacterCommand({
        kind: 'set-character-voice-profile',
        origin: 'voice-workbench',
        charId: characterId,
        voiceProfileId: profile.id,
      });
      return { success: true, profile };
    } catch (error: any) {
      if (profilesPersisted && this.projectWorkspace) {
        await this.projectWorkspace.updateVoiceProfiles(previousProfiles).catch(() => undefined);
      }
      await Promise.all(importedReferencePaths.map((path) =>
        this.projectResources.removeProjectResource(path).catch(() => undefined),
      ));
      return { success: false, error: error?.message || String(error) };
    }
  }

  listPresets(): Promise<VoiceLibraryResult> { return this.electron.listPresets(); }
  resolveReference(presetId: string, referenceId: string) { return this.electron.resolveReference(presetId, referenceId); }
  savePreset(request: SaveLocalVoicePresetRequest): Promise<LocalVoicePresetResult> { return this.electron.savePreset(request); }
  renamePreset(presetId: string, name: string): Promise<LocalVoicePresetResult> { return this.electron.renamePreset(presetId, name); }
  duplicatePreset(presetId: string, name?: string): Promise<LocalVoicePresetResult> { return this.electron.duplicatePreset(presetId, name); }
  deletePreset(presetId: string): Promise<VoiceLibraryResult> { return this.electron.deletePreset(presetId); }
  publishTemplateProfile(presetId: string): Promise<PublishTemplateVoiceProfileResult> { return this.electron.publishTemplateProfile(presetId); }
  generateCandidate(request: GenerateVoiceCandidateRequest): Promise<VoiceCandidateResult> { return this.electron.generateCandidate(request); }
  resolveProjectReference(projectPath: string): Promise<string> { return this.projectResources.resolveForRead(projectPath); }
  discardSession(sessionId: string): Promise<{ success: boolean; error?: string }> { return this.electron.clearSession(sessionId); }

  async adoptCandidate(command: AdoptVoiceCandidateCommand): Promise<VoiceAdoptionReceipt> {
    let importedRelativePath: string | undefined;
    try {
      const project = this.projectResources.getCurrentProject();
      if (!project || project.metadata.projectId !== command.projectId) {
        throw new Error('候选所属项目已切换，请重新打开语音工作台。');
      }
      if (command.mode !== 'save-only' && !command.statementId) throw new Error('未指定要更新的对白。');
      if (command.mode === 'apply' && command.candidateText.trim() !== (command.dialogueText ?? '').trim()) {
        throw new Error('候选文本与对白不一致，必须同步文本或仅保存到项目。');
      }

      const imported = await this.projectResources.importGeneratedVoiceCandidate(
        command.candidatePath,
        `${command.candidateId}.wav`,
      );
      importedRelativePath = imported.relativePath;
      if (command.mode === 'save-only') return { success: true, relativePath: imported.relativePath };

      const statement = this.semanticAuthoring.getDocumentSnapshot().statements
        .find((candidate) => candidate.id === command.statementId);
      if (!statement || statement.type !== 'dialogue') {
        throw new Error('要更新的对白语句不存在。');
      }
      const params = {
        ...statement.params,
        voice: imported.relativePath,
        lipSync: true,
      };
      if (command.mode === 'sync-and-apply') params.text = command.candidateText;
      await this.semanticAuthoring.author({
        version: AUTHORING_SCHEMA_VERSION,
        correlationId: `voice_candidate_${command.candidateId}`,
        origin: 'voice-workbench',
        kind: 'update-statement',
        statementId: command.statementId!,
        patch: { params },
      });
      return { success: true, relativePath: imported.relativePath };
    } catch (error: any) {
      if (importedRelativePath) {
        await this.projectResources.removeProjectResource(importedRelativePath).catch(() => undefined);
      }
      return { success: false, error: error?.message || String(error) };
    }
  }
}

export class ElectronVoiceAuthoringAdapter implements VoiceAuthoringElectronPort {
  constructor(private api: VoiceAuthoringElectronPort) {}
  scanCatalog(request: ScanVoiceCatalogRequest) { return this.api.scanCatalog(request); }
  pickReferenceAudio(multiple: boolean) { return this.api.pickReferenceAudio(multiple); }
  listPresets() { return this.api.listPresets(); }
  resolveReference(presetId: string, referenceId: string) { return this.api.resolveReference(presetId, referenceId); }
  savePreset(request: SaveLocalVoicePresetRequest) { return this.api.savePreset(request); }
  renamePreset(presetId: string, name: string) { return this.api.renamePreset(presetId, name); }
  duplicatePreset(presetId: string, name?: string) { return this.api.duplicatePreset(presetId, name); }
  deletePreset(presetId: string) { return this.api.deletePreset(presetId); }
  publishTemplateProfile(presetId: string) { return this.api.publishTemplateProfile(presetId); }
  generateCandidate(request: GenerateVoiceCandidateRequest) { return this.api.generateCandidate(request); }
  clearSession(sessionId: string) { return this.api.clearSession(sessionId); }
}
