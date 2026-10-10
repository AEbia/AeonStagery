/** @vitest-environment jsdom */
import { setupInlineInspectorFixture, state, loadStatements, setCharacterModel, renderList } from './fixtures/timelineInlineInspector';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

setupInlineInspectorFixture();

describe('List inline inspector resources', () => {
  it('edits a companion through its locator without changing the parent dialogue', async () => {
    loadStatements([{ id: 'line', type: 'dialogue', time: 0,
      params: { text: 'Hello', durationSeconds: 2 }, companions: [{
        id: 'performance', type: 'characterPerformance', anchor: 'start', offset: 0,
        params: { target: 'alice', motion: { kind: 'resource', key: 'wave', fadeInSeconds: 0.4 } },
      }] }]);
    setCharacterModel('figure/alice/main.model3.json');
    renderList();
    const motion = screen.getByRole('combobox', { name: '动作名称' });
    fireEvent.click(motion);
    fireEvent.click(await screen.findByRole('option', { name: 'nod' }));
    await waitFor(() => expect(state.document.statements[0].companions[0].params.motion).toEqual({ kind: 'resource', key: 'nod', fadeInSeconds: 0.4 }));
    expect(state.authorMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'update-dialogue-companion', locator: expect.objectContaining({ statementId: 'line', companionId: 'performance' }) }));
    expect(state.document.statements[0].params.text).toBe('Hello');
    });

  it('previews and selects expressions in the quick resource picker without expanding the row', async () => {
    loadStatements([{ id: 'expression', type: 'characterPerformance', time: 0,
      params: { target: 'alice', expression: 'smile' } }]);
    setCharacterModel('figure/alice/main.model3.json');
    const { container } = renderList();
    expect(screen.queryByRole('textbox', { name: '表情名' })).toBeNull();
    fireEvent.click(screen.getByRole('combobox', { name: '表情名' }));
    fireEvent.click(await screen.findByRole('button', { name: '预览 happy' }));
    expect(state.characterAdapter.setExpression).toHaveBeenCalledWith('alice', 'happy');
    expect(state.authorMock).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    expect(state.characterAdapter.setExpression).toHaveBeenLastCalledWith('alice', 'smile');
    fireEvent.click(screen.getByRole('combobox', { name: '表情名' }));
    fireEvent.click(screen.getByRole('option', { name: 'happy' }));
    await waitFor(() => expect(state.document.statements[0].params.expression).toBe('happy'));
    expect(container.querySelector('.inspector-workspace__detail')).toBeNull();
    });

  it('uses the active entrance model and speaker binding for cascading motion and expression choices', async () => {
    loadStatements([
      { id: 'enter', type: 'characterPresence', time: 0,
        params: { mode: 'enter', id: 'alice', model: 'figure/mygo/alice/winter.model3.json' } },
      { id: 'line', type: 'dialogue', time: 1,
        params: { speakerId: 'alice', text: 'Hello', durationSeconds: 2 }, companions: [{
          id: 'performance', type: 'characterPerformance', anchor: 'start', offset: 0,
          params: { target: '$speaker', motion: '' },
        }] },
      { id: 'later-enter', type: 'characterPresence', time: 4,
        params: { mode: 'enter', id: 'alice', model: 'figure/mygo/alice/summer.model3.json' } },
    ]);
    setCharacterModel('figure/mygo/alice/main.model3.json');
    const { container } = renderList();
    fireEvent.click(screen.getByRole('combobox', { name: '动作名称' }));
    await screen.findByRole('option', { name: 'bow' });
    expect(state.characterAdapter.getModelDataFromPath).toHaveBeenCalledWith('figure/mygo/alice/winter.model3.json');
    expect(state.characterAdapter.getModelDataFromPath).not.toHaveBeenCalledWith('figure/mygo/alice/summer.model3.json');
    expect(screen.getByRole('listbox', { name: '一级分组' })).toBeTruthy();
    expect(screen.getByRole('listbox', { name: '二级分组' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'bow' }).closest('[role="listbox"]'))
      .toBe(screen.getByRole('listbox', { name: '可选项' }));
    fireEvent.click(screen.getByRole('button', { name: '预览 mygo/alice/bow' }));
    expect(state.characterAdapter.playMotion).toHaveBeenCalledWith('alice', 'mygo/alice/bow');
    expect(state.authorMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('option', { name: 'bow' }));
    await waitFor(() => expect(state.document.statements[1].companions[0].params).toEqual({
      target: '$speaker', motion: { kind: 'resource', key: 'mygo/alice/bow' },
    }));
    fireEvent.click(screen.getByRole('combobox', { name: '表情名' }));
    expect(screen.getByRole('listbox', { name: '一级分组' })).toBeTruthy();
    expect(screen.getByRole('listbox', { name: '二级分组' })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'happy' }));
    await waitFor(() => expect(state.document.statements[1].companions[0].params.expression).toBe('mygo/alice/happy'));
    expect(container.querySelector('.inspector-workspace__detail')).toBeNull();
    });

  it('clears the only expression into a valid empty performance placeholder', async () => {
    loadStatements([{ id: 'expression', type: 'characterPerformance', time: 0,
      params: { target: 'alice', expression: 'smile' } }]);
    renderList();
    fireEvent.click(screen.getByRole('button', { name: '清除表情名' }));
    await waitFor(() => expect(state.document.statements[0].params).toEqual({ target: 'alice', motion: '' }));
    });

  it('clears a resource motion to a placeholder while preserving other performance fields', async () => {
    loadStatements([{ id: 'motion', type: 'characterPerformance', time: 0,
      params: { target: 'alice', motion: { kind: 'resource', key: 'wave' }, expression: 'smile' } }]);
    renderList();
    fireEvent.click(screen.getByRole('button', { name: '清除动作名称' }));
    await waitFor(() => expect(state.document.statements[0].params).toEqual({
      target: 'alice', motion: '', expression: 'smile',
    }));
    });

  it('blocks resource selection and preview while collaboration is offline', async () => {
    loadStatements([{ id: 'motion', type: 'characterPerformance', time: 0,
      params: { target: 'alice', motion: { kind: 'resource', key: 'wave' }, expression: 'smile' } }]);
    setCharacterModel('figure/alice/main.model3.json');
    state.collaborationStatus = 'offline';
    renderList();
    const picker = screen.getByRole('combobox', { name: '动作名称' });
    expect(picker.closest('fieldset')?.disabled).toBe(true);
    // Synthetic events can bypass the native disabled fieldset; callbacks still guard writes and previews.
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole('button', { name: '预览 nod' }));
    fireEvent.click(screen.getByRole('option', { name: 'nod' }));
    fireEvent.click(screen.getByRole('button', { name: '清除表情名' }));
    expect(state.authorMock).not.toHaveBeenCalled();
    expect(state.characterAdapter.playMotion).not.toHaveBeenCalled();
    expect(state.characterAdapter.setExpression).not.toHaveBeenCalled();
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
});
