/**
 * @vitest-environment jsdom
 *
 * 剧本动作优先（list）模式：在轨道上选中一个语句块时，右侧语句列表必须
 * 「跳转到该语句并展开」。列表行是虚拟化的，屏幕外的行根本没有挂载，
 * 所以既要滚动到目标行，也要让它内联展开。
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCENE_SCHEMA_VERSION } from '../api/types/semantic-scene';
import { sceneDocumentCodec, sceneStatementCompiler } from '../services/semantic-scene';
import { TimelineListView } from '../ui/timeline/TimelineListView';

const state = vi.hoisted(() => ({
  document: null as any,
  compiledScene: null as any,
  author: vi.fn(async (_intent: unknown) => ({})),
  layoutMode: 'list' as 'list' | 'tracks',
}));

vi.mock('../ui/context/AppContext', () => ({
  useApp: () => ({
    stores: { editor: { setCopyBuffer: vi.fn(), setCustomMotionEditorActionId: vi.fn() } },
    services: { semanticAuthoring: { author: state.author } },
  }),
  useOptionalApp: () => null,
  useCharacterAdapter: () => ({
    getModelDataFromPath: vi.fn(async () => ({ motions: [], expressions: [] })),
    playMotion: vi.fn(), stopAllMotions: vi.fn(), setExpression: vi.fn(),
  }),
  usePlaybackAdapter: () => ({ getCurrentTime: () => 0, subscribeTime: () => () => {}, seek: vi.fn(), play: vi.fn() }),
  useDocumentStore: () => ({
    version: 1, filePath: null, subscribe: () => () => {},
    getCurrentSceneDocumentSnapshot: () => state.document,
    getCompiledSceneSnapshot: () => state.compiledScene,
  }),
  useSemanticAuthoringService: () => ({
    author: state.author,
    authorTransaction: async (build: any) => { for (const intent of build(state.document)) await state.author(intent); },
    undo: vi.fn(), redo: vi.fn(),
  }),
  useProjectWorkspaceService: () => undefined,
  useIsCollaborationUndoDisabled: () => false,
  useCollaborationStatus: () => 'disconnected',
  useCollaborationPresence: () => ({ peers: [] }),
  useSceneAssetService: () => undefined,
  useResourceAuthoringService: () => undefined,
}));
vi.mock('../ui/store/storeHooks', () => ({
  useSemanticDocument: () => ({ document: state.document, filePath: null }),
  useValidationIssues: () => ({ issues: [] }),
  useCustomMotionEditorActionId: () => null,
}));
vi.mock('../ui/SettingsStore', () => ({
  useSettings: () => ({
    settings: { workbenchTimelineLayoutMode: state.layoutMode, workbenchDialogueFlowMode: 'auto' },
    setSetting: vi.fn(),
  }),
  getDefaultDialogueDurationSeconds: () => 2,
}));
vi.mock('../ui/timeline/ActionInspector', () => ({
  ActionInspector: ({ selectedActionIds }: any) => (
    <div data-testid="inline-action-inspector" data-action-id={Object.keys(selectedActionIds)[0]} />
  ),
}));

const ROW_COUNT = 40;
const ROW_ESTIMATE = 160;
const VIEWPORT_HEIGHT = 500;

let animationFrames: Array<FrameRequestCallback>;

function load() {
  state.document = sceneDocumentCodec.parseAndValidate({
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'reveal-scene',
    meta: { title: 'Reveal', characters: [] },
    statements: Array.from({ length: ROW_COUNT }, (_, index) => ({
      id: `line-${index}`,
      type: 'dialogue',
      time: index,
      params: { text: `S${index}`, speaker: `S${index}`, durationSeconds: 1 },
    })),
  });
  state.compiledScene = sceneStatementCompiler.compile(state.document);
}

/** Titles of the rows the virtualization window has mounted. */
function mountedTitles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.timeline-item__title')).map((node) => node.textContent ?? '');
}

function scrollFrame(view: ReturnType<typeof render>) {
  const scrollContainer = view.container.querySelector('.timeline-list-scroll') as HTMLElement;
  fireEvent.scroll(scrollContainer);
  act(() => { animationFrames.splice(0).forEach((frame) => frame(0)); });
  return scrollContainer;
}

function renderList(selectedActionIds: Record<string, boolean> = {}) {
  return render(<TimelineListView
    sceneData={{ sceneId: state.document.sceneId, meta: state.document.meta, timeline: [] }}
    selectedActionIds={selectedActionIds}
    setSelectedIds={vi.fn()}
    addAction={vi.fn()}
    handleSelect={vi.fn()}
    setCurrentTime={vi.fn()}
    loadExample={vi.fn(async () => true)}
  />);
}

/** Select one statement the way clicking its block on the track does. */
function selectOnTrack(view: ReturnType<typeof render>, index: number | null) {
  const before = view.container.querySelector('.timeline-list-scroll') as HTMLElement;
  Object.defineProperty(before, 'clientHeight', { configurable: true, value: VIEWPORT_HEIGHT });
  view.rerender(<TimelineListView
    sceneData={{ sceneId: state.document.sceneId, meta: state.document.meta, timeline: [] }}
    selectedActionIds={index === null ? {} : { [state.compiledScene.actions[index].id]: true }}
    setSelectedIds={vi.fn()}
    addAction={vi.fn()}
    handleSelect={vi.fn()}
    setCurrentTime={vi.fn()}
    loadExample={vi.fn(async () => true)}
  />);
  // A programmatic scrollTop change reaches the list through a scroll event.
  return scrollFrame(view);
}

beforeEach(() => {
  animationFrames = [];
  state.layoutMode = 'list';
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => animationFrames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  vi.stubGlobal('PointerEvent', MouseEvent);
  state.author.mockClear();
  load();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Track selection reveals the statement in the script list', () => {
  it('switches track selections without height animations or retaining the previous inspector', () => {
    const animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }));
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    try {
      const view = renderList();
      for (let index = 0; index < 20; index++) {
        selectOnTrack(view, index % 2);
        expect(screen.getAllByTestId('inline-action-inspector')).toHaveLength(1);
        const highlighted = view.container.querySelector('.timeline-item-container--revealed');
        expect(highlighted?.querySelector('.timeline-item--revealed')).toBeTruthy();
        expect(highlighted?.querySelector('.inspector-workspace__detail')).toBeTruthy();
      }

      expect(animate).toHaveBeenCalledTimes(0);
      expect(screen.getAllByTestId('inline-action-inspector')).toHaveLength(1);
      expect(screen.getByTestId('inline-action-inspector').dataset.actionId)
        .toBe(state.compiledScene.actions[1].id);
      selectOnTrack(view, null);
      expect(screen.queryByTestId('inline-action-inspector')).toBeNull();
      expect(animate).not.toHaveBeenCalled();
    } finally { delete (HTMLElement.prototype as any).animate; }
  });

  it('jumps an off-screen statement into view and expands it inline', () => {
    const view = renderList();
    // Nothing far down the list is mounted before the selection.
    expect(mountedTitles(view.container)).not.toContain('S39');

    const scrollContainer = selectOnTrack(view, 39);
    const rowOffset = 39 * ROW_ESTIMATE;

    // 1. The list scrolled down to the row (rows above keep their estimate).
    expect(scrollContainer.scrollTop).toBeGreaterThan(rowOffset - VIEWPORT_HEIGHT);
    expect(scrollContainer.scrollTop).toBeLessThanOrEqual(rowOffset);

    // 2. The row is now mounted and expanded, so its inline detail is editable.
    expect(mountedTitles(view.container)).toContain('S39');
    const expanded = view.container.querySelector('.timeline-item--expanded') as HTMLElement | null;
    expect(expanded).toBeTruthy();
    expect(expanded?.textContent).toContain('S39');
    expect(screen.getByTestId('inline-action-inspector').dataset.actionId)
      .toBe(state.compiledScene.actions[39].id);
  });

  it('aligns the newly selected statement even when it is already in view', () => {
    const view = renderList();
    const scrollContainer = view.container.querySelector('.timeline-list-scroll') as HTMLElement;
    Object.defineProperty(scrollContainer, 'clientHeight', { configurable: true, value: VIEWPORT_HEIGHT });
    // Land somewhere in the middle first, the way scrolling by hand would.
    scrollContainer.scrollTop = 1_900;
    scrollFrame(view);
    expect(mountedTitles(view.container)).toContain('S12');

    selectOnTrack(view, 12);

    expect(scrollContainer.scrollTop).toBe(12 * ROW_ESTIMATE);
    expect(screen.getByTestId('inline-action-inspector').dataset.actionId)
      .toBe(state.compiledScene.actions[12].id);
  });

  it('does not drag the view back after the user scrolls away from the selection', () => {
    const view = renderList();
    const scrollContainer = selectOnTrack(view, 30);
    const jumpedTo = scrollContainer.scrollTop;
    expect(jumpedTo).toBeGreaterThan(0);

    // The user reads elsewhere in the script, then a re-render happens with the
    // same selection (an unrelated edit, a sibling state change).
    scrollContainer.scrollTop = 400;
    scrollFrame(view);
    view.rerender(<TimelineListView
      sceneData={{ sceneId: state.document.sceneId, meta: state.document.meta, timeline: [] }}
      selectedActionIds={{ [state.compiledScene.actions[30].id]: true }}
      setSelectedIds={vi.fn()}
      addAction={vi.fn()}
      handleSelect={vi.fn()}
      setCurrentTime={vi.fn()}
      loadExample={vi.fn(async () => true)}
    />);

    expect(scrollContainer.scrollTop).toBe(400);
  });

  it('reveals a track selection in tracks mode too, where rows stay collapsed', () => {
    state.layoutMode = 'tracks';
    const view = renderList();
    expect(mountedTitles(view.container)).not.toContain('S39');

    const scrollContainer = selectOnTrack(view, 39);

    expect(scrollContainer.scrollTop).toBeGreaterThan(0);
    expect(mountedTitles(view.container)).toContain('S39');
    expect(screen.queryByTestId('inline-action-inspector')).toBeNull();
  });
});
