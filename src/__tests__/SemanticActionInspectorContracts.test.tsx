/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionInspector } from '../ui/timeline/ActionInspector';

const state = vi.hoisted(() => ({
  document: null as any,
  pickedAssetPath: "",
  compiledScene: null as any,
  validationIssues: [] as any[],
  characterAdapter: {
    getModelDataFromPath: vi.fn(async () => ({ motions: [], expressions: [] })),
    playMotion: vi.fn(),
    setExpression: vi.fn(),
  },
  semanticAuthoring: { author: vi.fn(async () => ({})) },
  playbackAdapter: {
    getCurrentTime: vi.fn(() => 0),
    seek: vi.fn(),
    subscribeTime: vi.fn(() => () => {}),
  },
  sceneAssetService: {
    importAssetPath: vi.fn(async (sourcePath: string) => sourcePath),
  },
}));

const EXPECTED_BLEND_OPTION_LABELS = [
  '正常 (Normal)',
  '正片叠底 (Multiply)',
  '滤色 (Screen)',
  '变暗 (Darken)',
  '变亮 (Lighten)',
  '叠加 (Overlay)',
  '柔光 (Soft Light)',
  '强光 (Hard Light)',
];

vi.mock('../ui/context/AppContext', () => ({
  useApp: () => ({
    stores: { editor: { setCopyBuffer: vi.fn(), pixelsPerSecond: 50 } },
    services: { semanticAuthoring: state.semanticAuthoring },
  }),
  useCharacterAdapter: () => state.characterAdapter,
  useCollaborationPresence: () => ({ peers: [] }),
  useDocumentStore: () => ({
    getCurrentSceneDocumentSnapshot: () => state.document,
    getCompiledSceneSnapshot: () => state.compiledScene,
  }),
  usePlaybackAdapter: () => state.playbackAdapter,
  useSceneAssetService: () => state.sceneAssetService,
  useSemanticAuthoringService: () => state.semanticAuthoring,
}));

vi.mock('../ui/AssetBrowserModal', () => ({
  AssetBrowserModal: ({ onSelect, onClose }: { onSelect: (path: string) => void; onClose: () => void }) => (
    <div role="dialog" aria-label="资源浏览器">
      <button onClick={() => { onSelect(state.pickedAssetPath); onClose(); }}>使用选中资源</button>
    </div>
  ),
}));

vi.mock('../ui/store/storeHooks', () => ({
  useSemanticDocument: () => ({ document: state.document, filePath: null }),
  useValidationIssues: () => ({ issues: state.validationIssues, loading: false }),
  useCustomMotionEditorActionId: () => null,
}));

function renderInspector(document: any, compiledAction: any): {
  updateAction: ReturnType<typeof vi.fn>;
  updateParam: ReturnType<typeof vi.fn>;
  replaceSourceParams: ReturnType<typeof vi.fn>;
  setSelectedIds: ReturnType<typeof vi.fn>;
} {
  state.document = document;
  state.compiledScene = {
    sceneId: document.sceneId,
    meta: document.meta,
    actions: [compiledAction],
  };
  const updateAction = vi.fn();
  const updateParam = vi.fn();
  const replaceSourceParams = vi.fn();
  const setSelectedIds = vi.fn();

  render(
    <ActionInspector
      sceneData={{ sceneId: document.sceneId, meta: document.meta, timeline: [] }}
      selectedActionIds={{ [compiledAction.id]: true }}
      setSelectedIds={setSelectedIds}
      updateAction={updateAction}
      updateParam={updateParam}
      replaceSourceParams={replaceSourceParams}
      deleteAction={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  return { updateAction, updateParam, replaceSourceParams, setSelectedIds };
}

function baseDocument(statement: any, characters: any[] = []): any {
  return {
    schemaVersion: 4,
    sceneId: 'task2_inspector',
    meta: { title: 'Task 2 Inspector', characters },
    statements: [statement],
  };
}

describe('Task 2 ActionInspector contracts', () => {
  beforeEach(() => {
    state.document = null;
    state.compiledScene = null;
    state.validationIssues = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('writes subtitle style into image dialogue source params when the optional style is absent', () => {
    const presentation = {
      renderer: 'image-dialogue-v1', styleId: 'pink-nameplate',
      textbox: { image: 'textbox.svg', x: 100, y: 700, width: 1700, minHeight: 240 },
      text: { x: 150, y: 750, maxWidth: 1600 },
    };
    const statement = { id: 'dialogue_style', time: 0, type: 'dialogue', params: { text: 'hello', durationSeconds: 1, presentation } };
    const { replaceSourceParams } = renderInspector(baseDocument(statement), {
      id: 'dialogue_style::primary', time: 0, action: 'dialogue',
      params: { text: 'hello', duration: 1, presentation },
      source: { statementId: statement.id, outputKey: 'primary' },
    });
    fireEvent.click(screen.getByRole('combobox', { name: '字幕样式' }));
    fireEvent.click(screen.getByRole('option', { name: '淡入' }));
    expect(replaceSourceParams).toHaveBeenCalledWith('dialogue_style::primary', { ...statement.params, style: 'fadeIn' });
  });

  it('edits semantic dialogue lipSync as a boolean', () => {
    const statement = {
      id: 'dialogue_1',
      time: 0,
      type: 'dialogue',
      params: { text: 'hello', durationSeconds: 1 },
    };
    const { updateParam } = renderInspector(baseDocument(statement), {
      id: 'dialogue_1::primary',
      time: 0,
      action: 'dialogue',
      params: { text: 'hello', duration: 1 },
      source: { statementId: 'dialogue_1', outputKey: 'primary' },
    });

    const checkbox = screen.getByLabelText('口型同步');
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    fireEvent.click(checkbox);
    expect(updateParam).toHaveBeenCalledWith('dialogue_1::primary', 'lipSync', false);
  });

  it('keeps narrator dialogue unbound while allowing text edits and optional speaker binding', () => {
    const statement = {
      id: 'narrator_dialogue',
      time: 0,
      type: 'dialogue',
      params: { text: '旁白', durationSeconds: 1 },
    };
    const actionId = 'narrator_dialogue::primary';
    const { updateParam, replaceSourceParams } = renderInspector(baseDocument(statement, [
      { id: 'hero', name: '主角' },
    ]), {
      id: actionId,
      time: 0,
      action: 'dialogue',
      params: { text: '旁白', duration: 1 },
      semanticType: 'dialogue',
      sourceParams: statement.params,
      source: { statementId: statement.id, outputKey: 'primary' },
    });

    expect(screen.getByRole('combobox', { name: '绑定角色' }).textContent).toContain('旁白');
    const text = screen.getByLabelText('文本内容');
    fireEvent.mouseDown(text);
    fireEvent.focus(text);
    fireEvent.change(text, { target: { value: '新的旁白' } });
    fireEvent.blur(text);
    expect(updateParam).toHaveBeenLastCalledWith(actionId, 'text', '新的旁白');

    fireEvent.click(screen.getByRole('combobox', { name: '绑定角色' }));
    fireEvent.click(screen.getByRole('option', { name: '主角 (ID: hero)' }));
    expect(replaceSourceParams).toHaveBeenLastCalledWith(actionId, expect.objectContaining({
      speakerId: 'hero',
      speaker: '主角',
    }));

    fireEvent.click(screen.getByRole('combobox', { name: '绑定角色' }));
    fireEvent.click(screen.getByRole('option', { name: '旁白' }));
    expect(replaceSourceParams).toHaveBeenLastCalledWith(actionId, {
      text: '旁白',
      durationSeconds: 1,
    });
  });

  it('keeps the semantic blink inspector affordance in seconds', () => {
    const statement = {
      id: 'blink_1',
      time: 0,
      type: 'characterPerformance',
      params: { target: 'tomori', blink: { enabled: true, interval: 2.5 } },
    };
    renderInspector(baseDocument(statement, [{
      id: 'tomori',
      name: 'Tomori',
      model: 'figure/tomori/model.json',
    }]), {
      id: 'blink_1::blink',
      time: 0,
      action: 'characterBlink',
      params: { id: 'tomori', enabled: true, interval: 2.5 },
      source: { statementId: 'blink_1', outputKey: 'blink' },
    });

    const interval = screen.getByRole('spinbutton', { name: '秒' });
    expect(interval.getAttribute('aria-valuenow')).toBe('2.5');
    expect(screen.getByText('眨眼间隔')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '移除眨眼' })).toBeNull();
  });

  it('exposes intervalRange in the semantic blink inspector', () => {
    const statement = {
      id: 'blink_range_1',
      time: 0,
      type: 'characterPerformance',
      params: { target: 'tomori', blink: { enabled: true, interval: 5, intervalRange: 0.5 } },
    };
    renderInspector(baseDocument(statement, [{
      id: 'tomori',
      name: 'Tomori',
      model: 'figure/tomori/model.json',
    }]), {
      id: 'blink_range_1::blink',
      time: 0,
      action: 'characterBlink',
      params: { id: 'tomori', enabled: true, interval: 5, intervalRange: 0.5 },
      source: { statementId: 'blink_range_1', outputKey: 'blink' },
    });

    const range = screen.getByRole('spinbutton', { name: '眨眼随机范围' });
    expect(range.getAttribute('aria-valuenow')).toBe('0.5');
    expect(screen.getByText('随机范围')).toBeTruthy();
  });

  it('updates intervalRange via replaceSourceParams when user adjusts random range in inspector', () => {
    const statement = {
      id: 'blink_range_2',
      time: 0,
      type: 'characterPerformance',
      params: { target: 'tomori', blink: { enabled: true, interval: 5, intervalRange: 0 } },
    };
    const { replaceSourceParams } = renderInspector(baseDocument(statement, [{
      id: 'tomori',
      name: 'Tomori',
      model: 'figure/tomori/model.json',
    }]), {
      id: 'blink_range_2::blink',
      time: 0,
      action: 'characterBlink',
      params: { id: 'tomori', enabled: true, interval: 5, intervalRange: 0 },
      source: { statementId: 'blink_range_2', outputKey: 'blink' },
    });

    const range = screen.getByRole('spinbutton', { name: '眨眼随机范围' });
    fireEvent.keyDown(range, { key: 'ArrowUp' });

    expect(replaceSourceParams).toHaveBeenCalledWith(
      'blink_range_2::blink',
      expect.objectContaining({
        blink: expect.objectContaining({
          enabled: true,
          interval: 5,
          intervalRange: 0.1,
        }),
      }),
    );
  });

  it('shows a model picker and writes a missing semantic model through source replacement', async () => {
    const statement = {
      id: 'enter_missing_model',
      time: 0,
      type: 'characterPresence',
      params: { mode: 'enter', id: 'new_character' },
    };
    const { replaceSourceParams } = renderInspector(baseDocument(statement, [{
      id: 'new_character',
      name: 'New character',
    }]), {
      id: 'enter_missing_model::primary',
      time: 0,
      action: 'addCharacter',
      params: { id: 'new_character' },
      source: { statementId: 'enter_missing_model', outputKey: 'primary' },
    });

    state.pickedAssetPath = 'figure/new/model.json';
    fireEvent.click(screen.getByRole('button', { name: '模型文件' }));
    fireEvent.click(screen.getByRole('button', { name: '使用选中资源' }));

    await waitFor(() => expect(replaceSourceParams).toHaveBeenCalledWith(
      'enter_missing_model::primary',
      expect.objectContaining({ model: 'figure/new/model.json' }),
    ));
  });

  it('uses the character model catalog as the entrance model dropdown', async () => {
    const statement = {
      id: 'enter_model_variant',
      time: 0,
      type: 'characterPresence',
      params: { mode: 'enter', id: 'hero' },
    };
    const { replaceSourceParams } = renderInspector(baseDocument(statement, [{
      id: 'hero',
      name: 'Hero',
      model: 'figure/hero/default.model.json',
      variants: [
        { name: '冬装', model: 'figure/hero/winter.model.json' },
        { name: '夏装', model: 'figure/hero/summer.model.json' },
      ],
    }]), {
      id: 'enter_model_variant::primary',
      time: 0,
      action: 'addCharacter',
      params: { id: 'hero' },
      source: { statementId: statement.id, outputKey: 'primary' },
    });

    const modelSelect = screen.getByRole('combobox', { name: '模型文件' });
    expect(modelSelect.textContent).toContain('主模型');
    expect(screen.queryByPlaceholderText('选择 Live2D 模型文件')).toBeNull();

    await act(async () => {
      fireEvent.click(modelSelect);
    });
    expect(screen.getByRole('option', { name: '冬装' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '夏装' })).toBeTruthy();
    // Only registered models are selectable; the ad-hoc current path is not a catalog entry.
    expect(screen.queryByRole('option', { name: '当前模型文件' })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: '夏装' }));
    });

    expect(replaceSourceParams).toHaveBeenCalledWith(
      'enter_model_variant::primary',
      expect.objectContaining({ model: 'figure/hero/summer.model.json' }),
    );
  });

  it('shows a picker for a missing environment file and preserves the semantic source seam', async () => {
    const statement = {
      id: 'environment_missing_file',
      time: 0,
      type: 'environmentLayer',
      params: { mode: 'set', layerId: 'background' },
    };
    const { replaceSourceParams } = renderInspector(baseDocument(statement), {
      id: 'environment_missing_file::primary',
      time: 0,
      action: 'setEnvironmentLayer',
      params: { layerId: 'background' },
      source: { statementId: 'environment_missing_file', outputKey: 'primary' },
    });

    state.pickedAssetPath = 'images/classroom.png';
    fireEvent.click(screen.getByRole('button', { name: '背景图片' }));
    fireEvent.click(screen.getByRole('button', { name: '使用选中资源' }));

    await waitFor(() => expect(replaceSourceParams).toHaveBeenCalledWith(
      'environment_missing_file::primary',
      expect.objectContaining({ image: 'images/classroom.png' }),
    ));
  });

  it('keeps authored camera keyframes and exposes a schema-safe second endpoint', () => {
    const statement = {
      id: 'camera_path',
      time: 0,
      type: 'camera',
      params: {
        mode: 'path',
        keyframes: [{ time: 0, position: [0.1, 0.2], label: 'authored' }],
      },
    };
    const { updateParam } = renderInspector(baseDocument(statement), {
      id: 'camera_path::primary',
      time: 0,
      action: 'cameraPath',
      params: { keyframes: statement.params.keyframes },
      source: { statementId: 'camera_path', outputKey: 'primary' },
    });

    expect(screen.getByText('路径关键帧（至少 2 个）')).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: '关键帧 2 X' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: '关键帧 1 变焦' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: '关键帧 1 旋转' })).toBeTruthy();
    expect(screen.getByLabelText('关键帧 1 缓动')).toBeTruthy();
    expect(screen.getByLabelText('关键帧 1 标签')).toBeTruthy();
    expect(screen.getByRole('button', { name: '添加路径关键帧' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('spinbutton', { name: '关键帧 1 X' }), { key: 'ArrowUp' });

    const call = updateParam.mock.calls.at(-1);
    expect(call?.[0]).toBe('camera_path::primary');
    expect(call?.[1]).toBe('keyframes');
    expect(call?.[2]).toHaveLength(2);
    expect(call?.[2][0]).toMatchObject({ position: [0.11, 0.2], label: 'authored' });
    expect(call?.[2][1]).toMatchObject({ position: [0.1, 0.2] });
  });

  it('renders semantic camera move endpoints and transform controls without a mode or camera-Z field', () => {
    const statement = {
      id: 'camera_move',
      time: 0,
      type: 'camera',
      params: {
        mode: 'move',
        to: [0.7, 0.8],
        zoom: { kind: 'absolute', value: 1.1 },
        rotation: 4,
        durationSeconds: 1,
        ease: 'smooth',
      },
    };
    const actionId = 'camera_move::primary';
    const { updateParam } = renderInspector(baseDocument(statement), {
      id: actionId,
      time: 0,
      action: 'cameraMotion',
      params: { target: [0.7, 0.8], duration: 1 },
      source: { statementId: statement.id, outputKey: 'primary' },
    });

    expect(screen.queryByRole('combobox', { name: '镜头模式' })).toBeNull();
    expect(screen.queryByText('移动起点')).toBeNull();
    expect(screen.getByText('移动终点')).toBeTruthy();
    expect(screen.getByText('终点变换')).toBeTruthy();

    expect(screen.queryByRole('spinbutton', { name: '起点坐标（标准化） X' })).toBeNull();
    const targetY = screen.getByRole('spinbutton', { name: '终点坐标（标准化） Y' });
    expect(targetY.getAttribute('aria-valuemin')).toBe('0');
    expect(targetY.getAttribute('aria-valuemax')).toBe('1');
    expect(screen.queryByRole('spinbutton', { name: /终点坐标.*Z/ })).toBeNull();
    expect(screen.getByRole('spinbutton', { name: '终点变焦' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: '终点旋转' })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('spinbutton', { name: '终点坐标（标准化） X' }), { key: 'ArrowUp' });
    expect(updateParam).toHaveBeenLastCalledWith(actionId, 'to', [0.71, 0.8], false);
  });

  it('exposes zoom for legacy camera motion and preserves relative zoom values', () => {
    const statement = {
      id: 'legacy_camera_motion',
      time: 0,
      type: 'characterPerformance',
      params: { target: 'hero' },
    };
    const actionId = 'legacy_camera_motion::primary';
    const { updateParam } = renderInspector(baseDocument(statement), {
      id: actionId,
      time: 0,
      action: 'cameraMotion',
      params: { move: 'push', easing: 'smooth', zoom: '+=0.25', duration: 1 },
      source: { statementId: statement.id, outputKey: 'primary' },
    });

    const zoom = screen.getByRole('spinbutton', { name: '镜头缩放' });
    expect(zoom.getAttribute('aria-valuenow')).toBe('0.25');
    expect(screen.getByRole('combobox', { name: '镜头缩放类型' })).toBeTruthy();

    fireEvent.keyDown(zoom, { key: 'ArrowUp' });
    expect(updateParam).toHaveBeenLastCalledWith(actionId, 'zoom', '+=0.3', false);
  });

  it('renders semantic camera stop-follow without start-only follow controls', () => {
    const statement = {
      id: 'camera_stop_follow',
      time: 0,
      type: 'camera',
      params: { mode: 'follow', operation: 'stop' },
    };
    renderInspector(baseDocument(statement, [{ id: 'hero', name: 'Hero' }]), {
      id: 'camera_stop_follow::stop',
      time: 0,
      action: 'cameraReset',
      params: { duration: 0 },
      source: { statementId: statement.id, outputKey: 'stop' },
    });

    expect(screen.getByText('停止跟随')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: '镜头模式' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: '跟随操作' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: '目标角色' })).toBeNull();
    expect(screen.queryByText('跟随偏移（标准化）')).toBeNull();
    expect(screen.queryByRole('spinbutton', { name: '跟随平滑度' })).toBeNull();
  });

  it('keeps camera companion focus target and zoom controls available', () => {
    const statement = {
      id: 'dialogue_with_camera',
      time: 0,
      type: 'dialogue',
      params: { text: 'hello', durationSeconds: 1 },
      companions: [{
        id: 'camera_focus',
        anchor: 'start',
        offset: 0,
        type: 'camera',
        params: {
          mode: 'focus',
          target: '$speaker',
          zoom: { kind: 'delta', value: 0.15 },
          durationSeconds: 0.6,
        },
      }],
    };
    renderInspector(baseDocument(statement, [{ id: 'hero', name: 'Hero' }]), {
      id: 'dialogue_with_camera::primary',
      time: 0,
      action: 'dialogue',
      params: { text: 'hello', duration: 1 },
      source: { statementId: statement.id, outputKey: 'primary' },
    });

    expect(screen.getByLabelText('目标')).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: '变焦增量' })).toBeTruthy();
  });

  it('localizes dialogue companion choices and derives speaker name and color from the character', () => {
    const statement = {
      id: 'dialogue_with_character_companion',
      time: 0,
      type: 'dialogue',
      params: {
        speakerId: 'hero',
        speaker: '旧显示名',
        speakerColor: '#111111',
        text: 'hello',
        durationSeconds: 1,
      },
      companions: [{
        id: 'motion',
        anchor: 'start',
        offset: 0,
        type: 'characterPerformance',
        params: { target: '$speaker', expression: 'smile' },
      }],
    };
    const actionId = 'dialogue_with_character_companion::primary';
    const { replaceSourceParams } = renderInspector(baseDocument(statement, [
      { id: 'hero', name: '主角', color: '#12ab34' },
      { id: 'side', name: '配角', color: '#fedcba' },
    ]), {
      id: actionId,
      time: 0,
      action: 'dialogue',
      params: { speakerId: 'hero', speaker: '旧显示名', text: 'hello', duration: 1 },
      semanticType: 'dialogue',
      sourceParams: statement.params,
      source: { statementId: statement.id, outputKey: 'primary' },
    });

    expect(screen.getByRole('combobox', { name: '绑定角色' }).textContent).toContain('主角');
    expect(screen.getByText('主角（当前说话人）')).toBeTruthy();
    expect(screen.queryByText('显示名称')).toBeNull();
    expect(screen.queryByText('说话人颜色')).toBeNull();
    expect(screen.queryByTestId('dialogue-speaker-color')).toBeNull();
    expect(screen.getByRole('combobox', { name: '伴随语句类型' }).textContent).toContain('角色表演');
    expect(screen.queryByText('Character Performance')).toBeNull();

    fireEvent.click(screen.getByRole('combobox', { name: '绑定角色' }));
    fireEvent.click(screen.getByRole('option', { name: /配角/ }));

    expect(replaceSourceParams).toHaveBeenLastCalledWith(actionId, expect.objectContaining({
      speakerId: 'side',
      speaker: '配角',
      speakerColor: '#fedcba',
    }));
  });

  it('renders filter templates and category-specific overrides without legacy lens controls', () => {
    const statement = {
      id: 'lens_atmosphere',
      time: 0,
      type: 'filterAdd',
      params: {
        recipeId: 'builtin:haze-godray',
        intensity: 0.6,
        warmth: 0.1,
        bloom: 0.2,
        blend: 0.3,
        contamination: 0.2,
        durationSeconds: 0.6,
      },
    };

    renderInspector(baseDocument(statement), {
      id: 'lens_atmosphere::primary',
      time: 0,
      action: 'addLensFilter',
      params: {
        category: 'atmosphere',
        recipeId: 'builtin:haze-godray',
        intensity: 0.6,
        warmth: 0.1,
        bloom: 0.2,
        blend: 0.3,
        contamination: 0.2,
        duration: 0.6,
      },
      source: { statementId: statement.id, outputKey: 'primary' },
    });

    expect(screen.getByRole('combobox', { name: '滤镜模板' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: '后期强度' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: '冷暖' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: 'Bloom' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: '空气感' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: '介质感' })).toBeTruthy();
    expect(screen.queryByRole('spinbutton', { name: '色差' })).toBeNull();
    expect(screen.queryByText('效果槽位')).toBeNull();
    expect(screen.queryByText('状态模式')).toBeNull();
    expect(screen.queryByText('风格微调')).toBeNull();
    expect(screen.getByText('过渡时长')).toBeTruthy();
  });

  it('shows fixed visual semantics and structured integration fields without free slot or mode selectors', () => {
    const statement = {
      id: 'visual_semantic_fields',
      time: 0,
      type: 'visualStyle',
      params: {
        scope: 'object',
        target: 'hero',
        slot: 'integration',
        mode: 'set',
        recipeId: 'builtin:integration-soft',
        intensity: 0.8,
        warmth: 0.1,
        blend: 0.35,
        contamination: 0.2,
        color: '#223344',
        colorStops: ['#223344', '#334455', '#445566', '#556677'],
        colorBlendMode: 'soft-light',
        semanticOverride: {
          intensity: 0.2,
          color: '#112233',
          colorStops: ['#112233', '#223344'],
          colorBlendMode: 'overlay',
        },
      },
    };
    const actionId = 'visual_semantic_fields::primary';
    const { replaceSourceParams } = renderInspector(baseDocument(statement, [{
      id: 'hero',
      name: 'Hero',
      model: 'figure/hero/model.json',
    }]), {
      id: actionId,
      time: 0,
      action: 'setCompositeRecipe',
      params: {
        targetId: 'hero',
        slot: 'integration',
        recipeId: 'builtin:integration-soft',
      },
      source: { statementId: statement.id, outputKey: 'primary' },
    });

    expect(screen.getAllByText('角色色彩融入').length).toBeGreaterThan(0);
    expect(screen.queryByRole('combobox', { name: '效果槽位' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: '状态模式' })).toBeNull();
    expect(screen.getByRole('spinbutton', { name: '染色强度' }).getAttribute('aria-valuenow')).toBe('0.2');
    expect(screen.getByRole('spinbutton', { name: '冷暖' }).getAttribute('aria-valuenow')).toBe('0');
    expect(screen.queryByRole('spinbutton', { name: '融入度' })).toBeNull();
    expect(screen.queryByRole('spinbutton', { name: '环境染色' })).toBeNull();
    expect(screen.queryByLabelText('左上颜色')).toBeNull();
    expect(screen.queryByText('风格微调')).toBeNull();
    expect(screen.queryByRole('combobox', { name: '配色' })).toBeNull();
    expect(screen.queryByText(/params|JSON/)).toBeNull();
    expect(replaceSourceParams).not.toHaveBeenCalled();
  });

  it('offers and writes the shared blend modes for object integration', () => {
    const statement = {
      id: 'visual-blend-mode',
      time: 0,
      type: 'visualStyle',
      params: {
        scope: 'object',
        target: 'hero',
        slot: 'integration',
        mode: 'set',
        recipeId: 'builtin:integration-soft',
        colorBlendMode: 'soft-light',
      },
    };
    const actionId = 'visual-blend-mode::primary';
    const { replaceSourceParams } = renderInspector(baseDocument(statement, [{
      id: 'hero',
      name: 'Hero',
      model: 'figure/hero/model.json',
    }]), {
      id: actionId,
      time: 0,
      action: 'setCompositeRecipe',
      params: { targetId: 'hero', slot: 'integration', recipeId: 'builtin:integration-soft' },
      source: { statementId: statement.id, outputKey: 'primary' },
    });

    fireEvent.click(screen.getByRole('combobox', { name: '颜色混合' }));
    const listbox = within(screen.getByRole('listbox'));
    expect(listbox.getAllByRole('option').map((option) => option.textContent)).toEqual([
      '正常 (Normal)',
      '正片叠底 (Multiply)',
      '滤色 (Screen)',
      '变暗 (Darken)',
      '变亮 (Lighten)',
      '叠加 (Overlay)',
      '柔光 (Soft Light)',
      '强光 (Hard Light)',
    ]);
    fireEvent.click(listbox.getByRole('option', { name: '正常 (Normal)' }));
    expect(replaceSourceParams).toHaveBeenLastCalledWith(actionId, expect.objectContaining({ colorBlendMode: 'normal' }));
  });

  it('offers and writes the same blend modes for lighting overlay and post overlay', () => {
    const overlay = {
      id: 'lighting-blend-mode',
      time: 0,
      type: 'lighting',
      params: { effect: 'overlay', mode: 'set', id: 'overlay-1', blendMode: 'multiply' },
    };
    const overlayActionId = 'lighting-blend-mode::primary';
    const { replaceSourceParams: replaceOverlayParams } = renderInspector(baseDocument(overlay), {
      id: overlayActionId,
      time: 0,
      action: 'addColorOverlay',
      params: { id: 'overlay-1' },
      source: { statementId: overlay.id, outputKey: 'primary' },
    });
    fireEvent.click(screen.getByRole('combobox', { name: '混合模式' }));
    const overlayOptions = within(screen.getByRole('listbox'));
    expect(overlayOptions.getAllByRole('option').map((option) => option.textContent)).toEqual(EXPECTED_BLEND_OPTION_LABELS);
    fireEvent.click(overlayOptions.getByRole('option', { name: '强光 (Hard Light)' }));
    expect(replaceOverlayParams).toHaveBeenLastCalledWith(overlayActionId, expect.objectContaining({ blendMode: 'hard-light' }));
    cleanup();

    const post = {
      id: 'post-blend-mode',
      time: 0,
      type: 'lighting',
      params: { effect: 'post', mode: 'set', overlayBlendMode: 'multiply' },
    };
    const postActionId = 'post-blend-mode::primary';
    const { replaceSourceParams: replacePostParams } = renderInspector(baseDocument(post), {
      id: postActionId,
      time: 0,
      action: 'setPostProcessing',
      params: { duration: 0 },
      source: { statementId: post.id, outputKey: 'primary' },
    });
    fireEvent.click(screen.getByRole('combobox', { name: '后期叠加模式' }));
    const postOptions = within(screen.getByRole('listbox'));
    expect(postOptions.getAllByRole('option').map((option) => option.textContent)).toEqual(EXPECTED_BLEND_OPTION_LABELS);
    fireEvent.click(postOptions.getByRole('option', { name: '变暗 (Darken)' }));
    expect(replacePostParams).toHaveBeenLastCalledWith(postActionId, expect.objectContaining({ overlayBlendMode: 'darken' }));
  });

  it('shows visual reset as target plus numeric transition duration only', () => {
    const statement = {
      id: 'visual_reset',
      time: 0,
      type: 'visualStyle',
      params: {
        scope: 'object',
        target: 'hero',
        slot: 'grounding',
        mode: 'reset',
        durationSeconds: 0.4,
      },
    };
    const actionId = 'visual_reset::primary';
    renderInspector(baseDocument(statement, [{
      id: 'hero',
      name: 'Hero',
      model: 'figure/hero/model.json',
    }]), {
      id: actionId,
      time: 0,
      action: 'resetCompositeRecipe',
      params: { targetId: 'hero', slot: 'grounding', duration: 0.4 },
      source: { statementId: statement.id, outputKey: 'primary' },
    });

    expect(screen.getByText('重置角色明暗融入')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '目标对象' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: '过渡时长' })).toBeTruthy();
    expect(screen.queryByText('风格配方')).toBeNull();
    expect(screen.queryByRole('spinbutton', { name: '强度' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: '效果槽位' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: '状态模式' })).toBeNull();
  });

  it('does not inject brightness into non-integration composite actions', () => {
    const statement = {
      id: 'visual_grounding_legacy',
      time: 0,
      type: 'visualStyle',
      params: {
        scope: 'object',
        target: 'hero',
        slot: 'grounding',
        mode: 'set',
        recipeId: 'builtin:ground-shadow-soft',
      },
    };
    renderInspector(baseDocument(statement), {
      id: 'visual_grounding_legacy::primary',
      time: 0,
      action: 'setCompositeRecipe',
      params: {
        targetId: 'hero',
        slot: 'grounding',
        recipeId: 'builtin:ground-shadow-soft',
      },
      source: { statementId: statement.id, outputKey: 'primary' },
    });

    expect(screen.queryByRole('spinbutton', { name: '亮度' })).toBeNull();
  });

  it('restricts rim-light targets to characters and keeps its controls numeric', () => {
    const statement = {
      id: 'rim_light_target',
      time: 0,
      type: 'visualStyle',
      params: {
        scope: 'object',
        target: 'background',
        slot: 'rim-light',
        mode: 'set',
        recipeId: 'builtin:integration-soft',
        warmth: 0.4,
        bloom: 0.2,
        rgbSplit: 0.1,
        colorStops: ['#112233'],
        colorBlendMode: 'overlay',
        thickness: 8,
      },
    };
    const actionId = 'rim_light_target::rim-light';
    const { updateParam, replaceSourceParams } = renderInspector(baseDocument(statement, [{
      id: 'hero',
      name: 'Hero',
      model: 'figure/hero/model.json',
    }]), {
      id: actionId,
      time: 0,
      action: 'setCharacterRimLight',
      params: { id: 'background', mode: 'set', thickness: 8 },
      source: { statementId: statement.id, outputKey: 'rim-light' },
    });

    expect(screen.getByRole('spinbutton', { name: '强度' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: '厚度' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: '角度' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: '边缘柔和度' })).toBeTruthy();
    expect(screen.queryByText('风格配方')).toBeNull();
    expect(screen.queryByText('冷暖')).toBeNull();
    expect(screen.queryByText('柔光')).toBeNull();
    expect(screen.queryByText('色差')).toBeNull();

    fireEvent.click(screen.getByRole('combobox', { name: '目标对象' }));
    expect(screen.queryByRole('option', { name: '背景' })).toBeNull();
    expect(screen.getByRole('option', { name: /Hero/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /Hero/ }));
    expect(replaceSourceParams).toHaveBeenCalledWith(actionId, expect.objectContaining({ target: 'hero' }));
    expect(updateParam).not.toHaveBeenCalledWith(actionId, 'target', 'hero');
  });

  it('renders typed post lighting fields without effect or lifecycle selectors', () => {
    const statement = {
      id: 'lighting_post',
      time: 0,
      type: 'lighting',
      params: {
        effect: 'post',
        mode: 'set',
        bloomThreshold: 0.8,
        bloomBloomScale: 1.2,
        bloomBrightness: 1.1,
        rgbSplitX: 0.1,
        rgbSplitY: -0.1,
        godrayGain: 0.2,
        godrayLacunarity: 2.2,
        godrayAngle: 35,
        adjGamma: 1.1,
        adjContrast: 1.2,
        adjSaturation: 0.9,
        adjBrightness: 1.05,
        adjRed: 1,
        adjGreen: 0.95,
        adjBlue: 1.1,
        durationSeconds: 0.6,
      },
    };
    renderInspector(baseDocument(statement), {
      id: 'lighting_post::primary',
      time: 0,
      action: 'setPostProcessing',
      params: { duration: 0.6 },
      source: { statementId: statement.id, outputKey: 'primary' },
    });

    expect(screen.getByText('设置后期处理')).toBeTruthy();
    expect(screen.queryByTestId('semantic-lighting-source-form')).toBeNull();
    expect(screen.queryByRole('combobox', { name: '效果' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: '生命周期' })).toBeNull();
    for (const name of [
      'Bloom 阈值', 'Bloom 强度', 'Bloom 亮度', 'RGB 分离 X', 'RGB 分离 Y',
      '体积光强度', '体积光细节', '体积光角度', 'Gamma', '对比度', '饱和度',
      '亮度', '红色通道', '绿色通道', '蓝色通道', '过渡时长',
    ]) {
      expect(screen.getByRole('spinbutton', { name })).toBeTruthy();
    }
  });

  it('renders godrays, overlay, and point-light fields by their fixed effect operation', () => {
    const godrays = {
      id: 'lighting_godrays',
      time: 0,
      type: 'lighting',
      params: { effect: 'godrays', mode: 'set', intensity: 0.5, angle: 30, lacunarity: 2, durationSeconds: 0.5 },
    };
    renderInspector(baseDocument(godrays), {
      id: 'lighting_godrays::primary',
      time: 0,
      action: 'setGodrays',
      params: { duration: 0.5 },
      source: { statementId: godrays.id, outputKey: 'primary' },
    });
    expect(screen.getByText('设置体积光')).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: '强度' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: '角度' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: 'Lacunarity' })).toBeTruthy();
    cleanup();

    const overlay = {
      id: 'lighting_overlay',
      time: 0,
      type: 'lighting',
      params: { effect: 'overlay', mode: 'set', id: 'overlay-1', color: '#112233', blendMode: 'screen', intensity: 0.4, durationSeconds: 0.5 },
    };
    renderInspector(baseDocument(overlay), {
      id: 'lighting_overlay::primary',
      time: 0,
      action: 'addColorOverlay',
      params: { id: 'overlay-1', duration: 0.5 },
      source: { statementId: overlay.id, outputKey: 'primary' },
    });
    expect(screen.getByText('添加色彩叠加')).toBeTruthy();
    expect(screen.getByLabelText('对象 ID')).toBeTruthy();
    expect(screen.getByLabelText('颜色')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '混合模式' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: '强度' })).toBeTruthy();
    cleanup();

    const pointLight = {
      id: 'lighting_point',
      time: 0,
      type: 'lighting',
      params: { effect: 'pointLight', mode: 'set', id: 'point-1', x: 0.5, y: 0.4, color: '#ffffff', radius: 240, intensity: 0.8, durationSeconds: 0.5 },
    };
    renderInspector(baseDocument(pointLight), {
      id: 'lighting_point::primary',
      time: 0,
      action: 'addPointLight',
      params: { id: 'point-1', duration: 0.5 },
      source: { statementId: pointLight.id, outputKey: 'primary' },
    });
    expect(screen.getByText('添加点光源')).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: 'X' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: 'Y' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: '半径' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: '强度' })).toBeTruthy();
  });

  it('narrows lighting remove operations to target and duration', () => {
    const statement = {
      id: 'lighting_remove_overlay',
      time: 0,
      type: 'lighting',
      params: { effect: 'overlay', mode: 'remove', id: 'overlay-1', durationSeconds: 0.4 },
    };
    renderInspector(baseDocument(statement), {
      id: 'lighting_remove_overlay::primary',
      time: 0,
      action: 'removeColorOverlay',
      params: { id: 'overlay-1', duration: 0.4 },
      source: { statementId: statement.id, outputKey: 'primary' },
    });

    expect(screen.getByText('移除色彩叠加')).toBeTruthy();
    expect(screen.getByLabelText('对象 ID')).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: '过渡时长' })).toBeTruthy();
    expect(screen.queryByLabelText('颜色')).toBeNull();
    expect(screen.queryByRole('combobox', { name: '混合模式' })).toBeNull();
    expect(screen.queryByRole('spinbutton', { name: '强度' })).toBeNull();
  });

  it('keeps object-scoped visual statements separate from lens filter statements', () => {
    const statement = {
      id: 'visual_scope_switch',
      time: 0,
      type: 'visualStyle',
      params: {
        scope: 'object',
        target: 'hero',
        slot: 'integration',
        mode: 'set',
        recipeId: 'builtin:integration-soft',
        colorStops: ['#112233'],
      },
    };
    renderInspector(baseDocument(statement, [{
      id: 'hero',
      name: 'Hero',
      model: 'figure/hero/model.json',
    }]), {
      id: 'visual_scope_switch::primary',
      time: 0,
      action: 'setCompositeRecipe',
      params: { targetId: 'hero', slot: 'integration', recipeId: 'builtin:integration-soft' },
      source: { statementId: statement.id, outputKey: 'primary' },
    });

    expect(screen.queryByRole('combobox', { name: '作用范围' })).toBeNull();
    expect(screen.getByRole('combobox', { name: '角色' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: '效果槽位' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: '状态模式' })).toBeNull();
  });

  it('edits dialogue integration through the same effective controls as standalone effects', () => {
    const statement = {
      id: 'dialogue_with_visual',
      time: 0,
      type: 'dialogue',
      params: { text: 'hello', durationSeconds: 1 },
      companions: [{
        id: 'visual',
        anchor: 'start',
        offset: 0,
        type: 'visualStyle',
        params: {
          scope: 'object',
          target: '$speaker',
          slot: 'integration',
          mode: 'set',
          recipeId: 'builtin:integration-soft',
          intensity: 0.8,
          warmth: 0.1,
          blend: 0.35,
          contamination: 0.2,
          color: '#223344',
          colorStops: ['#223344', '#334455'],
          colorBlendMode: 'soft-light',
          semanticOverride: {
            intensity: 0.2,
            color: '#112233',
            colorStops: ['#112233', '#223344'],
            colorBlendMode: 'overlay',
          },
        },
      }],
    };
    renderInspector(baseDocument(statement), {
      id: 'dialogue_with_visual::primary',
      time: 0,
      action: 'dialogue',
      params: { text: 'hello', duration: 1 },
      source: { statementId: statement.id, outputKey: 'primary' },
    });

    expect(screen.queryByLabelText('伴随语句模式')).toBeNull();
    expect(screen.queryByLabelText('伴随语句效果槽位')).toBeNull();
    expect(screen.queryByLabelText('左上颜色')).toBeNull();
    expect(screen.getAllByRole('spinbutton', { name: '染色强度' })).toHaveLength(1);
    expect(screen.queryByText('风格微调')).toBeNull();

    fireEvent.keyDown(screen.getByRole('spinbutton', { name: '染色强度' }), { key: 'ArrowUp' });
    expect(state.semanticAuthoring.author).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'update-dialogue-companion',
      locator: { statementId: statement.id, companionId: 'visual' },
      patch: expect.objectContaining({ params: expect.objectContaining({
        semanticOverride: expect.objectContaining({ intensity: 0.25 }),
      }) }),
    }));
  });

  it('routes semantic SFX files through the SFX/generic resource picker path', async () => {
    const statement = {
      id: 'sfx_picker',
      time: 0,
      type: 'audio',
      params: {
        role: 'sfx',
        mode: 'play',
        instanceId: 'hit',
        file: 'sfx/hit.wav',
      },
    };
    const { updateParam } = renderInspector(baseDocument(statement), {
      id: 'sfx_picker::primary',
      time: 0,
      action: 'playAudio',
      params: { id: 'hit', file: 'sfx/hit.wav' },
      source: { statementId: 'sfx_picker', outputKey: 'primary' },
    });

    state.pickedAssetPath = 'sfx/chime.ogg';
    fireEvent.click(screen.getByRole('button', { name: '音频文件' }));
    fireEvent.click(screen.getByRole('button', { name: '使用选中资源' }));

    await waitFor(() => {
      expect(updateParam).toHaveBeenCalledWith('sfx_picker::primary', 'file', 'sfx/chime.ogg');
    });
  });

  it('uses a file picker for dialogue companion SFX paths', async () => {
    const statement = {
      id: 'dialogue_with_sfx',
      time: 0,
      type: 'dialogue',
      params: { text: 'hello', durationSeconds: 1 },
      companions: [{
        id: 'sfx',
        anchor: 'start',
        offset: 0,
        type: 'audio',
        params: { role: 'sfx', mode: 'play', instanceId: 'hit', file: 'sfx/hit.wav', volume: 1 },
      }],
    };
    renderInspector(baseDocument(statement), {
      id: 'dialogue_with_sfx::primary',
      time: 0,
      action: 'dialogue',
      params: { text: 'hello', duration: 1 },
      source: { statementId: 'dialogue_with_sfx', outputKey: 'primary' },
    });

    state.pickedAssetPath = 'sfx/hit-2.wav';
    fireEvent.click(screen.getByRole('button', { name: '音效文件' }));
    fireEvent.click(screen.getByRole('button', { name: '使用选中资源' }));

    await waitFor(() => {
      expect(state.semanticAuthoring.author).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'update-dialogue-companion',
        locator: { statementId: 'dialogue_with_sfx', companionId: 'sfx' },
        patch: expect.objectContaining({
          params: expect.objectContaining({ file: 'sfx/hit-2.wav' }),
        }),
      }));
    });
  });

  it('matches validation issues by semantic statement ID as well as compiled action ID', () => {
    const statement = {
      id: 'dialogue_validation',
      time: 0,
      type: 'dialogue',
      params: { text: 'hello', durationSeconds: 1 },
    };
    state.validationIssues = [{
      severity: 'error',
      message: 'missing resource',
      actionId: 'dialogue_validation',
    }];
    renderInspector(baseDocument(statement), {
      id: 'dialogue_validation::primary',
      time: 0,
      action: 'dialogue',
      params: { text: 'hello', duration: 1 },
      source: { statementId: 'dialogue_validation', outputKey: 'primary' },
    });

    expect(document.querySelector('.selected-action-header__issue--error')).toBeTruthy();
  });

  it('renders a resource playMotion without crashing on the discriminated motion object', () => {
    const statement = {
      id: 'motion_resource',
      time: 0,
      type: 'characterPerformance',
      params: { target: 'hero', motion: { kind: 'resource', key: 'wave.mtn', fadeInSeconds: 0.3 } },
    };
    const actionId = 'motion_resource::primary';
    expect(() => renderInspector(baseDocument(statement, [{ id: 'hero', name: 'Hero' }]), {
      id: actionId,
      time: 0,
      action: 'playMotion',
      params: { id: 'hero' },
      sourceParams: statement.params,
      semanticType: 'characterPerformance',
      source: { statementId: statement.id, outputKey: 'primary' },
    })).not.toThrow();
    const motionField = document.querySelector('[data-testid="action-param-motion"]');
    expect(motionField).toBeTruthy();
    expect(motionField?.textContent).toContain('wave.mtn');
  });

  it('renders a custom playMotion without crashing and exposes the editor host', () => {
    const statement = {
      id: 'motion_custom',
      time: 0,
      type: 'characterPerformance',
      params: {
        target: 'hero',
        motion: {
          kind: 'custom',
          durationSeconds: 1,
          fadeInSeconds: 0.3,
          derivedFrom: { key: 'wave.mtn' },
          tracks: [{
            parameterId: 'PARAM_ANGLE_X',
            keyframes: [
              { time: 0, value: 0, segment: { type: 'linear' } },
              { time: 1, value: 10 },
            ],
          }],
        },
      },
    };
    const actionId = 'motion_custom::primary';
    expect(() => renderInspector(baseDocument(statement, [{ id: 'hero', name: 'Hero' }]), {
      id: actionId,
      time: 0,
      action: 'playMotion',
      params: { id: 'hero' },
      sourceParams: statement.params,
      semanticType: 'characterPerformance',
      source: { statementId: statement.id, outputKey: 'primary' },
    })).not.toThrow();
    expect(screen.getByText('编辑关键帧')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '重新转换…' }));
    const regenerationDialog = screen.getByRole('dialog', { name: '从源动作重新生成' });
    expect(regenerationDialog).toBeTruthy();
    expect(screen.getByText('当前全部关键帧和手工调整都会被替换。')).toBeTruthy();
    expect(regenerationDialog.textContent).toContain('wave.mtn');
  });

  it('renders both motion and expression fields on characterPerformance, allows clearing them from params, and does not render fadeInSeconds', () => {
    const statement = {
      id: 'performance_full',
      time: 0,
      type: 'characterPerformance',
      params: {
        target: 'hero',
        motion: { kind: 'resource', key: 'nod.mtn' },
        expression: 'smile',
      },
    };
    const actionId = 'performance_full::motion';
    const { replaceSourceParams } = renderInspector(baseDocument(statement, [{ id: 'hero', name: 'Hero' }]), {
      id: actionId,
      time: 0,
      action: 'playMotion',
      params: { id: 'hero' },
      sourceParams: statement.params,
      semanticType: 'characterPerformance',
      source: { statementId: statement.id, outputKey: 'motion' },
    });

    // 动作名与表情名都应展示在独立的资源选择区域
    const motionField = document.querySelector('[data-testid="action-param-motion"]');
    expect(motionField).toBeTruthy();
    expect(motionField?.textContent).toContain('nod.mtn');

    const expressionField = document.querySelector('[data-testid="action-param-expression"]');
    expect(expressionField).toBeTruthy();
    expect(expressionField?.textContent).toContain('smile');

    // 动作淡入无需展示
    expect(screen.queryByLabelText('动作淡入秒数')).toBeNull();

    // 可以通过清除按钮不选择动作（从 params 中移除）
    const clearMotionBtn = screen.getByRole('button', { name: '清除动作名' });
    expect(clearMotionBtn).toBeTruthy();
    fireEvent.click(clearMotionBtn);
    expect(replaceSourceParams).toHaveBeenCalledWith(actionId, {
      target: 'hero',
      expression: 'smile',
    });

    // 可以通过清除按钮不选择表情（从 params 中移除）
    const clearExpressionBtn = screen.getByRole('button', { name: '清除表情名' });
    expect(clearExpressionBtn).toBeTruthy();
    fireEvent.click(clearExpressionBtn);
    expect(replaceSourceParams).toHaveBeenCalledWith(actionId, {
      target: 'hero',
      motion: { kind: 'resource', key: 'nod.mtn' },
    });
  });

  it('exposes lookAt and blink panels on characterPerformance and allows adding lookAt only', () => {
    const statement = {
      id: 'performance_controls',
      time: 0,
      type: 'characterPerformance',
      params: {
        target: 'hero',
        motion: { kind: 'resource', key: 'idle.mtn' },
        blink: { enabled: true, interval: 4 },
      },
    };
    const actionId = 'performance_controls::motion';
    const { replaceSourceParams } = renderInspector(baseDocument(statement, [{ id: 'hero', name: 'Hero' }]), {
      id: actionId,
      time: 0,
      action: 'playMotion',
      params: { id: 'hero' },
      sourceParams: statement.params,
      semanticType: 'characterPerformance',
      source: { statementId: statement.id, outputKey: 'motion' },
    });

    // 已有 blink 应展示眨眼控制面板，且有移除按钮
    expect(screen.getByText('眨眼控制')).toBeTruthy();
    expect(screen.getByRole('button', { name: '移除眨眼' })).toBeTruthy();

    // 不再提供添加眨眼控制按钮，未配置 lookAt 时仅提供添加视线控制
    expect(screen.queryByRole('button', { name: '+ 添加眨眼控制' })).toBeNull();
    const addLookAtBtn = screen.getByRole('button', { name: '+ 添加视线控制' });
    expect(addLookAtBtn).toBeTruthy();

    fireEvent.click(addLookAtBtn);
    expect(replaceSourceParams).toHaveBeenCalledWith(
      actionId,
      expect.objectContaining({ lookAt: { point: [0, 0], intensity: 1, enabled: true } }),
    );
  });
});
