/** @vitest-environment jsdom */
import { readStylesheet } from './helpers/readStylesheet';
import { render } from '@testing-library/react';
import { expect, it } from 'vitest';

it('lights up the statement and expanded details together immediately without a dividing border', () => {
  const css = readStylesheet('src/styles/timeline/list.css')
    .replaceAll('var(--accent-glow)', 'rgba(79, 70, 229, 0.15)')
    .replaceAll('var(--accent-primary)', 'rgb(79, 70, 229)')
    .replaceAll('var(--border-subtle)', 'rgb(40, 40, 40)')
    .replaceAll('var(--color-dialogue)', 'rgb(0, 170, 0)');
  const { container } = render(<>
    <style>{css}</style>
    <div className="timeline-item-container timeline-item-container--revealed">
      <div className="timeline-item timeline-item--dialogue timeline-item--expanded timeline-item--revealed">Statement</div>
      <div className="inspector-workspace__detail">Expanded settings</div>
    </div>
  </>);
  const header = container.querySelector('.timeline-item') as HTMLElement;
  const details = container.querySelector('.inspector-workspace__detail') as HTMLElement;
  for (const element of [header, details]) {
    const style = window.getComputedStyle(element);
    expect(style.backgroundColor).toBe('rgba(79, 70, 229, 0.15)');
    expect(style.borderLeftColor).toBe('rgb(79, 70, 229)');
    expect(style.transition).toBe('none');
  }
  expect(window.getComputedStyle(header).borderBottomColor).toBe('rgba(0, 0, 0, 0)');
  // Translucent highlight fills must meet, not overlap into a darker stripe.
  expect(window.getComputedStyle(header).borderBottomWidth).toBe('0px');
  expect(window.getComputedStyle(details).marginTop).toBe('0px');
  expect(window.getComputedStyle(details).borderTopStyle).toBe('none');
});
