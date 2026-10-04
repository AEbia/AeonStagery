import { describe, expect, it, vi } from 'vitest';
import {
  COLLABORATION_SCHEMA_VERSION_V3,
  type CollaborationConnectionStatus,
  type CollaborativeSceneStateV3,
} from '../api/types/collaboration';
import {
  SCENE_SCHEMA_VERSION_V5,
  type SceneDocumentV5,
} from '../api/types/semantic-scene';
import { CollaborativeDocumentSyncLoopV3 } from '../services/collaboration/CollaborativeDocumentSyncLoopV3';
import { CollaborativeRemoteApplyPipelineV3 } from '../services/collaboration/CollaborativeRemoteApplyPipelineV3';
import { CollaborationRemoteStateRejectedError } from '../services/collaboration/CollaborationErrors';

function makeState(text: string): CollaborativeSceneStateV3 {
  return {
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V5,
    collaborationProjectId: 'proj_loop',
    roomId: 'proj_loop:main',
    sceneId: 'scene_loop',
    meta: { title: 'Loop', fps: 60 },
    statementsById: {
      line_1: {
        id: 'line_1',
        type: 'dialogue',
        time: 1,
        params: { text, durationSeconds: 2 },
      },
    },
    statementOrder: ['line_1'],
  };
}

function makeDoc(text: string): SceneDocumentV5 {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION_V5,
    sceneId: 'scene_loop',
    meta: { title: 'Loop', fps: 60 },
    statements: [{ id: 'line_1', time: 1, type: 'dialogue', params: { text, durationSeconds: 2 } }],
  };
}

function makeLoop(options: {
  applyWithPreparation: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  getSceneDocument?: () => SceneDocumentV5 | null;
  onRemoteStateRejected?: (error: CollaborationRemoteStateRejectedError) => void;
}) {
  let status: CollaborationConnectionStatus = 'connected';
  const notifyError = vi.fn();
  const client = {
    getState: vi.fn(() => makeState('remote')),
    publishState: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    isRealtimeConnected: vi.fn(() => true),
  };
  const loop = new CollaborativeDocumentSyncLoopV3({
    client: client as any,
    getSceneDocument: options.getSceneDocument ?? (() => makeDoc('local')),
    localCommitPipeline: { commit: options.commit } as any,
    remoteApplyPipeline: { applyWithPreparation: options.applyWithPreparation } as any,
    getStatus: () => status,
    setStatus: (next) => { status = next; },
    notifyError,
    onRemoteStateRejected: options.onRemoteStateRejected,
  });
  return { loop, notifyError, statusOf: () => status };
}

describe('CollaborativeDocumentSyncLoopV3 apply failure containment', () => {
  it('blocks local publication after a failed apply and resumes after a successful retry', async () => {
    let localDocument = makeDoc('local');
    const applyWithPreparation = vi.fn()
      .mockRejectedValueOnce(new Error('remote apply failed'))
      .mockImplementationOnce(async () => {
        localDocument = makeDoc('remote');
        return localDocument;
      });
    const commit = vi.fn().mockResolvedValue(makeState('published'));
    const { loop, notifyError, statusOf } = makeLoop({
      applyWithPreparation,
      commit,
      getSceneDocument: () => localDocument,
    });

    await loop.synchronizeRemote(makeState('remote'));

    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(statusOf()).toBe('connected');

    // The local snapshot is stale relative to the client state, so don't publish it.
    await loop.scheduleLocalPublish(true);
    expect(commit).not.toHaveBeenCalled();

    // A successful retry applies the remote document and releases the publish gate.
    await loop.synchronizeRemote(makeState('remote'));
    localDocument = makeDoc('local edit');
    await loop.scheduleLocalPublish(true);
    expect(commit).toHaveBeenCalled();
  });

  it('retries the same remote state after a failed apply (failure does not mark it applied)', async () => {
    const applyWithPreparation = vi.fn().mockRejectedValue(new Error('disk write failed'));
    const { loop } = makeLoop({ applyWithPreparation, commit: vi.fn() });

    await loop.synchronizeRemote(makeState('remote'));
    await loop.synchronizeRemote(makeState('remote'));

    // No signature dedup for failed applies: a later message must re-attempt.
    expect(applyWithPreparation).toHaveBeenCalledTimes(2);
  });

  it('reports a rejected remote screenplay as terminal state failure', async () => {
    const rejected = vi.fn();
    const pipeline = new CollaborativeRemoteApplyPipelineV3({});
    const applyWithPreparation = vi.fn((state: CollaborativeSceneStateV3) => (
      pipeline.applyWithPreparation(state)
    ));
    const { loop, notifyError } = makeLoop({
      applyWithPreparation,
      commit: vi.fn(),
      onRemoteStateRejected: rejected,
    });
    const malformedState = { ...makeState('remote'), statementOrder: [] };

    await loop.synchronizeRemote(malformedState);

    expect(rejected).toHaveBeenCalledOnce();
    expect(rejected.mock.calls[0][0]).toBeInstanceOf(CollaborationRemoteStateRejectedError);
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('deduplicates an already-applied state and only publishes genuinely newer content', async () => {
    const applied = makeDoc('remote');
    const applyWithPreparation = vi.fn().mockResolvedValue(applied);
    const commit = vi.fn().mockResolvedValue(makeState('published'));
    const { loop } = makeLoop({ applyWithPreparation, commit });

    await loop.synchronizeRemote(makeState('remote'));
    await loop.synchronizeRemote(makeState('remote'));
    expect(applyWithPreparation).toHaveBeenCalledTimes(1);

    // The apply moved the publish baseline to the applied document; the local
    // document differs, so it publishes once.
    await loop.scheduleLocalPublish(false);
    expect(commit).toHaveBeenCalledTimes(1);

    // An unchanged document after a successful publish must not echo-publish.
    await loop.scheduleLocalPublish(false);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
