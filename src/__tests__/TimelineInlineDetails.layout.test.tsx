/** @vitest-environment jsdom */
import { setupInlineDetailsFixture, list, expand } from './fixtures/timelineInlineDetails';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { readStylesheet } from './helpers/readStylesheet';
import { InlineStatementDetails } from '../ui/timeline/InlineStatementDetails';

setupInlineDetailsFixture();

describe('Inline details layout', () => {
  it('grows from five to ten lines, retains a manual height and resets on collapse', () => {
    list();
    const text = screen.getByRole('textbox', { name: '编辑台词内容' }) as HTMLTextAreaElement;
    // jsdom has no text layout; model the native metrics consumed by autosizing.
    text.style.lineHeight = '20px';
    text.style.padding = '6px 8px';
    text.style.border = '1px solid';
    Object.defineProperty(text, 'scrollHeight', { configurable: true, get: () => text.value.split('\n').length * 20 + 12 });
    fireEvent.click(screen.getByRole('button', { name: '展开详情' }));
    expect(text.style.height).toBe('114px');
    fireEvent.mouseDown(text);
    fireEvent.focus(text);
    fireEvent.change(text, { target: { value: Array(8).fill('台词').join('\n') } });
    expect(text.style.height).toBe('174px');
    fireEvent.change(text, { target: { value: Array(15).fill('台词').join('\n') } });
    expect(text.style.height).toBe('214px');
    text.style.height = '194px';
    fireEvent.change(text, { target: { value: '较短的台词' } });
    expect(text.style.height).toBe('194px');
    fireEvent.click(screen.getByRole('button', { name: '折叠详情' }));
    expect(text.style.height).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '展开详情' }));
    expect(text.style.height).toBe('114px');
  });

  it('holds the collapsed animation frame until React removes the detail element', async () => {
    let exit: { cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null } | undefined;
    const exposedFrames: boolean[] = [];
    const animate = vi.fn(function (this: HTMLElement) {
      const element = this;
      exit = {
        cancel: vi.fn(() => exposedFrames.push(element.isConnected)),
        onfinish: null,
      };
      return exit;
    });
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    try {
      const view = render(<InlineStatementDetails expanded>Settings</InlineStatementDetails>);
      view.rerender(<InlineStatementDetails expanded={false}>Settings</InlineStatementDetails>);
      const closing = view.container.querySelector('.inspector-workspace__detail');
      expect(closing?.isConnected).toBe(true);
      // A native animation callback runs before React commits its queued removal.
      await act(async () => {
        exit!.onfinish?.();
        expect(exposedFrames).not.toContain(true);
      });
      expect(closing?.isConnected).toBe(false);
      expect(exit!.cancel).toHaveBeenCalled();
    } finally { delete (HTMLElement.prototype as any).animate; }
  });

  it('animates opening and retains closing content until exit finishes, skipping expanded remounts', () => {
    const animations: { cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null }[] = [];
    const animate = vi.fn(() => {
      const animation = { cancel: vi.fn(), onfinish: null as (() => void) | null };
      animations.push(animation);
      return animation;
    });
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    try {
      const view = render(<InlineStatementDetails expanded={false}>Settings</InlineStatementDetails>);
      view.rerender(<InlineStatementDetails expanded>Settings</InlineStatementDetails>);
      expect(animate).toHaveBeenCalledTimes(1);
      view.rerender(<InlineStatementDetails expanded>Updated settings</InlineStatementDetails>);
      expect(animate).toHaveBeenCalledTimes(1);
      view.rerender(<InlineStatementDetails expanded={false}>Settings</InlineStatementDetails>);
      expect(animations[0].cancel).toHaveBeenCalledTimes(1);
      expect(animate).toHaveBeenCalledTimes(2);
      const closing = view.container.querySelector('.inspector-workspace__detail');
      expect(closing?.textContent).toBe('Settings');
      expect(closing?.getAttribute('aria-hidden')).toBe('true');
      expect(closing?.hasAttribute('inert')).toBe(true);
      act(() => animations[1].onfinish?.());
      expect(view.container.querySelector('.inspector-workspace__detail')).toBeNull();
      view.unmount();
      render(<InlineStatementDetails expanded>Remounted virtual row</InlineStatementDetails>);
      expect(animate).toHaveBeenCalledTimes(2);
    } finally { delete (HTMLElement.prototype as any).animate; }
  });

  it('cancels a pending exit when details reopen and keeps the inspector mounted during exit', () => {
    const animations: { cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null }[] = [];
    const animate = vi.fn(() => {
      const animation = { cancel: vi.fn(), onfinish: null as (() => void) | null };
      animations.push(animation);
      return animation;
    });
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    try {
      const { container } = list();
      expand(container);
      fireEvent.click(screen.getByRole('button', { name: '折叠详情' }));
      const closing = container.querySelector('.inspector-workspace__detail');
      expect(closing?.textContent).toContain('语音文件');
      const exit = animations[1];
      fireEvent.click(screen.getByRole('button', { name: '展开详情' }));
      expect(exit.cancel).toHaveBeenCalled();
      expect(exit.onfinish).toBeNull();
      expect(container.querySelector('.inspector-workspace__detail')).toBe(closing);
      expect(closing?.getAttribute('aria-hidden')).toBe('false');
      expect(closing?.hasAttribute('inert')).toBe(false);
    } finally { delete (HTMLElement.prototype as any).animate; }
  });

  it.each(['reduced-motion', 'low-performance'])('skips animation for %s', (mode) => {
    const animate = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    if (mode === 'reduced-motion') vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const content = (expanded: boolean) => <div data-perf={mode === 'low-performance' ? 'low' : 'high'}>
      <InlineStatementDetails expanded={expanded}>Settings</InlineStatementDetails>
    </div>;
    try {
      const view = render(content(false));
      view.rerender(content(true));
      view.rerender(content(false));
      expect(animate).not.toHaveBeenCalled();
      expect(view.container.querySelector('.inspector-workspace__detail')).toBeNull();
    } finally { delete (HTMLElement.prototype as any).animate; }
  });

  it('extends the statement decorative color strip down the expanded detail panel seamlessly with unified hover', () => {
    const listCss = readStylesheet('src/styles/timeline/list.css')
      // jsdom has no browser hover state; use an attribute to exercise the same rules.
      .replaceAll(':hover', '[data-test-hover]')
      .replaceAll('var(--color-dialogue)', 'rgb(0, 170, 0)')
      .replaceAll('var(--accent-primary)', 'rgb(79, 70, 229)')
      .replaceAll('var(--accent-glow)', 'rgba(79, 70, 229, 0.15)')
      .replaceAll('var(--border-subtle)', 'rgb(40, 40, 40)')
      .replaceAll('var(--border-highlight)', 'rgb(100, 100, 100)');

    const { container } = list();
    expand(container);
    const item = container.querySelector('.timeline-item') as HTMLElement;
    const detail = container.querySelector('.inspector-workspace__detail') as HTMLElement;
    const style = document.createElement('style');
    style.textContent = listCss;
    container.prepend(style);
    expect(item.classList.contains('timeline-item--dialogue')).toBe(true);
    expect(detail).toBeTruthy();
    expect(item.nextElementSibling).toBe(detail);
    for (const element of [item, detail]) {
      expect(window.getComputedStyle(element).borderLeftWidth).toBe('3px');
      expect(window.getComputedStyle(element).borderLeftColor).toBe('rgb(0, 170, 0)');
    }
    expect(window.getComputedStyle(item).borderBottomWidth).toBe('0px');
    expect(window.getComputedStyle(detail).marginTop).toBe('0px');

    item.parentElement!.setAttribute('data-test-hover', '');
    for (const element of [item, detail]) {
      expect(window.getComputedStyle(element).borderRightColor).toBe('rgb(100, 100, 100)');
    }

    // Pointer down on statement row applies data-pressed to row, matching the unified accent feedback rule
    fireEvent.pointerDown(item, { button: 0 });
    expect(item.dataset.pressed).toBe('true');
    for (const element of [item, detail]) {
      const computed = window.getComputedStyle(element);
      expect(computed.backgroundColor).toBe('rgba(79, 70, 229, 0.15)');
      expect(computed.borderRightColor).toBe('rgb(79, 70, 229)');
    }
    fireEvent.pointerUp(item);
    expect(item.dataset.pressed).toBeUndefined();
    for (const element of [item, detail]) {
      expect(window.getComputedStyle(element).borderRightColor).toBe('rgb(100, 100, 100)');
    }
  });
});
