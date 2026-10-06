/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useState, useEffect, useRef } from 'react';
import { eventBus } from '../api/events';
import { settingsManager, useSettings } from '../ui/SettingsStore';
import { ChangelogService } from '../services/announcements/ChangelogService';
import { ChangelogDialog } from '../ui/changelog/ChangelogDialog';
import { IconBell, IconMoon, IconSettings, IconSun, IconRefresh } from '../ui/icons';
import type { ChangelogItem } from '../services/announcements/announcementTypes';

const mockItems: ChangelogItem[] = [
  {
    id: '0.8.1-beta',
    type: 'release',
    version: '0.8.1-beta',
    title: 'AeonStagery 0.8.1-beta',
    date: '2026-10-06',
    summary: 'Release summary',
    content: '## New Features\n- Live2D Pixi rendering',
  },
];

// Test harness simulating App's top bar more menu and changelog wiring
function TopBarMoreMenuTestHarness({
  changelogService,
}: {
  changelogService: ChangelogService;
}) {
  const { settings, setSetting } = useSettings();
  const [isChangelogOpen, setIsChangelogOpen] = useState(false);
  const hasCheckedAutoChangelogRef = useRef(false);

  const hasUnreadChangelog = changelogService.hasUnread(
    settings.lastReadChangelogId,
    settings.readAnnouncementIds,
  );

  useEffect(() => {
    if (hasCheckedAutoChangelogRef.current) return;
    hasCheckedAutoChangelogRef.current = true;

    const autoShow = settings.autoShowChangelogOnUpdate ?? true;
    if (!autoShow) return;

    const latestRelease = changelogService.getLatestRelease();
    if (!latestRelease?.version) return;

    const isUnread = changelogService.isItemUnread(
      latestRelease,
      settings.lastReadChangelogId,
      settings.readAnnouncementIds,
    );

    if (isUnread) {
      setIsChangelogOpen(true);
    }
  }, [changelogService, settings.autoShowChangelogOnUpdate, settings.lastReadChangelogId, settings.readAnnouncementIds]);

  useEffect(() => {
    return eventBus.on('ui:openChangelog', () => {
      setIsChangelogOpen(true);
    });
  }, []);

  return (
    <div>
      <details className="top-bar__more" data-testid="top-bar-more">
        <summary className="btn btn--icon" title="更多操作" aria-label="更多操作">
          <span aria-hidden="true">•••</span>
          {hasUnreadChangelog && <span className="top-bar__unread-badge" aria-label="有未读更新" data-testid="unread-badge" />}
        </summary>
        <div className="top-bar__menu" role="menu">
          <button
            className="top-bar__menu-item"
            onClick={() => {
              const nextTheme = settings.theme === 'dark' ? 'light' : 'dark';
              setSetting('theme', nextTheme);
            }}
            role="menuitem"
            title="切换浅色或深色主题"
          >
            {settings.theme === 'light' ? <IconMoon width={15} height={15} /> : <IconSun width={15} height={15} />}
            切换主题
          </button>
          <button
            className="top-bar__menu-item"
            onClick={(e) => {
              const details = e.currentTarget.closest('details');
              if (details) details.open = false;
              setIsChangelogOpen(true);
            }}
            role="menuitem"
            title="查看更新日志与公告"
          >
            <IconBell width={15} height={15} />
            更新日志
            {hasUnreadChangelog && <span className="changelog-unread-dot" title="有未读更新" data-testid="menu-unread-dot" />}
          </button>
          <button
            className="top-bar__menu-item"
            onClick={(e) => {
              const details = e.currentTarget.closest('details');
              if (details) details.open = false;
              void eventBus.emit('ui:openSettings');
            }}
            role="menuitem"
          >
            <IconSettings width={15} height={15} />
            全局设置
          </button>
          <button className="top-bar__menu-item" role="menuitem">
            <IconRefresh width={15} height={15} />
            重新启动
          </button>
        </div>
      </details>

      {isChangelogOpen && (
        <ChangelogDialog
          isOpen={isChangelogOpen}
          onClose={() => setIsChangelogOpen(false)}
          changelogService={changelogService}
        />
      )}
    </div>
  );
}

describe('Changelog UI Integration', () => {
  let testService: ChangelogService;

  beforeEach(() => {
    window.localStorage.clear();
    settingsManager.set('lastReadChangelogId', undefined);
    settingsManager.set('readAnnouncementIds', []);
    settingsManager.set('autoShowChangelogOnUpdate', true);
    testService = new ChangelogService(mockItems);
  });

  describe('Manual Entry via Top-Bar More Menu (Three Dots)', () => {
    it('renders the three-dots button and shows the 更新日志 item in the menu', () => {
      // Mark as read so it doesn't auto-popup on mount
      settingsManager.set('lastReadChangelogId', '0.8.1-beta');

      render(<TopBarMoreMenuTestHarness changelogService={testService} />);

      const summaryBtn = screen.getByLabelText('更多操作');
      expect(summaryBtn).toBeDefined();
      expect(summaryBtn.textContent).toContain('•••');

      const changelogMenuItem = screen.getByRole('menuitem', { name: /更新日志/i });
      expect(changelogMenuItem).toBeDefined();
    });

    it('displays unread badges on the summary and menu item when new version is unread', () => {
      // Unread state
      settingsManager.set('lastReadChangelogId', '0.8.0-beta');
      // Disable auto-show so we can inspect the unread indicator in the menu
      settingsManager.set('autoShowChangelogOnUpdate', false);

      render(<TopBarMoreMenuTestHarness changelogService={testService} />);

      expect(screen.getByTestId('unread-badge')).toBeDefined();
      expect(screen.getByTestId('menu-unread-dot')).toBeDefined();
    });

    it('opens ChangelogDialog when clicking the 更新日志 menu item', () => {
      settingsManager.set('lastReadChangelogId', '0.8.1-beta');

      render(<TopBarMoreMenuTestHarness changelogService={testService} />);

      // Initially dialog is not mounted
      expect(screen.queryByText('更新日志与公告')).toBeNull();

      // Open the details dropdown
      const details = screen.getByTestId('top-bar-more') as HTMLDetailsElement;
      details.open = true;

      // Click the changelog button
      const changelogMenuItem = screen.getByRole('menuitem', { name: /更新日志/i });
      fireEvent.click(changelogMenuItem);

      // Dialog is now open
      expect(screen.getByText('更新日志与公告')).toBeDefined();
      expect(screen.getByText('Live2D Pixi rendering')).toBeDefined();
      expect(details.open).toBe(false);
    });

    it('opens ChangelogDialog when ui:openChangelog is emitted on eventBus', () => {
      settingsManager.set('lastReadChangelogId', '0.8.1-beta');

      render(<TopBarMoreMenuTestHarness changelogService={testService} />);

      expect(screen.queryByText('更新日志与公告')).toBeNull();

      act(() => {
        eventBus.emit('ui:openChangelog');
      });

      expect(screen.getByText('更新日志与公告')).toBeDefined();
    });
  });

  describe('Auto-Popup After Update', () => {
    it('automatically opens ChangelogDialog on startup when updated to a new version', () => {
      // User previous version was 0.8.0-beta, new version is 0.8.1-beta
      settingsManager.set('lastReadChangelogId', '0.8.0-beta');
      settingsManager.set('autoShowChangelogOnUpdate', true);

      render(<TopBarMoreMenuTestHarness changelogService={testService} />);

      // Automatically pops up
      expect(screen.getByText('更新日志与公告')).toBeDefined();
      expect(screen.getByText('Live2D Pixi rendering')).toBeDefined();
    });

    it('does NOT auto-popup when autoShowChangelogOnUpdate is false', () => {
      settingsManager.set('lastReadChangelogId', '0.8.0-beta');
      settingsManager.set('autoShowChangelogOnUpdate', false);

      render(<TopBarMoreMenuTestHarness changelogService={testService} />);

      expect(screen.queryByText('更新日志与公告')).toBeNull();
    });

    it('does NOT auto-popup when user has already read the latest release version', () => {
      settingsManager.set('lastReadChangelogId', '0.8.1-beta');
      settingsManager.set('autoShowChangelogOnUpdate', true);

      render(<TopBarMoreMenuTestHarness changelogService={testService} />);

      expect(screen.queryByText('更新日志与公告')).toBeNull();
    });

    it('marks the version as read when acknowledged with 我知道了', async () => {
      settingsManager.set('lastReadChangelogId', '0.8.0-beta');

      render(<TopBarMoreMenuTestHarness changelogService={testService} />);

      expect(screen.getByText('更新日志与公告')).toBeDefined();

      const knowBtn = screen.getByRole('button', { name: '我知道了' });
      fireEvent.click(knowBtn);

      // Dialog closes
      expect(screen.queryByText('更新日志与公告')).toBeNull();

      // Setting is updated to the latest release
      expect(settingsManager.get('lastReadChangelogId')).toBe('0.8.1-beta');
    });
  });
});
