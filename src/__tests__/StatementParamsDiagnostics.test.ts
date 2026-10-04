import { describe, expect, it } from 'vitest';
import { sceneStatementDefinitionRegistry } from '../services/semantic-scene/SceneStatementDefinitionRegistry';

/**
 * Agent-facing diagnostics for statement params (journal-derived fix): the
 * Agent previously learned one fact per failed write ("Unknown field at ..."),
 * so a wrong guess cost a full round trip. The parser now reports the whole
 * allowed/required field set so the next attempt converges in one retry.
 */
describe('statement params parse diagnostics', () => {
  it('lists the allowed fields when a param field is unknown', () => {
    expect(() =>
      sceneStatementDefinitionRegistry.parseParams(
        'environmentLayer',
        { background: '@mount/library/background/x.png' },
        'statement.params',
      ),
    ).toThrow(
      /Unknown field at statement\.params\.background\. Allowed fields: mode, layerId, file, image, position, scale, rotation, opacity, z, zIndex, durationSeconds, ease, transition/,
    );
  });

  it('reports a missing required field instead of a misleading empty-string error', () => {
    expect(() =>
      sceneStatementDefinitionRegistry.parseParams('environmentLayer', { mode: 'set' }, 'statement.params'),
    ).toThrow(/Missing required field at statement\.params\.layerId/);
  });

  it('keeps the enum hint for invalid mode values', () => {
    expect(() =>
      sceneStatementDefinitionRegistry.parseParams(
        'characterPresence',
        { mode: 'set', id: '1' },
        'statement.params',
      ),
    ).toThrow(/Invalid value at statement\.params\.mode: "set"\. Expected enter, exit/);
  });

  it('covers the audio family the journal session never completed', () => {
    expect(() =>
      sceneStatementDefinitionRegistry.parseParams('audio', { bgm: 'x' }, 'statement.params'),
    ).toThrow(/Missing required field at statement\.params\.role/);
  });
});
