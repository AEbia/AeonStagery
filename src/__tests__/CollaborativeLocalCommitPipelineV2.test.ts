import { describe, expect, it, vi } from 'vitest';
import {
  COLLABORATION_SCHEMA_VERSION_V2,
  type CollaborativeAssetManifest,
  type CollaborativeSceneStateV2,
} from '../api/types/collaboration';
import {
  SCENE_SCHEMA_VERSION_V4,
  type DialogueCompanion,
  type HistoricalSceneDocumentV4,
  type SceneStatement,
} from '../api/types/semantic-scene';
import { CollaborativeLocalCommitPipelineV2 } from '../services/collaboration/CollaborativeLocalCommitPipelineV2';
import { createCollaborativeSceneStateV2FromDocument } from '../services/collaboration/CollaborativeSceneStateV2';

const baseLine: SceneStatement = {
  id: 'line_1',
  time: 1,
  type: 'dialogue',
  params: {
    text: 'Hello',
    durationSeconds: 2,
  },
};

function makeDocument(statements: SceneStatement[] = [baseLine]): HistoricalSceneDocumentV4 {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION_V4,
    sceneId: 'scene_v2',
    meta: { title: 'Pipeline Scene V2' },
    statements,
  };
}

function makeState(
  document: HistoricalSceneDocumentV4 = makeDocument(),
  overrides: Partial<CollaborativeSceneStateV2> = {},
): CollaborativeSceneStateV2 {
  return {
    ...createCollaborativeSceneStateV2FromDocument(document, {
      collaborationProjectId: 'project_1',
      roomId: 'project_1:main',
    }),
    ...overrides,
  };
}

function makeBackgroundStatement(path = 'background/bg.png'): SceneStatement {
  return {
    id: 'bg',
    time: 0,
    type: 'environmentLayer',
    params: {
      mode: 'set',
      layerId: 'background',
      image: path,
    },
  };
}

function makeManifest(path = 'background/bg.png'): CollaborativeAssetManifest {
  return {
    [path]: {
      assetId: `background-image:${path}`,
      kind: 'background-image',
      importKind: 'background',
      projectRelativePath: path,
      entrypointPath: path,
      contentHash: 'sha256:bg',
      files: [{ relativePath: path, contentHash: 'sha256:bg', sizeBytes: 2 }],
      createdAt: '2026-06-21T00:00:00.000Z',
    },
  };
}

describe('CollaborativeLocalCommitPipelineV2', () => {
  it('skips local asset preparation when SceneDocumentV4 references match the latest manifest', async () => {
    const document = makeDocument([makeBackgroundStatement()]);
    const latestState = makeState(document, {
      assets: makeManifest('background/bg.png'),
    });
    const prepareLocalState = vi.fn();
    const pipeline = new CollaborativeLocalCommitPipelineV2({ prepareLocalState });
    const publisher = {
      publishState: vi.fn(),
      publishStatementChanges: vi.fn(),
      getState: vi.fn(() => latestState),
    };

    await pipeline.commit({
      document,
      latestState,
      publisher,
    });

    expect(prepareLocalState).not.toHaveBeenCalled();
    expect(publisher.publishState).not.toHaveBeenCalled();
    expect(publisher.publishStatementChanges).not.toHaveBeenCalled();
  });

  it('prepares local state when SceneDocumentV4 asset references change and publishes prepared assets', async () => {
    const document = makeDocument([makeBackgroundStatement('background/next.png')]);
    const latestState = makeState(makeDocument([makeBackgroundStatement('background/old.png')]), {
      assets: makeManifest('background/old.png'),
    });
    const preparedAssets = makeManifest('background/next.png');
    const prepareLocalState = vi.fn(async () => ({
      document,
      assets: preparedAssets,
    }));
    const pipeline = new CollaborativeLocalCommitPipelineV2({ prepareLocalState });
    const publisher = {
      publishState: vi.fn(),
    };

    const committed = await pipeline.commit({
      document,
      latestState,
      publisher,
    });

    expect(prepareLocalState).toHaveBeenCalledWith(document, expect.objectContaining({
      assets: makeManifest('background/old.png'),
    }));
    expect(publisher.publishState).toHaveBeenCalledWith(expect.objectContaining({
      assets: preparedAssets,
    }));
    expect(committed.assets).toEqual(preparedAssets);
  });

  it('forces local preparation even when SceneDocumentV4 asset references are unchanged', async () => {
    const document = makeDocument([makeBackgroundStatement()]);
    const assets = makeManifest('background/bg.png');
    const latestState = makeState(document, { assets });
    const prepareLocalState = vi.fn(async () => assets);
    const pipeline = new CollaborativeLocalCommitPipelineV2({ prepareLocalState });

    await pipeline.commit({
      document,
      latestState,
      forcePrepareLocalState: true,
      publisher: { publishState: vi.fn() },
    });

    expect(prepareLocalState).toHaveBeenCalledWith(document, latestState);
  });

  it('does not prepare assets for script-only edits when asset references are unchanged', async () => {
    const previousDocument = makeDocument([
      makeBackgroundStatement(),
      baseLine,
    ]);
    const nextDocument = makeDocument([
      makeBackgroundStatement(),
      {
        ...baseLine,
        params: {
          ...baseLine.params,
          text: 'Edited line',
        },
      },
    ]);
    const assets = makeManifest('background/bg.png');
    const latestState = makeState(previousDocument, { assets });
    const prepareLocalState = vi.fn();
    const pipeline = new CollaborativeLocalCommitPipelineV2({ prepareLocalState });
    const accepted = makeState(nextDocument, { assets });
    const publisher = {
      publishState: vi.fn(),
      publishStatementChanges: vi.fn(),
      getState: vi.fn(() => accepted),
    };

    await pipeline.commit({
      document: nextDocument,
      latestState,
      publisher,
    });

    expect(prepareLocalState).not.toHaveBeenCalled();
    expect(publisher.publishStatementChanges).toHaveBeenCalledWith({
      upsertStatements: {
        line_1: {
          ...baseLine,
          params: {
            ...baseLine.params,
            text: 'Edited line',
          },
        },
      },
    });
    expect(publisher.publishState).not.toHaveBeenCalled();
  });

  it('publishes statement-only changes through the statement entity port', async () => {
    const pipeline = new CollaborativeLocalCommitPipelineV2();
    const latestState = makeState();
    const document = makeDocument([{
      ...baseLine,
      time: 2,
    }]);
    const accepted = makeState(document);
    const publisher = {
      publishState: vi.fn(),
      publishStatementChanges: vi.fn(),
      getState: vi.fn(() => accepted),
    };

    const committed = await pipeline.commit({
      document,
      latestState,
      publisher,
    });

    expect(publisher.publishStatementChanges).toHaveBeenCalledWith({
      upsertStatements: {
        line_1: {
          ...baseLine,
          time: 2,
        },
      },
    });
    expect(publisher.publishState).not.toHaveBeenCalled();
    expect(committed).toBe(accepted);
  });

  it('publishes companion-only changes through the companion entity port', async () => {
    const companion: DialogueCompanion = {
      id: 'focus',
      anchor: 'start',
      offset: 0,
      type: 'camera',
      params: {
        mode: 'focus',
        target: '$speaker',
      },
    };
    const previousDocument = makeDocument([baseLine]);
    const nextDocument = makeDocument([{
      ...baseLine,
      companions: [companion],
    }]);
    const pipeline = new CollaborativeLocalCommitPipelineV2();
    const latestState = makeState(previousDocument);
    const publisher = {
      publishState: vi.fn(),
      publishCompanionChanges: vi.fn(),
    };

    await pipeline.commit({
      document: nextDocument,
      latestState,
      publisher,
    });

    expect(publisher.publishCompanionChanges).toHaveBeenCalledWith({
      statementId: 'line_1',
      upsertCompanions: {
        focus: companion,
      },
      companionOrder: ['focus'],
    });
    expect(publisher.publishState).not.toHaveBeenCalled();
  });

  it('falls back to full publish when statement entity port is unavailable', async () => {
    const pipeline = new CollaborativeLocalCommitPipelineV2();
    const latestState = makeState();
    const document = makeDocument([{
      ...baseLine,
      time: 2,
    }]);
    const publisher = {
      publishState: vi.fn(),
    };

    const committed = await pipeline.commit({
      document,
      latestState,
      publisher,
    });

    expect(publisher.publishState).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
      sceneSchemaVersion: SCENE_SCHEMA_VERSION_V4,
      statementsById: {
        line_1: {
          ...baseLine,
          time: 2,
        },
      },
    }));
    expect(committed.statementsById.line_1.time).toBe(2);
  });

  it('preserves canonical statementOrder when local time edits reorder the document array', async () => {
    const first: SceneStatement = { ...baseLine, id: 'first', time: 1 };
    const second: SceneStatement = { ...baseLine, id: 'second', time: 4 };
    const previousDocument = makeDocument([first, second]);
    const latestState = makeState(previousDocument, {
      statementOrder: ['second', 'first'],
    });
    const nextDocument = makeDocument([
      { ...first, time: 6 },
      { ...second, time: 1 },
    ]);
    const publisher = { publishState: vi.fn() };
    const pipeline = new CollaborativeLocalCommitPipelineV2();

    const committed = await pipeline.commit({
      document: nextDocument,
      latestState,
      publisher,
    });

    expect(committed.statementOrder).toEqual(['second', 'first']);
    expect(publisher.publishState).toHaveBeenCalledWith(expect.objectContaining({
      statementOrder: ['second', 'first'],
    }));
  });

  it('filters tombstoned statements before planning so stale records are not republished', async () => {
    const staleStatement: SceneStatement = {
      id: 'stale',
      time: 9,
      type: 'dialogue',
      params: {
        text: 'stale',
        durationSeconds: 1,
      },
    };
    const latestState = makeState(makeDocument([baseLine, staleStatement]), {
      tombstones: {
        statements: {
          stale: { id: 'stale', deletedAt: '2026-06-21T00:00:00.000Z' },
        },
      },
    });
    const document = makeDocument([baseLine, staleStatement]);
    const publisher = {
      publishState: vi.fn(),
      publishStatementChanges: vi.fn(),
    };
    const pipeline = new CollaborativeLocalCommitPipelineV2();

    const committed = await pipeline.commit({
      document,
      latestState,
      publisher,
    });

    expect(publisher.publishState).not.toHaveBeenCalled();
    expect(publisher.publishStatementChanges).not.toHaveBeenCalled();
    expect(committed.statementsById).not.toHaveProperty('stale');
    expect(committed.statementOrder).toEqual(['line_1']);
  });
});
