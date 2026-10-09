/** @vitest-environment jsdom */
import { setupInlineInspectorFixture, state, loadStatements, renderList } from './fixtures/timelineInlineInspector';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { editNumericControl } from './fixtures/editNumericControl';
import { sceneDocumentCodec, sceneStatementCompiler } from '../services/semantic-scene';
import { TimelineListView } from '../ui/timeline/TimelineListView';

setupInlineInspectorFixture();

describe('List inline inspector quick edit', () => {
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
});
