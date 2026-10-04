import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import {
  buildPerformanceCapabilityCatalog,
  type PerformanceProfileKeyEntryV1,
  type PerformanceProfileProvider,
} from '../ai-authoring/performance';
import {
  fingerprintPerformanceCapabilityCatalog,
  type ProjectAgentPerformanceCatalogResolver,
} from '../project-agent/ProjectAgentPerformanceCatalog';

/**
 * Raw model capabilities for one character, resolved across the PRIMARY model
 * and every sub-model variant. Keys are deduplicated by value between models
 * (see `createProjectAgentPerformanceCatalogResolver`), and the primary-only
 * sets are tracked so the catalog can suppress profile descriptions for
 * sub-model-only keys.
 */
export interface LoadedCharacterCapabilities {
  /** Key-union of motions across the primary model and all sub-model variants. */
  readonly motions: readonly string[];
  /** Key-union of expressions across the primary model and all sub-model variants. */
  readonly expressions: readonly string[];
  /** Motions present in the PRIMARY model only (sub-model-only keys get no description). */
  readonly primaryMotions?: readonly string[];
  /** Expressions present in the PRIMARY model only (sub-model-only keys get no description). */
  readonly primaryExpressions?: readonly string[];
}

/**
 * Production catalog resolver (ADR0023): the bounded performance catalog for
 * ALL target-scene characters is rebuilt from the current scene character
 * directory (SceneMeta.characters), the character/model binding, the actual
 * Live2D model motions/expressions and the performance profile provider. The
 * profile candidates are intersected with the REAL model keys; characters
 * without a configured model degrade per-field. The fingerprint covers the
 * catalog and the provider version so binding/profile/scene-character changes
 * trigger a fresh injection.
 */
export function createProjectAgentPerformanceCatalogResolver(options: {
  getSceneSnapshot: () => CurrentSceneDocument | null;
  loadModelCapabilities: (
    characters: readonly { id: string; model: string; variantModels?: readonly string[] }[],
  ) => Promise<Readonly<Record<string, LoadedCharacterCapabilities>>>;
  profileProvider: PerformanceProfileProvider | null;
}): ProjectAgentPerformanceCatalogResolver {
  return {
    async resolve() {
      const document = options.getSceneSnapshot();
      if (!document) {
        return {
          ok: false,
          code: 'scene_unavailable',
          message: 'No active scene document is available to build the performance catalog',
        };
      }
      const characters = document.meta.characters ?? [];
      const modelCharacters = characters.filter(
        (character): character is typeof characters[number] & { model: string } =>
          typeof character.model === 'string' && character.model.trim() !== '',
      );
      const loaded = await options.loadModelCapabilities(
        modelCharacters.map((character) => ({
          id: character.id,
          model: character.model,
          variantModels: (character.variants ?? [])
            .map((variant) => variant.model)
            .filter((model): model is string => typeof model === 'string' && model.trim() !== ''),
        })),
      );
      const entries = characters.map((character) => {
        const hasModel = modelCharacters.some((c) => c.id === character.id);
        const capability = loaded[character.id];
        return {
          identity: { id: character.id, name: character.name },
          motions: hasModel ? dedupe(capability?.motions ?? []) : [],
          expressions: hasModel ? dedupe(capability?.expressions ?? []) : [],
          fieldLevelDegrade: !hasModel,
        };
      });
      const lookAtTargets = characters.map((character) => character.id);
      const catalog = buildPerformanceCapabilityCatalog({
        characters: entries,
        lookAtTargets,
        reactionTargets: lookAtTargets,
        provider: options.profileProvider,
      });

      // Profile intersection attaches descriptions to ANY key that matches the
      // profile, including keys that exist only inside a sub-model variant. Per
      // design those variant-only keys must stay raw values (no description) and
      // shared keys must not be duplicated, so the prompt neither fabricates
      // descriptions nor inflates on repeated keys. The formal catalog types are
      // read-only, so the stripped surface is rebuilt as a new catalog value.
      const primaryByCharacter = new Map<string, { motions: Set<string>; expressions: Set<string> }>();
      for (const character of modelCharacters) {
        const capability = loaded[character.id];
        if (!capability) continue;
        primaryByCharacter.set(character.id, {
          motions: new Set(capability.primaryMotions ?? capability.motions),
          expressions: new Set(capability.primaryExpressions ?? capability.expressions),
        });
      }
      const strippedCatalog: typeof catalog = {
        ...catalog,
        characters: catalog.characters.map((character) => {
          const primary = primaryByCharacter.get(character.characterId);
          if (!primary || !character.profile) return character;
          return {
            ...character,
            profile: {
              ...character.profile,
              motions: stripProfileDescriptions(character.profile.motions, primary.motions),
              expressions: stripProfileDescriptions(character.profile.expressions, primary.expressions),
            },
          };
        }),
      };

      const providerVersion = options.profileProvider?.version ?? 'no-profile-provider';
      const fingerprint = `${providerVersion}|${fingerprintPerformanceCapabilityCatalog(strippedCatalog)}`;
      return { ok: true, value: { catalog: strippedCatalog, fingerprint } };
    },
  };
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Keep description-bearing entries for keys that live in the PRIMARY model;
 * reduce sub-model-only keys to their raw `key` so the catalog never invents a
 * description for a model it did not author.
 */
function stripProfileDescriptions(
  entries: readonly PerformanceProfileKeyEntryV1[] | undefined,
  primary: ReadonlySet<string>,
): readonly PerformanceProfileKeyEntryV1[] {
  if (!entries) return [];
  return entries.map((entry) => (primary.has(entry.key) ? entry : { key: entry.key }));
}
