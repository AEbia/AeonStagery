/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChangelogDialog } from '../ui/changelog/ChangelogDialog';
import { ChangelogService } from '../services/announcements/ChangelogService';
import { settingsManager } from '../ui/SettingsStore';
import type { ChangelogItem } from '../services/announcements/announcementTypes';

describe('ChangelogDialog', () => {
  const testItems: ChangelogItem[] = [
    {
      id: 'item-v0.6.1',
      type: 'release',
      version: '0.6.1',
      title: 'v0.6.1 Live2D Update',
      date: '2026-08-22',
      summary: 'Summary of 0.6.1',
      content: '## 0.6.1 Content\n- Added crash screen\n- Enhanced timeline',
      tags: [{ label: '最新', color: 'success' }],
    },
    {
      id: 'item-announcement',
      type: 'announcement',
      title: 'Notice for creators',
      date: '2026-08-20',
      pinned: true,
      summary: 'Creator guidelines',
      content: '## Community Guidelines\n- Respect copyrights',
    },
  ];

  let testService: ChangelogService;

  beforeEach(() => {
    window.localStorage.clear();
    settingsManager.set('lastReadChangelogId', undefined);
    settingsManager.set('readAnnouncementIds', []);
    settingsManager.set('autoShowChangelogOnUpdate', true);
    testService = new ChangelogService(testItems);
  });

  it('renders correctly when open', () => {
    const handleClose = vi.fn();
    render(<ChangelogDialog isOpen={true} onClose={handleClose} changelogService={testService} />);

    expect(screen.getByText('更新日志与公告')).toBeDefined();
    expect(screen.getAllByText('Notice for creators').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('v0.6.1 Live2D Update').length).toBeGreaterThanOrEqual(1);
  });

  it('does not render when isOpen is false', () => {
    const handleClose = vi.fn();
    const { container } = render(
      <ChangelogDialog isOpen={false} onClose={handleClose} changelogService={testService} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('filters items by tab category', () => {
    render(<ChangelogDialog isOpen={true} onClose={vi.fn()} changelogService={testService} />);

    // Switch to '版本更新' tab
    const releaseTab = screen.getByRole('tab', { name: '版本更新' });
    fireEvent.click(releaseTab);

    expect(screen.getAllByText('v0.6.1 Live2D Update').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Notice for creators')).toBeNull();

    // Switch to '官方公告' tab
    const announcementTab = screen.getByRole('tab', { name: '官方公告' });
    fireEvent.click(announcementTab);

    expect(screen.getAllByText('Notice for creators').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('v0.6.1 Live2D Update')).toBeNull();
  });

  it('switches viewed item on click and renders markdown content', () => {
    render(<ChangelogDialog isOpen={true} onClose={vi.fn()} changelogService={testService} />);

    // Initially unread release is selected
    expect(screen.getByText('Added crash screen')).toBeDefined();

    // Click on the announcement in the sidebar
    const announcementCard = screen.getByRole('button', { name: /Notice for creators/i });
    fireEvent.click(announcementCard);

    // Announcement markdown content should now be visible
    expect(screen.getByText('Community Guidelines')).toBeDefined();
  });

  it('calls onClose when close button or know button is clicked', () => {
    const handleClose = vi.fn();
    render(<ChangelogDialog isOpen={true} onClose={handleClose} changelogService={testService} />);

    const closeBtn = screen.getByRole('button', { name: '我知道了' });
    fireEvent.click(closeBtn);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('prioritizes unread release item over pinned announcement on open', () => {
    // testItems has pinned announcement and unread release (v0.6.1)
    render(<ChangelogDialog isOpen={true} onClose={vi.fn()} changelogService={testService} />);

    // Because v0.6.1 is an unread release, its markdown content should be selected by default
    expect(screen.getByText('Added crash screen')).toBeDefined();
  });

  it('allows toggling autoShowChangelogOnUpdate setting in footer', () => {
    render(<ChangelogDialog isOpen={true} onClose={vi.fn()} changelogService={testService} />);

    const checkbox = screen.getByLabelText('新版本启动时自动弹出更新日志') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
  });
});
