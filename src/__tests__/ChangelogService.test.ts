import { describe, it, expect } from 'vitest';
import { ChangelogService } from '../services/announcements/ChangelogService';
import type { ChangelogItem } from '../services/announcements/announcementTypes';

describe('ChangelogService', () => {
  const mockItems: ChangelogItem[] = [
    {
      id: 'item-1',
      type: 'release',
      version: '0.1.0',
      title: 'Initial Release',
      date: '2026-01-01',
      summary: 'First release of the product',
      content: '## Features\n- First feature',
      tags: [{ label: 'SpecialTag', color: 'primary' }],
    },
    {
      id: 'item-2',
      type: 'announcement',
      title: 'Important Notice',
      date: '2026-02-01',
      pinned: true,
      summary: 'Community announcement',
      content: '## Notice\n- Community update',
    },
    {
      id: 'item-3',
      type: 'release',
      version: '0.2.0',
      title: 'Second Release',
      date: '2026-03-01',
      summary: 'Second release update',
      content: '## Features\n- Live2D upgrade',
    },
  ];

  it('sorts pinned items first, then date descending', () => {
    const service = new ChangelogService(mockItems);
    const items = service.getItems();

    expect(items[0].id).toBe('item-2'); // pinned
    expect(items[1].id).toBe('item-3'); // 2026-03-01
    expect(items[2].id).toBe('item-1'); // 2026-01-01
  });

  it('filters by type', () => {
    const service = new ChangelogService(mockItems);
    const releases = service.getItems({ type: 'release' });
    expect(releases).toHaveLength(2);
    expect(releases.every((i) => i.type === 'release')).toBe(true);

    const announcements = service.getItems({ type: 'announcement' });
    expect(announcements).toHaveLength(1);
    expect(announcements[0].id).toBe('item-2');
  });

  it('filters by search query across title, version, summary, content, tags', () => {
    const service = new ChangelogService(mockItems);

    const matchVersion = service.getItems({ searchQuery: '0.2.0' });
    expect(matchVersion).toHaveLength(1);
    expect(matchVersion[0].id).toBe('item-3');

    const matchContent = service.getItems({ searchQuery: 'Live2D' });
    expect(matchContent).toHaveLength(1);
    expect(matchContent[0].id).toBe('item-3');

    const matchTag = service.getItems({ searchQuery: 'SpecialTag' });
    expect(matchTag).toHaveLength(1);
    expect(matchTag[0].id).toBe('item-1');
  });

  it('finds latest release', () => {
    const service = new ChangelogService(mockItems);
    const latest = service.getLatestRelease();
    expect(latest?.version).toBe('0.2.0');
  });

  it('computes unread status correctly', () => {
    const service = new ChangelogService(mockItems);

    // Initial with no read state
    expect(service.hasUnread(undefined, [])).toBe(true);
    expect(service.getUnreadCount(undefined, [])).toBe(3);

    // After reading item-2 and item-3
    expect(service.getUnreadCount(undefined, ['item-2', 'item-3'])).toBe(1);
    expect(service.isItemUnread(mockItems[0], undefined, ['item-2', 'item-3'])).toBe(true);
    expect(service.isItemUnread(mockItems[1], undefined, ['item-2', 'item-3'])).toBe(false);

    // Mark all as read
    const allIds = service.getAllIds();
    expect(service.hasUnread(undefined, allIds)).toBe(false);
    expect(service.getUnreadCount(undefined, allIds)).toBe(0);
  });
});
