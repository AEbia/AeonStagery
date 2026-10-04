/**
 * Redacted scene summary builder for crash reports (ADR-0032).
 *
 * Produces a structural outline of the active scene at crash time — statement
 * counts, duration and a per-statement (kind + start time) outline. It never
 * includes dialogue/script text or character names, honouring the redaction
 * policy while still giving a developer useful context for triage.
 */

import type {
  CrashSceneSummary,
  CrashSceneStatementOutline,
} from '../../api/types/crash';
import type { CurrentSceneDocument } from '../../api/types/semantic-scene';

const MAX_OUTLINE = 50;

export function buildRedactedSceneSummary(
  document: CurrentSceneDocument | null,
): CrashSceneSummary | null {
  if (!document || !Array.isArray(document.statements)) return null;

  const statements = (document.statements ?? []) as Array<{
    id: string;
    time?: unknown;
    type?: unknown;
    params?: Record<string, unknown>;
  }>;

  const outline: CrashSceneStatementOutline[] = statements
    .slice(0, MAX_OUTLINE)
    .map((statement, index) => {
      const params = statement.params ?? {};
      const start = typeof statement.time === 'number' ? statement.time : 0;
      const nextStart =
        index + 1 < statements.length && typeof statements[index + 1].time === 'number'
          ? (statements[index + 1].time as number)
          : undefined;

      const paramDuration =
        typeof params.durationSeconds === 'number' ? params.durationSeconds : undefined;
      const durationSeconds =
        paramDuration ?? (nextStart !== undefined && nextStart > start ? nextStart - start : undefined);

      // Structural references only — never the script/dialogue text. Note:
      // `speaker` (display name) is intentionally excluded; the character id is
      // kept as a structural reference.
      const characterId =
        typeof params.id === 'string'
          ? params.id
          : typeof params.characterId === 'string'
            ? params.characterId
            : typeof params.speakerId === 'string'
              ? params.speakerId
              : undefined;

      return {
        index,
        type: typeof statement.type === 'string' ? statement.type : String(statement.type ?? 'unknown'),
        startSeconds: start,
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        ...(characterId !== undefined ? { characterId } : {}),
      };
    });

  return {
    statementCount: statements.length,
    durationSeconds:
      typeof document.meta?.durationSeconds === 'number' ? document.meta.durationSeconds : null,
    outline,
  };
}
