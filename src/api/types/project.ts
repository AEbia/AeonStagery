export type ResourceImportMode = 'copy' | 'mount' | 'symlink';

export type ResourceKind =
  | 'live2dModel'
  | 'live2dMotion'
  | 'live2dExpression'
  | 'background'
  | 'image'
  | 'icon'
  | 'bgm'
  | 'sfx'
  | 'voice'
  | 'animation'
  | 'font'
  | 'lut'
  | 'mask';

export interface ExternalLibraryMount {
  id: string;
  path: string;
}

/**
 * Stable mount identity grammar. Every mount id — global library, embedded
 * copy, project binding and `@mount/<id>/...` reference — validates against
 * this single pattern so a binding can never be written under an id that
 * resolution would later refuse to read.
 */
export const MOUNT_ID_SOURCE = '[a-z0-9][a-z0-9-]{0,63}';
export const MOUNT_ID_PATTERN = new RegExp(`^${MOUNT_ID_SOURCE}$`);

/** Lowercase/trim a mount id, or return null when it can never resolve. */
export function normalizeMountId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return MOUNT_ID_PATTERN.test(normalized) ? normalized : null;
}

/**
 * A portable copy of a library mount stored beneath a project's root. The
 * path is always project-relative so project metadata never embeds a local
 * machine path.
 */
export interface EmbeddedLibraryMount {
  id: string;
  path: string;
}

/**
 * Machine-local paths selected for a project's stable mount identities:
 * projectId → mountId → absolute directory. Bindings never leave the local
 * settings store and never affect what the scene documents reference.
 */
export type ProjectExternalLibraryBindings = Record<string, Record<string, string>>;

export function getProjectExternalLibraryBinding(
  bindings: ProjectExternalLibraryBindings,
  projectId: string,
  mountId: string,
): string | undefined {
  return bindings[projectId]?.[mountId];
}

/**
 * Stable signature of one project's bindings for resolution-cache keys: the
 * cache must miss whenever a mount is bound, rebound or removed.
 */
export function projectExternalLibraryBindingsSignature(
  bindings: ProjectExternalLibraryBindings,
  projectId: string,
): string {
  const mounts = bindings[projectId];
  if (!mounts) return '';
  return Object.keys(mounts)
    .sort()
    .map((mountId) => `${mountId}\u0000${mounts[mountId]}`)
    .join('|');
}

/**
 * Thrown when a resource is resolved without an open project. Distinct from
 * {@link ProjectResourceResolutionError}: it is a caller bug, not a degraded
 * resource, and must never be reported as a broken reference.
 */
export class NoActiveProjectError extends Error {
  constructor() {
    super('No active project');
    this.name = 'NoActiveProjectError';
  }
}

export type ResourceResolutionSource =
  | 'project'
  | 'embedded-mount'
  | 'project-binding'
  | 'global-mount';

/** Which binding tier produced a mountable resolution or a failure below it. */
export type MountBindingSource = 'embedded-mount' | 'project-binding' | 'global-mount';

export type ResourceResolution =
  | {
    status: 'ready';
    source: ResourceResolutionSource;
    path: string;
    relativePath: string;
    mountId?: string;
    /** Stable reference text as provided by the caller. */
    reference?: string;
  }
  | {
    /** A project-relative asset is absent from every readable root. */
    status: 'project-asset-missing';
    reference: string;
    relativePath: string;
    /** Candidate under the project root, retained for diagnostics and repair UI. */
    path: string;
  }
  | {
    status: 'mount-unbound';
    mountId: string;
    reference: string;
    relativePath: string;
  }
  | {
    /** The bound library root itself does not exist on this machine. */
    status: 'mount-root-missing';
    mountId: string;
    reference: string;
    relativePath: string;
    /** Root directory that was bound (stale on this machine). */
    root: string;
    boundVia: MountBindingSource;
  }
  | {
    /** The bound library root exists but this specific file is absent. */
    status: 'asset-missing';
    mountId: string;
    reference: string;
    relativePath: string;
    /** Candidate absolute path that was probed. */
    path: string;
    root: string;
    boundVia: MountBindingSource;
  }
  | {
    /** The reference text is malformed and can never resolve. */
    status: 'invalid-reference';
    reference: string;
    reason: string;
  };

export type ResourceResolutionStatus = ResourceResolution['status'];

/**
 * Typed failure thrown by the string-returning resolve helpers so callers
 * (runtime preparers, diagnostics) can branch on `resolution.status`.
 */
export class ProjectResourceResolutionError extends Error {
  readonly resolution: ResourceResolution;

  constructor(resolution: ResourceResolution) {
    super(describeResourceResolution(resolution));
    this.name = 'ProjectResourceResolutionError';
    this.resolution = resolution;
  }
}

export function describeResourceResolution(resolution: ResourceResolution): string {
  switch (resolution.status) {
    case 'ready':
      return `Resource is available: ${resolution.path}`;
    case 'project-asset-missing':
      return `Resource is missing from the project and readable asset roots: ${resolution.relativePath}`;
    case 'mount-unbound':
      return `External library mount "${resolution.mountId}" is not registered on this machine`;
    case 'mount-root-missing':
      return `External library mount "${resolution.mountId}" is bound to a missing directory: "${resolution.root}"`;
    case 'asset-missing':
      return `Resource is missing from external library "${resolution.mountId}": ${resolution.relativePath}`;
    case 'invalid-reference':
      return `Invalid resource reference "${resolution.reference}": ${resolution.reason}`;
  }
}

export type ResourceImportKind =
  | 'figure'
  | 'background'
  | 'bgm'
  | 'vocal'
  | 'images'
  | 'animation'
  | 'project'
  | 'template'
  | 'generic';

export interface ProjectSceneEntry {
  id: string;
  name: string;
  path: string;
}

export interface ProjectAssetRoots {
  figure: string;
  background: string;
  bgm: string;
  vocal: string;
  images: string;
  animation: string;
  project: string;
  template: string;
}

export interface ProjectTemplateDefaults {
  dialogueStyleId?: string;
  lightingPresetId?: string;
  environmentPresetId?: string;
  cameraPresetId?: string;
  textLayerStyleId?: string;
  audioPresetId?: string;
  exportPresetId?: string;
}

export type CharacterVariantImportMode = 'primary-only' | 'all';

export interface ProjectTemplateConfiguration {
  enabledTemplateIds: string[];
  /** User overrides for resolved template defaults. Template-provided defaults are resolved at runtime. */
  defaults?: ProjectTemplateDefaults;
  selectedCharacterPresetIds?: string[];
  /** Controls whether template imports materialize only each character's primary model or every outfit variant. */
  characterVariantImportMode?: CharacterVariantImportMode;
  /** Project-owned snapshot of an image dialogue style and its materialized assets. */
  dialoguePresentation?: import('./semantic-scene').DialogueImagePresentation;
  /** Resolved built-in renderer for newly authored dialogue statements. */
  dialogueTemplate?: 'glass' | 'minimal' | 'classic';
}

export interface ProjectGptSovitsVoicePreset {
  id: string;
  name: string;
  gptWeightsPath: string;
  sovitsWeightsPath: string;
  refAudioPath: string;
  promptText: string;
  promptLang: string;
  textLang: string;
  speed: number;
}

export interface ProjectVoiceGenerationConfiguration {
  gptSovits?: {
    selectedPresetId?: string;
    presets: ProjectGptSovitsVoicePreset[];
  };
}

export type { ProjectVoiceProfile } from '../../services/voice/VoiceAuthoringTypes';

/**
 * Retained source of a scene that was imported from a WebGAL script, so the
 * scene can be regenerated later (e.g. with a different reading speed) without
 * re-picking the script or the asset mount.
 */
export interface ProjectWebGalImportReceipt {
  /** Original script file name, for display. */
  scriptName: string;
  /** Ordered original file names of every merged script part, for display. */
  scriptNames?: string[];
  /** The raw WebGAL script text that produced the scene. */
  scriptText: string;
  /** External library mount id whose root contains figure/, background/, vocal/. */
  mountId?: string;
  /** Reading pace multiplier the scene was generated with. */
  speed: number;
  /** Title given to the generated scene document. */
  sceneTitle: string;
  /** Project-relative path of the scene file this receipt owns. */
  scenePath: string;
  /** ISO timestamp of the last generation. */
  generatedAt: string;
  /** WebGAL import report of the last generation, kept so the author can see
   *  what was skipped and what the scaffold did not carry (ADR-0026). */
  report?: import('../../services/import/webgal/WebGalImportTypes').WebGalImportReport;
}

export const PROJECT_SCHEMA_VERSION_V1 = 1 as const;
export const PROJECT_SCHEMA_VERSION_V2 = 2 as const;
export const PROJECT_METADATA_VERSION_V1 = PROJECT_SCHEMA_VERSION_V1;
export const PROJECT_METADATA_VERSION_V2 = PROJECT_SCHEMA_VERSION_V2;

/**
 * The project metadata schema epoch the product currently loads and saves.
 * Project Metadata v2 is the first compatibility-aware project contract (ADR-0031).
 */
export const PROJECT_SCHEMA_VERSION = PROJECT_SCHEMA_VERSION_V2;
export const PROJECT_METADATA_VERSION = PROJECT_SCHEMA_VERSION;

export type ProjectSchemaVersion =
  | typeof PROJECT_SCHEMA_VERSION_V1
  | typeof PROJECT_SCHEMA_VERSION_V2;

export type CurrentProjectSchemaVersion = typeof PROJECT_SCHEMA_VERSION;

export interface ProjectMetadataV1 {
  projectId: string;
  name: string;
  projectVersion: typeof PROJECT_SCHEMA_VERSION_V1;
  createdAt: string;
  updatedAt: string;
  defaultSceneId: string;
  scenes: ProjectSceneEntry[];
  assetRoots: ProjectAssetRoots;
  templates?: ProjectTemplateConfiguration;
  voiceGeneration?: ProjectVoiceGenerationConfiguration;
  voiceProfiles?: import('../../services/voice/VoiceAuthoringTypes').ProjectVoiceProfile[];
  webGalImport?: ProjectWebGalImportReceipt;
}

export interface ProjectMetadataV2 {
  projectId: string;
  name: string;
  projectVersion: typeof PROJECT_SCHEMA_VERSION_V2;
  createdAt: string;
  updatedAt: string;
  defaultSceneId: string;
  scenes: ProjectSceneEntry[];
  assetRoots: ProjectAssetRoots;
  /** Portable, project-contained library copies keyed by stable mount id. */
  embeddedLibraryMounts?: EmbeddedLibraryMount[];
  templates?: ProjectTemplateConfiguration;
  voiceGeneration?: ProjectVoiceGenerationConfiguration;
  voiceProfiles?: import('../../services/voice/VoiceAuthoringTypes').ProjectVoiceProfile[];
  webGalImport?: ProjectWebGalImportReceipt;
}

export type CurrentProjectMetadata = ProjectMetadataV2;
export type ProjectMetadata = ProjectMetadataV2;

export const PROJECT_COMPATIBILITY_ENVELOPE_SCHEMA_VERSION = 1 as const;
export const PROJECT_COMPATIBILITY_ENVELOPE_FILE_NAME = 'project.json.compatibility' as const;

export interface ProjectCompatibilitySceneEntry {
  path: string;
  sceneSchemaVersion: number;
  sourceHash: string;
  hasUnknownFields: boolean;
}

export interface ProjectCompatibilityEnvelope {
  schemaVersion: typeof PROJECT_COMPATIBILITY_ENVELOPE_SCHEMA_VERSION;
  scenes: ProjectCompatibilitySceneEntry[];
}

export interface ProjectState {
  rootPath: string;
  projectFilePath: string;
  metadata: ProjectMetadata;
  compatibleSession?: import('../../services/project/CompatibleProjectSession').CompatibleProjectSession;
  compatibilityEnvelope?: ProjectCompatibilityEnvelope;
}

export const DEFAULT_PROJECT_ASSET_ROOTS: ProjectAssetRoots = {
  figure: 'figure',
  background: 'background',
  bgm: 'bgm',
  vocal: 'vocal',
  images: 'images',
  animation: 'animation',
  project: 'project',
  template: 'template',
};

export const DEFAULT_PROJECT_TEMPLATE_CONFIGURATION: ProjectTemplateConfiguration = {
  enabledTemplateIds: ['aeonstagery.default'],
  defaults: {
    dialogueStyleId: 'glass',
  },
  selectedCharacterPresetIds: [],
  characterVariantImportMode: 'primary-only',
};

export const DEFAULT_PROJECT_VOICE_GENERATION_CONFIGURATION: ProjectVoiceGenerationConfiguration = {
  gptSovits: {
    selectedPresetId: undefined,
    presets: [],
  },
};
