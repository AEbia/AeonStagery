/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchableSelect } from '../ui/SearchableSelect';

function openDropdown() {
  fireEvent.click(screen.getByRole('combobox'));
}

describe('SearchableSelect preview protocol', () => {
  afterEach(() => {
    cleanup();
  });

  it('does not preview on hover, even with onPreview provided', () => {
    const onPreview = vi.fn();
    render(
      <SearchableSelect
        value="default"
        options={['default', 'smile', 'angry']}
        onChange={vi.fn()}
        onPreview={onPreview}
      />,
    );
    openDropdown();

    fireEvent.mouseEnter(screen.getByRole('option', { name: 'smile' }));
    fireEvent.mouseEnter(screen.getByRole('option', { name: 'angry' }));

    expect(onPreview).not.toHaveBeenCalled();
  });

  it('does not preview while browsing with the keyboard', () => {
    const onPreview = vi.fn();
    render(
      <SearchableSelect
        value="default"
        options={['default', 'smile', 'angry']}
        onChange={vi.fn()}
        onPreview={onPreview}
      />,
    );
    openDropdown();

    const searchbox = screen.getByRole('searchbox', { name: '搜索选项' });
    fireEvent.keyDown(searchbox, { key: 'ArrowDown' });
    fireEvent.keyDown(searchbox, { key: 'ArrowDown' });
    fireEvent.keyDown(searchbox, { key: 'Home' });
    fireEvent.keyDown(searchbox, { key: 'End' });

    expect(onPreview).not.toHaveBeenCalled();
  });

  it('previews the row value when its play button is clicked', () => {
    const onPreview = vi.fn();
    render(
      <SearchableSelect
        value="default"
        options={['default', 'smile']}
        onChange={vi.fn()}
        onPreview={onPreview}
      />,
    );
    openDropdown();

    fireEvent.click(screen.getByRole('button', { name: '预览 smile' }));
    expect(onPreview).toHaveBeenCalledWith('smile');
  });

  it('restores the committed value via onPreview when the mouse leaves the options list', () => {
    const onPreview = vi.fn();
    render(
      <SearchableSelect
        value="default"
        options={['default', 'smile']}
        onChange={vi.fn()}
        onPreview={onPreview}
      />,
    );
    openDropdown();

    fireEvent.click(screen.getByRole('button', { name: '预览 smile' }));
    onPreview.mockClear();
    fireEvent.mouseLeave(screen.getByRole('listbox', { name: '可选项' }));

    expect(onPreview).toHaveBeenCalledWith('default');
  });

  it('does not restore on mouse leave when nothing was previewed', () => {
    const onPreview = vi.fn();
    render(
      <SearchableSelect
        value="default"
        options={['default', 'smile']}
        onChange={vi.fn()}
        onPreview={onPreview}
      />,
    );
    openDropdown();

    fireEvent.mouseEnter(screen.getByRole('option', { name: 'smile' }));
    fireEvent.mouseLeave(screen.getByRole('listbox', { name: '可选项' }));

    expect(onPreview).not.toHaveBeenCalled();
  });

  it('restores the committed value and closes when Escape is pressed', () => {
    const onPreview = vi.fn();
    render(
      <SearchableSelect
        value="default"
        options={['default', 'smile']}
        onChange={vi.fn()}
        onPreview={onPreview}
      />,
    );
    openDropdown();

    fireEvent.click(screen.getByRole('button', { name: '预览 smile' }));
    onPreview.mockClear();
    const combobox = screen.getByRole('combobox');
    fireEvent.keyDown(screen.getByRole('searchbox', { name: '搜索选项' }), { key: 'Escape' });

    expect(onPreview).toHaveBeenCalledWith('default');
    expect(combobox.getAttribute('aria-expanded')).toBe('false');
  });

  it('does not restore on Escape when nothing was previewed', () => {
    const onPreview = vi.fn();
    render(
      <SearchableSelect
        value="default"
        options={['default', 'smile']}
        onChange={vi.fn()}
        onPreview={onPreview}
      />,
    );
    openDropdown();

    fireEvent.keyDown(screen.getByRole('searchbox', { name: '搜索选项' }), { key: 'Escape' });

    expect(onPreview).not.toHaveBeenCalled();
  });

  it('does not restore on outside pointer down when the dropdown is closed', () => {
    const onPreview = vi.fn();
    render(
      <SearchableSelect
        value="default"
        options={['default', 'smile']}
        onChange={vi.fn()}
        onPreview={onPreview}
      />,
    );

    fireEvent.pointerDown(document.body);

    expect(onPreview).not.toHaveBeenCalled();
  });

  it('restores the committed value when the dropdown closes from an outside pointer down', () => {
    const onPreview = vi.fn();
    render(
      <SearchableSelect
        value="default"
        options={['default', 'smile']}
        onChange={vi.fn()}
        onPreview={onPreview}
      />,
    );
    openDropdown();

    fireEvent.click(screen.getByRole('button', { name: '预览 smile' }));
    onPreview.mockClear();
    fireEvent.pointerDown(document.body);

    expect(onPreview).toHaveBeenCalledWith('default');
    expect(screen.getByRole('combobox').getAttribute('aria-expanded')).toBe('false');
  });

  it('commits selection via onChange without triggering a preview', () => {
    const onChange = vi.fn();
    const onPreview = vi.fn();
    render(
      <SearchableSelect
        value="default"
        options={['default', 'smile', 'angry']}
        onChange={onChange}
        onPreview={onPreview}
      />,
    );
    openDropdown();

    fireEvent.mouseEnter(screen.getByRole('option', { name: 'smile' }));
    fireEvent.click(screen.getByRole('option', { name: 'angry' }));

    expect(onChange).toHaveBeenCalledWith('angry');
    expect(onPreview).not.toHaveBeenCalled();
  });

  it('restores an active preview when the component unmounts', () => {
    const onPreview = vi.fn();
    const { unmount } = render(
      <SearchableSelect
        value="default"
        options={['default', 'smile']}
        onChange={vi.fn()}
        onPreview={onPreview}
      />,
    );
    openDropdown();

    fireEvent.click(screen.getByRole('button', { name: '预览 smile' }));
    onPreview.mockClear();
    unmount();

    expect(onPreview).toHaveBeenCalledWith('default');
  });

  it('shows the full slash-prefixed motion/expression key instead of only the leaf name', () => {
    render(
      <SearchableSelect
        value="anon/angry04"
        options={['anon/angry04', 'anon/smile01']}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('combobox').textContent).toContain('anon/angry04');
    openDropdown();

    expect(screen.getByRole('option', { name: 'angry04' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'smile01' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'anon/angry04' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'anon/smile01' })).toBeNull();
  });

  it('supports unselecting via clear button on the trigger and empty option in dropdown', () => {
    const onChange = vi.fn();
    const onPreview = vi.fn();
    const { rerender } = render(
      <SearchableSelect
        label="动作名"
        value="idle"
        options={['idle', 'walk']}
        onChange={onChange}
        onPreview={onPreview}
        clearable
        clearLabel="（无动作）"
      />,
    );

    // 触发器上应有清除按钮
    const clearBtn = screen.getByRole('button', { name: '清除动作名' });
    expect(clearBtn).toBeTruthy();
    fireEvent.click(clearBtn);
    expect(onChange).toHaveBeenCalledWith('');

    // 下拉框中应有“（无动作）”选项，且该选项不含预览按钮
    openDropdown();
    const emptyOption = screen.getByRole('option', { name: '（无动作）' });
    expect(emptyOption).toBeTruthy();
    expect(screen.queryByRole('button', { name: '预览 （无动作）' })).toBeNull();

    // 点击（无动作）选项同样触发 onChange('')
    fireEvent.click(emptyOption);
    expect(onChange).toHaveBeenCalledWith('');

    // 当 value 为空时，（无动作）应标记为 aria-selected="true"，且触发器无清除按钮
    rerender(
      <SearchableSelect
        label="动作名"
        value=""
        options={['idle', 'walk']}
        onChange={onChange}
        clearable
        clearLabel="（无动作）"
      />,
    );
    expect(screen.queryByRole('button', { name: '清除动作名' })).toBeNull();
    openDropdown();
    expect(screen.getByRole('option', { name: '（无动作）' }).getAttribute('aria-selected')).toBe('true');
  });
});
