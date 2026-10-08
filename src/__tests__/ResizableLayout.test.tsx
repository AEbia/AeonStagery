/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useResizableLayout } from '../ui/hooks/useResizableLayout';

function Layout({ onCommit }: { onCommit: (width: number) => void }) {
  const layout = useResizableLayout({ initialLeftPanelWidth: 340, onLeftPanelWidthCommit: onCommit });
  return <div role="separator" tabIndex={0} aria-valuenow={layout.leftPanelWidth}
    onMouseDown={layout.handleLeftResizeMouseDown} onKeyDown={layout.handleLeftResizeKeyDown} />;
}

describe('left panel resize lifecycle', () => {
  it('commits once at mouseup using the final clamped width', () => {
    const commit = vi.fn();
    render(<Layout onCommit={commit} />);
    const handle = screen.getByRole('separator');
    fireEvent.mouseDown(handle, { clientX: 340 });
    fireEvent.mouseMove(window, { clientX: 400 });
    fireEvent.mouseMove(window, { clientX: 600 });
    expect(handle.getAttribute('aria-valuenow')).toBe('420');
    expect(commit).not.toHaveBeenCalled();
    fireEvent.mouseUp(window);
    expect(commit).toHaveBeenCalledExactlyOnceWith(420);
    fireEvent.mouseUp(window);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(document.body.hasAttribute('data-resizing')).toBe(false);
  });

  it('preserves keyboard resizing and clamping', () => {
    const commit = vi.fn();
    render(<Layout onCommit={commit} />);
    const handle = screen.getByRole('separator');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(commit).toHaveBeenLastCalledWith(350);
    fireEvent.keyDown(handle, { key: 'Home' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle.getAttribute('aria-valuenow')).toBe('320');
    fireEvent.keyDown(handle, { key: 'End' });
    expect(handle.getAttribute('aria-valuenow')).toBe('420');
  });

  it('removes listeners and resets the cursor when unmounted during a drag', () => {
    const commit = vi.fn();
    const view = render(<Layout onCommit={commit} />);
    fireEvent.mouseDown(screen.getByRole('separator'), { clientX: 340 });
    view.unmount();
    fireEvent.mouseMove(window, { clientX: 400 });
    fireEvent.mouseUp(window);
    expect(commit).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe('default');
    expect(document.body.hasAttribute('data-resizing')).toBe(false);
  });
});
