import {
  authoringComboToComboTemplate,
  parseTemplateAuthoringCombo,
  parseTemplatePackageManifest,
  type LoadedTemplatePackage,
  type SourcedAuthoringCombo,
  type SourcedSemanticAuthoringCombo,
  type SourcedTemplateAssetEntry,
  type SourcedTemplateCharacterPreset,
  type SourcedTemplateDialogueStyle,
  type SourcedTemplateVoiceProfile,
  type SourcedTemplateRecord,
  type SourcedPerformanceProfileDocument,
  type TemplateAuthoringCombo,
  type TemplatePackageManifest,
  type TemplatePackageSourceMetadata,
  type TemplatePackageScope,
  type TemplatePackageSource,
  parseTemplateVoiceProfile,
  templateMetadataMatchesId,
} from './TemplatePackageManifest';
import {
  DEFAULT_PROJECT_TEMPLATE_CONFIGURATION,
  type ProjectTemplateDefaults,
} from '../../api/types/project';
import { ProjectPathResolver } from '../io/ProjectPathResolver';
import {
  materializeInlinePerformanceProfile,
  parsePerformanceProfileDocument,
  PerformanceProfileValidationError,
} from '../ai-authoring/performance/PerformanceProfileValidation';
import {
  PERFORMANCE_PROFILE_SCHEMA_VERSION,
  type PerformanceProfileDocumentV1,
  type PerformanceProfileManifestEntryV1,
} from '../ai-authoring/performance/PerformanceProfileTypes';

export const TEMPLATE_PACKAGE_MANIFEST_FILE = 'manifest.v2.json';

type FileAccessLike = {
  readFile(path: string): Promise<{ data: string; path: string }>;
  join(...parts: string[]): Promise<string>;
  dirname(path: string): Promise<string>;
};

export interface TemplatePackageView {
  packages: LoadedTemplatePackage[];
  defaults: ProjectTemplateDefaults;
  assetEntries: SourcedTemplateAssetEntry[];
  characterPresets: SourcedTemplateCharacterPreset[];
  authoringCombos: SourcedAuthoringCombo[];
  semanticAuthoringCombos: SourcedSemanticAuthoringCombo[];
  dialogueStyles: SourcedTemplateDialogueStyle[];
  voiceProfiles: SourcedTemplateVoiceProfile[];
  performanceProfiles: SourcedPerformanceProfileDocument[];
  visualRecipes: Array<SourcedTemplateRecord<Record<string, unknown>>>;
  sceneBlueprints: Array<SourcedTemplateRecord<Record<string, unknown>>>;
  lightingPresets: Array<SourcedTemplateRecord<Record<string, unknown>>>;
  environmentPresets: Array<SourcedTemplateRecord<Record<string, unknown>>>;
  cameraPresets: Array<SourcedTemplateRecord<Record<string, unknown>>>;
  textLayerStyles: Array<SourcedTemplateRecord<Record<string, unknown>>>;
  audioPresets: Array<SourcedTemplateRecord<Record<string, unknown>>>;
  exportPresets: Array<SourcedTemplateRecord<Record<string, unknown>>>;
}

export interface TemplatePackageViewOptions {
  enabledTemplateIds?: string[];
}

export class TemplatePackageLoader {
  private pathResolver = new ProjectPathResolver();

  constructor(private fileAccess: FileAccessLike) {}

  async loadFromManifestPath(scope: TemplatePackageScope, manifestPath: string): Promise<LoadedTemplatePackage> {
    const raw = await this.fileAccess.readFile(manifestPath);
    const parsedManifest = parseTemplatePackageManifest(JSON.parse(raw.data));
    if (parsedManifest.manifestSchemaVersion !== 2) {
      throw new Error(`Template loader requires manifestSchemaVersion 2: ${manifestPath}`);
    }
    const packageRoot = await this.fileAccess.dirname(raw.path);
    const manifest = await this.loadPackageLocalDefinitions(
      parsedManifest,
      packageRoot,
    );
    return {
      manifest,
      source: {
        scope,
        packageRoot,
        manifestPath: raw.path,
      },
    };
  }

  async loadFromPackageRoot(scope: TemplatePackageScope, packageRoot: string): Promise<LoadedTemplatePackage> {
    return this.loadFromManifestPath(scope, await this.fileAccess.join(packageRoot, TEMPLATE_PACKAGE_MANIFEST_FILE));
  }

  private async loadPackageLocalDefinitions(
    manifest: TemplatePackageManifest,
    packageRoot: string,
  ): Promise<TemplatePackageManifest> {
    const sceneSchemaVersion = manifest.template.compatibility?.sceneSchemaVersion;
    const inheritedSceneSchemaVersion = sceneSchemaVersion === 4 || sceneSchemaVersion === 5
      ? sceneSchemaVersion
      : undefined;
    const authoringCombos = await Promise.all(
      (manifest.authoringCombos ?? []).map((combo) =>
        this.loadAuthoringComboDefinition(combo, packageRoot, manifest.manifestSchemaVersion ?? 1, inheritedSceneSchemaVersion),
      ),
    );
    const voiceProfiles = await Promise.all(
      (manifest.voiceProfiles ?? []).map((profile) => this.loadVoiceProfileDefinition(profile, packageRoot)),
    );
    const performanceProfiles = await Promise.all(
      (manifest.performanceProfiles ?? []).map((profile) => this.loadPerformanceProfileDefinition(profile, packageRoot)),
    );
    const assetIds = new Set((manifest.assets?.index ?? []).map((asset) => asset.id));
    for (const profile of voiceProfiles) {
      for (const reference of profile.references) {
        if (!assetIds.has(reference.assetId)) throw new Error(`Voice profile "${profile.id}" references unknown asset "${reference.assetId}"`);
      }
    }
    const voiceProfileIds = new Set(voiceProfiles.map((profile) => profile.id));
    for (const character of manifest.characterPresets ?? []) {
      if (character.voiceProfileId && !voiceProfileIds.has(character.voiceProfileId)) {
        throw new Error(`Character preset "${character.id}" references unknown voice profile "${character.voiceProfileId}"`);
      }
    }
    return {
      ...manifest,
      authoringCombos,
      voiceProfiles,
      performanceProfiles,
    };
  }

  private async loadPerformanceProfileDefinition(
    entry: PerformanceProfileManifestEntryV1,
    packageRoot: string,
  ): Promise<PerformanceProfileDocumentV1> {
    if (!entry.file) return materializeInlinePerformanceProfile(entry);
    const filePath = await this.fileAccess.join(packageRoot, this.pathResolver.normalizeRelativePath(entry.file));
    const raw = await this.fileAccess.readFile(filePath);
    const fileProfile = JSON.parse(raw.data) as Record<string, unknown>;
    if (fileProfile.schemaVersion !== PERFORMANCE_PROFILE_SCHEMA_VERSION) {
      throw new PerformanceProfileValidationError([{
        code: 'unsupported_schema_version',
        message: `Unsupported performance profile schemaVersion: expected ${PERFORMANCE_PROFILE_SCHEMA_VERSION}`,
        path: 'schemaVersion',
        profileId: entry.id,
      }]);
    }
    return parsePerformanceProfileDocument({
      ...fileProfile,
      schemaVersion: entry.schemaVersion,
      id: entry.id,
      name: entry.name,
    });
  }

  private async loadVoiceProfileDefinition(profile: import('../voice/VoiceAuthoringTypes').TemplateVoiceProfile, packageRoot: string) {
    if (!profile.file) return profile;
    const filePath = await this.fileAccess.join(packageRoot, this.pathResolver.normalizeRelativePath(profile.file));
    const raw = await this.fileAccess.readFile(filePath);
    return parseTemplateVoiceProfile({ ...profile, ...JSON.parse(raw.data), id: profile.id, name: profile.name, file: profile.file }, `voiceProfile file ${profile.file}`);
  }

  private async loadAuthoringComboDefinition(
    combo: TemplateAuthoringCombo,
    packageRoot: string,
    manifestSchemaVersion: TemplatePackageManifest['manifestSchemaVersion'],
    inheritedSceneSchemaVersion?: 4 | 5,
  ): Promise<TemplateAuthoringCombo> {
    if (!combo.file) return combo;

    const filePath = await this.fileAccess.join(packageRoot, this.pathResolver.normalizeRelativePath(combo.file));
    const raw = await this.fileAccess.readFile(filePath);
    const fileCombo = parseTemplateAuthoringCombo({
      ...combo,
      ...JSON.parse(raw.data),
      id: combo.id,
      name: combo.name,
      category: combo.category,
      file: combo.file,
    }, `authoringCombo file ${combo.file}`, manifestSchemaVersion ?? 1, inheritedSceneSchemaVersion);
    if ((manifestSchemaVersion ?? 1) === 2 && !fileCombo.payload) {
      throw new Error(`manifestSchemaVersion 2 authoring combo file ${combo.file} requires payload`);
    }
    return fileCombo;
  }
}

export function createLoadedTemplatePackage(
  manifestInput: unknown,
  source: TemplatePackageSource,
): LoadedTemplatePackage {
  return {
    manifest: parseTemplatePackageManifest(manifestInput),
    source,
  };
}

export function createTemplatePackageView(
  packages: LoadedTemplatePackage[],
  options: TemplatePackageViewOptions = {},
): TemplatePackageView {
  const sortedPackages = selectEnabledPackages(packages, options)
    .sort((a, b) => comparePackagePrecedence(a, b, options));
  return {
    packages: sortedPackages,
    defaults: mergeTemplateDefaults(sortedPackages),
    assetEntries: mergeAssets(sortedPackages),
    characterPresets: mergeCharacterPresets(sortedPackages),
    authoringCombos: mergeAuthoringCombos(sortedPackages),
    semanticAuthoringCombos: mergeSemanticAuthoringCombos(sortedPackages),
    dialogueStyles: mergeDialogueStyles(sortedPackages),
    voiceProfiles: mergeVoiceProfiles(sortedPackages),
    performanceProfiles: mergePerformanceProfiles(sortedPackages),
    visualRecipes: mergeGenericRecords(sortedPackages, (templatePackage) => templatePackage.manifest.visualRecipes),
    sceneBlueprints: mergeGenericRecords(sortedPackages, (templatePackage) => templatePackage.manifest.sceneBlueprints),
    lightingPresets: mergeGenericRecords(sortedPackages, (templatePackage) => templatePackage.manifest.lightingPresets),
    environmentPresets: mergeGenericRecords(sortedPackages, (templatePackage) => templatePackage.manifest.environmentPresets),
    cameraPresets: mergeGenericRecords(sortedPackages, (templatePackage) => templatePackage.manifest.cameraPresets),
    textLayerStyles: mergeGenericRecords(sortedPackages, (templatePackage) => templatePackage.manifest.textLayerStyles),
    audioPresets: mergeGenericRecords(sortedPackages, (templatePackage) => templatePackage.manifest.audioPresets),
    exportPresets: mergeGenericRecords(sortedPackages, (templatePackage) => templatePackage.manifest.exportPresets),
  };
}

function mergeVoiceProfiles(packages: LoadedTemplatePackage[]): SourcedTemplateVoiceProfile[] {
  const byId = new Map<string, SourcedTemplateVoiceProfile>();
  for (const templatePackage of packages) {
    for (const profile of templatePackage.manifest.voiceProfiles ?? []) {
      if (byId.has(profile.id)) continue;
      byId.set(profile.id, { ...profile, source: createSourceMetadata(templatePackage) });
    }
  }
  return [...byId.values()];
}

function mergePerformanceProfiles(packages: LoadedTemplatePackage[]): SourcedPerformanceProfileDocument[] {
  const byId = new Map<string, SourcedPerformanceProfileDocument>();
  packages.forEach((templatePackage, index) => {
    const priority = packages.length - index;
    for (const profile of templatePackage.manifest.performanceProfiles ?? []) {
      if (byId.has(profile.id)) continue;
      byId.set(profile.id, {
        schemaVersion: profile.schemaVersion,
        id: profile.id,
        name: profile.name,
        characters: profile.characters ?? [],
        priority,
        source: createSourceMetadata(templatePackage),
      });
    }
  });
  return [...byId.values()];
}

function selectEnabledPackages(
  packages: LoadedTemplatePackage[],
  options: TemplatePackageViewOptions,
): LoadedTemplatePackage[] {
  if (!options.enabledTemplateIds) return [...packages];
  const enabledIds = new Set(options.enabledTemplateIds);
  return packages.filter((templatePackage) => (
    [...enabledIds].some((id) => templateMetadataMatchesId(templatePackage.manifest.template, id))
  ));
}

export function resolveTemplateDefaults(
  packages: LoadedTemplatePackage[],
  options: TemplatePackageViewOptions = {},
  userDefaults?: ProjectTemplateDefaults,
): ProjectTemplateDefaults {
  return {
    ...(DEFAULT_PROJECT_TEMPLATE_CONFIGURATION.defaults ?? {}),
    ...createTemplatePackageView(packages, options).defaults,
    ...(userDefaults ?? {}),
  };
}

export function createBuiltinTemplatePackage(
  manifest: TemplatePackageManifest | unknown,
  packageRoot = 'templates/default',
): LoadedTemplatePackage {
  return createLoadedTemplatePackage(manifest, {
    scope: 'builtin',
    packageRoot,
    manifestPath: `${packageRoot}/${TEMPLATE_PACKAGE_MANIFEST_FILE}`,
  });
}

function mergeAuthoringCombos(packages: LoadedTemplatePackage[]): SourcedAuthoringCombo[] {
  const byId = new Map<string, SourcedAuthoringCombo>();

  for (const templatePackage of packages) {
    for (const combo of templatePackage.manifest.authoringCombos ?? []) {
      const template = authoringComboToComboTemplate(combo);
      if (!template) continue;
      if (byId.has(template.id)) continue;
      byId.set(template.id, {
        ...template,
        source: createSourceMetadata(templatePackage),
      });
    }
  }

  return [...byId.values()];
}

function mergeSemanticAuthoringCombos(packages: LoadedTemplatePackage[]): SourcedSemanticAuthoringCombo[] {
  const byId = new Map<string, SourcedSemanticAuthoringCombo>();

  for (const templatePackage of packages) {
    for (const combo of templatePackage.manifest.authoringCombos ?? []) {
      if (!combo.payload) continue;
      if (byId.has(combo.id)) continue;
      byId.set(combo.id, {
        ...combo,
        payload: combo.payload,
        source: createSourceMetadata(templatePackage),
      });
    }
  }

  return [...byId.values()];
}

function mergeAssets(packages: LoadedTemplatePackage[]): SourcedTemplateAssetEntry[] {
  const byId = new Map<string, SourcedTemplateAssetEntry>();

  for (const templatePackage of packages) {
    for (const asset of templatePackage.manifest.assets?.index ?? []) {
      if (byId.has(asset.id)) continue;
      byId.set(asset.id, {
        ...asset,
        source: createSourceMetadata(templatePackage),
      });
    }
  }

  return [...byId.values()];
}

function mergeCharacterPresets(packages: LoadedTemplatePackage[]): SourcedTemplateCharacterPreset[] {
  const byId = new Map<string, SourcedTemplateCharacterPreset>();

  for (const templatePackage of packages) {
    for (const preset of templatePackage.manifest.characterPresets ?? []) {
      if (byId.has(preset.id)) continue;
      byId.set(preset.id, {
        ...preset,
        source: createSourceMetadata(templatePackage),
      });
    }
  }

  return [...byId.values()];
}

function mergeDialogueStyles(packages: LoadedTemplatePackage[]): SourcedTemplateDialogueStyle[] {
  const byId = new Map<string, SourcedTemplateDialogueStyle>();

  for (const templatePackage of packages) {
    for (const style of templatePackage.manifest.dialogueStyles ?? []) {
      if (byId.has(style.id)) continue;
      byId.set(style.id, {
        ...style,
        source: createSourceMetadata(templatePackage),
      });
    }
  }

  return [...byId.values()];
}

function mergeTemplateDefaults(packages: LoadedTemplatePackage[]): ProjectTemplateDefaults {
  const defaults: ProjectTemplateDefaults = {};

  for (const templatePackage of packages) {
    const packageDefaults = templatePackage.manifest.defaults;
    if (!packageDefaults) continue;
    for (const [key, value] of Object.entries(packageDefaults) as Array<[keyof ProjectTemplateDefaults, string | undefined]>) {
      if (value !== undefined && defaults[key] === undefined) {
        defaults[key] = value;
      }
    }
  }

  return defaults;
}

function mergeGenericRecords(
  packages: LoadedTemplatePackage[],
  selectRecords: (templatePackage: LoadedTemplatePackage) => Array<Record<string, unknown>> | undefined,
): Array<SourcedTemplateRecord<Record<string, unknown>>> {
  const byId = new Map<string, SourcedTemplateRecord<Record<string, unknown>>>();

  for (const templatePackage of packages) {
    for (const record of selectRecords(templatePackage) ?? []) {
      if (typeof record.id !== 'string' || !record.id) continue;
      if (byId.has(record.id)) continue;
      byId.set(record.id, {
        ...record,
        source: createSourceMetadata(templatePackage),
      });
    }
  }

  return [...byId.values()];
}

function createSourceMetadata(templatePackage: LoadedTemplatePackage): TemplatePackageSourceMetadata {
  return {
    ...templatePackage.source,
    templateId: templatePackage.manifest.template.id,
    templateName: templatePackage.manifest.template.name,
  };
}

function comparePackagePrecedence(
  a: LoadedTemplatePackage,
  b: LoadedTemplatePackage,
  options: TemplatePackageViewOptions,
): number {
  const scopePrecedence = scopeRank(a.source.scope) - scopeRank(b.source.scope);
  if (scopePrecedence !== 0) return scopePrecedence;
  return enabledRank(b, options) - enabledRank(a, options);
}

function enabledRank(templatePackage: LoadedTemplatePackage, options: TemplatePackageViewOptions): number {
  const enabledIds = options.enabledTemplateIds ?? [];
  for (let index = enabledIds.length - 1; index >= 0; index -= 1) {
    if (templateMetadataMatchesId(templatePackage.manifest.template, enabledIds[index])) return index;
  }
  return -1;
}

function scopeRank(scope: TemplatePackageScope): number {
  switch (scope) {
    case 'project':
      return 0;
    case 'user':
      return 1;
    case 'community':
      return 2;
    case 'builtin':
      return 3;
  }
}
