import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION } from '../api/types/semantic-scene';
import { sceneDocumentCodec, sceneStatementDefinitionRegistry } from '../services/semantic-scene';
import { deriveTimelineMaxTimeSeconds } from '../ui/timeline/timelineMaxTime';

function parseStatements(statements: unknown[]) {
  return sceneDocumentCodec.parseAndValidate({
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'timeline-max-time',
    meta: { title: 'Timeline max time' },
    statements,
  });
}

describe('deriveTimelineMaxTimeSeconds', () => {
  it('uses only real statement extents, not derived lifecycle open ends', () => {
    const document = parseStatements([
      {
        id: 'enter-a',
        time: 2,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'A', durationSeconds: 0.5 },
      },
    ]);

    let statementExtentEnd = document.meta.durationSeconds ?? 0;
    for (const statement of document.statements) {
      statementExtentEnd = Math.max(
        statementExtentEnd,
        statement.time + sceneStatementDefinitionRegistry.temporalExtent(statement),
      );
    }

    // Open start extent is only start.time + transition, never a synthetic scene-end.
    expect(statementExtentEnd).toBe(2.5);

    const maxTime = deriveTimelineMaxTimeSeconds(statementExtentEnd);
    expect(maxTime).toBe(Math.max(30, statementExtentEnd) + 5);
    expect(maxTime).toBe(35);
  });

  it('keeps a minimum padded length', () => {
    expect(deriveTimelineMaxTimeSeconds(0)).toBe(35);
    expect(deriveTimelineMaxTimeSeconds(40)).toBe(45);
  });
});
