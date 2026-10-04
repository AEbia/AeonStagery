import type {
  ExternalLibraryMount,
  ProjectState,
  ResourceKind,
} from '../../api/types/project';
import type {
  AgentResourceCandidate,
  AgentInspectResourceResult,
} from '../../api/types/project-agent';
import type { LoadedTemplatePackage, TemplateAssetEntry } from '../template-package/TemplatePackageManifest';
import { TemplateResourceConventionScanner } from '../resource-authoring/TemplateResourceConventionScanner';
import { createTemplateResourceIndex } from '../resource-authoring/TemplateResourceIndex';
import { ProjectAgentPortError } from './ProjectAgentProjectReadPorts';
import type { ProjectAgentProjectFs } from './ProjectAgentProjectFs';
import {
  classifyResourceKind,
  isHiddenResourcePath,
  live2dIdentity,
  parseLive2DCapabilities,
  resourceMimeType,
  sniffAudioMetadata,
  sniffImageDimensions,
} from './ProjectAgentResourceMetadata';
import { isCanonicalPathWithinRoot, stableSortBy } from './ProjectAgentPathRules';
import type {
  ProjectAgentResourceInspectPort,
  ProjectAgentResourceSearchPort,
} from './ProjectAgentPorts';

/** Model documents above this size never enter the agent context. */
const MAX_MODEL_DOCUMENT_BYTES = 4 * 1024 * 1024;
/** Header bytes inspected for image/audio metadata. */
const MEDIA_HEAD_BYTES = 64 * 1024;

export interface ProjectAgentResourcePortsOptions {
  readonly fs: ProjectAgentProjectFs;
  readonly getProject: () => Pick<ProjectState, 'rootPath' | 'metadata'> | null;
  readonly getExternalMounts: () => readonly ExternalLibraryMount[];
  readonly getTemplatePackages: () => readonly LoadedTemplatePackage[];
}

export interface ProjectAgentResourcePorts {
  readonly resources: ProjectAgentResourceSearchPort;
  readonly resourceInspect: ProjectAgentResourceInspectPort;
}

type NamespaceSelection =
  | { kind: 'project' }
  | { kind: 'mount'; id: string }
  | { kind: 'template'; id: string };

/**
 * ADR0023 production resource search/inspect ports. Both tools are strictly
 * read-only: they never copy, import, adopt, rename, delete or materialize
 * files, and every result is contained inside a registered root with
 * no-follow symlink traversal.
 */
export function createProjectAgentResourcePorts(
  options: ProjectAgentResourcePortsOptions,
): ProjectAgentResourcePorts {
  const ports = new ProjectAgentResourcePortsImpl(options);
  return {
    resources: { searchResources: (searchOptions) => ports.searchResources(searchOptions) },
    resourceInspect: {
      inspectResource: (reference) => ports.inspectResource(reference),
      exists: (reference) => ports.exists(reference),
    },
  };
}

class ProjectAgentResourcePortsImpl {
  private readonly fs: ProjectAgentProjectFs;
  private readonly getProject: () => Pick<ProjectState, 'rootPath' | 'metadata'> | null;
  private readonly getExternalMounts: () => readonly ExternalLibraryMount[];
  private readonly getTemplatePackages: () => readonly LoadedTemplatePackage[];

  constructor(options: ProjectAgentResourcePortsOptions) {
    this.fs = options.fs;
    this.getProject = options.getProject;
    this.getExternalMounts = options.getExternalMounts;
    this.getTemplatePackages = options.getTemplatePackages;
  }

  async searchResources(options: {
    kind?: ResourceKind;
    text?: string;
    ownerId?: string;
    outfitId?: string;
    namespace?: string;
    pathPrefix?: string;
  }): Promise<{ entries: readonly AgentResourceCandidate[]; revision: string }> {
    const selections = this.resolveNamespaces(options.namespace);
    const candidates: AgentResourceCandidate[] = [];
    const revisionParts: string[] = [];
    const pathPrefix = options.pathPrefix === undefined
      ? undefined
      : normalizeBrowsePrefix(options.pathPrefix);
    if (pathPrefix !== undefined && isHiddenResourcePath(pathPrefix)) {
      return { entries: [], revision: hashRevision([]) };
    }
    // Identity filters apply to files, not navigation-only directories.
    // With either filter, the prefix bounds a recursive resource search.
    const recursive = pathPrefix === undefined || Boolean(options.ownerId || options.outfitId);
    for (const selection of selections) {
      if (recursive) {
        if (selection.kind === 'project') await this.scanProjectNamespace(candidates, revisionParts, pathPrefix);
        if (selection.kind === 'mount') await this.scanMountNamespace(selection.id, candidates, revisionParts, pathPrefix);
        if (selection.kind === 'template' && pathPrefix === undefined) await this.scanTemplateNamespace(selection.id, candidates, revisionParts);
      } else {
        if (selection.kind === 'project') {
          await this.browseProjectNamespace(pathPrefix, candidates, revisionParts);
        }
        if (selection.kind === 'mount') {
          await this.browseMountNamespace(selection.id, pathPrefix, candidates, revisionParts);
        }
      }
    }
    const filtered = candidates.filter((candidate) => matchesFilters(candidate, options));
    return {
      entries: stableSortBy(
        filtered,
        resourceCandidateKey,
      ),
      revision: hashRevision(stableSortBy(revisionParts, (part) => part)),
    };
  }

  /**
   * Stat-only existence probe (no metadata/content read): whether the
   * reference names an existing regular file. Lets the tool layer report
   * not_found for missing files even when the reference is policy-forbidden.
   */
  async exists(reference: string): Promise<boolean> {
    let resolved: { absolute: string; relative: string; scope: 'project' | 'mount' };
    try {
      resolved = await this.resolveReference(reference);
    } catch {
      return false;
    }
    try {
      const stat = await this.fs.stat(resolved.absolute);
      return stat !== null && stat.isFile;
    } catch {
      return false;
    }
  }

  async inspectResource(reference: string): Promise<AgentInspectResourceResult> {
    let resolved: { absolute: string; relative: string; scope: 'project' | 'mount' };
    try {
      resolved = await this.resolveReference(reference);
    } catch (error) {
      if (error instanceof ProjectAgentPortError && error.code === 'not_found') {
        return { exists: false, reference, scope: reference.startsWith('@mount/') ? 'mount' : 'project', bindable: false };
      }
      throw error;
    }
    const stat = await this.fs.stat(resolved.absolute);
    if (!stat || !stat.isFile) {
      return {
        exists: false,
        reference,
        scope: resolved.scope,
        bindable: false,
      };
    }
    const kind = resolved.scope === 'mount'
      ? classifyMountedResourceKind(resolved.relative, this.mountPathForReference(reference))
      : classifyResourceKind(resolved.relative);
    if (!kind) {
      return {
        exists: true,
        reference,
        scope: resolved.scope,
        kind: undefined,
        bindable: false,
      };
    }
    const sizeBytes = stat.sizeBytes;
    const mimeType = resourceMimeType(resolved.relative);
    const media: Record<string, unknown> = { ...(mimeType ? { mimeType } : {}), sizeBytes };
    if (kind === 'live2dModel') {
      const live2d = await this.readLive2DCapabilities(resolved, sizeBytes, media);
      return {
        exists: true,
        reference,
        scope: resolved.scope,
        kind,
        bindable: true,
        media,
        live2d,
      };
    }
    if (mimeType?.startsWith('image/') && sizeBytes > 0) {
      const head = await this.fs.readHead(resolved.absolute, MEDIA_HEAD_BYTES);
      if (head) {
        const dimensions = sniffImageDimensions(head);
        if (dimensions) Object.assign(media, dimensions);
      }
    } else if (mimeType?.startsWith('audio/') && sizeBytes > 0) {
      const head = await this.fs.readHead(resolved.absolute, MEDIA_HEAD_BYTES);
      if (head) {
        const audio = sniffAudioMetadata(head, mimeType);
        if (audio) {
          Object.assign(media, audio);
        }
      }
    }
    return {
      exists: true,
      reference,
      scope: resolved.scope,
      kind,
      bindable: true,
      media,
    };
  }

  private async readLive2DCapabilities(
    resolved: { absolute: string; relative: string },
    sizeBytes: number,
    media: Record<string, unknown>,
  ): Promise<{ motions: readonly string[]; expressions: readonly string[]; capabilities: Readonly<Record<string, unknown>> }> {
    if (sizeBytes > MAX_MODEL_DOCUMENT_BYTES) {
      return { motions: [], expressions: [], capabilities: { runtimeFamily: 'unknown' } };
    }
    let jsonText: string;
    try {
      jsonText = await this.fs.readTextFile(resolved.absolute);
    } catch {
      return { motions: [], expressions: [], capabilities: { runtimeFamily: 'unknown' } };
    }
    const capabilities = parseLive2DCapabilities(jsonText, resolved.relative);
    media.modelDocumentBytes = sizeBytes;
    return {
      motions: [...capabilities.motions],
      expressions: [...capabilities.expressions],
      capabilities: {
        runtimeFamily: capabilities.runtimeFamily,
        motionCount: capabilities.motions.length,
        expressionCount: capabilities.expressions.length,
      },
    };
  }

  private async resolveReference(reference: string): Promise<{
    absolute: string;
    relative: string;
    scope: 'project' | 'mount';
  }> {
    const project = this.getProject();
    if (reference.startsWith('@mount/')) {
      const rest = reference.slice('@mount/'.length);
      const slashIndex = rest.indexOf('/');
      if (slashIndex <= 0) throw new ProjectAgentPortError('forbidden_path', 'Invalid mount reference');
      const mountId = rest.slice(0, slashIndex);
      const relative = rest.slice(slashIndex + 1);
      const mount = this.getExternalMounts().find((candidate) => candidate.id === mountId);
      if (!mount?.path) throw new ProjectAgentPortError('not_found', 'Mount is not registered');
      return this.containedResolution(mount.path, assertRelativeShape(relative), 'mount');
    }
    if (!project) throw new ProjectAgentPortError('not_found', 'No active project workspace');
    return this.containedResolution(project.rootPath, assertRelativeShape(reference), 'project');
  }

  private mountPathForReference(reference: string): string {
    if (!reference.startsWith('@mount/')) return '';
    const rest = reference.slice('@mount/'.length);
    const slashIndex = rest.indexOf('/');
    if (slashIndex <= 0) return '';
    const mountId = rest.slice(0, slashIndex);
    return this.getExternalMounts().find((candidate) => candidate.id === mountId)?.path ?? '';
  }

  private async containedResolution(
    root: string,
    relative: string,
    scope: 'project' | 'mount',
  ): Promise<{ absolute: string; relative: string; scope: 'project' | 'mount' }> {
    let canonicalRoot: string;
    try {
      canonicalRoot = await this.fs.realpath(root);
    } catch {
      throw new ProjectAgentPortError('not_found', 'Registered root is not readable');
    }
    const absolute = await this.fs.join(root, relative);
    let canonical: string;
    try {
      canonical = await this.fs.realpath(absolute);
    } catch {
      // Target is missing: walk up the existing ancestor chain to detect a
      // symlink escape, so an outside root never degrades to a benign miss.
      const disposition = await this.detectAncestorEscape(absolute, canonicalRoot);
      if (disposition === 'escape') {
        throw new ProjectAgentPortError('forbidden_path', 'Reference resolves outside the registered root');
      }
      throw new ProjectAgentPortError('not_found', 'Resource does not exist inside the registered root');
    }
    if (!isCanonicalPathWithinRoot(canonical, canonicalRoot)) {
      throw new ProjectAgentPortError('forbidden_path', 'Reference resolves outside the registered root');
    }
    return { absolute, relative, scope };
  }

  /** Returns 'escape' when any existing ancestor canonicalizes outside the root. */
  private async detectAncestorEscape(absPath: string, canonicalRoot: string): Promise<'inside' | 'escape'> {
    let current = absPath;
    for (let depth = 0; depth < 64 && current; depth += 1) {
      try {
        const canonical = await this.fs.realpath(current);
        return isCanonicalPathWithinRoot(canonical, canonicalRoot) ? 'inside' : 'escape';
      } catch {
        const forward = current.lastIndexOf('/');
        const backward = current.lastIndexOf('\\');
        const slash = Math.max(forward, backward);
        if (slash <= 0) return 'escape';
        current = current.slice(0, slash);
      }
    }
    return 'escape';
  }

  private async scanProjectNamespace(
    candidates: AgentResourceCandidate[],
    revisionParts: string[],
    pathPrefix?: string,
  ): Promise<void> {
    const project = this.getProject();
    if (!project) return;
    let canonicalRoot: string;
    try {
      canonicalRoot = await this.fs.realpath(project.rootPath);
    } catch {
      return;
    }
    for (const [rootKey, relativeRoot] of Object.entries(project.metadata.assetRoots)) {
      if (!relativeRoot) continue;
      const normalizedRoot = normalizeReference(relativeRoot);
      if (!normalizedRoot || isHiddenResourcePath(normalizedRoot)) continue;
      if (pathPrefix && !isPathAtOrBelow(pathPrefix, normalizedRoot) && !isPathAtOrBelow(normalizedRoot, pathPrefix)) continue;
      const absoluteRoot = await this.fs.join(project.rootPath, normalizedRoot);
      const canonical = await this.canonicalizeContained(absoluteRoot, canonicalRoot);
      if (!canonical) continue;
      await this.walk(absoluteRoot, normalizedRoot, canonicalRoot, async (relative, absolute) => {
        const kind = classifyResourceKind(relative);
        if (!kind) return;
        const rootKind = rootKindByAssetRoot(rootKey, kind);
        if (!rootKind) return;
        // The walk's relative path includes the asset root name; identities
        // derive from the root-relative path like the app's own indexer.
        const rootRelative = relative.split('/').slice(1).join('/');
        const identity: { ownerId?: string; outfitId?: string } = rootKind === 'live2dModel'
          ? live2dIdentity(rootRelative)
          : rootKind === 'voice'
            ? voiceOwner(rootRelative)
            : {};
        const reference = normalizeReference(relative);
        if (!reference) return;
        candidates.push({
          kind: rootKind,
          displayName: displayNameFor(relative, rootKind, identity),
          scope: 'project',
          reference,
          ...(identity.ownerId ? { ownerId: identity.ownerId } : {}),
          ...(identity.outfitId ? { outfitId: identity.outfitId } : {}),
          metadata: await awaitFileMetadata(this.fs, absolute, relative),
        });
        revisionParts.push(await revisionPartFor(this.fs, absolute, relative));
      }, pathPrefix);
    }
  }

  private async scanMountNamespace(
    mountId: string,
    candidates: AgentResourceCandidate[],
    revisionParts: string[],
    pathPrefix = '',
  ): Promise<void> {
    const mount = this.getExternalMounts().find((candidate) => candidate.id === mountId);
    if (!mount?.path) return;
    let canonicalRoot: string;
    try {
      canonicalRoot = await this.fs.realpath(mount.path);
    } catch {
      return;
    }
    await this.walk(mount.path, '', canonicalRoot, async (relative, absolute) => {
      const kind = classifyMountedResourceKind(relative, mount.path);
      if (!kind) return;
      const identity: { ownerId?: string; outfitId?: string } = kind === 'live2dModel'
        ? live2dIdentity(relative)
        : kind === 'voice'
          ? voiceOwner(relative)
          : {};
      candidates.push({
        kind,
        displayName: displayNameFor(relative, kind, identity),
        scope: 'mount',
        reference: `@mount/${mountId}/${relative}`,
        ...(identity.ownerId ? { ownerId: identity.ownerId } : {}),
        ...(identity.outfitId ? { outfitId: identity.outfitId } : {}),
        metadata: await awaitFileMetadata(this.fs, absolute, relative),
      });
      revisionParts.push(await revisionPartFor(this.fs, absolute, relative));
    }, pathPrefix);
  }

  /**
   * Browse one project asset directory without exposing the project root or
   * accepting arbitrary project paths. The prefix must be that asset root or
   * one of its descendants, so generic project files remain out of scope.
   */
  private async browseProjectNamespace(
    pathPrefix: string,
    candidates: AgentResourceCandidate[],
    revisionParts: string[],
  ): Promise<void> {
    const project = this.getProject();
    if (!project) return;
    let canonicalRoot: string;
    try {
      canonicalRoot = await this.fs.realpath(project.rootPath);
    } catch {
      return;
    }
    for (const [rootKey, relativeRoot] of Object.entries(project.metadata.assetRoots)) {
      const normalizedRoot = normalizeReference(relativeRoot);
      if (!normalizedRoot || !isPathAtOrBelow(pathPrefix, normalizedRoot)) continue;
      const absolutePrefix = await this.fs.join(project.rootPath, pathPrefix);
      const canonicalPrefix = await this.canonicalizeContained(absolutePrefix, canonicalRoot);
      if (!canonicalPrefix) continue;
      await this.browseDirectory(
        absolutePrefix,
        pathPrefix,
        canonicalRoot,
        {
          onFile: async (relative, absolute) => {
            const detectedKind = classifyResourceKind(relative);
            if (!detectedKind) return;
            const kind = rootKindByAssetRoot(rootKey, detectedKind);
            if (!kind) return;
            const rootRelative = relative.split('/').slice(1).join('/');
            const identity: { ownerId?: string; outfitId?: string } = kind === 'live2dModel'
              ? live2dIdentity(rootRelative)
              : kind === 'voice'
                ? voiceOwner(rootRelative)
                : {};
            candidates.push({
              kind,
              displayName: displayNameFor(relative, kind, identity),
              scope: 'project',
              reference: relative,
              ...(identity.ownerId ? { ownerId: identity.ownerId } : {}),
              ...(identity.outfitId ? { outfitId: identity.outfitId } : {}),
              metadata: await awaitFileMetadata(this.fs, absolute, relative),
            });
          },
          onDirectory: (relative, absolute, displayName) => {
            candidates.push({
              kind: 'directory',
              displayName,
              scope: 'project',
              namespace: 'project',
              pathPrefix: relative,
            });
            return revisionPartFor(this.fs, absolute, relative).then((part) => {
              revisionParts.push(part);
            });
          },
          onResourceFile: async (relative, absolute) => {
            revisionParts.push(await revisionPartFor(this.fs, absolute, relative));
          },
        },
      );
    }
  }

  /**
   * Return immediate children of a registered mount directory. Directories
   * are navigation entries only; resource files keep their stable @mount
   * reference and remain subject to the normal resource validation gate.
   */
  private async browseMountNamespace(
    mountId: string,
    pathPrefix: string,
    candidates: AgentResourceCandidate[],
    revisionParts: string[],
  ): Promise<void> {
    const mount = this.getExternalMounts().find((candidate) => candidate.id === mountId);
    if (!mount?.path) return;
    let canonicalRoot: string;
    try {
      canonicalRoot = await this.fs.realpath(mount.path);
    } catch {
      return;
    }
    const absolutePrefix = await this.fs.join(mount.path, pathPrefix);
    const canonicalPrefix = await this.canonicalizeContained(absolutePrefix, canonicalRoot);
    if (!canonicalPrefix) return;
    await this.browseDirectory(
      absolutePrefix,
      pathPrefix,
      canonicalRoot,
      {
        onFile: async (relative, absolute) => {
          const kind = classifyMountedResourceKind(relative, mount.path);
          if (!kind) return;
          const identity: { ownerId?: string; outfitId?: string } = kind === 'live2dModel'
            ? live2dIdentity(relative)
            : kind === 'voice'
              ? voiceOwner(relative)
              : {};
          candidates.push({
            kind,
            displayName: displayNameFor(relative, kind, identity),
            scope: 'mount',
            reference: `@mount/${mountId}/${relative}`,
            ...(identity.ownerId ? { ownerId: identity.ownerId } : {}),
            ...(identity.outfitId ? { outfitId: identity.outfitId } : {}),
            metadata: await awaitFileMetadata(this.fs, absolute, relative),
          });
        },
        onDirectory: (relative, absolute, displayName) => {
          candidates.push({
            kind: 'directory',
            displayName,
            scope: 'mount',
            namespace: `mount:${mountId}`,
            pathPrefix: relative,
          });
          return revisionPartFor(this.fs, absolute, relative).then((part) => {
            revisionParts.push(part);
          });
        },
        onResourceFile: async (relative, absolute) => {
          revisionParts.push(await revisionPartFor(this.fs, absolute, relative));
        },
      },
    );
  }

  private async scanTemplateNamespace(
    templateId: string,
    candidates: AgentResourceCandidate[],
    revisionParts: string[],
  ): Promise<void> {
    const project = this.getProject();
    const enabledIds = new Set(project?.metadata.templates?.enabledTemplateIds ?? []);
    const templatePackage = this.getTemplatePackages().find((item) => item.manifest.template.id === templateId);
    if (!templatePackage) return;
    // ADR0023 scopes the template namespace to enabled templates only; a
    // disabled package must never surface, not even through convention scan.
    if (!enabledIds.has(templateId)) return;
    const packageRoot = templatePackage.source.packageRoot;
    let canonicalRoot: string;
    try {
      canonicalRoot = await this.fs.realpath(packageRoot);
    } catch {
      return;
    }
    const assetRootName = templatePackage.manifest.assets?.root ?? 'assets';
    const assetRootAbs = await this.fs.join(packageRoot, assetRootName);
    const canonicalAssetRoot = await this.canonicalizeContained(assetRootAbs, canonicalRoot);
    if (!canonicalAssetRoot) return;

    const explicitPaths = new Set<string>();
    for (const entry of templatePackage.manifest.assets?.index ?? []) {
      if (!entry.kind || isHiddenResourcePath(entry.path)) continue;
      explicitPaths.add(entry.path);
      const entryOwner = typeof entry.metadata?.ownerId === 'string' ? entry.metadata.ownerId : '';
      const entryOutfit = typeof entry.metadata?.outfitId === 'string' ? entry.metadata.outfitId : '';
      revisionParts.push(`manifest:${templateId}:${entry.id}:${entry.label ?? ''}:${entryOwner}:${entryOutfit}`);
      candidates.push(templateCandidate(entry, templatePackage));
    }

    // Convention scanning over the package asset root through a
    // containment/no-follow adapter over the same fs seam.
    const scanner = new TemplateResourceConventionScanner(
      new ContainedTemplateFileAccess(this.fs, canonicalAssetRoot),
    );
    const index = createTemplateResourceIndex([templatePackage], [...enabledIds]);
    try {
      await scanner.addPackage(index, templatePackage);
    } catch {
      return;
    }
    for (const candidate of index.entries()) {
      if (candidate.source === 'explicit' || candidate.source === 'alias') continue;
      if (isHiddenResourcePath(candidate.portablePath)) continue;
      if (explicitPaths.has(candidate.portablePath)) continue;
      candidates.push({
        kind: candidate.key.kind,
        displayName: candidate.key.name,
        scope: 'template',
        materializationRequired: true,
        ...(candidate.key.ownerId ? { ownerId: candidate.key.ownerId } : {}),
        ...(candidate.key.outfitId ? { outfitId: candidate.key.outfitId } : {}),
        metadata: {
          templateId,
          templateName: templatePackage.manifest.template.name,
        },
      });
      revisionParts.push(`scan:${templateId}:${candidate.portablePath}`);
    }
  }

  private resolveNamespaces(raw: string | undefined): NamespaceSelection[] {
    const enabledTemplateIds = new Set(
      this.getProject()?.metadata.templates?.enabledTemplateIds ?? [],
    );
    const enabledPackages = this.getTemplatePackages().filter(
      (item) => enabledTemplateIds.has(item.manifest.template.id),
    );
    if (raw === undefined) {
      const selections: NamespaceSelection[] = [{ kind: 'project' }];
      for (const mount of this.getExternalMounts()) selections.push({ kind: 'mount', id: mount.id });
      for (const templatePackage of enabledPackages) {
        selections.push({ kind: 'template', id: templatePackage.manifest.template.id });
      }
      return selections;
    }
    if (raw === 'project') return [{ kind: 'project' }];
    if (raw === 'mount' || raw.startsWith('mount:')) {
      const id = raw === 'mount' ? '' : raw.slice('mount:'.length);
      const mounts = this.getExternalMounts();
      if (!id) return mounts.map((mount) => ({ kind: 'mount' as const, id: mount.id }));
      return mounts.some((mount) => mount.id === id) ? [{ kind: 'mount', id }] : [];
    }
    if (raw === 'template' || raw.startsWith('template:')) {
      const id = raw === 'template' ? '' : raw.slice('template:'.length);
      if (!id) return enabledPackages.map((item) => ({ kind: 'template' as const, id: item.manifest.template.id }));
      return enabledPackages.some((item) => item.manifest.template.id === id)
        ? [{ kind: 'template', id }]
        : [];
    }
    return [];
  }

  private async canonicalizeContained(absPath: string, canonicalRoot: string): Promise<string | null> {
    try {
      const canonical = await this.fs.realpath(absPath);
      return isCanonicalPathWithinRoot(canonical, canonicalRoot) ? canonical : null;
    } catch {
      return null;
    }
  }

  /**
   * Recursive no-follow walk: symbolic links are never descended into and
   * never reported as resources, and every directory must canonically stay
   * inside the registered root. Search result size is bounded by the tool
   * pagination layer, not by rejecting a registered library for having more
   * files than an arbitrary traversal threshold.
   */
  private async walk(
    dirAbs: string,
    relativeDir: string,
    canonicalRoot: string,
    onFile: (relative: string, absolute: string) => Promise<void> | void,
    pathPrefix?: string,
  ): Promise<void> {
    let entries: readonly { name: string; isDirectory: boolean; isSymbolicLink: boolean }[];
    try {
      entries = await this.fs.readDir(dirAbs);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink || entry.name.startsWith('.')) continue;
      const relative = relativeDir.length > 0 ? `${relativeDir}/${entry.name}` : entry.name;
      // Walk only ancestors/descendants of the prefix, preserving no-follow
      // traversal even when a caller explicitly names a symlink directory.
      if (pathPrefix && !isPathAtOrBelow(relative, pathPrefix) && !(entry.isDirectory && isPathAtOrBelow(pathPrefix, relative))) continue;
      const absolute = await this.fs.join(dirAbs, entry.name);
      if (entry.isDirectory) {
        const canonical = await this.canonicalizeContained(absolute, canonicalRoot);
        if (!canonical) continue;
        await this.walk(absolute, relative, canonicalRoot, onFile, pathPrefix);
      } else {
        await onFile(relative, absolute);
      }
    }
  }

  /** Immediate, contained, no-follow directory listing used by browse mode. */
  private async browseDirectory(
    dirAbs: string,
    relativeDir: string,
    canonicalRoot: string,
    handlers: {
      onFile: (relative: string, absolute: string) => Promise<void> | void;
      onDirectory: (relative: string, absolute: string, displayName: string) => Promise<void> | void;
      onResourceFile: (relative: string, absolute: string) => Promise<void> | void;
    },
  ): Promise<void> {
    let entries: readonly { name: string; isDirectory: boolean; isSymbolicLink: boolean }[];
    try {
      entries = await this.fs.readDir(dirAbs);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink || entry.name.startsWith('.')) continue;
      const relative = relativeDir.length > 0 ? `${relativeDir}/${entry.name}` : entry.name;
      const absolute = await this.fs.join(dirAbs, entry.name);
      if (entry.isDirectory) {
        const canonical = await this.canonicalizeContained(absolute, canonicalRoot);
        if (!canonical) continue;
        await handlers.onDirectory(relative, absolute, entry.name);
      } else {
        const kind = classifyResourceKind(relative);
        await handlers.onFile(relative, absolute);
        if (kind) await handlers.onResourceFile(relative, absolute);
      }
    }
  }
}

/** Containment + no-follow adapter so the shared template convention scanner
 * can reuse this sandbox's traversal rules instead of its own readDir. */
class ContainedTemplateFileAccess {
  constructor(
    private readonly fs: ProjectAgentProjectFs,
    private readonly canonicalRoot: string,
  ) {}

  async readDir(dir: string): Promise<Array<{ name: string; isDirectory: boolean; path: string }>> {
    let entries: readonly { name: string; isDirectory: boolean; isSymbolicLink: boolean }[];
    try {
      entries = await this.fs.readDir(dir);
    } catch {
      return [];
    }
    const result: Array<{ name: string; isDirectory: boolean; path: string }> = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink || entry.name.startsWith('.')) continue;
      const absolute = await this.fs.join(dir, entry.name);
      if (entry.isDirectory) {
        try {
          const canonical = await this.fs.realpath(absolute);
          if (!isCanonicalPathWithinRoot(canonical, this.canonicalRoot)) continue;
        } catch {
          continue;
        }
        result.push({ name: entry.name, isDirectory: true, path: absolute });
      } else {
        result.push({ name: entry.name, isDirectory: false, path: absolute });
      }
    }
    return result;
  }

  async join(...parts: string[]): Promise<string> {
    return this.fs.join(...parts);
  }
}

function templateCandidate(
  entry: TemplateAssetEntry,
  templatePackage: LoadedTemplatePackage,
): AgentResourceCandidate {
  const metadata = { ...(entry.metadata ?? {}) };
  const ownerId = typeof metadata.ownerId === 'string' ? metadata.ownerId : undefined;
  const outfitId = typeof metadata.outfitId === 'string' ? metadata.outfitId : undefined;
  delete metadata.ownerId;
  delete metadata.outfitId;
  return {
    kind: entry.kind as ResourceKind,
    displayName: entry.label ?? entry.id,
    scope: 'template',
    materializationRequired: true,
    ...(ownerId ? { ownerId } : {}),
    ...(outfitId ? { outfitId } : {}),
    metadata: {
      ...metadata,
      templateId: templatePackage.manifest.template.id,
      templateName: templatePackage.manifest.template.name,
    },
  };
}

function matchesFilters(
  candidate: AgentResourceCandidate,
  options: { kind?: ResourceKind; text?: string; ownerId?: string; outfitId?: string },
): boolean {
  // Browse directories remain visible when filtering by resource kind: their
  // contents have not been scanned, and they are the navigation route to the
  // requested type.
  if (options.kind && candidate.kind !== 'directory' && candidate.kind !== options.kind) return false;
  if (options.ownerId && candidate.ownerId !== options.ownerId) return false;
  if (options.outfitId && candidate.outfitId !== options.outfitId) return false;
  if (options.text) {
    const needle = options.text.toLowerCase();
    const browsePath = candidate.kind === 'directory' ? candidate.pathPrefix : '';
    const reference = candidate.kind === 'directory' ? '' : candidate.reference ?? '';
    const haystack = `${candidate.displayName} ${browsePath} ${reference} ${candidate.ownerId ?? ''} ${candidate.outfitId ?? ''}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function resourceCandidateKey(candidate: AgentResourceCandidate): string {
  const location = candidate.kind === 'directory'
    ? candidate.pathPrefix
    : candidate.reference ?? candidate.displayName;
  return `${candidate.scope}:${candidate.namespace ?? ''}:${candidate.kind}:${location}`;
}

function normalizeReference(relative: string): string | null {
  const segments = relative.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) return null;
  return segments.join('/');
}

function normalizeBrowsePrefix(raw: string): string {
  const shaped = assertRelativeShape(raw);
  if (shaped === '') return '';
  const normalized = normalizeReference(shaped);
  if (!normalized) throw new ProjectAgentPortError('forbidden_path', 'Invalid resource browse prefix');
  return normalized;
}

function isPathAtOrBelow(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function classifyMountedResourceKind(relative: string, mountPath: string): ResourceKind | null {
  const kind = classifyResourceKind(relative);
  return kind === 'image' && isBackgroundMountRoot(mountPath) ? 'background' : kind;
}

function isBackgroundMountRoot(mountPath: string): boolean {
  const name = mountPath.replace(/\\/g, '/').split('/').filter(Boolean).at(-1)?.toLowerCase();
  return name === 'background' || name === 'backgrounds';
}

/** Defense in depth: only clean relative paths may reach the fs seam. */
function assertRelativeShape(relative: string): string {
  const normalized = relative.replace(/\\/g, '/').trim();
  if (
    normalized.startsWith('/')
    || /^[a-zA-Z]:\//.test(normalized)
    || normalized.startsWith('\\\\')
    || normalized.includes('\0')
    || normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new ProjectAgentPortError('forbidden_path', 'Reference must stay inside the registered root');
  }
  return normalized;
}

function displayNameFor(
  relative: string,
  kind: ResourceKind,
  identity: { ownerId?: string; outfitId?: string },
): string {
  const base = relative.split('/').at(-1) ?? relative;
  if (kind === 'live2dModel' && identity.ownerId && identity.outfitId) {
    return `${identity.ownerId}/${identity.outfitId}`;
  }
  return base.replace(/\.model(?:\.model3)?\.json$/i, '').replace(/\.(json|png|jpe?g|gif|webp|bmp|svg|mp3|wav|ogg|m4a|flac|ttf|otf|woff2?|cube)$/i, '');
}

function rootKindByAssetRoot(rootKey: string, fallbackKind: ResourceKind): ResourceKind | null {
  switch (rootKey) {
    case 'figure':
      return fallbackKind === 'live2dModel' ? 'live2dModel' : fallbackKind === 'image' ? 'image' : null;
    case 'background':
      return 'background';
    case 'images':
      return 'image';
    case 'bgm':
      return 'bgm';
    case 'vocal':
      return 'voice';
    case 'animation':
      return 'animation';
    default:
      return null;
  }
}

function voiceOwner(relative: string): { ownerId?: string } {
  const segments = relative.split('/').filter(Boolean);
  if (segments.length >= 2) return { ownerId: segments[0] };
  return {};
}

async function awaitFileMetadata(
  fs: ProjectAgentProjectFs,
  absolute: string,
  relative: string,
): Promise<Record<string, unknown>> {
  const stat = await fs.stat(absolute);
  const metadata: Record<string, unknown> = {};
  const mimeType = resourceMimeType(relative);
  if (mimeType) metadata.mimeType = mimeType;
  if (stat) metadata.sizeBytes = stat.sizeBytes;
  return metadata;
}

async function revisionPartFor(fs: ProjectAgentProjectFs, absolute: string, relative: string): Promise<string> {
  const stat = await fs.stat(absolute);
  return stat ? `${relative}:${stat.sizeBytes}:${stat.mtimeMs.toFixed(3)}` : `${relative}:0:0`;
}

function hashRevision(parts: readonly string[]): string {
  let hash = 2166136261;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      hash ^= part.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 10;
  }
  return (hash >>> 0).toString(16);
}
