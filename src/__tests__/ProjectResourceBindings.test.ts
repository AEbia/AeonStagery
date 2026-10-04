import { describe, expect, it } from 'vitest';
import { projectMetadataCodec } from '../services/project/ProjectMetadataCodec';
import {
  normalizeProjectExternalLibraryBindings,
  projectExternalLibraryBindingsSignature,
} from '../ui/SettingsStore';

const metadata = {
  projectId: 'demo',
  name: 'Demo',
  projectVersion: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  defaultSceneId: 'main',
  scenes: [{ id: 'main', name: 'Main', path: 'project/main.scene.json' }],
  assetRoots: {
    figure: 'figure',
    background: 'background',
    bgm: 'bgm',
    vocal: 'vocal',
    images: 'images',
    animation: 'animation',
    project: 'project',
    template: 'template',
  },
};

describe('project resource bindings', () => {
  it('parses portable embedded mount roots and rejects paths that escape the project', () => {
    expect(projectMetadataCodec.parseKnownProjection({
      ...metadata,
      embeddedLibraryMounts: [{ id: 'shared-library', path: '.aeonstagery/embedded/shared-library' }],
    }).embeddedLibraryMounts).toEqual([
      { id: 'shared-library', path: '.aeonstagery/embedded/shared-library' },
    ]);

    expect(() => projectMetadataCodec.parseKnownProjection({
      ...metadata,
      embeddedLibraryMounts: [{ id: 'shared-library', path: '../outside' }],
    })).toThrow('contained project-relative path');
    expect(() => projectMetadataCodec.parseKnownProjection({
      ...metadata,
      embeddedLibraryMounts: [{ id: 'shared-library', path: 'D:/outside' }],
    })).toThrow('project-relative path');
  });

  it('normalizes nested per-project bindings and prunes entries that can never resolve', () => {
    expect(normalizeProjectExternalLibraryBindings({
      demo: {
        'shared-library': ' F:\\Moved Library\\ ',
        '': 'C:/ignored',
        'Bad Id!': 'C:/ignored',
        missing: '   ',
        typed: 42,
      },
      '  ': { 'shared-library': 'C:/ignored' },
      other: 'not-a-record',
    })).toEqual({
      demo: { 'shared-library': 'F:/Moved Library' },
    });
  });

  it('folds the legacy flat projectId+NUL+mountId bindings into the nested shape', () => {
    const flatKey = `demo\u0000shared-library`;
    expect(normalizeProjectExternalLibraryBindings(undefined, {
      [flatKey]: 'E:/Library',
      'no-nul-key': 'E:/Ignored',
    })).toEqual({
      demo: { 'shared-library': 'E:/Library' },
    });
    // A nested value also accepts inline legacy keys from older payloads.
    expect(normalizeProjectExternalLibraryBindings({ [flatKey]: 'E:/Library' })).toEqual({
      demo: { 'shared-library': 'E:/Library' },
    });
  });

  it('produces a stable per-project binding signature for cache invalidation', () => {
    const bindings = { demo: { beta: 'D:/b', alpha: 'C:/a' }, other: { alpha: 'Z:/' } };
    expect(projectExternalLibraryBindingsSignature(bindings, 'demo'))
      .toBe(projectExternalLibraryBindingsSignature(bindings, 'demo'));
    expect(projectExternalLibraryBindingsSignature(bindings, 'demo'))
      .not.toBe(projectExternalLibraryBindingsSignature({ demo: { beta: 'D:/moved', alpha: 'C:/a' } }, 'demo'));
    expect(projectExternalLibraryBindingsSignature(bindings, 'missing')).toBe('');
  });
});
