import type { AgentPaginationMeta, AgentToolError } from '../../api/types/project-agent';
import { normalizeNonNegativeInt, normalizePositiveInt } from './ProjectAgentPathRules';

export const MAX_AGENT_CAPABILITY_PAGE_BYTES = 16_384;

interface CapabilityTextEntry {
  readonly key: string;
  readonly description?: string;
}

/** Plain text searches keys/descriptions; glob text matches an entire key. */
function createCapabilityTextMatcher(text: string): (entry: CapabilityTextEntry) => boolean {
  if (!text) return () => true;
  if (!text.includes('*') && !text.includes('?')) {
    return (entry) => entry.key.toLowerCase().includes(text)
      || (entry.description?.toLowerCase().includes(text) ?? false);
  }
  const pattern = Array.from(text);
  return (entry) => {
    const key = Array.from(entry.key.toLowerCase());
    let patternIndex = 0;
    let keyIndex = 0;
    let starIndex = -1;
    let starEnd = 0;
    // Remember only the latest star's expansion. This avoids translating
    // user input into a regex with potentially exponential backtracking.
    while (keyIndex < key.length) {
      if (pattern[patternIndex] === '?' || (pattern[patternIndex] !== '*' && pattern[patternIndex] === key[keyIndex])) {
        patternIndex += 1;
        keyIndex += 1;
      } else if (pattern[patternIndex] === '*') {
        starIndex = patternIndex;
        patternIndex += 1;
        starEnd = keyIndex;
      } else if (starIndex >= 0) {
        patternIndex = starIndex + 1;
        starEnd += 1;
        keyIndex = starEnd;
      } else {
        return false;
      }
    }
    while (pattern[patternIndex] === '*') patternIndex += 1;
    return patternIndex === pattern.length;
  };
}

export function normalizeCapabilityQuery(input: { text?: string; offset?: number; limit?: number }):
  | { ok: true; text: string; offset: number; limit: number; capped: boolean;
      matches: (entry: CapabilityTextEntry) => boolean }
  | { ok: false; error: AgentToolError } {
  if (input.text !== undefined && typeof input.text !== 'string') {
    return { ok: false, error: { code: 'invalid_arguments', message: 'text must be a string', retryable: false } };
  }
  const offset = normalizeNonNegativeInt(input.offset, 0, 'offset');
  if (typeof offset !== 'number') return { ok: false, error: offset };
  const limit = normalizePositiveInt(input.limit, 30, 'limit');
  if (typeof limit !== 'number') return { ok: false, error: limit };
  const text = input.text?.trim().toLowerCase() ?? '';
  return { ok: true, text, offset, limit: Math.min(limit, 100), capped: limit > 100,
    matches: createCapabilityTextMatcher(text) };
}

/** Preserve exact keys; oversized entries fail explicitly instead of creating a stuck cursor. */
export function takeCapabilityPage<T>(
  entries: readonly T[], query: { offset: number; limit: number; capped: boolean },
): { ok: true; entries: T[]; page: AgentPaginationMeta } | { ok: false; error: AgentToolError } {
  const selected: T[] = [];
  let usedBytes = 512; // Page envelope, counts and duplicated outer pagination metadata.
  const requested = entries.slice(query.offset, query.offset + query.limit);
  for (const entry of requested) {
    const bytes = new TextEncoder().encode(JSON.stringify(entry)).byteLength + 1;
    if (usedBytes + bytes > MAX_AGENT_CAPABILITY_PAGE_BYTES) {
      if (selected.length === 0) {
        return { ok: false, error: { code: 'result_too_large', message: 'A capability entry exceeds the safe page capacity; narrow the query', retryable: false } };
      }
      break;
    }
    selected.push(entry);
    usedBytes += bytes;
  }
  const nextOffset = query.offset + selected.length;
  return {
    ok: true,
    entries: selected,
    page: {
      total: entries.length,
      nextOffset,
      hasMore: nextOffset < entries.length,
      truncated: query.capped || selected.length < requested.length,
    },
  };
}
