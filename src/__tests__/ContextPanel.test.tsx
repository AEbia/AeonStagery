/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContextPanel } from '../ui/timeline/ContextPanel';
import { settingsManager } from '../ui/SettingsStore';

vi.mock('../ui/timeline/ActionInspectorTabs', () => ({
  DiagnosticsTab: () => <div>diagnostics content</div>,
  EngineSnapshotTab: () => <div>snapshot content</div>,
}));

vi.mock('../ui/timeline/CharacterDirectoryPanel', () => ({
  CharacterDirectoryPanel: () => <div>character content</div>,
}));

const sceneMeta = { title: 'workspace', characters: [] };

describe('ContextPanel', () => {
  it('renders as an embedded workspace tools page with detach support', () => {
    settingsManager.set('workbenchTimelineLayoutMode', 'list');
    const setActiveTab = vi.fn();
    const setIsOpen = vi.fn();
    const onDetach = vi.fn();

    const { container } = render(
      <ContextPanel
        sceneMeta={sceneMeta}
        actionCount={0}
        globalIssues={[]}
        isOpen
        setIsOpen={setIsOpen}
        width={400}
        activeTab="characters"
        setActiveTab={setActiveTab}
        onDetach={onDetach}
        canDetach
        embedded
      />,
    );

    expect(container.querySelector('.context-panel--embedded')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/切换侧栏视图，当前为角色管理/));
    fireEvent.click(screen.getByRole('menuitemradio', { name: '剧本动作，0 个' }));
    expect(setIsOpen).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByTitle('弹出为独立窗口'));
    expect(onDetach).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText(/切换侧栏视图，当前为角色管理/));
    fireEvent.click(screen.getByRole('menuitemradio', { name: '问题，无' }));
    expect(setActiveTab).toHaveBeenCalledWith('diagnostics');
  });
});
