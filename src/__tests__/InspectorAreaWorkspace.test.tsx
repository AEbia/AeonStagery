/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
        setCopyBuffer: vi.fn(),
      },
    },
  }),
  useDocumentStore: () => ({
    getCurrentSceneDocumentSnapshot: () => semanticDocumentState.document,
    getCompiledSceneSnapshot: () => null,
  }),
  useSemanticAuthoringService: () => null,
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
  inspectorTab: 'basic' as const,
  setInspectorTab: vi.fn(),
  updateAction: vi.fn(),
  updateParam: vi.fn(),
  deleteAction: vi.fn(),
  addActionAt: vi.fn(),
  addAction: vi.fn(),
  handleSave: vi.fn(),
  handleSelect: vi.fn(),
  setCurrentTime: vi.fn(),
  loadExample: vi.fn(async () => true),
  detailOpen: true,
  onDetailOpen: vi.fn(),
  onDetailClose: vi.fn(),
  layoutMode: 'split' as const,
  navigatorWidth: 400,
  detailWidth: 360,
  workspaceIssues: [],
  inspectorView: 'diagnostics' as const,
  onSelectInspectorView: vi.fn(),
};

describe('InspectorArea workspace navigator', () => {
  beforeEach(() => {
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
        detailSelectedActionIds={{}}
        detailOpen={false}
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
        detailSelectedActionIds={{ action_2: true }}
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
    render(<InspectorArea {...baseProps} detailOpen={false} />);

    expect(screen.queryByTestId('action-detail')).toBeNull();
    expect(screen.getByTestId('workspace-navigator')).toBeTruthy();
  });

  it('keeps script-action-priority height on non-action navigator views', () => {
    settingsManager.set('workbenchTimelineLayoutMode', 'list');
    const { container } = render(
      <InspectorArea {...baseProps} inspectorView="diagnostics" detailOpen={false} />,
    );

    expect(container.querySelector('.inspector-workspace__pane--navigator')?.getAttribute('data-timeline-layout')).toBe('list');
  });

  it('does not mount a separate detail during a legacy closing state', () => {
    const { container } = render(
      <InspectorArea
        {...baseProps}
        selectedActionIds={{}}
        detailSelectedActionIds={{ action_1: true }}
        detailClosing
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

  it('delegates multi-selection copy and delete to aggregate handlers', async () => {
    settingsManager.set('workbenchTimelineLayoutMode', 'tracks');
    const copyActions = vi.fn();
    const deleteActions = vi.fn();
    render(
      <InspectorArea
        {...baseProps}
        inspectorView="actions"
        selectedActionIds={{ action_1: true, action_2: true }}
        detailSelectedActionIds={{ action_1: true, action_2: true }}
        copyActions={copyActions}
        deleteActions={deleteActions}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /复制到剪贴板/ }));
    fireEvent.click(screen.getByRole('button', { name: /批量删除/ }));

    expect(copyActions).toHaveBeenCalledWith(['action_1', 'action_2']);
    expect(deleteActions).toHaveBeenCalledWith(['action_1', 'action_2']);
  });

  it.each(['split', 'replace'] as const)(
    'saves before closing action detail in %s layout',
    async (layoutMode) => {
      settingsManager.set('workbenchTimelineLayoutMode', 'tracks');
      let resolveSave!: (result: { success: true; path: string }) => void;
      const handleSave = vi.fn(() => new Promise<{ success: true; path: string }>((resolve) => {
        resolveSave = resolve;
      }));
      const onDetailClose = vi.fn();

      render(
        <InspectorArea
          {...baseProps}
          inspectorView="actions"
          layoutMode={layoutMode}
          handleSave={handleSave}
          onDetailClose={onDetailClose}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'close action detail' }));

      expect(handleSave).toHaveBeenCalledTimes(1);
      expect(onDetailClose).not.toHaveBeenCalled();

      resolveSave({ success: true, path: 'D:/project/scene.json' });

      await waitFor(() => {
        expect(onDetailClose).toHaveBeenCalledTimes(1);
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

    render(
      <InspectorArea
        {...baseProps}
        inspectorView="actions"
        handleSave={handleSave}
        onDetailClose={onDetailClose}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'close action detail' }));

    await waitFor(() => {
      expect(handleSave).toHaveBeenCalledTimes(1);
    });
    expect(onDetailClose).not.toHaveBeenCalled();
  });
});
