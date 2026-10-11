import { parse, type Root, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';
import { readStylesheet } from './helpers/readStylesheet';

const list = parse(readStylesheet('src/styles/timeline/list.css'));
const inspector = parse(readStylesheet('src/ui/timeline/Inspector.css'));
const global = parse(readStylesheet('src/styles/index.css'));

function rules(root: Root, selector: string): Rule[] {
  const matches: Rule[] = [];
  root.walkRules(rule => {
    if (rule.selectors.includes(selector)) matches.push(rule);
  });
  return matches;
}

function declarations(rule: Rule | undefined): Record<string, string> {
  const values: Record<string, string> = {};
  rule?.walkDecls(declaration => { values[declaration.prop] = declaration.value; });
  return values;
}

function inQuery(root: Root, name: string, query: string, selector: string): Rule | undefined {
  return rules(root, selector).find(rule =>
    rule.parent?.type === 'atrule' && rule.parent.name === name && rule.parent.params === query,
  );
}

describe('Timeline stylesheet contracts', () => {
  it('loads shared shell and row styles before presentation overrides', () => {
    const selectors: string[] = [];
    global.walkRules(rule => { selectors.push(rule.selector); });
    const index = (selector: string) => {
      const position = selectors.indexOf(selector);
      expect(position, selector).toBeGreaterThanOrEqual(0);
      return position;
    };
    expect(index('.side-panel')).toBeLessThan(index('.left-panel'));
    expect(index('.left-panel')).toBeLessThan(index('.property-inspector-shell'));
    expect(index('.property-inspector-shell')).toBeLessThan(index('.timeline-toolbar'));
    expect(index('.timeline-item')).toBeLessThan(index('.timeline-item--authoring'));
    expect(index('.timeline-item--authoring')).toBeLessThan(index('.timeline-list-view--outline .timeline-item--compact'));
  });

  it('keeps quick resource fields usable and expanded dialogue text bounded', () => {
    expect(declarations(rules(list, '.timeline-item__quick-fields .timeline-item__inline-field--resource')[0]))
      .toMatchObject({ flex: '1 1 280px', 'min-width': 'min(100%, 240px)' });
    expect(declarations(rules(list, '.timeline-item__inline-field--resource > .timeline-item__inline-select')[0]))
      .toMatchObject({ flex: '1', width: '100%', 'max-width': '100%', 'min-width': '0' });
    expect(declarations(rules(list, '.timeline-item--expanded .timeline-item__quick-fields textarea.timeline-item__inline-input--text')[0]))
      .toMatchObject({
        'flex-basis': '100%',
        'min-height': 'calc(5 * 1.4em + 14px)',
        'max-height': 'calc(10 * 1.4em + 14px)',
        'overflow-y': 'auto',
      });
  });

  it('preserves responsive inspector columns and narrow property toolbar controls', () => {
    expect(declarations(inQuery(inspector, 'container', 'action-inspector (min-width: 720px)', '.inspector-property-sections')))
      .toMatchObject({ 'grid-template-columns': 'repeat(2, minmax(0, 1fr))' });
    expect(declarations(inQuery(inspector, 'container', 'action-inspector (min-width: 1120px)', '.inspector-property-sections:has(> .inspector-section:nth-child(3))')))
      .toMatchObject({ 'grid-template-columns': 'repeat(3, minmax(0, 1fr))' });
    for (const presentation of ['panel', 'inline']) {
      const selector = `.selected-action-inspector[data-presentation="${presentation}"] ${presentation === 'panel' ? '.inspector-row' : '.inspector-grid > .inspector-row'}`;
      expect(declarations(inQuery(inspector, 'container', 'action-inspector (max-width: 319px)', selector)))
        .toMatchObject({ 'grid-template-columns': 'minmax(0, 1fr)' });
    }
    expect(declarations(inQuery(global, 'container', 'property-inspector (max-width: 359px)', '.property-inspector-shell__tool-btn')))
      .toMatchObject({ width: '32px', 'min-height': '32px', padding: '0' });
    expect(declarations(inQuery(global, 'container', 'property-inspector (max-width: 359px)', '.property-inspector-shell__tool-btn > span')))
      .toMatchObject({ display: 'none' });
  });

  it('keeps reduced motion and low performance overrides for rows, details and left tabs', () => {
    for (const selector of ['.timeline-item', '.timeline-item-container .inspector-workspace__detail']) {
      expect(declarations(inQuery(list, 'media', '(prefers-reduced-motion: reduce)', selector)))
        .toMatchObject({ transition: 'none' });
      expect(declarations(rules(list, `[data-perf="low"] ${selector}`)[0]))
        .toMatchObject({ transition: 'none' });
    }
    for (const selector of ['.left-panel', '.left-panel__tab', '.left-panel__tabpanel', '.left-panel__empty-icon']) {
      expect(declarations(inQuery(global, 'media', '(prefers-reduced-motion: reduce)', selector)))
        .toMatchObject({ transition: 'none', animation: 'none' });
    }
    expect(declarations(rules(global, 'html[data-perf="low"] .left-panel')[0]))
      .toMatchObject({ 'backdrop-filter': 'none', transition: 'none' });
  });

  it.each(['dark', 'light'])('applies %s scrubbable theme overrides after the base controls', theme => {
    const selectors: string[] = [];
    inspector.walkRules(rule => { selectors.push(rule.selector); });
    const themed = `[data-theme="${theme}"] .scrubbable-popover`;
    expect(selectors.indexOf(themed)).toBeGreaterThan(selectors.indexOf('.scrubbable-popover'));
    expect(declarations(rules(inspector, themed)[0])).toHaveProperty('background');
  });
});
