/** @vitest-environment jsdom */
import { render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InlineStatementDetails } from '../ui/timeline/InlineStatementDetails';

let animations: { cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null }[];

beforeEach(() => {
  animations = [];
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: vi.fn(() => {
    const animation = { cancel: vi.fn(), onfinish: null };
    animations.push(animation);
    return animation;
  }) });
});
afterEach(() => {
  delete (HTMLElement.prototype as any).animate;
  vi.unstubAllGlobals();
});

it('remembers an instant opening when closing returns to the default motion policy', () => {
  const view = render(<InlineStatementDetails expanded={false}>Settings</InlineStatementDetails>);
  view.rerender(<InlineStatementDetails expanded animateExpansion={false}>Settings</InlineStatementDetails>);
  view.rerender(<InlineStatementDetails expanded={false}>Settings</InlineStatementDetails>);
  expect(animations).toHaveLength(0);
  expect(view.container.querySelector('.inspector-workspace__detail')).toBeNull();
});

it('removes a closing inspector when its animation is disabled mid-exit', () => {
  const view = render(<InlineStatementDetails expanded>Settings</InlineStatementDetails>);
  view.rerender(<InlineStatementDetails expanded={false}>Settings</InlineStatementDetails>);
  expect(animations).toHaveLength(1);
  expect(view.container.querySelector('.inspector-workspace__detail')).toBeTruthy();
  view.rerender(<InlineStatementDetails expanded={false} animateExpansion={false}>Settings</InlineStatementDetails>);
  expect(animations[0].cancel).toHaveBeenCalledOnce();
  expect(animations[0].onfinish).toBeNull();
  expect(view.container.querySelector('.inspector-workspace__detail')).toBeNull();
});
