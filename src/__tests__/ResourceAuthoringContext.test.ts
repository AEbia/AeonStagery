import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import { completeResourceAuthoringContext } from '../services/resource-authoring';

const document: CurrentSceneDocument = {
  schemaVersion: SCENE_SCHEMA_VERSION,
  sceneId: 'context-test',
  meta: { title: 'Context Test', characters: [] },
  statements: [
    { id: 'enter', time: 1, type: 'characterPresence', params: { mode: 'enter', id: 'soyo', variant: 'winter' } },
    { id: 'change', time: 5, type: 'characterPresence', params: { mode: 'enter', id: 'soyo', model: 'figure/soyo/models/summer/model.model3.json' } },
    { id: 'exit', time: 9, type: 'characterPresence', params: { mode: 'exit', id: 'soyo' } },
  ],
};

describe('resource authoring context projection', () => {
  it('projects the latest active outfit at the insertion time', () => {
    expect(completeResourceAuthoringContext(document, { kind: 'voice', ownerId: 'soyo', time: 4 })).toEqual({
      kind: 'voice', ownerId: 'soyo', outfitId: 'winter',
    });
    expect(completeResourceAuthoringContext(document, { kind: 'voice', ownerId: 'soyo', time: 6 })).toEqual({
      kind: 'voice', ownerId: 'soyo', outfitId: 'summer',
    });
  });

  it('clears outfit after exit and respects an explicit picker scope', () => {
    expect(completeResourceAuthoringContext(document, { kind: 'voice', ownerId: 'soyo', time: 10 })).toEqual({
      kind: 'voice', ownerId: 'soyo',
    });
    expect(completeResourceAuthoringContext(document, { kind: 'live2dModel', ownerId: 'soyo', outfitId: 'stage', time: 10 })).toEqual({
      kind: 'live2dModel', ownerId: 'soyo', outfitId: 'stage',
    });
  });
});
