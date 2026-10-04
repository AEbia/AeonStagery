import type { ProjectTemplateDefaults } from '../../api/types/project';
import type { TemplateVoiceProfile } from '../voice/VoiceAuthoringTypes';
import {
  SCENE_SCHEMA_VERSION_V5,
} from '../../api/types/semantic-scene';
import { sceneStatementDefinitionRegistry } from '../semantic-scene';
import { RESOURCE_KINDS, type ResourceKind } from '../resource-authoring/ResourceAuthoringTypes';
import { parseDialogueImagePresentation } from '../semantic-scene/SceneStatementDefinitionRegistry';
import { parsePerformanceProfileManifestEntry } from '../ai-authoring/performance/PerformanceProfileValidation';
import type { PerformanceProfileDocumentV1, PerformanceProfileManifestEntryV1 } from '../ai-authoring/performance/PerformanceProfileTypes';

export const TEMPLATE_PACKAGE_SCHEMA_VERSION = 2 as const;
export type TemplatePackageScope = 'builtin' | 'user' | 'project' | 'community';
export type TemplateManifestSchemaVersion = 1 | 2;
export type LegacyTemplateActionName = string;

export type AuthoringDefinitionCategory =
  | 'dialogue'
  | 'character'
  | 'camera'
  | 'environment'
  | 'media';

export interface ComboTemplate {
  id: string;
  name: string;
  category: AuthoringDefinitionCategory;
  actions: Array<{ action: LegacyTemplateActionName; params: Record<string, any>; delay: number }>;
  source?: {
    scope: TemplatePackageScope;
    templateId: string;
    templateName: string;
  };
}

export interface TemplatePackageMetadata {
  id: string;
  /** Previous package ids accepted when opening projects created before a package rename. */
  aliases?: string[];
  name: string;
  version: string;
  category?: string;
  author?: string;
  description?: string;
  tags?: string[];
  compatibility?: Record<string, unknown>;
}

export interface TemplatePackageAssets {
  root?: string;
  index?: TemplateAssetEntry[];
}

export interface TemplateResourceConvention {
  patterns: string[];
  entrypoints?: string[];
  extensions?: string[];
}

export type TemplateResourceConventions = Partial<Record<ResourceKind, TemplateResourceConvention>>;

export interface TemplateAssetEntry {
  id: string;
  path: string;
  kind?: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface TemplateCharacterVariant {
  id: string;
  name: string;
  model: string;
  runtime?: string;
  metadata?: Record<string, unknown>;
}

export interface TemplateCharacterPreset {
  id: string;
  name: string;
  file?: string;
  model?: string;
  variants?: TemplateCharacterVariant[];
  speakerColor?: string;
  voiceProfileId?: string;
  defaultTransform?: {
    position?: [number, number];
    scale?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface TemplateAuthoringComboAction {
  action: LegacyTemplateActionName;
  params?: Record<string, unknown>;
  delay?: number;
}

export type TemplateAuthoringComboPayload =
  | {
      kind: 'statementPreset';
      statement: Record<string, unknown>;
      sceneSchemaVersion?: 4 | 5;
    }
  | {
      kind: 'dialoguePreset';
      dialogue: Record<string, unknown>;
      companions?: Record<string, unknown>[];
      sceneSchemaVersion?: 4 | 5;
    }
  | {
      kind: 'timelineFragment';
      statements: Record<string, unknown>[];
      sceneSchemaVersion?: 4 | 5;
    };

export interface TemplateAuthoringCombo {
  id: string;
  name: string;
  category: AuthoringDefinitionCategory;
  file?: string;
  actions?: TemplateAuthoringComboAction[];
  payload?: TemplateAuthoringComboPayload;
}

export interface TemplateDialogueStyle {
  id: string;
  name: string;
  renderer: string;
  params?: Record<string, unknown>;
}

export interface TemplatePackageManifest {
  manifestSchemaVersion?: TemplateManifestSchemaVersion;
  template: TemplatePackageMetadata;
  assets?: TemplatePackageAssets;
  resourceConventions?: TemplateResourceConventions;
  defaults?: ProjectTemplateDefaults;
  characterPresets?: TemplateCharacterPreset[];
  authoringCombos?: TemplateAuthoringCombo[];
  dialogueStyles?: TemplateDialogueStyle[];
  voiceProfiles?: TemplateVoiceProfile[];
  performanceProfiles?: PerformanceProfileManifestEntryV1[];
  visualRecipes?: Array<Record<string, unknown>>;
  sceneBlueprints?: Array<Record<string, unknown>>;
  lightingPresets?: Array<Record<string, unknown>>;
  environmentPresets?: Array<Record<string, unknown>>;
  cameraPresets?: Array<Record<string, unknown>>;
  textLayerStyles?: Array<Record<string, unknown>>;
  audioPresets?: Array<Record<string, unknown>>;
  exportPresets?: Array<Record<string, unknown>>;
}

export interface TemplatePackageSource {
  scope: TemplatePackageScope;
  packageRoot: string;
  manifestPath?: string;
}

export interface LoadedTemplatePackage {
  manifest: TemplatePackageManifest;
  source: TemplatePackageSource;
}

export interface SourcedAuthoringCombo extends ComboTemplate {
  source: TemplatePackageSource & { templateId: string; templateName: string };
}

export type SourcedSemanticAuthoringCombo = TemplateAuthoringCombo & {
  payload: TemplateAuthoringComboPayload;
  source: TemplatePackageSource & { templateId: string; templateName: string };
};

export type TemplatePackageSourceMetadata = TemplatePackageSource & {
  templateId: string;
  templateName: string;
};

export type SourcedTemplateRecord<T extends Record<string, unknown>> = T & {
  source: TemplatePackageSourceMetadata;
};

export type SourcedTemplateCharacterPreset = TemplateCharacterPreset & {
  source: TemplatePackageSourceMetadata;
};

export type SourcedTemplateDialogueStyle = TemplateDialogueStyle & {
  source: TemplatePackageSourceMetadata;
};

export type SourcedTemplateAssetEntry = TemplateAssetEntry & {
  source: TemplatePackageSourceMetadata;
};

export type SourcedTemplateVoiceProfile = TemplateVoiceProfile & {
  source: TemplatePackageSourceMetadata;
};

export type SourcedPerformanceProfileDocument = PerformanceProfileDocumentV1 & {
  source: TemplatePackageSourceMetadata;
  /** Explicit provider priority (higher wins) derived from package precedence order. */
  readonly priority: number;
};

const AUTHORING_CATEGORIES = new Set<AuthoringDefinitionCategory>([
  'dialogue',
  'character',
  'camera',
  'environment',
  'media',
]);

export function parseTemplatePackageManifest(input: unknown): TemplatePackageManifest {
  const manifest = expectRecord(input, 'manifest');
  const template = expectRecord(manifest.template, 'template');
  const manifestSchemaVersion = optionalManifestSchemaVersion(manifest.manifestSchemaVersion);
  const compatibility = optionalRecord(template.compatibility, 'template.compatibility');
  validateTemplateCompatibility(manifestSchemaVersion, compatibility);
  const parsed: TemplatePackageManifest = {
    manifestSchemaVersion,
    template: {
      id: expectString(template.id, 'template.id'),
      aliases: optionalStringArray(template.aliases, 'template.aliases'),
      name: expectString(template.name, 'template.name'),
      version: expectString(template.version, 'template.version'),
      category: optionalString(template.category, 'template.category'),
      author: optionalString(template.author, 'template.author'),
      description: optionalString(template.description, 'template.description'),
      tags: optionalStringArray(template.tags, 'template.tags'),
      compatibility,
    },
  };

  if (manifest.assets !== undefined) {
    const assets = expectRecord(manifest.assets, 'assets');
    parsed.assets = {
      root: optionalString(assets.root, 'assets.root'),
      index: optionalAssetIndex(assets.index),
    };
  }
  parsed.resourceConventions = parseResourceConventions(manifest.resourceConventions);

  parsed.defaults = parseTemplateDefaults(manifest.defaults);
  parsed.characterPresets = optionalArray(manifest.characterPresets, 'characterPresets').map(parseCharacterPreset);
  parsed.authoringCombos = optionalArray(manifest.authoringCombos, 'authoringCombos')
    .map((combo, index) => parseAuthoringCombo(combo, index, manifestSchemaVersion));
  parsed.dialogueStyles = optionalArray(manifest.dialogueStyles, 'dialogueStyles').map(parseDialogueStyle);
  parsed.voiceProfiles = optionalArray(manifest.voiceProfiles, 'voiceProfiles').map((profile, index) => parseTemplateVoiceProfile(profile, `voiceProfiles[${index}]`));
  parsed.performanceProfiles = parsePerformanceProfileManifestEntries(manifest.performanceProfiles);
  parsed.visualRecipes = optionalRecordArray(manifest.visualRecipes, 'visualRecipes');
  parsed.sceneBlueprints = optionalRecordArray(manifest.sceneBlueprints, 'sceneBlueprints');
  parsed.lightingPresets = optionalRecordArray(manifest.lightingPresets, 'lightingPresets');
  parsed.environmentPresets = optionalRecordArray(manifest.environmentPresets, 'environmentPresets');
  parsed.cameraPresets = optionalRecordArray(manifest.cameraPresets, 'cameraPresets');
  parsed.textLayerStyles = optionalRecordArray(manifest.textLayerStyles, 'textLayerStyles');
  parsed.audioPresets = optionalRecordArray(manifest.audioPresets, 'audioPresets');
  parsed.exportPresets = optionalRecordArray(manifest.exportPresets, 'exportPresets');

  return parsed;
}

export function templateMetadataMatchesId(metadata: TemplatePackageMetadata, id: string): boolean {
  return metadata.id === id || (metadata.aliases ?? []).includes(id);
}

function parseTemplateDefaults(input: unknown): ProjectTemplateDefaults | undefined {
  if (input === undefined) return undefined;
  const defaults = expectRecord(input, 'defaults');
  return {
    dialogueStyleId: optionalString(defaults.dialogueStyleId, 'defaults.dialogueStyleId'),
    lightingPresetId: optionalString(defaults.lightingPresetId, 'defaults.lightingPresetId'),
    environmentPresetId: optionalString(defaults.environmentPresetId, 'defaults.environmentPresetId'),
    cameraPresetId: optionalString(defaults.cameraPresetId, 'defaults.cameraPresetId'),
    textLayerStyleId: optionalString(defaults.textLayerStyleId, 'defaults.textLayerStyleId'),
    audioPresetId: optionalString(defaults.audioPresetId, 'defaults.audioPresetId'),
    exportPresetId: optionalString(defaults.exportPresetId, 'defaults.exportPresetId'),
  };
}

export function parseTemplateAuthoringCombo(
  input: unknown,
  path = 'authoringCombo',
  manifestSchemaVersion: TemplateManifestSchemaVersion = 1,
): TemplateAuthoringCombo {
  return parseAuthoringCombo(input, path, manifestSchemaVersion);
}

export function authoringComboToComboTemplate(combo: TemplateAuthoringCombo): ComboTemplate | null {
  if (!combo.actions || combo.actions.length === 0) return null;
  return {
    id: combo.id,
    name: combo.name,
    category: combo.category,
    actions: combo.actions.map((action) => ({
      action: action.action,
      params: { ...(action.params ?? {}) },
      delay: action.delay ?? 0,
    })),
  };
}

function parseCharacterPreset(input: unknown, index: number): TemplateCharacterPreset {
  const preset = expectRecord(input, `characterPresets[${index}]`);
  const defaultTransform = optionalRecord(preset.defaultTransform, `characterPresets[${index}].defaultTransform`);
  return {
    id: expectString(preset.id, `characterPresets[${index}].id`),
    name: expectString(preset.name, `characterPresets[${index}].name`),
    file: optionalString(preset.file, `characterPresets[${index}].file`),
    model: optionalString(preset.model, `characterPresets[${index}].model`),
    variants: optionalArray(preset.variants, `characterPresets[${index}].variants`).map((variant, variantIndex) =>
      parseCharacterVariant(variant, index, variantIndex),
    ),
    speakerColor: optionalString(preset.speakerColor, `characterPresets[${index}].speakerColor`),
    voiceProfileId: optionalString(preset.voiceProfileId, `characterPresets[${index}].voiceProfileId`),
    defaultTransform: defaultTransform ? {
      position: optionalPosition(defaultTransform.position, `characterPresets[${index}].defaultTransform.position`),
      scale: optionalNumber(defaultTransform.scale, `characterPresets[${index}].defaultTransform.scale`),
    } : undefined,
    metadata: optionalRecord(preset.metadata, `characterPresets[${index}].metadata`),
  };
}

function parsePerformanceProfileManifestEntries(
  input: unknown,
): PerformanceProfileManifestEntryV1[] | undefined {
  if (input === undefined) return undefined;
  return optionalArray(input, 'performanceProfiles').map((item, index) => {
    const entry = parsePerformanceProfileManifestEntry(item);
    const file = entry.file;
    if (file !== undefined && (file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file) || file.split(/[\\/]/).includes('..'))) {
      throw new Error(`Performance profile file must stay inside the template package at performanceProfiles[${index}].file`);
    }
    return entry;
  });
}

export function parseTemplateVoiceProfile(input: unknown, path = 'voiceProfile'): TemplateVoiceProfile {
  const profile = expectRecord(input, path);
  const file = optionalString(profile.file, `${path}.file`);
  if (file && profile.gptModel === undefined && profile.sovitsModel === undefined && profile.inferenceDefaults === undefined) {
    return {
      id: expectString(profile.id, `${path}.id`),
      name: expectString(profile.name, `${path}.name`),
      file,
      gptModel: { fileName: '__package_local__' },
      sovitsModel: { fileName: '__package_local__' },
      references: [],
      inferenceDefaults: { textLang: 'auto', speed: 1 },
    };
  }
  const gptModel = expectRecord(profile.gptModel, `${path}.gptModel`);
  const sovitsModel = expectRecord(profile.sovitsModel, `${path}.sovitsModel`);
  const defaults = expectRecord(profile.inferenceDefaults, `${path}.inferenceDefaults`);
  return {
    id: expectString(profile.id, `${path}.id`),
    name: expectString(profile.name, `${path}.name`),
    file,
    gptModel: {
      fileName: expectString(gptModel.fileName, `${path}.gptModel.fileName`),
      relativePathSuffix: optionalString(gptModel.relativePathSuffix, `${path}.gptModel.relativePathSuffix`),
    },
    sovitsModel: {
      fileName: expectString(sovitsModel.fileName, `${path}.sovitsModel.fileName`),
      relativePathSuffix: optionalString(sovitsModel.relativePathSuffix, `${path}.sovitsModel.relativePathSuffix`),
    },
    references: optionalArray(profile.references, `${path}.references`).map((item, index) => {
      const referencePath = `${path}.references[${index}]`;
      const reference = expectRecord(item, referencePath);
      const role = expectString(reference.role, `${referencePath}.role`);
      if (role !== 'primary' && role !== 'auxiliary') throw new Error(`Invalid voice reference role at ${referencePath}.role`);
      return {
        id: expectString(reference.id, `${referencePath}.id`),
        label: expectString(reference.label, `${referencePath}.label`),
        assetId: expectString(reference.assetId, `${referencePath}.assetId`),
        role,
        promptText: expectString(reference.promptText, `${referencePath}.promptText`),
        promptLang: expectString(reference.promptLang, `${referencePath}.promptLang`),
        tags: optionalStringArray(reference.tags, `${referencePath}.tags`),
      };
    }),
    inferenceDefaults: {
      textLang: expectString(defaults.textLang, `${path}.inferenceDefaults.textLang`),
      speed: optionalNumber(defaults.speed, `${path}.inferenceDefaults.speed`) ?? 1,
      topK: optionalNumber(defaults.topK, `${path}.inferenceDefaults.topK`),
      topP: optionalNumber(defaults.topP, `${path}.inferenceDefaults.topP`),
      temperature: optionalNumber(defaults.temperature, `${path}.inferenceDefaults.temperature`),
      batchSize: optionalNumber(defaults.batchSize, `${path}.inferenceDefaults.batchSize`),
      batchThreshold: optionalNumber(defaults.batchThreshold, `${path}.inferenceDefaults.batchThreshold`),
      splitBucket: optionalBoolean(defaults.splitBucket, `${path}.inferenceDefaults.splitBucket`),
      fragmentInterval: optionalNumber(defaults.fragmentInterval, `${path}.inferenceDefaults.fragmentInterval`),
      parallelInfer: optionalBoolean(defaults.parallelInfer, `${path}.inferenceDefaults.parallelInfer`),
      textSplitMethod: optionalString(defaults.textSplitMethod, `${path}.inferenceDefaults.textSplitMethod`),
      repetitionPenalty: optionalNumber(defaults.repetitionPenalty, `${path}.inferenceDefaults.repetitionPenalty`),
      sampleSteps: optionalNumber(defaults.sampleSteps, `${path}.inferenceDefaults.sampleSteps`),
      superSampling: optionalBoolean(defaults.superSampling, `${path}.inferenceDefaults.superSampling`),
      seed: optionalNumber(defaults.seed, `${path}.inferenceDefaults.seed`),
    },
  };
}

function parseCharacterVariant(input: unknown, presetIndex: number, variantIndex: number): TemplateCharacterVariant {
  const path = `characterPresets[${presetIndex}].variants[${variantIndex}]`;
  const variant = expectRecord(input, path);
  return {
    id: expectString(variant.id, `${path}.id`),
    name: expectString(variant.name, `${path}.name`),
    model: expectString(variant.model, `${path}.model`),
    runtime: optionalString(variant.runtime, `${path}.runtime`),
    metadata: optionalRecord(variant.metadata, `${path}.metadata`),
  };
}

function parseAuthoringCombo(
  input: unknown,
  index: number | string,
  manifestSchemaVersion: TemplateManifestSchemaVersion,
): TemplateAuthoringCombo {
  const path = typeof index === 'number' ? `authoringCombos[${index}]` : index;
  const combo = expectRecord(input, path);
  const category = expectString(combo.category, `${path}.category`);
  if (!AUTHORING_CATEGORIES.has(category as AuthoringDefinitionCategory)) {
    throw new Error(`Invalid authoring combo category at ${path}.category: "${category}"`);
  }
  const file = optionalString(combo.file, `${path}.file`);
  const actions = parseAuthoringComboActions(combo.actions, `${path}.actions`);
  const payload = parseAuthoringComboPayload(combo.payload, `${path}.payload`);

  if (manifestSchemaVersion === 2) {
    assertNoLegacyComboShape(combo, path);
    if (!payload && !file) {
      throw new Error(`manifestSchemaVersion 2 authoring combo at ${path} requires payload or file`);
    }
  }

  return {
    id: expectString(combo.id, `${path}.id`),
    name: expectString(combo.name, `${path}.name`),
    category: category as AuthoringDefinitionCategory,
    file,
    actions,
    payload,
  };
}

function assertNoLegacyComboShape(record: Record<string, unknown>, path: string): void {
  if (record.actions !== undefined) {
    throw new Error(`manifestSchemaVersion 2 authoring combo at ${path} must use payload, not legacy actions`);
  }
  if (record.actionsById !== undefined) {
    throw new Error(`manifestSchemaVersion 2 authoring combo at ${path} must use payload, not legacy actionsById`);
  }
  if (record.timeline !== undefined) {
    throw new Error(`manifestSchemaVersion 2 authoring combo at ${path} must use payload, not legacy timeline`);
  }
  if (record.ActionType !== undefined) {
    throw new Error(`manifestSchemaVersion 2 authoring combo at ${path} must use payload, not legacy ActionType`);
  }
  if (record.action !== undefined) {
    throw new Error(`manifestSchemaVersion 2 authoring combo at ${path} must use payload, not legacy action`);
  }
}

function parseAuthoringComboActions(input: unknown, path: string): TemplateAuthoringComboAction[] | undefined {
  if (input === undefined) return undefined;
  return optionalArray(input, path).map((action, actionIndex) => {
    const actionPath = `${path}[${actionIndex}]`;
    const actionRecord = expectRecord(action, actionPath);
    return {
      action: expectString(actionRecord.action, `${actionPath}.action`),
      params: optionalRecord(actionRecord.params, `${actionPath}.params`) ?? {},
      delay: optionalNumber(actionRecord.delay, `${actionPath}.delay`) ?? 0,
    };
  });
}

function parseAuthoringComboPayload(input: unknown, path: string): TemplateAuthoringComboPayload | undefined {
  if (input === undefined) return undefined;
  const payload = expectRecord(input, path);
  assertNoLegacyPayloadShape(payload, path);
  const kind = expectString(payload.kind, `${path}.kind`);
  const sceneSchemaVersion = optionalSceneSchemaVersion(payload.sceneSchemaVersion, `${path}.sceneSchemaVersion`);
  switch (kind) {
    case 'statementPreset': {
      const statement = expectRecord(payload.statement, `${path}.statement`);
      assertKnownStatementType(statement.type, `${path}.statement.type`);
      return {
        kind,
        statement,
        ...(sceneSchemaVersion !== undefined ? { sceneSchemaVersion } : {}),
      };
    }
    case 'dialoguePreset': {
      const dialogue = expectRecord(payload.dialogue, `${path}.dialogue`);
      assertKnownStatementType(dialogue.type, `${path}.dialogue.type`);
      const companions = optionalRecordArray(payload.companions, `${path}.companions`);
      companions?.forEach((companion, index) => {
        assertKnownStatementType(companion.type, `${path}.companions[${index}].type`);
      });
      return {
        kind,
        dialogue,
        ...(companions ? { companions } : {}),
        ...(sceneSchemaVersion !== undefined ? { sceneSchemaVersion } : {}),
      };
    }
    case 'timelineFragment': {
      const statements = optionalArray(payload.statements, `${path}.statements`)
        .map((statement, index) => {
          const stmtRecord = expectRecord(statement, `${path}.statements[${index}]`);
          assertKnownStatementType(stmtRecord.type, `${path}.statements[${index}].type`);
          return stmtRecord;
        });
      return {
        kind,
        statements,
        ...(sceneSchemaVersion !== undefined ? { sceneSchemaVersion } : {}),
      };
    }
    default:
      throw new Error(`Invalid authoring combo payload kind at ${path}.kind: "${kind}"`);
  }
}

function assertKnownStatementType(type: unknown, path: string): void {
  if (typeof type !== 'string' || !sceneStatementDefinitionRegistry.has(type)) {
    throw new Error(`Unknown statement family at ${path}: "${String(type)}"`);
  }
}

function assertNoLegacyPayloadShape(record: Record<string, unknown>, path: string): void {
  const legacyKeys = ['actionsById', 'timeline', 'action', 'ActionType', 'actions', 'actionType'];
  for (const key of legacyKeys) {
    if (key in record) {
      throw new Error(`Legacy action-based property "${key}" is not supported in template payload at ${path}`);
    }
  }
}

function optionalSceneSchemaVersion(input: unknown, path: string): 4 | 5 | undefined {
  if (input === undefined) return undefined;
  if (input !== 4 && input !== SCENE_SCHEMA_VERSION_V5) {
    throw new Error(`Invalid sceneSchemaVersion at ${path}: expected 4 or 5, got ${String(input)}`);
  }
  return input;
}

function optionalManifestSchemaVersion(input: unknown): TemplateManifestSchemaVersion {
  if (input === undefined) return 1;
  if (input !== 1 && input !== 2) {
    throw new Error('Expected manifestSchemaVersion to be 1 or 2');
  }
  return input;
}

function validateTemplateCompatibility(
  manifestSchemaVersion: TemplateManifestSchemaVersion,
  compatibility: Record<string, unknown> | undefined,
): void {
  if (manifestSchemaVersion !== 2) return;
  const sceneSchemaVersion = compatibility?.sceneSchemaVersion;
  if (sceneSchemaVersion !== 4 && sceneSchemaVersion !== SCENE_SCHEMA_VERSION_V5) {
    throw new Error(
      `manifestSchemaVersion 2 templates must declare template.compatibility.sceneSchemaVersion=4 or 5`,
    );
  }
}

function parseDialogueStyle(input: unknown, index: number): TemplateDialogueStyle {
  const style = expectRecord(input, `dialogueStyles[${index}]`);
  const renderer = expectString(style.renderer, `dialogueStyles[${index}].renderer`);
  const rawParams = optionalRecord(style.params, `dialogueStyles[${index}].params`);
  let params = rawParams;
  if (renderer === 'image-dialogue-v1') {
    if (!rawParams) {
      throw new Error(`image-dialogue-v1 requires params at dialogueStyles[${index}].params`);
    }
    const presentation = parseDialogueImagePresentation(
      { renderer, ...rawParams },
      `dialogueStyles[${index}]`,
    );
    const { renderer: _renderer, ...validatedParams } = presentation!;
    params = validatedParams;
  }
  return {
    id: expectString(style.id, `dialogueStyles[${index}].id`),
    name: expectString(style.name, `dialogueStyles[${index}].name`),
    renderer,
    params,
  };
}

function expectRecord(input: unknown, path: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`Expected object at ${path}`);
  }
  return input as Record<string, unknown>;
}

function optionalRecord(input: unknown, path: string): Record<string, unknown> | undefined {
  if (input === undefined) return undefined;
  return expectRecord(input, path);
}

function expectString(input: unknown, path: string): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error(`Expected non-empty string at ${path}`);
  }
  return input;
}

function optionalString(input: unknown, path: string): string | undefined {
  if (input === undefined) return undefined;
  return expectString(input, path);
}

function optionalNumber(input: unknown, path: string): number | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new Error(`Expected finite number at ${path}`);
  }
  return input;
}

function optionalBoolean(input: unknown, path: string): boolean | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'boolean') throw new Error(`Expected boolean at ${path}`);
  return input;
}

function optionalArray(input: unknown, path: string): unknown[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error(`Expected array at ${path}`);
  return input;
}

function optionalRecordArray(input: unknown, path: string): Array<Record<string, unknown>> | undefined {
  if (input === undefined) return undefined;
  return optionalArray(input, path).map((item, index) => expectRecord(item, `${path}[${index}]`));
}

function optionalStringArray(input: unknown, path: string): string[] | undefined {
  if (input === undefined) return undefined;
  return optionalArray(input, path).map((item, index) => expectString(item, `${path}[${index}]`));
}

function optionalPosition(input: unknown, path: string): [number, number] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length !== 2) {
    throw new Error(`Expected [number, number] at ${path}`);
  }
  const [x, y] = input;
  if (typeof x !== 'number' || typeof y !== 'number') {
    throw new Error(`Expected [number, number] at ${path}`);
  }
  return [x, y];
}

function optionalAssetIndex(input: unknown): TemplatePackageAssets['index'] {
  if (input === undefined) return undefined;
  return optionalArray(input, 'assets.index').map((item, index) => {
    const record = expectRecord(item, `assets.index[${index}]`);
    const path = expectString(record.path, `assets.index[${index}].path`);
    if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.split(/[\\/]/).includes('..')) {
      throw new Error(`Asset path must stay inside the template package at assets.index[${index}].path`);
    }
    return {
      id: expectString(record.id, `assets.index[${index}].id`),
      path,
      kind: optionalString(record.kind, `assets.index[${index}].kind`),
      label: optionalString(record.label, `assets.index[${index}].label`),
      metadata: optionalRecord(record.metadata, `assets.index[${index}].metadata`),
    };
  });
}

const RESOURCE_KIND_SET = new Set<string>(RESOURCE_KINDS);
const COMMON_NAMED_PLACEHOLDERS = new Set(['name', 'extension']);
const ALLOWED_PLACEHOLDERS: Record<ResourceKind, ReadonlySet<string>> = {
  live2dModel: new Set(['character', 'outfit', 'entrypoint']),
  live2dMotion: new Set(['character', 'outfit', 'name', 'extension']),
  live2dExpression: new Set(['character', 'outfit', 'name', 'extension']),
  background: COMMON_NAMED_PLACEHOLDERS,
  image: COMMON_NAMED_PLACEHOLDERS,
  icon: COMMON_NAMED_PLACEHOLDERS,
  bgm: COMMON_NAMED_PLACEHOLDERS,
  sfx: COMMON_NAMED_PLACEHOLDERS,
  voice: new Set(['character', 'name', 'extension']),
  animation: COMMON_NAMED_PLACEHOLDERS,
  font: COMMON_NAMED_PLACEHOLDERS,
  lut: COMMON_NAMED_PLACEHOLDERS,
  mask: COMMON_NAMED_PLACEHOLDERS,
};

function parseResourceConventions(input: unknown): TemplateResourceConventions | undefined {
  if (input === undefined) return undefined;
  const record = expectRecord(input, 'resourceConventions');
  const result: TemplateResourceConventions = {};
  for (const [rawKind, rawConvention] of Object.entries(record)) {
    if (!RESOURCE_KIND_SET.has(rawKind)) throw new Error(`Unsupported resource kind at resourceConventions.${rawKind}`);
    const kind = rawKind as ResourceKind;
    const path = `resourceConventions.${kind}`;
    const convention = expectRecord(rawConvention, path);
    const patterns = optionalStringArray(convention.patterns, `${path}.patterns`) ?? [];
    if (patterns.length === 0) throw new Error(`Expected at least one pattern at ${path}.patterns`);
    patterns.forEach((pattern, index) => validateConventionPattern(pattern, kind, `${path}.patterns[${index}]`));
    const entrypoints = optionalStringArray(convention.entrypoints, `${path}.entrypoints`);
    const extensions = optionalStringArray(convention.extensions, `${path}.extensions`);
    for (const [label, values] of [['entrypoints', entrypoints], ['extensions', extensions]] as const) {
      values?.forEach((value, index) => {
        if (!value || value.includes('/') || value.includes('\\') || value === '..') {
          throw new Error(`Invalid ${label} value at ${path}.${label}[${index}]`);
        }
      });
    }
    result[kind] = { patterns, ...(entrypoints ? { entrypoints } : {}), ...(extensions ? { extensions } : {}) };
  }
  return result;
}

function validateConventionPattern(pattern: string, kind: ResourceKind, path: string): void {
  if (!pattern || pattern.startsWith('/') || /^[A-Za-z]:[\\/]/.test(pattern) || pattern.split(/[\\/]/).includes('..')) {
    throw new Error(`Resource convention must stay inside the template package at ${path}`);
  }
  for (const match of pattern.matchAll(/\{([^}]+)\}/g)) {
    if (!ALLOWED_PLACEHOLDERS[kind].has(match[1])) {
      throw new Error(`Unsupported placeholder {${match[1]}} at ${path}`);
    }
  }
  if (pattern.replace(/\{[^}]+\}/g, '').includes('{') || pattern.replace(/\{[^}]+\}/g, '').includes('}')) {
    throw new Error(`Malformed placeholder at ${path}`);
  }
}
