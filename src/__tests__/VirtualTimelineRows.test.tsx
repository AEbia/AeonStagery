/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { MeasuredTimelineRow, useVirtualTimelineRows } from '../ui/timeline/useVirtualTimelineRows';

const rows = Array.from({ length: 1000 }, (_, index) => ({
  id: `row-${index}`, measurementKey: `row-${index}`, estimatedHeight: 40,
}));
let observers: Map<Element, () => void>;
let animationFrames: Array<FrameRequestCallback>;

function List({ height = 40 }: { height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const virtual = useVirtualTimelineRows(ref, rows);
  return <div ref={ref} data-testid="viewport">
    <div data-testid="list" style={{ height: virtual.totalHeight }}>
      {virtual.indices.map((index) => <MeasuredTimelineRow key={rows[index].id}
        measurementKey={rows[index].measurementKey} top={virtual.offsets[index]} gap={0}
        measure={virtual.measure} onFocus={() => virtual.setFocusedId(rows[index].id)}
        onBlur={() => virtual.setFocusedId(null)}>
        <input aria-label={`Row ${index}`} data-height={height} />
      </MeasuredTimelineRow>)}
    </div>
  </div>;
}

function scrollTo(viewport: HTMLElement, top: number) {
  viewport.scrollTop = top;
  fireEvent.scroll(viewport);
  act(() => {
    const frames = animationFrames.splice(0);
    frames.forEach((callback) => callback(0));
  });
}

beforeEach(() => {
  observers = new Map();
  animationFrames = [];
  vi.stubGlobal('ResizeObserver', class {
    private elements: Element[] = [];
    constructor(private callback: () => void) {}
    observe(element: Element) { this.elements.push(element); observers.set(element, this.callback); }
    disconnect() { this.elements.forEach((element) => observers.delete(element)); }
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => animationFrames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { height: Number(this.querySelector('[data-height]')?.getAttribute('data-height') ?? 0) } as DOMRect;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('variable-height timeline virtualization', () => {
  it('bounds mounted rows and moves the visible window when scrolling', () => {
    const { container } = render(<List />);
    const viewport = screen.getByTestId('viewport');
    expect(container.querySelectorAll('[data-timeline-virtual-row]').length).toBeLessThan(20);
    scrollTo(viewport, 8000);
    expect(screen.getByRole('textbox', { name: 'Row 200' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Row 0' })).toBeNull();
    expect(container.querySelectorAll('[data-timeline-virtual-row]').length).toBeLessThan(20);
  });

  it('remeasures expanded rows and leaves no overlap with the following row', () => {
    const view = render(<List />);
    view.rerender(<List height={120} />);
    const first = screen.getByRole('textbox', { name: 'Row 0' }).closest('[data-timeline-virtual-row]') as HTMLElement;
    const second = screen.getByRole('textbox', { name: 'Row 1' }).closest('[data-timeline-virtual-row]') as HTMLElement;
    expect(first.style.top).toBe('0px');
    expect(second.style.top).toBe('120px');
  });

  it('keeps a focused draft mounted outside the visible window', () => {
    const { container } = render(<List />);
    const input = screen.getByRole('textbox', { name: 'Row 0' }) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Unsaved draft' } });
    scrollTo(screen.getByTestId('viewport'), 8000);
    expect(screen.getByRole('textbox', { name: 'Row 0' })).toBe(input);
    expect(input.value).toBe('Unsaved draft');
    expect(container.querySelectorAll('[data-timeline-virtual-row]').length).toBeLessThan(21);
    fireEvent.blur(input);
    expect(screen.queryByRole('textbox', { name: 'Row 0' })).toBeNull();
  });

  it('clears stale measurements when the container width changes', () => {
    render(<List height={120} />);
    const viewport = screen.getByTestId('viewport');
    scrollTo(viewport, 8000);
    const before = screen.getByTestId('list').style.height;
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 600 });
    act(() => observers.get(viewport)?.());
    // Visible rows are measured again; hidden rows return to estimates until mounted.
    expect(screen.getByTestId('list').style.height).not.toBe(before);
    expect(screen.getAllByRole('textbox').length).toBeLessThan(20);
  });
});
