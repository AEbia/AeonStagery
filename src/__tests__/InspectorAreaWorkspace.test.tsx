/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LooseTimelineScene as SceneScript } from './fixtures/TimelineTestTypes';
import { InspectorArea } from '../ui/timeline/InspectorArea';
import { settingsManager } from '../ui/SettingsStore';

const semanticDocumentState = vi.hoisted(() => ({
  document: {
    schemaVersion: 4 as const,
    sceneId: 'scene_1',
    meta: { title: 'Workspace detail', characters: [] },
    statements: [{
      id: 'action_1',
      time: 1,
      type: 'dialogue' as const,
      params: { text: 'hello', durationSeconds: 1 },
    }],
  },
  setCopyBuffer: vi.fn(),
  authorTransaction: vi.fn(async () => ({ createdStatementIds: [] })),
}));

vi.mock('../ui/timeline/ActionInspector', () => ({
  ActionInspector: ({ onClose }: { onClose: () => void | Promise<void> }) => (
    <div data-testid="action-detail">
      action detail
      <button onClick={() => { void onClose(); }}>close action detail</button>
    </div>
  ),
}));

vi.mock('../ui/timeline/ContextPanel', () => ({
  ContextPanel: () => <div data-testid="workspace-navigator">workspace navigator</div>,
}));

vi.mock('../ui/timeline/TimelineListView', () => ({
  TimelineListView: () => <div data-testid="timeline-navigator">timeline navigator</div>,
}));

vi.mock('../ui/context/AppContext', () => ({
  useApp: () => ({
    stores: {
      editor: {
        setCopyBuffer: semanticDocumentState.setCopyBuffer,
      },
    },
  }),
  useDocumentStore: () => ({
    getCurrentSceneDocumentSnapshot: () => semanticDocumentState.document,
    getCompiledSceneSnapshot: () => null,
  }),
  useSemanticAuthoringService: () => ({ authorTransaction: semanticDocumentState.authorTransaction }),
  useCollaborationStatus: () => 'disconnected',
  useTemplatePackageCatalog: () => undefined,
}));

vi.mock('../ui/store/storeHooks', () => ({
  useSemanticDocument: () => ({ document: semanticDocumentState.document, filePath: null }),
  useCustomMotionEditorActionId: () => null,
}));

const sceneData = {
  sceneId: 'scene_1',
  meta: { title: 'Workspace detail', characters: [] },
  timeline: [
    {
      _id: 'action_1',
      time: 1,
      action: 'dialogue',
      params: { text: 'hello' },
    },
  ],
} as SceneScript;

const baseProps = {
  sceneData,
  selectedActionIds: { action_1: true },
  setSelectedIds: vi.fn(),
  updateAction: vi.fn(),
  updateParam: vi.fn(),
  deleteAction: vi.fn(),
  addAction: vi.fn(),
  handleSave: vi.fn(),
  handleSelect: vi.fn(),
  setCurrentTime: vi.fn(),
  loadExample: vi.fn(async () => true),
  onDetailClose: vi.fn(),
  navigatorWidth: 400,
  workspaceIssues: [],
  inspectorView: 'diagnostics' as const,
  onSelectInspectorView: vi.fn(),
};

describe('InspectorArea workspace navigator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsManager.set('workbenchTimelineLayoutMode', 'list');
    semanticDocumentState.document = {
      schemaVersion: 4,
      sceneId: 'scene_1',
      meta: { title: 'Workspace detail', characters: [] },
      statements: [{
        id: 'action_1',
        time: 1,
        type: 'dialogue',
        params: { text: 'hello', durationSeconds: 1 },
      }],
    };
  });

  it('keeps the navigator mounted when an action is selected after loading', () => {
    const { rerender } = render(
      <InspectorArea
        {...baseProps}
        selectedActionIds={{}}
      />,
    );

    semanticDocumentState.document = {
      ...semanticDocumentState.document,
      statements: [{
        id: 'action_2',
        time: 2,
        type: 'dialogue',
        params: { text: 'loaded later', durationSeconds: 1 },
      }],
    };
    rerender(
      <InspectorArea
        {...baseProps}
        selectedActionIds={{ action_2: true }}
      />,
    );

    expect(screen.queryByTestId('action-detail')).toBeNull();
    expect(screen.queryByText('1 个动作已选中')).toBeNull();
  });

  it.each(['diagnostics', 'snapshot'] as const)(
    'shows the %s tool without a separate selected action detail',
    (inspectorView) => {
      render(<InspectorArea {...baseProps} inspectorView={inspectorView} />);

      expect(screen.queryByTestId('action-detail')).toBeNull();
      expect(screen.getByTestId('workspace-navigator')).toBeTruthy();
      expect(screen.queryByTestId('timeline-navigator')).toBeNull();
    },
  );

  it('shows only the workspace navigator after detail is closed', () => {
    render(<InspectorArea {...baseProps} selectedActionIds={{}} />);

    expect(screen.queryByTestId('action-detail')).toBeNull();
    expect(screen.getByTestId('workspace-navigator')).toBeTruthy();
  });

  it('keeps script-action-priority height on non-action navigator views', () => {
    settingsManager.set('workbenchTimelineLayoutMode', 'list');
    const { container } = render(
      <InspectorArea {...baseProps} inspectorView="diagnostics" selectedActionIds={{}} />,
    );

    expect(container.querySelector('.inspector-workspace__pane--navigator')?.getAttribute('data-timeline-layout')).toBe('list');
  });

  it('does not mount a separate detail after clearing selection', () => {
    const { container } = render(
      <InspectorArea
        {...baseProps}
        selectedActionIds={{}}
      />,
    );

    expect(screen.queryByTestId('action-detail')).toBeNull();
    expect(container.querySelector('.inspector-workspace__pane--detail')).toBeNull();
  });

  it('does not show action detail in character management', () => {
    render(<InspectorArea {...baseProps} inspectorView="characters" />);

    expect(screen.queryByTestId('action-detail')).toBeNull();
    expect(screen.getByTestId('workspace-navigator')).toBeTruthy();
  });

  it('submits multi-selection copy and delete through shared commands', async () => {
    settingsManager.set('workbenchTimelineLayoutMode', 'tracks');
    render(
      <InspectorArea
        {...baseProps}
        inspectorView="actions"
        selectedActionIds={{ action_1: true, action_2: true }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /复制到剪贴板/ }));
    fireEvent.click(screen.getByRole('button', { name: /批量删除/ }));

    expect(semanticDocumentState.setCopyBuffer).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'dialogue', params: expect.objectContaining({ text: 'hello' }) }),
    ]);
    expect(semanticDocumentState.authorTransaction).toHaveBeenCalledWith([
      expect.objectContaining({ kind: 'delete-statements', statementIds: ['action_1'] }),
    ]);
    await waitFor(() => expect(baseProps.setSelectedIds).toHaveBeenCalledWith({}));
  });

  it.each<Record<string, boolean>>([
    { action_1: true },
    { action_1: true, action_2: true },
  ])(
    'waits for saving before clearing selection %j and closing detail',
    async (selectedActionIds) => {
      settingsManager.set('workbenchTimelineLayoutMode', 'tracks');
      let resolveSave!: (result: { success: true; path: string }) => void;
      const handleSave = vi.fn(() => new Promise<{ success: true; path: string }>((resolve) => {
        resolveSave = resolve;
      }));
      const onDetailClose = vi.fn();
      const setSelectedIds = vi.fn();

      render(
        <InspectorArea
          {...baseProps}
          inspectorView="actions"
          selectedActionIds={selectedActionIds}
          setSelectedIds={setSelectedIds}
          handleSave={handleSave}
          onDetailClose={onDetailClose}
        />,
      );

      fireEvent.click(screen.getByRole('button', {
        name: 'action_2' in selectedActionIds ? '取消选择' : 'close action detail',
      }));

      expect(handleSave).toHaveBeenCalledTimes(1);
      expect(onDetailClose).not.toHaveBeenCalled();
      expect(setSelectedIds).not.toHaveBeenCalled();

      resolveSave({ success: true, path: 'D:/project/scene.json' });

      await waitFor(() => {
        expect(onDetailClose).toHaveBeenCalledTimes(1);
        expect(setSelectedIds).toHaveBeenCalledExactlyOnceWith({});
      });
    },
  );

  it.each([
    { success: false as const, error: 'disk full' },
    { success: false as const, cancelled: true as const },
  ])('keeps action detail open when saving does not succeed', async (saveResult) => {
    settingsManager.set('workbenchTimelineLayoutMode', 'tracks');
    const handleSave = vi.fn(async () => saveResult);
    const onDetailClose = vi.fn();
    const setSelectedIds = vi.fn();

    render(
      <InspectorArea
        {...baseProps}
        inspectorView="actions"
        setSelectedIds={setSelectedIds}
        handleSave={handleSave}
        onDetailClose={onDetailClose}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'close action detail' }));
    });

    await waitFor(() => {
      expect(handleSave).toHaveBeenCalledTimes(1);
    });
    expect(onDetailClose).not.toHaveBeenCalled();
    expect(setSelectedIds).not.toHaveBeenCalled();
    expect(screen.getByTestId('action-detail')).toBeTruthy();
  });

  it.each(['list', 'tracks'] as const)(
    'preserves selection when switching from %s to the other layout and back',
    (initialLayout) => {
      settingsManager.set('workbenchTimelineLayoutMode', initialLayout);
      const setSelectedIds = vi.fn();
      const onDetailClose = vi.fn();
      const handleSave = vi.fn();
      render(<InspectorArea {...baseProps} inspectorView="actions"
        setSelectedIds={setSelectedIds} onDetailClose={onDetailClose} handleSave={handleSave} />);

      const expectLayout = (layout: 'list' | 'tracks') => {
        expect(screen.queryByTestId('action-detail') !== null).toBe(layout === 'tracks');
        expect(screen.queryByTestId('timeline-navigator') !== null).toBe(layout === 'list');
      };
      expectLayout(initialLayout);
      const otherLayout = initialLayout === 'list' ? 'tracks' : 'list';
      act(() => settingsManager.set('workbenchTimelineLayoutMode', otherLayout));
      expectLayout(otherLayout);
      act(() => settingsManager.set('workbenchTimelineLayoutMode', initialLayout));
      expectLayout(initialLayout);
      expect(setSelectedIds).not.toHaveBeenCalled();
      expect(onDetailClose).not.toHaveBeenCalled();
      expect(handleSave).not.toHaveBeenCalled();
    },
  );
});
