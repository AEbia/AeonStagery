import type { RecentProjectEntry } from '../../SettingsStore';

/** Calendar dates use the user's local timezone, including across DST changes. */
export function formatRelativeTime(iso: string, now: number): string {
  const date = new Date(iso);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return '';
  const elapsed = now - timestamp;
  if (elapsed < 60_000) return '刚刚';
  const current = new Date(now);
  const dayNumber = (value: Date) => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86_400_000;
  const days = dayNumber(current) - dayNumber(date);
  if (days === 1) return '昨天';
  if (days > 1 && days < 7) return `${days} 天前`;
  if (days >= 7) {
    const year = date.getFullYear() === current.getFullYear() ? '' : `${date.getFullYear()}年`;
    return `${year}${date.getMonth() + 1}月${date.getDate()}日`;
  }
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  return `${Math.floor(elapsed / 3_600_000)} 小时前`;
}

export function formatAbsoluteTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function filterRecentProjects(projects: readonly RecentProjectEntry[], query: string): RecentProjectEntry[] {
  const keywords = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return projects.filter(({ name, rootPath }) => keywords.every((keyword) =>
    name.toLowerCase().includes(keyword) || rootPath.toLowerCase().includes(keyword)));
}
