/** @vitest-environment jsdom */
import { setupInlineDetailsFixture, state, load, list, expand } from './fixtures/timelineInlineDetails';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

setupInlineDetailsFixture();

describe('Inline details resources', () => {
  it('keeps one audio file picker with browsing in the row after expanding details', () => {
    load('audio', { role: 'bgm', mode: 'play', file: 'music.ogg' });
    const { container } = list();
    const detail = expand(container);
    expect(detail.queryByRole('button', { name: '音频文件' })).toBeNull();
    expect(detail.queryByRole('textbox', { name: '音频文件' })).toBeNull();
    expect(detail.queryByText('music.ogg')).toBeNull();
    expect((screen.getByRole('textbox', { name: '音频文件' }) as HTMLInputElement).value).toBe('music.ogg');
    expect(screen.getByRole('button', { name: '打开资源浏览器' })).toBeTruthy();
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

  it.each([false, true])('writes the actual main model path from the row with expanded=%s', async (expanded) => {
    const mainModel = '@mount/figure/figure/hero/main.model3.json';
    load('characterPresence', { mode: 'enter', id: 'alice', model: 'figure/hero/winter.model3.json', opacity: 0.8 }, [{
      id: 'alice', name: 'Alice', model: mainModel,
      variants: [{ name: '冬装', model: 'figure/hero/winter.model3.json' }],
    }]);
    const { container } = list();
    if (expanded) {
      expect(expand(container).queryByRole('combobox', { name: '模型变体' })).toBeNull();
    }
    const picker = screen.getByRole('combobox', { name: '模型变体' });
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
    const picker = screen.getByRole('combobox', { name: '模型变体' });
    expect(picker.textContent).toBe('自定义模型');
    expect(detail.queryByRole('combobox', { name: '模型变体' })).toBeNull();
    expect(detail.queryByText('alice.model3.json')).toBeNull();
    expect(detail.queryByText('空间坐标')).toBeNull();
    // The registered-model catalog stays one column: no group rails, and no meaningless "current file" entry.
    fireEvent.click(picker);
    expect(screen.queryByRole('listbox', { name: '一级分组' })).toBeNull();
    expect(screen.queryByRole('listbox', { name: '二级分组' })).toBeNull();
    expect(screen.getByRole('option', { name: '主模型' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '冬装' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '夏装' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: '当前模型文件' })).toBeNull();
    fireEvent.keyDown(picker, { key: 'Escape' });
    await waitFor(() => expect(state.characterAdapter.getModelDataFromPath).toHaveBeenCalledWith('alice.model3.json'));
  });

  it('keeps motion and expression browsing and preview in the row while retaining conversion in details', async () => {
    load('characterPerformance', { target: 'alice', motion: { kind: 'resource', key: 'wave', fadeInSeconds: 0.3 }, expression: 'smile' }, [
      { id: 'alice', name: 'Alice', model: 'figure/alice/main.model3.json' },
    ]);
    const { container } = list();
    const detail = expand(container);
    expect(detail.queryByRole('combobox', { name: '动作名称' })).toBeNull();
    expect(detail.queryByRole('combobox', { name: '表情名' })).toBeNull();
    expect(detail.queryByText('wave')).toBeNull();
    expect(detail.queryByText('smile')).toBeNull();
    expect(detail.getByTestId('resource-motion-conversion')).toBeTruthy();
    const row = within(container.querySelector('.timeline-item__quick-fields') as HTMLElement);
    const motionPicker = screen.getByRole('combobox', { name: '动作名称' });
    const expressionPicker = screen.getByRole('combobox', { name: '表情名' });
    expect(row.getByRole('combobox', { name: '动作名称' })).toBe(motionPicker);
    expect(row.getByRole('combobox', { name: '表情名' })).toBe(expressionPicker);
    await waitFor(() => {
      expect(motionPicker.textContent).toContain('wave');
      expect(expressionPicker.textContent).toContain('smile');
    });
    expect(screen.queryByRole('textbox', { name: '动作名称' })).toBeNull();
    fireEvent.click(motionPicker);
    fireEvent.click(await screen.findByRole('button', { name: '预览 wave' }));
    expect(state.characterAdapter.playMotion).toHaveBeenCalledWith('alice', 'wave');
    fireEvent.keyDown(motionPicker, { key: 'Escape' });
    fireEvent.click(expressionPicker);
    fireEvent.click(await screen.findByRole('button', { name: '预览 smile' }));
    expect(state.characterAdapter.setExpression).toHaveBeenCalledWith('alice', 'smile');
  });

  it('retains the custom motion keyframe editor', () => {
    load('characterPerformance', { target: 'alice', motion: { kind: 'custom', durationSeconds: 1, fadeInSeconds: 0,
      derivedFrom: { key: 'wave' }, tracks: [{ parameterId: 'ParamAngleX', keyframes: [{ time: 0, value: 0 }] }] } });
    const { container } = list();
    const detail = expand(container);
    fireEvent.click(detail.getByRole('button', { name: '编辑关键帧' }));
    expect(state.openCustomMotionEditor).toHaveBeenCalledWith({ statementId: 'line' });
    expect((screen.getByRole('textbox', { name: '动作名称' }) as HTMLInputElement).readOnly).toBe(true);
  });
});
