/** @vitest-environment jsdom */
import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCENE_SCHEMA_VERSION } from '../api/types/semantic-scene';
import { sceneDocumentCodec, sceneStatementCompiler } from '../services/semantic-scene';
import { TimelineListView } from '../ui/timeline/TimelineListView';
import { InlineStatementDetails } from '../ui/timeline/InlineStatementDetails';

const state = vi.hoisted(() => ({
  document: null as any,
  compiledScene: null as any,
  author: vi.fn(async (_intent: unknown) => ({})),
  setCustomMotionEditorActionId: vi.fn(),
  characterAdapter: {
    getModelDataFromPath: vi.fn(async () => ({ motions: ['wave'], expressions: ['smile'] })),
    playMotion: vi.fn(), stopAllMotions: vi.fn(), setExpression: vi.fn(),
  },
}));

vi.mock('../ui/context/AppContext', () => ({
  useApp: () => ({
    stores: { editor: { setCopyBuffer: vi.fn(), setCustomMotionEditorActionId: state.setCustomMotionEditorActionId } },
    services: { semanticAuthoring: { author: state.author } },
  }),
  useOptionalApp: () => null,
  useCharacterAdapter: () => state.characterAdapter,
  usePlaybackAdapter: () => ({ getCurrentTime: () => 0, subscribeTime: () => () => {}, seek: vi.fn(), play: vi.fn() }),
  useDocumentStore: () => ({
    version: 1, filePath: null, subscribe: () => () => {},
    getCurrentSceneDocumentSnapshot: () => state.document,
    getCompiledSceneSnapshot: () => state.compiledScene,
  }),
  useSemanticAuthoringService: () => ({
    author: state.author,
    authorTransaction: async (build: any) => {
      for (const intent of build(state.document)) await state.author(intent);
    },
    undo: vi.fn(), redo: vi.fn(),
  }),
  useProjectWorkspaceService: () => undefined,
  useIsCollaborationUndoDisabled: () => false,
  useCollaborationStatus: () => 'disconnected',
  useCollaborationPresence: () => ({ peers: [] }),
  useSceneAssetService: () => undefined,
  useResourceAuthoringService: () => undefined,
}));
vi.mock('../ui/store/storeHooks', () => ({
  useSemanticDocument: () => ({ document: state.document, filePath: null }),
  useValidationIssues: () => ({ issues: [] }),
  useCustomMotionEditorActionId: () => null,
}));
vi.mock('../ui/SettingsStore', () => ({
  useSettings: () => ({ settings: { workbenchTimelineLayoutMode: 'list', workbenchDialogueFlowMode: 'auto' }, setSetting: vi.fn() }),
  getDefaultDialogueDurationSeconds: () => 2,
}));

function load(
  type: string,
  params: Record<string, unknown>,
  characters: Array<Record<string, unknown>> = [{ id: 'alice', name: 'Alice' }],
) {
  state.document = sceneDocumentCodec.parseAndValidate({
    schemaVersion: SCENE_SCHEMA_VERSION, sceneId: 'inline-details',
    meta: { title: 'Inline details', characters },
    statements: [{ id: 'line', time: 0, type, params }],
  });
  state.compiledScene = sceneStatementCompiler.compile(state.document);
}
function list(extra: Partial<Parameters<typeof TimelineListView>[0]> = {}) {
  return render(<TimelineListView sceneData={{ sceneId: state.document.sceneId, meta: state.document.meta, timeline: [] }}
    selectedActionIds={{}} setSelectedIds={vi.fn()} addAction={vi.fn()} handleSelect={vi.fn()}
    setCurrentTime={vi.fn()} loadExample={vi.fn(async () => true)} {...extra} />);
}
function expand(container: HTMLElement) {
  fireEvent.click(screen.getByRole('button', { name: '展开详情' }));
  return within(container.querySelector('.inspector-workspace__detail') as HTMLElement);
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  vi.stubGlobal('PointerEvent', MouseEvent);
  state.author.mockClear();
  state.setCustomMotionEditorActionId.mockClear();
  load('dialogue', { speakerId: 'alice', text: '第一句台词', durationSeconds: 2 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('script authoring inline details', () => {
  it('toggles only the clicked statement while preserving expanded, collapsed and selected siblings', () => {
    state.document = sceneDocumentCodec.parseAndValidate({
      ...state.document,
      statements: ['first', 'second', 'third'].map((id) => ({
        id, type: 'dialogue', time: 0, params: { text: id, durationSeconds: 2 },
      })),
    });
    state.compiledScene = sceneStatementCompiler.compile(state.document);
    const handleSelect = vi.fn();
    const selectedId = state.compiledScene.actions[0].id;
    const { container } = list({ handleSelect, selectedActionIds: { [selectedId]: true } });
    const rows = Array.from(container.querySelectorAll('.timeline-item')) as HTMLElement[];
    const firstPanel = rows[0].parentElement?.querySelector('.inspector-workspace__detail');
    expect(firstPanel).toBeTruthy();
    expect(rows[0].classList.contains('timeline-item--active')).toBe(false);

    fireEvent.pointerDown(rows[1], { button: 0 });
    expect(rows[1].dataset.pressed).toBe('true');
    fireEvent.pointerUp(rows[1]);
    fireEvent.click(rows[1]);
    const secondPanel = rows[1].parentElement?.querySelector('.inspector-workspace__detail');
    expect(secondPanel).toBeTruthy();
    expect(rows[1].dataset.pressed).toBeUndefined();
    expect(rows[0].parentElement?.querySelector('.inspector-workspace__detail')).toBe(firstPanel);
    expect(rows[2].classList.contains('timeline-item--expanded')).toBe(false);

    fireEvent.click(rows[0]);
    expect(rows[0].parentElement?.querySelector('.inspector-workspace__detail')).toBeNull();
    expect(rows[1].parentElement?.querySelector('.inspector-workspace__detail')).toBe(secondPanel);
    expect(rows[2].classList.contains('timeline-item--expanded')).toBe(false);
    expect(handleSelect).not.toHaveBeenCalled();
    expect(container.querySelector('.timeline-item--active')).toBeNull();
  });

  it('keeps modifier-click selection available separately from expansion', () => {
    const handleSelect = vi.fn();
    const { container } = list({ handleSelect });
    const row = container.querySelector('.timeline-item') as HTMLElement;
    fireEvent.click(row, { ctrlKey: true });
    expect(handleSelect).toHaveBeenCalledWith(expect.any(String), true);
    expect(container.querySelector('.inspector-workspace__detail')).toBeNull();
  });

  it.each([
    '.timeline-item', '.timeline-item__title', '.timeline-item__inline-controls',
    '.timeline-item__quick-fields', '.timeline-item__actions',
  ])('expands from %s with feedback on the whole row without changing selection', (selector) => {
    const handleSelect = vi.fn();
    const { container } = list({ handleSelect });
    const row = container.querySelector('.timeline-item') as HTMLElement;
    const target = container.querySelector(selector) as HTMLElement;
    fireEvent.pointerDown(target, { button: 0 });
    expect(row.dataset.pressed).toBe('true');
    fireEvent.pointerUp(target);
    expect(row.dataset.pressed).toBeUndefined();
    fireEvent.click(target);
    expect(handleSelect).not.toHaveBeenCalled();
    expect(container.querySelector('.inspector-workspace__detail')).toBeTruthy();
    fireEvent.click(target);
    expect(handleSelect).not.toHaveBeenCalled();
    expect(container.querySelector('.inspector-workspace__detail')).toBeNull();
  });

  it('keeps editing, picker options and playback independent of row selection', () => {
    const handleSelect = vi.fn();
    const { container } = list({ handleSelect });
    const row = container.querySelector('.timeline-item') as HTMLElement;
    const controls = [
      screen.getByRole('textbox', { name: '编辑台词内容' }),
      container.querySelector('.timeline-item__quick-fields [role="spinbutton"]') as HTMLElement,
      screen.getByRole('button', { name: '播放到此句' }),
      screen.getByRole('combobox', { name: '选择说话角色' }),
    ];
    for (const control of controls) {
      fireEvent.pointerDown(control, { button: 0 });
      expect(row.dataset.pressed).toBeUndefined();
      fireEvent.pointerUp(control);
      fireEvent.click(control);
    }
    fireEvent.click(screen.getByRole('option', { name: '(旁白)' }));
    expect(handleSelect).not.toHaveBeenCalled();
    expect(container.querySelector('.inspector-workspace__detail')).toBeNull();
    expect(state.author).toHaveBeenCalled();
  });

  it('clears row feedback when a press is cancelled or leaves the row', () => {
    const { container } = list();
    const row = container.querySelector('.timeline-item') as HTMLElement;
    fireEvent.pointerDown(row, { button: 0 });
    fireEvent.pointerCancel(row);
    expect(row.dataset.pressed).toBeUndefined();
    fireEvent.pointerDown(row, { button: 0 });
    fireEvent.pointerLeave(row);
    expect(row.dataset.pressed).toBeUndefined();
    fireEvent.pointerDown(row, { button: 2 });
    expect(row.dataset.pressed).toBeUndefined();
  });

  it('preserves a composing draft when expanding from blank space in its row', () => {
    const { container } = list();
    const text = screen.getByRole('textbox', { name: '编辑台词内容' }) as HTMLTextAreaElement;
    fireEvent.mouseDown(text);
    act(() => text.focus());
    fireEvent.compositionStart(text);
    fireEvent.change(text, { target: { value: '正在输入' } });
    const blank = container.querySelector('.timeline-item__quick-fields') as HTMLElement;
    const mouseDown = createEvent.mouseDown(blank);
    fireEvent(blank, mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
    fireEvent.click(blank);
    expect(document.activeElement).toBe(text);
    expect(text.value).toBe('正在输入');
    expect(state.author).not.toHaveBeenCalled();
  });

  it('keeps dialogue basics in one place and retains voice, style and companion settings', () => {
    const { container } = list();
    const text = screen.getByRole('textbox', { name: '编辑台词内容' });
    const detail = expand(container);
    expect(screen.getByRole('textbox', { name: '编辑台词内容' })).toBe(text);
    expect(container.querySelectorAll('textarea')).toHaveLength(1);
    expect(detail.queryByText('对话文本')).toBeNull();
    expect(detail.queryByText('绑定角色')).toBeNull();
    expect(detail.queryByText('时长')).toBeNull();
    expect(detail.getByText('语音文件')).toBeTruthy();
    expect(detail.getByRole('button', { name: '语音工作台' })).toBeTruthy();
    expect(detail.getByText('口型同步')).toBeTruthy();
    expect(detail.queryByText('基础属性')).toBeNull();
  });

  it('preserves a composing draft, cursor and focus while expanding and collapsing the same textarea', () => {
    list();
    const text = screen.getByRole('textbox', { name: '编辑台词内容' }) as HTMLTextAreaElement;
    expect(text.rows).toBe(2);
    fireEvent.mouseDown(text);
    act(() => text.focus());
    fireEvent.compositionStart(text);
    fireEvent.change(text, { target: { value: '正在编写的新台词' } });
    text.setSelectionRange(3, 5);
    const expandButton = screen.getByRole('button', { name: '展开详情' });
    const mouseDown = createEvent.mouseDown(expandButton);
    fireEvent(expandButton, mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
    fireEvent.click(expandButton);
    expect(screen.getByRole('textbox', { name: '编辑台词内容' })).toBe(text);
    expect(text.rows).toBe(5);
    expect(text.value).toBe('正在编写的新台词');
    expect(text.selectionStart).toBe(3);
    expect(text.selectionEnd).toBe(5);
    expect(document.activeElement).toBe(text);
    expect(state.author).not.toHaveBeenCalled();
    fireEvent.compositionEnd(text);
    fireEvent.click(screen.getByRole('button', { name: '折叠详情' }));
    expect(screen.getByRole('textbox', { name: '编辑台词内容' })).toBe(text);
    expect(text.rows).toBe(2);
    expect(text.value).toBe('正在编写的新台词');
    expect(state.author).not.toHaveBeenCalled();
  });

  it('grows from five to ten lines, retains a manual height and resets on collapse', () => {
    list();
    const text = screen.getByRole('textbox', { name: '编辑台词内容' }) as HTMLTextAreaElement;
    // jsdom has no text layout; model the native metrics consumed by autosizing.
    text.style.lineHeight = '20px';
    text.style.padding = '6px 8px';
    text.style.border = '1px solid';
    Object.defineProperty(text, 'scrollHeight', { configurable: true, get: () => text.value.split('\n').length * 20 + 12 });
    fireEvent.click(screen.getByRole('button', { name: '展开详情' }));
    expect(text.style.height).toBe('114px');
    fireEvent.mouseDown(text);
    fireEvent.focus(text);
    fireEvent.change(text, { target: { value: Array(8).fill('台词').join('\n') } });
    expect(text.style.height).toBe('174px');
    fireEvent.change(text, { target: { value: Array(15).fill('台词').join('\n') } });
    expect(text.style.height).toBe('214px');
    text.style.height = '194px';
    fireEvent.change(text, { target: { value: '较短的台词' } });
    expect(text.style.height).toBe('194px');
    fireEvent.click(screen.getByRole('button', { name: '折叠详情' }));
    expect(text.style.height).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '展开详情' }));
    expect(text.style.height).toBe('114px');
  });

  it('omits duplicated camera shake controls while retaining frequency, direction and decay', () => {
    load('camera', { mode: 'shake', intensity: 0.4, durationSeconds: 1 });
    const { container } = list();
    const detail = expand(container);
    expect(screen.getAllByRole('spinbutton', { name: '震动强度' })).toHaveLength(1);
    expect(screen.getAllByRole('spinbutton', { name: '震动时长' })).toHaveLength(1);
    expect(detail.queryByRole('spinbutton', { name: '震动强度' })).toBeNull();
    expect(detail.getByRole('spinbutton', { name: '震动频率' })).toBeTruthy();
    expect(detail.getByRole('checkbox', { name: '衰减' })).toBeTruthy();
  });

  it('retains camera zoom type and easing without duplicating its numeric value or endpoint', () => {
    load('camera', { mode: 'move', to: [0.4, 0.6], zoom: { kind: 'absolute', value: 1.5 }, durationSeconds: 1 });
    const { container } = list();
    const detail = expand(container);
    expect(screen.getAllByRole('spinbutton', { name: '终点变焦' })).toHaveLength(1);
    expect(detail.queryByRole('spinbutton', { name: '终点变焦' })).toBeNull();
    expect(detail.queryByText('移动终点')).toBeNull();
    expect(detail.getByRole('combobox', { name: '终点变焦类型' })).toBeTruthy();
    expect(detail.getByText('移动缓动')).toBeTruthy();
  });

  it.each([
    ['characterTransform', { id: 'alice', position: [0.5, 1], scale: 1, durationSeconds: 1 }, ['空间坐标', '缩放比例', '时长'], '深度 (Z)'],
    ['environmentLayer', { mode: 'set', layerId: 'background', file: 'background.png', opacity: 1 }, ['不透明度', '时长'], '过渡方式'],
    ['audio', { role: 'bgm', mode: 'play', file: 'music.ogg', volume: 0.8 }, ['音量大小', '淡出'], '循环播放'],
  ])('keeps additional %s settings without duplicating row fields', (type, params, labels, additional) => {
    load(type, params);
    const { container } = list();
    const detail = expand(container);
    for (const label of labels) expect(detail.queryByText(label)).toBeNull();
    expect(detail.getByText(additional)).toBeTruthy();
    expect(container.querySelectorAll('.inspector-section-title').length).toBeGreaterThan(0);
  });

  it('keeps resource browsing without repeating the file path in details', () => {
    load('audio', { role: 'bgm', mode: 'play', file: 'music.ogg' });
    const { container } = list();
    const detail = expand(container);
    expect(detail.getByRole('button', { name: '音频文件' })).toBeTruthy();
    expect(detail.getByText('选择背景音乐...')).toBeTruthy();
    expect(detail.queryByText('music.ogg')).toBeNull();
    expect(screen.getByRole('textbox', { name: '音频文件' })).toBeTruthy();
  });

  it.each([
    { model: '@mount/figure/figure/hero/main.model3.json', label: '主模型' },
    { model: undefined, label: '主模型' },
    { model: 'figure/hero/winter.model3.json', label: '冬装' },
    { model: 'figure/hero/ad-hoc.model3.json', label: '自定义模型' },
  ])('shows $label instead of a filename for the row model picker', ({ model, label }) => {
    load('characterPresence', { mode: 'enter', id: 'alice', ...(model ? { model } : {}) }, [{
      id: 'alice', name: 'Alice', model: '@mount/figure/figure/hero/main.model3.json',
      variants: [{ name: '冬装', model: 'figure/hero/winter.model3.json' }],
    }]);
    list();
    const picker = screen.getByRole('combobox', { name: '模型变体' });
    expect(picker.textContent).toBe(label);
    expect(picker.textContent).not.toContain('.model3.json');
  });

  it.each(['row', 'details'])('writes the actual main model path when selected in %s', async (location) => {
    const mainModel = '@mount/figure/figure/hero/main.model3.json';
    load('characterPresence', { mode: 'enter', id: 'alice', model: 'figure/hero/winter.model3.json', opacity: 0.8 }, [{
      id: 'alice', name: 'Alice', model: mainModel,
      variants: [{ name: '冬装', model: 'figure/hero/winter.model3.json' }],
    }]);
    const { container } = list();
    const picker = location === 'details'
      ? expand(container).getByRole('combobox', { name: '模型变体' })
      : screen.getByRole('combobox', { name: '模型变体' });
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole('option', { name: '主模型' }));
    await waitFor(() => expect(state.author).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'update-statement', statementId: 'line',
      patch: { params: expect.objectContaining({ mode: 'enter', id: 'alice', model: mainModel, opacity: 0.8 }) },
    })));
  });

  it('offers only characters in the character picker when a model is already assigned', () => {
    load('characterPresence', { mode: 'enter', id: 'alice', model: 'figure/alice/main.model3.json' }, [{
      id: 'alice', name: 'Alice', model: 'figure/alice/main.model3.json',
    }]);
    list();
    const picker = screen.getByRole('combobox', { name: '选择角色' });
    expect(picker.textContent).toBe('Alice');
    fireEvent.click(picker);
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Alice']);
  });

  it('offers only actual models when the character has variants but no main model', () => {
    load('characterPresence', { mode: 'enter', id: 'alice', model: 'figure/alice/winter.model3.json' }, [{
      id: 'alice', name: 'Alice',
      variants: [{ name: '冬装', model: 'figure/alice/winter.model3.json' }],
    }]);
    list();
    const picker = screen.getByRole('combobox', { name: '模型变体' });
    expect(picker.textContent).toBe('冬装');
    fireEvent.click(picker);
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['冬装']);
  });

  it('retains model variant selection without repeating the current model path', async () => {
    load('characterPresence', { mode: 'enter', id: 'alice', model: 'alice.model3.json' }, [
      {
        id: 'alice', name: 'Alice', model: 'figure/alice/main.model3.json',
        variants: [
          { name: '冬装', model: 'figure/alice/winter.model3.json' },
          { name: '夏装', model: 'figure/alice/summer.model3.json' },
        ],
      },
    ]);
    const { container } = list();
    const detail = expand(container);
    expect(detail.getByRole('combobox', { name: '模型变体' })).toBeTruthy();
    expect(detail.getByText('自定义模型')).toBeTruthy();
    expect(detail.queryByText('alice.model3.json')).toBeNull();
    expect(detail.queryByText('空间坐标')).toBeNull();
    // The registered-model catalog stays one column: no group rails, and no meaningless "current file" entry.
    fireEvent.click(detail.getByRole('combobox', { name: '模型变体' }));
    expect(screen.queryByRole('listbox', { name: '一级分组' })).toBeNull();
    expect(screen.queryByRole('listbox', { name: '二级分组' })).toBeNull();
    expect(screen.getByRole('option', { name: '主模型' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '冬装' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '夏装' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: '当前模型文件' })).toBeNull();
    fireEvent.keyDown(detail.getByRole('combobox', { name: '模型变体' }), { key: 'Escape' });
    await waitFor(() => expect(state.characterAdapter.getModelDataFromPath).toHaveBeenCalledWith('alice.model3.json'));
  });

  it('keeps background layer editing in the row without an extra layer creation selector', () => {
    load('environmentLayer', { mode: 'set', layerId: 'background', file: 'background.png' });
    const { container } = list();
    const detail = expand(container);
    expect(detail.queryByRole('combobox', { name: '选择或新建环境层' })).toBeNull();
    expect(detail.queryByRole('combobox', { name: '环境层名称' })).toBeNull();
    expect((screen.getByRole('textbox', { name: '环境层名称' }) as HTMLInputElement).value).toBe('background');
  });

  it('omits integration basics while retaining color controls', () => {
    load('visualStyle', { scope: 'object', target: 'alice', slot: 'integration', mode: 'set', recipeId: 'builtin:integration-soft', intensity: 0.8, durationSeconds: 0.5 });
    const { container } = list();
    const detail = expand(container);
    expect(detail.queryByText('角色')).toBeNull();
    expect(detail.queryByRole('spinbutton', { name: '染色强度' })).toBeNull();
    expect(detail.queryByRole('spinbutton', { name: '过渡时长' })).toBeNull();
    expect(detail.getByRole('spinbutton', { name: '亮度' })).toBeTruthy();
    expect(detail.getByRole('combobox', { name: '颜色混合' })).toBeTruthy();
  });

  it('keeps effective integration override fields editable in details', () => {
    load('visualStyle', { scope: 'object', target: 'alice', slot: 'integration', mode: 'set', recipeId: 'builtin:integration-soft',
      semanticOverride: { intensity: 0.6, brightness: 0.1 } });
    const { container } = list();
    const detail = expand(container);
    expect(screen.queryByRole('spinbutton', { name: '强度' })).toBeNull();
    expect(detail.getByRole('spinbutton', { name: '染色强度' }).getAttribute('aria-valuenow')).toBe('0.6');
  });

  it('keeps resource-motion browsing and conversion without repeating the current action', () => {
    load('characterPerformance', { target: 'alice', motion: { kind: 'resource', key: 'wave', fadeInSeconds: 0.3 } });
    const { container } = list();
    const detail = expand(container);
    expect(detail.getByText('浏览并预览动作…')).toBeTruthy();
    expect(detail.queryByText('wave')).toBeNull();
    expect(detail.getByTestId('resource-motion-conversion')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '动作名称' })).toBeTruthy();
  });

  it('retains the custom motion keyframe editor', () => {
    load('characterPerformance', { target: 'alice', motion: { kind: 'custom', durationSeconds: 1, fadeInSeconds: 0,
      derivedFrom: { key: 'wave' }, tracks: [{ parameterId: 'ParamAngleX', keyframes: [{ time: 0, value: 0 }] }] } });
    const { container } = list();
    const detail = expand(container);
    fireEvent.click(detail.getByRole('button', { name: '编辑关键帧' }));
    expect(state.setCustomMotionEditorActionId).toHaveBeenCalledWith('statementId:4:line|outputKey:6:motion');
    expect((screen.getByRole('textbox', { name: '动作名称' }) as HTMLInputElement).readOnly).toBe(true);
  });
});

describe('inline detail motion', () => {
  it('holds the collapsed animation frame until React removes the detail element', async () => {
    let exit: { cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null } | undefined;
    const exposedFrames: boolean[] = [];
    const animate = vi.fn(function (this: HTMLElement) {
      const element = this;
      exit = {
        cancel: vi.fn(() => exposedFrames.push(element.isConnected)),
        onfinish: null,
      };
      return exit;
    });
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    try {
      const view = render(<InlineStatementDetails expanded>Settings</InlineStatementDetails>);
      view.rerender(<InlineStatementDetails expanded={false}>Settings</InlineStatementDetails>);
      const closing = view.container.querySelector('.inspector-workspace__detail');
      expect(closing?.isConnected).toBe(true);
      // A native animation callback runs before React commits its queued removal.
      await act(async () => {
        exit!.onfinish?.();
        expect(exposedFrames).not.toContain(true);
      });
      expect(closing?.isConnected).toBe(false);
      expect(exit!.cancel).toHaveBeenCalled();
    } finally { delete (HTMLElement.prototype as any).animate; }
  });

  it('animates opening and retains closing content until exit finishes, skipping expanded remounts', () => {
    const animations: { cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null }[] = [];
    const animate = vi.fn(() => {
      const animation = { cancel: vi.fn(), onfinish: null as (() => void) | null };
      animations.push(animation);
      return animation;
    });
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    try {
      const view = render(<InlineStatementDetails expanded={false}>Settings</InlineStatementDetails>);
      view.rerender(<InlineStatementDetails expanded>Settings</InlineStatementDetails>);
      expect(animate).toHaveBeenCalledTimes(1);
      view.rerender(<InlineStatementDetails expanded>Updated settings</InlineStatementDetails>);
      expect(animate).toHaveBeenCalledTimes(1);
      view.rerender(<InlineStatementDetails expanded={false}>Settings</InlineStatementDetails>);
      expect(animations[0].cancel).toHaveBeenCalledTimes(1);
      expect(animate).toHaveBeenCalledTimes(2);
      const closing = view.container.querySelector('.inspector-workspace__detail');
      expect(closing?.textContent).toBe('Settings');
      expect(closing?.getAttribute('aria-hidden')).toBe('true');
      expect(closing?.hasAttribute('inert')).toBe(true);
      act(() => animations[1].onfinish?.());
      expect(view.container.querySelector('.inspector-workspace__detail')).toBeNull();
      view.unmount();
      render(<InlineStatementDetails expanded>Remounted virtual row</InlineStatementDetails>);
      expect(animate).toHaveBeenCalledTimes(2);
    } finally { delete (HTMLElement.prototype as any).animate; }
  });

  it('cancels a pending exit when details reopen and keeps the inspector mounted during exit', () => {
    const animations: { cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null }[] = [];
    const animate = vi.fn(() => {
      const animation = { cancel: vi.fn(), onfinish: null as (() => void) | null };
      animations.push(animation);
      return animation;
    });
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    try {
      const { container } = list();
      expand(container);
      fireEvent.click(screen.getByRole('button', { name: '折叠详情' }));
      const closing = container.querySelector('.inspector-workspace__detail');
      expect(closing?.textContent).toContain('语音文件');
      const exit = animations[1];
      fireEvent.click(screen.getByRole('button', { name: '展开详情' }));
      expect(exit.cancel).toHaveBeenCalled();
      expect(exit.onfinish).toBeNull();
      expect(container.querySelector('.inspector-workspace__detail')).toBe(closing);
      expect(closing?.getAttribute('aria-hidden')).toBe('false');
      expect(closing?.hasAttribute('inert')).toBe(false);
    } finally { delete (HTMLElement.prototype as any).animate; }
  });

  it.each(['reduced-motion', 'low-performance'])('skips animation for %s', (mode) => {
    const animate = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    if (mode === 'reduced-motion') vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const content = (expanded: boolean) => <div data-perf={mode === 'low-performance' ? 'low' : 'high'}>
      <InlineStatementDetails expanded={expanded}>Settings</InlineStatementDetails>
    </div>;
    try {
      const view = render(content(false));
      view.rerender(content(true));
      view.rerender(content(false));
      expect(animate).not.toHaveBeenCalled();
      expect(view.container.querySelector('.inspector-workspace__detail')).toBeNull();
    } finally { delete (HTMLElement.prototype as any).animate; }
  });
});
