import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PROJECT_COMPATIBILITY_ENVELOPE_SCHEMA_VERSION,
  PROJECT_COMPATIBILITY_ENVELOPE_FILE_NAME,
  PROJECT_SCHEMA_VERSION_V2,
  type ProjectMetadata,
  type ProjectState,
} from '../api/types/project';
import {
  ProjectCompatibilityEnvelopeService,
  calculateSourceHash,
} from '../services/project';
import { CompatibleSceneSession } from '../services/semantic-scene';
import { ProjectResourceService } from '../services/io/ProjectResourceService';
import { ProjectPathResolver } from '../services/io/ProjectPathResolver';
import type { IFileAccess } from '../services/io/IFileAccess';

function makeScene(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 5,
    sceneId: 'scene-main',
    meta: {
      title: 'Main Scene',
    },
    statements: [
      {
        id: 'stmt-1',
        time: 0,
        type: 'dialogue',
        params: {
          speakerId: 'char-1',
          text: 'Hello, world!',
          durationSeconds: 2,
        },
      },
    ],
    ...overrides,
  };
}

function makeProjectMetadata(overrides: Partial<ProjectMetadata> = {}): ProjectMetadata {
  return {
    projectId: 'proj-envelope-test',
    name: 'Envelope Test Project',
    projectVersion: PROJECT_SCHEMA_VERSION_V2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    defaultSceneId: 'main',
    scenes: [
      { id: 'main', name: 'Main Scene', path: 'project/main.scene.json' },
    ],
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
    ...overrides,
  };
}

describe('ProjectCompatibilityEnvelope', () => {
  describe('CompatibleSceneSession.detectUnknownFields', () => {
    it('returns false for a clean v5 scene document', () => {
      const cleanScene = makeScene();
      expect(CompatibleSceneSession.detectUnknownFields(cleanScene)).toBe(false);

      const outcome = CompatibleSceneSession.open(cleanScene);
      expect(outcome.status).toBe('ready');
      if (outcome.status !== 'ready') throw new Error('Expected ready');
      expect(outcome.session.hasUnknownFields).toBe(false);
    });

    it('returns true when unknown fields are present at the root, metadata, or statements', () => {
      const sceneWithRootUnknown = makeScene({ futureRootField: 'extra' });
      expect(CompatibleSceneSession.detectUnknownFields(sceneWithRootUnknown)).toBe(true);

      const sceneWithMetaUnknown = makeScene({
        meta: { title: 'Main', customMetaProp: 123 },
      });
      expect(CompatibleSceneSession.detectUnknownFields(sceneWithMetaUnknown)).toBe(true);

      const sceneWithStmtUnknown = makeScene({
        statements: [
          {
            id: 'stmt-1',
            time: 0,
            type: 'dialogue',
            params: { speakerId: 'char-1', text: 'Hello', durationSeconds: 2, extraParam: true },
          },
        ],
      });
      expect(CompatibleSceneSession.detectUnknownFields(sceneWithStmtUnknown)).toBe(true);
    });

    it('detects unknown fields on a CompatibleSceneSession instance and survives typed edits', () => {
      const sceneWithUnknown = makeScene({
        meta: { title: 'Initial Title', preservedField: 42 },
      });
      const outcome = CompatibleSceneSession.open(sceneWithUnknown);
      expect(outcome.status).toBe('ready');
      if (outcome.status !== 'ready') throw new Error('Expected ready');

      const session = outcome.session;
      expect(session.hasUnknownFields).toBe(true);
      expect(CompatibleSceneSession.detectUnknownFields(session)).toBe(true);

      // Perform a typed edit
      session.applyTypedEdit({
        ...session.projection,
        meta: { ...session.projection.meta, title: 'Updated Title' },
      });

      expect(session.hasUnknownFields).toBe(true);
      expect(session.serialize()).toHaveProperty('meta.preservedField', 42);
    });
  });

  describe('ProjectCompatibilityEnvelopeService: buildEnvelope & validateEnvelope', () => {
    let fileStore: Map<string, string>;
    let fileAccessMock: any;
    let envelopeService: ProjectCompatibilityEnvelopeService;

    beforeEach(() => {
      fileStore = new Map();
      fileAccessMock = {
        readFile: vi.fn(async (p: string) => {
          const norm = p.replace(/\\/g, '/');
          if (!fileStore.has(norm)) throw new Error(`File not found: ${norm}`);
          return { data: fileStore.get(norm)!, path: norm };
        }),
        writeFile: vi.fn(async (p: string, data: string) => {
          const norm = p.replace(/\\/g, '/');
          fileStore.set(norm, data);
        }),
        exists: vi.fn(async (p: string) => {
          const norm = p.replace(/\\/g, '/');
          return fileStore.has(norm);
        }),
        join: vi.fn(async (...parts: string[]) => parts.join('/').replace(/\\/g, '/').replace(/\/+/g, '/')),
        dirname: vi.fn(async (p: string) => p.split('/').slice(0, -1).join('/') || '.'),
      };
      envelopeService = new ProjectCompatibilityEnvelopeService(fileAccessMock, new ProjectPathResolver(null));
    });

    it('builds a fresh envelope with schemaVersion 1 and per-scene facts', async () => {
      const sceneJson = JSON.stringify(makeScene(), null, 2);
      fileStore.set('D:/projects/demo/project/main.scene.json', sceneJson);

      const metadata = makeProjectMetadata();
      const envelope = await envelopeService.buildEnvelope('D:/projects/demo', metadata);

      expect(envelope.schemaVersion).toBe(PROJECT_COMPATIBILITY_ENVELOPE_SCHEMA_VERSION);
      expect(envelope.scenes).toHaveLength(1);

      const entry = envelope.scenes[0];
      expect(entry.path).toBe('project/main.scene.json');
      expect(entry.sceneSchemaVersion).toBe(5);
      expect(entry.hasUnknownFields).toBe(false);
      expect(entry.sourceHash).toBe(await calculateSourceHash(sceneJson));
    });

    it('records hasUnknownFields: true when a scene contains unknown properties', async () => {
      const sceneWithUnknown = makeScene({ unknownProperty: 'preserve-me' });
      const sceneJson = JSON.stringify(sceneWithUnknown, null, 2);
      fileStore.set('D:/projects/demo/project/main.scene.json', sceneJson);

      const metadata = makeProjectMetadata();
      const envelope = await envelopeService.buildEnvelope('D:/projects/demo', metadata);

      expect(envelope.scenes[0].hasUnknownFields).toBe(true);
      expect(envelope.scenes[0].sceneSchemaVersion).toBe(5);
      expect(envelope.scenes[0].sourceHash).toBe(await calculateSourceHash(sceneJson));
    });

    it('records correct schema version for v4 scenes', async () => {
      const v4Scene = {
        schemaVersion: 4,
        sceneId: 'scene-v4',
        meta: { title: 'V4 Scene' },
        statements: [],
      };
      const sceneJson = JSON.stringify(v4Scene, null, 2);
      fileStore.set('D:/projects/demo/project/main.scene.json', sceneJson);

      const metadata = makeProjectMetadata();
      const envelope = await envelopeService.buildEnvelope('D:/projects/demo', metadata);

      expect(envelope.scenes[0].sceneSchemaVersion).toBe(4);
      expect(envelope.scenes[0].hasUnknownFields).toBe(false);
    });

    it('records sceneSchemaVersion 0 when a referenced scene file is missing', async () => {
      const metadata = makeProjectMetadata();
      const envelope = await envelopeService.buildEnvelope('D:/projects/demo', metadata);

      expect(envelope.scenes).toHaveLength(1);
      expect(envelope.scenes[0].sceneSchemaVersion).toBe(0);
      expect(envelope.scenes[0].sourceHash).toBe('');
    });

    it('handles multiple scenes in project metadata', async () => {
      const scene1 = JSON.stringify(makeScene({ sceneId: 's1' }));
      const scene2 = JSON.stringify(makeScene({ sceneId: 's2', extraKey: true }));

      fileStore.set('D:/projects/demo/project/scene1.scene.json', scene1);
      fileStore.set('D:/projects/demo/project/scene2.scene.json', scene2);

      const metadata = makeProjectMetadata({
        scenes: [
          { id: 's1', name: 'Scene 1', path: 'project/scene1.scene.json' },
          { id: 's2', name: 'Scene 2', path: 'project/scene2.scene.json' },
        ],
      });

      const envelope = await envelopeService.buildEnvelope('D:/projects/demo', metadata);
      expect(envelope.scenes).toHaveLength(2);
      expect(envelope.scenes[0].path).toBe('project/scene1.scene.json');
      expect(envelope.scenes[0].hasUnknownFields).toBe(false);
      expect(envelope.scenes[1].path).toBe('project/scene2.scene.json');
      expect(envelope.scenes[1].hasUnknownFields).toBe(true);
    });

    it('validates fresh envelope and detects stale envelope on hash or schema change', async () => {
      const sceneJson = JSON.stringify(makeScene());
      const hash = await calculateSourceHash(sceneJson);

      const freshEnvelope = {
        schemaVersion: PROJECT_COMPATIBILITY_ENVELOPE_SCHEMA_VERSION,
        scenes: [
          {
            path: 'project/main.scene.json',
            sceneSchemaVersion: 5,
            sourceHash: hash,
            hasUnknownFields: false,
          },
        ],
      };

      const sceneFacts = [
        {
          path: 'project/main.scene.json',
          sceneSchemaVersion: 5,
          sourceHash: hash,
          hasUnknownFields: false,
        },
      ];

      expect(envelopeService.validateEnvelope(freshEnvelope, sceneFacts)).toBe(true);

      // Stale due to modified content / hash
      const staleByHash = {
        ...freshEnvelope,
        scenes: [{ ...freshEnvelope.scenes[0], sourceHash: 'sha256:different' }],
      };
      expect(envelopeService.validateEnvelope(staleByHash, sceneFacts)).toBe(false);

      // Stale due to modified scene schema version
      const staleBySchema = {
        ...freshEnvelope,
        scenes: [{ ...freshEnvelope.scenes[0], sceneSchemaVersion: 4 }],
      };
      expect(envelopeService.validateEnvelope(staleBySchema, sceneFacts)).toBe(false);

      // Stale due to modified unknown fields presence
      const staleByUnknowns = {
        ...freshEnvelope,
        scenes: [{ ...freshEnvelope.scenes[0], hasUnknownFields: true }],
      };
      expect(envelopeService.validateEnvelope(staleByUnknowns, sceneFacts)).toBe(false);

      // Malformed / invalid envelope
      expect(envelopeService.validateEnvelope(null, sceneFacts)).toBe(false);
      expect(envelopeService.validateEnvelope({ schemaVersion: 99, scenes: [] }, sceneFacts)).toBe(false);
      expect(envelopeService.validateEnvelope({ schemaVersion: 1, scenes: 'not-an-array' }, sceneFacts)).toBe(false);
    });
  });

  describe('Integration with ProjectResourceService: loading & saving', () => {
    let fileStore: Map<string, string>;
    let fileAccess: Record<keyof IFileAccess, any>;
    let service: ProjectResourceService;

    const rootPath = 'D:/projects/demo';
    const projectFilePath = 'D:/projects/demo/project.json';
    const envelopeFilePath = `D:/projects/demo/${PROJECT_COMPATIBILITY_ENVELOPE_FILE_NAME}`;
    const sceneFilePath = 'D:/projects/demo/project/main.scene.json';

    beforeEach(() => {
      fileStore = new Map();
      fileAccess = {
        readAsset: vi.fn(),
        readFile: vi.fn(async (p: string) => {
          const norm = p.replace(/\\/g, '/');
          if (!fileStore.has(norm)) throw new Error(`File not found: ${norm}`);
          return { data: fileStore.get(norm)!, path: norm };
        }),
        readBinaryFile: vi.fn(),
        showOpenDialog: vi.fn(),
        showSaveDialog: vi.fn(),
        writeFile: vi.fn(async (p: string, data: string) => {
          const norm = p.replace(/\\/g, '/');
          fileStore.set(norm, data);
        }),
        writeBinaryFile: vi.fn(),
        replaceFile: vi.fn(),
        ensureDir: vi.fn(async () => {}),
        copyFile: vi.fn(),
        readDir: vi.fn(),
        stat: vi.fn(async () => null),
        realpath: vi.fn(async (p: string) => p),
        exists: vi.fn(async (p: string) => fileStore.has(p.replace(/\\/g, '/'))),
        join: vi.fn(async (...parts: string[]) => parts.join('/').replace(/\\/g, '/').replace(/\/+/g, '/')),
        dirname: vi.fn(async (p: string) => p.split('/').slice(0, -1).join('/') || '.'),
        basename: vi.fn(async (p: string) => p.split('/').pop() || p),
        extname: vi.fn(async (p: string) => {
          const idx = p.lastIndexOf('.');
          return idx === -1 ? '' : p.slice(idx);
        }),
      };

      service = new ProjectResourceService(
        fileAccess as unknown as IFileAccess,
        new ProjectPathResolver(null),
      );
    });

    it('loads fresh persisted envelope on loadProject', async () => {
      const metadata = makeProjectMetadata();
      const sceneData = JSON.stringify(makeScene(), null, 2);
      const sceneHash = await calculateSourceHash(sceneData);

      const persistedEnvelope = {
        schemaVersion: PROJECT_COMPATIBILITY_ENVELOPE_SCHEMA_VERSION,
        scenes: [
          {
            path: 'project/main.scene.json',
            sceneSchemaVersion: 5,
            sourceHash: sceneHash,
            hasUnknownFields: false,
          },
        ],
      };

      fileStore.set(projectFilePath, JSON.stringify(metadata, null, 2));
      fileStore.set(sceneFilePath, sceneData);
      fileStore.set(envelopeFilePath, JSON.stringify(persistedEnvelope, null, 2));

      const loaded = await service.loadProject(projectFilePath);
      expect(loaded.compatibilityEnvelope).toBeDefined();
      expect(loaded.compatibilityEnvelope?.schemaVersion).toBe(1);
      expect(loaded.compatibilityEnvelope?.scenes[0].sourceHash).toBe(sceneHash);
    });

    it('rebuilds envelope in memory when project.json.compatibility is missing without failing project load', async () => {
      const metadata = makeProjectMetadata();
      const sceneData = JSON.stringify(makeScene(), null, 2);
      const expectedHash = await calculateSourceHash(sceneData);

      fileStore.set(projectFilePath, JSON.stringify(metadata, null, 2));
      fileStore.set(sceneFilePath, sceneData);
      // Note: envelopeFilePath is intentionally NOT in fileStore

      const loaded = await service.loadProject(projectFilePath);
      expect(loaded.metadata.name).toBe('Envelope Test Project');
      expect(loaded.compatibilityEnvelope).toBeDefined();
      expect(loaded.compatibilityEnvelope?.schemaVersion).toBe(1);
      expect(loaded.compatibilityEnvelope?.scenes[0].sourceHash).toBe(expectedHash);
    });

    it('rebuilds envelope in memory when project.json.compatibility is malformed or invalid JSON', async () => {
      const metadata = makeProjectMetadata();
      const sceneData = JSON.stringify(makeScene(), null, 2);
      const expectedHash = await calculateSourceHash(sceneData);

      fileStore.set(projectFilePath, JSON.stringify(metadata, null, 2));
      fileStore.set(sceneFilePath, sceneData);
      fileStore.set(envelopeFilePath, '{ invalid json');

      const loaded = await service.loadProject(projectFilePath);
      expect(loaded.compatibilityEnvelope).toBeDefined();
      expect(loaded.compatibilityEnvelope?.scenes[0].sourceHash).toBe(expectedHash);
    });

    it('detects stale persisted envelope and rebuilds fresh projection in memory', async () => {
      const metadata = makeProjectMetadata();
      const sceneData = JSON.stringify(makeScene(), null, 2);
      const actualHash = await calculateSourceHash(sceneData);

      const staleEnvelope = {
        schemaVersion: PROJECT_COMPATIBILITY_ENVELOPE_SCHEMA_VERSION,
        scenes: [
          {
            path: 'project/main.scene.json',
            sceneSchemaVersion: 5,
            sourceHash: 'sha256:stale-outdated-hash',
            hasUnknownFields: false,
          },
        ],
      };

      fileStore.set(projectFilePath, JSON.stringify(metadata, null, 2));
      fileStore.set(sceneFilePath, sceneData);
      fileStore.set(envelopeFilePath, JSON.stringify(staleEnvelope, null, 2));

      const loaded = await service.loadProject(projectFilePath);
      expect(loaded.compatibilityEnvelope).toBeDefined();
      expect(loaded.compatibilityEnvelope?.scenes[0].sourceHash).toBe(actualHash);
    });

    it('refreshes and writes envelope file on saveProjectMetadata (last-writer-wins, non-interfering)', async () => {
      const metadata = makeProjectMetadata();
      const sceneData = JSON.stringify(makeScene({ customUnknownField: 'preserve' }), null, 2);

      fileStore.set(projectFilePath, JSON.stringify(metadata, null, 2));
      fileStore.set(sceneFilePath, sceneData);

      const loaded = await service.loadProject(projectFilePath);

      // Save updated project metadata
      const updated = await service.saveProjectMetadata(loaded, {
        ...loaded.metadata,
        name: 'Updated Project Name',
      });

      expect(updated.metadata.name).toBe('Updated Project Name');
      expect(fileStore.has(envelopeFilePath)).toBe(true);

      const writtenEnvelope = JSON.parse(fileStore.get(envelopeFilePath)!);
      expect(writtenEnvelope.schemaVersion).toBe(1);
      expect(writtenEnvelope.scenes[0].hasUnknownFields).toBe(true);
      expect(writtenEnvelope.scenes[0].sourceHash).toBe(await calculateSourceHash(sceneData));
    });

    it('refreshes envelope via refreshCompatibilityEnvelope helper', async () => {
      const metadata = makeProjectMetadata();
      const sceneData = JSON.stringify(makeScene(), null, 2);

      fileStore.set(projectFilePath, JSON.stringify(metadata, null, 2));
      fileStore.set(sceneFilePath, sceneData);

      const projectState: ProjectState = {
        rootPath,
        projectFilePath,
        metadata,
      };

      service.setCurrentProject(projectState);
      const envelope = await service.refreshCompatibilityEnvelope();

      expect(envelope).not.toBeNull();
      expect(envelope?.schemaVersion).toBe(1);
      expect(envelope?.scenes[0].sourceHash).toBe(await calculateSourceHash(sceneData));
      expect(fileStore.has(envelopeFilePath)).toBe(true);
    });
  });
});
