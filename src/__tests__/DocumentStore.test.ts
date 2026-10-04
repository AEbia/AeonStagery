import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DocumentStore } from '../ui/store/DocumentStore';
import {
  SCENE_SCHEMA_VERSION,
  type CurrentSceneDocument,
  type SemanticSceneBundle,
} from '../api/types/semantic-scene';
import {
  getSceneDocumentCanonicalOrder,
  withSceneDocumentCanonicalOrder,
} from '../services/semantic-scene';
import { sceneDocumentCodec } from '../services/semantic-scene/SceneDocumentCodec';
import { SemanticScenePipeline } from '../services/semantic-scene/SemanticScenePipeline';

function makeSceneDocumentV4(overrides: Partial<CurrentSceneDocument> = {}): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'semantic-scene',
    meta: { title: 'Semantic Scene' },
    statements: [
      {
        id: 'line_1',
        time: 1,
        type: 'dialogue',
        params: {
          text: 'Hello',
          durationSeconds: 2,
        },
      },
    ],
    ...overrides,
  };
}

function firstDialogueText(document: CurrentSceneDocument): string {
  const statement = document.statements[0];
  if (statement.type !== 'dialogue') throw new Error('Expected first statement to be dialogue');
  return statement.params.text;
}

describe('DocumentStore', () => {
  let store: DocumentStore;

  beforeEach(() => {
    store = new DocumentStore();
  });

  it('starts with null semantic snapshots and version 0', () => {
    expect(store.getCurrentSceneDocumentSnapshot()).toBeNull();
    expect(store.getCompiledSceneSnapshot()).toBeNull();
    expect(store.getPreparedSceneSnapshot()).toBeNull();
    expect(store.version).toBe(0);
  });

  it('stores a detached CurrentSceneDocument snapshot without runtime projections', () => {
    const document = makeSceneDocumentV4();

    store._replaceCurrentSceneDocumentSnapshot(document);

    expect(store.version).toBe(1);
    expect(store.getCurrentSceneDocumentSnapshot()).toEqual(document);
    expect(store.getCompiledSceneSnapshot()).toBeNull();
    expect(store.getPreparedSceneSnapshot()).toBeNull();
  });

  it('validates and clones CurrentSceneDocument snapshots before exposing them', () => {
    const document = makeSceneDocumentV4();

    store._replaceCurrentSceneDocumentSnapshot(document);
    (document.statements[0].params as any).text = 'mutated input';
    const firstRead = store.getCurrentSceneDocumentSnapshot()!;
    const secondRead = store.getCurrentSceneDocumentSnapshot()!;

    expect(firstDialogueText(firstRead)).toBe('Hello');
    expect(firstDialogueText(secondRead)).toBe('Hello');
    expect(firstRead).not.toBe(secondRead);
    expect(firstRead.statements).not.toBe(secondRead.statements);
  });

  it('retains canonical order metadata across save-safe document snapshots', () => {
    const document = makeSceneDocumentV4({
      statements: [
        {
          id: 'late',
          time: 6,
          type: 'dialogue',
          params: { text: 'Late', durationSeconds: 1 },
        },
        {
          id: 'early',
          time: 1,
          type: 'dialogue',
          params: { text: 'Early', durationSeconds: 1 },
        },
      ],
    });
    const materialized = withSceneDocumentCanonicalOrder(document, ['early', 'late']);

    store._replaceCurrentSceneDocumentSnapshot(materialized);

    expect(getSceneDocumentCanonicalOrder(store.getCurrentSceneDocumentSnapshot())).toEqual(['early', 'late']);
  });

  it('rejects invalid CurrentSceneDocument snapshots without changing the current snapshot or version', () => {
    const document = makeSceneDocumentV4();
    store._replaceCurrentSceneDocumentSnapshot(document);
    const version = store.version;

    expect(() => store._replaceCurrentSceneDocumentSnapshot({
      ...document,
      schemaVersion: 1 as any,
    })).toThrow(/Unsupported scene schema version/);

    expect(store.version).toBe(version);
    expect(store.getCurrentSceneDocumentSnapshot()).toEqual(document);
  });

  it('_clearCurrentSceneDocumentSnapshot notifies only when a detached snapshot exists', () => {
    let notifications = 0;
    store.subscribe(() => { notifications++; });

    store._clearCurrentSceneDocumentSnapshot();
    expect(notifications).toBe(0);
    expect(store.version).toBe(0);

    store._replaceCurrentSceneDocumentSnapshot(makeSceneDocumentV4());
    store._clearCurrentSceneDocumentSnapshot();

    expect(notifications).toBe(2);
    expect(store.version).toBe(2);
    expect(store.getCurrentSceneDocumentSnapshot()).toBeNull();
  });

  describe('semantic bundle commit', () => {
    async function makeBundle(): Promise<SemanticSceneBundle> {
      const pipeline = new SemanticScenePipeline({
        resolveAsset: async (source) => `asset://localhost/C:/project/${source}`,
      });
      return pipeline.processDocument(makeSceneDocumentV4());
    }

    it('stores a semantic bundle without re-validating the already-validated source', async () => {
      const bundle = await makeBundle();
      // Spy only after the pipeline produced the bundle: the pipeline itself
      // validates, so the store must not add a third pass on top.
      const codecSpy = vi.spyOn(sceneDocumentCodec, 'parseAndValidate');
      try {
        const freshStore = new DocumentStore();
        freshStore._replaceSemanticScene(bundle, 'project/main.scene.json');

        expect(codecSpy).not.toHaveBeenCalled();
        expect(freshStore.getCompiledSceneSnapshot()).toBe(bundle.compiled);
        expect(freshStore.getPreparedSceneSnapshot()).toBe(bundle.prepared);
        expect(freshStore.version).toBe(1);
        expect(freshStore.getCurrentSceneDocumentSnapshot()).toEqual(bundle.source);
      } finally {
        codecSpy.mockRestore();
      }
    });

    it('rejects semantic bundles whose compiled schema or scene id mismatches the source', async () => {
      const bundle = await makeBundle();

      expect(() => store._replaceSemanticScene({
        ...bundle,
        compiled: { ...bundle.compiled, sourceSchemaVersion: SCENE_SCHEMA_VERSION - 1 } as never,
      })).toThrow(/schema/);
      expect(() => store._replaceSemanticScene({
        ...bundle,
        compiled: { ...bundle.compiled, sceneId: 'other-scene' } as never,
      })).toThrow(/scene id/);
      expect(() => store._replaceSemanticScene({
        ...bundle,
        prepared: { ...bundle.prepared, sceneId: 'other-scene' } as never,
      })).toThrow(/scene id/);
    });
  });

});
