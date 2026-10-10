/** @vitest-environment jsdom */
import { setupInlineInspectorFixture, state, renderList } from './fixtures/timelineInlineInspector';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TimelineListView } from '../ui/timeline/TimelineListView';

setupInlineInspectorFixture();

describe('List inline inspector expansion selection', () => {
  it('statements are collapsed by default and expand when clicking expand toggle icon or row', () => {
    const { container } = render(
      <TimelineListView
        sceneData={{ sceneId: state.document.sceneId, meta: state.document.meta, timeline: [] }}
        selectedActionIds={{}}
        setSelectedIds={vi.fn()}
        addAction={vi.fn()}
        handleSelect={vi.fn()}
        setCurrentTime={vi.fn()}
        loadExample={vi.fn(async () => true)}
      />,
    );

    // Collapsed by default: no inspector-workspace__detail rendered
    expect(container.querySelectorAll('.inspector-workspace__detail')).toHaveLength(0);
    expect(screen.queryByTestId('inline-action-inspector')).toBeNull();

    // Find expand buttons
    const expandButtons = screen.getAllByRole('button', { name: '展开详情' });
    expect(expandButtons.length).toBeGreaterThanOrEqual(3);

    // Click first statement's expand toggle
    fireEvent.click(expandButtons[0]);

    // Expanded: inspector-workspace__detail container is rendered inline
    expect(container.querySelectorAll('.inspector-workspace__detail')).toHaveLength(1);
    expect(screen.getByTestId('inline-action-inspector')).toBeTruthy();
    expect(screen.getByRole('button', { name: '折叠详情' })).toBeTruthy();

    // Click again to collapse
    fireEvent.click(screen.getByRole('button', { name: '折叠详情' }));
    expect(container.querySelectorAll('.inspector-workspace__detail')).toHaveLength(0);
    expect(screen.queryByTestId('inline-action-inspector')).toBeNull();
    });

  it('toggles expansion when clicking the statement title button', () => {
    const { container } = render(
      <TimelineListView
        sceneData={{ sceneId: state.document.sceneId, meta: state.document.meta, timeline: [] }}
        selectedActionIds={{}}
        setSelectedIds={vi.fn()}
        addAction={vi.fn()}
        handleSelect={vi.fn()}
        setCurrentTime={vi.fn()}
        loadExample={vi.fn(async () => true)}
      />,
    );

    const titleButtons = screen.getAllByRole('button', { name: /^展开.+详情$/ });
    expect(titleButtons.length).toBeGreaterThanOrEqual(3);

    // Click statement title button to expand
    fireEvent.click(titleButtons[0]);
    expect(container.querySelectorAll('.inspector-workspace__detail')).toHaveLength(1);

    // Click statement title button again to collapse
    fireEvent.click(titleButtons[0]);
    expect(container.querySelectorAll('.inspector-workspace__detail')).toHaveLength(0);
    });

  it('provides 全部展开 and 全部折叠 buttons in toolbar to expand and collapse all statements', () => {
    const { container } = render(
      <TimelineListView
        sceneData={{ sceneId: state.document.sceneId, meta: state.document.meta, timeline: [] }}
        selectedActionIds={{}}
        setSelectedIds={vi.fn()}
        addAction={vi.fn()}
        handleSelect={vi.fn()}
        setCurrentTime={vi.fn()}
        loadExample={vi.fn(async () => true)}
      />,
    );

    const expandAllBtn = screen.getByRole('button', { name: '全部展开' });
    const collapseAllBtn = screen.getByRole('button', { name: '全部折叠' });

    expect(expandAllBtn).toBeTruthy();
    expect(collapseAllBtn).toBeTruthy();

    // Initially all collapsed
    expect(container.querySelectorAll('.inspector-workspace__detail')).toHaveLength(0);

    // Click 全部展开
    fireEvent.click(expandAllBtn);

    // All 3 statements expanded
    expect(container.querySelectorAll('.inspector-workspace__detail')).toHaveLength(3);
    expect(screen.getAllByTestId('inline-action-inspector')).toHaveLength(3);

    // Click 全部折叠
    fireEvent.click(collapseAllBtn);

    // All statements collapsed
    expect(container.querySelectorAll('.inspector-workspace__detail')).toHaveLength(0);
    expect(screen.queryByTestId('inline-action-inspector')).toBeNull();
    });

  it('keeps other rows expanded when collapsing one after expand-all', () => {
    renderList();
    fireEvent.click(screen.getByRole('button', { name: '全部展开' }));
    expect(screen.getAllByTestId('inline-action-inspector')).toHaveLength(3);
    fireEvent.click(screen.getAllByRole('button', { name: '折叠详情' })[0]);
    expect(screen.getAllByTestId('inline-action-inspector')).toHaveLength(2);
    });

  it('opens an externally selected statement inline and leaves other statements collapsed', () => {
    const selectedId = state.compiledScene.actions.find((action: any) => action.source.statementId === 'dlg-2').id;
    renderList({ selectedActionIds: { [selectedId]: true } });
    expect(screen.getAllByTestId('inline-action-inspector')).toHaveLength(1);
    expect(screen.getByTestId('inline-action-inspector').getAttribute('data-action-id')).toBe(selectedId);
    });

  it('collapses a deselected track statement while retaining manually expanded statements', () => {
    const firstId = state.compiledScene.actions.find((action: any) => action.source.statementId === 'dlg-1').id;
    const secondId = state.compiledScene.actions.find((action: any) => action.source.statementId === 'dlg-2').id;
    const list = (selectedActionIds: Record<string, boolean>) => <TimelineListView
      sceneData={{ sceneId: state.document.sceneId, meta: state.document.meta, timeline: [] }}
      selectedActionIds={selectedActionIds} setSelectedIds={vi.fn()} addAction={vi.fn()}
      handleSelect={vi.fn()} setCurrentTime={vi.fn()} loadExample={vi.fn(async () => true)}
    />;
    const view = render(list({}));
    fireEvent.click(screen.getAllByRole('button', { name: '展开详情' })[0]);
    view.rerender(list({ [secondId]: true }));
    expect(screen.getAllByTestId('inline-action-inspector')).toHaveLength(2);

    view.rerender(list({}));
    expect(screen.getAllByTestId('inline-action-inspector')).toHaveLength(1);
    expect(screen.getByTestId('inline-action-inspector').getAttribute('data-action-id')).toBe(firstId);

    // Selecting an already manually expanded statement does not take ownership.
    view.rerender(list({ [firstId]: true }));
    view.rerender(list({}));
    expect(screen.getByTestId('inline-action-inspector').getAttribute('data-action-id')).toBe(firstId);
    });

  it('briefly emphasizes an external selection without stealing focus or flashing on rerenders', () => {
    vi.useFakeTimers();
    try {
      const selectedId = state.compiledScene.actions.find((action: any) => action.source.statementId === 'dlg-2').id;
      const list = (selectedActionIds: Record<string, boolean>) => <TimelineListView
        sceneData={{ sceneId: state.document.sceneId, meta: state.document.meta, timeline: [] }}
        selectedActionIds={selectedActionIds} setSelectedIds={vi.fn()} addAction={vi.fn()}
        handleSelect={vi.fn()} setCurrentTime={vi.fn()} loadExample={vi.fn(async () => true)}
      />;
      const view = render(list({}));
      const draft = screen.getAllByRole('textbox', { name: '编辑台词内容' })[0];
      fireEvent.mouseDown(draft);
      act(() => draft.focus());
      expect(document.activeElement === draft).toBe(true);

      view.rerender(list({ [selectedId]: true }));

      const row = screen.getByTestId('inline-action-inspector')
        .closest('.timeline-item-container')?.querySelector('.timeline-item');
      expect(row?.classList.contains('timeline-item--revealed')).toBe(true);
      expect(document.activeElement === draft).toBe(true);
      act(() => vi.advanceTimersByTime(250));
      expect(row?.classList.contains('timeline-item--revealed')).toBe(false);

      view.rerender(list({ [selectedId]: true }));
      expect(row?.classList.contains('timeline-item--revealed')).toBe(false);
      view.rerender(list({}));
      view.rerender(list({ [selectedId]: true }));
      expect(row?.classList.contains('timeline-item--revealed')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    });
});
