/** @vitest-environment jsdom */
import { setupInlineDetailsFixture, state, list } from './fixtures/timelineInlineDetails';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { sceneDocumentCodec, sceneStatementCompiler } from '../services/semantic-scene';

setupInlineDetailsFixture();

describe('Inline details expansion selection', () => {
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
});
