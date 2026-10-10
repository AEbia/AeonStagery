/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Profiler, useRef } from 'react';
import { MeasuredTimelineRow, useVirtualTimelineRows } from '../ui/timeline/useVirtualTimelineRows';

const rows = Array.from({ length: 1000 }, (_, index) => ({
  id: `row-${index}`, measurementKey: `row-${index}`, estimatedHeight: 40,
}));
let observers: Map<Element, (entries?: ResizeObserverEntry[]) => void>;
let animationFrames: Array<FrameRequestCallback>;

function List({ height = 40, rowSizes = rows }: { height?: number; rowSizes?: typeof rows }) {
  const ref = useRef<HTMLDivElement>(null);
  const virtual = useVirtualTimelineRows(ref, rowSizes);
  return <div ref={ref} data-testid="viewport">
    <button onClick={() => virtual.revealRow('row-500')}>Reveal row 500</button>
    <div ref={virtual.contentRef} data-testid="list" style={{ height: virtual.totalHeight }}>
      {virtual.indices.map((index) => <MeasuredTimelineRow key={rowSizes[index].id}
        id={rowSizes[index].id} registerRow={virtual.registerRow}
        measurementKey={rowSizes[index].measurementKey} top={virtual.getOffset(index)} gap={0}
        measure={virtual.measure} onFocus={() => virtual.setFocusedId(rowSizes[index].id)}
        onBlur={() => virtual.setFocusedId(null)}>
        <input aria-label={`Row ${index}`} data-height={height} />
      </MeasuredTimelineRow>)}
    </div>
  </div>;
}

function flushFrames() {
  act(() => { animationFrames.splice(0).forEach((callback) => callback(0)); });
}

function scrollTo(viewport: HTMLElement, top: number) {
  viewport.scrollTop = top;
  fireEvent.scroll(viewport);
  act(() => {
    const frames = animationFrames.splice(0);
    frames.forEach((callback) => callback(0));
  });
}

function notifyRowResizes(container: HTMLElement) {
  act(() => {
    container.querySelectorAll('[data-timeline-virtual-row]').forEach((row) => observers.get(row)?.());
  });
  flushFrames();
}

beforeEach(() => {
  observers = new Map();
  animationFrames = [];
  vi.stubGlobal('ResizeObserver', class {
    private elements: Element[] = [];
    constructor(private callback: ResizeObserverCallback) {}
    observe(element: Element) {
      this.elements.push(element);
      observers.set(element, (entries = []) => this.callback(entries, this as unknown as ResizeObserver));
    }
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
  it('uses delivered border-box sizes without forcing another row geometry read', () => {
    render(<List />);
    const first = screen.getByRole('textbox', { name: 'Row 0' }).closest('[data-timeline-virtual-row]')!;
    const geometry = vi.spyOn(first, 'getBoundingClientRect');
    geometry.mockClear();
    act(() => observers.get(first)?.([{
      target: first, borderBoxSize: [{ blockSize: 120, inlineSize: 500 }],
    } as unknown as ResizeObserverEntry]));
    flushFrames();
    expect(geometry).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox', { name: 'Row 1' })
      .closest('[data-timeline-virtual-row]') as HTMLElement).style.top).toBe('120px');
  });

  it('coalesces separate resize deliveries into one layout commit with the latest height', () => {
    const commits = vi.fn();
    render(<Profiler id="list" onRender={commits}><List /></Profiler>);
    const first = screen.getByRole('textbox', { name: 'Row 0' }).closest('[data-timeline-virtual-row]')!;
    commits.mockClear();
    for (const height of [60, 100, 120]) {
      act(() => observers.get(first)?.([{
        target: first, borderBoxSize: [{ blockSize: height, inlineSize: 500 }],
      } as unknown as ResizeObserverEntry]));
    }
    expect(commits).not.toHaveBeenCalled();
    expect(animationFrames).toHaveLength(1);
    // Neighbor geometry is current before the deferred React commit.
    expect((screen.getByRole('textbox', { name: 'Row 1' })
      .closest('[data-timeline-virtual-row]') as HTMLElement).style.top).toBe('120px');
    flushFrames();
    expect(commits).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('textbox', { name: 'Row 1' })
      .closest('[data-timeline-virtual-row]') as HTMLElement).style.top).toBe('120px');
  });

  it('does not rescan all row measurement keys on an animation size update', () => {
    let keyReads = 0;
    const rowSizes = rows.map((row) => ({ ...row, get measurementKey() { keyReads++; return row.measurementKey; } }));
    render(<List rowSizes={rowSizes} />);
    const first = screen.getByRole('textbox', { name: 'Row 0' }).closest('[data-timeline-virtual-row]')!;
    keyReads = 0;
    first.querySelector('[data-height]')!.setAttribute('data-height', '120');
    act(() => observers.get(first)?.([{
      target: first, borderBoxSize: [{ blockSize: 120, inlineSize: 500 }],
    } as unknown as ResizeObserverEntry]));
    flushFrames();
    expect(keyReads).toBeLessThan(50);
    expect((screen.getByRole('textbox', { name: 'Row 1' })
      .closest('[data-timeline-virtual-row]') as HTMLElement).style.top).toBe('120px');
  });
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
    notifyRowResizes(view.container);
    const first = screen.getByRole('textbox', { name: 'Row 0' }).closest('[data-timeline-virtual-row]') as HTMLElement;
    const second = screen.getByRole('textbox', { name: 'Row 1' }).closest('[data-timeline-virtual-row]') as HTMLElement;
    expect(first.style.top).toBe('0px');
    expect(second.style.top).toBe('120px');
  });

  it('does not recurse through synchronous updates while a row height is animating', () => {
    let reads = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const isAnimatingRow = this.querySelector('[aria-label="Row 0"]') !== null;
      return { height: isAnimatingRow ? 40 + Math.min(++reads, 8000) / 100 : 40 } as DOMRect;
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => render(<List />)).not.toThrow();
    expect(reads).toBeLessThan(50);

    // A real size notification still updates the layout to the final height.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { height: this.querySelector('[aria-label="Row 0"]') ? 120 : 40 } as DOMRect;
    });
    notifyRowResizes(screen.getByTestId('list'));
    const second = screen.getByRole('textbox', { name: 'Row 1' })
      .closest('[data-timeline-virtual-row]') as HTMLElement;
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

  it.each(['rows-first', 'container-first', 'container-only'])(
    'retains mounted row geometry on a width change with %s notifications', (order) => {
      render(<List height={120} />);
      const viewport = screen.getByTestId('viewport');
      const firstInput = screen.getByRole('textbox', { name: 'Row 0' });
      const second = screen.getByRole('textbox', { name: 'Row 1' })
        .closest('[data-timeline-virtual-row]') as HTMLElement;
      expect(second.style.top).toBe('120px');

      const notifyContainer = observers.get(viewport)!;
      const notifyRows = [...observers.entries()]
        .filter(([element]) => element.hasAttribute('data-timeline-virtual-row'))
        .map(([, notify]) => notify);
      Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 600 });
      act(() => {
        if (order === 'rows-first') notifyRows.forEach((notify) => notify());
        notifyContainer();
        if (order === 'container-first') notifyRows.forEach((notify) => notify());
      });

      expect(second.style.top).toBe('120px');
      expect(screen.getByRole('textbox', { name: 'Row 0' })).toBe(firstInput);
    },
  );

  it.each([10, 200])('reveals an unmounted row after neighbors measure %i px, without a scroll event', (height) => {
    const view = render(<List height={height} />);
    const viewport = screen.getByTestId('viewport');
    expect(screen.queryByRole('textbox', { name: 'Row 500' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Reveal row 500' }));

    const row = screen.getByRole('textbox', { name: 'Row 500' })
      .closest('[data-timeline-virtual-row]') as HTMLElement;
    const top = Number.parseFloat(row.style.top);
    expect(top).toBeGreaterThanOrEqual(viewport.scrollTop);
    expect(top).toBeLessThan(viewport.scrollTop + 400);

    scrollTo(viewport, 8000);
    view.rerender(<List height={height + 1} />);
    notifyRowResizes(view.container);
    expect(viewport.scrollTop).toBe(8000);
  });

  it('keeps the destination visible when an earlier row finishes collapsing after the jump', () => {
    render(<List height={200} />);
    const viewport = screen.getByTestId('viewport');
    fireEvent.click(screen.getByRole('button', { name: 'Reveal row 500' }));
    const previous = screen.getByRole('textbox', { name: 'Row 499' })
      .closest('[data-timeline-virtual-row]') as HTMLElement;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { height: this === previous ? 20 : 200 } as DOMRect;
    });

    act(() => observers.get(previous)?.());
    flushFrames();

    const destination = screen.getByRole('textbox', { name: 'Row 500' })
      .closest('[data-timeline-virtual-row]') as HTMLElement;
    expect(Number.parseFloat(destination.style.top)).toBe(viewport.scrollTop);

    const alignedTop = viewport.scrollTop;
    fireEvent.wheel(viewport, { deltaY: -100 });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { height: this === previous ? 10 : 200 } as DOMRect;
    });
    act(() => observers.get(previous)?.());
    flushFrames();
    expect(viewport.scrollTop).toBe(alignedTop);
  });
});
