import type {
  PerformanceCapabilityCatalogV1,
  PerformanceProfileKeyEntryV1,
} from '../ai-authoring/performance/PerformanceProfileTypes';

/**
 * System-prompt slot where the host injects the bounded performance catalog
 * (ADR0023). Small catalogs are injected directly; large catalogs become a
 * bounded summary with exact keys available through a paginated read tool.
 */
export const PROJECT_AGENT_CAPABILITY_CATALOG_SLOT = '{{capability_catalog}}';

export interface ProjectAgentPerformanceCatalogResolution {
  readonly catalog: PerformanceCapabilityCatalogV1;
  /** Stable fingerprint of the catalog + provider inputs (refresh trigger). */
  readonly fingerprint: string;
}

export interface ProjectAgentPerformanceCatalogResolver {
  /**
   * Recompute the bounded catalog for ALL target-scene characters from the
   * current scene character directory, the character/model binding and the
   * performance profile provider, intersected with actual model
   * motions/expressions. Failures never block the task; the last injected
   * catalog stays in effect.
   */
  resolve(): Promise<
    | { ok: true; value: ProjectAgentPerformanceCatalogResolution }
    | { ok: false; code: string; message: string }
  >;
}

/**
 * Capability-preserving model projection. The formal catalog keeps profile
 * provenance for enhancement processors; the Agent only needs valid keys,
 * their useful descriptions, targets, and concise degradation diagnostics.
 */
export interface ProjectAgentPerformanceCapabilityCatalogProjectionV1 {
  readonly version: 1;
  readonly characters: readonly {
    readonly characterId: string;
    readonly name: string;
    readonly fieldLevelDegrade: boolean;
    readonly motions: readonly ProjectAgentPerformanceCapabilityKeyV1[];
    readonly expressions: readonly ProjectAgentPerformanceCapabilityKeyV1[];
  }[];
  readonly lookAtTargets: readonly string[];
  readonly reactionTargets: readonly string[];
  readonly diagnostics: readonly {
    readonly code: string;
    readonly message: string;
    readonly characterId?: string;
    readonly key?: string;
  }[];
}

export interface ProjectAgentPerformanceCapabilityKeyV1 {
  readonly key: string;
  readonly description?: string;
}

/**
 * Collapse raw keys plus the duplicated profile/intersection records into one
 * model-visible entry per key. This does not alter the source catalog or the
 * fingerprint used to refresh it.
 */
export function projectPerformanceCapabilityCatalogForAgent(
  catalog: PerformanceCapabilityCatalogV1,
): ProjectAgentPerformanceCapabilityCatalogProjectionV1 {
  return {
    version: 1,
    characters: catalog.characters.map((character) => ({
      characterId: character.characterId,
      name: character.name,
      fieldLevelDegrade: character.fieldLevelDegrade,
      motions: projectCapabilityKeys(character.motions, character.profile?.motions),
      expressions: projectCapabilityKeys(character.expressions, character.profile?.expressions),
    })),
    lookAtTargets: [...catalog.lookAtTargets],
    reactionTargets: [...catalog.reactionTargets],
    diagnostics: catalog.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      ...(diagnostic.characterId ? { characterId: diagnostic.characterId } : {}),
      ...(diagnostic.key ? { key: diagnostic.key } : {}),
    })),
  };
}

export const MAX_AGENT_CAPABILITY_CATALOG_BYTES = 16_384;

interface CapabilityNamespaceSummary {
  readonly prefix: string;
  motionCount: number;
  expressionCount: number;
}

interface CapabilityCharacterSummary {
  readonly characterId: string;
  readonly name: string;
  readonly fieldLevelDegrade: boolean;
  readonly motionCount: number;
  readonly expressionCount: number;
  readonly namespaceCount: number;
  readonly namespaces: CapabilityNamespaceSummary[];
  namespacesTruncated: boolean;
}

/** Namespace is the exact key prefix through its last slash; bare keys use "". */
function summarizeCapabilityNamespaces(character: PerformanceCapabilityCatalogV1['characters'][number]): CapabilityNamespaceSummary[] {
  const namespaces = new Map<string, CapabilityNamespaceSummary>();
  for (const [kind, keys] of [['motionCount', character.motions], ['expressionCount', character.expressions]] as const) {
    for (const key of keys) {
      const prefix = key.slice(0, key.lastIndexOf('/') + 1);
      const entry = namespaces.get(prefix) ?? { prefix, motionCount: 0, expressionCount: 0 };
      entry[kind] += 1;
      namespaces.set(prefix, entry);
    }
  }
  return [...namespaces.values()].sort((a, b) => a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0);
}

/** Never let a model's full motion dictionary become unbounded fixed context. */
export function serializePerformanceCapabilityCatalogForAgent(
  catalog: PerformanceCapabilityCatalogV1,
): string {
  const projection = projectPerformanceCapabilityCatalogForAgent(catalog);
  const full = JSON.stringify(projection);
  const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
  if (byteLength(full) <= MAX_AGENT_CAPABILITY_CATALOG_BYTES) return full;

  const summary = {
    version: 1,
    truncated: true,
    queryTool: 'searchCharacterCapabilities',
    characterCount: catalog.characters.length,
    characters: [] as CapabilityCharacterSummary[],
    diagnostics: catalog.diagnostics.slice(0, 10).map((item) => ({
      code: item.code.slice(0, 120), message: item.message.slice(0, 200),
    })),
    diagnosticCount: catalog.diagnostics.length,
  };
  const pendingNamespaces: { character: CapabilityCharacterSummary; entries: CapabilityNamespaceSummary[] }[] = [];
  // Reserve character identities/counts before spending space on namespaces.
  for (const character of catalog.characters) {
    const namespaces = summarizeCapabilityNamespaces(character);
    const item: CapabilityCharacterSummary = {
      characterId: character.characterId,
      name: character.name.slice(0, 120),
      fieldLevelDegrade: character.fieldLevelDegrade,
      motionCount: character.motions.length,
      expressionCount: character.expressions.length,
      namespaceCount: namespaces.length,
      namespaces: [],
      namespacesTruncated: namespaces.length > 0,
    };
    summary.characters.push(item);
    if (byteLength(JSON.stringify(summary)) > MAX_AGENT_CAPABILITY_CATALOG_BYTES) {
      summary.characters.pop();
      break;
    }
    pendingNamespaces.push({ character: item, entries: namespaces });
  }
  for (const { character, entries } of pendingNamespaces) {
    for (const entry of entries) {
      character.namespaces.push(entry);
      character.namespacesTruncated = character.namespaces.length < entries.length;
      if (byteLength(JSON.stringify(summary)) > MAX_AGENT_CAPABILITY_CATALOG_BYTES) {
        character.namespaces.pop();
        character.namespacesTruncated = true;
        break;
      }
    }
  }
  return JSON.stringify(summary);
}

/**
 * Directly inject the catalog into the system prompt by replacing the slot.
 * Without the slot (legacy prompts), append a bounded catalog section.
 */
export function injectPerformanceCapabilityCatalog(
  systemPrompt: string,
  catalog: PerformanceCapabilityCatalogV1,
): string {
  const json = serializePerformanceCapabilityCatalogForAgent(catalog);
  if (systemPrompt.includes(PROJECT_AGENT_CAPABILITY_CATALOG_SLOT)) {
    return systemPrompt.replace(
      PROJECT_AGENT_CAPABILITY_CATALOG_SLOT,
      `\`\`\`json\n${json}\n\`\`\``,
    );
  }
  return [
    systemPrompt,
    '',
    'Bounded performance capability catalog (host-injected, current target scene):',
    '```json',
    json,
    '```',
  ].join('\n');
}

/** Deterministic fingerprint of a catalog for refresh-on-change decisions. */
export function fingerprintPerformanceCapabilityCatalog(catalog: PerformanceCapabilityCatalogV1): string {
  return JSON.stringify(catalog);
}

function projectCapabilityKeys(
  keys: readonly string[],
  profileKeys: readonly PerformanceProfileKeyEntryV1[] | undefined,
): ProjectAgentPerformanceCapabilityKeyV1[] {
  const descriptions = new Map(
    (profileKeys ?? [])
      .filter((entry) => typeof entry.description === 'string' && entry.description.trim().length > 0)
      .map((entry) => [entry.key, entry.description!.trim()] as const),
  );
  return keys.map((key) => {
    const description = descriptions.get(key);
    return { key, ...(description ? { description } : {}) };
  });
}
