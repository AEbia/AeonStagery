import type { ResourceCandidate, ResourceKey, ResourceCandidateSource } from './ResourceAuthoringTypes';

const SOURCE_RANK: Record<ResourceCandidateSource, number> = {
  explicit: 0,
  alias: 1,
  outfit: 2,
  owner: 3,
  convention: 4,
};

export class ResourceIndex {
  private readonly candidates: ResourceCandidate[] = [];

  add(candidate: ResourceCandidate): void {
    if (!candidate.namespace) throw new Error('Indexed resources require a namespace');
    if (!candidate.portablePath || candidate.portablePath.startsWith('/') || candidate.portablePath.split(/[\\/]/).includes('..')) {
      throw new Error(`Resource path must stay inside its namespace: "${candidate.portablePath}"`);
    }
    this.candidates.push(freezeCandidate(candidate));
  }

  addAll(other: ResourceIndex): void {
    for (const candidate of other.entries()) this.add(candidate);
  }

  entries(): readonly ResourceCandidate[] {
    return [...this.candidates];
  }

  find(key: ResourceKey, enabledNamespaces?: readonly string[]): ResourceCandidate[] {
    const enabled = enabledNamespaces ? new Set(['project', ...enabledNamespaces]) : undefined;
    let matches = this.candidates.filter((candidate) =>
      candidate.key.kind === key.kind
      && candidate.key.name === key.name
      && (!key.namespace || candidate.namespace === key.namespace)
      && (!enabled || enabled.has(candidate.namespace))
      && (!key.ownerId || candidate.key.ownerId === key.ownerId)
      && (!key.outfitId || !candidate.key.outfitId || candidate.key.outfitId === key.outfitId),
    );
    if (matches.length === 0) return [];
    if (!key.namespace && enabledNamespaces) {
      const namespaceOrder = ['project', ...enabledNamespaces];
      const selectedNamespace = namespaceOrder.find((namespace) => matches.some((candidate) => candidate.namespace === namespace));
      if (selectedNamespace) matches = matches.filter((candidate) => candidate.namespace === selectedNamespace);
    }
    const bestRank = Math.min(...matches.map((candidate) => SOURCE_RANK[candidate.source]));
    return matches
      .filter((candidate) => SOURCE_RANK[candidate.source] === bestRank)
      .sort((a, b) => `${a.namespace}\0${a.portablePath}`.localeCompare(`${b.namespace}\0${b.portablePath}`));
  }
}

function freezeCandidate(candidate: ResourceCandidate): ResourceCandidate {
  const key = Object.freeze({ ...candidate.key });
  const metadata = candidate.metadata ? Object.freeze({ ...candidate.metadata }) : undefined;
  return Object.freeze({ ...candidate, key, ...(metadata ? { metadata } : {}) });
}
