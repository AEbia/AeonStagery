import type {
  PerformanceCapabilityCatalogV1,
  PerformanceProfileKeyEntryV1,
} from '../ai-authoring/performance/PerformanceProfileTypes';

/**
 * System-prompt slot where the host injects the bounded performance catalog
 * (ADR0023). The catalog is the ONLY fixed context exception: it is injected
 * directly, never registered as an Agent read tool, and never a gate bypass.
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

/** Serialize the compact projection once for prompt injection and diagnostics. */
export function serializePerformanceCapabilityCatalogForAgent(
  catalog: PerformanceCapabilityCatalogV1,
): string {
  return JSON.stringify(projectPerformanceCapabilityCatalogForAgent(catalog));
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
