/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AppProvider } from '../ui/context/AppContext';
import { TrackArea } from '../ui/timeline/TrackArea';
import type { ICharacterAdapter } from '../api/interfaces/ICharacterAdapter';
import type { Live2DMotionSamplingOptions } from '../engine/runtime/Live2DRuntimeContracts';
import type { LooseTimelineAction as SceneAction } from './fixtures/TimelineTestTypes';
import type { TimelineScene } from '../ui/timeline/semanticTimelineTypes';
import { buildTimelineTracks } from '../ui/timeline/timelineTrackPresentation';
import { buildSemanticTimelineReadModel } from '../ui/timeline/semanticTimelineReadModel';
import { SCENE_SCHEMA_VERSION, type CompiledScene } from '../api/types/semantic-scene';
import { sceneDocumentCodec, sceneStatementCompiler } from '../services/semantic-scene';

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
  sceneData?: TimelineScene;
  compiledScene?: CompiledScene;
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
  characterAdapter?: Partial<Pick<ICharacterAdapter, 'getMotionDuration' | 'sampleMotion'>>;
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
    character: (options.characterAdapter ?? {}) as unknown as ICharacterAdapter,
    stage: {} as any,
    timeline: { select: vi.fn() } as any,
    export: {} as any,
  };

  const stores = {
    document: {
      sceneData: { meta: { markers: [] }, timeline: actions.map((item) => item.action) },
      getCompiledSceneSnapshot: () => options.compiledScene ?? ({
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
      getCurrentSceneDocumentView: () => options.semanticDocument ?? null,
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
        tracks={options.sceneData ? buildTimelineTracks(options.sceneData) : [{ id: 'global', label: 'Global', actions }]}
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
        sceneData={options.sceneData ?? { sceneId: 'summary-test', meta: { title: 'Summary Test', markers: [] }, timeline: actions.map((item) => item.action) }}
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

  it.each([
    ['blur', 'set', '设置模糊'], ['blur', 'modulate', '变化模糊'], ['blur', 'reset', '重置模糊'],
    ['post', 'set', '设置后期处理'], ['post', 'modulate', '变化后期处理'], ['post', 'reset', '重置后期处理'],
  ] as const)('targets all environment layers when inserting %s %s from the environment row', async (effect, mode, label) => {
    const document = sceneDocumentCodec.parseAndValidate({
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'environment-effects-menu',
      meta: { title: 'Environment effects', characters: [{ id: 'hero', name: '主角' }] },
      statements: [
        { id: 'fog', time: 0, type: 'environmentLayer', params: { mode: 'set', layerId: 'fog', file: 'fog.png' } },
        { id: 'environment-effect', time: 0, type: 'lighting', params: { effect, mode: 'set', target: { kind: 'group', group: 'environmentLayers' } } },
        { id: 'character-effect', time: 0, type: 'lighting', params: { effect, mode: 'set', target: { kind: 'character', id: 'hero' } } },
        { id: 'scene-effect', time: 0, type: 'lighting', params: { effect, mode: 'set', target: effect === 'blur' ? 'global' : 'panorama' } },
        { id: 'point-light', time: 0, type: 'lighting', params: { effect: 'pointLight', mode: 'set', id: 'point_light_1', color: '#ffffff', intensity: 0.5 } },
      ],
    });
    const compiled = sceneStatementCompiler.compile(document);
    const items = buildSemanticTimelineReadModel(document, compiled);
    const author = vi.fn(async () => ({ createdStatementIds: [] }));
    const { container } = renderTrackArea({
      actions: items.map((item) => ({ id: item.id, action: item.displayAction })),
      sceneData: { sceneId: document.sceneId, meta: document.meta, timeline: items.map((item) => item.displayAction) },
      compiledScene: compiled,
      semanticDocument: document,
      selectedIds: Object.fromEntries(items.filter((item) => ['fog', 'character-effect'].includes(item.statementId)).map((item) => [item.id, true])),
      validationIssueIds: [],
      repeatIndexMap: new Map(),
      pps: 100,
      services: { sceneFile: {}, semanticAuthoring: { author } },
    });

    fireEvent.contextMenu(container.querySelector('.track-row[data-track-id="environment"]')!, { clientX: 300, clientY: 100 });
    const menu = within(screen.getByRole('dialog', { name: '空白轨道插入菜单' }));
    expect(menu.getByRole('button', { name: '变化点光源' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(menu.getByRole('button', { name: label }));
    });

    expect(author).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'insert-statement',
      anchorTime: 2,
      statement: { type: 'lighting', params: expect.objectContaining({ effect, mode, target: { kind: 'group', group: 'environmentLayers' } }) },
    }));
  });

  it.each(([
    ['blur', 'modulate', '变化模糊'], ['blur', 'reset', '重置模糊'],
    ['post', 'modulate', '变化后期处理'], ['post', 'reset', '重置后期处理'],
  ] as const).flatMap(([effect, mode, label]) => (['none', 'legacy', 'structured'] as const)
    .map((selection) => [effect, mode, label, selection] as const)))(
    'inserts %s %s on the global row with %s and %s character selection', async (effect, mode, label, selection) => {
    const target = effect === 'blur' ? 'global' : 'panorama';
    const source = sceneDocumentCodec.parseAndValidate({
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'global-effects-menu',
      meta: { title: 'Global effects', characters: [{ id: 'hero', name: '主角' }] },
      statements: [
        { id: 'scene-effect', time: 0, type: 'lighting', params: { effect, mode: 'set', target } },
        { id: 'character-effect', time: 0, type: 'lighting', params: {
          effect, mode: 'set', target: selection === 'legacy' ? 'hero' : { kind: 'character', id: 'hero' },
        } },
      ],
    });
    const compiled = sceneStatementCompiler.compile(source);
    const items = buildSemanticTimelineReadModel(source, compiled);
    const author = vi.fn(async () => ({ createdStatementIds: [] }));
    const { container } = renderTrackArea({
      sceneData: { sceneId: source.sceneId, meta: source.meta, timeline: items.map((item) => item.displayAction) },
      compiledScene: compiled,
      semanticDocument: source,
      selectedIds: Object.fromEntries(compiled.actions
        .filter((action) => selection !== 'none' && action.source.statementId === 'character-effect')
        .map((action) => [action.id, true])),
      validationIssueIds: [],
      repeatIndexMap: new Map(),
      pps: 100,
      services: { sceneFile: {}, semanticAuthoring: { author } },
    });

    fireEvent.contextMenu(container.querySelector('.track-row[data-track-id="global"]')!, { clientX: 300, clientY: 100 });
    const menu = within(screen.getByRole('dialog', { name: '空白轨道插入菜单' }));
    fireEvent.click(menu.getByRole('tab', { name: '画面效果' }));
    await act(async () => {
      fireEvent.click(menu.getByRole('button', { name: label }));
    });

    expect(author).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'insert-statement',
      anchorTime: 2,
      statement: { type: 'lighting', params: expect.objectContaining({ effect, mode, target }) },
    }));
  });

  it.each(([
    ['blur', 'modulate', '变化模糊'], ['blur', 'reset', '重置模糊'],
    ['post', 'modulate', '变化后期处理'], ['post', 'reset', '重置后期处理'],
  ] as const).flatMap(([effect, mode, label]) => ['none', 'hero', 'both'].map((selection) => [effect, mode, label, selection] as const)))(
    'offers and inserts %s %s (%s) for either character with %s selection', async (effect, mode, label, selection) => {
    const source = sceneDocumentCodec.parseAndValidate({
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'character-effects-menu',
      meta: { title: 'Character effects', characters: [{ id: 'hero', name: '主角' }, { id: 'friend', name: '朋友' }] },
      statements: ['hero', 'friend'].map((id) => ({
        id: `${id}-effect`, time: 0, type: 'lighting', params: { effect, mode: 'set', target: { kind: 'character', id } },
      })),
    });
    const compiled = sceneStatementCompiler.compile(source);
    const items = buildSemanticTimelineReadModel(source, compiled);
    const author = vi.fn(async () => ({ createdStatementIds: [] }));
    const { container } = renderTrackArea({
      sceneData: { sceneId: source.sceneId, meta: source.meta, timeline: items.map((item) => item.displayAction) },
      compiledScene: compiled,
      semanticDocument: source,
      selectedIds: Object.fromEntries(compiled.actions
        .filter((action) => selection === 'both' || (selection === 'hero' && action.source.statementId === 'hero-effect'))
        .map((action) => [action.id, true])),
      validationIssueIds: [],
      repeatIndexMap: new Map(),
      pps: 100,
      services: { sceneFile: {}, semanticAuthoring: { author } },
    });

    for (const id of ['hero', 'friend']) {
      fireEvent.contextMenu(container.querySelector(`.track-row[data-track-id="char:${id}"]`)!, { clientX: 300, clientY: 100 });
      const menu = within(screen.getByRole('dialog', { name: '空白轨道插入菜单' }));
      fireEvent.click(menu.getByRole('tab', { name: '画面效果' }));
      await act(async () => {
        fireEvent.click(menu.getByRole('button', { name: label }));
      });

      expect(author).toHaveBeenLastCalledWith(expect.objectContaining({
        kind: 'insert-statement',
        anchorTime: 2,
        statement: { type: 'lighting', params: expect.objectContaining({ effect, mode, target: { kind: 'character', id } }) },
      }));
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

  it('uses project FPS for conversion sampling and keyframe estimates when scene FPS is omitted', async () => {
    const motion = { kind: 'resource', key: 'wave.mtn' };
    const action = {
      _id: 'motion_1',
      action: 'playMotion',
      semanticType: 'characterPerformance',
      time: 2,
      params: { target: 'hero', duration: 2, motion },
      sourceParams: { target: 'hero', durationSeconds: 2, motion },
    } as unknown as SceneAction;
    const sampleMotion = vi.fn(async (_characterId: string, _motionKey: string, _options: Live2DMotionSamplingOptions) => ({
      status: 'sampled' as const,
      metadata: { durationSeconds: 2 },
    }));
    const project = { metadata: { videoFormat: { width: 1920, height: 1080, fps: 30 } } };
    const projectWorkspace = {
      getCurrentProject: () => project,
      subscribe: () => () => {},
    };

    renderTrackArea({
      actions: [{ id: 'motion_1', action }],
      semanticDocument: {
        schemaVersion: 5,
        sceneId: 'scene_1',
        meta: { title: 'Motion FPS' },
        statements: [{
          id: 'statement-motion_1',
          time: 2,
          type: 'characterPerformance',
          params: { target: 'hero', durationSeconds: 2, motion },
        }],
      },
      characterAdapter: {
        getMotionDuration: () => 0,
        sampleMotion,
      },
      services: {
        projectWorkspace,
        customMotionConversion: { convert: vi.fn() },
      },
    });

    fireEvent.contextMenu(screen.getByTestId('timeline-track-block'), { clientX: 20, clientY: 50 });
    fireEvent.click(screen.getByRole('menuitem', { name: '转为自定义动作…' }));

    await waitFor(() => {
      expect(sampleMotion).toHaveBeenCalledWith('hero', 'wave.mtn', { fps: 30, zeroSourceFades: true });
      expect(screen.getByText('约 60 帧')).toBeTruthy();
    });
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
