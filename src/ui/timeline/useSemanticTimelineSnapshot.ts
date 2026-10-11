import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { CompiledScene, CurrentSceneDocument } from '../../api/types/semantic-scene';
import { useDocumentStore } from '../context/AppContext';
import type { ReadonlyDocumentStore } from '../store/DocumentStore';
import { buildSemanticTimelineReadModel, type SemanticTimelineReadModelItem } from './semanticTimelineReadModel';
import type { TimelineAction } from './semanticTimelineTypes';

export interface SemanticTimelineSnapshot {
  readonly document: CurrentSceneDocument | null;
  readonly compiled: CompiledScene | null;
  readonly items: SemanticTimelineReadModelItem[];
  readonly actions: TimelineAction[];
  readonly itemById: ReadonlyMap<string, SemanticTimelineReadModelItem>;
}

export function readSemanticTimelineSnapshot(
  store: Pick<ReadonlyDocumentStore, 'getCurrentSceneDocumentSnapshot' | 'getCompiledSceneSnapshot'>,
): SemanticTimelineSnapshot {
  const document = store.getCurrentSceneDocumentSnapshot();
  const compiled = store.getCompiledSceneSnapshot();
  const items = buildSemanticTimelineReadModel(document, compiled);
  return {
    document,
    compiled,
    items,
    actions: items.map((item) => item.displayAction),
    itemById: new Map(items.map((item) => [item.id, item])),
  };
}

/** The view owner reads once; descendants receive the same source and display snapshot. */
export function useSemanticTimelineSnapshot(provided?: SemanticTimelineSnapshot): SemanticTimelineSnapshot {
  const store = useDocumentStore();
  const subscribe = useCallback((listener: () => void) => provided
    ? () => {}
    : store.subscribe?.(listener) ?? (() => {}), [provided, store]);
  const getVersion = useCallback(() => provided ? 0 : store.version, [provided, store]);
  const version = useSyncExternalStore(subscribe, getVersion);
  return useMemo(() => provided ?? readSemanticTimelineSnapshot(store), [provided, store, version]);
}
