/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { LooseTimelineAction as SceneAction } from './fixtures/TimelineTestTypes';
import {
  TimelineSelectionBar,
} from '../ui/timeline/TimelineSelectionBar';
import { WorkspaceToolsWindow } from '../WorkspaceToolsWindow';
import {
  WORKBENCH_CONTEXT_WIDTH,
  WORKBENCH_DETAIL_WIDTH,
  WORKBENCH_PANEL_WIDTH,
  WORKBENCH_TIMELINE_HEIGHT,
  clampWorkbenchValue,
} from '../ui/hooks/useResizableLayout';

describe('workbench layout polish', () => {
  it('clamps persisted workbench dimensions to ergonomic bounds', () => {
    expect(clampWorkbenchValue(120, WORKBENCH_PANEL_WIDTH.min, WORKBENCH_PANEL_WIDTH.max, WORKBENCH_PANEL_WIDTH.defaultValue))
      .toBe(WORKBENCH_PANEL_WIDTH.min);
    expect(clampWorkbenchValue(900, WORKBENCH_CONTEXT_WIDTH.min, WORKBENCH_CONTEXT_WIDTH.max, WORKBENCH_CONTEXT_WIDTH.defaultValue))
      .toBe(WORKBENCH_CONTEXT_WIDTH.max);
    expect(clampWorkbenchValue(120, WORKBENCH_DETAIL_WIDTH.min, WORKBENCH_DETAIL_WIDTH.max, WORKBENCH_DETAIL_WIDTH.defaultValue))
      .toBe(WORKBENCH_DETAIL_WIDTH.min);
    expect(clampWorkbenchValue(undefined, WORKBENCH_TIMELINE_HEIGHT.min, WORKBENCH_TIMELINE_HEIGHT.max, WORKBENCH_TIMELINE_HEIGHT.defaultValue))
      .toBe(WORKBENCH_TIMELINE_HEIGHT.defaultValue);
  });

  it('shows selected action context and exposes high-frequency actions', () => {
    const action = {
      _id: 'dialogue_1',
      action: 'dialogue',
      time: 5.75,
      params: { duration: 3, text: '测试台词' },
    } as SceneAction;
    const onSeek = vi.fn();
    const onReveal = vi.fn();
    const onClear = vi.fn();
    const onCopy = vi.fn();
    const onDuplicate = vi.fn();
    const onDelete = vi.fn();
    const onSplit = vi.fn();
    const onAlignToPlayhead = vi.fn();
    const onSelectAdjacent = vi.fn();
    const onChangeTrack = vi.fn();

    render(
      <TimelineSelectionBar
        selectedCount={1}
        action={action}
        trackLabel="全局"
        trackValue="global"
        trackOptions={[{ id: 'global', label: '全局' }, { id: 'char:1', label: '角色 1' }]}
        issueCount={2}
        hasRepeatWarning
        canSplit
        onSeek={onSeek}
        onReveal={onReveal}
        onClear={onClear}
        onCopy={onCopy}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
        onSplit={onSplit}
        onAlignToPlayhead={onAlignToPlayhead}
        onSelectAdjacent={onSelectAdjacent}
        onChangeTrack={onChangeTrack}
      />,
    );

    expect(screen.getByTestId('timeline-selection-bar')).toBeTruthy();
    expect(screen.getByTestId('timeline-selection-layer')).toBeTruthy();
    expect(screen.getByText('对话')).toBeTruthy();
    expect(screen.getAllByText('全局').length).toBeGreaterThan(0);
    expect(screen.getByText('重复')).toBeTruthy();

    fireEvent.click(screen.getByText('定位'));
    expect(onReveal).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('复制'));
    expect(onCopy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('拆分'));
    expect(onSplit).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('快速改轨道'));
    fireEvent.click(screen.getByRole('option', { name: '角色 1' }));
    expect(onChangeTrack).toHaveBeenCalledWith('char:1');

    fireEvent.click(screen.getByTitle('清空选择'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('does not reserve timeline space when nothing is selected', () => {
    render(
      <TimelineSelectionBar
        selectedCount={0}
        action={null}
        trackLabel={undefined}
        issueCount={0}
        hasRepeatWarning={false}
        canSplit={false}
        onSeek={vi.fn()}
        onReveal={vi.fn()}
        onClear={vi.fn()}
        onCopy={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
        onSplit={vi.fn()}
        onAlignToPlayhead={vi.fn()}
        onSelectAdjacent={vi.fn()}
        onChangeTrack={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('timeline-selection-layer')).toBeNull();
    expect(screen.queryByTestId('timeline-selection-bar')).toBeNull();
  });

  it('renders the detached tools surface safely without an Electron bridge', () => {
    const originalApi = (window as any).aeonStageryAPI;
    (window as any).aeonStageryAPI = undefined;

    try {
      render(<WorkspaceToolsWindow />);

      expect(screen.getAllByText('等待主窗口连接').length).toBeGreaterThan(0);
      expect(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled')).toBe(true);
      expect(screen.queryByRole('button', { name: '重新停靠' })).toBeNull();
    } finally {
      (window as any).aeonStageryAPI = originalApi;
    }
  });
});
