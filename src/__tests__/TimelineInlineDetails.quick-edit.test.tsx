/** @vitest-environment jsdom */
import { setupInlineDetailsFixture, state, load, list, expand } from './fixtures/timelineInlineDetails';
import { act, createEvent, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SemanticAuthorIntent } from '../api/types/authoring';
import { sceneStatementCompiler } from '../services/semantic-scene';
import { SemanticTimelineAuthoringService } from '../services/timeline-authoring/SemanticTimelineAuthoringService';

setupInlineDetailsFixture();

describe('Inline details quick edit', () => {
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

  it('commits an expanded inspector scrub once when the drag ends', () => {
    load('camera', { mode: 'shake', intensity: 0.4, durationSeconds: 1, frequency: 10 });
    const { container } = list();
    const detail = expand(container);
    const frequency = detail.getByRole('spinbutton', { name: '震动频率' });

    fireEvent.mouseDown(frequency, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.mouseMove(document, { clientX: 46, clientY: 10, movementX: 36 });
    fireEvent.mouseMove(document, { clientX: 82, clientY: 10, movementX: 36 });
    const intermediateCalls = state.author.mock.calls.length;
    const finalValue = Number(frequency.querySelector('.scrubbable-badge-value')?.textContent);
    fireEvent.mouseUp(document, { clientX: 82, clientY: 10 });

    expect(intermediateCalls).toBe(0);
    expect(finalValue).toBeGreaterThan(10);
    expect(state.author).toHaveBeenCalledTimes(1);
    expect(state.author).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'update-statement',
      patch: { params: { mode: 'shake', intensity: 0.4, durationSeconds: 1, frequency: finalValue } },
    }));
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

  it.each([undefined, [0.4, 0.6]])('clears a camera focus target with position %j to use fixed coordinates', async (position) => {
    const params = {
      mode: 'focus', target: 'alice', ...(position ? { position } : {}),
      zoom: { kind: 'absolute', value: 1.2 }, durationSeconds: 1,
    };
    load('camera', params);
    const { container } = list();
    const detail = expand(container);
    expect(detail.queryByRole('combobox', { name: '目标角色' })).toBeNull();

    fireEvent.click(screen.getByRole('combobox', { name: '跟随目标' }));
    const fixedCoordinates = screen.getByRole('option', { name: '固定坐标' });
    await act(async () => { fireEvent.click(fixedCoordinates); });

    const fixedParams = {
      mode: 'focus', position: position ?? [0.5, 0.5],
      zoom: { kind: 'absolute', value: 1.2 }, durationSeconds: 1,
    };
    expect(state.author).toHaveBeenCalledTimes(1);
    expect(state.author).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'update-statement', patch: { params: fixedParams },
    }));
    const result = new SemanticTimelineAuthoringService().author(
      state.document, state.author.mock.calls[0][0] as SemanticAuthorIntent,
    );
    expect(sceneStatementCompiler.compile(result.document).actions[0].params.focus)
      .toEqual({ point: fixedParams.position });
  });

  it('keeps a character target required for camera following', () => {
    load('camera', { mode: 'follow', operation: 'start', target: 'alice' });
    list();
    fireEvent.click(screen.getByRole('combobox', { name: '跟随目标' }));
    expect(screen.queryByRole('option', { name: '固定坐标' })).toBeNull();
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

  it('edits the literal environment layer ID in the row without a duplicate detail control', () => {
    load('environmentLayer', { mode: 'set', layerId: 'background', file: 'background.png' });
    const { container } = list();
    const detail = expand(container);
    expect(detail.queryByRole('combobox', { name: '选择或新建环境层' })).toBeNull();
    expect(detail.queryByRole('combobox', { name: '环境层名称' })).toBeNull();
    expect(detail.queryByRole('textbox', { name: '环境图层 ID' })).toBeNull();
    expect((screen.getByRole('textbox', { name: '环境图层 ID' }) as HTMLInputElement).value).toBe('background');
  });

  it('retains integration target selection and color controls without duplicating numeric fields', () => {
    load('visualStyle', { scope: 'object', target: 'alice', slot: 'integration', mode: 'set', recipeId: 'builtin:integration-soft', intensity: 0.8, durationSeconds: 0.5 });
    const { container } = list();
    const detail = expand(container);
    expect(detail.getByRole('combobox', { name: '角色' })).toBeTruthy();
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
});
