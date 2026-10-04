import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROJECT_ASSET_ROOTS,
  PROJECT_SCHEMA_VERSION_V2,
} from '../api/types/project';
import {
  migrateProjectMetadataV1ToV2,
  validateProjectMetadataV2Stage,
} from '../services/project';

describe('ProjectMetadataMigration', () => {
  it('migrates a valid v1 project metadata document to v2', () => {
    const v1Input = {
      projectId: 'p1',
      name: 'V1 Project',
      projectVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      defaultSceneId: 'main',
      scenes: [{ id: 'main', name: 'Main', path: 'project/main.scene.json' }],
      assetRoots: { ...DEFAULT_PROJECT_ASSET_ROOTS },
      unknownV1Field: { custom: true },
    };

    const { document, warnings } = migrateProjectMetadataV1ToV2(v1Input);
    const doc = document as Record<string, unknown>;

    expect(doc.projectVersion).toBe(PROJECT_SCHEMA_VERSION_V2);
    expect(doc.name).toBe('V1 Project');
    expect(doc.unknownV1Field).toEqual({ custom: true });
    expect(warnings.length).toBeGreaterThan(0);

    const projection = validateProjectMetadataV2Stage(doc);
    expect(projection.projectVersion).toBe(PROJECT_SCHEMA_VERSION_V2);
    expect(projection.name).toBe('V1 Project');
  });

  it('migrates unversioned legacy metadata to v2 with normalized defaults', () => {
    const legacyInput = {
      name: 'Legacy Project',
      scenes: [{ id: 'scene-a', name: 'Scene A', path: 'project/a.scene.json' }],
      futureRoot: 'preserved-root',
    };

    const { document, warnings } = migrateProjectMetadataV1ToV2(legacyInput);
    const doc = document as Record<string, unknown>;

    expect(doc.projectVersion).toBe(PROJECT_SCHEMA_VERSION_V2);
    expect(doc.name).toBe('Legacy Project');
    expect(typeof doc.projectId).toBe('string');
    expect(doc.defaultSceneId).toBe('scene-a');
    expect(doc.assetRoots).toMatchObject(DEFAULT_PROJECT_ASSET_ROOTS);
    expect(doc.futureRoot).toBe('preserved-root');
    expect(warnings).toContain('Project metadata upgraded from unversioned legacy contract to v2');
  });

  it('preserves unknown properties inside assetRoots, scenes, and templates during migration', () => {
    const v1Input = {
      projectId: 'p1',
      name: 'V1 With Unknowns',
      projectVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      defaultSceneId: 'main',
      scenes: [{
        id: 'main',
        name: 'Main',
        path: 'project/main.scene.json',
        sceneExtra: 'kept',
      }],
      assetRoots: {
        ...DEFAULT_PROJECT_ASSET_ROOTS,
        customExtraRoot: 'extra/path',
      },
      templates: {
        enabledTemplateIds: ['mygo'],
        futureTemplateKey: 'kept-template',
      },
      topLevelUnknown: 999,
    };

    const { document } = migrateProjectMetadataV1ToV2(v1Input);
    const doc = document as Record<string, unknown>;

    expect(doc.topLevelUnknown).toBe(999);
    expect((doc.assetRoots as Record<string, unknown>).customExtraRoot).toBe('extra/path');
    expect((doc.scenes as Array<Record<string, unknown>>)[0].sceneExtra).toBe('kept');
    expect((doc.templates as Record<string, unknown>).futureTemplateKey).toBe('kept-template');
  });

  it('throws and fails detached validation if input is not an object', () => {
    expect(() => migrateProjectMetadataV1ToV2('invalid')).toThrow('expects an object input');
    expect(() => migrateProjectMetadataV1ToV2(null)).toThrow('expects an object input');
  });

  it('throws and fails detached validation if version is unsupported (>1)', () => {
    expect(() => migrateProjectMetadataV1ToV2({ projectVersion: 3 })).toThrow('expects schemaVersion 1 or missing version');
  });

  it('handles and normalizes partial or incomplete fields gracefully', () => {
    const incompleteInput = {
      projectVersion: 1,
      scenes: [{ id: '', name: 'Main', path: 'path' }], // empty id filtered out, falls back to default
    };
    const { document } = migrateProjectMetadataV1ToV2(incompleteInput);
    const doc = document as Record<string, unknown>;
    expect(doc.projectVersion).toBe(PROJECT_SCHEMA_VERSION_V2);
    expect(Array.isArray(doc.scenes)).toBe(true);
  });
});
