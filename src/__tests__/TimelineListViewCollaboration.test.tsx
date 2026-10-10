/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../ui/context/AppContext';
import type { LooseTimelineScene as SceneScript } from './fixtures/TimelineTestTypes';
import type { TimelineListViewProps } from '../ui/timeline/TimelineListView';
import type { WorkspaceToolTab } from '../ui/workspace-tools/types';
import { settingsManager } from '../ui/SettingsStore';

let TimelineListView: React.FC<TimelineListViewProps>;

const scene: SceneScript = {
  sceneId: 'scene_1',
  meta: { title: 'Collab Scene' },
  timeline: [],
};

const sceneWithAction: SceneScript = {
  sceneId: 'scene_1',
  meta: { title: 'Collab Scene', characters: [{ id: 'c1', name: '灯' }] },
  timeline: [
    {
      _id: 'action-1',
      time: 0,
      action: 'dialogue',
      params: { speakerId: 'c1', text: '你好' },
    },
  ],
};

const sceneAroundPlayhead: SceneScript = {
  sceneId: 'scene_1',
  meta: { title: 'Selection Boundaries' },
  timeline: [
    { _id: 'before', time: 0.5, action: 'wait', params: { duration: 1 } },
    { _id: 'equal', time: 1, action: 'wait', params: { duration: 1 } },
    { _id: 'after', time: 1.5, action: 'wait', params: { duration: 1 } },
  ],
};

function makeContext(
  documentAdapter: { undo: () => void; redo: () => void },
  status = 'connected',
  sceneData: SceneScript = scene,
  peers: any[] = [],
  currentTime = 0,
) {
  const semanticAuthoring = {
    undo: vi.fn(async () => true),
    redo: vi.fn(async () => true),
  };
  return {
    adapters: {
      document: {
        ...documentAdapter,
        loadScene: async () => undefined,
        updateAction: () => undefined,
        updateActions: () => undefined,
      } as any,
      playback: {
        getCurrentTime: () => currentTime,
        play: () => undefined,
        pause: () => undefined,
        subscribeTime: () => () => undefined,
      } as any,
      camera: {} as any,
      character: {
        getCoreModel: () => null,
        getModel: () => null,
      } as any,
      stage: {} as any,
      timeline: {} as any,
      export: {} as any,
    },
    stores: {
      document: {
        sceneData,
        version: 1,
        filePath: null,
        subscribe: () => () => undefined,
        getCurrentSceneDocumentSnapshot: () => ({
          schemaVersion: 4,
          sceneId: sceneData.sceneId,
          meta: sceneData.meta,
          statements: sceneData.timeline.map((action) => ({
            id: `statement-${action._id}`,
            time: action.time ?? 0,
            type: 'dialogue',
            params: {
              text: String(action.params.text ?? ''),
              durationSeconds: Number(action.params.duration ?? 1),
            },
          })),
        }),
        getCompiledSceneSnapshot: () => ({
          sourceSchemaVersion: 2,
          sceneId: sceneData.sceneId,
          meta: sceneData.meta,
          durationSeconds: 0,
          actions: sceneData.timeline.map((action) => ({
            id: action._id,
            time: action.time,
            action: action.action,
            params: action.params,
            source: { statementId: `statement-${action._id}` },
          })),
        }),
      } as any,
      playback: { playing: false } as any,
      editor: { selectedActionIds: {}, canUndo: true, canRedo: true } as any,
      validation: { issues: [], loading: false, errorsCount: 0, warningsCount: 0 } as any,
    },
    services: {
      sceneFile: {} as any,
      semanticAuthoring: semanticAuthoring as any,
    },
    collaboration: {
      status,
      self: null,
      peers,
    } as any,
  };
}

function renderTimeline(
  status = 'connected',
  sceneData: SceneScript = scene,
  peers: any[] = [],
  onSelectWorkspaceView?: (tab: WorkspaceToolTab) => void,
  workspaceErrorCount = 0,
  workspaceWarningCount = 0,
  currentTime = 0,
) {
  const documentAdapter = {
    undo: vi.fn(),
    redo: vi.fn(),
  };
  const setSelectedIds = vi.fn();
  const handleSelect = vi.fn();
  const context = makeContext(documentAdapter, status, sceneData, peers, currentTime);
  render(
    <AppProvider {...context}>
      <TimelineListView
        sceneData={sceneData}
        selectedActionIds={{}}
        setSelectedIds={setSelectedIds}
        addAction={vi.fn()}
        handleSelect={handleSelect}
        setCurrentTime={vi.fn()}
        loadExample={vi.fn(async () => true)}
        workspaceErrorCount={workspaceErrorCount}
        workspaceWarningCount={workspaceWarningCount}
        onSelectWorkspaceView={onSelectWorkspaceView}
      />
    </AppProvider>,
  );
  return { documentAdapter, semanticAuthoring: context.services.semanticAuthoring, setSelectedIds, handleSelect };
}

describe('TimelineListView collaboration undo exclusion', () => {
  beforeAll(async () => {
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
    ({ TimelineListView } = await import('../ui/timeline/TimelineListView'));
  });

  beforeEach(() => {
    settingsManager.set('workbenchTimelineLayoutMode', 'tracks');
    (globalThis as any).ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
  });

  it('disables undo and redo toolbar buttons during collaboration', () => {
    const { documentAdapter, semanticAuthoring } = renderTimeline('connected');

    const undoButton = screen.getByTitle('协作模式暂不支持撤销');
    const redoButton = screen.getByTitle('协作模式暂不支持重做');
    expect((undoButton as HTMLButtonElement).disabled).toBe(true);
    expect((redoButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(undoButton);
    fireEvent.click(redoButton);

    expect(documentAdapter.undo).not.toHaveBeenCalled();
    expect(documentAdapter.redo).not.toHaveBeenCalled();
    expect(semanticAuthoring.undo).not.toHaveBeenCalled();
    expect(semanticAuthoring.redo).not.toHaveBeenCalled();
  });

  it('keeps undo and redo toolbar buttons enabled outside collaboration', () => {
    const { documentAdapter, semanticAuthoring } = renderTimeline('disconnected');

    fireEvent.click(screen.getByTitle('撤销 (Ctrl+Z)'));
    fireEvent.click(screen.getByTitle('重做 (Ctrl+Shift+Z)'));

    expect(documentAdapter.undo).not.toHaveBeenCalled();
    expect(documentAdapter.redo).not.toHaveBeenCalled();
    expect(semanticAuthoring.undo).toHaveBeenCalledTimes(1);
    expect(semanticAuthoring.redo).toHaveBeenCalledTimes(1);
  });

  it('selects a contextual workspace view from the timeline title', () => {
    settingsManager.set('workbenchTimelineLayoutMode', 'list');
    const onSelectWorkspaceView = vi.fn();
    renderTimeline('disconnected', scene, [], onSelectWorkspaceView, 2, 1);

    const alert = screen.getByTitle('2 个错误；1 个警告；尚未配置角色');
    expect(alert.getAttribute('data-severity')).toBe('error');

    fireEvent.click(screen.getByLabelText('切换侧栏视图，当前为剧本动作，2 个错误；1 个警告；尚未配置角色'));

    expect(screen.getByText('未配置')).toBeTruthy();
    expect(screen.getByTitle('2 个错误；1 个警告；尚未配置角色')).toBeTruthy();

    const diagnosticsItem = screen.getByRole('menuitemradio', { name: '问题，3 个' });
    expect(diagnosticsItem.querySelector('em')?.getAttribute('data-severity')).toBe('error');
    fireEvent.click(diagnosticsItem);

    expect(onSelectWorkspaceView).toHaveBeenCalledWith('diagnostics');
  });

  it('uses warning severity when there are no errors', () => {
    settingsManager.set('workbenchTimelineLayoutMode', 'list');
    renderTimeline('disconnected', sceneWithAction, [], undefined, 0, 2);

    const alert = screen.getByTitle('2 个警告');

    expect(alert.getAttribute('data-severity')).toBe('warning');
  });

  it('hides the workspace view picker in tracks mode', () => {
    renderTimeline('disconnected');

    expect(screen.queryByLabelText(/切换侧栏视图/)).toBeNull();
  });

  it('marks a timeline action currently edited by a collaboration peer', () => {
    renderTimeline('connected', sceneWithAction, [
      {
        clientId: 'peer-1',
        displayName: '分镜师',
        selectedStatementIds: ['statement-action-1'],
        editingTarget: { kind: 'statement', statementId: 'statement-action-1' },
      },
    ]);

    expect(screen.getByLabelText('分镜师 正在编辑此语句')).toBeTruthy();
    expect(screen.getAllByTitle('分镜师 正在编辑此语句').length).toBeGreaterThan(0);
  });

  it('keeps row selection separate from the original timing and quick-action controls', () => {
    const { handleSelect } = renderTimeline('disconnected', sceneWithAction);

    const selectButton = screen.getByRole('button', { name: /^选择/ });
    const startTime = screen.getByTitle('编辑时间');
    const playButton = screen.getByRole('button', { name: '播放到此句' });
    expect(startTime.querySelector('[role="spinbutton"]')).toBeTruthy();
    expect(selectButton.contains(startTime)).toBe(false);
    expect(selectButton.contains(playButton)).toBe(false);

    fireEvent.click(selectButton);
    expect(handleSelect).toHaveBeenCalledWith('action-1', false);
  });

  it('keeps actions at the playhead on the right selection boundary', () => {
    const { setSelectedIds } = renderTimeline(
      'disconnected',
      sceneAroundPlayhead,
      [],
      undefined,
      0,
      0,
      1,
    );

    fireEvent.click(screen.getByTitle('选中播放位置左侧所有动作'));
    expect(setSelectedIds).toHaveBeenLastCalledWith({ before: true });

    fireEvent.click(screen.getByTitle('选中播放位置右侧所有动作'));
    expect(setSelectedIds).toHaveBeenLastCalledWith({ equal: true, after: true });
  });
});
