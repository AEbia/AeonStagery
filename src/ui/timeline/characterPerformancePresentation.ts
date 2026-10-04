import type { TimelineAction } from './semanticTimelineTypes';

/**
 * Presentation helpers for the characterPerformance family (ADR-0022).
 *
 * The AI prose pipeline materializes performance companions whose source
 * `target` is the literal `$speaker` token; the read model resolves that token
 * to the parent dialogue speaker id (`resolvedSpeakerId`). These helpers keep
 * every author-facing surface (inspector binding select, model pickers)
 * consistent with that auto-binding.
 */

export interface CharacterPerformanceTargetSelectOption {
  readonly value: string;
  readonly label: string;
}

export interface CharacterPerformanceTargetSelectModel {
  /** Value handed to the FormSelect: the speaker token or a real character id. */
  readonly value: string;
  readonly options: readonly CharacterPerformanceTargetSelectOption[];
}

/**
 * Builds the "绑定角色" select model for a characterPerformance target.
 *
 * - An unbound `$speaker` placeholder displays as "当前说话人（<name>）" and
 *   keeps the speaker token as its value, so re-selecting it never destroys
 *   the ADR-0022 auto-binding.
 * - The empty "旁白" option is deliberately omitted: an empty target is not a
 *   valid performance target and would permanently unbind the placeholder.
 * - Root statements without a resolvable parent speaker never get the
 *   `$speaker` option (`$speaker` is only legal inside a dialogue companion).
 */
export function buildCharacterPerformanceTargetSelect(input: {
  readonly rawTarget: unknown;
  readonly resolvedSpeakerId: string | undefined;
  readonly characters: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}): CharacterPerformanceTargetSelectModel {
  const rawTarget = typeof input.rawTarget === 'string' ? input.rawTarget : '';
  const canUseSpeakerToken = rawTarget === '$speaker' || input.resolvedSpeakerId !== undefined;
  const speakerName = input.resolvedSpeakerId
    ? input.characters.find((character) => character.id === input.resolvedSpeakerId)?.name
    : undefined;

  const options: CharacterPerformanceTargetSelectOption[] = [
    ...(canUseSpeakerToken
      ? [{
          value: '$speaker',
          label: speakerName ? `当前说话人（${speakerName}）` : '当前说话人',
        }]
      : []),
    ...input.characters.map((character) => ({
      value: character.id,
      label: `${character.name}（ID: ${character.id}）`,
    })),
  ];

  const value = rawTarget === '$speaker'
    ? '$speaker'
    : rawTarget === '' && input.resolvedSpeakerId !== undefined
      ? '$speaker'
      : rawTarget;

  return { value, options };
}

/**
 * Resolves the character whose Live2D motion/expression catalog should back
 * the performance pickers. A bound placeholder uses its real `target`; an
 * unbound `$speaker` placeholder falls back to the resolved parent speaker.
 */
export function resolveCharacterPerformanceTargetCharId(
  action: TimelineAction,
  resolvedSpeakerId: string | undefined,
): string | undefined {
  // Compiled outputs carry the resolved runtime id; prefer it when present.
  const runtimeId = typeof action.params?.id === 'string' && action.params.id
    ? action.params.id
    : undefined;
  if (runtimeId) return runtimeId;
  const params = (action.sourceParams ?? action.params) as Record<string, unknown> | undefined;
  const rawTarget = typeof params?.target === 'string' ? params.target : undefined;
  if (rawTarget && rawTarget !== '$speaker') return rawTarget;
  return resolvedSpeakerId;
}
