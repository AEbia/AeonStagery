import { BUNDLED_CHANGELOGS } from './bundledChangelogs';
import type { ChangelogFilterOptions, ChangelogItem } from './announcementTypes';

export class ChangelogService {
  private readonly items: readonly ChangelogItem[];

  constructor(customItems?: readonly ChangelogItem[]) {
    this.items = customItems ?? BUNDLED_CHANGELOGS;
  }

  /**
   * Get all changelog / announcement items sorted (pinned first, then date descending).
   */
  getItems(options?: ChangelogFilterOptions): ChangelogItem[] {
    let result = [...this.items];

    if (options?.type && options.type !== 'all') {
      result = result.filter((item) => item.type === options.type);
    }

    if (options?.searchQuery && options.searchQuery.trim()) {
      const query = options.searchQuery.trim().toLowerCase();
      result = result.filter((item) => {
        const matchTitle = item.title.toLowerCase().includes(query);
        const matchVersion = item.version?.toLowerCase().includes(query);
        const matchSummary = item.summary?.toLowerCase().includes(query);
        const matchContent = item.content.toLowerCase().includes(query);
        const matchTags = item.tags?.some((t) => t.label.toLowerCase().includes(query));
        return matchTitle || matchVersion || matchSummary || matchContent || matchTags;
      });
    }

    return result.sort((a, b) => {
      // Pinned items take top precedence
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      // Then sort by date descending
      return b.date.localeCompare(a.date);
    });
  }

  getItemById(id: string): ChangelogItem | undefined {
    return this.items.find((item) => item.id === id);
  }

  getLatestRelease(): ChangelogItem | undefined {
    const releases = this.items.filter((item) => item.type === 'release' || item.type === 'patch' || item.type === 'hotfix');
    if (releases.length === 0) return undefined;
    return [...releases].sort((a, b) => b.date.localeCompare(a.date))[0];
  }

  getLatestItem(): ChangelogItem | undefined {
    if (this.items.length === 0) return undefined;
    return [...this.items].sort((a, b) => b.date.localeCompare(a.date))[0];
  }

  /**
   * Determine whether a specific item is considered unread.
   */
  isItemUnread(item: ChangelogItem, lastReadIdOrVersion?: string, readIds: string[] = []): boolean {
    if (readIds.includes(item.id)) return false;
    if (lastReadIdOrVersion && (item.id === lastReadIdOrVersion || item.version === lastReadIdOrVersion)) {
      return false;
    }
    // If no read history at all, the latest item is unread
    if (!lastReadIdOrVersion && readIds.length === 0) {
      return true;
    }
    return !readIds.includes(item.id);
  }

  /**
   * Check if there are any unread items.
   */
  hasUnread(lastReadIdOrVersion?: string, readIds: string[] = []): boolean {
    return this.getUnreadCount(lastReadIdOrVersion, readIds) > 0;
  }

  /**
   * Count total unread items based on user's read state.
   */
  getUnreadCount(lastReadIdOrVersion?: string, readIds: string[] = []): number {
    return this.items.filter((item) => this.isItemUnread(item, lastReadIdOrVersion, readIds)).length;
  }

  getAllIds(): string[] {
    return this.items.map((item) => item.id);
  }
}

export const defaultChangelogService = new ChangelogService();
