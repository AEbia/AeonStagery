/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LooseTimelineScene as SceneScript } from './fixtures/TimelineTestTypes';
import { InspectorArea, type InspectorAreaProps } from '../ui/timeline/InspectorArea';
import { PropertyInspectorShell } from '../ui/timeline/PropertyInspectorShell';
import type { TimelineScene } from '../ui/timeline/semanticTimelineTypes';
import { computeSidePanelWidth } from '../App';
import { settingsManager } from '../ui/SettingsStore';

const semanticDocumentState = vi.hoisted(() => ({
  document: {
    schemaVersion: 4 as const,
    sceneId: 'scene_tracks',
    meta: { title: 'Tracks Inspector Test', characters: [] },
    statements: [
      {
        id: 'action_1',
        time: 1,
        type: 'dialogue' as const,
        params: { text: 'Statement 1', durationSeconds: 2 },
      },
      {
        id: 'action_2',
        time: 3,
        type: 'dialogue' as const,
        params: { text: 'Statement 2', durationSeconds: 2 },
      },
    ],
  },
}));

vi.mock('../ui/timeline/ActionInspector', () => ({
  ActionInspector: ({
    onClose,
    selectedActionIds,
  }: {
    onClose: () => void | Promise<void>;
    selectedActionIds: Record<string, boolean>;
  }) => (
    <div data-testid="action-inspector">
      <span>Action Inspector Active: {Object.keys(selectedActionIds).join(', ')}</span>
      <button onClick={() => { void onClose(); }}>关闭详情</button>
    </div>
  ),
}));

vi.mock('../ui/timeline/ActionInspectorTabs', () => ({
  DiagnosticsTab: () => (
    <div data-testid="diagnostics-tab">
      <span>问题诊断面板内容</span>
    </div>
  ),
  EngineSnapshotTab: () => (
    <div data-testid="engine-snapshot-tab">
      <span>运行快照面板内容</span>
    </div>
  ),
}));

vi.mock('../ui/timeline/RawScriptTab', () => ({
  RawScriptTab: () => (
    <div data-testid="raw-script-tab">
      <span>场景 JSON 代码编辑器</span>
    </div>
  ),
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
  sceneId: 'scene_tracks',
  meta: { title: 'Tracks Inspector Test', characters: [] },
  timeline: [
    {
      _id: 'action_1',
      time: 1,
      action: 'dialogue',
      params: { text: 'Statement 1' },
    },
    {
      _id: 'action_2',
      time: 3,
      action: 'dialogue',
      params: { text: 'Statement 2' },
    },
  ],
} as SceneScript;

const createProps = (overrides: Partial<InspectorAreaProps> = {}): InspectorAreaProps => ({
  sceneData: sceneData as unknown as TimelineScene,
  selectedActionIds: {},
  setSelectedIds: vi.fn(),
  inspectorTab: 'basic' as const,
  setInspectorTab: vi.fn(),
  updateAction: vi.fn(),
  updateParam: vi.fn(),
  deleteAction: vi.fn(),
  addActionAt: vi.fn(),
  addAction: vi.fn(),
  handleSave: vi.fn(async () => ({ success: true as const, path: '/test.json' })),
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
  inspectorView: 'actions' as const,
  onSelectInspectorView: vi.fn(),
  ...overrides,
});

describe('Tracks mode dedicated Property Inspector', () => {
  beforeEach(() => {
    settingsManager.set('workbenchTimelineLayoutMode', 'tracks');
  });

  describe('sidePanelWidth calculation', () => {
    it('maintains fixed panel width in tracks mode without expanding/collapsing on selection', () => {
      const panelWidth = 400;
      const detailWidth = 360;

      // In tracks mode: detail closed
      const widthDeselected = computeSidePanelWidth({
        isTracksMode: true,
        panelWidth,
        inspectorNavigatorWidth: panelWidth,
        inspectorLayout: 'split',
        isInspectorDetailVisible: false,
        detailWidth,
      });
      expect(widthDeselected).toBe(400);

      // In tracks mode: detail open (action selected)
      const widthSelected = computeSidePanelWidth({
        isTracksMode: true,
        panelWidth,
        inspectorNavigatorWidth: panelWidth,
        inspectorLayout: 'split',
        isInspectorDetailVisible: true,
        detailWidth,
      });
      expect(widthSelected).toBe(400);

      // Verify that width did NOT change between selected and deselected
      expect(widthSelected).toBe(widthDeselected);

      // Resizing updates the panel width
      const resizedWidth = computeSidePanelWidth({
        isTracksMode: true,
        panelWidth: 450,
        inspectorNavigatorWidth: 450,
        inspectorLayout: 'split',
        isInspectorDetailVisible: true,
        detailWidth,
      });
      expect(resizedWidth).toBe(450);
    });

    it('keeps sidePanelWidth fixed at panel width in list mode (inline inspector)', () => {
      const panelWidth = 600;
      const detailWidth = 360;

      // In list mode: detail closed
      const listWidthClosed = computeSidePanelWidth({
        isTracksMode: false,
        panelWidth,
        inspectorNavigatorWidth: panelWidth,
        inspectorLayout: 'split',
        isInspectorDetailVisible: false,
        detailWidth,
      });
      expect(listWidthClosed).toBe(600);

      // In list mode: detail open - remains fixed at panel width
      const listWidthOpen = computeSidePanelWidth({
        isTracksMode: false,
        panelWidth,
        inspectorNavigatorWidth: panelWidth,
        inspectorLayout: 'split',
        isInspectorDetailVisible: true,
        detailWidth,
      });
      expect(listWidthOpen).toBe(600);
    });
  });

  describe('PropertyInspectorShell components and interactions', () => {
    it('renders empty state placeholder "选择一个语句来查看属性" when NO action is selected', () => {
      render(<PropertyInspectorShell {...createProps({ selectedActionIds: {} })} />);

      expect(screen.getByText('选择一个语句来查看属性')).toBeTruthy();
      expect(screen.queryByTestId('action-inspector')).toBeNull();
    });

    it('renders ActionInspector when an action is selected', () => {
      render(
        <PropertyInspectorShell
          {...createProps({
            selectedActionIds: { action_1: true },
            detailSelectedActionIds: { action_1: true },
          })}
        />,
      );

      expect(screen.getByTestId('action-inspector')).toBeTruthy();
      expect(screen.getByText(/Action Inspector Active: action_1/)).toBeTruthy();
      expect(screen.queryByText('选择一个语句来查看属性')).toBeNull();
    });

    it('renders "选择一个语句来查看属性" after clearing selection', async () => {
      const setSelectedIds = vi.fn();
      const onDetailClose = vi.fn();

      const { rerender } = render(
        <PropertyInspectorShell
          {...createProps({
            selectedActionIds: { action_1: true },
            detailSelectedActionIds: { action_1: true },
            setSelectedIds,
            onDetailClose,
          })}
        />,
      );

      expect(screen.getByTestId('action-inspector')).toBeTruthy();

      // Trigger close in ActionInspector
      fireEvent.click(screen.getByText('关闭详情'));
      await waitFor(() => {
        expect(setSelectedIds).toHaveBeenCalledWith({});
        expect(onDetailClose).toHaveBeenCalled();
      });

      // Re-render with cleared selection
      rerender(
        <PropertyInspectorShell
          {...createProps({
            selectedActionIds: {},
            detailSelectedActionIds: {},
          })}
        />,
      );

      expect(screen.getByText('选择一个语句来查看属性')).toBeTruthy();
      expect(screen.queryByTestId('action-inspector')).toBeNull();
    });

    it('switches right panel to RawScriptTab when clicking "场景 JSON" and back', async () => {
      const onSelectInspectorView = vi.fn();
      const { rerender } = render(
        <PropertyInspectorShell
          {...createProps({
            onSelectInspectorView,
          })}
        />,
      );

      // Initially on Property Inspector
      expect(screen.getByText('选择一个语句来查看属性')).toBeTruthy();

      // Click "场景 JSON" button
      const jsonBtn = screen.getByRole('button', { name: '场景 JSON' });
      fireEvent.click(jsonBtn);
      expect(onSelectInspectorView).toHaveBeenCalledWith('script');

      // Controlled or state updated: render in script view
      rerender(
        <PropertyInspectorShell
          {...createProps({
            inspectorView: 'script',
            onSelectInspectorView,
          })}
        />,
      );

      // Now RawScriptTab is displayed
      expect(screen.getByTestId('raw-script-view')).toBeTruthy();
      expect(await screen.findByText('场景 JSON 代码编辑器')).toBeTruthy();

      // Has "返回属性检查器" button
      const backBtn = screen.getByRole('button', { name: /返回属性检查器/ });
      expect(backBtn).toBeTruthy();

      // Click "返回属性检查器"
      fireEvent.click(backBtn);
      expect(onSelectInspectorView).toHaveBeenCalledWith('actions');

      // Re-render in actions view
      rerender(
        <PropertyInspectorShell
          {...createProps({
            inspectorView: 'actions',
            onSelectInspectorView,
          })}
        />,
      );

      expect(screen.getByText('选择一个语句来查看属性')).toBeTruthy();
      expect(screen.queryByTestId('raw-script-view')).toBeNull();
    });

    it('switches right panel to EngineSnapshotTab when clicking "运行快照" and back', () => {
      const onSelectInspectorView = vi.fn();
      const { rerender } = render(
        <PropertyInspectorShell
          {...createProps({
            onSelectInspectorView,
          })}
        />,
      );

      // Click "运行快照" button
      const snapshotBtn = screen.getByRole('button', { name: '运行快照' });
      fireEvent.click(snapshotBtn);
      expect(onSelectInspectorView).toHaveBeenCalledWith('snapshot');

      // Re-render in snapshot view
      rerender(
        <PropertyInspectorShell
          {...createProps({
            inspectorView: 'snapshot',
            onSelectInspectorView,
          })}
        />,
      );

      expect(screen.getByTestId('engine-snapshot-view')).toBeTruthy();
      expect(screen.getByText('运行快照面板内容')).toBeTruthy();

      // Click "返回属性检查器"
      const backBtn = screen.getByRole('button', { name: /返回属性检查器/ });
      fireEvent.click(backBtn);
      expect(onSelectInspectorView).toHaveBeenCalledWith('actions');

      // Re-render back in actions view
      rerender(
        <PropertyInspectorShell
          {...createProps({
            inspectorView: 'actions',
            onSelectInspectorView,
          })}
        />,
      );

      expect(screen.getByText('选择一个语句来查看属性')).toBeTruthy();
      expect(screen.queryByTestId('engine-snapshot-view')).toBeNull();
    });

    it('switches right panel to DiagnosticsTab when validation-pill sets view to diagnostics, and back', () => {
      const onSelectInspectorView = vi.fn();

      // Simulate top-bar validation-pill clicked -> sets inspectorView='diagnostics'
      const { rerender } = render(
        <PropertyInspectorShell
          {...createProps({
            inspectorView: 'diagnostics',
            onSelectInspectorView,
          })}
        />,
      );

      expect(screen.getByTestId('diagnostics-view')).toBeTruthy();
      expect(screen.getByText('问题诊断面板内容')).toBeTruthy();

      // Has "返回属性检查器" button
      const backBtn = screen.getByRole('button', { name: /返回属性检查器/ });
      fireEvent.click(backBtn);
      expect(onSelectInspectorView).toHaveBeenCalledWith('actions');

      // Re-render in actions view
      rerender(
        <PropertyInspectorShell
          {...createProps({
            inspectorView: 'actions',
            onSelectInspectorView,
          })}
        />,
      );

      expect(screen.getByText('选择一个语句来查看属性')).toBeTruthy();
      expect(screen.queryByTestId('diagnostics-view')).toBeNull();
    });

    it('returns to Property Inspector when an action is selected while in diagnostics view', () => {
      const onSelectInspectorView = vi.fn();

      const { rerender } = render(
        <PropertyInspectorShell
          {...createProps({
            inspectorView: 'diagnostics',
            selectedActionIds: {},
            onSelectInspectorView,
          })}
        />,
      );

      expect(screen.getByTestId('diagnostics-view')).toBeTruthy();

      // Simulate action selected from diagnostic issue
      rerender(
        <PropertyInspectorShell
          {...createProps({
            inspectorView: 'diagnostics',
            selectedActionIds: { action_1: true },
            detailSelectedActionIds: { action_1: true },
            onSelectInspectorView,
          })}
        />,
      );

      expect(onSelectInspectorView).toHaveBeenCalledWith('actions');
    });

    it('renders InspectorArea through PropertyInspectorShell in tracks mode', () => {
      render(
        <InspectorArea
          {...createProps({
            selectedActionIds: { action_1: true },
            detailSelectedActionIds: { action_1: true },
            layoutMode: 'split',
            navigatorWidth: 400,
            detailWidth: 360,
          })}
        />,
      );

      // In tracks mode, InspectorArea delegates to PropertyInspectorShell
      expect(screen.getByTestId('action-inspector')).toBeTruthy();
      expect(screen.getByRole('button', { name: '场景 JSON' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '运行快照' })).toBeTruthy();
    });
  });
});
