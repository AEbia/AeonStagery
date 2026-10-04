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
