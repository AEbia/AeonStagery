/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeSidePanelWidth } from '../App';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import { sceneDocumentCodec, sceneStatementCompiler } from '../services/semantic-scene';
import { TimelineListView } from '../ui/timeline/TimelineListView';

const state = vi.hoisted(() => ({
  document: null as any,
  compiledScene: null as any,
  authorMock: vi.fn(async () => ({})),
}));

vi.mock('../ui/context/AppContext', () => ({
  usePlaybackAdapter: () => ({
    getCurrentTime: () => 0,
    subscribeTime: () => () => {},
    seek: vi.fn(),
    play: vi.fn(),
  }),
  useDocumentStore: () => ({
    version: 1,
    filePath: null,
    subscribe: () => () => {},
    getCurrentSceneDocumentSnapshot: () => state.document,
    getCompiledSceneSnapshot: () => state.compiledScene,
  }),
  useSemanticAuthoringService: () => ({
    author: state.authorMock,
    undo: vi.fn(),
    redo: vi.fn(),
  }),
  useProjectWorkspaceService: () => undefined,
  useIsCollaborationUndoDisabled: () => false,
  useCollaborationStatus: () => 'disconnected',
  useCollaborationPresence: () => ({ peers: [] }),
  useOptionalApp: () => null,
}));

vi.mock('../ui/store/storeHooks', () => ({
  useSemanticDocument: () => ({ document: state.document, filePath: null }),
  useValidationIssues: () => ({ issues: [] }),
  useCustomMotionEditorActionId: () => null,
}));

vi.mock('../ui/SettingsStore', () => ({
  useSettings: () => ({
    settings: {
      workbenchTimelineLayoutMode: 'list',
      workbenchDialogueFlowMode: 'auto',
    },
    setSetting: vi.fn(),
  }),
}));

vi.mock('../ui/timeline/ActionInspector', () => ({
  ActionInspector: ({ selectedActionIds, onClose }: any) => (
    <div data-testid="inline-action-inspector" data-action-id={Object.keys(selectedActionIds)[0]}>
      <span>内联属性检查器 - {Object.keys(selectedActionIds)[0]}</span>
      <button onClick={() => onClose()}>关闭内联详情</button>
    </div>
  ),
}));

function testDocument(): CurrentSceneDocument {
  return sceneDocumentCodec.parseAndValidate({
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'test-inline-inspector-scene',
    meta: {
      title: 'Inline Inspector Scene',
      characters: [
        { id: 'alice', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
      ],
    },
    statements: [
      {
        id: 'dlg-1',
        time: 0,
        type: 'dialogue',
        params: { speakerId: 'alice', speaker: 'Alice', text: '你好，这是第一句台词。', durationSeconds: 2 },
      },
      {
        id: 'camera-1',
        time: 2,
        type: 'camera',
        params: { mode: 'shake', intensity: 1.5, durationSeconds: 1.0 },
      },
      {
        id: 'dlg-2',
        time: 3,
        type: 'dialogue',
        params: { speakerId: 'bob', speaker: 'Bob', text: '第二句台词在此。', durationSeconds: 2.5 },
      },
    ],
  });
}

describe('List mode inline inspector and layout', () => {
  beforeEach(() => {
    (globalThis as any).ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    state.document = testDocument();
    state.compiledScene = sceneStatementCompiler.compile(state.document);
    state.authorMock.mockClear();
  });

  describe('1. List mode default width & fixed sidePanelWidth', () => {
    it('defaults right panel timeline list width to 600px in list mode', () => {
      // Test default width 600 in 560px~640px range
      const listWidth = computeSidePanelWidth({
        isTracksMode: false,
        panelWidth: 600,
        inspectorNavigatorWidth: 600,
        inspectorLayout: 'split',
        isInspectorDetailVisible: false,
        detailWidth: 360,
      });
      expect(listWidth).toBe(600);
      expect(listWidth).toBeGreaterThanOrEqual(560);
      expect(listWidth).toBeLessThanOrEqual(640);
    });

    it('keeps sidePanelWidth fixed at panel width when detail is visible in list mode', () => {
      const fixedWidthCollapsed = computeSidePanelWidth({
        isTracksMode: false,
        panelWidth: 600,
        inspectorNavigatorWidth: 600,
        inspectorLayout: 'split',
        isInspectorDetailVisible: false,
        detailWidth: 360,
      });
      const fixedWidthExpanded = computeSidePanelWidth({
        isTracksMode: false,
        panelWidth: 600,
        inspectorNavigatorWidth: 600,
        inspectorLayout: 'split',
        isInspectorDetailVisible: true,
        detailWidth: 360,
      });

      // Does NOT pop out a separate side column (+ detailWidth + 4), remains fixed at 600px
      expect(fixedWidthCollapsed).toBe(600);
      expect(fixedWidthExpanded).toBe(600);
    });

    it('supports user-adjusted panel width in 560px~640px range without splitting', () => {
      for (const width of [560, 580, 620, 640]) {
        const computed = computeSidePanelWidth({
          isTracksMode: false,
          panelWidth: width,
          inspectorNavigatorWidth: width,
          inspectorLayout: 'split',
          isInspectorDetailVisible: true,
          detailWidth: 360,
        });
        expect(computed).toBe(width);
      }
    });
  });

  describe('2. Individual statement expand/collapse toggling', () => {
    it('statements are collapsed by default and expand when clicking expand toggle icon or row', () => {
      const { container } = render(
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

      // Collapsed by default: no inspector-workspace__detail rendered
      expect(container.querySelectorAll('.inspector-workspace__detail')).toHaveLength(0);
      expect(screen.queryByTestId('inline-action-inspector')).toBeNull();

      // Find expand buttons
      const expandButtons = screen.getAllByRole('button', { name: '展开详情' });
      expect(expandButtons.length).toBeGreaterThanOrEqual(3);

      // Click first statement's expand toggle
      fireEvent.click(expandButtons[0]);

      // Expanded: inspector-workspace__detail container is rendered inline
      expect(container.querySelectorAll('.inspector-workspace__detail')).toHaveLength(1);
      expect(screen.getByTestId('inline-action-inspector')).toBeTruthy();
      expect(screen.getByRole('button', { name: '折叠详情' })).toBeTruthy();

      // Click again to collapse
      fireEvent.click(screen.getByRole('button', { name: '折叠详情' }));
      expect(container.querySelectorAll('.inspector-workspace__detail')).toHaveLength(0);
      expect(screen.queryByTestId('inline-action-inspector')).toBeNull();
    });

    it('toggles expansion when clicking the statement select button', () => {
      const { container } = render(
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

      const selectButtons = screen.getAllByRole('button', { name: /选择/ });
      expect(selectButtons.length).toBeGreaterThanOrEqual(3);

      // Click statement select button to expand
      fireEvent.click(selectButtons[0]);
      expect(container.querySelectorAll('.inspector-workspace__detail')).toHaveLength(1);

      // Click statement select button again to collapse
      fireEvent.click(selectButtons[0]);
      expect(container.querySelectorAll('.inspector-workspace__detail')).toHaveLength(0);
    });
  });

  describe('3. Global quick controls: 全部展开 and 全部折叠', () => {
    it('provides 全部展开 and 全部折叠 buttons in toolbar to expand and collapse all statements', () => {
      const { container } = render(
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

      const expandAllBtn = screen.getByRole('button', { name: '全部展开' });
      const collapseAllBtn = screen.getByRole('button', { name: '全部折叠' });

      expect(expandAllBtn).toBeTruthy();
      expect(collapseAllBtn).toBeTruthy();

      // Initially all collapsed
      expect(container.querySelectorAll('.inspector-workspace__detail')).toHaveLength(0);

      // Click 全部展开
      fireEvent.click(expandAllBtn);

      // All 3 statements expanded
      expect(container.querySelectorAll('.inspector-workspace__detail')).toHaveLength(3);
      expect(screen.getAllByTestId('inline-action-inspector')).toHaveLength(3);

      // Click 全部折叠
      fireEvent.click(collapseAllBtn);

      // All statements collapsed
      expect(container.querySelectorAll('.inspector-workspace__detail')).toHaveLength(0);
      expect(screen.queryByTestId('inline-action-inspector')).toBeNull();
    });
  });

  describe('4. Inline basic controls when collapsed', () => {
    it('displays inline editable speaker selector and dialogue text in the row when collapsed', () => {
      const updateAction = vi.fn();
      const updateParam = vi.fn();

      render(
        <TimelineListView
          sceneData={{ sceneId: state.document.sceneId, meta: state.document.meta, timeline: [] }}
          selectedActionIds={{}}
          setSelectedIds={vi.fn()}
          addAction={vi.fn()}
          handleSelect={vi.fn()}
          setCurrentTime={vi.fn()}
          loadExample={vi.fn(async () => true)}
          updateAction={updateAction}
          updateParam={updateParam}
        />,
      );

      // Inline speaker selectors are visible
      const speakerSelects = screen.getAllByRole('combobox', { name: '选择说话角色' });
      expect(speakerSelects.length).toBeGreaterThanOrEqual(2);
      expect((speakerSelects[0] as HTMLSelectElement).value).toBe('alice');

      // Change speaker inline
      fireEvent.change(speakerSelects[0], { target: { value: 'bob' } });
      expect(state.authorMock).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'update-statement',
        patch: expect.objectContaining({
          params: expect.objectContaining({
            speakerId: 'bob',
            speaker: 'Bob',
          }),
        }),
      }));
      expect(updateAction).toHaveBeenCalledWith(expect.stringContaining('dlg-1'), expect.objectContaining({
        params: expect.objectContaining({ speakerId: 'bob' }),
      }));

      // Inline text input is visible and directly editable
      const textInputs = screen.getAllByRole('textbox', { name: '编辑台词内容' });
      expect(textInputs.length).toBeGreaterThanOrEqual(2);
      expect((textInputs[0] as HTMLInputElement).value).toBe('你好，这是第一句台词。');

      // Change text inline
      fireEvent.change(textInputs[0], { target: { value: '修改后的台词内容' } });
      expect(state.authorMock).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'update-statement',
        patch: expect.objectContaining({
          params: expect.objectContaining({
            text: '修改后的台词内容',
          }),
        }),
      }));
      expect(updateParam).toHaveBeenCalledWith(expect.stringContaining('dlg-1'), 'text', '修改后的台词内容');
    });

    it('displays inline camera parameter controls in the row when collapsed', () => {
      const updateParam = vi.fn();

      render(
        <TimelineListView
          sceneData={{ sceneId: state.document.sceneId, meta: state.document.meta, timeline: [] }}
          selectedActionIds={{}}
          setSelectedIds={vi.fn()}
          addAction={vi.fn()}
          handleSelect={vi.fn()}
          setCurrentTime={vi.fn()}
          loadExample={vi.fn(async () => true)}
          updateParam={updateParam}
        />,
      );

      // Camera shake intensity & duration inputs
      const intensityInput = screen.getByRole('spinbutton', { name: '震动强度' });
      const durationInput = screen.getByRole('spinbutton', { name: '震动时长' });

      expect(intensityInput).toBeTruthy();
      expect(durationInput).toBeTruthy();
      expect((intensityInput as HTMLInputElement).value).toBe('1.5');
      expect((durationInput as HTMLInputElement).value).toBe('1');

      // Change camera intensity inline
      fireEvent.change(intensityInput, { target: { value: '2.5' } });
      expect(state.authorMock).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'update-statement',
        patch: expect.objectContaining({
          params: expect.objectContaining({ intensity: 2.5 }),
        }),
      }));
      expect(updateParam).toHaveBeenCalledWith(expect.stringContaining('camera-1'), 'intensity', 2.5);
    });
  });

  describe('5. Outline mode (inlineExpandable={false}) in tracks / sidebar mode', () => {
    it('does not render expand buttons or inline edit controls when inlineExpandable is false', () => {
      const handleSelect = vi.fn();
      const { container } = render(
        <TimelineListView
          sceneData={{ sceneId: state.document.sceneId, meta: state.document.meta, timeline: [] }}
          inlineExpandable={false}
          selectedActionIds={{}}
          setSelectedIds={vi.fn()}
          addAction={vi.fn()}
          handleSelect={handleSelect}
          setCurrentTime={vi.fn()}
          loadExample={vi.fn(async () => true)}
        />,
      );

      // No expand toggle buttons or toolbar controls
      expect(screen.queryByRole('button', { name: '展开详情' })).toBeNull();
      expect(screen.queryByRole('button', { name: '全部展开' })).toBeNull();
      expect(screen.queryByRole('button', { name: '全部折叠' })).toBeNull();

      // No inline input controls
      expect(screen.queryByRole('combobox', { name: '选择说话角色' })).toBeNull();
      expect(screen.queryByRole('textbox', { name: '编辑台词内容' })).toBeNull();

      // Cards render with compact class
      const compactItems = container.querySelectorAll('.timeline-item--compact');
      expect(compactItems.length).toBeGreaterThanOrEqual(3);

      // Clicking card triggers handleSelect without expanding
      const selectButtons = screen.getAllByRole('button', { name: /选择/ });
      fireEvent.click(selectButtons[0]);
      expect(handleSelect).toHaveBeenCalledWith(expect.stringContaining('dlg-1'), false);
      expect(container.querySelectorAll('.inspector-workspace__detail')).toHaveLength(0);
    });
  });
});
