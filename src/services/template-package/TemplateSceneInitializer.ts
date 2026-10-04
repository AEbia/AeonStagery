import type {
  CharacterVariantImportMode,
  ProjectTemplateConfiguration,
} from '../../api/types/project';
import type { CurrentSceneDocument, SceneSchemaVersion } from '../../api/types/semantic-scene';
import { SCENE_SCHEMA_VERSION } from '../../api/types/semantic-scene';
import type { SceneMeta } from '../../api/types/scene-common';
import type { ResourceImportKind } from '../../api/types/project';
import {
  createTemplatePackageView,
} from './TemplatePackageLoader';
import type {
  LoadedTemplatePackage,
  SourcedTemplateCharacterPreset,
} from './TemplatePackageManifest';

type SceneCharacter = NonNullable<SceneMeta['characters']>[number];

export function createTemplateInitializedScene(
  title: string,
  options: {
    templateConfiguration?: ProjectTemplateConfiguration;
    templatePackages?: LoadedTemplatePackage[];
    schemaVersion?: SceneSchemaVersion;
  } = {},
): CurrentSceneDocument {
  return {
    schemaVersion: (options.schemaVersion ?? SCENE_SCHEMA_VERSION) as any,
    sceneId: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    meta: {
      title,
      fps: 60,
      resolution: [1920, 1080],
      characters: createInitialCharactersFromTemplates(
        options.templatePackages ?? [],
        options.templateConfiguration,
      ),
      markers: [],
    },
    statements: [],
  };
}

export function createInitialCharactersFromTemplates(
  templatePackages: LoadedTemplatePackage[],
  templateConfiguration?: ProjectTemplateConfiguration,
): SceneCharacter[] {
  const selectedIds = templateConfiguration?.selectedCharacterPresetIds ?? [];
  if (selectedIds.length === 0 || templatePackages.length === 0) return [];

  const view = createTemplatePackageView(templatePackages, {
    enabledTemplateIds: templateConfiguration?.enabledTemplateIds,
  });
  const presetsById = new Map(view.characterPresets.map((preset) => [preset.id, preset]));
  const usedIds = new Set<string>();

  return selectedIds.flatMap((presetId) => {
    const preset = presetsById.get(presetId);
    if (!preset) return [];
    const character = characterPresetToSceneCharacter(
      preset,
      usedIds,
      resolveCharacterVariantImportMode(templateConfiguration),
    );
    usedIds.add(character.id);
    return [character];
  });
}

export async function importInitialTemplateCharacterAssets(
  scene: CurrentSceneDocument,
  templatePackages: LoadedTemplatePackage[],
  templateConfiguration: ProjectTemplateConfiguration | undefined,
  importTemplateAssetPath: (
    sourcePath: string,
    trustedRoot: string,
    kind: ResourceImportKind,
  ) => Promise<string>,
  joinPath: (...parts: string[]) => Promise<string>,
): Promise<CurrentSceneDocument> {
  const selectedIds = templateConfiguration?.selectedCharacterPresetIds ?? [];
  if (selectedIds.length === 0 || templatePackages.length === 0) return scene;

  const view = createTemplatePackageView(templatePackages, {
    enabledTemplateIds: templateConfiguration?.enabledTemplateIds,
  });
  const presetsById = new Map(view.characterPresets.map((preset) => [preset.id, preset]));
  const sourceByModel = new Map<string, { sourcePath: string; packageRoot: string }>();

  for (const presetId of selectedIds) {
    const preset = presetsById.get(presetId);
    if (!preset) continue;
    for (const model of collectPresetModelPaths(
      preset,
      resolveCharacterVariantImportMode(templateConfiguration),
    )) {
      sourceByModel.set(model, {
        sourcePath: await resolveTemplateSourcePath(preset.source.packageRoot, model, joinPath),
        packageRoot: preset.source.packageRoot,
      });
    }
  }

  if (sourceByModel.size === 0) return scene;

  const importedByModel = new Map<string, string>();
  for (const [model, source] of sourceByModel) {
    importedByModel.set(model, await importTemplateAssetPath(
      source.sourcePath,
      source.packageRoot,
      'figure',
    ));
  }

  for (const character of scene.meta.characters ?? []) {
    if (character.model && importedByModel.has(character.model)) {
      character.model = importedByModel.get(character.model);
    }
    for (const variant of character.variants ?? []) {
      if (variant.model && importedByModel.has(variant.model)) {
        variant.model = importedByModel.get(variant.model)!;
      }
    }
  }

  return scene;
}

function characterPresetToSceneCharacter(
  preset: SourcedTemplateCharacterPreset,
  usedIds: Set<string>,
  variantImportMode: CharacterVariantImportMode,
): SceneCharacter {
  const allVariants = preset.variants ?? [];
  const variants = variantImportMode === 'all' ? allVariants : [];
  const primaryModel = preset.model ?? allVariants[0]?.model ?? '';
  const character: SceneCharacter = {
    id: uniqueCharacterId(preset.id, usedIds),
    name: preset.name,
    model: primaryModel,
  };

  if (preset.speakerColor) {
    character.color = preset.speakerColor;
  }
  if (preset.voiceProfileId) character.voiceProfileId = preset.voiceProfileId;

  if (variants.length > 0) {
    character.variants = variants.map((variant) => ({
      name: variant.name,
      model: variant.model,
    }));
  }

  return character;
}

function uniqueCharacterId(baseId: string, usedIds: Set<string>): string {
  const cleanBase = baseId.trim() || 'character';
  if (!usedIds.has(cleanBase)) return cleanBase;

  let index = 2;
  while (usedIds.has(`${cleanBase}_${index}`)) {
    index += 1;
  }
  return `${cleanBase}_${index}`;
}

function collectPresetModelPaths(
  preset: SourcedTemplateCharacterPreset,
  variantImportMode: CharacterVariantImportMode,
): string[] {
  const models = new Set<string>();
  const primaryModel = preset.model ?? preset.variants?.[0]?.model;
  if (primaryModel) models.add(primaryModel);
  if (variantImportMode === 'all') {
    for (const variant of preset.variants ?? []) {
      if (variant.model) models.add(variant.model);
    }
  }
  return [...models];
}

function resolveCharacterVariantImportMode(
  templateConfiguration?: ProjectTemplateConfiguration,
): CharacterVariantImportMode {
  return templateConfiguration?.characterVariantImportMode === 'all' ? 'all' : 'primary-only';
}

async function resolveTemplateSourcePath(
  packageRoot: string,
  modelPath: string,
  joinPath: (...parts: string[]) => Promise<string>,
): Promise<string> {
  const normalized = modelPath.replace(/\\/g, '/');
  if (
    normalized.startsWith('asset://') ||
    normalized.startsWith('file://') ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.startsWith('/')
  ) {
    return normalized;
  }
  return joinPath(packageRoot, normalized);
}
