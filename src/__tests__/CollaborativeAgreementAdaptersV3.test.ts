import { describe, expect, it, vi } from 'vitest';
import {
  COLLABORATION_SCHEMA_VERSION_V3,
  type CollaborativeSceneStateV3,
} from '../api/types/collaboration';
import {
  SCENE_SCHEMA_VERSION_V5,
  type SceneDocumentV5,
} from '../api/types/semantic-scene';
import {
  CollaborativeServerSceneAgreementAdapterV3,
  CollaborativeServerSceneSafetyPathAdapterV3,
  type CollaborativeServerSceneAgreementRequestV3,
} from '../services/collaboration/CollaborativeAgreementAdapters';

function makeStateV3(): CollaborativeSceneStateV3 {
  return {
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V5,
    collaborationProjectId: 'proj_v3',
    roomId: 'proj_v3:main',
    sceneId: 'scene_agreement_v3',
    meta: { title: 'Agreement Scene V3', fps: 60 },
    statementsById: {
      line_1: {
        id: 'line_1',
        type: 'dialogue',
        time: 1,
        params: {
          text: 'Server Line 1',
          durationSeconds: 2,
        },
      },
    },
    statementOrder: ['line_1'],
  };
}

function makeDocV5(): SceneDocumentV5 {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION_V5,
    sceneId: 'scene_agreement_v3',
    meta: { title: 'Local Scene V5', fps: 60 },
    statements: [
      {
        id: 'line_local',
        type: 'dialogue',
        time: 0,
        params: {
          text: 'Local Line',
          durationSeconds: 1,
        },
      },
    ],
  };
}

describe('CollaborativeServerSceneAgreementAdapterV3', () => {
  it('requests confirmation, backs up local document, and commits accepted v5 server scene', async () => {
    let capturedRequest: CollaborativeServerSceneAgreementRequestV3 | null = null;
    const presenter = {
      show: vi.fn((req: CollaborativeServerSceneAgreementRequestV3) => {
        capturedRequest = req;
      }),
      clear: vi.fn(),
    };

    const files = new Map<string, string>();
    const fileAccess = {
      dirname: (p: string) => p.substring(0, p.lastIndexOf('/')),
      basename: (p: string) => p.substring(p.lastIndexOf('/') + 1),
      ensureDir: vi.fn(),
      exists: vi.fn((p: string) => files.has(p)),
      copyFile: vi.fn((src: string, dest: string) => {
        files.set(dest, files.get(src) || '');
      }),
      writeFile: vi.fn((p: string, data: string) => {
        files.set(p, data);
      }),
    };

    const projectResources = {
      resolveForProjectWrite: (rel: string) => `/project/${rel}`,
    };

    const localDoc = makeDocV5();
    files.set('/project/project/main.scene.json', JSON.stringify(localDoc));

    const safetyPaths = new CollaborativeServerSceneSafetyPathAdapterV3({
      fileAccess,
      projectResources,
      targetSceneRelativePath: 'project/main.scene.json',
      now: () => new Date('2026-08-18T12:00:00Z'),
    });

    const adapter = new CollaborativeServerSceneAgreementAdapterV3({
      presenter,
      safetyPaths,
      getLocalDocument: () => localDoc,
    });

    const serverState = makeStateV3();
    const requestPromise = adapter.request(serverState);

    await vi.waitFor(() => expect(presenter.show).toHaveBeenCalled());
    expect(capturedRequest).not.toBeNull();
    const req = capturedRequest as unknown as CollaborativeServerSceneAgreementRequestV3;
    expect(req.serverDocument.schemaVersion).toBe(SCENE_SCHEMA_VERSION_V5);

    adapter.complete(true);
    await requestPromise;

    expect(adapter.hasAcceptedServerScene).toBe(true);

    // Commit accepted document to disk
    await adapter.commitAcceptedServerDocument(req.serverDocument);
    const writtenTarget = files.get('/project/project/main.scene.json');
    expect(writtenTarget).toBeDefined();
    const parsedTarget = JSON.parse(writtenTarget!);
    expect(parsedTarget.schemaVersion).toBe(SCENE_SCHEMA_VERSION_V5);
    expect(parsedTarget.statements[0].id).toBe('line_1');
  });
});
