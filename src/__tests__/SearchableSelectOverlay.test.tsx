/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchableSelect } from '../ui/SearchableSelect';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderPicker(top = 100, left = 40, width = 300) {
  vi.stubGlobal('innerWidth', 800);
  vi.stubGlobal('innerHeight', 600);
  const onChange = vi.fn();
  const onPreview = vi.fn();
  const view = render(
    <div style={{ overflow: 'auto', position: 'relative', zIndex: 2 }}>
      <SearchableSelect value="idle" options={['idle', 'wave']} onChange={onChange} onPreview={onPreview} />
    </div>,
  );
  const trigger = screen.getByRole('combobox');
  const bounds = vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(left, top, width, 32));
  fireEvent.click(trigger);
  const overlay = screen.getByRole('searchbox').closest<HTMLElement>('.searchable-select-overlay')!;
  return { ...view, overlay, bounds, onChange, onPreview };
}

describe('SearchableSelect overlay', () => {
  it('escapes a clipping stacking context while preserving pointer selection and preview', () => {
    const { container, overlay, onChange, onPreview } = renderPicker();
    expect(overlay.parentElement).toBe(document.body);
    expect(container.contains(overlay)).toBe(false);
    expect(overlay.style.position).toBe('fixed');
    expect(overlay.style.top).toBe('134px');
    expect(overlay.style.left).toBe('40px');
    expect(overlay.style.width).toBe('300px');

    fireEvent.pointerDown(screen.getByRole('searchbox'));
    expect(screen.getByRole('searchbox')).toBeTruthy();
    const preview = screen.getByRole('button', { name: '预览 wave' });
    fireEvent.pointerDown(preview);
    fireEvent.click(preview);
    expect(onPreview).toHaveBeenLastCalledWith('wave');
    const option = screen.getByRole('option', { name: 'wave' });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith('wave');
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(onPreview).toHaveBeenCalledTimes(1);
  });

  it('opens above near the bottom edge and follows scrolling and resizing', () => {
    const { overlay, bounds } = renderPicker(520, 720);
    expect(overlay.style.top).toBe('');
    expect(overlay.style.bottom).toBe('82px');
    expect(overlay.style.left).toBe('492px');
    expect(overlay.style.height).toBe('360px');

    bounds.mockReturnValue(new DOMRect(50, 90, 280, 32));
    fireEvent.scroll(window);
    expect(overlay.style.top).toBe('124px');
    expect(overlay.style.bottom).toBe('');
    expect(overlay.style.left).toBe('50px');
    expect(overlay.style.width).toBe('280px');

    vi.stubGlobal('innerHeight', 300);
    fireEvent.resize(window);
    expect(overlay.style.height).toBe('168px');
  });

  it('closes on an outside pointer event without issuing another preview', () => {
    const { onPreview } = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: '预览 wave' }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(onPreview.mock.calls).toEqual([['wave']]);
  });
});
