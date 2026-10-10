/** @vitest-environment jsdom */
import { setupInlineInspectorFixture, state, loadStatements, renderList } from './fixtures/timelineInlineInspector';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { computeSidePanelWidth } from '../App';
import { TimelineListView } from '../ui/timeline/TimelineListView';

setupInlineInspectorFixture();

describe('List inline inspector layout', () => {
  it('defaults right panel timeline list width to 600px in list mode', () => {
    // Test default width 600 in 560px~640px range
    const listWidth = computeSidePanelWidth({
      isTracksMode: false,
      panelWidth: 600,
      inspectorNavigatorWidth: 600,
      inspectorLayout: 'split',
      isInspectorDetailVisible: false,
      detailWidth: 360,
    });
    expect(listWidth).toBe(600);
    expect(listWidth).toBeGreaterThanOrEqual(560);
    expect(listWidth).toBeLessThanOrEqual(640);
    });

  it('keeps sidePanelWidth fixed at panel width when detail is visible in list mode', () => {
    const fixedWidthCollapsed = computeSidePanelWidth({
      isTracksMode: false,
      panelWidth: 600,
      inspectorNavigatorWidth: 600,
      inspectorLayout: 'split',
      isInspectorDetailVisible: false,
      detailWidth: 360,
    });
    const fixedWidthExpanded = computeSidePanelWidth({
      isTracksMode: false,
      panelWidth: 600,
      inspectorNavigatorWidth: 600,
      inspectorLayout: 'split',
      isInspectorDetailVisible: true,
      detailWidth: 360,
    });

    // Does NOT pop out a separate side column (+ detailWidth + 4), remains fixed at 600px
    expect(fixedWidthCollapsed).toBe(600);
    expect(fixedWidthExpanded).toBe(600);
    });

  it('supports user-adjusted panel width in 560px~640px range without splitting', () => {
    for (const width of [560, 580, 620, 640]) {
      const computed = computeSidePanelWidth({
        isTracksMode: false,
        panelWidth: width,
        inspectorNavigatorWidth: width,
        inspectorLayout: 'split',
        isInspectorDetailVisible: true,
        detailWidth: 360,
      });
      expect(computed).toBe(width);
    }
    });

  it('does not render expand buttons or inline edit controls when inlineExpandable is false', () => {
    const handleSelect = vi.fn();
    const { container } = render(
      <TimelineListView
        sceneData={{ sceneId: state.document.sceneId, meta: state.document.meta, timeline: [] }}
        inlineExpandable={false}
        selectedActionIds={{}}
        setSelectedIds={vi.fn()}
        addAction={vi.fn()}
        handleSelect={handleSelect}
        setCurrentTime={vi.fn()}
        loadExample={vi.fn(async () => true)}
      />,
    );

    // No expand toggle buttons or toolbar controls
    expect(screen.queryByRole('button', { name: '展开详情' })).toBeNull();
    expect(screen.queryByRole('button', { name: '全部展开' })).toBeNull();
    expect(screen.queryByRole('button', { name: '全部折叠' })).toBeNull();

    // No inline input controls
    expect(screen.queryByRole('combobox', { name: '选择说话角色' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: '编辑台词内容' })).toBeNull();

    // Cards render with compact class
    const compactItems = container.querySelectorAll('.timeline-item--compact');
    expect(compactItems.length).toBeGreaterThanOrEqual(3);

    // Clicking card triggers handleSelect without expanding
    const selectButtons = screen.getAllByRole('button', { name: /选择/ });
    fireEvent.click(selectButtons[0]);
    expect(handleSelect).toHaveBeenCalledWith(expect.stringContaining('dlg-1'), false);
    expect(container.querySelectorAll('.inspector-workspace__detail')).toHaveLength(0);
    });

  it('mounts only visible inspectors after expanding a long scene', () => {
    loadStatements(Array.from({ length: 200 }, (_, index) => ({
      id: `line-${index}`, type: 'dialogue', time: index * 3,
      params: { text: `Line ${index}`, durationSeconds: 2 },
    })));
    const { container } = renderList();
    expect(container.querySelectorAll('[data-timeline-virtual-row]').length).toBeLessThan(20);
    fireEvent.click(screen.getByRole('button', { name: '全部展开' }));
    expect(screen.getAllByTestId('inline-action-inspector').length).toBeLessThan(20);
    });

  it('does not display dialogue or action summaries in the compact outline', () => {
    const { container } = renderList({ inlineExpandable: false });
    expect(screen.queryByText('你好，这是第一句台词。')).toBeNull();
    expect(container.querySelector('.timeline-item__outline-text')).toBeNull();
    expect(container.querySelectorAll('.timeline-item--compact').length).toBeGreaterThan(0);
    expect(container.querySelector('.timeline-item__quick-fields')).toBeNull();
    expect(container.querySelector('.inspector-workspace__detail')).toBeNull();
    });
});
