/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeCompiledActionId } from '../services/semantic-scene/SceneStatementCompiler';
import { TimelineListView } from '../ui/timeline/TimelineListView';

const state = vi.hoisted(() => ({
  document: null as any,
  compiledScene: null as any,
}));

vi.mock('../ui/context/AppContext', () => ({
  usePlaybackAdapter: () => ({
    getCurrentTime: () => 0,
    subscribeTime: () => () => {},
  }),
  useDocumentStore: () => ({
    version: 1,
    filePath: null,
    subscribe: () => () => {},
    getCurrentSceneDocumentSnapshot: () => state.document,
    getCompiledSceneSnapshot: () => state.compiledScene,
  }),
  useSemanticAuthoringService: () => ({ author: vi.fn(async () => ({})) }),
  useProjectWorkspaceService: () => undefined,
  useIsCollaborationUndoDisabled: () => false,
  useCollaborationStatus: () => 'disconnected',
  useCollaborationPresence: () => ({ peers: [] }),
  useOptionalApp: () => null,
}));

describe('Task 2 semantic timeline summaries', () => {
  beforeEach(() => {
    (globalThis as any).ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    state.document = {
      schemaVersion: 4,
      sceneId: 'task2_timeline',
      meta: {
        title: 'Task 2 timeline',
        characters: [{ id: 'tomori', name: 'Tomori' }],
      },
      statements: [
        {
          id: 'look_at',
          time: 0,
          type: 'characterPerformance',
          params: { target: 'tomori', lookAt: { point: [0.2, -0.4], enabled: true } },
        },
        {
          id: 'blink',
          time: 1,
          type: 'characterPerformance',
          params: { target: 'tomori', blink: { enabled: false, interval: 2.5 } },
        },
      ],
    };
    state.compiledScene = {
      sceneId: 'task2_timeline',
      meta: state.document.meta,
      actions: [
        {
          id: encodeCompiledActionId('look_at', undefined, 'lookAt'),
          time: 0,
          action: 'characterLookAt',
          params: { id: 'tomori', focusX: 0.2, focusY: -0.4, enabled: true },
          source: { statementId: 'look_at', outputKey: 'lookAt' },
        },
        {
          id: encodeCompiledActionId('blink', undefined, 'blink'),
          time: 1,
          action: 'characterBlink',
          params: { id: 'tomori', enabled: false, interval: 2500 },
          source: { statementId: 'blink', outputKey: 'blink' },
        },
      ],
    };
  });

  it('renders semantic look-at points and blink intervals in author-facing units', () => {
    render(
      <TimelineListView
        sceneData={{ sceneId: state.document.sceneId, meta: state.document.meta, timeline: [] }}
        selectedActionIds={{}}
        setSelectedIds={vi.fn()}
        addAction={vi.fn()}
        handleSelect={vi.fn()}
        setCurrentTime={vi.fn()}
        loadExample={vi.fn(async () => true)}
      />,
    );

    expect(screen.getByText('对焦位置: (0.2, -0.4)')).toBeTruthy();
    expect(screen.getByText('启用:否 间隔:2.5秒')).toBeTruthy();
  });
});
