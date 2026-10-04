import type { IFileAccess } from '../io/IFileAccess';
import type { ProjectResourceService } from '../io/ProjectResourceService';
import type { TemplatePackageCatalog } from '../template-package';
import { ResourceAuthoringIndexBuilder } from './ResourceAuthoringIndexBuilder';
import { ResourceAuthoringResolver } from './ResourceAuthoringResolver';
import { ResourceMaterializer, type MaterializedResource } from './ResourceMaterializer';
import type {
  ResourceCandidateQuery,
  ResourceCandidateView,
  ResourceResolution,
  ResourceResolutionContext,
} from './ResourceAuthoringTypes';
import type { ResourceCandidate } from './ResourceAuthoringTypes';
import type { ResourceIndex } from './ResourceIndex';

export class ResourceAuthoringService {
  private readonly indexBuilder: ResourceAuthoringIndexBuilder;
  private readonly materializer: ResourceMaterializer;
  private indexPromise: Promise<ResourceIndex> | null = null;
  private readonly unsubscribeCatalog: () => void;

  constructor(
    fileAccess: IFileAccess,
    private readonly projectResources: ProjectResourceService,
    private readonly templatePackages: TemplatePackageCatalog,
  ) {
    this.indexBuilder = new ResourceAuthoringIndexBuilder(fileAccess);
    this.materializer = new ResourceMaterializer(
      fileAccess,
      projectResources,
      () => templatePackages.getPackages(),
    );
    this.unsubscribeCatalog = templatePackages.subscribe(() => this.invalidate());
  }

  async refresh(): Promise<void> {
    this.invalidate();
    await this.getIndex();
  }

  invalidate(): void {
    this.indexPromise = null;
  }

  async resolve(input: string, context: ResourceResolutionContext): Promise<ResourceResolution> {
    const project = this.projectResources.getCurrentProject();
    const enabledNamespaces = context.enabledNamespaces
      ?? project?.metadata.templates?.enabledTemplateIds;
    const index = await this.getIndex();
    return new ResourceAuthoringResolver(index).resolve(input, { ...context, enabledNamespaces });
  }

  async listCandidates(query: ResourceCandidateQuery): Promise<ResourceCandidateView[]> {
    const index = await this.getIndex();
    const project = this.projectResources.getCurrentProject();
    const enabled = new Set(['project', ...(query.enabledNamespaces ?? project?.metadata.templates?.enabledTemplateIds ?? [])]);
    const text = query.text?.trim().toLowerCase() ?? '';
    const rawCandidates = index.entries().filter((candidate) =>
      candidate.key.kind === query.kind
      && enabled.has(candidate.namespace)
      && (!query.namespaceFilter || candidate.namespace === query.namespaceFilter)
      && (!query.ownerFilter || candidate.key.ownerId === query.ownerFilter)
      && (query.includeOtherOwners || !candidate.key.ownerId || candidate.key.ownerId === query.ownerId)
      && (!query.outfitId || !candidate.key.outfitId || candidate.key.outfitId === query.outfitId)
      && (!text || candidate.key.name.toLowerCase().includes(text)
        || candidate.key.ownerId?.toLowerCase().includes(text)
        || candidate.namespace.toLowerCase().includes(text)
        || metadataSearchText(candidate.metadata).includes(text)),
    );
    const candidates = selectBestCandidateLayer(rawCandidates);
    const namespaceConflicts = new Map<string, Set<string>>();
    for (const candidate of candidates) {
      const identity = `${candidate.key.ownerId ?? ''}\0${candidate.key.name}`;
      const namespaces = namespaceConflicts.get(identity) ?? new Set<string>();
      namespaces.add(candidate.namespace);
      namespaceConflicts.set(identity, namespaces);
    }
    return candidates
      .map((candidate): ResourceCandidateView => {
        const isCurrentOwner = !candidate.key.ownerId || candidate.key.ownerId === query.ownerId;
        const namespaceVisible = (namespaceConflicts.get(`${candidate.key.ownerId ?? ''}\0${candidate.key.name}`)?.size ?? 0) > 1;
        const ownerPrefix = !isCurrentOwner && candidate.key.ownerId ? `${candidate.key.ownerId}:` : '';
        const namespacePrefix = namespaceVisible ? `${candidate.namespace}@` : '';
        return {
          candidate,
          displayName: `${namespacePrefix}${ownerPrefix}${candidate.key.name}`,
          fullIdentity: `${candidate.namespace}@${candidate.key.ownerId ? `${candidate.key.ownerId}:` : ''}${candidate.key.name}`,
          isCurrentOwner,
          namespaceVisible,
        };
      })
      .sort((left, right) =>
        Number(right.isCurrentOwner) - Number(left.isCurrentOwner)
        || left.displayName.localeCompare(right.displayName)
        || left.candidate.portablePath.localeCompare(right.candidate.portablePath));
  }

  async resolveAndMaterialize(input: string, context: ResourceResolutionContext): Promise<MaterializedResource> {
    const resolution = await this.resolve(input, context);
    if (resolution.status !== 'resolved') {
      throw new ResourceResolutionError(resolution);
    }
    return this.materializeCandidate(input, resolution.candidate);
  }

  async materializeCandidate(input: string, candidate: ResourceCandidate): Promise<MaterializedResource> {
    const materialized = await this.materializer.materialize(input, candidate);
    if (materialized.receipt.operation !== 'existing-project-reference') this.invalidate();
    return materialized;
  }

  dispose(): void {
    this.unsubscribeCatalog();
  }

  private getIndex(): Promise<ResourceIndex> {
    if (this.indexPromise) return this.indexPromise;
    const project = this.projectResources.getCurrentProject();
    if (!project) return Promise.reject(new Error('No active project'));
    const pending = this.indexBuilder.build(project, this.templatePackages.getPackages())
      .catch((error) => {
        if (this.indexPromise === pending) this.indexPromise = null;
        throw error;
      });
    this.indexPromise = pending;
    return pending;
  }
}

const CANDIDATE_SOURCE_RANK: Record<ResourceCandidate['source'], number> = {
  explicit: 0,
  alias: 1,
  outfit: 2,
  owner: 3,
  convention: 4,
};

function selectBestCandidateLayer(candidates: readonly ResourceCandidate[]): ResourceCandidate[] {
  const groups = new Map<string, ResourceCandidate[]>();
  for (const candidate of candidates) {
    const key = [
      candidate.namespace,
      candidate.key.kind,
      candidate.key.ownerId ?? '',
      candidate.key.outfitId ?? '',
      candidate.key.name,
    ].join('\0');
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) => {
    const bestRank = Math.min(...group.map((candidate) => CANDIDATE_SOURCE_RANK[candidate.source]));
    const seenPaths = new Set<string>();
    return group.filter((candidate) => {
      if (CANDIDATE_SOURCE_RANK[candidate.source] !== bestRank || seenPaths.has(candidate.portablePath)) return false;
      seenPaths.add(candidate.portablePath);
      return true;
    });
  });
}

function metadataSearchText(metadata: ResourceCandidate['metadata']): string {
  if (!metadata) return '';
  return Object.values(metadata)
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

export class ResourceResolutionError extends Error {
  constructor(readonly resolution: Exclude<ResourceResolution, { status: 'resolved' }>) {
    super(resolution.diagnostics.map((item) => item.message).join('; '));
    this.name = 'ResourceResolutionError';
  }
}
