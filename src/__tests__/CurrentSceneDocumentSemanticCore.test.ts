import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  SCENE_SCHEMA_VERSION,
  type CurrentSceneDocument,
} from '../api/types/semantic-scene';
import {
  buildSemanticSceneLineView,
  SemanticScenePipeline,
  validateSemanticSceneStructure,
} from '../services/semantic-scene';
import { DocumentStore } from '../ui/store/DocumentStore';

function makeCurrentDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'current-semantic-core',
    meta: {
      title: 'Current semantic core',
      characters: [{ id: 'alice', name: 'Alice' }],
    },
    statements: [{
      id: 'alice-enters',
      time: 0,
      type: 'characterPresence',
      params: {
        mode: 'enter',
        id: 'alice',
        model: 'figure/alice.model3.json',
      },
    }],
  };
}

describe('current Scene Document semantic core contract', () => {
  it('validates, compiles, projects, prepares, and stores through the current contract', async () => {
    const document = makeCurrentDocument();
    const pipeline = new SemanticScenePipeline({
      resolveAsset: async (source) => `asset://project/${source}`,
    });

    expect(validateSemanticSceneStructure(document)).toEqual([]);
    expect(buildSemanticSceneLineView(document)).toMatchObject({
      totalLines: 1,
      lines: [expect.objectContaining({ type: 'characterPresence' })],
    });

    const bundle = await pipeline.processDocument(document);
    expectTypeOf(bundle.source).toEqualTypeOf<CurrentSceneDocument>();
    expect(bundle.compiled.actions[0]).toMatchObject({
      action: 'addCharacter',
      params: { id: 'alice', model: 'figure/alice.model3.json' },
    });
    expect(bundle.prepared.actions[0].params.model).toEqual({
      source: 'figure/alice.model3.json',
      runtimeUri: 'asset://project/figure/alice.model3.json',
    });

    const store = new DocumentStore();
    store._replaceSemanticScene(bundle);
    expect(store.getCurrentSceneDocumentSnapshot()).toEqual(document);
    expect(store.getCompiledSceneSnapshot()).toBe(bundle.compiled);
    expect(store.getPreparedSceneSnapshot()).toBe(bundle.prepared);
  });
});
