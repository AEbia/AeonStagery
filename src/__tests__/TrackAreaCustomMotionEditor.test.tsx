/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '../ui/context/AppContext';
import { CustomMotionEditor, isTrackAnimated, type CustomMotionEditorProps } from '../ui/timeline/CustomMotionEditor';
import { TrackArea } from '../ui/timeline/TrackArea';
import type { CustomMotionEditLeaseGate } from '../services/timeline-authoring/CustomMotionEditLeaseGate';
import type { LooseTimelineAction as SceneAction } from './fixtures/TimelineTestTypes';
import type { TimelineAction } from '../ui/timeline/semanticTimelineTypes';

const CUSTOM_MOTION = {
  kind: 'custom',
  derivedFrom: { key: 'motions/idle.motion3.json' },
  durationSeconds: 1,
  fadeInSeconds: 0.2,
  tracks: [
    {
      parameterId: 'ParamAngleX',
      keyframes: [
        { time: 0, value: 0 },
        { time: 0.5, value: 5 },
      ],
    },
  ],
} as const;

function createCustomMotionAction(id: string, time: number, motion: unknown = CUSTOM_MOTION): { id: string; action: SceneAction } {
  return {
    id,
    action: {
      _id: id,
      action: 'playMotion',
      semanticType: 'characterPerformance',
      time,
      params: { duration: 1, motion },
    } as unknown as SceneAction,
  };
}

function renderTrackAreaWithCustomMotion(options: {
  expandedActionId: string | null;
  actions?: Array<{ id: string; action: TimelineAction }>;
  selectedIds?: Record<string, boolean>;
  collaboration?: { status: 'disconnected'; customMotionEditLeaseGate?: CustomMotionEditLeaseGate };
  document?: unknown;
  viewWindow?: { start: number; end: number };
} = { expandedActionId: null }) {
  const actions = options.actions ?? [createCustomMotionAction('cm1', 2)];
  void actions;
  const setCustomMotionEditorActionId = vi.fn();
  const onDrag = vi.fn();
  const onBatchDrag = vi.fn();

  const adapters = {
    document: { pushUndo: vi.fn(), pasteActions: vi.fn().mockReturnValue([]), setTimeline: vi.fn() } as any,
    playback: {
      getCurrentTime: vi.fn().mockReturnValue(0),
      subscribeTime: vi.fn(() => () => {}),
      seek: vi.fn(),
      play: vi.fn(),
      pause: vi.fn(),
      getDuration: vi.fn().mockReturnValue(0),
      setLoop: vi.fn(),
      setLoopEnabled: vi.fn(),
      setSpeed: vi.fn(),
    } as any,
    camera: {} as any,
    character: {} as any,
    stage: {} as any,
    timeline: { select: vi.fn() } as any,
    export: {} as any,
  };

  const stores = {
    document: {
      sceneData: { meta: { markers: [] }, timeline: actions.map((item) => item.action) },
      getCompiledSceneSnapshot: () => ({
        sourceSchemaVersion: 2,
        sceneId: 'scene_1',
        meta: { title: 'CME Band Test' },
        durationSeconds: 20,
        actions: actions.map(({ id, action }) => ({
          id,
          time: action.time,
          action: action.action,
          params: action.params,
          source: { statementId: `statement-${id}` },
        })),
      }),
      getCurrentSceneDocumentSnapshot: () => options.document ?? null,
      subscribe: () => () => {},
    } as any,
    playback: {
      playing: false,
      duration: 0,
      engineStatus: '',
      subscribe: () => () => {},
      setDuration: vi.fn(),
      setPlaying: vi.fn(),
      setEngineStatus: vi.fn(),
    } as any,
    editor: {
      copyBuffer: [],
      customMotionEditorActionId: options.expandedActionId,
      setCustomMotionEditorActionId,
      subscribe: () => () => {},
    } as any,
    validation: {
      issues: [],
      loading: false,
      errorsCount: 0,
      warningsCount: 0,
      subscribe: () => () => {},
      getSeverityByActionId: () => null,
      getIssueMessageByActionId: () => null,
    } as any,
  };

  const view = render(
    <AppProvider adapters={adapters} stores={stores} collaboration={options.collaboration}>
      <TrackArea
        tracks={[{ id: 'char:hina', label: 'Hina', actions }]}
        pps={10}
        maxTime={20}
        selectedIds={options.selectedIds ?? {}}
        onSelect={vi.fn()}
        onDrag={onDrag}
        onResize={vi.fn()}
        onSeek={vi.fn()}
        sceneData={{ sceneId: 'cme-band-test', meta: { title: 'CME Band Test', markers: [] }, timeline: actions.map((item) => item.action) }}
        scrollLeft={0}
        containerWidth={1000}
        onBatchDrag={onBatchDrag}
        viewWindow={options.viewWindow ?? { start: 0, end: 20 }}
        onNavigateRange={vi.fn()}
      />
    </AppProvider>,
  );

  return { ...view, setCustomMotionEditorActionId, onDrag, onBatchDrag };
}

describe('TrackArea 自定义动作关键帧展开带', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    if (!HTMLElement.prototype.setPointerCapture) {
      Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { value: vi.fn(), configurable: true });
      Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { value: vi.fn(), configurable: true });
    }
  });

  it('未展开时不渲染关键帧编辑器', () => {
    renderTrackAreaWithCustomMotion({ expandedActionId: null });
    expect(screen.queryByTestId('custom-motion-editor')).toBeNull();
  });

  it('展开时在目标轨道下方渲染内嵌关键帧编辑器（timeline 布局）', () => {
    renderTrackAreaWithCustomMotion({ expandedActionId: 'cm1' });
    const editor = screen.getByTestId('custom-motion-editor');
    expect(editor.getAttribute('data-layout')).toBe('timeline');
    // 参数名出现在吸左标签列中
    const laneLabel = editor.querySelector('.cme__lane-label .cme__param-name');
    expect(laneLabel?.textContent).toBe('头部左右');
    expect(editor.textContent).not.toContain('ParamAngleX');
    // 展开带位于轨道行之后
    const row = screen.getByTestId('timeline-track-row');
    expect(row.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('时间轴关键帧画布保持场景坐标宽度，避免视口拉宽 SVG 后标记偏离总标尺', () => {
    renderTrackAreaWithCustomMotion({ expandedActionId: 'cm1' });
    const editor = screen.getByTestId('custom-motion-editor');
    const lanesInner = editor.querySelector('.cme__lanes-inner') as HTMLElement;
    expect(lanesInner.style.minWidth).toBe(lanesInner.style.width);
  });

  it('自定义角色动作语句块可以横向拖动改变开始时间', () => {
    const action = createCustomMotionAction('cm1', 2);
    const { onDrag } = renderTrackAreaWithCustomMotion({
      expandedActionId: null,
      actions: [action],
      document: {
        schemaVersion: 5,
        sceneId: 'cme-drag-test',
        meta: { title: 'CME Drag Test', characters: [{ id: 'Hina', name: 'Hina' }] },
        statements: [{
          id: 'statement-cm1',
          time: 2,
          type: 'characterPerformance',
          params: { target: 'Hina', motion: CUSTOM_MOTION },
        }],
      },
    });
    const block = screen.getByTestId('timeline-track-block');
    fireEvent.pointerDown(block, { button: 0, clientX: 20, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 30, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 30, clientY: 50, pointerId: 1 });

    expect(onDrag).toHaveBeenCalledWith('cm1', 3, [{ id: 'cm1', time: 3 }]);
  });

  it('自定义动作语句块的宽度使用 Motion 自身的时长', () => {
    const motion = { ...CUSTOM_MOTION, durationSeconds: 4 };
    const action = {
      id: 'cm1',
      action: {
        _id: 'cm1',
        action: 'playMotion',
        semanticType: 'characterPerformance',
        time: 2,
        params: { motion },
      } as unknown as SceneAction,
    };
    const { container } = renderTrackAreaWithCustomMotion({
      expandedActionId: null,
      actions: [action],
      document: {
        schemaVersion: 5,
        sceneId: 'cme-duration-test',
        meta: { title: 'CME Duration Test', characters: [{ id: 'Hina', name: 'Hina' }] },
        statements: [{
          id: 'statement-cm1',
          time: 2,
          type: 'characterPerformance',
          params: { target: 'Hina', motion },
        }],
      },
    });

    const block = container.querySelector('[data-testid="timeline-track-block"]') as HTMLElement;
    expect(block.dataset.actionDuration).toBe('4');
    expect(block.style.width).toBe('40px');
  });

  it('零时长语句块保留普通最小显示宽度，并按语义范围分行', () => {
    const { container } = renderTrackAreaWithCustomMotion({
      expandedActionId: null,
      actions: [
        { id: 'hide', action: { time: 2, action: 'setDialogueVisibility', semanticType: 'dialogueVisibility', params: { visible: false, duration: 0 } } },
        { id: 'show', action: { time: 2.5, action: 'setDialogueVisibility', semanticType: 'dialogueVisibility', params: { visible: true, duration: 0 } } },
        { id: 'expression', action: { time: 6, action: 'setExpression', params: { id: 'Hina', expression: 'smile', duration: 0 } } },
      ],
    });
    const blocks = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="timeline-track-block"]'));
    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      expect(block.style.width).toBe('4px');
      expect(block.dataset.actionDuration).toBe('0');
    }
    expect(blocks[0].style.top).toBe(blocks[1].style.top);
  });

  it('零时长块不会因视觉宽度扩展到视口外而被保留', () => {
    renderTrackAreaWithCustomMotion({
      expandedActionId: null,
      actions: [{ id: 'hide', action: { time: 2, action: 'setDialogueVisibility', semanticType: 'dialogueVisibility', params: { visible: false, duration: 0 } } }],
      viewWindow: { start: 4.5, end: 5 },
    });
    expect(screen.queryByTestId('timeline-track-block')).toBeNull();
  });

  it('对白下的自定义角色动作语句块也可以横向拖动改变开始时间', () => {
    const action = createCustomMotionAction('cm1', 2);
    const { onDrag } = renderTrackAreaWithCustomMotion({
      expandedActionId: null,
      actions: [action],
      document: {
        schemaVersion: 5,
        sceneId: 'cme-companion-drag-test',
        meta: { title: 'CME Companion Drag Test', characters: [{ id: 'Hina', name: 'Hina' }] },
        statements: [{
          id: 'dialogue-1',
          time: 1,
          type: 'dialogue',
          params: { speakerId: 'Hina', speaker: 'Hina', text: 'Hello', durationSeconds: 1 },
          companions: [{
            id: 'cm1',
            anchor: 'start',
            offset: 1,
            type: 'characterPerformance',
            params: { target: 'Hina', motion: CUSTOM_MOTION },
          }],
        }],
      },
    });
    const block = screen.getByTestId('timeline-track-block');
    fireEvent.pointerDown(block, { button: 0, clientX: 20, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 30, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 30, clientY: 50, pointerId: 1 });

    expect(onDrag).toHaveBeenCalledWith('cm1', 3, [{ id: 'cm1', time: 3 }]);
  });

  it('摘要模式下选中的自定义动作锚点仍可拖动整段语句', async () => {
    const actions = Array.from({ length: 141 }, (_, index) => {
      const id = index === 0 ? 'cm1' : `cm${index + 1}`;
      const time = index === 0 ? 2 : index * 0.1;
      return createCustomMotionAction(id, time);
    });
    const { onDrag } = renderTrackAreaWithCustomMotion({
      expandedActionId: null,
      actions,
      selectedIds: { cm1: true },
      document: {
        schemaVersion: 5,
        sceneId: 'cme-summary-drag-test',
        meta: { title: 'CME Summary Drag Test', characters: [{ id: 'Hina', name: 'Hina' }] },
        statements: actions.map(({ id, action }) => ({
          id: `statement-${id}`,
          time: action.time,
          type: 'characterPerformance',
          params: { target: 'Hina', motion: CUSTOM_MOTION },
        })),
      },
    });

    await waitFor(() => expect(screen.getByTestId('track-anchor-pin')).toBeTruthy());
    const anchor = screen.getByTestId('track-anchor-pin');
    fireEvent.pointerDown(anchor, { button: 0, clientX: 20, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 30, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 30, clientY: 50, pointerId: 1 });

    expect(onDrag).toHaveBeenCalledWith('cm1', 3, [{ id: 'cm1', time: 3 }]);
  });

  it('内嵌页头按视口宽度钉住，且不渲染空闲教学工具条', () => {
    renderTrackAreaWithCustomMotion({ expandedActionId: 'cm1' });
    const editor = screen.getByTestId('custom-motion-editor');
    expect(editor.style.getPropertyValue('--cme-viewport')).toBe('1000px');
    expect(editor.querySelector('.cme__header')).not.toBeNull();
    expect(editor.querySelector('.cme__identity')).not.toBeNull();
    expect(editor.querySelector('.cme__toolbar')).toBeNull();
    expect(editor.textContent).not.toContain('点击菱形编辑');
    expect(editor.querySelector('.cme__lease')).toBeNull();
    expect(editor.textContent).not.toContain('未连接编辑租约');
  });

  it('滚动时导航条与 32px 标尺底边无额外空隙', () => {
    renderTrackAreaWithCustomMotion({ expandedActionId: 'cm1' });
    const sticky = screen.getByTestId('custom-motion-editor').querySelector('.cme__sticky') as HTMLElement;
    expect(getComputedStyle(sticky).top).toBe('-8px');
  });

  it('only shows the acquired badge when the lease gate reports held', () => {
    render(
      <CustomMotionEditor
        motion={CUSTOM_MOTION}
        blockTime={2}
        pixelsPerSecond={10}
        playheadTime={2.5}
        leaseState="held"
        onCommit={vi.fn()}
      />,
    );
    expect(screen.getByTestId('custom-motion-editor').textContent).toContain('已获得编辑权');
  });

  it('点击关闭按钮收起展开带', () => {
    const { setCustomMotionEditorActionId } = renderTrackAreaWithCustomMotion({ expandedActionId: 'cm1' });
    fireEvent.click(screen.getByLabelText('收起关键帧编辑器'));
    expect(setCustomMotionEditorActionId).toHaveBeenCalledWith(null);
  });

  it('目标动作不是自定义动作时自动收起', () => {
    const plainAction = {
      id: 'plain1',
      action: {
        _id: 'plain1', action: 'dialogue', time: 1, params: { duration: 0.5, text: 'hi' },
      } as unknown as SceneAction,
    };
    const { setCustomMotionEditorActionId } = renderTrackAreaWithCustomMotion({
      expandedActionId: 'plain1',
      actions: [plainAction],
    });
    expect(screen.queryByTestId('custom-motion-editor')).toBeNull();
    expect(setCustomMotionEditorActionId).toHaveBeenCalledWith(null);
  });

  it('点击关键帧只高亮活动轨道上的同一时刻菱形，其它轨道同时刻不误选', () => {
    const dualTrackMotion = {
      ...CUSTOM_MOTION,
      tracks: [
        { parameterId: 'ParamAngleX', keyframes: [{ time: 0, value: 0 }, { time: 0.5, value: 5 }] },
        { parameterId: 'ParamEyeBallX', keyframes: [{ time: 0, value: 0 }, { time: 0.5, value: 3 }] },
      ],
    };
    renderTrackAreaWithCustomMotion({
      expandedActionId: 'cm1',
      actions: [createCustomMotionAction('cm1', 2, dualTrackMotion)],
    });
    const editor = screen.getByTestId('custom-motion-editor');
    const lanes = editor.querySelectorAll('.cme__lane');
    expect(lanes.length).toBe(2);
    // 点击第一条轨道 t=0.5 的菱形
    const diamond = lanes[0].querySelector('[data-kf="1"] path');
    expect(diamond).not.toBeNull();
    fireEvent.pointerDown(diamond as Element);
    // 第一条轨道 t=0.5 高亮为选中
    expect(lanes[0].querySelector('[data-kf="1"] path')?.getAttribute('fill')).toBe('var(--accent-primary)');
    // 第二条轨道 t=0.5 保持未选中外观
    expect(lanes[1].querySelector('[data-kf="1"] path')?.getAttribute('fill')).toBe('var(--bg-elevated)');
    // 两条轨道的首帧（t=0）都不应被误选
    expect(lanes[0].querySelector('[data-kf="0"] path')?.getAttribute('fill')).toBe('var(--bg-elevated)');
    expect(lanes[1].querySelector('[data-kf="0"] path')?.getAttribute('fill')).toBe('var(--bg-elevated)');
  });

  it('选中关键帧后可用 Escape、再点同一菱形或取消选中按钮取消选中', () => {
    render(
      <CustomMotionEditor
        motion={CUSTOM_MOTION}
        blockTime={2}
        pixelsPerSecond={10}
        playheadTime={2.5}
        onCommit={vi.fn()}
      />,
    );
    const editor = screen.getByTestId('custom-motion-editor');
    const diamond = editor.querySelector('[data-kf="1"] path');
    expect(diamond).not.toBeNull();
    fireEvent.pointerDown(diamond as Element);
    fireEvent.pointerUp(window);
    expect(screen.getByRole('spinbutton', { name: '值' })).toBeTruthy();

    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.queryByRole('spinbutton', { name: '值' })).toBeNull();

    fireEvent.pointerDown(diamond as Element);
    fireEvent.pointerUp(window);
    fireEvent.click(screen.getByRole('button', { name: '取消选中' }));
    expect(screen.queryByRole('spinbutton', { name: '值' })).toBeNull();

    fireEvent.pointerDown(diamond as Element);
    fireEvent.pointerUp(window);
    expect(screen.getByRole('spinbutton', { name: '值' })).toBeTruthy();
    fireEvent.pointerDown(diamond as Element);
    fireEvent.pointerUp(window);
    expect(screen.queryByRole('spinbutton', { name: '值' })).toBeNull();
  });

  it('参数标签显示播放头处的当前值，而不是关键帧总数', () => {
    render(
      <CustomMotionEditor
        motion={CUSTOM_MOTION}
        blockTime={2}
        pixelsPerSecond={10}
        playheadTime={2.5}
        onCommit={vi.fn()}
      />,
    );

    const currentValue = screen.getByTestId('custom-motion-editor').querySelector('.cme__navigator .cme__count');
    expect(currentValue?.textContent).toBe('5');
    const laneValue = screen.getByTestId('custom-motion-editor').querySelector('.cme__lane-label .cme__count');
    expect(laneValue?.textContent).toBe('5');
  });

  it('播放时间变化时轨道标签数字实时跟随，不依赖量化后的 playheadTime', () => {
    const listeners = new Set<(time: number) => void>();
    let currentTime = 2;
    const adapters = {
      playback: {
        getCurrentTime: () => currentTime,
        subscribeTime: (callback: (time: number) => void) => {
          listeners.add(callback);
          return () => listeners.delete(callback);
        },
      },
    };
    render(
      <AppProvider adapters={adapters as any} stores={{} as any}>
        <CustomMotionEditor
          motion={CUSTOM_MOTION}
          blockTime={2}
          pixelsPerSecond={10}
          playheadTime={2}
          onCommit={vi.fn()}
        />
      </AppProvider>,
    );

    const laneValue = screen.getByTestId('custom-motion-editor').querySelector('.cme__lane-label .cme__count');
    expect(laneValue?.textContent).toBe('0');

    currentTime = 2.25;
    act(() => {
      for (const listener of listeners) listener(currentTime);
    });
    expect(laneValue?.textContent).toBe('2.5');

    currentTime = 2.5;
    act(() => {
      for (const listener of listeners) listener(currentTime);
    });
    expect(laneValue?.textContent).toBe('5');
  });

  it('选中关键帧后可左右拖动参数标签中的当前值，并在松手时只提交一次', () => {
    const onCommit = vi.fn();
    render(
      <CustomMotionEditor
        motion={CUSTOM_MOTION}
        blockTime={2}
        pixelsPerSecond={10}
        playheadTime={2.5}
        onCommit={onCommit}
      />,
    );
    const editor = screen.getByTestId('custom-motion-editor');
    const diamond = editor.querySelector('[data-kf="1"] path');
    expect(diamond).not.toBeNull();
    fireEvent.pointerDown(diamond as Element);

    const currentValue = editor.querySelector('.cme__navigator [role="spinbutton"]') as HTMLElement;
    expect(currentValue).not.toBeNull();
    fireEvent.mouseDown(currentValue, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.mouseMove(document, { clientX: 20, clientY: 10, movementX: 10 });
    expect(currentValue.textContent).toBe('5.5');
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.mouseUp(document, { clientX: 20, clientY: 10 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith([
      { type: 'update-keyframe', trackParameterId: 'ParamAngleX', time: 0.5, value: 5.5 },
    ], expect.any(Object));
  });

  it('空白轨道和曲线点击只清除选择，不添加关键帧', () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <CustomMotionEditor
        motion={CUSTOM_MOTION}
        blockTime={2}
        pixelsPerSecond={10}
        playheadTime={2.25}
        onCommit={onCommit}
      />,
    );
    const editor = screen.getByTestId('custom-motion-editor');
    fireEvent.pointerDown(editor.querySelector('[data-testid="cme-lanes"] svg') as Element);
    expect(onCommit).not.toHaveBeenCalled();

    rerender(
      <CustomMotionEditor
        motion={CUSTOM_MOTION}
        blockTime={2}
        pixelsPerSecond={10}
        playheadTime={2.25}
        onCommit={onCommit}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '曲线' }));
    fireEvent.pointerDown(editor.querySelector('[data-testid="cme-curve"] svg') as Element);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('实时播放头事件优先于过期的适配器读取，插帧落在播放头处', () => {
    const onCommit = vi.fn();
    const listeners = new Set<(time: number) => void>();
    let engineTime = 2;
    const adapters = {
      playback: {
        getCurrentTime: () => engineTime,
        subscribeTime: (callback: (time: number) => void) => {
          listeners.add(callback);
          return () => listeners.delete(callback);
        },
      },
    };
    render(
      <AppProvider adapters={adapters as any} stores={{} as any}>
        <CustomMotionEditor
          motion={CUSTOM_MOTION}
          blockTime={2}
          pixelsPerSecond={10}
          playheadTime={2}
          onCommit={onCommit}
        />
      </AppProvider>,
    );

    // A seek dispatches the new playhead before the engine's synchronous
    // getter catches up. The edit must use the dispatched value.
    act(() => {
      for (const listener of listeners) listener(2.25);
    });
    fireEvent.click(screen.getByRole('button', { name: '在当前播放头添加关键帧' }));
    expect(onCommit).toHaveBeenCalledWith([
      { type: 'insert-keyframe', trackParameterId: 'ParamAngleX', time: 0.25, value: 2.5 },
    ], expect.any(Object));
    engineTime = 2.25;
  });

  it('编辑器初次展开时使用适配器的实际播放头，不使用过期的父级时间', () => {
    const onCommit = vi.fn();
    const adapters = {
      playback: {
        // The parent timeline can still be rendering its previous bucket while
        // the adapter already exposes the exact current scene time.
        getCurrentTime: () => 2.3,
        subscribeTime: () => () => {},
      },
    };
    render(
      <AppProvider adapters={adapters as any} stores={{} as any}>
        <CustomMotionEditor
          motion={CUSTOM_MOTION}
          blockTime={2}
          pixelsPerSecond={10}
          playheadTime={2.5}
          onCommit={onCommit}
        />
      </AppProvider>,
    );

    expect(screen.getByTestId('custom-motion-editor').querySelector('.cme__playhead')?.getAttribute('style')).toContain('left: 23px');
    fireEvent.click(screen.getByRole('button', { name: '在当前播放头添加关键帧' }));
    expect(onCommit).toHaveBeenCalledWith([
      { type: 'insert-keyframe', trackParameterId: 'ParamAngleX', time: 0.3, value: 3 },
    ], expect.any(Object));
  });

  it('时间轴展开带优先使用父级订阅保存的播放头，避免引擎读取滞后导致插帧落后', () => {
    const onCommit = vi.fn();
    const adapters = {
      playback: {
        // A seek notification can reach the timeline before the engine getter
        // catches up. TrackArea keeps that exact notification in its ref and
        // passes it to the embedded timeline editor.
        getCurrentTime: () => 2.1,
        subscribeTime: () => () => {},
      },
    };
    render(
      <AppProvider adapters={adapters as any} stores={{} as any}>
        <CustomMotionEditor
          motion={CUSTOM_MOTION}
          layout="timeline"
          gutterWidth={100}
          blockTime={2}
          pixelsPerSecond={10}
          playheadTime={2.25}
          onCommit={onCommit}
        />
      </AppProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '在当前播放头添加关键帧' }));
    expect(onCommit).toHaveBeenCalledWith([
      { type: 'insert-keyframe', trackParameterId: 'ParamAngleX', time: 0.25, value: 2.5 },
    ], expect.any(Object));
  });

  it('提交后关键帧标记使用与主播放头相同的场景时间坐标', () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <CustomMotionEditor
        motion={CUSTOM_MOTION}
        layout="timeline"
        gutterWidth={100}
        blockTime={2}
        pixelsPerSecond={10}
        playheadTime={2.25}
        onCommit={onCommit}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '在当前播放头添加关键帧' }));
    const insertedMotion = {
      ...CUSTOM_MOTION,
      tracks: [{
        ...CUSTOM_MOTION.tracks[0],
        keyframes: [...CUSTOM_MOTION.tracks[0].keyframes, { time: 0.25, value: 2.5 }],
      }],
    };
    rerender(
      <CustomMotionEditor
        motion={insertedMotion}
        layout="timeline"
        gutterWidth={100}
        blockTime={2}
        pixelsPerSecond={10}
        playheadTime={2.25}
        onCommit={onCommit}
      />,
    );

    const marker = screen.getByTestId('custom-motion-editor').querySelector('[data-kf="2"] path');
    expect(marker?.getAttribute('d')).toContain('M 22.5');
  });

  it('插帧保留播放头的精确秒数，不用两位小数把标尺位置改掉', () => {
    const onCommit = vi.fn();
    render(
      <CustomMotionEditor
        motion={CUSTOM_MOTION}
        blockTime={2}
        pixelsPerSecond={100}
        playheadTime={2.256}
        onCommit={onCommit}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '在当前播放头添加关键帧' }));
    expect(onCommit).toHaveBeenCalledWith([
      { type: 'insert-keyframe', trackParameterId: 'ParamAngleX', time: 0.256, value: 2.56 },
    ], expect.any(Object));
  });

  it('播放头没有关键帧时修改当前值会插帧，已有关键帧时只更新该帧', () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <CustomMotionEditor
        motion={CUSTOM_MOTION}
        blockTime={2}
        pixelsPerSecond={10}
        playheadTime={2.25}
        onCommit={onCommit}
      />,
    );
    const control = screen.getByTestId('custom-motion-editor').querySelector('.cme__navigator [role="spinbutton"]') as HTMLElement;
    expect(control).not.toBeNull();
    fireEvent.keyDown(control, { key: 'ArrowUp' });
    expect(onCommit).toHaveBeenCalledWith([
      { type: 'insert-keyframe', trackParameterId: 'ParamAngleX', time: 0.25, value: 2.55 },
    ], expect.any(Object));

    onCommit.mockClear();
    rerender(
      <CustomMotionEditor
        motion={CUSTOM_MOTION}
        blockTime={2}
        pixelsPerSecond={10}
        playheadTime={2.5}
        onCommit={onCommit}
      />,
    );
    fireEvent.keyDown(screen.getByTestId('custom-motion-editor').querySelector('.cme__navigator [role="spinbutton"]') as HTMLElement, { key: 'ArrowUp' });
    expect(onCommit).toHaveBeenCalledWith([
      { type: 'update-keyframe', trackParameterId: 'ParamAngleX', time: 0.5, value: 5.05 },
    ], expect.any(Object));
  });

  it('Motion 设置输入框按 Escape 只取消草稿，不提交修改', () => {
    const onCommit = vi.fn();
    render(
      <CustomMotionEditor
        motion={CUSTOM_MOTION}
        blockTime={2}
        pixelsPerSecond={10}
        playheadTime={2}
        onCommit={onCommit}
      />,
    );
    fireEvent.keyDown(screen.getByRole('spinbutton', { name: '动作时长（秒）' }), { key: 'Enter' });
    const durationInput = screen.getByRole('spinbutton', { name: '动作时长（秒）' }) as HTMLInputElement;
    fireEvent.change(durationInput, { target: { value: '3' } });
    fireEvent.keyDown(durationInput, { key: 'Escape' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('spinbutton', { name: '动作时长（秒）' }).textContent).toBe('1');
  });

  it('数值调整器保存关键帧后保留编辑栏并可继续输入', () => {
    const onCommit = vi.fn();
    const editorProps = {
      blockTime: 2,
      pixelsPerSecond: 10,
      playheadTime: 0,
      onCommit,
    };
    const { rerender } = render(
      <CustomMotionEditor motion={CUSTOM_MOTION} {...editorProps} />,
    );
    const diamond = screen.getByTestId('custom-motion-editor').querySelector('[data-kf="1"] path');
    expect(diamond).not.toBeNull();
    fireEvent.pointerDown(diamond as Element);

    fireEvent.keyDown(screen.getByRole('spinbutton', { name: '值' }), { key: 'Enter' });
    const valueInput = screen.getByRole('spinbutton', { name: '值' }) as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: '12' } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(valueInput);
    expect(onCommit).toHaveBeenCalledWith([
      { type: 'update-keyframe', trackParameterId: 'ParamAngleX', time: 0.5, value: 12 },
    ], expect.any(Object));

    const updatedMotion = {
      ...CUSTOM_MOTION,
      tracks: [{
        ...CUSTOM_MOTION.tracks[0],
        keyframes: [CUSTOM_MOTION.tracks[0].keyframes[0], { time: 0.5, value: 12 }],
      }],
    };
    rerender(<CustomMotionEditor motion={updatedMotion} {...editorProps} />);

    expect(screen.getByRole('spinbutton', { name: '值' }).textContent).toBe('12');
    fireEvent.keyDown(screen.getByRole('spinbutton', { name: '值' }), { key: 'Enter' });
    const refreshedInput = screen.getByRole('spinbutton', { name: '值' }) as HTMLInputElement;
    expect(refreshedInput.value).toBe('12');
    expect(document.activeElement).toBe(refreshedInput);
  });

  it('视图切换只保留轨道和曲线', () => {
    render(
      <CustomMotionEditor
        motion={CUSTOM_MOTION}
        blockTime={2}
        pixelsPerSecond={10}
        playheadTime={2}
        onCommit={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: '列表' })).toBeNull();
    expect(screen.queryByTestId('cme-list')).toBeNull();
    expect(screen.getByTestId('cme-lanes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '曲线' }));
    expect(screen.getByTestId('cme-curve')).toBeTruthy();
  });

  it('曲线视图在贝塞尔分段上显示控制点手柄', () => {
    const bezierMotion = {
      ...CUSTOM_MOTION,
      tracks: [{
        parameterId: 'ParamAngleX',
        keyframes: [
          {
            time: 0,
            value: 0,
            segment: {
              type: 'bezier' as const,
              controlPoints: [
                { time: 0.18, value: 1 },
                { time: 0.32, value: 4 },
              ] as [{ time: number; value: number }, { time: number; value: number }],
            },
          },
          { time: 0.5, value: 5 },
        ],
      }],
    };
    render(
      <CustomMotionEditor
        motion={bezierMotion}
        blockTime={2}
        pixelsPerSecond={10}
        playheadTime={2}
        onCommit={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '曲线' }));
    const curve = screen.getByTestId('cme-curve');
    expect(curve.querySelectorAll('[data-cp]').length).toBe(2);
    expect(curve.querySelector('.cme__bezier-handle')).not.toBeNull();
  });

  it('空轨道（协作中间态）在曲线视图不崩溃且显示空状态', () => {
    const emptyMotion = {
      ...CUSTOM_MOTION,
      tracks: [] as unknown as CustomMotionEditorProps['motion']['tracks'],
    };
    render(
      <CustomMotionEditor
        motion={emptyMotion}
        blockTime={2}
        pixelsPerSecond={10}
        playheadTime={2}
        onCommit={vi.fn()}
      />,
    );
    // 轨道视图（默认）与曲线视图都必须能渲染，而不是抛 TypeError。
    expect(screen.getByTestId('custom-motion-editor').textContent).toContain('0 条轨道');
    fireEvent.click(screen.getByRole('button', { name: '曲线' }));
    expect(screen.getByTestId('custom-motion-editor').textContent).toContain('该动作没有可编辑的参数轨道');
  });

  it('timeline 模式下页头与工具条同处一个 sticky 容器，滚动时不会互相覆盖', () => {
    render(
      <CustomMotionEditor
        motion={CUSTOM_MOTION}
        layout="timeline"
        gutterWidth={100}
        viewportWidth={1000}
        blockTime={2}
        pixelsPerSecond={10}
        playheadTime={2}
        onCommit={vi.fn()}
      />,
    );
    const editor = screen.getByTestId('custom-motion-editor');
    const sticky = editor.querySelector('.cme__sticky');
    expect(sticky).not.toBeNull();
    expect(sticky?.querySelector('.cme__header')).not.toBeNull();
    // 选中关键帧后工具条也渲染在同一个 sticky 容器里，而不是与页头各自 sticky。
    const diamond = editor.querySelector('.cme__kf');
    fireEvent.pointerDown(diamond as Element);
    expect(sticky?.querySelector('.cme__toolbar')).not.toBeNull();
    expect(editor.querySelector(':scope > .cme__toolbar')).toBeNull();
  });

  it('租约门的 subscribe 作为 useSyncExternalStore 回调时不丢失 this 绑定', () => {
    // 回归：此前直接把 gate.subscribe 方法引用传给 useSyncExternalStore，
    // 回调以普通函数调用导致 this 为 undefined（this.listeners 崩溃）。
    class FakeLeaseGate {
      private readonly listeners = new Set<() => void>();
      acquire(): Promise<boolean> { return Promise.resolve(true); }
      release(): void {}
      getState(): 'unavailable' { return 'unavailable'; }
      subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      }
    }
    expect(() => renderTrackAreaWithCustomMotion({
      expandedActionId: null,
      collaboration: { status: 'disconnected', customMotionEditLeaseGate: new FakeLeaseGate() },
    })).not.toThrow();
    expect(screen.queryByTestId('custom-motion-editor')).toBeNull();
  });

  it('isTrackAnimated 能够准确区分动态轨道与静态恒定轨道', () => {
    expect(isTrackAnimated({ parameterId: 'PARAM_STATIC', keyframes: [{ time: 0, value: 0 }, { time: 2, value: 0 }] })).toBe(false);
    expect(isTrackAnimated({ parameterId: 'PARAM_SINGLE', keyframes: [{ time: 0, value: 10 }] })).toBe(false);
    expect(isTrackAnimated({ parameterId: 'PARAM_ANIM', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 10 }] })).toBe(true);
  });

  it('自定义动作编辑器支持全部与仅动态参数过滤切换及搜索过滤', () => {
    const multiTrackMotion = {
      kind: 'custom' as const,
      derivedFrom: { key: 'sample' },
      durationSeconds: 2,
      fadeInSeconds: 0.2,
      tracks: [
        {
          parameterId: 'PARAM_DYNAMIC_1',
          keyframes: [{ time: 0, value: 0 }, { time: 1, value: 10 }],
        },
        {
          parameterId: 'PARAM_STATIC_1',
          keyframes: [{ time: 0, value: 0 }, { time: 2, value: 0 }],
        },
        {
          parameterId: 'PARAM_STATIC_2',
          keyframes: [{ time: 0, value: 5 }, { time: 2, value: 5 }],
        },
      ],
    };

    render(
      <CustomMotionEditor
        motion={multiTrackMotion}
        blockTime={0}
        pixelsPerSecond={10}
        playheadTime={0}
        onCommit={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /全部 \(3\)/ })).not.toBeNull();
    expect(screen.getByRole('button', { name: /仅动态 \(1\)/ })).not.toBeNull();

    // 默认显示全部 3 条轨道
    const lanesInner = screen.getByTestId('cme-lanes');
    expect(lanesInner.querySelectorAll('.cme__lane').length).toBe(3);

    // 点击“仅动态 (1)”
    fireEvent.click(screen.getByRole('button', { name: /仅动态 \(1\)/ }));
    expect(lanesInner.querySelectorAll('.cme__lane').length).toBe(1);

    // 切换回“全部 (3)”
    fireEvent.click(screen.getByRole('button', { name: /全部 \(3\)/ }));
    expect(lanesInner.querySelectorAll('.cme__lane').length).toBe(3);

    // 搜索过滤
    const searchInput = screen.getByRole('searchbox', { name: '搜索参数' });
    fireEvent.change(searchInput, { target: { value: 'STATIC_2' } });
    expect(lanesInner.querySelectorAll('.cme__lane').length).toBe(1);
  });
});
