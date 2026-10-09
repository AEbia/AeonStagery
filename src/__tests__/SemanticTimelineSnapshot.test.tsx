/** @vitest-environment jsdom */
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import { SemanticScenePipeline } from '../services/semantic-scene/SemanticScenePipeline';
import { DocumentStore } from '../ui/store/DocumentStore';
import { useSemanticTimelineSnapshot, type SemanticTimelineSnapshot } from '../ui/timeline/useSemanticTimelineSnapshot';

const state = vi.hoisted(() => ({ store: null as unknown as DocumentStore }));
vi.mock('../ui/context/AppContext', () => ({ useDocumentStore: () => state.store }));

const pipeline = new SemanticScenePipeline({ resolveAsset: async (source) => `asset://test/${source}` });
function document(expression?: string): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'snapshot',
    meta: { title: 'Snapshot', characters: [{ id: 'alice', name: 'Alice' }] },
    statements: [{ id: 'line', time: 0, type: 'dialogue', params: { text: 'Hello', durationSeconds: 2 },
      companions: [{ id: 'performance', anchor: 'start', offset: 0, type: 'characterPerformance',
        params: { target: 'alice', motion: '', ...(expression ? { expression } : {}) } }] }],
  };
}

describe('semantic timeline view snapshot', () => {
  beforeEach(() => { state.store = new DocumentStore(); });

  it('shares source, root and companion mappings throughout the tree and refreshes them together', async () => {
    state.store._replaceSemanticScene(await pipeline.processDocument(document()));
    const sourceReads = vi.spyOn(state.store, 'getCurrentSceneDocumentSnapshot');
    const compiledReads = vi.spyOn(state.store, 'getCompiledSceneSnapshot');
    let owner!: SemanticTimelineSnapshot;
    let list!: SemanticTimelineSnapshot;
    let inspector!: SemanticTimelineSnapshot;
    function Inspector({ snapshot }: { snapshot: SemanticTimelineSnapshot }) {
      inspector = useSemanticTimelineSnapshot(snapshot);
      return null;
    }
    function List({ snapshot }: { snapshot: SemanticTimelineSnapshot }) {
      list = useSemanticTimelineSnapshot(snapshot);
      return <Inspector snapshot={list} />;
    }
    function Owner({ unrelated }: { unrelated: string }) {
      owner = useSemanticTimelineSnapshot();
      return <div aria-label={unrelated}><List snapshot={owner} /></div>;
    }
    const { rerender } = render(<Owner unrelated="first render" />);
    const initial = owner;
    expect(list).toBe(owner);
    expect(inspector).toBe(owner);
    expect(sourceReads).toHaveBeenCalledTimes(1);
    expect(compiledReads).toHaveBeenCalledTimes(1);
    const companion = owner.items.find((item) => item.companionId === 'performance')!;
    const root = owner.items.find((item) => item.locator.kind === 'statement')!;
    expect(companion.parentItemId).toBe(root.id);
    expect(owner.itemById.get(companion.id)).toBe(companion);
    expect(owner.actions[owner.items.indexOf(companion)]).toBe(companion.displayAction);

    rerender(<Owner unrelated="another render" />);
    expect(owner).toBe(initial);
    expect(sourceReads).toHaveBeenCalledTimes(1);

    const next = await pipeline.processDocument(document('smile'));
    act(() => { state.store._replaceSemanticScene(next); });
    expect(owner).not.toBe(initial);
    expect(list).toBe(owner);
    expect(inspector).toBe(owner);
    expect(sourceReads).toHaveBeenCalledTimes(2);
    expect(compiledReads).toHaveBeenCalledTimes(2);
    const filled = owner.items.find((item) => item.companionId === 'performance')!;
    expect(filled.id).not.toBe(companion.id);
    expect(filled.locator).toEqual(companion.locator);
    expect(filled.source.params).toMatchObject({ expression: 'smile' });
    expect(companion.source.params).not.toHaveProperty('expression');
  });
});
