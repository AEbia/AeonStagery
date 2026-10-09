/**
 * @vitest-environment jsdom
 */
import { editNumericControl } from './fixtures/editNumericControl';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TimelineListView } from '../ui/timeline/TimelineListView';
import { settingsManager } from '../ui/SettingsStore';

const state = vi.hoisted(() => {
  const holder = {
    document: null as any,
    compiledScene: null as any,
    documentVersion: 0,
    documentListeners: new Set<() => void>(),
    collaborationStatus: 'disconnected' as 'disconnected' | 'offline',
    author: vi.fn(async (): Promise<{ createdStatementIds: string[] }> => ({ createdStatementIds: [] })),
    documentStore: null as any,
  };
  holder.documentStore = {
    get version() { return holder.documentVersion; },
    get filePath() { return null; },
    getCurrentSceneDocumentSnapshot: () => holder.document,
    getCompiledSceneSnapshot: () => holder.compiledScene,
    subscribe: (listener: () => void) => {
      holder.documentListeners.add(listener);
      return () => holder.documentListeners.delete(listener);
    },
  };
  return holder;
});

vi.mock('../ui/context/AppContext', () => ({
  usePlaybackAdapter: () => ({
    getCurrentTime: () => 0,
    subscribeTime: () => () => {},
    seek: vi.fn(),
    play: vi.fn(),
  }),
  useDocumentStore: () => state.documentStore,
  useSemanticAuthoringService: () => ({ author: state.author }),
  useProjectWorkspaceService: () => undefined,
  useIsCollaborationUndoDisabled: () => false,
  useCollaborationStatus: () => state.collaborationStatus,
  useCollaborationPresence: () => ({ peers: [] }),
  useOptionalApp: () => ({ collaboration: { status: state.collaborationStatus } }),
}));

function makeStatement(id: string, time: number) {
  return {
    id,
    time,
    type: 'dialogue',
    params: { text: id, durationSeconds: 1 },
  };
}

function renderList(
  statementTimes = [0, 1, 2],
  collaborationStatus: 'disconnected' | 'offline' = 'disconnected',
) {
  return renderStatements(
    statementTimes.map((time, index) => makeStatement(`statement-${index}`, time)),
    collaborationStatus,
  );
}

function renderStatements(
  statements: any[],
  collaborationStatus: 'disconnected' | 'offline' = 'disconnected',
) {
  state.document = {
    schemaVersion: 4,
    sceneId: 'inline-list',
    meta: { title: 'Inline list', characters: [] },
    statements,
  };
  state.compiledScene = null;
  state.collaborationStatus = collaborationStatus;
  state.author.mockClear();
  const handleSelect = vi.fn();
  render(
    <TimelineListView
      sceneData={{ sceneId: 'inline-list', meta: state.document.meta, timeline: [] }}
      selectedActionIds={{}}
      setSelectedIds={vi.fn()}
      addAction={vi.fn()}
      handleSelect={handleSelect}
      setCurrentTime={vi.fn()}
      loadExample={vi.fn(async () => true)}
    />,
  );
  return { handleSelect };
}

describe('timeline list inline authoring', () => {
  beforeEach(() => {
    (globalThis as any).ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    window.localStorage.clear();
    settingsManager.set('workbenchDialogueFlowMode', 'manual');
    settingsManager.set('workbenchTimelineLayoutMode', 'tracks');
  });

  it('renders n - 1 dialogue insertion gaps and hides them while searching', () => {
    renderList([0, 1, 2]);
    expect(screen.getAllByTestId('timeline-list-gap')).toHaveLength(2);
    expect(screen.getByLabelText('在 0.5 秒插入语句')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: '搜索时间轴动作、台词或角色' }), {
      target: { value: 'statement-1' },
    });
    expect(screen.queryByTestId('timeline-list-gap')).toBeNull();

    cleanup();
    renderList([1]);
    expect(screen.queryByTestId('timeline-list-gap')).toBeNull();
  });

  it('opens track-blank-menu when clicking gap plus and inserts statement at gap position', async () => {
    state.author.mockImplementationOnce(async () => {
      state.document = { ...state.document, statements: [...state.document.statements, makeStatement('created-dialogue', 0.1)] };
      return { createdStatementIds: ['created-dialogue'] };
    });
    const { handleSelect } = renderList([0.04, 0.16]);

    expect(document.querySelector('.track-blank-menu')).toBeNull();
    fireEvent.click(screen.getByLabelText('在 0.1 秒插入语句'));

    expect(document.querySelector('.track-blank-menu')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '对话' }));

    await waitFor(() => expect(state.author).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'insert-statement',
      origin: 'timeline-list-gap',
      anchorTime: 0.1,
      beforeStatementId: 'statement-1',
      statement: expect.objectContaining({ type: 'dialogue' }),
    })));
    expect(handleSelect).toHaveBeenCalledWith(['created-dialogue'], false);
    expect(document.querySelector('.track-blank-menu')).toBeNull();
  });

  it('inserts statement before the next root statement from track-blank-menu', async () => {
    state.author.mockResolvedValueOnce({ createdStatementIds: ['created-camera'] });
    renderList([0, 1]);
    fireEvent.click(screen.getByLabelText('在 0.5 秒插入语句'));

    expect(document.querySelector('.track-blank-menu')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '镜头移动' }));

    await waitFor(() => expect(state.author).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'insert-statement',
      origin: 'timeline-list-gap',
      anchorTime: 0.5,
      beforeStatementId: 'statement-1',
      statement: expect.objectContaining({ type: 'camera' }),
    })));
  });

  it('forwards automatic flow when editing a dialogue start time', async () => {
    renderList([0, 1, 2]);
    fireEvent.click(screen.getByRole('button', { name: '全自动' }));

    editNumericControl(screen.getAllByTitle('编辑时间')[1], '2.0');

    await waitFor(() => expect(state.author).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'update-statement',
      statementId: 'statement-1',
      patch: { time: 2 },
      flow: true,
    })));
  });

  it('locks other gap insertion while the authoring request is pending', async () => {
    let resolveAuthor: ((receipt: { createdStatementIds: string[] }) => void) | undefined;
    const authorPending = new Promise<{ createdStatementIds: string[] }>((resolve) => {
      resolveAuthor = resolve;
    });
    state.author.mockImplementationOnce(() => authorPending);

    renderList([0, 1, 2]);
    fireEvent.click(screen.getByLabelText('在 0.5 秒插入语句'));
    fireEvent.click(screen.getByRole('button', { name: '对话' }));

    expect(state.author).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('在 1.5 秒插入语句'));
    expect(state.author).toHaveBeenCalledTimes(1);

    resolveAuthor?.({ createdStatementIds: [] });
    await authorPending;
  });

  it('keeps quick-add controls hidden and exposes dialogue flow in the toolbar', () => {
    renderList([0, 1]);

    expect(screen.queryByText('快速添加')).toBeNull();
    expect(screen.queryByRole('textbox', { name: '单句追加输入' })).toBeNull();
    expect(screen.queryByRole('button', { name: '添加动作' })).toBeNull();

    const automatic = screen.getByRole('button', { name: '全自动' });
    const manual = screen.getByRole('button', { name: '不自动重排' });
    expect(automatic.closest('.timeline-toolbar')).toBeTruthy();
    expect(automatic.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(automatic);
    expect(automatic.getAttribute('aria-pressed')).toBe('true');
    expect(manual.getAttribute('aria-pressed')).toBe('false');
  });

  it('authors dialogue drag reorder without enabling inline editing', async () => {
    renderList([0, 1, 2]);
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: vi.fn(),
      getData: vi.fn(),
    };
    fireEvent.dragStart(screen.getByLabelText('拖拽第 1 行调整语句顺序'), { dataTransfer });
    fireEvent.drop(screen.getByRole('group', { name: /statement-2/ }), { dataTransfer, clientY: -1 });

    await waitFor(() => expect(state.author).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'reorder-dialogue-chain',
      orderedDialogueIds: ['statement-1', 'statement-0', 'statement-2'],
      movedStatementId: 'statement-0',
      flow: false,
    })));
    expect(screen.getAllByTitle('编辑时间')).toHaveLength(3);
  });

  it('moves non-dialogue root statements with the ordinary timeline move intent', async () => {
    renderStatements([
      {
        id: 'camera-0',
        time: 0,
        type: 'camera',
        params: { mode: 'focus', position: [0, 0] },
      },
      makeStatement('statement-1', 2),
    ]);
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: vi.fn(),
      getData: vi.fn(),
    };

    fireEvent.dragStart(screen.getByLabelText('拖拽第 1 行调整语句顺序'), { dataTransfer });
    fireEvent.drop(screen.getByRole('group', { name: /statement-1/ }), { dataTransfer, clientY: -1 });

    await waitFor(() => expect(state.author).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'move-timeline-locators',
      origin: 'timeline-editor',
      moves: [expect.objectContaining({
        locator: { kind: 'statement', statementId: 'camera-0' },
      })],
    })));
  });

  it('correctly reorders dialogue upwards when dragged to preceding item', async () => {
    renderList([0, 1, 2]);
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: vi.fn(),
      getData: vi.fn(),
    };

    // Drag statement-2 (3rd item) up to statement-0 (1st item), drop on bottom half (clientY: 10)
    // Should insert statement-2 after statement-0, before statement-1: ['statement-0', 'statement-2', 'statement-1']
    fireEvent.dragStart(screen.getByLabelText('拖拽第 3 行调整语句顺序'), { dataTransfer });
    fireEvent.drop(screen.getByRole('group', { name: /statement-0/ }), { dataTransfer, clientY: 10 });

    await waitFor(() => expect(state.author).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'reorder-dialogue-chain',
      orderedDialogueIds: ['statement-0', 'statement-2', 'statement-1'],
      movedStatementId: 'statement-2',
      flow: false,
    })));
  });

  it('provides visual feedback classes while dragging and hovering drop targets', () => {
    renderList([0, 1, 2]);
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: vi.fn(),
      getData: vi.fn(),
    };

    const dragHandle = screen.getByLabelText('拖拽第 1 行调整语句顺序');
    const draggedRow = screen.getByRole('group', { name: /statement-0/ });
    const targetRow = screen.getByRole('group', { name: /statement-1/ });
    const gap = screen.getAllByTestId('timeline-list-gap')[0];

    // Initially no dragging classes
    expect(draggedRow.classList.contains('timeline-item--dragging')).toBe(false);

    // Start drag
    fireEvent.dragStart(dragHandle, { dataTransfer });
    expect(draggedRow.classList.contains('timeline-item--dragging')).toBe(true);
    expect(dragHandle.classList.contains('timeline-item__drag-handle--dragging')).toBe(true);

    // Hover over top half of target row -> drop-before indicator
    fireEvent.dragOver(targetRow, { dataTransfer, clientY: -1 });
    expect(targetRow.classList.contains('timeline-item--drop-before')).toBe(true);
    expect(targetRow.classList.contains('timeline-item--drop-after')).toBe(false);

    // Hover over bottom half of target row -> drop-after indicator
    fireEvent.dragOver(targetRow, { dataTransfer, clientY: 10 });
    expect(targetRow.classList.contains('timeline-item--drop-after')).toBe(true);
    expect(targetRow.classList.contains('timeline-item--drop-before')).toBe(false);

    // Hovering over the dragged row itself should not show drop indicators
    fireEvent.dragOver(draggedRow, { dataTransfer, clientY: 10 });
    expect(draggedRow.classList.contains('timeline-item--drop-after')).toBe(false);
    expect(draggedRow.classList.contains('timeline-item--drop-before')).toBe(false);

    // Hover over a gap -> gap drag-over indicator
    fireEvent.dragOver(gap, { dataTransfer });
    expect(gap.classList.contains('timeline-list-gap--drag-over')).toBe(true);

    // Leaving gap to a child element inside keeps indicator
    const gapButton = gap.querySelector('.timeline-list-gap__button');
    fireEvent.dragLeave(gap, { dataTransfer, relatedTarget: gapButton });
    expect(gap.classList.contains('timeline-list-gap--drag-over')).toBe(true);

    // Leaving gap completely clears indicator
    fireEvent.dragLeave(gap, { dataTransfer, relatedTarget: document.body });
    expect(gap.classList.contains('timeline-list-gap--drag-over')).toBe(false);

    // End drag -> all indicators cleared
    fireEvent.dragEnd(dragHandle);
    expect(draggedRow.classList.contains('timeline-item--dragging')).toBe(false);
    expect(dragHandle.classList.contains('timeline-item__drag-handle--dragging')).toBe(false);
    expect(targetRow.classList.contains('timeline-item--drop-before')).toBe(false);
    expect(targetRow.classList.contains('timeline-item--drop-after')).toBe(false);
    expect(gap.classList.contains('timeline-list-gap--drag-over')).toBe(false);
  });

  it('does not expose a global drag handle for dialogue companion rows', () => {
    renderStatements([{
      ...makeStatement('statement-0', 0),
      companions: [{
        id: 'companion-camera',
        anchor: 'start',
        offset: 0,
        type: 'camera',
        params: { mode: 'focus', position: [0, 0] },
      }],
    }]);

    expect(screen.getAllByTitle('拖拽调整语句顺序')).toHaveLength(1);
    expect(screen.getAllByTitle('编辑时间')).toHaveLength(2);
  });

  it('keeps gap insertion read-only while collaboration is offline', () => {
    renderList([0, 1], 'offline');
    fireEvent.click(screen.getByLabelText('在 0.5 秒插入语句'));

    expect(document.querySelector('.track-blank-menu')).toBeNull();
    expect(state.author).not.toHaveBeenCalled();
  });

  it('renders gap buttons as ordinary plus buttons without dialogue text and toggles track-blank-menu', () => {
    renderList([0, 1]);
    const gapButton = screen.getByLabelText('在 0.5 秒插入语句');

    expect(gapButton.textContent?.trim()).toBe('');
    expect(gapButton.querySelector('svg')).toBeTruthy();

    fireEvent.click(gapButton);
    expect(document.querySelector('.track-blank-menu')).toBeTruthy();

    fireEvent.click(gapButton);
    expect(document.querySelector('.track-blank-menu')).toBeNull();
  });

  it('dismisses track-blank-menu on Escape key', () => {
    renderList([0, 1]);
    const gapButton = screen.getByLabelText('在 0.5 秒插入语句');

    fireEvent.click(gapButton);
    expect(document.querySelector('.track-blank-menu')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('.track-blank-menu')).toBeNull();
  });
});
