// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  createExternalLibraryMount,
  hasExternalLibraryMountPath,
  normalizeExternalLibraryMounts,
  rebindExternalLibraryMount,
} from '../ui/SettingsStore';

describe('external library mount settings', () => {
  it('migrates legacy path arrays to deterministic stable mount ids', () => {
    expect(normalizeExternalLibraryMounts(undefined, [
      'C:/Libraries/WebGAL SV',
      'D:/Shared/WebGAL SV',
    ])).toEqual([
      { id: 'webgal-sv', path: 'C:/Libraries/WebGAL SV' },
      { id: 'webgal-sv-2', path: 'D:/Shared/WebGAL SV' },
    ]);
  });

  it('preserves a mount id when its machine-local path is replaced', () => {
    const mount = createExternalLibraryMount('C:/Libraries/WebGAL SV', []);
    const rebound = { ...mount, path: 'D:/Libraries/WebGAL SV' };

    expect(rebound).toEqual({ id: 'webgal-sv', path: 'D:/Libraries/WebGAL SV' });
  });

  it('preserves both stable ids when a mount is rebound to another mount path', () => {
    const mounts = [
      { id: 'library-a', path: 'E:/Library' },
      { id: 'library-b', path: 'F:/Library' },
    ];

    expect(rebindExternalLibraryMount(mounts, 1, ' E:\\Library\\ ')).toEqual([
      { id: 'library-a', path: 'E:/Library' },
      { id: 'library-b', path: 'E:/Library' },
    ]);
  });

  it('matches an existing mount through canonical path comparison', () => {
    const mounts = [{ id: 'library', path: 'E:/Library' }];

    expect(hasExternalLibraryMountPath(mounts, ' e:\\library\\ ')).toBe(true);
  });

  it('normalizes persisted ids and drops blank legacy roots', () => {
    expect(normalizeExternalLibraryMounts([
      { id: 'Shared Library', path: ' E:\\Shared\\ ' },
      { id: 'ignored', path: ' ' },
    ], undefined)).toEqual([
      { id: 'shared-library', path: 'E:/Shared' },
    ]);
  });
});
