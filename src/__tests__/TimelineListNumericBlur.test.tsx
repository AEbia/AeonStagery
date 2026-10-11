/** @vitest-environment jsdom */
import { setupInlineDetailsFixture, state, load, list } from './fixtures/timelineInlineDetails';
import { act, createEvent, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

setupInlineDetailsFixture();

describe('List numeric draft blur', () => {
  it.each(['blank space', 'expand button'])('commits a typed value and leaves edit mode when clicking %s in its row', (target) => {
    load('camera', { mode: 'shake', intensity: 0.4, durationSeconds: 1 });
    const { container } = list();
    const intensity = screen.getByRole('spinbutton', { name: '震动强度' });
    fireEvent.mouseDown(intensity, { button: 0 });
    fireEvent.mouseUp(document);
    const input = screen.getByRole('spinbutton', { name: '震动强度' }) as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: '2.5' } });
    expect(state.author).not.toHaveBeenCalled();

    const surface = target === 'blank space'
      ? container.querySelector('.timeline-item__quick-fields') as HTMLElement
      : screen.getByRole('button', { name: '展开详情' });
    const mouseDown = createEvent.mouseDown(surface, { button: 0 });
    fireEvent(surface, mouseDown);
    // jsdom does not perform the browser's default blur on a blank-space press.
    if (!mouseDown.defaultPrevented) act(() => input.blur());
    fireEvent.click(surface);

    expect(mouseDown.defaultPrevented).toBe(false);
    expect(state.author).toHaveBeenCalledTimes(1);
    expect(state.author).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'update-statement',
      patch: { params: { mode: 'shake', intensity: 2.5, durationSeconds: 1 } },
    }));
    expect(document.activeElement).not.toBe(input);
    expect(container.querySelector('input.scrubbable-input-mode')).toBeNull();
  });
});
