import type { ChangelogItem } from './announcementTypes';

/**
 * In-app changelog for the current release line.
 *
 * The release-history reset retired every bundled entry, so this list is
 * intentionally empty. The dialog, its empty state and the announcement
 * plumbing stay in place: `ChangelogService` already treats an empty list as a
 * valid state (`getLatestRelease()` returns `undefined`, `getItems()` returns
 * `[]`), and future releases can add entries here again without any UI change.
 */
export const BUNDLED_CHANGELOGS: readonly ChangelogItem[] = [];
