import { describe, expect, it, vi } from 'vitest';
import {
  CompatibilityCoordinator,
  ProjectMetadataArtifactCompatibilityAdapter,
  SceneArtifactCompatibilityAdapter,
  type ArtifactCompatibilityAdapter,
  type CoordinatorBackupResolverPort,
  type CoordinatorFileAccessPort,
  type MigrationConfirmationPresenter,
  type MigrationConfirmationRequest,
} from '../services/compatibility';
import { DEFAULT_PROJECT_ASSET_ROOTS } from '../api/types/project';

class MemoryFileAccess implements CoordinatorFileAccessPort {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();

  async readFile(path: string): Promise<{ data: string }> {
    const data = this.files.get(path);
    if (data === undefined) throw new Error(`File not found: ${path}`);
    return { data };
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async copyFile(sourcePath: string, destPath: string): Promise<void> {
    const data = this.files.get(sourcePath);
    if (data === undefined) throw new Error(`Source file not found: ${sourcePath}`);
    this.files.set(destPath, data);
  }

  async ensureDir(path: string): Promise<void> {
    this.dirs.add(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }

  dirname(path: string): string {
    const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return index >= 0 ? path.slice(0, index) : '.';
  }

  basename(path: string): string {
    const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return index >= 0 ? path.slice(index + 1) : path;
  }
}

class MemoryBackupResolver implements CoordinatorBackupResolverPort {
  constructor(private readonly baseDir: string = '/project') {}

  resolveForProjectWrite(relativePath: string): string {
    return `${this.baseDir}/${relativePath}`;
  }
}

function makeV5Scene(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 5,
    sceneId: 'main-scene',
    meta: { title: 'V5 Scene' },
    statements: [
      {
        id: 'dialogue-1',
        time: 0,
        type: 'dialogue',
        params: { text: 'Hello v5', durationSeconds: 2 },
      },
    ],
    ...overrides,
  };
}

function makeV4Scene(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 4,
    sceneId: 'main-scene',
    meta: { title: 'V4 Scene' },
    statements: [
      {
        id: 'dialogue-1',
        time: 0,
        type: 'dialogue',
        params: { text: 'Hello v4', durationSeconds: 2 },
      },
    ],
    ...overrides,
  };
}

function makeV3Scene(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 3,
    sceneId: 'main-scene',
    meta: { title: 'V3 Scene', durationSeconds: 5 },
    statements: [
      {
        id: 'dialogue-1',
        time: 0,
        type: 'dialogue',
        params: { text: 'Hello v3', durationSeconds: 2 },
      },
      {
        id: 'clip-1',
        time: 1,
        type: 'live2dParameterClip',
        params: { durationSeconds: 2 },
      },
    ],
    ...overrides,
  };
}

function makeV2Project(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: 'proj-123',
    name: 'V2 Project',
    projectVersion: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    defaultSceneId: 'main',
    scenes: [{ id: 'main', name: 'Main Scene', path: 'project/main.scene.json' }],
    assetRoots: { ...DEFAULT_PROJECT_ASSET_ROOTS },
    ...overrides,
  };
}

function makeV1Project(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: 'proj-v1',
    name: 'V1 Project',
    projectVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    defaultSceneId: 'main',
    scenes: [{ id: 'main', name: 'Main Scene', path: 'project/main.scene.json' }],
    assetRoots: { ...DEFAULT_PROJECT_ASSET_ROOTS },
    ...overrides,
  };
}

describe('CompatibilityCoordinator', () => {
  const fixedDate = new Date('2026-08-18T10:20:30.000Z');

  describe('Uniform Compatibility Outcomes across Adapters', () => {
    const sceneAdapter = new SceneArtifactCompatibilityAdapter();
    const projectAdapter = new ProjectMetadataArtifactCompatibilityAdapter();

    it('produces ready outcome for same-epoch documents with unknown fields', () => {
      const fileAccess = new MemoryFileAccess();
      const coordinator = new CompatibilityCoordinator({ fileAccess });

      // Scene v5 with unknown fields
      const v5WithUnknowns = makeV5Scene({
        futureSceneConfig: { enableRaytracing: true },
        statements: [
          {
            id: 'dialogue-1',
            time: 0,
            type: 'dialogue',
            params: { text: 'Hello', durationSeconds: 2 },
            futureCompanion: { glow: true },
          },
        ],
      });
      const sceneOutcome = coordinator.inspect(v5WithUnknowns, sceneAdapter);
      expect(sceneOutcome.status).toBe('ready');
      if (sceneOutcome.status !== 'ready') throw new Error('Expected ready');
      expect(sceneOutcome.session.projection.schemaVersion).toBe(5);
      expect(sceneOutcome.session.hasUnknownFields).toBe(true);
      expect(sceneOutcome.session.serialize()).toEqual(v5WithUnknowns);

      // Project v2 with unknown fields
      const v2WithUnknowns = makeV2Project({
        futureTopLevelSetting: 'custom-val',
      });
      const projectOutcome = coordinator.inspect(v2WithUnknowns, projectAdapter);
      expect(projectOutcome.status).toBe('ready');
      if (projectOutcome.status !== 'ready') throw new Error('Expected ready');
      expect(projectOutcome.session.projection.projectVersion).toBe(2);
      expect(projectOutcome.session.serialize()).toEqual(v2WithUnknowns);
    });

    it('produces migration_required outcome with executable migration plans', () => {
      const fileAccess = new MemoryFileAccess();
      const coordinator = new CompatibilityCoordinator({ fileAccess });

      // Scene v4
      const v4Scene = makeV4Scene({ futureNote: 'keep' });
      const sceneOutcome = coordinator.inspect(v4Scene, sceneAdapter);
      expect(sceneOutcome.status).toBe('migration_required');
      if (sceneOutcome.status !== 'migration_required') throw new Error('Expected migration_required');
      expect(sceneOutcome.plan.sourceEpoch).toBe(4);
      expect(sceneOutcome.plan.targetEpoch).toBe(5);
      expect(sceneOutcome.plan.stages).toEqual(['v4_to_v5']);
      const migratedScene = sceneOutcome.plan.migrate();
      expect(migratedScene.session.projection.schemaVersion).toBe(5);
      expect(migratedScene.session.serialize()).toHaveProperty('futureNote', 'keep');

      // Project v1
      const v1Proj = makeV1Project({ futureSetting: 123 });
      const projectOutcome = coordinator.inspect(v1Proj, projectAdapter);
      expect(projectOutcome.status).toBe('migration_required');
      if (projectOutcome.status !== 'migration_required') throw new Error('Expected migration_required');
      expect(projectOutcome.plan.sourceEpoch).toBe(1);
      expect(projectOutcome.plan.targetEpoch).toBe(2);
      const migratedProject = projectOutcome.plan.migrate();
      expect(migratedProject.session.projection.projectVersion).toBe(2);
      expect(migratedProject.session.serialize()).toHaveProperty('futureSetting', 123);
    });

    it('produces incompatible outcome with structured issues for unsupported epochs and discriminators', () => {
      const fileAccess = new MemoryFileAccess();
      const coordinator = new CompatibilityCoordinator({ fileAccess });

      // Scene v2 (offline migration required)
      const v2SceneOutcome = coordinator.inspect({ schemaVersion: 2, sceneId: 's', statements: [] }, sceneAdapter);
      expect(v2SceneOutcome.status).toBe('incompatible');
      if (v2SceneOutcome.status !== 'incompatible') throw new Error('Expected incompatible');
      expect(v2SceneOutcome.issue.code).toBe('unsupported_schema_epoch');

      // Scene future epoch v6+
      const v6SceneOutcome = coordinator.inspect({ schemaVersion: 6, sceneId: 's', statements: [] }, sceneAdapter);
      expect(v6SceneOutcome.status).toBe('incompatible');
      if (v6SceneOutcome.status !== 'incompatible') throw new Error('Expected incompatible');
      expect(v6SceneOutcome.issue.code).toBe('unsupported_schema_epoch');

      // Scene unknown statement discriminator
      const unknownStatementOutcome = coordinator.inspect(
        makeV5Scene({ statements: [{ id: '1', time: 0, type: 'unknownCustomStatement', params: {} }] }),
        sceneAdapter,
      );
      expect(unknownStatementOutcome.status).toBe('incompatible');
      if (unknownStatementOutcome.status !== 'incompatible') throw new Error('Expected incompatible');
      expect(unknownStatementOutcome.issue.code).toBe('unknown_discriminator');

      // Project future epoch v3+
      const v3ProjectOutcome = coordinator.inspect(
        { projectVersion: 3, projectId: 'p', name: 'P', scenes: [], assetRoots: {} },
        projectAdapter,
      );
      expect(v3ProjectOutcome.status).toBe('incompatible');
      if (v3ProjectOutcome.status !== 'incompatible') throw new Error('Expected incompatible');
      expect(v3ProjectOutcome.issue.code).toBe('unsupported_schema_epoch');
    });

    it('produces invalid outcome with structured issues for malformed artifacts', () => {
      const fileAccess = new MemoryFileAccess();
      const coordinator = new CompatibilityCoordinator({ fileAccess });

      // Scene missing schemaVersion
      const sceneOutcome = coordinator.inspect({ sceneId: 's', statements: [] }, sceneAdapter);
      expect(sceneOutcome.status).toBe('invalid');
      if (sceneOutcome.status !== 'invalid') throw new Error('Expected invalid');
      expect(sceneOutcome.issue.code).toBe('malformed_scene');

      // Project invalid projectVersion
      const projectOutcome = coordinator.inspect({ projectVersion: -9 }, projectAdapter);
      expect(projectOutcome.status).toBe('invalid');
      if (projectOutcome.status !== 'invalid') throw new Error('Expected invalid');
      expect(projectOutcome.issue.code).toBe('malformed_metadata');
    });
  });

  describe('Scene Gated Migration Policy Admission', () => {
    const sceneAdapter = new SceneArtifactCompatibilityAdapter();
    const backupResolver = new MemoryBackupResolver('/project');

    it('admits ready scene directly without backup or confirmation prompt', async () => {
      const fileAccess = new MemoryFileAccess();
      const confirmMigration = vi.fn(async () => true);
      const coordinator = new CompatibilityCoordinator({
        fileAccess,
        backupResolver,
        confirmMigration,
        now: () => fixedDate,
      });

      const scenePath = '/project/scenes/main.scene.json';
      await fileAccess.writeFile(scenePath, JSON.stringify(makeV5Scene(), null, 2));

      const outcome = await coordinator.admit(scenePath, sceneAdapter);
      expect(outcome.status).toBe('ready');
      if (outcome.status !== 'ready') throw new Error('Expected ready');
      expect(outcome.migrated).toBe(false);
      expect(outcome.session.projection.schemaVersion).toBe(5);
      expect(confirmMigration).not.toHaveBeenCalled();
      expect(fileAccess.files.size).toBe(1); // No backup created
    });

    it('performs gated v4 to v5 migration: creates backup, prompts user, upgrades in-place on confirm', async () => {
      const fileAccess = new MemoryFileAccess();
      let capturedRequest: MigrationConfirmationRequest | null = null;
      const confirmMigration = vi.fn(async (req: MigrationConfirmationRequest) => {
        capturedRequest = req;
        return true;
      });

      const coordinator = new CompatibilityCoordinator({
        fileAccess,
        backupResolver,
        confirmMigration,
        now: () => fixedDate,
      });

      const scenePath = '/project/scenes/main.scene.json';
      await fileAccess.writeFile(scenePath, JSON.stringify(makeV4Scene(), null, 2));

      const outcome = await coordinator.admit(scenePath, sceneAdapter);
      expect(outcome.status).toBe('migrated');
      if (outcome.status !== 'migrated') throw new Error('Expected migrated');
      expect(outcome.migrated).toBe(true);
      expect(outcome.sourceEpoch).toBe(4);
      expect(outcome.targetEpoch).toBe(5);
      expect(outcome.backupPath).toBe('/project/.aeonstagery/backups/2026-08-18T10-20-30-000Z/main.scene.json');

      expect(confirmMigration).toHaveBeenCalledTimes(1);
      expect(capturedRequest).toMatchObject({
        artifactPath: scenePath,
        backupPath: '/project/.aeonstagery/backups/2026-08-18T10-20-30-000Z/main.scene.json',
        sourceEpoch: 4,
        targetEpoch: 5,
        stages: ['v4_to_v5'],
        artifactKind: 'scene',
      });

      // Backup contains original v4 content
      const backup = JSON.parse(fileAccess.files.get(outcome.backupPath!)!);
      expect(backup.schemaVersion).toBe(4);

      // Target scene upgraded in-place to v5
      const upgraded = JSON.parse(fileAccess.files.get(scenePath)!);
      expect(upgraded.schemaVersion).toBe(5);
    });

    it('cancels migration and preserves original file on disk when user declines', async () => {
      const fileAccess = new MemoryFileAccess();
      const confirmMigration = vi.fn(async () => false); // User declines

      const coordinator = new CompatibilityCoordinator({
        fileAccess,
        backupResolver,
        confirmMigration,
        now: () => fixedDate,
      });

      const scenePath = '/project/scenes/main.scene.json';
      const originalV4 = JSON.stringify(makeV4Scene(), null, 2);
      await fileAccess.writeFile(scenePath, originalV4);

      const outcome = await coordinator.admit(scenePath, sceneAdapter);
      expect(outcome.status).toBe('cancelled');
      if (outcome.status !== 'cancelled') throw new Error('Expected cancelled');
      expect(outcome.reason).toBe('declined');

      // Backup was created
      expect(fileAccess.files.has('/project/.aeonstagery/backups/2026-08-18T10-20-30-000Z/main.scene.json')).toBe(true);
      // Original file remains unchanged
      expect(fileAccess.files.get(scenePath)).toBe(originalV4);
    });

    it('performs composed v3 to v5 migration: creates single backup, prompts once with aggregated warnings', async () => {
      const fileAccess = new MemoryFileAccess();
      let capturedRequest: MigrationConfirmationRequest | null = null;
      const confirmMigration = vi.fn(async (req: MigrationConfirmationRequest) => {
        capturedRequest = req;
        return true;
      });

      const coordinator = new CompatibilityCoordinator({
        fileAccess,
        backupResolver,
        confirmMigration,
        now: () => fixedDate,
      });

      const scenePath = '/project/scenes/intro.scene.json';
      await fileAccess.writeFile(scenePath, JSON.stringify(makeV3Scene(), null, 2));

      const outcome = await coordinator.admit(scenePath, sceneAdapter);
      expect(outcome.status).toBe('migrated');
      if (outcome.status !== 'migrated') throw new Error('Expected migrated');
      expect(outcome.sourceEpoch).toBe(3);
      expect(outcome.targetEpoch).toBe(5);
      expect(outcome.stages).toEqual(['v3_to_v4', 'v4_to_v5']);

      expect(confirmMigration).toHaveBeenCalledTimes(1);
      expect((capturedRequest as MigrationConfirmationRequest | null)?.warnings.some((w) => w.includes('clip-1'))).toBe(true);

      const upgraded = JSON.parse(fileAccess.files.get(scenePath)!);
      expect(upgraded.schemaVersion).toBe(5);
      expect(upgraded.statements).toHaveLength(1);
    });

    it('rejects unsupported epochs without creating backup or prompting user', async () => {
      const fileAccess = new MemoryFileAccess();
      const confirmMigration = vi.fn(async () => true);

      const coordinator = new CompatibilityCoordinator({
        fileAccess,
        backupResolver,
        confirmMigration,
        now: () => fixedDate,
      });

      const scenePath = '/project/scenes/v2.scene.json';
      const v2Content = JSON.stringify({ schemaVersion: 2, sceneId: 'v2', statements: [] }, null, 2);
      await fileAccess.writeFile(scenePath, v2Content);

      const outcome = await coordinator.admit(scenePath, sceneAdapter);
      expect(outcome.status).toBe('incompatible');
      if (outcome.status !== 'incompatible') throw new Error('Expected incompatible');
      expect(outcome.issue.code).toBe('unsupported_schema_epoch');
      expect(confirmMigration).not.toHaveBeenCalled();
      expect(fileAccess.files.size).toBe(1); // No backup created
      expect(fileAccess.files.get(scenePath)).toBe(v2Content);
    });
  });

  describe('Project Metadata Automatic Migration Policy Admission', () => {
    const projectAdapter = new ProjectMetadataArtifactCompatibilityAdapter();

    it('admits v2 project directly as ready without modifying disk', async () => {
      const fileAccess = new MemoryFileAccess();
      const coordinator = new CompatibilityCoordinator({ fileAccess });

      const projectPath = '/project/project.json';
      const v2Content = JSON.stringify(makeV2Project(), null, 2);
      await fileAccess.writeFile(projectPath, v2Content);

      const outcome = await coordinator.admit(projectPath, projectAdapter);
      expect(outcome.status).toBe('ready');
      if (outcome.status !== 'ready') throw new Error('Expected ready');
      expect(outcome.migrated).toBe(false);
      expect(outcome.session.projection.projectVersion).toBe(2);
      expect(fileAccess.files.get(projectPath)).toBe(v2Content);
    });

    it('automatically upgrades v1 metadata to v2 on disk immediately without prompt or backup', async () => {
      const fileAccess = new MemoryFileAccess();
      const confirmMigration = vi.fn(async () => true);
      const coordinator = new CompatibilityCoordinator({
        fileAccess,
        confirmMigration,
      });

      const projectPath = '/project/project.json';
      const v1Content = JSON.stringify(makeV1Project({ customFutureFlag: 'preserved' }), null, 2);
      await fileAccess.writeFile(projectPath, v1Content);

      const outcome = await coordinator.admit(projectPath, projectAdapter);
      expect(outcome.status).toBe('migrated');
      if (outcome.status !== 'migrated') throw new Error('Expected migrated');
      expect(outcome.migrated).toBe(true);
      expect(outcome.sourceEpoch).toBe(1);
      expect(outcome.targetEpoch).toBe(2);
      expect(confirmMigration).not.toHaveBeenCalled(); // Automatic policy does NOT prompt

      // Verify file overwritten on disk with v2 schema and unknown fields retained
      const written = JSON.parse(fileAccess.files.get(projectPath)!);
      expect(written.projectVersion).toBe(2);
      expect(written.customFutureFlag).toBe('preserved');
    });

    it('automatically upgrades legacy unversioned metadata to v2 on disk', async () => {
      const fileAccess = new MemoryFileAccess();
      const coordinator = new CompatibilityCoordinator({ fileAccess });

      const projectPath = '/project/project.json';
      const legacyContent = JSON.stringify({
        projectId: 'legacy-proj',
        name: 'Legacy Project',
        scenes: [{ id: 'main', name: 'Main', path: 'project/main.scene.json' }],
        assetRoots: { ...DEFAULT_PROJECT_ASSET_ROOTS },
        legacyFlag: true,
      }, null, 2);
      await fileAccess.writeFile(projectPath, legacyContent);

      const outcome = await coordinator.admit(projectPath, projectAdapter);
      expect(outcome.status).toBe('migrated');
      if (outcome.status !== 'migrated') throw new Error('Expected migrated');
      expect(outcome.session.projection.projectVersion).toBe(2);
      expect(outcome.session.projection.name).toBe('Legacy Project');

      const written = JSON.parse(fileAccess.files.get(projectPath)!);
      expect(written.projectVersion).toBe(2);
      expect(written.legacyFlag).toBe(true);
    });

    it('rejects future projectVersion (v3+) as incompatible without disk modification', async () => {
      const fileAccess = new MemoryFileAccess();
      const coordinator = new CompatibilityCoordinator({ fileAccess });

      const projectPath = '/project/project.json';
      const v3Content = JSON.stringify({
        projectId: 'future-proj',
        name: 'Future Project',
        projectVersion: 3,
        scenes: [],
        assetRoots: {},
      }, null, 2);
      await fileAccess.writeFile(projectPath, v3Content);

      const outcome = await coordinator.admit(projectPath, projectAdapter);
      expect(outcome.status).toBe('incompatible');
      if (outcome.status !== 'incompatible') throw new Error('Expected incompatible');
      expect(outcome.issue.code).toBe('unsupported_schema_epoch');
      expect(fileAccess.files.get(projectPath)).toBe(v3Content);
    });

    it('rejects malformed project metadata as invalid without disk modification', async () => {
      const fileAccess = new MemoryFileAccess();
      const coordinator = new CompatibilityCoordinator({ fileAccess });

      const projectPath = '/project/project.json';
      const malformed = JSON.stringify({ projectVersion: 'not-a-number' }, null, 2);
      await fileAccess.writeFile(projectPath, malformed);

      const outcome = await coordinator.admit(projectPath, projectAdapter);
      expect(outcome.status).toBe('invalid');
      if (outcome.status !== 'invalid') throw new Error('Expected invalid');
      expect(outcome.issue.code).toBe('malformed_metadata');
      expect(fileAccess.files.get(projectPath)).toBe(malformed);
    });
  });

  describe('Non-existent and Malformed File Handling', () => {
    const sceneAdapter = new SceneArtifactCompatibilityAdapter();

    it('returns invalid outcome when file does not exist', async () => {
      const fileAccess = new MemoryFileAccess();
      const coordinator = new CompatibilityCoordinator({ fileAccess });

      const outcome = await coordinator.admit('/nonexistent/scene.json', sceneAdapter);
      expect(outcome.status).toBe('invalid');
      if (outcome.status !== 'invalid') throw new Error('Expected invalid');
      expect(outcome.issue.code).toBe('malformed_scene');
      expect(outcome.issue.message).toContain('does not exist');
    });

    it('returns invalid outcome when file contains invalid JSON', async () => {
      const fileAccess = new MemoryFileAccess();
      const coordinator = new CompatibilityCoordinator({ fileAccess });

      const scenePath = '/project/corrupt.scene.json';
      await fileAccess.writeFile(scenePath, '{ not valid json');

      const outcome = await coordinator.admit(scenePath, sceneAdapter);
      expect(outcome.status).toBe('invalid');
      if (outcome.status !== 'invalid') throw new Error('Expected invalid');
      expect(outcome.issue.code).toBe('malformed_scene');
    });

    it('returns invalid and leaves the file untouched when migration plan execution throws', async () => {
      const fileAccess = new MemoryFileAccess();
      const coordinator = new CompatibilityCoordinator({ fileAccess });
      const scenePath = '/project/scene.scene.json';
      const original = JSON.stringify(makeV5Scene(), null, 2);
      await fileAccess.writeFile(scenePath, original);

      const throwingAdapter: ArtifactCompatibilityAdapter<unknown, unknown, unknown> = {
        artifactKind: 'scene',
        migrationPolicy: 'gated',
        inspect: () => ({
          status: 'migration_required',
          plan: {
            sourceEpoch: 4,
            targetEpoch: 5,
            stages: ['v4_to_v5'],
            warnings: [],
            migrate: () => {
              throw new Error('migration exploded');
            },
          },
        }),
        serialize: (session) => session,
        createInvalidIssue: (message) => ({ code: 'malformed_scene', message }),
      };

      const outcome = await coordinator.admit(scenePath, throwingAdapter);
      expect(outcome.status).toBe('invalid');
      if (outcome.status !== 'invalid') throw new Error('Expected invalid');
      expect(outcome.issue.message).toContain('migration exploded');
      expect(fileAccess.files.get(scenePath)).toBe(original);
    });
  });

  describe('MigrationConfirmationAdapter interaction', () => {
    const sceneAdapter = new SceneArtifactCompatibilityAdapter();
    const backupResolver = new MemoryBackupResolver('/project');

    it('works with presenter and adapter callbacks', async () => {
      const fileAccess = new MemoryFileAccess();
      let shownRequest: MigrationConfirmationRequest | null = null;
      const presenter: MigrationConfirmationPresenter = {
        show: (req) => { shownRequest = req; },
        clear: () => { shownRequest = null; },
      };

      const coordinator = new CompatibilityCoordinator({
        fileAccess,
        backupResolver,
        confirmationPresenter: presenter,
        now: () => fixedDate,
      });

      const scenePath = '/project/scenes/main.scene.json';
      await fileAccess.writeFile(scenePath, JSON.stringify(makeV4Scene(), null, 2));

      const admitPromise = coordinator.admit(scenePath, sceneAdapter);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(shownRequest).not.toBeNull();
      expect(shownRequest!.sourceEpoch).toBe(4);

      coordinator.confirmation?.complete(true);

      const outcome = await admitPromise;
      expect(outcome.status).toBe('migrated');
      expect(shownRequest).toBeNull();
    });
  });
});
