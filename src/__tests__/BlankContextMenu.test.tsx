/**
 * @vitest-environment jsdom
 */
import type { MouseEvent as ReactMouseEvent } from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlankContextMenu } from '../ui/timeline/BlankContextMenu';
import { useBlankContextMenu } from '../ui/timeline/useBlankContextMenu';

describe('blank timeline context menu', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('infers a character track from the pointer position when the target is not the row', () => {
    const area = document.createElement('div');
    const target = document.createElement('div');
    area.appendChild(target);
    document.body.appendChild(area);
    vi.spyOn(area, 'getBoundingClientRect').mockReturnValue({
      left: 20,
      right: 1020,
      top: 0,
      bottom: 600,
      width: 1000,
      height: 600,
      x: 20,
      y: 0,
      toJSON: () => ({}),
    });

    const characterTrack = document.createElement('div');
    characterTrack.dataset.trackId = 'char:anon';
    characterTrack.dataset.trackLabel = 'Anon';
    vi.spyOn(characterTrack, 'getBoundingClientRect').mockReturnValue({
      left: 20,
      right: 1020,
      top: 100,
      bottom: 140,
      width: 1000,
      height: 40,
      x: 20,
      y: 100,
      toJSON: () => ({}),
    });

    const { result } = renderHook(() => useBlankContextMenu({
      areaRef: { current: area },
      trackRefs: { current: new Map([['char:anon', characterTrack]]) },
      pps: 10,
    }));
    const preventDefault = vi.fn();

    act(() => {
      result.current.handleContextMenu({
        target,
        clientX: 220,
        clientY: 120,
        preventDefault,
      } as unknown as ReactMouseEvent<HTMLDivElement>);
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(result.current.blankMenu).toMatchObject({
      time: 10,
      charId: 'anon',
      charLabel: 'Anon',
    });
  });

  it('changes categories only after an explicit click', () => {
    render(
      <BlankContextMenu
        menu={{ x: 20, y: 20, time: 2, charId: null, charLabel: null }}
        hasCopyBuffer={false}
        onPaste={vi.fn()}
        onSelectAction={vi.fn()}
      />,
    );

    const allTab = screen.getByRole('tab', { name: '全部' });
    const cameraTab = screen.getByRole('tab', { name: '镜头' });
    expect(allTab.getAttribute('aria-selected')).toBe('true');

    fireEvent.mouseEnter(cameraTab);
    expect(allTab.getAttribute('aria-selected')).toBe('true');
    expect(cameraTab.getAttribute('aria-selected')).toBe('false');

    fireEvent.click(cameraTab);
    expect(allTab.getAttribute('aria-selected')).toBe('false');
    expect(cameraTab.getAttribute('aria-selected')).toBe('true');
  });

  it('exposes keyboard-reachable left and right navigation controls for overflowing tabs', () => {
    render(
      <BlankContextMenu
        menu={{ x: 20, y: 20, time: 2, charId: null, charLabel: null }}
        hasCopyBuffer={false}
        onPaste={vi.fn()}
        onSelectAction={vi.fn()}
      />,
    );

    const categories = document.querySelector<HTMLElement>('.track-blank-menu__categories')!;
    Object.defineProperty(categories, 'clientWidth', { configurable: true, value: 100 });
    Object.defineProperty(categories, 'scrollWidth', { configurable: true, value: 400 });
    fireEvent.scroll(categories);

    const left = screen.getByRole('button', { name: '向左滚动语句类型' });
    const right = screen.getByRole('button', { name: '向右滚动语句类型' });
    expect(left.hasAttribute('disabled')).toBe(true);
    expect(right.hasAttribute('disabled')).toBe(false);

    fireEvent.click(right);
    expect(categories.scrollLeft).toBe(80);
    expect(left.hasAttribute('disabled')).toBe(false);

    fireEvent.click(left);
    expect(categories.scrollLeft).toBe(0);
  });

  it('inserts resource statements without requiring a prior resource selection', () => {
    const onSelectAction = vi.fn();
    render(
      <BlankContextMenu
        menu={{ x: 20, y: 20, time: 2, charId: null, charLabel: null }}
        hasCopyBuffer={false}
        onPaste={vi.fn()}
        onSelectAction={onSelectAction}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /放入环境画面/ }));

    expect(onSelectAction).toHaveBeenCalledWith('statement', { blockId: 'environment.set-background' });
  });

  it('inserts dialogue from the global track context without a character binding', () => {
    const onSelectAction = vi.fn();
    render(
      <BlankContextMenu
        menu={{ x: 20, y: 20, time: 2, charId: null, charLabel: null }}
        hasCopyBuffer={false}
        onPaste={vi.fn()}
        onSelectAction={onSelectAction}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '对话' }));

    expect(onSelectAction).toHaveBeenCalledWith('statement', { blockId: 'dialogue.basic' });
  });

  it('displays 组合母版 tab correctly and positions it immediately after 角色', () => {
    render(
      <BlankContextMenu
        menu={{ x: 20, y: 20, time: 2, charId: null, charLabel: null }}
        hasCopyBuffer={false}
        onPaste={vi.fn()}
        onSelectAction={vi.fn()}
      />,
    );

    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent?.trim());
    expect(tabs).toContain('组合母版');
    expect(tabs).not.toContain('组合');

    const characterIndex = tabs.indexOf('角色');
    const templateIndex = tabs.indexOf('组合母版');
    expect(characterIndex).toBeGreaterThan(-1);
    expect(templateIndex).toBe(characterIndex + 1);
  });

  it('renders 组合母版 section correctly titled and positioned after 角色 in all view', () => {
    const mockTemplates: any[] = [
      {
        id: 'test-combo-1',
        name: '测试组合母版1',
        payload: {
          kind: 'timelineFragment',
          statements: [
            { type: 'characterPresence', params: {} },
            { type: 'camera', params: {} },
          ],
        },
      },
    ];

    render(
      <BlankContextMenu
        menu={{ x: 20, y: 20, time: 2, charId: null, charLabel: null }}
        hasCopyBuffer={false}
        templates={mockTemplates}
        onPaste={vi.fn()}
        onSelectAction={vi.fn()}
      />,
    );

    expect(screen.getAllByText('组合母版').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('组合母板')).toBeNull();

    const titles = Array.from(document.querySelectorAll('.statement-block-library__section-title'))
      .map((el) => el.textContent?.trim());

    const characterSectionIndex = titles.indexOf('角色');
    const templateSectionIndex = titles.indexOf('组合母版');
    expect(characterSectionIndex).toBeGreaterThan(-1);
    expect(templateSectionIndex).toBe(characterSectionIndex + 1);
  });

  it('renders individual template names cleanly without showing 内置·Aeon... badge', () => {
    const mockTemplates: any[] = [
      {
        id: 'char_one_click_enter',
        name: '一键登场',
        source: {
          scope: 'builtin',
          templateId: 'aeonstagery.default',
          templateName: 'AeonStagery Default Templates',
        },
        payload: {
          kind: 'timelineFragment',
          statements: [
            { type: 'characterPresence', params: {} },
            { type: 'visualStyle', params: { slot: 'integration' } },
            { type: 'visualStyle', params: { slot: 'rim-light' } },
          ],
        },
      },
    ];

    render(
      <BlankContextMenu
        menu={{ x: 20, y: 20, time: 2, charId: null, charLabel: null }}
        hasCopyBuffer={false}
        templates={mockTemplates}
        onPaste={vi.fn()}
        onSelectAction={vi.fn()}
      />,
    );

    const templateCard = screen.getByTestId('statement-template-card');
    expect(templateCard).toBeDefined();
    expect(templateCard.querySelector('.statement-block-library__template-label')?.textContent).toBe('一键登场');
    expect(templateCard.textContent).not.toContain('内置 · Aeon');
    expect(templateCard.getAttribute('title')).toBe('一键登场 · 内置 · AeonStagery Default Templates');
  });

  it('filters out templates with <= 1 statement or names duplicating existing statement blocks', () => {
    const mockTemplates: any[] = [
      {
        id: 'single_statement_combo',
        name: '单语句模板',
        payload: {
          kind: 'timelineFragment',
          statements: [{ type: 'camera', params: {} }],
        },
      },
      {
        id: 'duplicate_name_combo',
        name: '角色登场', // Duplicates existing statement block '角色登场'
        payload: {
          kind: 'timelineFragment',
          statements: [
            { type: 'characterPresence', params: {} },
            { type: 'camera', params: {} },
          ],
        },
      },
      {
        id: 'valid_combo',
        name: '合法多语句母版',
        payload: {
          kind: 'timelineFragment',
          statements: [
            { type: 'characterPresence', params: {} },
            { type: 'camera', params: {} },
          ],
        },
      },
    ];

    render(
      <BlankContextMenu
        menu={{ x: 20, y: 20, time: 2, charId: null, charLabel: null }}
        hasCopyBuffer={false}
        templates={mockTemplates}
        onPaste={vi.fn()}
        onSelectAction={vi.fn()}
      />,
    );

    expect(screen.queryByText('单语句模板')).toBeNull();
    // '角色登场' exists as statement block, but should not have a template card
    const cards = screen.getAllByRole('button');
    const templateLabels = cards
      .filter((card) => card.getAttribute('data-testid') === 'statement-template-card')
      .map((card) => card.querySelector('.statement-block-library__template-label')?.textContent?.trim());
    expect(templateLabels).not.toContain('单语句模板');
    expect(templateLabels).not.toContain('角色登场');
    expect(templateLabels).toContain('合法多语句母版');
  });

  it('displays only 对话推进 and 一键登场 from default templates', () => {
    const defaultTemplates: any[] = [
      {
        id: 'dialogue_push',
        name: '对话推进',
        payload: {
          kind: 'dialoguePreset',
          dialogue: { type: 'dialogue', params: { speaker: '$character', text: '对话内容' } },
          companions: [{ type: 'characterPerformance', anchor: 'start', offset: 0, params: { target: '$character' } }],
        },
      },
      {
        id: 'char_one_click_enter',
        name: '一键登场',
        payload: {
          kind: 'timelineFragment',
          statements: [
            { type: 'characterPresence', params: { mode: 'enter', id: '$character' } },
            { type: 'visualStyle', params: { scope: 'object', target: '$character', slot: 'integration' } },
            { type: 'visualStyle', params: { scope: 'object', target: '$character', slot: 'rim-light' } },
          ],
        },
      },
    ];

    render(
      <BlankContextMenu
        menu={{ x: 20, y: 20, time: 2, charId: 'anon', charLabel: 'Anon' }}
        hasCopyBuffer={false}
        templates={defaultTemplates}
        onPaste={vi.fn()}
        onSelectAction={vi.fn()}
      />,
    );

    const cards = screen.getAllByRole('button');
    const templateLabels = cards
      .filter((card) => card.getAttribute('data-testid') === 'statement-template-card')
      .map((card) => card.querySelector('.statement-block-library__template-label')?.textContent?.trim());
    expect(templateLabels).toEqual(['对话推进', '一键登场']);
  });

  it('renders an empty state when search matches nothing and clears with clear button', () => {
    render(
      <BlankContextMenu
        menu={{ x: 20, y: 20, time: 2, charId: null, charLabel: null }}
        hasCopyBuffer={false}
        onPaste={vi.fn()}
        onSelectAction={vi.fn()}
      />,
    );

    const searchInput = screen.getByPlaceholderText('搜索动作类型...');
    fireEvent.change(searchInput, { target: { value: '不存在的动作xyz' } });

    expect(screen.getByText('未找到与“不存在的动作xyz”匹配的语句类型或母版')).toBeDefined();

    const clearButton = screen.getByRole('button', { name: '清空搜索' });
    expect(clearButton).toBeDefined();

    fireEvent.click(clearButton);
    expect(screen.queryByText('未找到与“不存在的动作xyz”匹配的语句类型或母版')).toBeNull();
    expect((searchInput as HTMLInputElement).value).toBe('');
  });
});


