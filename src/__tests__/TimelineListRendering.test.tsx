/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCENE_SCHEMA_VERSION } from '../api/types/semantic-scene';
import { sceneDocumentCodec, sceneStatementCompiler } from '../services/semantic-scene';
import { TimelineListView, type TimelineListViewProps } from '../ui/timeline/TimelineListView';
import { readSemanticTimelineSnapshot } from '../ui/timeline/useSemanticTimelineSnapshot';

const state = vi.hoisted(() => {
  const store = {
    version: 1, document: null as any, compiled: null as any,
    subscribe: () => () => {},
    getCurrentSceneDocumentSnapshot() { return this.document; },
    getCompiledSceneSnapshot() { return this.compiled; },
  };
  return {
    store,
    renders: new Map<string, number>(),
    authoring: { author: vi.fn(), authorTransaction: vi.fn(), undo: vi.fn(), redo: vi.fn() },
    playback: { getCurrentTime: () => 0, seek: vi.fn(), play: vi.fn() },
    settings: { workbenchTimelineLayoutMode: 'list', workbenchDialogueFlowMode: 'auto' },
  };
});
let observers: Map<Element, ResizeObserverCallback>;
vi.mock('../ui/context/AppContext', () => ({
  useDocumentStore: () => state.store,
  usePlaybackAdapter: () => state.playback,
  useSemanticAuthoringService: () => state.authoring,
  useOptionalApp: () => null,
  useIsCollaborationUndoDisabled: () => false,
  useCollaborationStatus: () => 'disconnected',
  useCollaborationPresence: () => ({ peers: [] }),
}));
vi.mock('../ui/SettingsStore', () => ({
  useSettings: () => ({ settings: state.settings, setSetting: vi.fn() }),
}));
vi.mock('../ui/timeline/StatementQuickControls', () => ({
  StatementQuickControls: ({ item }: any) => {
    state.renders.set(item.id, (state.renders.get(item.id) ?? 0) + 1);
    return <textarea aria-label={`Draft ${item.source.id}`} defaultValue={item.source.params.text} />;
  },
}));
vi.mock('../ui/timeline/ActionInspector', () => ({
  ActionInspector: ({ selectedActionIds }: any) => <div data-testid="detail">{Object.keys(selectedActionIds)[0]}</div>,
}));

beforeEach(() => {
  observers = new Map();
  state.renders.clear();
  state.store.document = sceneDocumentCodec.parseAndValidate({
    schemaVersion: SCENE_SCHEMA_VERSION, sceneId: 'render-cost', meta: { title: 'Render cost', characters: [] },
    statements: Array.from({ length: 20 }, (_, index) => ({
      id: `line-${index}`, type: 'dialogue', time: index,
      params: { text: `Line ${index}`, speaker: `Speaker ${index}`, durationSeconds: 1 },
    })),
  });
  state.store.compiled = sceneStatementCompiler.compile(state.store.document);
  vi.stubGlobal('ResizeObserver', class {
    private elements: Element[] = [];
    constructor(private callback: ResizeObserverCallback) {}
    observe(element: Element) { this.elements.push(element); observers.set(element, this.callback); }
    disconnect() { this.elements.forEach((element) => observers.delete(element)); }
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function props(): TimelineListViewProps {
  return {
    sceneData: { sceneId: 'render-cost', meta: state.store.document.meta, timeline: [] },
    semanticSnapshot: readSemanticTimelineSnapshot(state.store), selectedActionIds: {},
    setSelectedIds: vi.fn(), addAction: vi.fn(), handleSelect: vi.fn(),
    setCurrentTime: vi.fn(), loadExample: vi.fn(async () => true),
  };
}

describe('list interaction render cost', () => {
  it('updates animated row geometry without rerendering neighboring content', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const view = render(<TimelineListView {...props()} />);
    fireEvent.click(screen.getAllByRole('button', { name: '展开详情' })[0]);
    const first = view.container.querySelector('[data-timeline-virtual-row]')!;
    const untouched = state.store.compiled.actions[1].id;
    const before = state.renders.get(untouched);
    for (const height of [120, 170, 240]) {
      act(() => observers.get(first)?.([{
        target: first, borderBoxSize: [{ blockSize: height, inlineSize: 500 }],
      } as unknown as ResizeObserverEntry], {} as ResizeObserver));
      act(() => frames.splice(0).forEach((callback) => callback(0)));
    }
    expect(state.renders.get(untouched)).toBe(before);
    const following = view.container.querySelectorAll('[data-timeline-virtual-row]')[1] as HTMLElement;
    expect(following.style.top).toBe('240px');
  });
  it('retains row memoization with new parent handlers and invokes the latest handler', () => {
    const initial = props();
    const view = render(<TimelineListView {...initial} />);
    const untouched = state.store.compiled.actions[1].id;
    const before = state.renders.get(untouched);
    const latestSeek = vi.fn();
    view.rerender(<TimelineListView {...initial} setCurrentTime={latestSeek}
      handleSelect={vi.fn()} setSelectedIds={vi.fn()} />);
    expect(state.renders.get(untouched)).toBe(before);
    fireEvent.click(screen.getAllByRole('button', { name: '播放到此句' })[1]);
    expect(latestSeek).toHaveBeenCalledWith(1);
    expect(initial.setCurrentTime).not.toHaveBeenCalled();
  });
  it('does not rerender unrelated mounted rows when expanding and collapsing a row', () => {
    const view = render(<TimelineListView {...props()} />);
    const untouched = state.store.compiled.actions[1].id;
    const before = state.renders.get(untouched);
    fireEvent.click(screen.getAllByRole('button', { name: '展开详情' })[0]);
    expect(screen.getByTestId('detail')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '折叠详情' }));
    expect(view.container.querySelector('.inspector-workspace__detail')).toBeNull();
    expect(state.renders.get(untouched)).toBe(before);
  });

  it('does not rerender unrelated rows when selecting a row or clearing its reveal highlight', () => {
    vi.useFakeTimers();
    try {
      const initial = props();
      const view = render(<TimelineListView {...initial} />);
      const untouched = state.store.compiled.actions[2].id;
      const before = state.renders.get(untouched);
      view.rerender(<TimelineListView {...initial} selectedActionIds={{ [state.store.compiled.actions[0].id]: true }} />);
      expect(screen.getByTestId('detail')).toBeTruthy();
      act(() => vi.advanceTimersByTime(250));
      expect(state.renders.get(untouched)).toBe(before);
    } finally { vi.useRealTimers(); }
  });
});
