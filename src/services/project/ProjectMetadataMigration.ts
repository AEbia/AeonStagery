import {
  DEFAULT_PROJECT_ASSET_ROOTS,
  PROJECT_SCHEMA_VERSION_V2,
  type ProjectMetadataV2,
  type ProjectSceneEntry,
} from '../../api/types/project';
import { ProjectMetadataCodec, projectMetadataCodec } from './ProjectMetadataCodec';

export function migrateProjectMetadataV1ToV2(
  input: unknown,
  codec: ProjectMetadataCodec = projectMetadataCodec,
): { document: unknown; warnings: readonly string[] } {
  if (!isRecord(input)) {
    throw new Error('migrateProjectMetadataV1ToV2 expects an object input');
  }

  if (input.projectVersion !== undefined && input.projectVersion !== 1) {
    throw new Error(
      `migrateProjectMetadataV1ToV2 expects schemaVersion 1 or missing version, received ${describeValue(input.projectVersion)}`,
    );
  }

  const warnings: string[] = [];
  if (input.projectVersion === undefined) {
    warnings.push('Project metadata upgraded from unversioned legacy contract to v2');
  } else {
    warnings.push('Project metadata upgraded from v1 to v2');
  }

  const document = cloneJson(input) as Record<string, unknown>;
  document.projectVersion = PROJECT_SCHEMA_VERSION_V2;

  if (typeof document.projectId !== 'string' || !document.projectId.trim()) {
    document.projectId = typeof document.id === 'string' && document.id.trim()
      ? document.id.trim()
      : (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  if (typeof document.name !== 'string' || !document.name.trim()) {
    document.name = 'AeonStagery Project';
  }

  const now = new Date().toISOString();
  if (typeof document.createdAt !== 'string' || !document.createdAt.trim()) {
    document.createdAt = now;
  }
  if (typeof document.updatedAt !== 'string' || !document.updatedAt.trim()) {
    document.updatedAt = now;
  }

  const existingRoots = isRecord(document.assetRoots) ? document.assetRoots : {};
  const assetRoots = {
    ...DEFAULT_PROJECT_ASSET_ROOTS,
    ...existingRoots,
  };
  document.assetRoots = assetRoots;

  const projectAssetRoot = typeof assetRoots.project === 'string' && assetRoots.project.trim()
    ? assetRoots.project
    : DEFAULT_PROJECT_ASSET_ROOTS.project;

  const scenes = normalizeScenes(document.scenes, projectAssetRoot);
  document.scenes = scenes;

  const fallbackSceneId = scenes.find((scene) => scene.id === 'main')?.id ?? scenes[0]?.id ?? 'main';
  if (typeof document.defaultSceneId !== 'string' || !scenes.some((scene) => scene.id === document.defaultSceneId)) {
    document.defaultSceneId = fallbackSceneId;
  }

  const rawTemplates = isRecord(document.templates) ? document.templates : {};
  const enabledTemplateIds = Array.isArray(rawTemplates.enabledTemplateIds)
    ? rawTemplates.enabledTemplateIds.filter((id): id is string => typeof id === 'string' && !!id.trim())
    : ['aeonstagery.default'];
  const defaults = isRecord(rawTemplates.defaults) ? { ...rawTemplates.defaults } : undefined;
  const selectedCharacterPresetIds = Array.isArray(rawTemplates.selectedCharacterPresetIds)
    ? rawTemplates.selectedCharacterPresetIds.filter((id): id is string => typeof id === 'string' && !!id.trim())
    : [];
  document.templates = {
    ...rawTemplates,
    enabledTemplateIds: enabledTemplateIds.length > 0 ? enabledTemplateIds : ['aeonstagery.default'],
    defaults,
    selectedCharacterPresetIds,
    characterVariantImportMode: rawTemplates.characterVariantImportMode === 'all' ? 'all' : 'primary-only',
  };

  // Validate detached v2 stage
  validateProjectMetadataV2Stage(document, codec);

  return { document, warnings };
}

export function validateProjectMetadataV2Stage(
  document: unknown,
  codec: ProjectMetadataCodec = projectMetadataCodec,
): ProjectMetadataV2 {
  if (!isRecord(document)) {
    throw new Error('Detached v2 stage validation expects an object');
  }
  return codec.parseKnownProjection(document);
}

function normalizeScenes(input: unknown, projectAssetRoot: string): ProjectSceneEntry[] {
  const fallbackScene: ProjectSceneEntry = {
    id: 'main',
    name: 'Main Scene',
    path: `${projectAssetRoot}/main.scene.json`,
  };

  if (!Array.isArray(input)) {
    return [fallbackScene];
  }

  const validScenes = input.filter((scene) => (
    isRecord(scene)
    && typeof scene.id === 'string'
    && scene.id.trim()
    && typeof scene.name === 'string'
    && typeof scene.path === 'string'
    && scene.path.trim()
  )).map((scene) => ({
    ...scene,
    id: (scene.id as string).trim(),
    name: scene.name as string,
    path: (scene.path as string).trim(),
  })) as ProjectSceneEntry[];

  if (validScenes.length === 0) {
    return [fallbackScene];
  }

  return validScenes;
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
