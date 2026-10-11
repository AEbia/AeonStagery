import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../../api/types/semantic-scene';
import { sceneDocumentCodec } from '../../services/semantic-scene';

// Parse a fresh document on each call so edits never leak between scenarios.
export function createTimelineSceneDocument({
  sceneId = 'inline-details',
  meta = { title: 'Inline details', characters: [{ id: 'alice', name: 'Alice' }] },
  statements,
}: {
  sceneId?: string;
  meta?: Record<string, unknown>;
  statements: unknown[];
}): CurrentSceneDocument {
  return sceneDocumentCodec.parseAndValidate({
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId,
    meta,
    statements,
  });
}

export function createInlineInspectorDocument(): CurrentSceneDocument {
  return createTimelineSceneDocument({
    sceneId: 'test-inline-inspector-scene',
    meta: {
      title: 'Inline Inspector Scene',
      characters: [
        { id: 'alice', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
      ],
    },
    statements: [
      {
        id: 'dlg-1',
        time: 0,
        type: 'dialogue',
        params: { speakerId: 'alice', speaker: 'Alice', text: '你好，这是第一句台词。', durationSeconds: 2 },
      },
      {
        id: 'camera-1',
        time: 2,
        type: 'camera',
        params: { mode: 'shake', intensity: 1.5, durationSeconds: 1.0 },
      },
      {
        id: 'dlg-2',
        time: 3,
        type: 'dialogue',
        params: { speakerId: 'bob', speaker: 'Bob', text: '第二句台词在此。', durationSeconds: 2.5 },
      },
    ],
  });
}
