/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import { sceneDocumentCodec, sceneStatementCompiler } from '../services/semantic-scene';
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

function placeholderDocument(): CurrentSceneDocument {
  return sceneDocumentCodec.parseAndValidate({
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'placeholder-search-scene',
    meta: { title: 'Placeholder search', characters: [{ id: 'alice', name: 'Alice' }] },
    statements: [
      {
        id: 'dlg-1',
        time: 0,
        type: 'dialogue',
        params: { speakerId: 'alice', speaker: 'Alice', text: '你好。', durationSeconds: 2 },
        companions: [
          {
            id: 'cmp_perf',
            anchor: 'start',
            offset: 0,
            type: 'characterPerformance',
            params: { target: '$speaker', motion: '' },
          },
        ],
      },
    ],
  });
}

function renderList() {
  return render(
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
}

describe('placeholder search by auto-bound character', () => {
  beforeEach(() => {
    (globalThis as any).ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    state.document = placeholderDocument();
    state.compiledScene = sceneStatementCompiler.compile(state.document);
  });

  it('keeps the 动作待定 placeholder when searching its auto-bound character name', () => {
    renderList();
    const search = screen.getByLabelText('搜索时间轴动作、台词或角色');
    fireEvent.change(search, { target: { value: 'Alice' } });

    expect(screen.getByText('Alice · 动作待定')).toBeTruthy();
  });

  it('filters the placeholder out when searching an unrelated character', () => {
    renderList();
    const search = screen.getByLabelText('搜索时间轴动作、台词或角色');
    fireEvent.change(search, { target: { value: 'Taki' } });

    expect(screen.queryByText(/动作待定/)).toBeNull();
    expect(screen.getByText(/未找到匹配/)).toBeTruthy();
  });
});
