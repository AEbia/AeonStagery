/**
 * @vitest-environment jsdom
 *
 * Regression guard for the timeline interaction → authoring commit promise
 * chain. The drop-flicker fix relies on `useBlockDrag` / `useBatchDrag` /
 * `useBlockResize` keeping their transient overlays pinned until the
 * authoring commit settles. That only works when the handlers passed down
 * through TrackArea actually return the `semanticAuthoring.author(...)`
 * promise; a wrapper that swallows the return (block-body arrow without
 * `return`) silently disables the pin for that interaction. These tests
 * assert the chain is intact for all three handlers.
 */
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../ui/context/AppContext';
import { TimelineEditor } from '../ui/TimelineEditor';
import { EditorStore } from '../ui/store/EditorStore';
import type { InspectorPanelView } from '../ui/timeline/InspectorViewPicker';
import type { SemanticTimelineSnapshot } from '../ui/timeline/useSemanticTimelineSnapshot';

let capturedTrackAreaProps: Record<string, unknown> = {};
let capturedInspectorAreaProps: Record<string, unknown> = {};
let capturedZoomSliderProps: Record<string, unknown> = {};

vi.mock('../ui/timeline/TrackArea', () => ({
  TrackArea: (props: Record<string, unknown>) => {
    capturedTrackAreaProps = props;
    return <div data-testid="track-area" />;
  },
}));

vi.mock('../ui/timeline/InspectorArea', () => ({
  InspectorArea: (props: Record<string, unknown>) => {
    capturedInspectorAreaProps = props;
    return <div data-testid="inspector-area" />;
  },
}));

vi.mock('../ui/timeline/TimelineZoomSlider', () => ({
  TimelineZoomSlider: (props: Record<string, unknown>) => {
    capturedZoomSliderProps = props;
    return <div data-testid="timeline-zoom-slider" />;
  },
}));

vi.mock('../ui/timeline/TimelineSelectionBar', () => ({
  TimelineSelectionBar: () => <div data-testid="timeline-selection-bar" />,
}));

function makeContext(status = 'connected') {
  const subscribe = () => () => undefined;
  const sceneData = {
    sceneId: 'scene-1',
    meta: { title: 'Commit chain' },
    timeline: [
      { _id: 'action-enter', action: 'wait', time: 0, params: { duration: 1 } },
    ],
  };
  return {
    adapters: {
      document: { undo: vi.fn(), redo: vi.fn() } as any,
      playback: {
        getCurrentTime: () => 0,
        seek: vi.fn(),
        subscribeTime: () => () => undefined,
      } as any,
      camera: {} as any,
      character: {} as any,
      stage: {} as any,
      timeline: { select: vi.fn() } as any,
      export: {} as any,
    },
    stores: {
      document: {
        sceneData,
        version: 1,
        filePath: '',
        subscribe,
        getCurrentSceneDocumentSnapshot: () => ({
          schemaVersion: 4,
          sceneId: sceneData.sceneId,
          meta: sceneData.meta,
          statements: [
            { id: 'enter-a', time: 1, type: 'characterPresence', params: { mode: 'enter', id: 'A' } },
          ],
        }),
        getCompiledSceneSnapshot: () => ({
          sourceSchemaVersion: 2,
          sceneId: sceneData.sceneId,
          meta: sceneData.meta,
          durationSeconds: 5,
          actions: [
            {
              id: 'action-enter',
              time: 1,
              action: 'addCharacter',
              params: { id: 'A' },
              source: { statementId: 'enter-a' },
            },
          ],
        }),
      } as any,
      playback: { playing: false, duration: 1, engineStatus: 'ready', subscribe } as any,
      editor: {
        selectedActionIds: {},
        selectedActionIdsSnapshot: {},
        selectedCount: 0,
        pixelsPerSecond: 50,
        gizmosVisible: true,
        saveStatus: 'idle',
        subscribe,
        setPixelsPerSecond: vi.fn(),
      } as any,
      validation: { issues: [], loading: false, errorsCount: 0, warningsCount: 0, subscribe } as any,
    },
    services: {
      sceneFile: {} as any,
      semanticAuthoring: {
        author: vi.fn(async () => ({ createdStatementIds: [] as string[] })),
      } as any,
    },
    collaboration: { status, self: null, peers: [] } as any,
  };
}

describe('TimelineEditor interaction → authoring promise chain', () => {
  beforeEach(() => {
    capturedTrackAreaProps = {};
    capturedInspectorAreaProps = {};
    capturedTrackAreaProps = {};
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it('passes the same semantic snapshot to tracks and the inspector', () => {
    render(<AppProvider {...makeContext()}><TimelineEditor /></AppProvider>);
    const snapshot = capturedTrackAreaProps.semanticSnapshot as SemanticTimelineSnapshot;
    expect(capturedInspectorAreaProps.semanticSnapshot).toBe(snapshot);
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.document?.statements[0].id).toBe(snapshot.items[0].statementId);
    expect(snapshot.actions[0]).toBe(snapshot.items[0].displayAction);
  });

  it('keeps ruler and zoom viewport widths in sync when the adjacent panel resizes', () => {
    let viewportWidth = 720;
    let notifyResize = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { notifyResize = callback; }
      observe() {}
      disconnect = disconnect;
    });
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('timeline-editor-scroll-container') ? viewportWidth : 0;
      });

    try {
      const { unmount } = render(<AppProvider {...makeContext()}><TimelineEditor mode="tracks" /></AppProvider>);
      expect(capturedTrackAreaProps.containerWidth).toBe(720);
      expect(capturedZoomSliderProps.containerWidth).toBe(620);

      viewportWidth = 480;
      act(() => notifyResize());
      expect(capturedTrackAreaProps.containerWidth).toBe(480);
      expect(capturedZoomSliderProps.containerWidth).toBe(380);
      unmount();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      width.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('blocks a delayed inspector commit when collaboration goes offline after opening the form', async () => {
    const context = makeContext();
    const transaction = vi.fn();
    context.services.semanticAuthoring = { author: vi.fn(), authorTransaction: transaction } as any;
    const { rerender } = render(<AppProvider {...context}><TimelineEditor /></AppProvider>);
    const delayedCommit = capturedInspectorAreaProps.replaceSourceParams as (id: string, params: Record<string, unknown>) => Promise<unknown>;
    rerender(<AppProvider {...context} collaboration={{ ...context.collaboration, status: 'offline' }}><TimelineEditor /></AppProvider>);
    await delayedCommit('action-enter', { mode: 'enter', id: 'B' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('replaces a previous copy with an uncompiled statement from the timeline', () => {
    const context = makeContext();
    const editor = new EditorStore();
    context.stores.editor = editor;
    const document = context.stores.document.getCurrentSceneDocumentSnapshot();
    document.statements.push({
      id: 'performance-placeholder',
      time: 3,
      type: 'characterPerformance',
      params: { target: 'A', motion: '' },
    });
    context.stores.document.getCurrentSceneDocumentSnapshot = () => document;

    render(<AppProvider {...context}><TimelineEditor mode="tracks" /></AppProvider>);

    const copy = (ids: string[]) => act(() => {
      (capturedTrackAreaProps.onCopyActions as (ids: string[]) => void)(ids);
    });
    copy(['action-enter']);
    expect(editor.copyBuffer[0].type).toBe('characterPresence');
    copy(['performance-placeholder']);
    expect(editor.copyBuffer).toEqual([{
      time: 0,
      type: 'characterPerformance',
      params: { target: 'A', motion: '' },
    }]);
  });

  it('surfaces the authoring promise for onDrag, onResize and onBatchDrag', async () => {
    const context = makeContext('connected');
    const author = vi.fn(async (_intent: unknown) => ({ createdStatementIds: [] as string[] }));
    context.services.semanticAuthoring = { author };

    render(
      <AppProvider {...context}>
        <TimelineEditor mode="tracks" />
      </AppProvider>,
    );

    const { onDrag, onResize, onBatchDrag } = capturedTrackAreaProps;
    expect(typeof onDrag).toBe('function');
    expect(typeof onResize).toBe('function');
    expect(typeof onBatchDrag).toBe('function');

    const dragResult = (onDrag as (id: string, time: number) => unknown)('action-enter', 2);
    const resizeResult = (onResize as (id: string, duration: number) => unknown)('action-enter', 3);
    const batchResult = (onBatchDrag as (updates: unknown) => unknown)([{ id: 'action-enter', time: 2 }]);

    // The pin mechanism requires a thenable here; `undefined` means the
    // promise was dropped and the flicker fix is silently disabled.
    expect(dragResult, 'onDrag must return the authoring promise').toBeInstanceOf(Promise);
    expect(resizeResult, 'onResize must return the authoring promise').toBeInstanceOf(Promise);
    expect(batchResult, 'onBatchDrag must return the authoring promise').toBeInstanceOf(Promise);

    await act(async () => {
      await Promise.all([dragResult, resizeResult, batchResult]);
    });
    expect(author).toHaveBeenCalledTimes(3);
    expect(author.mock.calls[2][0]).toEqual(expect.objectContaining({ kind: 'move-timeline-locators' }));
  });

  it('returns no promise when the offline gate blocks the edit', async () => {
    const context = makeContext('offline');
    const author = vi.fn(async (_intent: unknown) => ({ createdStatementIds: [] as string[] }));
    context.services.semanticAuthoring = { author };

    render(
      <AppProvider {...context}>
        <TimelineEditor mode="tracks" />
      </AppProvider>,
    );

    const { onDrag, onBatchDrag } = capturedTrackAreaProps;
    // Offline: the edit is blocked, so no commit is scheduled and the
    // interaction must NOT pin anything (transients clear immediately,
    // blocks snap back to their stale document positions — correct).
    expect((onDrag as (id: string, time: number) => unknown)('action-enter', 2)).toBeUndefined();
    expect((onBatchDrag as (updates: unknown) => unknown)([{ id: 'action-enter', time: 2 }])).toBeUndefined();
    expect(author).not.toHaveBeenCalled();
  });

  it('reports inspector detail visibility on selection, view changes and unmount', () => {
    const context = makeContext();
    const editor = new EditorStore();
    context.stores.editor = editor;
    context.adapters.timeline.select = vi.fn((ids: Record<string, boolean>) => editor._setSelectedIds(ids));
    const onVisibilityChange = vi.fn();
    const inspector = (view: InspectorPanelView) => (
      <AppProvider {...context}>
        <TimelineEditor mode="inspector" inspectorView={view}
          onInspectorDetailVisibilityChange={onVisibilityChange} />
      </AppProvider>
    );
    const { rerender, unmount } = render(inspector('actions'));
    expect(onVisibilityChange).toHaveBeenLastCalledWith(false);

    act(() => editor._setSelectedIds({ 'action-enter': true }));
    expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
    for (const view of ['diagnostics', 'snapshot'] as const) {
      rerender(inspector(view));
      expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
    }
    for (const view of ['script', 'characters'] as const) {
      rerender(inspector(view));
      expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
    }
    rerender(inspector('actions'));
    expect(onVisibilityChange).toHaveBeenLastCalledWith(true);

    act(() => editor._setSelectedIds({}));
    expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
    act(() => editor._setSelectedIds({ 'action-enter': true }));
    expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
    unmount();
    expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
  });
});
