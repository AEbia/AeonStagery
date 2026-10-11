/** @vitest-environment jsdom */
import { setupInlineDetailsFixture, list } from './fixtures/timelineInlineDetails';
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

setupInlineDetailsFixture();

function sizingFixture() {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const observers = new Map<Element, ResizeObserverCallback>();
  vi.stubGlobal('ResizeObserver', class {
    private elements: Element[] = [];
    constructor(private callback: ResizeObserverCallback) {}
    observe(element: Element) { this.elements.push(element); observers.set(element, this.callback); }
    disconnect() { this.elements.forEach((element) => observers.delete(element)); }
  });
  list();
  const text = screen.getByRole('textbox', { name: '编辑台词内容' }) as HTMLTextAreaElement;
  let lineHeight = 20;
  const originalStyle = window.getComputedStyle;
  const styles = vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => element === text
    ? { lineHeight: String(lineHeight), fontSize: '16', paddingTop: '4', paddingBottom: '4',
      borderTopWidth: '1', borderBottomWidth: '1' } as CSSStyleDeclaration
    : originalStyle(element, pseudo));
  Object.defineProperty(text, 'scrollHeight', { configurable: true, get: () => text.value.length > 30 ? 260 : 80 });
  fireEvent.mouseDown(text);
  act(() => text.focus());
  fireEvent.click(screen.getByRole('button', { name: '展开详情' }));
  styles.mockClear();
  return {
    text, frames, styles,
    setLineHeight: (height: number) => { lineHeight = height; },
    notifyWidth: () => act(() => observers.get(text)?.([{
      target: text, borderBoxSize: [{ inlineSize: 600, blockSize: 110 }],
    } as unknown as ResizeObserverEntry], {} as ResizeObserver)),
    flush: () => act(() => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    }),
  };
}

describe('expanded dialogue textarea sizing', () => {
  it('coalesces input sizing, reuses typography metrics and retains the ten-line limit', () => {
    const { text, frames, styles, flush } = sizingFixture();
    expect(text.style.height).toBe('110px');
    fireEvent.change(text, { target: { value: 'x'.repeat(40) } });
    fireEvent.change(text, { target: { value: 'x'.repeat(50) } });
    fireEvent.change(text, { target: { value: 'x'.repeat(60) } });
    expect(text.style.height).toBe('110px');
    expect(frames.size).toBe(1);
    expect(text.value).toBe('x'.repeat(60));
    expect(styles.mock.calls.filter(([element]) => element === text)).toHaveLength(0);
    flush();
    expect(text.style.height).toBe('210px');
    expect(styles.mock.calls.filter(([element]) => element === text)).toHaveLength(0);
  });

  it('preserves a manual minimum and cancels pending sizing when collapsed', () => {
    const { text, flush } = sizingFixture();
    text.style.height = '180px';
    fireEvent.change(text, { target: { value: 'short' } });
    flush();
    expect(text.style.height).toBe('180px');
    fireEvent.change(text, { target: { value: 'x'.repeat(60) } });
    fireEvent.click(screen.getByRole('button', { name: '折叠详情' }));
    expect(text.style.height).toBe('');
    flush();
    expect(text.style.height).toBe('');
    expect(text.rows).toBe(2);
  });

  it('invalidates typography metrics when resizing the text field', () => {
    const { text, styles, setLineHeight, notifyWidth, flush } = sizingFixture();
    setLineHeight(28);
    notifyWidth();
    flush();
    expect(styles.mock.calls.filter(([element]) => element === text)).toHaveLength(1);
    expect(text.style.height).toBe('150px');
  });

  it('invalidates typography metrics on a theme change even at a fixed width', async () => {
    const { text, styles, setLineHeight, flush } = sizingFixture();
    setLineHeight(28);
    try {
      await act(async () => { document.documentElement.dataset.timelineSizingTest = 'changed'; });
      flush();
      expect(styles.mock.calls.filter(([element]) => element === text)).toHaveLength(1);
      expect(text.style.height).toBe('150px');
    } finally {
      await act(async () => { delete document.documentElement.dataset.timelineSizingTest; });
      flush();
    }
  });
});
