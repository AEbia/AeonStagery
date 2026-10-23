import { describe, expect, it } from 'vitest';
import { sceneDocumentCodec } from '../services/semantic-scene';
import { sceneStatementCompiler } from '../services/semantic-scene/SceneStatementCompiler';
import type { CurrentSceneDocument } from '../api/types/semantic-scene';

function makeDocument(statements: unknown[]): CurrentSceneDocument {
  return sceneDocumentCodec.parseAndValidate({
    schemaVersion: 4,
    sceneId: 'camera-follow-stop',
    meta: {
      title: 'Camera follow stop',
      characters: [{ id: 'tomori', name: 'Tomori', model: 'figure/tomori/model.json' }],
    },
    statements,
  });
}

describe('scene statement compiler — camera follow stop', () => {
  it('releases follow when a camera statement writes position', () => {
    const compiled = sceneStatementCompiler.compile(makeDocument([
      { id: 'follow_start', time: 1, type: 'camera', params: { mode: 'follow', operation: 'start', target: 'tomori' } },
      { id: 'position', time: 2, type: 'camera', params: { mode: 'move', to: [0.4, 0.6], durationSeconds: 1 } },
      { id: 'follow_again', time: 3, type: 'camera', params: { mode: 'follow', operation: 'start', target: 'tomori' } },
    ]));

    expect(compiled.actions.map((action) => action.action)).toEqual([
      'cameraFollow', 'cameraMotion', 'cameraFollow',
    ]);
  });

  it('releases follow with a dedicated unfollow action instead of resetting the whole camera', () => {
    const compiled = sceneStatementCompiler.compile(makeDocument([
      {
        id: 'follow_start',
        time: 1,
        type: 'camera',
        params: { mode: 'follow', operation: 'start', target: 'tomori' },
      },
      {
        id: 'follow_stop',
        time: 5,
        type: 'camera',
        params: { mode: 'follow', operation: 'stop' },
      },
    ]));

    const stop = compiled.actions.find((action) => action.id.includes('follow_stop'));
    expect(stop).toMatchObject({
      action: 'cameraUnfollow',
      params: {},
    });
  });

  it('uses the stop statement to bound follow without adding a duration to its start', () => {
    const document = makeDocument([
      { id: 'follow_start', time: 1, type: 'camera', params: {
        mode: 'follow', operation: 'start', target: 'tomori',
      } },
      { id: 'follow_stop', time: 3, type: 'camera', params: { mode: 'follow', operation: 'stop' } },
    ]);

    const compiled = sceneStatementCompiler.compile(document);

    expect(compiled.sourceSchemaVersion).toBe(document.schemaVersion);
    expect(compiled.durationSeconds).toBe(3);
    expect(compiled.actions[0].params).not.toHaveProperty('duration');
    expect(compiled.actions).toMatchObject([
      { action: 'cameraFollow', time: 1, params: { characterId: 'tomori' } },
      { action: 'cameraUnfollow', time: 3, params: {} },
    ]);
  });

  it.each(['start', 'stop'])('rejects durationSeconds on follow %s', operation => {
    for (const durationSeconds of [0, 2, -0.25, Number.NaN, Infinity]) {
      expect(() => makeDocument([
        { id: 'follow', time: 1, type: 'camera', params: {
          mode: 'follow', operation, target: 'tomori', durationSeconds,
        } },
      ])).toThrow(/durationSeconds/);
    }
  });

  it('keeps camera reset semantics for explicit reset statements', () => {
    const compiled = sceneStatementCompiler.compile(makeDocument([
      {
        id: 'reset_statement',
        time: 0,
        type: 'camera',
        params: { mode: 'reset', durationSeconds: 1.2, ease: 'smooth' },
      },
    ]));

    expect(compiled.actions[0]).toMatchObject({
      action: 'cameraReset',
      params: { duration: 1.2 },
    });
  });
});
