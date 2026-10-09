/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { editNumericControl } from './fixtures/editNumericControl';
import { computeSidePanelWidth } from '../App';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import { sceneDocumentCodec, sceneStatementCompiler } from '../services/semantic-scene';
import { SemanticTimelineAuthoringService } from '../services/timeline-authoring/SemanticTimelineAuthoringService';
import { TimelineListView } from '../ui/timeline/TimelineListView';

const state = vi.hoisted(() => ({
  document: null as any,
  compiledScene: null as any,
  authorMock: vi.fn(async (_intent: any) => ({})),
  collaborationStatus: 'disconnected',
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
    authorTransaction: async (build: any) => {
      const intents = typeof build === 'function' ? build(state.document) : build;
      for (const intent of intents) {
        await state.authorMock(intent);
        state.document = new SemanticTimelineAuthoringService().author(state.document, intent).document;
        state.compiledScene = sceneStatementCompiler.compile(state.document);
      }
    },
    undo: vi.fn(),
    redo: vi.fn(),
  }),
  useProjectWorkspaceService: () => undefined,
  useIsCollaborationUndoDisabled: () => false,
  useCollaborationStatus: () => state.collaborationStatus,
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
    state.collaborationStatus = 'disconnected';
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

    it('toggles expansion when clicking the statement title button', () => {
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

      const titleButtons = screen.getAllByRole('button', { name: /^展开.+详情$/ });
      expect(titleButtons.length).toBeGreaterThanOrEqual(3);

      // Click statement title button to expand
      fireEvent.click(titleButtons[0]);
      expect(container.querySelectorAll('.inspector-workspace__detail')).toHaveLength(1);

      // Click statement title button again to collapse
      fireEvent.click(titleButtons[0]);
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
      expect(speakerSelects[0].textContent).toBe('Alice');

      // Change speaker inline
      fireEvent.click(speakerSelects[0]);
      fireEvent.click(screen.getByRole('option', { name: 'Bob' }));
      expect(state.authorMock).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'update-statement',
        patch: expect.objectContaining({
          params: expect.objectContaining({
            speakerId: 'bob',
            speaker: 'Bob',
          }),
        }),
      }));
      expect(updateAction).not.toHaveBeenCalled();

      // Inline text input is visible and directly editable
      const textInputs = screen.getAllByRole('textbox', { name: '编辑台词内容' });
      expect(textInputs.length).toBeGreaterThanOrEqual(2);
      expect((textInputs[0] as HTMLInputElement).value).toBe('你好，这是第一句台词。');

      // Keep typing local; commit the final draft on blur
      fireEvent.mouseDown(textInputs[0]);
      fireEvent.focus(textInputs[0]);
      fireEvent.change(textInputs[0], { target: { value: '修改后的台词内容' } });
      fireEvent.blur(textInputs[0]);
      expect(state.authorMock).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'update-statement',
        patch: expect.objectContaining({
          params: expect.objectContaining({
            text: '修改后的台词内容',
          }),
        }),
      }));
      expect(updateParam).not.toHaveBeenCalled();
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
      expect(intensityInput.getAttribute('aria-valuenow')).toBe('1.5');
      expect(durationInput.getAttribute('aria-valuenow')).toBe('1');

      // Change camera intensity inline
      editNumericControl(intensityInput, '2.5');
      expect(state.authorMock).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'update-statement',
        patch: expect.objectContaining({
          params: expect.objectContaining({ intensity: 2.5 }),
        }),
      }));
      expect(updateParam).not.toHaveBeenCalled();
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

  describe('Canonical quick editing', () => {
    function loadStatements(statements: unknown[]) {
      state.document = sceneDocumentCodec.parseAndValidate({ ...testDocument(), statements });
      state.compiledScene = sceneStatementCompiler.compile(state.document);
    }
    function renderList(extra: Partial<Parameters<typeof TimelineListView>[0]> = {}) {
      return render(<TimelineListView
        sceneData={{ sceneId: state.document.sceneId, meta: state.document.meta, timeline: [] }}
        selectedActionIds={{}} setSelectedIds={vi.fn()} addAction={vi.fn()} handleSelect={vi.fn()}
        setCurrentTime={vi.fn()} loadExample={vi.fn(async () => true)} {...extra}
      />);
    }

    it('keeps other rows expanded when collapsing one after expand-all', () => {
      renderList();
      fireEvent.click(screen.getByRole('button', { name: '全部展开' }));
      expect(screen.getAllByTestId('inline-action-inspector')).toHaveLength(3);
      fireEvent.click(screen.getAllByRole('button', { name: '折叠详情' })[0]);
      expect(screen.getAllByTestId('inline-action-inspector')).toHaveLength(2);
    });

    it('retains typing through asynchronous authoring and submits once on blur', async () => {
      state.authorMock.mockImplementationOnce(() => new Promise(() => {}));
      renderList();
      const text = screen.getAllByRole('textbox', { name: '编辑台词内容' })[0] as HTMLTextAreaElement;
      fireEvent.mouseDown(text);
      fireEvent.focus(text);
      fireEvent.change(text, { target: { value: 'First' } });
      fireEvent.change(text, { target: { value: 'First and second' } });
      expect(text.value).toBe('First and second');
      expect(state.authorMock).not.toHaveBeenCalled();
      fireEvent.blur(text);
      await waitFor(() => expect(state.authorMock).toHaveBeenCalledTimes(1));
      expect(text.value).toBe('First and second');
      expect(state.authorMock).toHaveBeenCalledWith(expect.objectContaining({
        patch: expect.objectContaining({ params: expect.objectContaining({ text: 'First and second' }) }),
      }));
    });

    it('cancels a draft with Escape without authoring', () => {
      renderList();
      const text = screen.getAllByRole('textbox', { name: '编辑台词内容' })[0] as HTMLTextAreaElement;
      fireEvent.mouseDown(text);
      fireEvent.focus(text);
      fireEvent.change(text, { target: { value: 'Discard me' } });
      fireEvent.keyDown(text, { key: 'Escape' });
      expect(text.value).toBe('你好，这是第一句台词。');
      expect(state.authorMock).not.toHaveBeenCalled();
    });

    it('mounts only visible inspectors after expanding a long scene', () => {
      loadStatements(Array.from({ length: 200 }, (_, index) => ({
        id: `line-${index}`, type: 'dialogue', time: index * 3,
        params: { text: `Line ${index}`, durationSeconds: 2 },
      })));
      const { container } = renderList();
      expect(container.querySelectorAll('[data-timeline-virtual-row]').length).toBeLessThan(20);
      fireEvent.click(screen.getByRole('button', { name: '全部展开' }));
      expect(screen.getAllByTestId('inline-action-inspector').length).toBeLessThan(20);
    });

    it('edits X and Y while collapsed, preserving queued edits and the other transform fields', async () => {
      loadStatements([{ id: 'move', time: 0, type: 'characterTransform',
        params: { id: 'alice', position: [0.25, 0.8], rotation: 30, durationSeconds: 1 } }]);
      const { container } = renderList();
      editNumericControl(screen.getByRole('spinbutton', { name: '空间坐标 X' }), '-0.5');
      await waitFor(() => expect(state.document.statements[0].params.position[0]).toBe(-0.5));
      // The controls still render the original Y and X. Commit merges against the latest source.
      editNumericControl(screen.getByRole('spinbutton', { name: '空间坐标 Y' }), '1.2');
      await waitFor(() => expect(state.document.statements[0].params).toEqual({
        id: 'alice', position: [-0.5, 1.2], rotation: 30, durationSeconds: 1,
      }));
      expect(container.querySelector('.inspector-workspace__detail')).toBeNull();
      expect(state.compiledScene.actions[0].params).toMatchObject({ position: [-0.5, 1.2] });
    });

    it('does not display dialogue or action summaries in the compact outline', () => {
      const { container } = renderList({ inlineExpandable: false });
      expect(screen.queryByText('你好，这是第一句台词。')).toBeNull();
      expect(container.querySelector('.timeline-item__outline-text')).toBeNull();
      expect(container.querySelectorAll('.timeline-item--compact').length).toBeGreaterThan(0);
      expect(container.querySelector('.timeline-item__quick-fields')).toBeNull();
      expect(container.querySelector('.inspector-workspace__detail')).toBeNull();
    });

    it('uses workbench scrubbers and commits a drag once when it ends', async () => {
      const { container } = renderList();
      expect(container.querySelector('input[type="number"]')).toBeNull();
      expect(screen.getAllByRole('spinbutton').every((control) => control.classList.contains('scrubbable-badge'))).toBe(true);
      const intensity = screen.getByRole('spinbutton', { name: '震动强度' });
      fireEvent.mouseDown(intensity, { clientX: 10, clientY: 10, button: 0 });
      fireEvent.mouseMove(document, { clientX: 46, clientY: 10, movementX: 36 });
      expect(state.authorMock).not.toHaveBeenCalled();
      fireEvent.mouseUp(document, { clientX: 46, clientY: 10 });
      await waitFor(() => expect(state.authorMock).toHaveBeenCalledTimes(1));
      expect(state.authorMock).toHaveBeenCalledWith(expect.objectContaining({
        patch: expect.objectContaining({ params: expect.objectContaining({ intensity: 1.6 }) }),
      }));
    });

    it('writes camera durationSeconds rather than the compiled duration key', async () => {
      renderList();
      editNumericControl(screen.getByRole('spinbutton', { name: '震动时长' }), '2.3');
      await waitFor(() => expect(state.document.statements.find((item: any) => item.id === 'camera-1').params.durationSeconds).toBe(2.3));
      expect(state.document.statements.find((item: any) => item.id === 'camera-1').params).not.toHaveProperty('duration');
    });

    it('clears speaker metadata when switching to narration and applies the next character color', async () => {
      state.document = sceneDocumentCodec.parseAndValidate({ ...state.document,
        meta: { ...state.document.meta, characters: [{ id: 'alice', name: 'Alice', color: '#abcdef' }, { id: 'bob', name: 'Bob', color: '#123456' }] },
        statements: [{ id: 'line', type: 'dialogue', time: 0,
          params: { speakerId: 'alice', speaker: 'Alice', speakerColor: '#abcdef', text: 'Hello', durationSeconds: 2 } }],
      });
      state.compiledScene = sceneStatementCompiler.compile(state.document);
      renderList();
      const speaker = screen.getByRole('combobox', { name: '选择说话角色' });
      fireEvent.click(speaker);
      fireEvent.click(screen.getByRole('option', { name: '(旁白)' }));
      await waitFor(() => expect(state.document.statements[0].params).toEqual({ text: 'Hello', durationSeconds: 2 }));
      fireEvent.click(speaker);
      fireEvent.click(screen.getByRole('option', { name: 'Bob' }));
      await waitFor(() => expect(state.document.statements[0].params).toMatchObject({ speakerId: 'bob', speaker: 'Bob', speakerColor: '#123456' }));
    });

    it('edits a companion through its locator without changing the parent dialogue', async () => {
      loadStatements([{ id: 'line', type: 'dialogue', time: 0,
        params: { text: 'Hello', durationSeconds: 2 }, companions: [{
          id: 'performance', type: 'characterPerformance', anchor: 'start', offset: 0,
          params: { target: 'alice', motion: { kind: 'resource', key: 'wave', fadeInSeconds: 0.4 } },
        }] }]);
      renderList();
      const motion = screen.getByRole('textbox', { name: '动作名称' });
      fireEvent.mouseDown(motion);
      fireEvent.focus(motion);
      fireEvent.change(motion, { target: { value: 'nod' } });
      fireEvent.blur(motion);
      await waitFor(() => expect(state.document.statements[0].companions[0].params.motion).toEqual({ kind: 'resource', key: 'nod', fadeInSeconds: 0.4 }));
      expect(state.authorMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'update-dialogue-companion', locator: expect.objectContaining({ statementId: 'line', companionId: 'performance' }) }));
      expect(state.document.statements[0].params.text).toBe('Hello');
    });

    it('keeps custom motion data while exposing its expanded editor', () => {
      loadStatements([{ id: 'motion', type: 'characterPerformance', time: 0,
        params: { target: 'alice', motion: { kind: 'custom', durationSeconds: 1, fadeInSeconds: 0,
          derivedFrom: { key: 'wave' }, tracks: [{ parameterId: 'ParamAngleX', keyframes: [{ time: 0, value: 0 }] }] } } }]);
      const original = state.document.statements[0].params.motion;
      renderList();
      expect((screen.getByRole('textbox', { name: '动作名称' }) as HTMLInputElement).readOnly).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: '展开详情' }));
      expect(screen.getByTestId('inline-action-inspector')).toBeTruthy();
      expect(state.document.statements[0].params.motion).toEqual(original);
      expect(state.authorMock).not.toHaveBeenCalled();
    });

    it('disables quick fields while collaboration is offline', () => {
      state.collaborationStatus = 'offline';
      renderList();
      const intensity = screen.getByRole('spinbutton', { name: '震动强度' });
      expect(intensity.getAttribute('aria-disabled')).toBe('true');
      fireEvent.keyDown(intensity, { key: 'ArrowUp' });
      fireEvent.mouseDown(intensity, { clientX: 10, clientY: 10 });
      fireEvent.mouseMove(document, { clientX: 50, clientY: 10 });
      fireEvent.mouseUp(document);
      const text = screen.getAllByRole('textbox', { name: '编辑台词内容' })[0];
      expect((text.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
      fireEvent.change(text, { target: { value: 'Blocked' } });
      expect(state.authorMock).not.toHaveBeenCalled();
    });

    it('keeps batch copy and delete available without opening a separate panel', async () => {
      const copyActions = vi.fn();
      const deleteActions = vi.fn();
      const { container } = renderList({ selectedActionIds: { first: true, second: true }, copyActions, deleteActions });
      fireEvent.click(screen.getByRole('button', { name: '复制到剪贴板' }));
      fireEvent.click(screen.getByRole('button', { name: '批量删除' }));
      expect(copyActions).toHaveBeenCalledWith(['first', 'second']);
      await waitFor(() => expect(deleteActions).toHaveBeenCalledWith(['first', 'second']));
      expect(container.querySelector('.inspector-workspace__detail')).toBeNull();
    });

    it('opens an externally selected statement inline and leaves other statements collapsed', () => {
      const selectedId = state.compiledScene.actions.find((action: any) => action.source.statementId === 'dlg-2').id;
      renderList({ selectedActionIds: { [selectedId]: true } });
      expect(screen.getAllByTestId('inline-action-inspector')).toHaveLength(1);
      expect(screen.getByTestId('inline-action-inspector').getAttribute('data-action-id')).toBe(selectedId);
    });
  });

});
