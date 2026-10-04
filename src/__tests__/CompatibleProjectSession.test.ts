import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROJECT_ASSET_ROOTS,
  PROJECT_SCHEMA_VERSION_V2,
  type ProjectMetadataV2,
} from '../api/types/project';
import {
  CompatibleProjectSession,
} from '../services/project';

function makeProject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: 'proj-123',
    name: 'Compatible Project',
    projectVersion: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    defaultSceneId: 'main',
    scenes: [{ id: 'main', name: 'Main Scene', path: 'project/main.scene.json' }],
    assetRoots: { ...DEFAULT_PROJECT_ASSET_ROOTS },
    ...overrides,
  };
}

describe('CompatibleProjectSession', () => {
  describe('version classification', () => {
    it('returns ready for a valid projectVersion 2 document', () => {
      const source = makeProject();
      const outcome = CompatibleProjectSession.open(source);

      expect(outcome.status).toBe('ready');
      if (outcome.status !== 'ready') throw new Error('Expected ready');
      expect(outcome.session.projection.projectVersion).toBe(PROJECT_SCHEMA_VERSION_V2);
      expect(outcome.session.projection.name).toBe('Compatible Project');
    });

    it('strips unknown fields from the typed projection while keeping them in session serialization', () => {
      const source = makeProject({
        futureTopLevel: { enabled: true, tier: 'pro' },
        scenes: [{
          id: 'main',
          name: 'Main Scene',
          path: 'project/main.scene.json',
          futureSceneMetadata: 'custom',
        }],
        assetRoots: {
          ...DEFAULT_PROJECT_ASSET_ROOTS,
          futureAssetRoot: 'custom-root',
        },
      });

      const outcome = CompatibleProjectSession.open(source);
      expect(outcome.status).toBe('ready');
      if (outcome.status !== 'ready') throw new Error('Expected ready');

      // Typed projection omits unknown fields
      expect(outcome.session.projection).not.toHaveProperty('futureTopLevel');
      expect((outcome.session.projection.scenes[0] as any)).not.toHaveProperty('futureSceneMetadata');
      expect((outcome.session.projection.assetRoots as any)).not.toHaveProperty('futureAssetRoot');

      // Serialization retains unknown fields
      expect(outcome.session.serialize()).toEqual(source);
    });

    it('returns migration_required for projectVersion 1 metadata and migrates to v2', () => {
      const source = makeProject({
        projectVersion: 1,
        futureField: 'keep-me',
      });

      const outcome = CompatibleProjectSession.open(source);
      expect(outcome.status).toBe('migration_required');
      if (outcome.status !== 'migration_required') throw new Error('Expected migration_required');

      expect(outcome.plan.sourceEpoch).toBe(1);
      expect(outcome.plan.targetEpoch).toBe(PROJECT_SCHEMA_VERSION_V2);

      const result = outcome.plan.migrate();
      expect(result.session.projection.projectVersion).toBe(PROJECT_SCHEMA_VERSION_V2);
      expect((result.document as Record<string, unknown>).projectVersion).toBe(PROJECT_SCHEMA_VERSION_V2);
      expect((result.document as Record<string, unknown>).futureField).toBe('keep-me');
      expect(result.session.serialize()).toHaveProperty('futureField', 'keep-me');
    });

    it('returns migration_required for recognized legacy shape with missing projectVersion', () => {
      const source = {
        projectId: 'legacy-proj',
        name: 'Legacy Project',
        scenes: [{ id: 'main', name: 'Main', path: 'project/main.scene.json' }],
        assetRoots: { ...DEFAULT_PROJECT_ASSET_ROOTS },
        unknownLegacyField: 42,
      };

      const outcome = CompatibleProjectSession.open(source);
      expect(outcome.status).toBe('migration_required');
      if (outcome.status !== 'migration_required') throw new Error('Expected migration_required');

      const result = outcome.plan.migrate();
      expect(result.session.projection.projectVersion).toBe(PROJECT_SCHEMA_VERSION_V2);
      expect(result.session.projection.name).toBe('Legacy Project');
      expect(result.session.serialize()).toHaveProperty('unknownLegacyField', 42);
    });

    it('never assumes missing projectVersion is current; returns invalid for unrecognized structures', () => {
      const invalidUnversioned = {
        unrelatedKey: 'some-value',
        anotherKey: 123,
      };

      const outcome = CompatibleProjectSession.open(invalidUnversioned);
      expect(outcome.status).toBe('invalid');
      if (outcome.status !== 'invalid') throw new Error('Expected invalid');
      expect(outcome.issue.code).toBe('malformed_metadata');
    });

    it('returns incompatible with unsupported_schema_epoch for future projectVersion epochs', () => {
      const futureSource = makeProject({
        projectVersion: 3,
      });

      const outcome = CompatibleProjectSession.open(futureSource);
      expect(outcome.status).toBe('incompatible');
      if (outcome.status !== 'incompatible') throw new Error('Expected incompatible');
      expect(outcome.issue.code).toBe('unsupported_schema_epoch');
      expect(outcome.issue.path).toBe('project.projectVersion');
      expect(outcome.issue.message).toContain('Unsupported project schema epoch 3');
    });

    it('returns invalid for malformed projectVersion (non-integer, negative, string, boolean)', () => {
      for (const badVersion of [0, -1, 1.5, '2', true, null, []]) {
        const source = makeProject({ projectVersion: badVersion });
        const outcome = CompatibleProjectSession.open(source);
        expect(outcome.status).toBe('invalid');
        if (outcome.status !== 'invalid') throw new Error(`Expected invalid for ${badVersion}`);
        expect(outcome.issue.code).toBe('malformed_metadata');
      }
    });

    it('returns invalid for non-object inputs', () => {
      for (const input of [null, undefined, 'string', 123, true, []]) {
        const outcome = CompatibleProjectSession.open(input);
        expect(outcome.status).toBe('invalid');
      }
    });

    it('returns invalid for malformed required fields in v2 project', () => {
      const badProjectId = makeProject({ projectId: '' });
      expect(CompatibleProjectSession.open(badProjectId).status).toBe('invalid');

      const badScenes = makeProject({ scenes: 'not-an-array' });
      expect(CompatibleProjectSession.open(badScenes).status).toBe('invalid');

      const badAssetRoots = makeProject({ assetRoots: { figure: 123 } });
      expect(CompatibleProjectSession.open(badAssetRoots).status).toBe('invalid');
    });
  });

  describe('unknown field preservation through typed edits and round-trips', () => {
    it('preserves top-level and nested unknown fields across typed edits', () => {
      const source = makeProject({
        futureTopLevel: { extra: 1, nested: { flag: true } },
        customPluginSettings: ['plugin-a', 'plugin-b'],
        assetRoots: {
          ...DEFAULT_PROJECT_ASSET_ROOTS,
          customVocalRoot: 'vocal/extra',
        },
        scenes: [{
          id: 'main',
          name: 'Main Scene',
          path: 'project/main.scene.json',
          futureSceneProperty: 'persisted',
        }],
      });

      const outcome = CompatibleProjectSession.open(source);
      expect(outcome.status).toBe('ready');
      if (outcome.status !== 'ready') throw new Error('Expected ready');

      const session = outcome.session;

      // Apply typed edit modifying project name and adding a scene
      const updatedProjection: ProjectMetadataV2 = {
        ...session.projection,
        name: 'Renamed Project',
        scenes: [
          ...session.projection.scenes,
          { id: 'scene-2', name: 'Second Scene', path: 'project/scene2.scene.json' },
        ],
      };

      session.applyTypedEdit(updatedProjection);

      expect(session.projection.name).toBe('Renamed Project');
      expect(session.projection.scenes).toHaveLength(2);

      const serialized = session.serialize() as Record<string, unknown>;
      expect(serialized.name).toBe('Renamed Project');
      expect(serialized.futureTopLevel).toEqual({ extra: 1, nested: { flag: true } });
      expect(serialized.customPluginSettings).toEqual(['plugin-a', 'plugin-b']);
      expect((serialized.assetRoots as Record<string, unknown>).customVocalRoot).toBe('vocal/extra');

      const serializedScenes = serialized.scenes as Array<Record<string, unknown>>;
      expect(serializedScenes[0]).toHaveProperty('futureSceneProperty', 'persisted');
      expect(serializedScenes[1]).toEqual({
        id: 'scene-2',
        name: 'Second Scene',
        path: 'project/scene2.scene.json',
      });
    });

    it('removes unknown fields when the owning entity is deleted', () => {
      const source = makeProject({
        scenes: [
          { id: 'scene-1', name: 'Scene 1', path: 'project/s1.scene.json', unknownSceneData: 'keep' },
          { id: 'scene-2', name: 'Scene 2', path: 'project/s2.scene.json', unknownSceneData: 'remove-with-scene' },
        ],
      });

      const outcome = CompatibleProjectSession.open(source);
      if (outcome.status !== 'ready') throw new Error('Expected ready');

      const session = outcome.session;

      // Remove scene-2
      const updatedProjection: ProjectMetadataV2 = {
        ...session.projection,
        scenes: [session.projection.scenes[0]],
      };

      session.applyTypedEdit(updatedProjection);

      const serialized = session.serialize() as Record<string, unknown>;
      const scenes = serialized.scenes as Array<Record<string, unknown>>;
      expect(scenes).toHaveLength(1);
      expect(scenes[0]).toHaveProperty('unknownSceneData', 'keep');
      expect(JSON.stringify(serialized)).not.toContain('remove-with-scene');
    });

    it('supports undo and redo over typed edits while preserving unknown fields', () => {
      const source = makeProject({
        unknownMetadata: 'original',
      });

      const outcome = CompatibleProjectSession.open(source);
      if (outcome.status !== 'ready') throw new Error('Expected ready');
      const session = outcome.session;

      expect(session.canUndo).toBe(false);

      session.applyTypedEdit({ ...session.projection, name: 'Edit 1' });
      expect(session.canUndo).toBe(true);
      expect(session.projection.name).toBe('Edit 1');
      expect((session.serialize() as any).unknownMetadata).toBe('original');

      session.applyTypedEdit({ ...session.projection, name: 'Edit 2' });
      expect(session.projection.name).toBe('Edit 2');

      expect(session.undo()).toBe(true);
      expect(session.projection.name).toBe('Edit 1');
      expect((session.serialize() as any).unknownMetadata).toBe('original');

      expect(session.undo()).toBe(true);
      expect(session.projection.name).toBe('Compatible Project');
      expect((session.serialize() as any).unknownMetadata).toBe('original');

      expect(session.undo()).toBe(false);

      expect(session.redo()).toBe(true);
      expect(session.projection.name).toBe('Edit 1');

      expect(session.redo()).toBe(true);
      expect(session.projection.name).toBe('Edit 2');
    });

    it('replaces source completely on replaceSource', () => {
      const sourceA = makeProject({ originalKey: 'valA' });
      const outcome = CompatibleProjectSession.open(sourceA);
      if (outcome.status !== 'ready') throw new Error('Expected ready');
      const session = outcome.session;

      const sourceB = makeProject({ name: 'Replaced Project', newKey: 'valB' });
      const replaceOutcome = session.replaceSource(sourceB);

      expect(replaceOutcome.status).toBe('ready');
      expect(session.projection.name).toBe('Replaced Project');
      const serialized = session.serialize() as Record<string, unknown>;
      expect(serialized.newKey).toBe('valB');
      expect(serialized).not.toHaveProperty('originalKey');
    });
  });
});
