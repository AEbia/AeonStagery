/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '../ui/context/AppContext';
import { TrackArea } from '../ui/timeline/TrackArea';
import type { LooseTimelineAction as SceneAction } from './fixtures/TimelineTestTypes';

function createAction(id: string, time: number, actionType: SceneAction['action'] = 'dialogue'): { id: string; action: SceneAction } {
  return {
    id,
    action: {
      _id: id,
      action: actionType,
      time,
      params: { duration: 0.2, text: id },
    } as SceneAction,
  };
}

function createValidationStore(issueIds: string[]) {
  const listeners = new Set<() => void>();
  return {
    issues: issueIds.map((id) => ({ actionId: id, severity: 'error', message: `${id} broken` })),
    loading: false,
    errorsCount: issueIds.length,
    warningsCount: 0,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSeverityByActionId(id: string) {
      return issueIds.includes(id) ? 'error' : null;
    },
    getIssueMessageByActionId(id: string) {
      return issueIds.includes(id) ? `${id} broken` : null;
    },
  };
}

function renderTrackArea(options: {
  actions?: Array<{ id: string; action: SceneAction }>;
  pps?: number;
  containerWidth?: number;
  selectedIds?: Record<string, boolean>;
  repeatIndexMap?: Map<string, string>;
  validationIssueIds?: string[];
  collaboration?: any;
  semanticDocument?: any;
  onCopyActions?: (ids: readonly string[]) => void;
  onDuplicateActions?: (ids: readonly string[]) => void | Promise<void>;
  onDeleteActions?: (ids: readonly string[]) => void | Promise<void>;
  copyBuffer?: any[];
  services?: any;
} = {}) {
  const actions = options.actions ?? Array.from({ length: 50 }, (_, index) => createAction(`a${index}`, index * 0.2));
  if (!options.actions) {
    actions[5] = createAction('a5', 1, 'cameraMove');
  }

  const onSelect = vi.fn();
  const onSeek = vi.fn();
  const onNavigateRange = vi.fn();
  const onDrag = vi.fn();
  const onResize = vi.fn();
  const playbackSubscribers = new Set<(time: number) => void>();

  const adapters = {
    document: {
      pushUndo: vi.fn(),
      pasteActions: vi.fn().mockReturnValue([]),
      setTimeline: vi.fn(),
    } as any,
    playback: {
      getCurrentTime: vi.fn().mockReturnValue(0),
      subscribeTime: vi.fn((cb: (time: number) => void) => {
        playbackSubscribers.add(cb);
        return () => playbackSubscribers.delete(cb);
      }),
      seek: vi.fn(),
      play: vi.fn(),
      pause: vi.fn(),
      getDuration: vi.fn().mockReturnValue(0),
      setLoop: vi.fn(),
      setLoopEnabled: vi.fn(),
      setSpeed: vi.fn(),
    } as any,
    camera: {} as any,
    character: {} as any,
    stage: {} as any,
    timeline: { select: vi.fn() } as any,
    export: {} as any,
  };

  const stores = {
    document: {
      sceneData: { meta: { markers: [] }, timeline: actions.map((item) => item.action) },
      getCompiledSceneSnapshot: () => ({
        sourceSchemaVersion: 2,
        sceneId: 'scene_1',
        meta: { title: 'Track Area Test' },
        durationSeconds: 20,
        actions: actions.map(({ id, action }) => ({
          id,
          time: action.time,
          action: action.action,
          params: action.params,
          source: { statementId: `statement-${id}` },
        })),
      }),
      getCurrentSceneDocumentSnapshot: () => options.semanticDocument ?? null,
      subscribe: () => () => {},
    } as any,
    playback: {
      playing: false,
      duration: 0,
      engineStatus: '',
      subscribe: () => () => {},
      setDuration: vi.fn(),
      setPlaying: vi.fn(),
      setEngineStatus: vi.fn(),
    } as any,
    editor: {
      copyBuffer: options.copyBuffer ?? [],
      subscribe: () => () => {},
    } as any,
    validation: createValidationStore(options.validationIssueIds ?? ['a3']) as any,
  };

  const view = render(
    <AppProvider adapters={adapters} stores={stores} services={options.services} collaboration={options.collaboration}>
      <TrackArea
        tracks={[{ id: 'global', label: 'Global', actions }]}
        pps={options.pps ?? 10}
        maxTime={20}
        selectedIds={options.selectedIds ?? { a1: true }}
        onSelect={onSelect}
        onDrag={onDrag}
        onResize={onResize}
        onCopyActions={options.onCopyActions}
        onDuplicateActions={options.onDuplicateActions}
        onDeleteActions={options.onDeleteActions}
        onSeek={onSeek}
        sceneData={{ sceneId: 'summary-test', meta: { title: 'Summary Test', markers: [] }, timeline: actions.map((item) => item.action) }}
        scrollLeft={0}
        containerWidth={options.containerWidth ?? 1000}
        repeatIndexMap={options.repeatIndexMap ?? new Map([['a2', 'dup']])}
        onBatchDrag={vi.fn()}
        viewWindow={{ start: 0, end: 20 }}
        onNavigateRange={onNavigateRange}
      />
    </AppProvider>,
  );

  return {
    ...view,
    onSelect,
    onSeek,
    onNavigateRange,
    onDrag,
    onResize,
    playbackSubscribers,
  };
}

describe('TrackArea summary mode', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    if (!HTMLElement.prototype.setPointerCapture) {
      Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { value: vi.fn(), configurable: true });
      Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { value: vi.fn(), configurable: true });
    }
  });

  it.each([1200, 1600])('fills a %ipx viewport with the ruler when zoomed out', (containerWidth) => {
    const { container } = renderTrackArea({ actions: [], pps: 10, containerWidth });
    const trackArea = screen.getByTestId('timeline-track-area');
    expect(parseFloat(trackArea.style.width)).toBeGreaterThanOrEqual(containerWidth);

    const ruler = container.querySelector('.timeline-ruler')!;
    const tickPositions = Array.from(ruler.querySelectorAll<HTMLElement>('.ruler-tick'))
      .map(tick => parseFloat(tick.style.left));
    // Tick coordinates start after the 100px track-label column.
    expect(Math.max(...tickPositions)).toBeGreaterThanOrEqual(containerWidth - 100 - 100);
  });

  it('preserves horizontal scrolling when the scene is wider than the viewport', () => {
    renderTrackArea({ actions: [], pps: 100, containerWidth: 1600 });
    expect(screen.getByTestId('timeline-track-area').style.width).toBe('2200px');
  });

  it('aligns the motion insertion target with the character entrance', () => {
    const entranceAction = {
      _id: 'enter-1',
      action: 'addCharacter',
      time: 2.5,
      params: { id: 'hero' },
      semanticType: 'characterPresence',
      sourceParams: { mode: 'enter', id: 'hero' },
    } as any;
    const { container } = renderTrackArea({
      actions: [{ id: 'enter-1', action: entranceAction }],
      pps: 10,
    });
    const target = container.querySelector('[data-tutorial-target="timeline-blank-after-entrance"]');
    expect(target).toBeTruthy();
    expect((target as HTMLElement).style.left).toBe('125px');
  });

  it('renders summary blocks, anchor pins, and a single portal tooltip', async () => {
    const { onSelect, onSeek, onNavigateRange } = renderTrackArea();

    await waitFor(() => {
      expect(screen.getAllByTestId('track-summary-block').length).toBeGreaterThan(0);
    });

    const issueSummaryBlock = screen.getAllByTestId('track-summary-block').find(
      (block) => block.getAttribute('data-has-issue') === 'true',
    );
    expect(issueSummaryBlock).toBeTruthy();
    expect(screen.getAllByTestId('track-anchor-pin')).toHaveLength(1);
    expect(screen.getByTestId('timeline-spotlight-window')).toBeTruthy();

    const summaryBlock = screen.getAllByTestId('track-summary-block')[0];
    fireEvent.mouseEnter(summaryBlock, { clientX: 20, clientY: 30 });
    expect(screen.getAllByTestId('summary-tooltip-portal')).toHaveLength(1);

    fireEvent.click(summaryBlock);
    expect(onSeek).toHaveBeenCalled();

    fireEvent.doubleClick(summaryBlock);
    expect(onNavigateRange).toHaveBeenCalledTimes(1);

    const anchorPin = screen.getAllByTestId('track-anchor-pin')[0];
    fireEvent.click(anchorPin);
    expect(onSelect).toHaveBeenCalled();
    expect(onNavigateRange).toHaveBeenCalledTimes(1);
  });

  it('marks detailed track blocks currently edited by a collaboration peer', () => {
    const actions = [
      createAction('a1', 0),
      createAction('a2', 1),
    ];

    const { container } = renderTrackArea({
      actions,
      pps: 300,
      selectedIds: {},
      repeatIndexMap: new Map(),
      validationIssueIds: [],
      collaboration: {
        status: 'connected',
        self: { clientId: 'self', displayName: '导演' },
        peers: [{
          clientId: 'peer-1',
          displayName: '分镜师',
          selectedStatementIds: ['statement-a1'],
          editingTarget: { kind: 'statement', statementId: 'statement-a1' },
        }],
      },
    });

    expect(screen.getByLabelText('分镜师 正在编辑此语句')).toBeTruthy();
    expect(container.querySelector('[data-id="a1"]')?.getAttribute('data-collaboration-editing')).toBe('true');
  });

  it('renders peer CTI positions from collaboration presence', () => {
    renderTrackArea({
      actions: [
        createAction('a1', 0),
        createAction('a2', 1),
      ],
      pps: 300,
      selectedIds: {},
      repeatIndexMap: new Map(),
      validationIssueIds: [],
      collaboration: {
        status: 'connected',
        self: { clientId: 'self', displayName: '导演' },
        peers: [{
          clientId: 'peer-1',
          displayName: '分镜师',
          selectedActionIds: [],
          editingTarget: null,
          playheadTime: 1.5,
        }],
      },
    });

    const peerPlayhead = screen.getByTestId('collaboration-playhead');
    expect(peerPlayhead.getAttribute('data-client-id')).toBe('peer-1');
    expect(peerPlayhead.getAttribute('style')).toContain('left: 550px');
    expect(screen.getByLabelText('分镜师 的 CTI 1.50s')).toBeTruthy();
  });

  it('renders ordinary track blocks without StateSpan projection attributes', () => {
    const { container } = renderTrackArea({
      actions: [createAction('ordinary', 1)],
      pps: 40,
      selectedIds: { ordinary: true },
      repeatIndexMap: new Map(),
      validationIssueIds: [],
    });

    const block = container.querySelector('[data-id="ordinary"]');
    expect(block).toBeTruthy();
    expect(block?.getAttribute('data-state-span')).toBeNull();
    expect(block?.getAttribute('data-state-span-projection')).toBeNull();
    expect(container.querySelector('.state-span-endpoint')).toBeNull();
    expect(container.querySelector('.state-span-materialize-end')).toBeNull();
  });

  it('blocks paste from a stale blank menu after collaboration goes offline', async () => {
    let status: 'connected' | 'offline' = 'connected';
    const collaboration = {
      get status() { return status; },
      self: null,
      peers: [],
    };
    const author = vi.fn(async () => ({ createdStatementIds: [] }));
    const view = renderTrackArea({
      collaboration,
      copyBuffer: [{ type: 'dialogue', params: { text: 'copied' } }],
      validationIssueIds: [],
      services: {
        sceneFile: {},
        semanticAuthoring: { author },
      },
    });

    fireEvent.contextMenu(view.container.querySelector('.track-row')!, { clientX: 180, clientY: 24 });
    expect(screen.getByRole('button', { name: '粘贴此处' })).toBeTruthy();

    status = 'offline';
    act(() => {
      view.playbackSubscribers.forEach((subscriber) => subscriber(1));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '粘贴此处' }));
    });

    expect(author).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: '空白轨道插入菜单' })).toBeNull();
    view.unmount();
  });

  it('blocks template insertion from a stale blank menu after collaboration goes offline', async () => {
    let status: 'connected' | 'offline' = 'connected';
    const collaboration = {
      get status() { return status; },
      self: null,
      peers: [],
    };
    const author = vi.fn(async () => ({ createdStatementIds: [] }));
    const packages: never[] = [];
    const templateCatalog = {
      getPackages: () => packages,
      subscribe: () => () => {},
      getSemanticAuthoringCombos: () => [{
        id: 'stale-template',
        name: 'Stale Template',
        category: 'dialogue',
        payload: {
          kind: 'statementSequence',
          statements: [
            { type: 'dialogue', params: { text: 'template 1', durationSeconds: 1 } },
            { type: 'dialogue', params: { text: 'template 2', durationSeconds: 1 } },
          ],
        },
      }],
    };
    const view = renderTrackArea({
      collaboration,
      validationIssueIds: [],
      services: {
        sceneFile: {},
        semanticAuthoring: { author },
        templatePackages: templateCatalog,
      },
    });

    fireEvent.contextMenu(view.container.querySelector('.track-row')!, { clientX: 180, clientY: 24 });
    status = 'offline';
    act(() => {
      view.playbackSubscribers.forEach((subscriber) => subscriber(1));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stale Template' }));
    });

    expect(author).not.toHaveBeenCalled();
    expect(screen.queryByTestId('template-authoring-preview')).toBeNull();
    view.unmount();
  });

  it('renders peer timeline pointer positions from collaboration presence', () => {
    renderTrackArea({
      actions: [
        createAction('a1', 0),
        createAction('a2', 1),
      ],
      pps: 300,
      selectedIds: {},
      repeatIndexMap: new Map(),
      validationIssueIds: [],
      collaboration: {
        status: 'connected',
        self: { clientId: 'self', displayName: '导演' },
        peers: [{
          clientId: 'peer-1',
          displayName: '分镜师',
          selectedActionIds: [],
          editingTarget: null,
          playheadTime: 1.5,
          pointer: { surface: 'timeline', time: 1.25, trackId: 'global' },
        }],
      },
    });

    const peerPointer = screen.getByTestId('collaboration-pointer');
    expect(peerPointer.getAttribute('data-client-id')).toBe('peer-1');
    expect(peerPointer.getAttribute('data-track-id')).toBe('global');
    expect(peerPointer.getAttribute('style')).toContain('left: 475px');
    expect(peerPointer.getAttribute('style')).toContain('top: 54px');
    expect(screen.getByLabelText('分镜师 指向 1.25s')).toBeTruthy();
  });

  it('publishes local timeline pointer presence without changing selection or seek', () => {
    const publishPresence = vi.fn();
    const { container, onSelect, onSeek } = renderTrackArea({
      actions: [
        createAction('a1', 0),
        createAction('a2', 1),
      ],
      pps: 300,
      selectedIds: {},
      repeatIndexMap: new Map(),
      validationIssueIds: [],
      collaboration: {
        status: 'connected',
        self: { clientId: 'self', displayName: '导演' },
        peers: [],
        publishPresence,
      },
    });

    const root = container.firstElementChild as HTMLElement;
    const row = container.querySelector('[data-track-id="global"]') as HTMLElement;
    root.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 1000,
      bottom: 200,
      width: 1000,
      height: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    row.getBoundingClientRect = () => ({
      left: 0,
      top: 40,
      right: 1000,
      bottom: 80,
      width: 1000,
      height: 40,
      x: 0,
      y: 40,
      toJSON: () => ({}),
    });

    fireEvent.pointerMove(root, { clientX: 550, clientY: 60 });
    expect(publishPresence).toHaveBeenCalledWith({
      pointer: { surface: 'timeline', time: 1.5, trackId: 'global' },
    });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onSeek).not.toHaveBeenCalled();

    fireEvent.pointerLeave(root);
    expect(publishPresence).toHaveBeenLastCalledWith({ pointer: null });
  });

  it('keeps collaboration-edited actions visible as summary anchor pins', async () => {
    renderTrackArea({
      collaboration: {
        status: 'connected',
        self: { clientId: 'self', displayName: '导演' },
        peers: [{
          clientId: 'peer-1',
          displayName: '分镜师',
          selectedStatementIds: ['statement-a10'],
          editingTarget: { kind: 'statement', statementId: 'statement-a10' },
        }],
      },
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('track-summary-block').length).toBeGreaterThan(0);
    });

    expect(screen.getAllByTestId('track-anchor-pin')).toHaveLength(2);
    const collaborationAnchor = screen.getByTitle('分镜师 正在编辑此语句');
    expect(collaborationAnchor.getAttribute('data-anchor-id')).toBe('a10');
    expect(collaborationAnchor.getAttribute('data-collaboration-editing')).toBe('true');
  });
});
