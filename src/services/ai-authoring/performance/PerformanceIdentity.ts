import type {
  PerformanceIdentityResolutionV1,
  PerformanceProfileDiagnostic,
  PerformanceProfileDocumentV1,
  PerformanceProfileKeyEntryV1,
  PerformanceProfileSourceV1,
  ResolvedPerformanceCharacterProfileV1,
  SceneCharacterIdentity,
} from './PerformanceProfileTypes';

/**
 * Unicode normalize + trim + case-fold for exact name/alias identity matching.
 * No fuzzy/substring matching — composite names must be explicit aliases.
 */
export function normalizePerformanceIdentityToken(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

function sceneNameTokens(sceneCharacter: SceneCharacterIdentity): string[] {
  const tokens = [normalizePerformanceIdentityToken(sceneCharacter.name)];
  for (const alias of sceneCharacter.aliases ?? []) {
    tokens.push(normalizePerformanceIdentityToken(alias));
  }
  return tokens.filter((token) => token.length > 0);
}

function toResolved(
  profile: PerformanceProfileDocumentV1,
  character: PerformanceProfileDocumentV1['characters'][number],
  matchKind: ResolvedPerformanceCharacterProfileV1['matchKind'],
  templateId?: string,
): ResolvedPerformanceCharacterProfileV1 {
  return {
    profileId: profile.id,
    profileName: profile.name,
    characterId: character.id,
    aliases: character.aliases ?? [],
    motions: character.motions ?? [],
    expressions: character.expressions ?? [],
    matchKind,
    ...(templateId !== undefined ? { templateId } : {}),
  };
}

/**
 * Merge same-id profiles by priority (higher wins). Different profile ids remain independent sources.
 */
export function mergePerformanceProfileSources(
  sources: readonly PerformanceProfileSourceV1[],
): readonly PerformanceProfileSourceV1[] {
  const byId = new Map<string, PerformanceProfileSourceV1>();
  for (const source of sources) {
    const existing = byId.get(source.profile.id);
    if (!existing || source.priority >= existing.priority) {
      byId.set(source.profile.id, source);
    }
  }
  return [...byId.values()].sort((left, right) => {
    if (right.priority !== left.priority) return right.priority - left.priority;
    return left.profile.id.localeCompare(right.profile.id);
  });
}

/**
 * Resolve specialized performance knowledge for one scene character.
 * 1) exact characterPreset.id === scene character id
 * 2) exact normalized profile alias against scene name / aliases
 *
 * Ambiguity is only when one scene character hits multiple equal-rank candidates.
 * Multiple distinct scene characters each matching their own profile is not ambiguous.
 */
export function resolvePerformanceIdentity(
  sceneCharacter: SceneCharacterIdentity,
  sources: readonly PerformanceProfileSourceV1[],
): PerformanceIdentityResolutionV1 {
  const merged = mergePerformanceProfileSources(sources);
  const presetMatches: ResolvedPerformanceCharacterProfileV1[] = [];
  const nameMatches: ResolvedPerformanceCharacterProfileV1[] = [];
  const sceneTokens = new Set(sceneNameTokens(sceneCharacter));
  const sceneId = sceneCharacter.id;

  for (const source of merged) {
    for (const character of source.profile.characters) {
      if (character.id === sceneId) {
        presetMatches.push(toResolved(source.profile, character, 'preset_id', source.templateId));
        continue;
      }
      const profileTokens = (character.aliases ?? []).map(normalizePerformanceIdentityToken).filter(Boolean);
      const hit = profileTokens.some((token) => sceneTokens.has(token));
      if (!hit) continue;
      nameMatches.push(toResolved(source.profile, character, 'alias', source.templateId));
    }
  }

  const uniqueByCharacter = (items: readonly ResolvedPerformanceCharacterProfileV1[]) => {
    const map = new Map<string, ResolvedPerformanceCharacterProfileV1>();
    for (const item of items) {
      const key = `${item.profileId}::${item.characterId}`;
      if (!map.has(key)) map.set(key, item);
    }
    return [...map.values()];
  };

  const presets = uniqueByCharacter(presetMatches);
  if (presets.length === 1) {
    return { status: 'matched', profile: presets[0]! };
  }
  if (presets.length > 1) {
    return ambiguous(sceneCharacter, presets);
  }

  const names = uniqueByCharacter(nameMatches);
  if (names.length === 1) {
    return { status: 'matched', profile: names[0]! };
  }
  if (names.length > 1) {
    return ambiguous(sceneCharacter, names);
  }

  return { status: 'none' };
}

function ambiguous(
  sceneCharacter: SceneCharacterIdentity,
  candidates: readonly ResolvedPerformanceCharacterProfileV1[],
): PerformanceIdentityResolutionV1 {
  const diagnostic: PerformanceProfileDiagnostic = {
    code: 'ambiguous_identity',
    message:
      `Scene character "${sceneCharacter.id}" matches multiple performance profiles: `
      + candidates.map((candidate) => `${candidate.profileId}/${candidate.characterId}`).join(', '),
    characterId: sceneCharacter.id,
  };
  return {
    status: 'ambiguous',
    candidates,
    diagnostic,
  };
}

/**
 * Intersect profile motion/expression keys with actual model keys.
 * Missing profile keys become `profile_motion_unavailable` / `profile_expression_unavailable` warnings.
 * Model keys not listed in the profile remain available as undescribed generic capabilities.
 */
export function intersectProfileWithModelKeys(
  profile: ResolvedPerformanceCharacterProfileV1,
  model: { readonly motions: readonly string[]; readonly expressions: readonly string[] },
): {
  readonly motions: readonly PerformanceProfileKeyEntryV1[];
  readonly expressions: readonly PerformanceProfileKeyEntryV1[];
  readonly diagnostics: readonly PerformanceProfileDiagnostic[];
} {
  const motionSet = new Set(model.motions);
  const expressionSet = new Set(model.expressions);
  const motions: PerformanceProfileKeyEntryV1[] = [];
  const expressions: PerformanceProfileKeyEntryV1[] = [];
  const diagnostics: PerformanceProfileDiagnostic[] = [];

  for (const entry of profile.motions) {
    if (motionSet.has(entry.key)) {
      motions.push(entry);
    } else {
      diagnostics.push({
        code: 'profile_motion_unavailable',
        message: `Profile motion key "${entry.key}" is not present on the current model`,
        characterId: profile.characterId,
        profileId: profile.profileId,
        key: entry.key,
      });
    }
  }

  for (const entry of profile.expressions) {
    if (expressionSet.has(entry.key)) {
      expressions.push(entry);
    } else {
      diagnostics.push({
        code: 'profile_expression_unavailable',
        message: `Profile expression key "${entry.key}" is not present on the current model`,
        characterId: profile.characterId,
        profileId: profile.profileId,
        key: entry.key,
      });
    }
  }

  return { motions, expressions, diagnostics };
}
