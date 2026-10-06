import type {
  ExternalLibraryMount,
  ProjectTemplateConfiguration,
  ProjectExternalLibraryBindings,
  MountBindingSource,
  ResourceResolutionSource,
  ProjectVoiceGenerationConfiguration,
  ProjectMetadata,
  ProjectState,
  ProjectCompatibilityEnvelope,
  ResourceResolution,
  ResourceImportKind,
  ResourceImportMode,
} from '../../api/types/project';
import {
  DEFAULT_PROJECT_ASSET_ROOTS,
  DEFAULT_PROJECT_TEMPLATE_CONFIGURATION,
  DEFAULT_PROJECT_VOICE_GENERATION_CONFIGURATION,
  getProjectExternalLibraryBinding,
  projectExternalLibraryBindingsSignature,
  MOUNT_ID_PATTERN,
  NoActiveProjectError,
  ProjectResourceResolutionError,
  PROJECT_SCHEMA_VERSION_V2,
} from '../../api/types/project';
import { ProjectPathResolver } from './ProjectPathResolver';
import { CompatibleProjectSession } from '../project/CompatibleProjectSession';
import { ProjectCompatibilityEnvelopeService } from '../project/ProjectCompatibilityEnvelopeService';
import {
  CompatibilityCoordinator,
  ProjectMetadataArtifactCompatibilityAdapter,
} from '../compatibility';

type DirEntry = { name: string; isDirectory: boolean; path: string };

function relativePathBelowCategory(pathValue: string, prefixes: Array<string | undefined>): string {
  const pathSegments = pathValue.replace(/\\/g, '/').split('/').filter(Boolean);
  let selected: { index: number; length: number } | null = null;

  for (const prefix of prefixes) {
    if (!prefix) continue;
    const prefixSegments = prefix.replace(/\\/g, '/').split('/').filter(Boolean);
    if (prefixSegments.length === 0 || prefixSegments.length > pathSegments.length) continue;
    for (let index = 0; index <= pathSegments.length - prefixSegments.length; index += 1) {
      const matches = prefixSegments.every((segment, offset) =>
        segment.toLowerCase() === pathSegments[index + offset].toLowerCase());
      if (!matches) continue;
      if (!selected || index < selected.index || (index === selected.index && prefixSegments.length > selected.length)) {
        selected = { index, length: prefixSegments.length };
      }
    }
  }

  if (!selected) return pathSegments.join('/');
  const belowCategory = pathSegments.slice(selected.index + selected.length).join('/');
  return belowCategory || pathSegments.join('/');
}

type FileAccessLike = {
  readFile(path: string): Promise<{ data: string; path: string }>;
  writeFile(path: string, data: string): Promise<void>;
  ensureDir(path: string): Promise<void>;
  copyFile(sourcePath: string, destPath: string): Promise<void>;
  removeFile?(path: string): Promise<void>;
  readDir(path: string): Promise<DirEntry[]>;
  exists(path: string): Promise<boolean>;
  join(...parts: string[]): Promise<string>;
  dirname(path: string): Promise<string>;
  basename(path: string): Promise<string>;
  extname(path: string): Promise<string>;
};

export interface ImportedResource {
  mode: ResourceImportMode;
  kind: ResourceImportKind;
  relativePath: string;
}

export interface CreateProjectMetadataOptions {
  templates?: ProjectTemplateConfiguration;
}

export class ProjectResourceService {
  private resolver: ProjectPathResolver;
  private currentProjectOverride: ProjectState | null = null;
  private envelopeService: ProjectCompatibilityEnvelopeService;
  private coordinator: CompatibilityCoordinator;
  private projectAdapter: ProjectMetadataArtifactCompatibilityAdapter;
  /**
   * Positive read-resolution cache: cache key (project root + mount/binding
   * signature + reference) → the confirmed source and absolute path. Only
   * *hits* are cached — a fallback (file absent) is never stored, so assets
   * imported later are still found. The key embeds the external-library mount
   * and project-binding signatures, so switching projects or rebinding mounts
   * automatically re-resolves; explicit invalidation (invalidateReadResolution)
   * covers same-key staleness (project switch, resource delete, external file
   * mutation).
   */
  private readonly resolveCache = new Map<string, {
    source: ResourceResolutionSource;
    path: string;
  }>();

  constructor(
    private fileAccess: FileAccessLike,
    resolver?: ProjectPathResolver,
    private getExternalLibraryMounts: () => ExternalLibraryMount[] = () => [],
    private readCurrentProject: () => ProjectState | null = () => null,
    private getProjectExternalLibraryBindings: () => ProjectExternalLibraryBindings = () => ({}),
  ) {
    this.resolver = resolver ?? new ProjectPathResolver((window as any).aeonStageryAPI);
    this.envelopeService = new ProjectCompatibilityEnvelopeService(this.fileAccess, this.resolver);
    this.projectAdapter = new ProjectMetadataArtifactCompatibilityAdapter();
    this.coordinator = new CompatibilityCoordinator({
      fileAccess: this.fileAccess,
    });
  }

  getEnvelopeService(): ProjectCompatibilityEnvelopeService {
    return this.envelopeService;
  }

  getCurrentProject(): ProjectState | null {
    return this.currentProjectOverride ?? this.readCurrentProject();
  }

  setCurrentProject(project: ProjectState | null): void {
    this.currentProjectOverride = project;
    // The project root participates in cache keys, but clearing here keeps
    // the table from growing across sessions and drops any same-key residue.
    this.invalidateReadResolution();
  }

  async createProjectMetadata(
    name: string,
    scenePath: string,
    options: CreateProjectMetadataOptions = {},
  ): Promise<ProjectMetadata> {
    const now = new Date().toISOString();
    return {
      projectId: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name,
      projectVersion: PROJECT_SCHEMA_VERSION_V2,
      createdAt: now,
      updatedAt: now,
      defaultSceneId: 'main',
      scenes: [{ id: 'main', name: 'Main Scene', path: scenePath }],
      assetRoots: { ...DEFAULT_PROJECT_ASSET_ROOTS },
      templates: normalizeProjectTemplateConfiguration(options.templates),
      voiceGeneration: normalizeProjectVoiceGenerationConfiguration(),
    };
  }

  async createProject(
    rootPath: string,
    name: string,
    options: CreateProjectMetadataOptions = {},
  ): Promise<ProjectState> {
    const sceneRelativePath = `${DEFAULT_PROJECT_ASSET_ROOTS.project}/main.scene.json`;
    const metadata = await this.createProjectMetadata(name, sceneRelativePath, options);
    const sessionOutcome = this.coordinator.inspect(metadata, this.projectAdapter);
    const compatibleSession = sessionOutcome.status === 'ready' ? sessionOutcome.session : undefined;

    await this.fileAccess.ensureDir(rootPath);
    for (const root of Object.values(metadata.assetRoots)) {
      const fullPath = await this.fileAccess.join(rootPath, root);
      await this.fileAccess.ensureDir(fullPath);
    }

    const projectFilePath = await this.fileAccess.join(rootPath, 'project.json');
    await this.fileAccess.writeFile(projectFilePath, JSON.stringify(metadata, null, 2));

    const envelope = await this.envelopeService.buildEnvelope(rootPath, metadata);
    await this.envelopeService.writeEnvelope(rootPath, envelope);

    const projectState: ProjectState = {
      rootPath,
      projectFilePath,
      metadata,
      compatibleSession,
      compatibilityEnvelope: envelope,
    };
    return projectState;
  }

  async loadProject(projectPathOrRoot: string): Promise<ProjectState> {
    const projectFilePath = projectPathOrRoot.toLowerCase().endsWith('project.json')
      ? projectPathOrRoot
      : await this.fileAccess.join(projectPathOrRoot, 'project.json');
    const rootPath = await this.fileAccess.dirname(projectFilePath);

    const outcome = await this.coordinator.admit(projectFilePath, this.projectAdapter);
    if (outcome.status === 'incompatible' || outcome.status === 'invalid') {
      throw new Error(outcome.issue.message);
    }
    if (outcome.status === 'cancelled') {
      throw new Error('Project load cancelled');
    }

    const metadata: ProjectMetadata = outcome.session.projection;
    const compatibleSession: CompatibleProjectSession = outcome.session;

    const { envelope } = await this.envelopeService.loadOrRebuildEnvelope(rootPath, metadata);

    return {
      rootPath,
      projectFilePath,
      metadata,
      compatibleSession,
      compatibilityEnvelope: envelope,
    };
  }

  async saveProjectMetadata(project: ProjectState, metadata: ProjectMetadata): Promise<ProjectState> {
    const nextMetadata: ProjectMetadata = {
      ...metadata,
      projectVersion: PROJECT_SCHEMA_VERSION_V2,
      updatedAt: new Date().toISOString(),
    };

    let session = project.compatibleSession;
    if (!session) {
      const outcome = this.coordinator.inspect(project.metadata ?? metadata, this.projectAdapter);
      if (outcome.status === 'ready') {
        session = outcome.session;
      } else if (outcome.status === 'migration_required') {
        session = outcome.plan.migrate().session;
      }
    }

    let serialized: unknown;
    let finalProjection: ProjectMetadata;

    if (session) {
      finalProjection = session.applyTypedEdit(nextMetadata);
      serialized = session.serialize();
    } else {
      finalProjection = nextMetadata;
      serialized = nextMetadata;
    }

    await this.fileAccess.writeFile(project.projectFilePath, JSON.stringify(serialized, null, 2));

    const envelope = await this.envelopeService.buildEnvelope(project.rootPath, finalProjection);
    await this.envelopeService.writeEnvelope(project.rootPath, envelope);

    return {
      ...project,
      metadata: finalProjection,
      compatibleSession: session,
      compatibilityEnvelope: envelope,
    };
  }

  async refreshCompatibilityEnvelope(project?: ProjectState): Promise<ProjectCompatibilityEnvelope | null> {
    const targetProject = project ?? this.getCurrentProject();
    if (!targetProject) return null;

    const envelope = await this.envelopeService.buildEnvelope(targetProject.rootPath, targetProject.metadata);
    await this.envelopeService.writeEnvelope(targetProject.rootPath, envelope);
    targetProject.compatibilityEnvelope = envelope;
    return envelope;
  }

  /**
   * Resolves a resource while retaining *why* a resource is available or
   * unavailable on this machine. Missing external library content degrades to
   * a structured status instead of throwing — callers render recovery UI and
   * the runtime skips unavailable assets.
   */
  async resolveForReadWithStatus(projectRelativePath: string): Promise<ResourceResolution> {
    const project = this.getCurrentProject();
    if (!project) throw new NoActiveProjectError();
    const mounted = this.tryParseMountedReference(projectRelativePath);
    if (mounted) {
      if ('invalid' in mounted) {
        return { status: 'invalid-reference', reference: projectRelativePath, reason: mounted.invalid };
      }
      return this.resolveMountedReference(project, mounted);
    }
    const normalizedRelative = this.normalizeStoredRelativePath(projectRelativePath);
    const cacheKey = this.readCacheKey(project, projectRelativePath);
    const cached = this.resolveCache.get(cacheKey);
    if (cached !== undefined) {
      return {
        status: 'ready',
        source: cached.source,
        path: cached.path,
        relativePath: normalizedRelative,
        reference: projectRelativePath,
      };
    }
    const roots = this.getReadableRoots(project, normalizedRelative);

    let fallback = '';
    for (const root of roots) {
      const candidate = await this.resolver.resolveAbsolute(root, normalizedRelative);
      if (!fallback) fallback = candidate;
      if (await this.fileAccess.exists(candidate)) {
        // Positive only: fallback resolutions must stay uncached so a file
        // that appears later (import, materialization) is re-detected.
        const source: ResourceResolutionSource =
          root === project.rootPath ? 'project' : 'global-mount';
        this.resolveCache.set(cacheKey, { source, path: candidate });
        return {
          status: 'ready',
          source,
          path: candidate,
          relativePath: normalizedRelative,
          reference: projectRelativePath,
        };
      }
    }

    return {
      status: 'project-asset-missing',
      reference: projectRelativePath,
      relativePath: normalizedRelative,
      path: fallback || await this.resolver.resolveAbsolute(project.rootPath, normalizedRelative),
    };
  }

  /**
   * Backward-compatible string resolution. Callers that need recovery UI use
   * resolveForReadWithStatus; this throws a typed error below ready.
   */
  async resolveForRead(projectRelativePath: string): Promise<string> {
    const resolution = await this.resolveForReadWithStatus(projectRelativePath);
    if (resolution.status !== 'ready') {
      throw new ProjectResourceResolutionError(resolution);
    }
    return resolution.path;
  }

  /**
   * Structured status lookup that never throws for *unavailable* resources.
   * Anything else — no open project, or a filesystem failure while probing —
   * propagates: reporting those as a broken reference would send the user to
   * fix a document that is fine.
   */
  async resolveStatus(reference: string): Promise<ResourceResolution> {
    try {
      return await this.resolveForReadWithStatus(reference);
    } catch (error) {
      if (error instanceof ProjectResourceResolutionError) return error.resolution;
      throw error;
    }
  }

  private async resolveMountedReference(
    project: ProjectState,
    mounted: { mountId: string; relativePath: string },
  ): Promise<ResourceResolution> {
    const reference = `@mount/${mounted.mountId}/${mounted.relativePath}`;
    const cacheKey = this.readCacheKey(project, reference);
    const cached = this.resolveCache.get(cacheKey);
    if (cached !== undefined) {
      return {
        status: 'ready',
        source: cached.source,
        mountId: mounted.mountId,
        path: cached.path,
        relativePath: mounted.relativePath,
        reference,
      };
    }

    // 1. Project-embedded copies win, but a single missing file inside an
    //    embedded mount may be repaired by a local binding tier below.
    const embeddedMount = project.metadata.embeddedLibraryMounts?.find(
      (candidate) => candidate.id === mounted.mountId,
    );
    let embeddedRoot: string | null = null;
    let embeddedCandidate: string | null = null;
    if (embeddedMount) {
      embeddedRoot = await this.resolver.resolveAbsolute(
        project.rootPath,
        this.normalizeEmbeddedMountPath(embeddedMount.path),
      );
      embeddedCandidate = await this.resolver.resolveAbsolute(embeddedRoot, mounted.relativePath);
      if (await this.fileAccess.exists(embeddedCandidate)) {
        this.resolveCache.set(cacheKey, { source: 'embedded-mount', path: embeddedCandidate });
        return {
          status: 'ready',
          source: 'embedded-mount',
          mountId: mounted.mountId,
          path: embeddedCandidate,
          relativePath: mounted.relativePath,
          reference,
        };
      }
    }

    // 2. A project binding, once present, overrides the global library even
    //    when its root or files are missing: silently falling back to a
    //    different directory would mask the real misconfiguration.
    const projectBinding = getProjectExternalLibraryBinding(
      this.getProjectExternalLibraryBindings(),
      project.metadata.projectId,
      mounted.mountId,
    );
    if (projectBinding) {
      const probed = await this.probeMountedRoot(reference, mounted, projectBinding, 'project-binding');
      if (probed.status === 'ready') this.resolveCache.set(cacheKey, { source: 'project-binding', path: probed.path });
      return probed;
    }

    // 3. Global asset library with the same stable id.
    const globalMount = this.getExternalLibraryMounts().find((candidate) => candidate.id === mounted.mountId);
    if (globalMount?.path) {
      const probed = await this.probeMountedRoot(reference, mounted, globalMount.path, 'global-mount');
      if (probed.status === 'ready') this.resolveCache.set(cacheKey, { source: 'global-mount', path: probed.path });
      return probed;
    }

    // The mount ships inside this project, so "not configured on this machine"
    // would be the wrong diagnosis: name the broken embedded copy instead.
    if (embeddedRoot !== null && embeddedCandidate !== null) {
      if (!(await this.fileAccess.exists(embeddedRoot))) {
        return {
          status: 'mount-root-missing',
          mountId: mounted.mountId,
          reference,
          relativePath: mounted.relativePath,
          root: embeddedRoot,
          boundVia: 'embedded-mount',
        };
      }
      return {
        status: 'asset-missing',
        mountId: mounted.mountId,
        reference,
        relativePath: mounted.relativePath,
        path: embeddedCandidate,
        root: embeddedRoot,
        boundVia: 'embedded-mount',
      };
    }

    return { status: 'mount-unbound', mountId: mounted.mountId, reference, relativePath: mounted.relativePath };
  }

  private async probeMountedRoot(
    reference: string,
    mounted: { mountId: string; relativePath: string },
    root: string,
    boundVia: MountBindingSource,
  ): Promise<
    | Extract<ResourceResolution, { status: 'ready' }>
    | Extract<ResourceResolution, { status: 'mount-root-missing' | 'asset-missing' }>
  > {
    const candidate = await this.resolver.resolveAbsolute(root, mounted.relativePath);
    if (await this.fileAccess.exists(candidate)) {
      return {
        status: 'ready',
        source: boundVia,
        mountId: mounted.mountId,
        path: candidate,
        relativePath: mounted.relativePath,
        reference,
      };
    }
    if (!(await this.fileAccess.exists(root))) {
      return {
        status: 'mount-root-missing',
        mountId: mounted.mountId,
        reference,
        relativePath: mounted.relativePath,
        root,
        boundVia,
      };
    }
    return {
      status: 'asset-missing',
      mountId: mounted.mountId,
      reference,
      relativePath: mounted.relativePath,
      path: candidate,
      root,
      boundVia,
    };
  }

  private normalizeEmbeddedMountPath(pathValue: string): string {
    const normalized = pathValue.replace(/\\/g, '/').trim();
    if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized) || /^(https?:|asset:|file:)/i.test(normalized)) {
      throw new Error(`Embedded library mount path must be project-relative: "${pathValue}"`);
    }
    const segments = normalized.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error(`Embedded library mount path escapes the project: "${pathValue}"`);
    }
    return segments.join('/');
  }

  /**
   * Signature of the current external-library mounts and the active project's
   * bindings so cached resolutions invalidate when either is registered,
   * removed, or rebound.
   */
  private readMountsSignature(): string {
    const project = this.getCurrentProject();
    const bindingSignature = project
      ? projectExternalLibraryBindingsSignature(
        this.getProjectExternalLibraryBindings(),
        project.metadata.projectId,
      )
      : '';
    const globalSignature = this.getExternalLibraryMounts()
      .map((mount) => `${mount.id}\u0000${mount.path ?? ''}`)
      .join('|');
    return `${globalSignature}\u0001${bindingSignature}`;
  }

  private readCacheKey(project: ProjectState, reference: string): string {
    return `${project.rootPath}\u0000${this.readMountsSignature()}\u0000${this.normalizeCacheReference(reference)}`;
  }

  /**
   * Cache identity of a reference. Both lookups and invalidation go through
   * it, so `@mount/id/./a.png` and `@mount/id/a.png` share one entry.
   */
  private normalizeCacheReference(reference: string): string {
    const mounted = this.tryParseMountedReference(reference);
    if (mounted && !('invalid' in mounted)) {
      return `@mount/${mounted.mountId}/${mounted.relativePath}`;
    }
    try {
      return this.normalizeStoredRelativePath(reference);
    } catch {
      return reference;
    }
  }

  /**
   * Drop cached positive read resolutions.
   * - With a project-relative path: removes only the entry for that path under
   *   the current project/mounts (keyed invalidation), preserving unrelated
   *   cached resolutions.
   * - Without a path: clears the whole table (bulk external mutation, e.g. a
   *   folder replaced outside the app; also used on project switch).
   * Fallback resolutions are intentionally never cached, so a file that
   * appears later (import/materialization) is re-detected without calling
   * this. Call it only when a previously-existing file's *existence* may have
   * changed outside the service (OS-level delete/replace, mount backing
   * directory mutation).
   */
  invalidateReadResolution(projectRelativePath?: string): void {
    if (this.resolveCache.size === 0) return;
    if (projectRelativePath === undefined) {
      this.resolveCache.clear();
      return;
    }
    const project = this.getCurrentProject();
    if (!project) return;
    // Keys embed the raw reference (mounted or relative), matching the
    // lookup side; different spellings simply occupy independent entries.
    this.resolveCache.delete(this.readCacheKey(project, projectRelativePath));
  }

  async resolveForProjectWrite(projectRelativePath: string): Promise<string> {
    const project = this.getCurrentProject();
    if (!project) throw new Error('No active project');
    if (this.parseMountedReference(projectRelativePath)) {
      throw new Error(`Mounted asset references cannot be used as project write paths: "${projectRelativePath}"`);
    }
    return this.resolver.resolveAbsolute(
      project.rootPath,
      this.normalizeStoredRelativePath(projectRelativePath),
    );
  }

  async resolveForRuntime(projectRelativePath: string): Promise<string> {
    const absolutePath = await this.resolveForRead(projectRelativePath);
    const clean = absolutePath.replace(/\\/g, '/');
    return encodeURI(`asset://localhost/${clean}`);
  }

  async classifySource(sourcePath: string): Promise<'insideProject' | 'outsideProject'> {
    const project = this.getCurrentProject();
    if (!project) throw new Error('No active project');
    return this.resolver.classifySource(project.rootPath, sourcePath);
  }

  async normalizeForStorage(sourcePath: string, kind: ResourceImportKind): Promise<ImportedResource> {
    const project = this.getCurrentProject();
    if (!project) throw new Error('No active project');

    const mounted = this.parseMountedReference(sourcePath);
    if (mounted) {
      return {
        mode: 'mount',
        kind,
        relativePath: this.formatMountedReference(mounted.mountId, mounted.relativePath),
      };
    }

    const rootRelative = this.tryNormalizeRootRelativePath(sourcePath);
    if (rootRelative) {
      return {
        mode: 'mount',
        kind,
        relativePath: rootRelative,
      };
    }

    if (!this.resolver.isAbsolutePath(sourcePath) && !this.resolver.isUrlLike(sourcePath)) {
      return {
        mode: 'copy',
        kind,
        relativePath: this.resolver.normalizeRelativePath(sourcePath),
      };
    }

    const insideRelative = await this.resolver.relativeFromProject(project.rootPath, sourcePath);
    if (insideRelative) {
      return { mode: 'copy', kind, relativePath: insideRelative };
    }

    const externalMatch = await this.relativeFromExternalLibrary(sourcePath);
    if (externalMatch) {
      return {
        mode: 'mount',
        kind,
        relativePath: this.formatMountedReference(externalMatch.mount.id, externalMatch.relativePath),
      };
    }

    throw new Error(`Asset path is outside the active project and registered external libraries: "${sourcePath}"`);
  }

  async importIntoProject(
    sourceAbsolutePath: string,
    kind: ResourceImportKind,
    mode: ResourceImportMode = 'copy',
    preferredRelativePath?: string,
  ): Promise<ImportedResource> {
    const project = this.getCurrentProject();
    if (!project) throw new Error('No active project');

    const rootRelative = this.tryNormalizeRootRelativePath(sourceAbsolutePath);
    if (rootRelative) {
      return { mode: 'mount', kind, relativePath: rootRelative };
    }

    const insideRelative = await this.resolver.relativeFromProject(project.rootPath, sourceAbsolutePath);
    if (insideRelative) {
      return { mode: 'copy', kind, relativePath: insideRelative };
    }

    const externalMatch = await this.relativeFromExternalLibrary(sourceAbsolutePath);
    if (externalMatch) {
      if (mode === 'copy') {
        return this.copyExternalFileIntoProject(
          sourceAbsolutePath,
          kind,
          preferredRelativePath ?? externalMatch.relativePath,
        );
      }
      return {
        mode: 'mount',
        kind,
        relativePath: this.formatMountedReference(externalMatch.mount.id, externalMatch.relativePath),
      };
    }

    throw new Error(`Asset path is outside the active project and registered external libraries: "${sourceAbsolutePath}"`);
  }

  async materializeFromTrustedRoot(
    trustedRoot: string,
    sourceAbsolutePath: string,
    kind: ResourceImportKind,
    preferredRelativePath: string,
  ): Promise<ImportedResource> {
    const relative = await this.resolver.relativeFromProject(trustedRoot, sourceAbsolutePath);
    if (!relative) {
      throw new Error(`Trusted resource source escapes its declared root: "${sourceAbsolutePath}"`);
    }
    return this.copyExternalFileIntoProject(sourceAbsolutePath, kind, preferredRelativePath);
  }

  async importGeneratedVoiceCandidate(sourceAbsolutePath: string, preferredFileName: string): Promise<ImportedResource> {
    const safeName = preferredFileName
      .replace(/[^a-zA-Z0-9_.-]+/g, '-')
      .replace(/^\.+/, '')
      .slice(0, 120) || `voice-${Date.now()}.wav`;
    return this.copyExternalFileIntoProject(sourceAbsolutePath, 'vocal', `vocal/generated/${safeName}`);
  }

  async importVoiceReference(sourceAbsolutePath: string, presetId: string, referenceId: string): Promise<ImportedResource> {
    const extension = (await this.fileAccess.extname(sourceAbsolutePath)).toLowerCase() || '.wav';
    const safePreset = presetId.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80) || 'voice';
    const safeReference = referenceId.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80) || 'reference';
    return this.copyExternalFileIntoProject(sourceAbsolutePath, 'vocal', `vocal/reference/${safePreset}/${safeReference}${extension}`);
  }

  async removeProjectResource(relativePath: string): Promise<void> {
    if (!this.fileAccess.removeFile) throw new Error('Project resource deletion is unavailable.');
    const absolutePath = await this.resolveForProjectWrite(relativePath);
    await this.fileAccess.removeFile(absolutePath);
    // A deleted file may have been a cached positive resolution; drop only its
    // entry so unrelated cached resolutions stay warm.
    this.invalidateReadResolution(relativePath);
  }

  private getReadableRoots(project: ProjectState, _relativePath: string): string[] {
    const externalRoots = this.getExternalLibraryMounts().map((mount) => mount.path);
    const roots = [project.rootPath, ...externalRoots];
    const seen = new Set<string>();
    return roots.filter((root) => {
      if (!root) return false;
      const key = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private normalizeStoredRelativePath(pathValue: string): string {
    if (this.parseMountedReference(pathValue)) {
      throw new Error(`Expected a project-relative path, got mounted reference "${pathValue}"`);
    }
    const rootRelative = this.tryNormalizeRootRelativePath(pathValue);
    return rootRelative ?? this.resolver.normalizeRelativePath(pathValue);
  }

  private tryNormalizeRootRelativePath(pathValue: string): string | null {
    const normalized = pathValue.replace(/\\/g, '/').trim();
    const withoutLeadingSlash = normalized.replace(/^\/+/, '');
    const topLevel = withoutLeadingSlash.split('/')[0];
    const standardRoots = new Set(Object.values(DEFAULT_PROJECT_ASSET_ROOTS));
    if (normalized.startsWith('/') && standardRoots.has(topLevel)) {
      return this.resolver.normalizeRelativePath(withoutLeadingSlash);
    }
    return null;
  }

  /** Project mounted resources beneath their standard category root. */
  toCollaborationReference(reference: string, kind?: ResourceImportKind): string {
    const mounted = this.parseMountedReference(reference);
    if (!mounted) return this.normalizeStoredRelativePath(reference);

    const project = this.getCurrentProject();
    const configuredRoots = (project?.metadata.assetRoots ?? {}) as Record<string, string>;
    const defaultRoots = DEFAULT_PROJECT_ASSET_ROOTS as unknown as Record<string, string>;
    const knownRoots = Array.from(new Set([
      ...Object.values(configuredRoots),
      ...Object.values(defaultRoots),
    ].filter((root): root is string => typeof root === 'string' && root.trim().length > 0)));
    const normalizedMountPath = this.resolver.normalizeRelativePath(mounted.relativePath);

    let assetRoot = kind && kind !== 'generic'
      ? configuredRoots[kind] ?? defaultRoots[kind] ?? kind
      : knownRoots.find((root) => normalizedMountPath === root || normalizedMountPath.startsWith(`${root}/`));
    if (!assetRoot) assetRoot = configuredRoots.project ?? defaultRoots.project ?? 'project';
    assetRoot = this.resolver.normalizeRelativePath(assetRoot);

    // Libraries commonly contain a wrapper directory such as game/ before
    // their category roots. Copy only the portion below the matching category
    // so @mount/game/figure/a.json becomes figure/a.json.
    const categoryPrefixes = Array.from(new Set([
      kind,
      configuredRoots[kind ?? ''],
      defaultRoots[kind ?? ''],
      assetRoot,
    ].filter((prefix): prefix is string => typeof prefix === 'string' && prefix.length > 0)));
    const sourceRelativePath = relativePathBelowCategory(normalizedMountPath, categoryPrefixes);

    return this.resolver.normalizeRelativePath(
      `${assetRoot}/${sourceRelativePath}`,
    );
  }

  private async relativeFromExternalLibrary(
    sourcePath: string,
  ): Promise<{ mount: ExternalLibraryMount; relativePath: string } | null> {
    const matches: Array<{ mount: ExternalLibraryMount; relativePath: string }> = [];
    for (const mount of this.getExternalLibraryMounts()) {
      if (!mount.path) continue;
      const relative = await this.resolver.relativeFromProject(mount.path, sourcePath);
      if (relative) matches.push({ mount, relativePath: relative });
    }
    return matches.sort((left, right) => right.mount.path.length - left.mount.path.length)[0] ?? null;
  }

  private parseMountedReference(pathValue: string): { mountId: string; relativePath: string } | null {
    const parsed = this.tryParseMountedReference(pathValue);
    if (!parsed) return null;
    if ('invalid' in parsed) {
      throw new Error(`Invalid mounted asset reference "${pathValue}": ${parsed.invalid}`);
    }
    return parsed;
  }

  /**
   * Non-throwing mount parse for the resolution path: a malformed reference is
   * a permanent per-document condition to report, not an exception to catch.
   */
  private tryParseMountedReference(
    pathValue: string,
  ): { mountId: string; relativePath: string } | { invalid: string } | null {
    const normalized = pathValue.replace(/\\/g, '/').trim();
    if (!normalized.startsWith('@mount/')) return null;
    const [, mountId, ...relativeSegments] = normalized.split('/');
    if (!MOUNT_ID_PATTERN.test(mountId ?? '')) {
      return { invalid: `unknown external library mount id in "${normalized}"` };
    }
    if (relativeSegments.length === 0 || !relativeSegments.join('/').replace(/^\/+/, '')) {
      return { invalid: 'mounted asset reference has no relative path' };
    }
    try {
      return {
        mountId,
        relativePath: this.resolver.normalizeRelativePath(relativeSegments.join('/')),
      };
    } catch (error) {
      return { invalid: error instanceof Error ? error.message : String(error) };
    }
  }

  private formatMountedReference(mountId: string, relativePath: string): string {
    if (!MOUNT_ID_PATTERN.test(mountId)) {
      throw new Error(`Invalid external library mount id: "${mountId}"`);
    }
    return `@mount/${mountId}/${this.resolver.normalizeRelativePath(relativePath)}`;
  }

  private async copyExternalFileIntoProject(
    sourceAbsolutePath: string,
    kind: ResourceImportKind,
    preferredRelativePath?: string,
  ): Promise<ImportedResource> {
    const project = this.getCurrentProject();
    if (!project) throw new Error('No active project');

    const assetRoot = (project.metadata.assetRoots as unknown as Record<string, string>)[kind] ?? kind;
    const targetRelativePath = this.resolver.normalizeRelativePath(
      preferredRelativePath || `${assetRoot}/${await this.fileAccess.basename(sourceAbsolutePath)}`,
    );
    const targetAbsolutePath = await this.resolveForProjectWrite(targetRelativePath);
    await this.fileAccess.ensureDir(await this.fileAccess.dirname(targetAbsolutePath));
    await this.fileAccess.copyFile(sourceAbsolutePath, targetAbsolutePath);
    return {
      mode: 'copy',
      kind,
      relativePath: targetRelativePath,
    };
  }
}


function normalizeProjectTemplateConfiguration(
  templates?: ProjectTemplateConfiguration,
): ProjectTemplateConfiguration {
  return {
    enabledTemplateIds: normalizeStringList(
      templates?.enabledTemplateIds,
      DEFAULT_PROJECT_TEMPLATE_CONFIGURATION.enabledTemplateIds,
    ),
    defaults: templates?.defaults ? { ...templates.defaults } : undefined,
    selectedCharacterPresetIds: normalizeStringList(
      templates?.selectedCharacterPresetIds,
      DEFAULT_PROJECT_TEMPLATE_CONFIGURATION.selectedCharacterPresetIds ?? [],
    ),
    characterVariantImportMode: templates?.characterVariantImportMode === 'all' ? 'all' : 'primary-only',
    ...(templates?.dialoguePresentation
      ? { dialoguePresentation: JSON.parse(JSON.stringify(templates.dialoguePresentation)) }
      : {}),
    ...(['glass', 'minimal', 'classic'].includes(templates?.dialogueTemplate ?? '')
      ? { dialogueTemplate: templates?.dialogueTemplate }
      : {}),
  };
}

function normalizeStringList(input: string[] | undefined, fallback: string[]): string[] {
  if (!Array.isArray(input)) return [...fallback];
  const seen = new Set<string>();
  return input.filter((value) => {
    if (typeof value !== 'string' || !value.trim()) return false;
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

export function normalizeProjectVoiceGenerationConfiguration(
  voiceGeneration?: ProjectVoiceGenerationConfiguration,
): ProjectVoiceGenerationConfiguration {
  const presets = Array.isArray(voiceGeneration?.gptSovits?.presets)
    ? voiceGeneration.gptSovits.presets
        .filter((preset) => preset && typeof preset.id === 'string' && preset.id.trim())
        .map((preset) => ({
          id: preset.id.trim(),
          name: typeof preset.name === 'string' && preset.name.trim() ? preset.name.trim() : preset.id.trim(),
          gptWeightsPath: typeof preset.gptWeightsPath === 'string' ? preset.gptWeightsPath : '',
          sovitsWeightsPath: typeof preset.sovitsWeightsPath === 'string' ? preset.sovitsWeightsPath : '',
          refAudioPath: typeof preset.refAudioPath === 'string' ? preset.refAudioPath : '',
          promptText: typeof preset.promptText === 'string' ? preset.promptText : '',
          promptLang: typeof preset.promptLang === 'string' && preset.promptLang ? preset.promptLang : 'zh',
          textLang: typeof preset.textLang === 'string' && preset.textLang ? preset.textLang : 'zh',
          speed: typeof preset.speed === 'number' && Number.isFinite(preset.speed) ? preset.speed : 1,
        }))
    : [...(DEFAULT_PROJECT_VOICE_GENERATION_CONFIGURATION.gptSovits?.presets ?? [])];

  const selectedPresetId = voiceGeneration?.gptSovits?.selectedPresetId
    && presets.some((preset) => preset.id === voiceGeneration.gptSovits?.selectedPresetId)
      ? voiceGeneration.gptSovits.selectedPresetId
      : presets[0]?.id;

  return {
    gptSovits: {
      selectedPresetId,
      presets,
    },
  };
}
