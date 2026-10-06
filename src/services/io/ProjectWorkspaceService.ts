import {
  DEFAULT_PROJECT_TEMPLATE_CONFIGURATION,
  type ProjectState,
  type ProjectTemplateConfiguration,
  type ProjectVoiceGenerationConfiguration,
  type ProjectWebGalImportReceipt,
} from '../../api/types/project';
import type { CurrentSceneDocument, DialogueImagePresentation } from '../../api/types/semantic-scene';
import type { SceneMeta } from '../../api/types/scene-common';
import { ProjectResourceService } from './ProjectResourceService';
import type { IFileAccess } from './IFileAccess';
import { ProjectSession } from './ProjectSession';
import {
  createTemplateInitializedScene,
  importInitialTemplateCharacterAssets,
  createTemplatePackageView,
  type LoadedTemplatePackage,
} from '../template-package';
import type { SceneAssetHooks } from './SceneAssetService';
import {
  applyWebGalVoiceTiming,
  audioDurationSeconds,
  convertWebGalToSceneDocument,
  joinWebGalScriptTexts,
  type WebGalImportInput,
  type WebGalImportReport,
} from '../import/webgal';

export type ProjectResult =
  | { success: true; project: ProjectState; scenePath: string; webgalReport?: WebGalImportReport }
  | { success: false; error: string };

export type WebGalRegenerateResult =
  | { success: true; scenePath: string; webgalReport: WebGalImportReport }
  | { success: false; error: string };

export interface CreateProjectOptions {
  templates?: ProjectTemplateConfiguration;
  webgal?: WebGalImportInput;
}

type SceneCharacter = NonNullable<SceneMeta['characters']>[number];

export class ProjectWorkspaceService {
  private voiceGenerationSaveQueue: Promise<void> = Promise.resolve();

  constructor(
    private fileAccess: IFileAccess,
    private projectResources: ProjectResourceService,
    private session: ProjectSession,
    private setProjectRoot: (path: string) => void,
    private getTemplatePackages: () => LoadedTemplatePackage[] = () => [],
    private sceneAssets?: Pick<SceneAssetHooks, 'importAssetPath' | 'importTemplateAssetPath'>,
  ) {}

  getCurrentProject(): ProjectState | null {
    return this.session.getCurrentProject();
  }

  closeProject(): void {
    this.session.setCurrentProject(null);
    this.setProjectRoot('');
  }

  subscribe(listener: () => void): () => void {
    return this.session.subscribe(listener);
  }

  async createProjectAt(
    rootPath: string,
    name = 'AeonStagery Project',
    options: CreateProjectOptions = {},
  ): Promise<ProjectResult> {
    try {
      const project = await this.projectResources.createProject(rootPath, name, {
        ...options,
        templates: options.templates ?? this.defaultProjectTemplateConfiguration(),
      });
      this.session.setCurrentProject(project);
      this.setProjectRoot(project.rootPath);
      let resultProject = project;
      if (project.metadata.templates) {
        const materializedTemplates = await this.materializeDialoguePresentation(project.metadata.templates);
        resultProject = await this.projectResources.saveProjectMetadata(project, {
          ...project.metadata,
          templates: materializedTemplates,
        });
        this.session.setCurrentProject(resultProject);
      }

      const sceneRelativePath = project.metadata.scenes[0]?.path;
      if (!sceneRelativePath) {
        return { success: false, error: 'Project metadata missing default scene entry' };
      }

      const sceneAbsolutePath = await this.resolveScenePath(project.rootPath, sceneRelativePath);
      const templatePackages = this.getTemplatePackages();
      let scene: CurrentSceneDocument;
      let webgalReport: WebGalImportReport | undefined;
      if (options.webgal) {
        // Multiple script parts merge into ONE continuous scene timeline, so
        // playback runs through every chapter in order without interruption.
        const scriptNames = [
          options.webgal.scriptName,
          ...(options.webgal.additionalScripts ?? []).map((part) => part.scriptName),
        ].filter((value): value is string => Boolean(value));
        const mergedInput: WebGalImportInput = {
          ...options.webgal,
          scriptText: joinWebGalScriptTexts(options.webgal),
        };
        const converted = await this.convertWebGalScene(mergedInput, name);
        scene = converted.document;
        webgalReport = converted.report;
        const receipt: ProjectWebGalImportReceipt = {
          scriptName: scriptNames.length > 0 ? scriptNames.join(' + ') : 'WebGAL 剧本',
          scriptNames: scriptNames.length > 0 ? scriptNames : undefined,
          scriptText: mergedInput.scriptText,
          mountId: options.webgal.mountId,
          speed: options.webgal.speed ?? 1.5,
          sceneTitle: name,
          scenePath: sceneRelativePath,
          generatedAt: new Date().toISOString(),
          report: converted.report,
        };
        const projectWithReceipt = await this.projectResources.saveProjectMetadata(project, {
          ...project.metadata,
          webGalImport: receipt,
        });
        this.session.setCurrentProject(projectWithReceipt);
        resultProject = projectWithReceipt;
      } else {
        scene = createTemplateInitializedScene(name, {
          templateConfiguration: resultProject.metadata.templates,
          templatePackages,
        });
        if (this.sceneAssets) {
          await importInitialTemplateCharacterAssets(
            scene,
            templatePackages,
            resultProject.metadata.templates,
            this.sceneAssets.importTemplateAssetPath.bind(this.sceneAssets),
            (...parts) => this.fileAccess.join(...parts),
          );
        }
      }
      await this.fileAccess.writeFile(sceneAbsolutePath, JSON.stringify(scene, null, 2));
      await this.projectResources.refreshCompatibilityEnvelope(resultProject);

      return {
        success: true,
        project: resultProject,
        scenePath: sceneAbsolutePath,
        webgalReport,
      };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  private defaultProjectTemplateConfiguration(): ProjectTemplateConfiguration {
    const enabledTemplateIds = [...new Set(
      this.getTemplatePackages().map((templatePackage) => templatePackage.manifest.template.id),
    )];
    return {
      enabledTemplateIds: enabledTemplateIds.length > 0
        ? enabledTemplateIds
        : [...DEFAULT_PROJECT_TEMPLATE_CONFIGURATION.enabledTemplateIds],
      selectedCharacterPresetIds: [],
      characterVariantImportMode: 'primary-only',
    };
  }

  /**
   * Re-runs the WebGAL conversion for the stored import receipt and replaces
   * the scene file it owns. The receipt keeps the raw script, asset mount and
   * previous options, so the only required input is an optional new speed.
   */
  async regenerateWebGalScene(input: { speed?: number } = {}): Promise<WebGalRegenerateResult> {
    try {
      const project = this.session.getCurrentProject();
      if (!project) return { success: false, error: 'No active project' };
      const receipt = project.metadata.webGalImport;
      if (!receipt) {
        return { success: false, error: '该项目没有可重新生成的 WebGAL 导入凭据' };
      }

      const speed = Number.isFinite(input.speed) && (input.speed as number) > 0
        ? (input.speed as number)
        : receipt.speed;
      const converted = await this.convertWebGalScene(
        {
          scriptText: receipt.scriptText,
          scriptName: receipt.scriptName,
          mountId: receipt.mountId,
          speed,
        },
        receipt.sceneTitle,
      );

      const sceneAbsolutePath = await this.resolveScenePath(project.rootPath, receipt.scenePath);
      await this.fileAccess.writeFile(sceneAbsolutePath, JSON.stringify(converted.document, null, 2));

      const updatedReceipt: ProjectWebGalImportReceipt = {
        ...receipt,
        speed,
        generatedAt: new Date().toISOString(),
        report: converted.report,
      };
      const updatedProject = await this.projectResources.saveProjectMetadata(project, {
        ...project.metadata,
        webGalImport: updatedReceipt,
      });
      this.session.setCurrentProject(updatedProject);

      return { success: true, scenePath: sceneAbsolutePath, webgalReport: converted.report };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  private async convertWebGalScene(
    input: WebGalImportInput,
    sceneTitle: string,
  ): Promise<{ document: CurrentSceneDocument; report: WebGalImportReport }> {
    const converted = convertWebGalToSceneDocument(input.scriptText, {
      mountId: input.mountId,
      sceneTitle,
      duration: { speed: input.speed },
    });
    let document = converted.document;
    const report = converted.report;

    if (input.mountId) {
      const timing = await applyWebGalVoiceTiming(document, {
        speed: input.speed,
        resolveAudio: (reference) => this.projectResources.resolveForRead(reference),
        readAudioDuration: async (fsPath) => {
          if (!this.fileAccess.readBinaryFile) return null;
          try {
            const { data } = await this.fileAccess.readBinaryFile(fsPath);
            return audioDurationSeconds(data);
          } catch {
            return null;
          }
        },
      });
      document = timing.document;
      if (timing.missing > 0) {
        report.notes.push({
          lineNumber: 0,
          message: `有 ${timing.missing} 条配音未能读取时长，保持按文字估算。`,
        });
      }
    }

    return { document, report };
  }

  async openProjectAt(projectPathOrRoot: string): Promise<ProjectResult> {
    try {
      let project = await this.projectResources.loadProject(projectPathOrRoot);
      this.session.setCurrentProject(project);
      this.setProjectRoot(project.rootPath);

      // Older projects can persist the selected style id without its renderer
      // snapshot. Restore it before authoring reads the project defaults.
      const templates = project.metadata.templates;
      if (templates) {
        const view = createTemplatePackageView(this.getTemplatePackages(), { enabledTemplateIds: templates.enabledTemplateIds });
        const styleId = templates.defaults?.dialogueStyleId ?? view.defaults.dialogueStyleId;
        const style = view.dialogueStyles.find((candidate) => candidate.id === styleId);
        const needsSnapshot = style?.renderer === 'image-dialogue-v1'
          ? !templates.dialoguePresentation || templates.dialoguePresentation.styleId !== styleId
          : style && (templates.dialoguePresentation || templates.dialogueTemplate !== style.renderer);
        if (needsSnapshot) {
          project = { ...project, metadata: { ...project.metadata, templates: await this.materializeDialoguePresentation(templates) } };
          this.session.setCurrentProject(project);
        }
      }

      const sceneEntry = project.metadata.scenes.find((scene) => scene.id === project.metadata.defaultSceneId)
        ?? project.metadata.scenes[0];
      if (!sceneEntry) {
        return { success: false, error: 'Project contains no registered scenes' };
      }

      const sceneAbsolutePath = await this.resolveScenePath(project.rootPath, sceneEntry.path);
      return {
        success: true,
        project,
        scenePath: sceneAbsolutePath,
      };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  async prepareCollaborationProjectAt(rootPath: string, name = 'AeonStagery Collaboration'): Promise<ProjectResult> {
    try {
      const projectFilePath = await this.fileAccess.join(rootPath, 'project.json');
      if (await this.fileAccess.exists(projectFilePath)) {
        return this.openProjectAt(projectFilePath);
      }

      if (await this.fileAccess.exists(rootPath)) {
        const entries = await this.fileAccess.readDir(rootPath);
        const meaningfulEntries = entries.filter((entry) => !entry.name.startsWith('.'));
        if (meaningfulEntries.length > 0) {
          return {
            success: false,
            error: '请选择空目录，或选择包含 project.json 的 AeonStagery 项目目录',
          };
        }
      }

      return this.createProjectAt(rootPath, name);
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  async updateTemplateConfiguration(templates: ProjectTemplateConfiguration): Promise<ProjectResult> {
    try {
      const currentProject = this.session.getCurrentProject();
      if (!currentProject) {
        return { success: false, error: 'No active project' };
      }

      const materializedTemplates = await this.materializeDialoguePresentation(templates);
      const project = await this.projectResources.saveProjectMetadata(currentProject, {
        ...currentProject.metadata,
        templates: materializedTemplates,
      });
      this.session.setCurrentProject(project);

      const sceneEntry = project.metadata.scenes.find((scene) => scene.id === project.metadata.defaultSceneId)
        ?? project.metadata.scenes[0];
      if (!sceneEntry) {
        return { success: false, error: 'Project contains no registered scenes' };
      }

      return {
        success: true,
        project,
        scenePath: await this.resolveScenePath(project.rootPath, sceneEntry.path),
      };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  async prepareDialogueStyle(styleId: string): Promise<ProjectTemplateConfiguration> {
    const currentProject = this.session.getCurrentProject();
    if (!currentProject) throw new Error('No active project');
    const templates = currentProject.metadata.templates;
    if (!templates) throw new Error('Project has no template configuration');
    return this.materializeDialoguePresentation({
      ...templates,
      defaults: { ...templates.defaults, dialogueStyleId: styleId },
    });
  }

  async updateVoiceGenerationConfiguration(voiceGeneration: ProjectVoiceGenerationConfiguration): Promise<ProjectResult> {
    const save = async (): Promise<ProjectResult> => this.saveVoiceGenerationConfigurationNow(voiceGeneration);
    const queuedSave = this.voiceGenerationSaveQueue.then(save, save);
    this.voiceGenerationSaveQueue = queuedSave.then(() => undefined, () => undefined);
    return queuedSave;
  }

  async updateVoiceProfiles(voiceProfiles: import('../../api/types/project').ProjectVoiceProfile[]): Promise<ProjectResult> {
    try {
      const currentProject = this.session.getCurrentProject();
      if (!currentProject) return { success: false, error: 'No active project' };
      const project = await this.projectResources.saveProjectMetadata(currentProject, {
        ...currentProject.metadata,
        voiceProfiles: JSON.parse(JSON.stringify(voiceProfiles)),
      });
      this.session.setCurrentProject(project);
      const sceneEntry = project.metadata.scenes.find((scene) => scene.id === project.metadata.defaultSceneId) ?? project.metadata.scenes[0];
      return sceneEntry
        ? { success: true, project, scenePath: await this.resolveScenePath(project.rootPath, sceneEntry.path) }
        : { success: false, error: 'Project contains no registered scenes' };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  private async saveVoiceGenerationConfigurationNow(voiceGeneration: ProjectVoiceGenerationConfiguration): Promise<ProjectResult> {
    try {
      const currentProject = this.session.getCurrentProject();
      if (!currentProject) {
        return { success: false, error: 'No active project' };
      }

      const project = await this.projectResources.saveProjectMetadata(currentProject, {
        ...currentProject.metadata,
        voiceGeneration,
      });
      this.session.setCurrentProject(project);

      const sceneEntry = project.metadata.scenes.find((scene) => scene.id === project.metadata.defaultSceneId)
        ?? project.metadata.scenes[0];
      if (!sceneEntry) {
        return { success: false, error: 'Project contains no registered scenes' };
      }

      return {
        success: true,
        project,
        scenePath: await this.resolveScenePath(project.rootPath, sceneEntry.path),
      };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  async prepareTemplateCharacters(templates: ProjectTemplateConfiguration): Promise<SceneCharacter[]> {
    await this.materializeTemplateVoiceProfiles(templates);
    const scene = createTemplateInitializedScene('Template Character Import', {
      templateConfiguration: templates,
      templatePackages: this.getTemplatePackages(),
    });

    if (this.sceneAssets) {
      await importInitialTemplateCharacterAssets(
        scene,
        this.getTemplatePackages(),
        templates,
        this.sceneAssets.importTemplateAssetPath.bind(this.sceneAssets),
        (...parts) => this.fileAccess.join(...parts),
      );
    }

    return scene.meta.characters ?? [];
  }

  private async materializeTemplateVoiceProfiles(templates: ProjectTemplateConfiguration): Promise<void> {
    const packages = this.getTemplatePackages();
    const view = createTemplatePackageView(packages, { enabledTemplateIds: templates.enabledTemplateIds });
    const selectedCharacters = new Set(templates.selectedCharacterPresetIds ?? []);
    const requiredProfileIds = new Set(view.characterPresets
      .filter((character) => selectedCharacters.has(character.id) && character.voiceProfileId)
      .map((character) => character.voiceProfileId!));
    if (requiredProfileIds.size === 0) return;

    const currentProject = this.session.getCurrentProject();
    if (!currentProject) throw new Error('No active project');
    const materialized = [...(currentProject.metadata.voiceProfiles ?? [])];
    for (const profile of view.voiceProfiles.filter((item) => requiredProfileIds.has(item.id))) {
      const references = [] as import('../voice/VoiceAuthoringTypes').ProjectVoiceProfile['references'];
      for (const reference of profile.references) {
        const asset = view.assetEntries.find((item) => item.id === reference.assetId && item.source.templateId === profile.source.templateId);
        if (!asset) throw new Error(`Template voice asset not found: ${reference.assetId}`);
        const sourcePackage = packages.find((item) => item.manifest.template.id === profile.source.templateId && item.source.packageRoot === profile.source.packageRoot);
        if (!sourcePackage) throw new Error(`Template package not found: ${profile.source.templateId}`);
        const assetRoot = sourcePackage.manifest.assets?.root ?? '';
        const sourcePath = await this.fileAccess.join(sourcePackage.source.packageRoot, assetRoot, asset.path);
        const imported = await this.projectResources.importVoiceReference(sourcePath, profile.id, reference.id);
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
      const projectProfile: import('../voice/VoiceAuthoringTypes').ProjectVoiceProfile = {
        id: profile.id,
        name: profile.name,
        gptModel: { ...profile.gptModel },
        sovitsModel: { ...profile.sovitsModel },
        references,
        inferenceDefaults: { ...profile.inferenceDefaults },
      };
      const index = materialized.findIndex((item) => item.id === projectProfile.id);
      if (index >= 0) materialized[index] = projectProfile;
      else materialized.push(projectProfile);
    }
    const result = await this.updateVoiceProfiles(materialized);
    if (!result.success) throw new Error(result.error);
  }

  private async materializeDialoguePresentation(
    templates: ProjectTemplateConfiguration,
  ): Promise<ProjectTemplateConfiguration> {
    const packages = this.getTemplatePackages();
    const view = createTemplatePackageView(packages, { enabledTemplateIds: templates.enabledTemplateIds });
    const styleId = templates.defaults?.dialogueStyleId ?? view.defaults.dialogueStyleId;
    const style = styleId ? view.dialogueStyles.find((candidate) => candidate.id === styleId) : undefined;
    if (!style || style.renderer !== 'image-dialogue-v1' || !style.params) {
      const { dialoguePresentation: _previous, dialogueTemplate: _template, ...rest } = templates;
      const builtinRenderer = style && ['glass', 'minimal', 'classic'].includes(style.renderer)
        ? style.renderer as 'glass' | 'minimal' | 'classic'
        : undefined;
      return { ...rest, ...(builtinRenderer ? { dialogueTemplate: builtinRenderer } : {}) };
    }

    const sourcePackage = packages.find((candidate) => (
      candidate.manifest.template.id === style.source.templateId
      && candidate.source.packageRoot === style.source.packageRoot
    ));
    if (!sourcePackage) throw new Error(`Template package not found: ${style.source.templateId}`);
    const presentation = JSON.parse(JSON.stringify({
      renderer: 'image-dialogue-v1',
      ...style.params,
      styleId: style.id,
    })) as DialogueImagePresentation;
    const assetRoot = sourcePackage.manifest.assets?.root ?? 'assets';

    const materialize = async (reference: string, kind: 'ui' | 'font'): Promise<string> => {
      const sourcePath = await this.fileAccess.join(sourcePackage.source.packageRoot, assetRoot, reference);
      const portable = reference.replace(/\\/g, '/').replace(/^\/+/, '');
      const preferredPath = kind === 'font'
        ? `images/templates/${style.source.templateId}/fonts/${await this.fileAccess.basename(reference)}`
        : `images/templates/${style.source.templateId}/${portable}`;
      const imported = await this.projectResources.materializeFromTrustedRoot(
        sourcePackage.source.packageRoot,
        sourcePath,
        'images',
        preferredPath,
      );
      return imported.relativePath;
    };

    presentation.textbox.image = await materialize(presentation.textbox.image, 'ui');
    if (presentation.namebox) presentation.namebox.image = await materialize(presentation.namebox.image, 'ui');
    if (presentation.text.fontFile) {
      presentation.text.fontFile = await materialize(presentation.text.fontFile, 'font');
    }
    if (presentation.speaker?.fontFile) {
      presentation.speaker.fontFile = await materialize(presentation.speaker.fontFile, 'font');
    }
    const { dialogueTemplate: _builtIn, ...rest } = templates;
    return { ...rest, dialoguePresentation: presentation };
  }

  private async resolveScenePath(rootPath: string, sceneRelativePath: string): Promise<string> {
    return this.fileAccess.join(rootPath, sceneRelativePath);
  }
}
