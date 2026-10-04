import { describe, expect, it, vi } from 'vitest';
import {
  SceneMigrationConfirmationPresenterHost,
  SceneMigrationExperience,
  type SceneMigrationConfirmationPresenter,
  type SceneMigrationConfirmationRequest,
  type SceneMigrationFileAccessPort,
  type SceneMigrationProjectResourcePort,
} from '../services/semantic-scene/SceneMigrationExperience';

class MemoryFileAccess implements SceneMigrationFileAccessPort {
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

class MemoryProjectResources implements SceneMigrationProjectResourcePort {
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

describe('SceneMigrationExperience', () => {
  const fixedDate = new Date('2026-08-18T10:20:30.000Z');

  it('opens a v5 scene directly as ready without backup or confirmation prompt', async () => {
    const fileAccess = new MemoryFileAccess();
    const projectResources = new MemoryProjectResources();
    const confirmMigration = vi.fn(async () => true);

    const scenePath = '/project/scenes/main.scene.json';
    const originalContent = JSON.stringify(makeV5Scene(), null, 2);
    await fileAccess.writeFile(scenePath, originalContent);

    const experience = new SceneMigrationExperience({
      fileAccess,
      projectResources,
      confirmMigration,
      now: () => fixedDate,
    });

    const result = await experience.openScene(scenePath);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Expected ready');
    expect(result.migrated).toBe(false);
    expect(result.session.projection.schemaVersion).toBe(5);
    expect(confirmMigration).not.toHaveBeenCalled();
    expect(fileAccess.files.size).toBe(1); // No backup created
  });

  it('performs guarded v4 to v5 migration: creates backup, prompts user, upgrades in-place on confirm', async () => {
    const fileAccess = new MemoryFileAccess();
    const projectResources = new MemoryProjectResources();
    let capturedRequest: SceneMigrationConfirmationRequest | null = null;
    const confirmMigration = vi.fn(async (request: SceneMigrationConfirmationRequest) => {
      capturedRequest = request;
      return true;
    });

    const scenePath = '/project/scenes/main.scene.json';
    const originalContent = JSON.stringify(makeV4Scene(), null, 2);
    await fileAccess.writeFile(scenePath, originalContent);

    const experience = new SceneMigrationExperience({
      fileAccess,
      projectResources,
      confirmMigration,
      now: () => fixedDate,
    });

    const result = await experience.openScene(scenePath);
    expect(result.status).toBe('migrated');
    if (result.status !== 'migrated') throw new Error('Expected migrated');
    expect(result.migrated).toBe(true);
    expect(result.sourceEpoch).toBe(4);
    expect(result.targetEpoch).toBe(5);
    expect(result.backupPath).toBe('/project/.aeonstagery/backups/2026-08-18T10-20-30-000Z/main.scene.json');

    // Verify confirmation request
    expect(confirmMigration).toHaveBeenCalledTimes(1);
    expect(capturedRequest).toMatchObject({
      scenePath,
      backupPath: '/project/.aeonstagery/backups/2026-08-18T10-20-30-000Z/main.scene.json',
      sourceEpoch: 4,
      targetEpoch: 5,
      stages: ['v4_to_v5'],
      warnings: [],
    });

    // Verify backup contains the original v4 content
    const backupContent = fileAccess.files.get('/project/.aeonstagery/backups/2026-08-18T10-20-30-000Z/main.scene.json');
    expect(JSON.parse(backupContent!)).toMatchObject({ schemaVersion: 4 });

    // Verify target file was upgraded in-place to v5
    const upgradedContent = fileAccess.files.get(scenePath);
    expect(JSON.parse(upgradedContent!)).toMatchObject({ schemaVersion: 5 });
    expect(result.session.projection.schemaVersion).toBe(5);
  });

  it('cancels migration and leaves original file untouched when user declines', async () => {
    const fileAccess = new MemoryFileAccess();
    const projectResources = new MemoryProjectResources();
    const confirmMigration = vi.fn(async () => false); // User declines

    const scenePath = '/project/scenes/main.scene.json';
    const originalContent = JSON.stringify(makeV4Scene(), null, 2);
    await fileAccess.writeFile(scenePath, originalContent);

    const experience = new SceneMigrationExperience({
      fileAccess,
      projectResources,
      confirmMigration,
      now: () => fixedDate,
    });

    const result = await experience.openScene(scenePath);
    expect(result.status).toBe('cancelled');
    if (result.status !== 'cancelled') throw new Error('Expected cancelled');
    expect(result.reason).toBe('declined');

    // Backup was created before prompt
    expect(fileAccess.files.has('/project/.aeonstagery/backups/2026-08-18T10-20-30-000Z/main.scene.json')).toBe(true);

    // Original file remains unchanged as v4
    const currentContent = fileAccess.files.get(scenePath);
    expect(JSON.parse(currentContent!)).toMatchObject({ schemaVersion: 4 });
  });

  it('performs composed v3 to v5 migration: creates 1 backup, asks once, aggregates warnings, upgrades in-place', async () => {
    const fileAccess = new MemoryFileAccess();
    const projectResources = new MemoryProjectResources();
    let capturedRequest: SceneMigrationConfirmationRequest | null = null;
    const confirmMigration = vi.fn(async (request: SceneMigrationConfirmationRequest) => {
      capturedRequest = request;
      return true;
    });

    const scenePath = '/project/scenes/chapter1.scene.json';
    const originalContent = JSON.stringify(makeV3Scene(), null, 2);
    await fileAccess.writeFile(scenePath, originalContent);

    const experience = new SceneMigrationExperience({
      fileAccess,
      projectResources,
      confirmMigration,
      now: () => fixedDate,
    });

    const result = await experience.openScene(scenePath);
    expect(result.status).toBe('migrated');
    if (result.status !== 'migrated') throw new Error('Expected migrated');
    expect(result.sourceEpoch).toBe(3);
    expect(result.targetEpoch).toBe(5);
    expect(result.backupPath).toBe('/project/.aeonstagery/backups/2026-08-18T10-20-30-000Z/chapter1.scene.json');

    // Confirm was called only once with composed stages and aggregated warnings
    expect(confirmMigration).toHaveBeenCalledTimes(1);
    expect(capturedRequest).toMatchObject({
      scenePath,
      sourceEpoch: 3,
      targetEpoch: 5,
      stages: ['v3_to_v4', 'v4_to_v5'],
    });
    expect(capturedRequest!.warnings.length).toBeGreaterThan(0);
    expect(capturedRequest!.warnings.some((w) => w.includes('Removed live2dParameterClip statement "clip-1"'))).toBe(true);

    // Backup has original v3 content
    const backupContent = fileAccess.files.get('/project/.aeonstagery/backups/2026-08-18T10-20-30-000Z/chapter1.scene.json');
    expect(JSON.parse(backupContent!)).toMatchObject({ schemaVersion: 3 });

    // Scene file upgraded in-place to v5 with clip dropped
    const upgraded = JSON.parse(fileAccess.files.get(scenePath)!);
    expect(upgraded.schemaVersion).toBe(5);
    expect(upgraded.statements).toHaveLength(1);
    expect(upgraded.statements[0].id).toBe('dialogue-1');
  });

  it('rejects offline-migration versions (v1, v2) with actionable diagnostics and leaves file untouched', async () => {
    const fileAccess = new MemoryFileAccess();
    const projectResources = new MemoryProjectResources();
    const confirmMigration = vi.fn(async () => true);

    const scenePath = '/project/scenes/v2.scene.json';
    const v2Content = JSON.stringify({ schemaVersion: 2, sceneId: 'v2', statements: [] }, null, 2);
    await fileAccess.writeFile(scenePath, v2Content);

    const experience = new SceneMigrationExperience({
      fileAccess,
      projectResources,
      confirmMigration,
      now: () => fixedDate,
    });

    const result = await experience.openScene(scenePath);
    expect(result.status).toBe('incompatible');
    if (result.status !== 'incompatible') throw new Error('Expected incompatible');
    expect(result.issue.code).toBe('unsupported_schema_epoch');
    expect(result.issue.message).toContain('offline migration');
    expect(confirmMigration).not.toHaveBeenCalled();
    // Original file untouched
    expect(fileAccess.files.get(scenePath)).toBe(v2Content);
  });

  it('rejects future versions (v6+) as incompatible and leaves file untouched', async () => {
    const fileAccess = new MemoryFileAccess();
    const projectResources = new MemoryProjectResources();

    const scenePath = '/project/scenes/future.scene.json';
    const v6Content = JSON.stringify({ schemaVersion: 6, sceneId: 'v6', statements: [] }, null, 2);
    await fileAccess.writeFile(scenePath, v6Content);

    const experience = new SceneMigrationExperience({
      fileAccess,
      projectResources,
      now: () => fixedDate,
    });

    const result = await experience.openScene(scenePath);
    expect(result.status).toBe('incompatible');
    if (result.status !== 'incompatible') throw new Error('Expected incompatible');
    expect(result.issue.code).toBe('unsupported_schema_epoch');
    expect(fileAccess.files.get(scenePath)).toBe(v6Content);
  });

  it('returns invalid for malformed or missing schemaVersion and leaves file untouched', async () => {
    const fileAccess = new MemoryFileAccess();
    const projectResources = new MemoryProjectResources();

    const scenePath = '/project/scenes/missing.scene.json';
    const unversionedContent = JSON.stringify({ sceneId: 'no-version', statements: [] }, null, 2);
    await fileAccess.writeFile(scenePath, unversionedContent);

    const experience = new SceneMigrationExperience({
      fileAccess,
      projectResources,
      now: () => fixedDate,
    });

    const result = await experience.openScene(scenePath);
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('Expected invalid');
    expect(result.issue.code).toBe('malformed_scene');
    expect(result.issue.message).toContain('missing schemaVersion');
    expect(fileAccess.files.get(scenePath)).toBe(unversionedContent);
  });

  it('returns incompatible when v4 scene has unknown discriminators before backup or prompt', async () => {
    const fileAccess = new MemoryFileAccess();
    const projectResources = new MemoryProjectResources();
    const confirmMigration = vi.fn(async () => true);

    const scenePath = '/project/scenes/invalid-v4.scene.json';
    const invalidV4 = JSON.stringify(makeV4Scene({
      statements: [{ id: '1', time: 0, type: 'unknownFamily', params: {} }],
    }), null, 2);
    await fileAccess.writeFile(scenePath, invalidV4);

    const experience = new SceneMigrationExperience({
      fileAccess,
      projectResources,
      confirmMigration,
      now: () => fixedDate,
    });

    const result = await experience.openScene(scenePath);
    expect(result.status).toBe('incompatible');
    if (result.status !== 'incompatible') throw new Error('Expected incompatible');
    expect(result.issue.code).toBe('unknown_discriminator');
    expect(confirmMigration).not.toHaveBeenCalled();
    expect(fileAccess.files.size).toBe(1); // No backup created
    expect(fileAccess.files.get(scenePath)).toBe(invalidV4);
  });

  it('works with SceneMigrationConfirmationPresenter and SceneMigrationConfirmationAdapter', async () => {
    const fileAccess = new MemoryFileAccess();
    const projectResources = new MemoryProjectResources();

    let shownRequest: SceneMigrationConfirmationRequest | null = null;
    const presenter: SceneMigrationConfirmationPresenter = {
      show: (req) => { shownRequest = req; },
      clear: () => { shownRequest = null; },
    };

    const scenePath = '/project/scenes/main.scene.json';
    await fileAccess.writeFile(scenePath, JSON.stringify(makeV4Scene(), null, 2));

    const experience = new SceneMigrationExperience({
      fileAccess,
      projectResources,
      confirmationPresenter: presenter,
      now: () => fixedDate,
    });

    const openPromise = experience.openScene(scenePath);
    // Give async task a tick
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(shownRequest).not.toBeNull();
    expect(shownRequest!.sourceEpoch).toBe(4);

    // Complete the confirmation
    experience.confirmation?.complete(true);

    const result = await openPromise;
    expect(result.status).toBe('migrated');
    expect(shownRequest).toBeNull(); // Presenter was cleared
  });

  it('delivers a pending migration request once a presenter handler is registered', () => {
    const host = new SceneMigrationConfirmationPresenterHost();
    const request: SceneMigrationConfirmationRequest = {
      scenePath: '/project/scenes/main.scene.json',
      backupPath: '/project/.aeonstagery/backups/main.scene.json',
      sourceEpoch: 4,
      targetEpoch: 5,
      stages: ['v4_to_v5'],
      warnings: [],
    };

    host.show(request);

    let shownRequest: SceneMigrationConfirmationRequest | null = null;
    const handler: SceneMigrationConfirmationPresenter = {
      show: (req) => { shownRequest = req; },
      clear: () => { shownRequest = null; },
    };
    host.setHandler(handler);

    expect(shownRequest).toBe(request);
  });
});
