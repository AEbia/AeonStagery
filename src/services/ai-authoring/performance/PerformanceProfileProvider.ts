import {
  intersectProfileWithModelKeys,
  mergePerformanceProfileSources,
  resolvePerformanceIdentity,
} from './PerformanceIdentity';
import type {
  IntersectedProfileKeysV1,
  PerformanceCapabilityCatalogV1,
  PerformanceCapabilityCharacterV1,
  PerformanceIdentityResolutionV1,
  PerformanceProfileDiagnostic,
  PerformanceProfileDocumentV1,
  PerformanceProfileSourceV1,
  ResolvedPerformanceCharacterProfileV1,
  SceneCharacterIdentity,
} from './PerformanceProfileTypes';
import { parsePerformanceProfileDocument } from './PerformanceProfileValidation';

export interface PerformanceProfileProvider {
  /**
   * Resolve specialized performance knowledge for one scene character.
   * Returns none when no profile matches; ambiguous pauses the performance unit.
   */
  resolveCharacter(
    sceneCharacter: SceneCharacterIdentity,
  ): PerformanceIdentityResolutionV1;

  /** Provider version string used for checkpoint invalidation. */
  readonly version: string;

  /** Loaded profile documents after priority merge (for diagnostics / fingerprinting). */
  listProfiles(): readonly PerformanceProfileDocumentV1[];
}

export interface StaticPerformanceProfileProviderOptions {
  readonly sources: readonly PerformanceProfileSourceV1[];
  /** Stable version fingerprint for checkpoint invalidation. */
  readonly version?: string;
}

/**
 * In-memory PerformanceProfileProvider seam implementation.
 * Does not read Live2D model files or stage state — host supplies model keys separately.
 */
export class StaticPerformanceProfileProvider implements PerformanceProfileProvider {
  readonly version: string;

  private readonly sources: readonly PerformanceProfileSourceV1[];

  constructor(options: StaticPerformanceProfileProviderOptions) {
    this.sources = mergePerformanceProfileSources(
      options.sources.map((source) => ({
        ...source,
        profile: parsePerformanceProfileDocument(source.profile),
      })),
    );
    this.version = options.version
      ?? fingerprintSources(this.sources);
  }

  resolveCharacter(sceneCharacter: SceneCharacterIdentity): PerformanceIdentityResolutionV1 {
    return resolvePerformanceIdentity(sceneCharacter, this.sources);
  }

  listProfiles(): readonly PerformanceProfileDocumentV1[] {
    return this.sources.map((source) => source.profile);
  }
}

function fingerprintSources(sources: readonly PerformanceProfileSourceV1[]): string {
  return sources
    .map((source) => JSON.stringify({
      priority: source.priority,
      templateId: source.templateId,
      profile: source.profile,
    }))
    .join('|') || 'empty';
}

export interface BuildPerformanceCapabilityCatalogInput {
  readonly characters: readonly {
    readonly identity: SceneCharacterIdentity;
    readonly motions: readonly string[];
    readonly expressions: readonly string[];
    /** True when the character has no model configured (field-level degrade). */
    readonly fieldLevelDegrade?: boolean;
  }[];
  readonly lookAtTargets?: readonly string[];
  readonly reactionTargets?: readonly string[];
  readonly provider?: PerformanceProfileProvider | null;
}

/**
 * Build the read-only capability catalog for one performance processing unit.
 * Profile motion/expression candidates are intersected with actual model keys.
 */
export function buildPerformanceCapabilityCatalog(
  input: BuildPerformanceCapabilityCatalogInput,
): PerformanceCapabilityCatalogV1 {
  const diagnostics: PerformanceProfileDiagnostic[] = [];
  const characters: PerformanceCapabilityCharacterV1[] = [];
  const provider = input.provider ?? null;

  for (const entry of input.characters) {
    const fieldLevelDegrade = entry.fieldLevelDegrade === true;
    let profile: ResolvedPerformanceCharacterProfileV1 | undefined;
    let intersectedProfile: IntersectedProfileKeysV1 | undefined;

    if (fieldLevelDegrade) {
      diagnostics.push({
        code: 'performance_capabilities_unavailable',
        message: `No Live2D model is configured for character "${entry.identity.id}" — ` +
          'motion/expression generation disabled, other performance fields remain fillable',
        characterId: entry.identity.id,
      });
    }

    if (provider) {
      const resolution = provider.resolveCharacter(entry.identity);
      if (resolution.status === 'ambiguous') {
        diagnostics.push(resolution.diagnostic);
      } else if (resolution.status === 'matched' && !fieldLevelDegrade) {
        const intersection = intersectProfileWithModelKeys(resolution.profile, {
          motions: entry.motions,
          expressions: entry.expressions,
        });
        // Only profile data for keys that pass the intersection may enter the
        // catalog/prompt; unmatched keys are dropped with warnings, and
        // field-level-degrade characters carry no profile data at all.
        profile = {
          ...resolution.profile,
          motions: intersection.motions,
          expressions: intersection.expressions,
        };
        intersectedProfile = {
          motions: intersection.motions,
          expressions: intersection.expressions,
          diagnostics: intersection.diagnostics,
        };
        diagnostics.push(...intersection.diagnostics);
      }
    }

    characters.push({
      characterId: entry.identity.id,
      name: entry.identity.name,
      motions: fieldLevelDegrade ? [] : [...entry.motions],
      expressions: fieldLevelDegrade ? [] : [...entry.expressions],
      fieldLevelDegrade,
      ...(profile ? { profile } : {}),
      ...(intersectedProfile ? { intersectedProfile } : {}),
    });
  }

  return {
    version: 1,
    characters,
    lookAtTargets: input.lookAtTargets ?? [],
    reactionTargets: input.reactionTargets ?? [],
    diagnostics,
  };
}

export type { PerformanceProfileProvider as PerformanceProfileProviderSeam };
