/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChangelogDialog } from '../ui/changelog/ChangelogDialog';
import { ChangelogService } from '../services/announcements/ChangelogService';
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

    // Click on the release item in the sidebar
    const releaseCard = screen.getByText('v0.6.1 Live2D Update');
    fireEvent.click(releaseCard);

    // Markdown content should be visible
    expect(screen.getByText('Added crash screen')).toBeDefined();
    expect(screen.getByText('Enhanced timeline')).toBeDefined();
  });

  it('calls onClose when close button or know button is clicked', () => {
    const handleClose = vi.fn();
    render(<ChangelogDialog isOpen={true} onClose={handleClose} changelogService={testService} />);

    const closeBtn = screen.getByRole('button', { name: '我知道了' });
    fireEvent.click(closeBtn);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });
});
