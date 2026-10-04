import { describe, expect, it, vi, type Mock } from 'vitest';
import type { CollaborativeSceneStateV2 } from '../api/types/collaboration';
import { SCENE_SCHEMA_VERSION_V4, type HistoricalSceneDocumentV4 } from '../api/types/semantic-scene';
import { createAssetAgreementProposal } from '../services/collaboration/CollaborationAssetHandshake';
import {
  CollaborativeAgreementAdapter,
  CollaborativeResourceAgreementAdapter,
  CollaborativeServerSceneAgreementAdapterV2,
  CollaborativeServerSceneSafetyPathAdapterV2,
  type CollaborativeAgreementPresenter,
  type CollaborativeResourceAgreementRequest,
  type CollaborativeServerSceneAgreementRequestV2,
} from '../services/collaboration/CollaborativeAgreementAdapters';

function makePresenter<TRequest>(): CollaborativeAgreementPresenter<TRequest> & {
  shown: TRequest[];
  clear: Mock<() => void>;
} {
  const clear = vi.fn<() => void>(() => undefined);
  return {
    shown: [],
    show(request: TRequest) {
      this.shown.push(request);
    },
    clear,
  };
}

function makeDocumentV3(sceneId = 'local scene'): HistoricalSceneDocumentV4 {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION_V4,
    sceneId,
    meta: { title: 'Local Semantic Scene' },
    statements: [],
  };
}

function makeServerStateV2(sceneId = 'server scene'): CollaborativeSceneStateV2 {
  return {
    schemaVersion: 2,
    sceneSchemaVersion: 4,
    collaborationProjectId: 'project-1',
    roomId: 'project-1:main',
    sceneId,
    meta: { title: 'Server Semantic Scene' },
    statementsById: {
      s1: {
        id: 's1',
        time: 0,
        type: 'dialogue',
        params: { text: 'hello', durationSeconds: 1 },
      },
    },
    statementOrder: ['s1'],
  };
}

function makeResourceAgreementRequest(): CollaborativeResourceAgreementRequest {
  return {
    proposal: createAssetAgreementProposal({}, 'local', { reason: 'initial-host' }),
    title: '确认本地协作资源',
    message: '确认这些文件用于协作。',
  };
}

async function waitForShown<TRequest>(presenter: { shown: TRequest[] }): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (presenter.shown.length >= 1) return;
    await Promise.resolve();
  }
  throw new Error(`Expected an agreement request, got ${presenter.shown.length}`);
}

describe('CollaborativeAgreementAdapter', () => {
  it('shows a request and resolves only after confirmation', async () => {
    const presenter = makePresenter<CollaborativeResourceAgreementRequest>();
    const adapter = new CollaborativeResourceAgreementAdapter(presenter);
    const promise = adapter.request(makeResourceAgreementRequest());

    expect(presenter.shown).toHaveLength(1);
    adapter.complete(true);

    await expect(promise).resolves.toBeUndefined();
    expect(presenter.clear).toHaveBeenCalledTimes(1);
  });

  it('rejects pending requests when cancelled', async () => {
    const presenter = makePresenter<CollaborativeResourceAgreementRequest>();
    const adapter = new CollaborativeResourceAgreementAdapter(presenter);
    const promise = adapter.request(makeResourceAgreementRequest());

    adapter.complete(false);

    await expect(promise).rejects.toThrow('已取消资源约定');
    expect(presenter.clear).toHaveBeenCalledTimes(1);
  });

  it('cancels an older request before showing a replacement', async () => {
    const presenter = makePresenter<{ id: string }>();
    const adapter = new CollaborativeAgreementAdapter(presenter, 'cancelled');
    const first = adapter.request({ id: 'first' });
    const second = adapter.request({ id: 'second' });

    adapter.complete(true);

    await expect(first).rejects.toThrow('cancelled');
    await expect(second).resolves.toBeUndefined();
    expect(presenter.shown.map((request) => request.id)).toEqual(['first', 'second']);
    expect(presenter.clear).toHaveBeenCalledTimes(2);
  });
});

describe('CollaborativeServerSceneAgreementAdapterV2', () => {
  it('backs up the current in-memory scene before committing the server scene', async () => {
    let acceptedTargetScenePath: string | undefined;
    const presenter = makePresenter<CollaborativeServerSceneAgreementRequestV2>();
    const copyFile = vi.fn();
    const writeFile = vi.fn();
    const agreement = new CollaborativeServerSceneAgreementAdapterV2({
      presenter,
      safetyPaths: new CollaborativeServerSceneSafetyPathAdapterV2({
        fileAccess: {
          dirname: (path) => path.replace(/\/[^/]+$/, ''),
          basename: (path) => path.split('/').pop() || path,
          ensureDir: vi.fn(),
          exists: vi.fn(async () => true),
          copyFile,
          writeFile,
        },
        projectResources: {
          resolveForProjectWrite: (relativePath) => `D:/project/${relativePath}`,
        },
        targetSceneRelativePath: 'project/main.scene.json',
        now: () => new Date('2026-06-08T12:34:56.000Z'),
      }),
      getLocalDocument: () => makeDocumentV3(),
      onAcceptedTargetScenePath: (path) => {
        acceptedTargetScenePath = path;
      },
    });

    const promise = agreement.request(makeServerStateV2());
    await waitForShown(presenter);

    expect(presenter.shown[0].localDocument?.schemaVersion).toBe(SCENE_SCHEMA_VERSION_V4);
    expect(presenter.shown[0].serverDocument.schemaVersion).toBe(SCENE_SCHEMA_VERSION_V4);
    expect(presenter.shown[0].serverState.statementOrder).toEqual(['s1']);
    expect(acceptedTargetScenePath).toBeUndefined();
    expect(presenter.shown[0].targetScenePath).toBe('D:/project/project/main.scene.json');
    expect(presenter.shown[0].backupPath).toBe('D:/project/.aeonstagery/backups/2026-06-08T12-34-56-000Z/main.scene.json');
    expect(presenter.shown[0].jsonBackupPath).toBe('D:/project/.aeonstagery/backups/2026-06-08T12-34-56-000Z/main.scene.json');
    expect(copyFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();

    agreement.complete(true);

    await expect(promise).resolves.toBeUndefined();
    expect(acceptedTargetScenePath).toBe('D:/project/project/main.scene.json');
    expect(copyFile).not.toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledWith(
      'D:/project/.aeonstagery/backups/2026-06-08T12-34-56-000Z/main.scene.json',
      expect.stringContaining('"sceneId": "local scene"'),
    );

    const committedPaths = await agreement.commitAcceptedServerDocument(presenter.shown[0].serverDocument);

    expect(committedPaths?.targetScenePath).toBe('D:/project/project/main.scene.json');
    expect(writeFile).toHaveBeenCalledWith(
      'D:/project/project/main.scene.json',
      expect.stringContaining('"sceneId": "server scene"'),
    );
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(writeFile.mock.invocationCallOrder[0]).toBeLessThan(writeFile.mock.invocationCallOrder[1]);
    await expect(agreement.commitAcceptedServerDocument(presenter.shown[0].serverDocument)).resolves.toBeNull();
    expect(agreement.hasAcceptedServerScene).toBe(true);
  });

  it('does not back up or write the main scene when accepted resource issues are blocking', async () => {
    const presenter = makePresenter<CollaborativeServerSceneAgreementRequestV2>();
    const copyFile = vi.fn();
    const writeFile = vi.fn();
    const agreement = new CollaborativeServerSceneAgreementAdapterV2({
      presenter,
      safetyPaths: new CollaborativeServerSceneSafetyPathAdapterV2({
        fileAccess: {
          dirname: (path) => path.replace(/\/[^/]+$/, ''),
          basename: (path) => path.split('/').pop() || path,
          ensureDir: vi.fn(),
          exists: vi.fn(async () => true),
          copyFile,
          writeFile,
        },
        projectResources: {
          resolveForProjectWrite: (relativePath) => `D:/project/${relativePath}`,
        },
        targetSceneRelativePath: 'project/main.scene.json',
        now: () => new Date('2026-06-08T12:34:56.000Z'),
      }),
      getLocalDocument: () => makeDocumentV3(),
    });

    const promise = agreement.request(makeServerStateV2(), {
      blockingIssues: ['background/bg.png: missing'],
    });
    await waitForShown(presenter);

    agreement.complete(true);

    await expect(promise).rejects.toThrow('资源约定包含阻塞问题');
    expect(copyFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(agreement.hasAcceptedServerScene).toBe(false);
  });
});
