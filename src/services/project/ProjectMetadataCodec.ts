import {
  PROJECT_SCHEMA_VERSION_V2,
  type CharacterVariantImportMode,
  type EmbeddedLibraryMount,
  type ProjectAssetRoots,
  type ProjectGptSovitsVoicePreset,
  type ProjectMetadataV2,
  type ProjectSceneEntry,
  type ProjectTemplateConfiguration,
  type ProjectTemplateDefaults,
  type ProjectVoiceGenerationConfiguration,
  type ProjectWebGalImportReceipt,
} from '../../api/types/project';
import type { ProjectVoiceProfile } from '../voice/VoiceAuthoringTypes';

export class ProjectMetadataCodec {
  parseKnownProjection(input: unknown): ProjectMetadataV2 {
    if (!isRecord(input)) {
      throw new Error('Expected object at project metadata');
    }

    if (input.projectVersion !== PROJECT_SCHEMA_VERSION_V2) {
      throw new Error(
        `Expected project metadata schema version ${PROJECT_SCHEMA_VERSION_V2}, received ${describeValue(input.projectVersion)}`,
      );
    }

    if (typeof input.projectId !== 'string' || !input.projectId.trim()) {
      throw new Error('Expected non-empty string at project.projectId');
    }

    if (typeof input.name !== 'string') {
      throw new Error('Expected string at project.name');
    }

    if (typeof input.createdAt !== 'string' || !input.createdAt.trim()) {
      throw new Error('Expected non-empty string at project.createdAt');
    }

    if (typeof input.updatedAt !== 'string' || !input.updatedAt.trim()) {
      throw new Error('Expected non-empty string at project.updatedAt');
    }

    if (typeof input.defaultSceneId !== 'string' || !input.defaultSceneId.trim()) {
      throw new Error('Expected non-empty string at project.defaultSceneId');
    }

    const scenes = parseScenes(input.scenes);
    const assetRoots = parseAssetRoots(input.assetRoots);
    const embeddedLibraryMounts = parseEmbeddedLibraryMounts(input.embeddedLibraryMounts);
    const templates = parseTemplates(input.templates);
    const voiceGeneration = parseVoiceGeneration(input.voiceGeneration);
    const voiceProfiles = parseVoiceProfiles(input.voiceProfiles);
    const webGalImport = parseWebGalImport(input.webGalImport);

    return Object.freeze({
      projectId: input.projectId,
      name: input.name,
      projectVersion: PROJECT_SCHEMA_VERSION_V2,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      defaultSceneId: input.defaultSceneId,
      scenes,
      assetRoots,
      ...(embeddedLibraryMounts !== undefined ? { embeddedLibraryMounts } : {}),
      ...(templates !== undefined ? { templates } : {}),
      ...(voiceGeneration !== undefined ? { voiceGeneration } : {}),
      ...(voiceProfiles !== undefined ? { voiceProfiles } : {}),
      ...(webGalImport !== undefined ? { webGalImport } : {}),
    });
  }
}

function parseEmbeddedLibraryMounts(input: unknown): EmbeddedLibraryMount[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) {
    throw new Error('Expected array at project.embeddedLibraryMounts');
  }

  const mountIds = new Set<string>();
  const mounts = input.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Expected object at project.embeddedLibraryMounts[${index}]`);
    }
    if (typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id)) {
      throw new Error(`Expected valid mount id at project.embeddedLibraryMounts[${index}].id`);
    }
    if (mountIds.has(item.id)) {
      throw new Error(`Expected unique mount id at project.embeddedLibraryMounts[${index}].id`);
    }
    if (typeof item.path !== 'string') {
      throw new Error(`Expected string at project.embeddedLibraryMounts[${index}].path`);
    }
    mountIds.add(item.id);
    return Object.freeze({
      id: item.id,
      path: parseContainedRelativePath(item.path, `project.embeddedLibraryMounts[${index}].path`),
    });
  });

  return Object.freeze(mounts) as unknown as EmbeddedLibraryMount[];
}

function parseContainedRelativePath(input: string, location: string): string {
  const normalized = input.replace(/\\/g, '/').trim();
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized) || /^(https?:|asset:|file:)/i.test(normalized)) {
    throw new Error(`Expected project-relative path at ${location}`);
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Expected contained project-relative path at ${location}`);
  }
  return segments.join('/');
}

export const projectMetadataCodec = new ProjectMetadataCodec();

function parseScenes(input: unknown): ProjectSceneEntry[] {
  if (!Array.isArray(input)) {
    throw new Error('Expected array at project.scenes');
  }

  return input.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Expected object at project.scenes[${index}]`);
    }
    if (typeof item.id !== 'string' || !item.id.trim()) {
      throw new Error(`Expected non-empty string at project.scenes[${index}].id`);
    }
    if (typeof item.name !== 'string') {
      throw new Error(`Expected string at project.scenes[${index}].name`);
    }
    if (typeof item.path !== 'string' || !item.path.trim()) {
      throw new Error(`Expected non-empty string at project.scenes[${index}].path`);
    }
    return Object.freeze({
      id: item.id,
      name: item.name,
      path: item.path,
    });
  });
}

function parseAssetRoots(input: unknown): ProjectAssetRoots {
  if (!isRecord(input)) {
    throw new Error('Expected object at project.assetRoots');
  }

  const requiredKeys: Array<keyof ProjectAssetRoots> = [
    'figure',
    'background',
    'bgm',
    'vocal',
    'images',
    'animation',
    'project',
    'template',
  ];

  const result: Partial<ProjectAssetRoots> = {};
  for (const key of requiredKeys) {
    if (typeof input[key] !== 'string' || !input[key].trim()) {
      throw new Error(`Expected non-empty string at project.assetRoots.${key}`);
    }
    result[key] = input[key];
  }

  return Object.freeze(result as ProjectAssetRoots);
}

function parseTemplates(input: unknown): ProjectTemplateConfiguration | undefined {
  if (input === undefined || input === null) return undefined;
  if (!isRecord(input)) {
    throw new Error('Expected object at project.templates');
  }

  if (!Array.isArray(input.enabledTemplateIds) || !input.enabledTemplateIds.every((id) => typeof id === 'string')) {
    throw new Error('Expected string array at project.templates.enabledTemplateIds');
  }

  let defaults: ProjectTemplateDefaults | undefined;
  if (input.defaults !== undefined && input.defaults !== null) {
    if (!isRecord(input.defaults)) {
      throw new Error('Expected object at project.templates.defaults');
    }
    const defaultKeys = [
      'dialogueStyleId',
      'lightingPresetId',
      'environmentPresetId',
      'cameraPresetId',
      'textLayerStyleId',
      'audioPresetId',
      'exportPresetId',
    ] as const;
    const defaultsObj: Record<string, string | undefined> = {};
    for (const key of defaultKeys) {
      if (input.defaults[key] !== undefined) {
        if (typeof input.defaults[key] !== 'string') {
          throw new Error(`Expected string at project.templates.defaults.${key}`);
        }
        defaultsObj[key] = input.defaults[key];
      }
    }
    defaults = Object.freeze(defaultsObj);
  }

  let selectedCharacterPresetIds: readonly string[] | undefined;
  if (input.selectedCharacterPresetIds !== undefined && input.selectedCharacterPresetIds !== null) {
    if (!Array.isArray(input.selectedCharacterPresetIds) || !input.selectedCharacterPresetIds.every((id) => typeof id === 'string')) {
      throw new Error('Expected string array at project.templates.selectedCharacterPresetIds');
    }
    selectedCharacterPresetIds = Object.freeze([...input.selectedCharacterPresetIds]);
  }

  let characterVariantImportMode: CharacterVariantImportMode | undefined;
  if (input.characterVariantImportMode === 'all' || input.characterVariantImportMode === 'primary-only') {
    characterVariantImportMode = input.characterVariantImportMode;
  }

  const dialogueTemplate = (input.dialogueTemplate === 'glass' || input.dialogueTemplate === 'minimal' || input.dialogueTemplate === 'classic')
    ? input.dialogueTemplate
    : undefined;

  const dialoguePresentation = input.dialoguePresentation && isRecord(input.dialoguePresentation)
    ? (cloneJson(input.dialoguePresentation) as any)
    : undefined;

  return Object.freeze({
    enabledTemplateIds: Object.freeze([...input.enabledTemplateIds]) as unknown as string[],
    defaults,
    selectedCharacterPresetIds: (selectedCharacterPresetIds ? Object.freeze([...selectedCharacterPresetIds]) : Object.freeze([])) as unknown as string[],
    ...(characterVariantImportMode !== undefined ? { characterVariantImportMode } : {}),
    ...(dialogueTemplate !== undefined ? { dialogueTemplate } : {}),
    ...(dialoguePresentation !== undefined ? { dialoguePresentation } : {}),
  });
}

function parseVoiceGeneration(input: unknown): ProjectVoiceGenerationConfiguration | undefined {
  if (input === undefined || input === null) return undefined;
  if (!isRecord(input)) {
    throw new Error('Expected object at project.voiceGeneration');
  }

  let gptSovits: ProjectVoiceGenerationConfiguration['gptSovits'];
  if (input.gptSovits !== undefined && input.gptSovits !== null) {
    if (!isRecord(input.gptSovits)) {
      throw new Error('Expected object at project.voiceGeneration.gptSovits');
    }
    if (input.gptSovits.selectedPresetId !== undefined && typeof input.gptSovits.selectedPresetId !== 'string') {
      throw new Error('Expected string at project.voiceGeneration.gptSovits.selectedPresetId');
    }
    if (!Array.isArray(input.gptSovits.presets)) {
      throw new Error('Expected array at project.voiceGeneration.gptSovits.presets');
    }
    const presets: ProjectGptSovitsVoicePreset[] = input.gptSovits.presets.map((preset, index) => {
      if (!isRecord(preset)) {
        throw new Error(`Expected object at project.voiceGeneration.gptSovits.presets[${index}]`);
      }
      if (typeof preset.id !== 'string' || !preset.id.trim()) {
        throw new Error(`Expected non-empty string at project.voiceGeneration.gptSovits.presets[${index}].id`);
      }
      if (typeof preset.name !== 'string') {
        throw new Error(`Expected string at project.voiceGeneration.gptSovits.presets[${index}].name`);
      }
      return Object.freeze({
        id: preset.id,
        name: preset.name,
        gptWeightsPath: typeof preset.gptWeightsPath === 'string' ? preset.gptWeightsPath : '',
        sovitsWeightsPath: typeof preset.sovitsWeightsPath === 'string' ? preset.sovitsWeightsPath : '',
        refAudioPath: typeof preset.refAudioPath === 'string' ? preset.refAudioPath : '',
        promptText: typeof preset.promptText === 'string' ? preset.promptText : '',
        promptLang: typeof preset.promptLang === 'string' ? preset.promptLang : 'zh',
        textLang: typeof preset.textLang === 'string' ? preset.textLang : 'zh',
        speed: typeof preset.speed === 'number' && Number.isFinite(preset.speed) ? preset.speed : 1,
      });
    });
    gptSovits = Object.freeze({
      selectedPresetId: input.gptSovits.selectedPresetId,
      presets: Object.freeze(presets) as unknown as ProjectGptSovitsVoicePreset[],
    });
  }

  return Object.freeze({
    ...(gptSovits !== undefined ? { gptSovits } : {}),
  });
}

function parseVoiceProfiles(input: unknown): ProjectVoiceProfile[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) {
    throw new Error('Expected array at project.voiceProfiles');
  }

  return Object.freeze(input.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Expected object at project.voiceProfiles[${index}]`);
    }
    if (typeof item.id !== 'string' || !item.id.trim()) {
      throw new Error(`Expected non-empty string at project.voiceProfiles[${index}].id`);
    }
    if (typeof item.name !== 'string') {
      throw new Error(`Expected string at project.voiceProfiles[${index}].name`);
    }
    return Object.freeze(cloneJson(item) as unknown as ProjectVoiceProfile);
  })) as unknown as ProjectVoiceProfile[];
}

function parseWebGalImport(input: unknown): ProjectWebGalImportReceipt | undefined {
  if (input === undefined || input === null) return undefined;
  if (!isRecord(input)) {
    throw new Error('Expected object at project.webGalImport');
  }
  if (typeof input.scriptName !== 'string') {
    throw new Error('Expected string at project.webGalImport.scriptName');
  }
  if (input.scriptNames !== undefined && (!Array.isArray(input.scriptNames) || !input.scriptNames.every((name) => typeof name === 'string'))) {
    throw new Error('Expected string array at project.webGalImport.scriptNames');
  }
  if (typeof input.scriptText !== 'string') {
    throw new Error('Expected string at project.webGalImport.scriptText');
  }
  if (typeof input.sceneTitle !== 'string') {
    throw new Error('Expected string at project.webGalImport.sceneTitle');
  }
  if (typeof input.scenePath !== 'string') {
    throw new Error('Expected string at project.webGalImport.scenePath');
  }
  if (typeof input.generatedAt !== 'string') {
    throw new Error('Expected string at project.webGalImport.generatedAt');
  }
  if (typeof input.speed !== 'number' || !Number.isFinite(input.speed)) {
    throw new Error('Expected finite number at project.webGalImport.speed');
  }

  return Object.freeze({
    scriptName: input.scriptName,
    ...(Array.isArray(input.scriptNames) ? { scriptNames: [...input.scriptNames] } : {}),
    scriptText: input.scriptText,
    mountId: typeof input.mountId === 'string' ? input.mountId : undefined,
    speed: input.speed,
    sceneTitle: input.sceneTitle,
    scenePath: input.scenePath,
    generatedAt: input.generatedAt,
    ...(input.report ? { report: cloneJson(input.report) as any } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return undefined as unknown as T;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return undefined as unknown as T;
  return JSON.parse(serialized) as T;
}

function describeValue(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}
