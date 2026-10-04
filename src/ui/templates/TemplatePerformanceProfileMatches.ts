import { resolvePerformanceIdentity } from '../../services/ai-authoring/performance/PerformanceIdentity';
import type {
  PerformanceProfileSourceV1,
  SceneCharacterIdentity,
} from '../../services/ai-authoring/performance/PerformanceProfileTypes';

export interface TemplateCharacterMatch {
  readonly status: 'matched' | 'none' | 'ambiguous';
  readonly label: string;
}

/** Invert the production scene-to-profile resolver for the template editor. */
export function getTemplateCharacterMatches(
  templateId: string,
  profileId: string,
  sceneCharacters: readonly SceneCharacterIdentity[],
  sources: readonly PerformanceProfileSourceV1[],
): ReadonlyMap<string, TemplateCharacterMatch> {
  const matches = new Map<string, SceneCharacterIdentity[]>();
  const conflicts = new Set<string>();
  for (const sceneCharacter of sceneCharacters) {
    const resolution = resolvePerformanceIdentity(sceneCharacter, sources);
    if (resolution.status === 'none') continue;
    const candidates = resolution.status === 'matched' ? [resolution.profile] : resolution.candidates;
    for (const candidate of candidates) {
      if (candidate.templateId !== templateId || candidate.profileId !== profileId) continue;
      if (resolution.status === 'ambiguous') conflicts.add(candidate.characterId);
      const characters = matches.get(candidate.characterId) ?? [];
      characters.push(sceneCharacter);
      matches.set(candidate.characterId, characters);
    }
  }
  return new Map([...matches].map(([id, characters]) => [id,
    conflicts.has(id) || characters.length > 1
      ? { status: 'ambiguous', label: '匹配冲突' }
      : { status: 'matched', label: `已匹配：${characters[0]!.name || characters[0]!.id}` },
  ]));
}

export const UNMATCHED_TEMPLATE_CHARACTER: TemplateCharacterMatch = { status: 'none', label: '未匹配' };
