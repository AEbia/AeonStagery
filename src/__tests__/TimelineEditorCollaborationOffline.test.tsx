/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../ui/context/AppContext';
import { TimelineEditor } from '../ui/TimelineEditor';

vi.mock('../ui/timeline/TrackArea', () => ({
  TrackArea: (props: { onDeleteActions?: (ids: readonly string[]) => void }) => (
    <div data-testid="track-area">
      <button onClick={() => props.onDeleteActions?.(['action-enter'])}>delete state span</button>
    </div>
  ),
}));

vi.mock('../ui/timeline/InspectorArea', () => ({
  InspectorArea: () => <div data-testid="inspector-area" />,
}));

vi.mock('../ui/timeline/TimelineZoomSlider', () => ({
  TimelineZoomSlider: () => <div data-testid="timeline-zoom-slider" />,
}));

vi.mock('../ui/timeline/TimelineSelectionBar', () => ({
  TimelineSelectionBar: () => <div data-testid="timeline-selection-bar" />,
}));

function makeContext(status = 'offline') {
  const subscribe = () => () => undefined;
  const sceneData = {
    sceneId: 'scene-1',
    meta: { title: 'Offline Collaboration' },
    timeline: [
      { _id: 'action-1', action: 'wait', time: 0, params: { duration: 1 } },
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
          statements: [],
        }),
        getCompiledSceneSnapshot: () => null,
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
      timelineAuthoring: {
        getDraft: () => null,
        previewActionEdit: vi.fn(),
        commitActionEdit: vi.fn(),
        commitActionEdits: vi.fn(),
        author: vi.fn(async () => ({ createdActionIds: [] })),
      } as any,
      semanticAuthoring: {
        author: vi.fn(async () => ({ createdStatementIds: [] as string[] })),
      } as any,
    },
    collaboration: { status, self: null, peers: [] } as any,
  };
}

describe('TimelineEditor collaboration offline copy', () => {
  beforeEach(() => {
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

  it('uses the shared status UX offline edit message in the blocked-edit banner', () => {
    render(
      <AppProvider {...makeContext('offline')}>
        <TimelineEditor mode="tracks" />
      </AppProvider>,
    );

    expect(screen.getByRole('status').textContent).toContain('共享编辑已暂停；请手动重连后才能继续编辑。');
  });

  it('deletes selected statements independently without cascade dependency dialog', () => {
    const context = makeContext('connected');
    const author = vi.fn(async () => ({ createdStatementIds: [] as string[] }));
    context.services.semanticAuthoring = { author };
    context.stores.document.getCurrentSceneDocumentSnapshot = () => ({
      schemaVersion: 4,
      sceneId: 'scene-1',
      meta: { title: 'Independent delete' },
      statements: [
        { id: 'enter-a', time: 1, type: 'characterPresence', params: { mode: 'enter', id: 'A' } },
        { id: 'transform-a', time: 2, type: 'characterTransform', params: { id: 'A', position: [0.6, 1] } },
        { id: 'exit-a', time: 5, type: 'characterPresence', params: { mode: 'exit', id: 'A' } },
      ],
    } as any);
    context.stores.document.getCompiledSceneSnapshot = () => ({
      sourceSchemaVersion: 2,
      sceneId: 'scene-1',
      meta: { title: 'Independent delete' },
      durationSeconds: 5,
      actions: [
        { id: 'action-enter', time: 1, action: 'addCharacter', params: { id: 'A' }, source: { statementId: 'enter-a' } },
        { id: 'action-transform', time: 2, action: 'transformCharacter', params: { id: 'A' }, source: { statementId: 'transform-a' } },
        { id: 'action-exit', time: 5, action: 'removeCharacter', params: { id: 'A' }, source: { statementId: 'exit-a' } },
      ],
    } as any);

    render(
      <AppProvider {...context}>
        <TimelineEditor mode="tracks" />
      </AppProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'delete state span' }));

    expect(screen.queryByRole('dialog', { name: '删除状态区间及依赖' })).toBeNull();
  });
});
