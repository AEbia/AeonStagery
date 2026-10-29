import { describe, expect, it } from 'vitest';
import { filterRecentProjects, formatAbsoluteTime, formatRelativeTime } from '../recentProjects';

const now = new Date(2026, 9, 28, 12).getTime();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

describe('recent project times', () => {
  it.each([
    [0, '刚刚'], [0.99, '刚刚'], [-10, '刚刚'], [1, '1 分钟前'],
    [59, '59 分钟前'], [60, '1 小时前'], [120, '2 小时前'],
    [24 * 60, '昨天'], [2 * 24 * 60, '2 天前'], [6 * 24 * 60, '6 天前'],
    [7 * 24 * 60, '10月21日'],
  ])('formats %s minutes ago as %s', (minutes, expected) => {
    expect(formatRelativeTime(ago(minutes), now)).toBe(expected);
  });

  it('uses calendar days at midnight rather than elapsed 24-hour periods', () => {
    expect(formatRelativeTime(new Date(2026, 9, 27, 23, 59).toISOString(), new Date(2026, 9, 28, 0, 1).getTime())).toBe('昨天');
  });

  it('includes the year only for older dates in a different calendar year', () => {
    expect(formatRelativeTime(new Date(2025, 9, 3).toISOString(), now)).toBe('2025年10月3日');
    expect(formatRelativeTime(new Date(2026, 9, 3).toISOString(), now)).toBe('10月3日');
  });

  it('omits invalid times and formats full local time for tooltips', () => {
    expect(formatRelativeTime('invalid', now)).toBe('');
    expect(formatAbsoluteTime('invalid')).toBe('');
    expect(formatAbsoluteTime(new Date(2026, 9, 28, 21, 4).toISOString())).toBe('2026/10/28 21:04');
  });
});

describe('recent project search', () => {
  const projects = [
    { name: 'Episode Alpha', rootPath: 'D:/Shows/One', projectFilePath: 'one', lastOpenedAt: '' },
    { name: 'ALPHA two', rootPath: 'D:/Work/Two', projectFilePath: 'two', lastOpenedAt: '' },
    { name: 'Finale', rootPath: 'D:/Shows/Alpha', projectFilePath: 'three', lastOpenedAt: '' },
  ];
  it('requires every keyword to match the name or root path and preserves input order', () => {
    expect(filterRecentProjects(projects, ' ALPHA\tSHOWS ')).toEqual([projects[0], projects[2]]);
    expect(filterRecentProjects(projects, 'alpha missing')).toEqual([]);
    expect(filterRecentProjects(projects, 'WORK')).toEqual([projects[1]]);
  });
  it('returns all projects for whitespace without mutating the source', () => {
    expect(filterRecentProjects(Object.freeze([...projects]), ' \n ')).toEqual(projects);
  });
});
