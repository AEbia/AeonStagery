import { describe, expect, it } from 'vitest';
import { createLibraryRootsPolicy } from '../services/settings/LibraryRootsPolicy';

describe('LibraryRootsPolicy', () => {
  it('normalizes, deduplicates, and omits blank roots without asset import behavior', () => {
    const policy = createLibraryRootsPolicy();

    const roots = policy.resolveRoots({
      projectRoot: 'C:\\Project\\',
      externalRoots: [' c:/project ', 'D:\\Shared\\Library\\', '', 'D:/Shared/Library/'],
    });

    expect(roots).toEqual(['C:/Project', 'D:/Shared/Library']);
  });

  it('keeps project root first and marks external roots read-only', () => {
    const policy = createLibraryRootsPolicy();

    expect(policy.describeRoot('C:/Project', 'project')).toEqual({
      root: 'C:/Project',
      kind: 'project',
      writable: true,
    });
    expect(policy.describeRoot('D:/Assets', 'external')).toEqual({
      root: 'D:/Assets',
      kind: 'external',
      writable: false,
    });
  });
});
