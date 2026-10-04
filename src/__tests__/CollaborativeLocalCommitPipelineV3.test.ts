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
  CollaborativeLocalCommitPipelineV3,
} from '../services/collaboration/CollaborativeLocalCommitPipelineV3';
import { createCollaborativeSceneStateV3FromDocument } from '../services/collaboration/CollaborativeSceneStateV3';
import {
  planCollaborativeStateTransactionV3,
  deriveCollaborativeStatementChangesV3,
  deriveCollaborativeCompanionChangesV3,
} from '../services/collaboration/CollaborativeStateTransactionPlannerV3';
import { withSceneDocumentCanonicalOrder } from '../services/semantic-scene/SceneDocumentCanonicalOrder';

function makeStateV3(): CollaborativeSceneStateV3 {
  return {
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V5,
    collaborationProjectId: 'proj_v3',
    roomId: 'proj_v3:main',
    sceneId: 'scene_commit_v3',
    meta: { title: 'Commit Scene V3', fps: 60 },
    statementsById: {
      line_1: {
        id: 'line_1',
        type: 'dialogue',
        time: 1,
        params: {
          text: 'Line 1',
          durationSeconds: 2,
        },
      },
    },
    statementOrder: ['line_1'],
    companionGroupsByStatementId: {
      line_1: {
        companionsById: {
          c1: {
            id: 'c1',
            anchor: 'start',
            offset: 0,
            type: 'camera',
            params: { mode: 'focus', target: '$speaker' },
          },
        },
        companionOrder: ['c1'],
      },
    },
  };
}

function makeDocV5(): SceneDocumentV5 {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION_V5,
    sceneId: 'scene_commit_v3',
    meta: { title: 'Commit Scene V3', fps: 60 },
    statements: [
      {
        id: 'line_1',
        type: 'dialogue',
        time: 1,
        params: {
          text: 'Line 1 edited',
          durationSeconds: 2,
        },
        companions: [
          {
            id: 'c1',
            anchor: 'start',
            offset: 0,
            type: 'camera',
            params: { mode: 'focus', target: '$speaker' },
          },
        ],
      },
    ],
  };
}

describe('CollaborativeLocalCommitPipelineV3 & Transaction Planner', () => {
  it('derives statement changes for single statement modification', () => {
    const prev = makeStateV3();
    const next = {
      ...prev,
      statementsById: {
        line_1: {
          ...prev.statementsById.line_1,
          params: { text: 'Updated', durationSeconds: 2 },
        },
      },
    };

    const changes = deriveCollaborativeStatementChangesV3(prev, next);
    expect(changes).not.toBeNull();
    expect((changes?.upsertStatements?.line_1.params as any).text).toBe('Updated');
  });

  it('derives companion changes for companion modifications on existing statement', () => {
    const prev = makeStateV3();
    const next: CollaborativeSceneStateV3 = {
      ...prev,
      companionGroupsByStatementId: {
        line_1: {
          companionsById: {
            c1: {
              ...prev.companionGroupsByStatementId!.line_1.companionsById.c1,
              type: 'camera',
              params: { mode: 'focus', target: '$listener' },
            },
          },
          companionOrder: ['c1'],
        },
      },
    };

    const changes = deriveCollaborativeCompanionChangesV3(prev, next);
    expect(changes).not.toBeNull();
    expect(changes?.statementId).toBe('line_1');
    expect(changes?.upsertCompanions?.c1.params).toEqual({ mode: 'focus', target: '$listener' });
  });

  it('plans entity statement change when publisher supports statement changes', () => {
    const prev = makeStateV3();
    const next = {
      ...prev,
      statementsById: {
        line_1: {
          ...prev.statementsById.line_1,
          params: { text: 'Updated line', durationSeconds: 2 },
        },
      },
    };

    const plan = planCollaborativeStateTransactionV3(prev, next, {
      statements: true,
      companions: true,
    });
    expect(plan.kind).toBe('entity');
    if (plan.kind === 'entity') {
      expect(plan.entity).toBe('statements');
    }
  });

  it('commits document changes through CollaborativeLocalCommitPipelineV3', async () => {
    const pipeline = new CollaborativeLocalCommitPipelineV3();
    const publisher = {
      publishState: vi.fn(),
      publishStatementChanges: vi.fn(),
      publishCompanionChanges: vi.fn(),
      getState: vi.fn(),
    };

    const doc = makeDocV5();
    const latestState = makeStateV3();

    await pipeline.commit({
      document: doc,
      latestState,
      publisher,
    });

    expect(publisher.publishStatementChanges).toHaveBeenCalled();
  });

  it('publishes explicit canonical reorders when same-time statement fields are unchanged', async () => {
    const sourceDocument: SceneDocumentV5 = {
      ...makeDocV5(),
      statements: [
        {
          id: 'line_1',
          type: 'dialogue',
          time: 1,
          params: { text: 'Line 1', durationSeconds: 2 },
        },
        {
          id: 'line_2',
          type: 'dialogue',
          time: 1,
          params: { text: 'Line 2', durationSeconds: 2 },
        },
      ],
    };
    const source = withSceneDocumentCanonicalOrder(sourceDocument, ['line_1', 'line_2']);
    const reordered = withSceneDocumentCanonicalOrder({
      ...source,
      statements: [...source.statements].reverse(),
    }, ['line_2', 'line_1']);
    const latestState = createCollaborativeSceneStateV3FromDocument(source, {
      collaborationProjectId: 'proj_v3',
      roomId: 'proj_v3:main',
    });
    const publisher = {
      publishState: vi.fn(),
      publishStatementChanges: vi.fn(),
      publishCompanionChanges: vi.fn(),
      getState: vi.fn(() => latestState),
    };
    const prepareLocalState = vi.fn(async () => ({
      document: JSON.parse(JSON.stringify(reordered)) as SceneDocumentV5,
    }));

    await new CollaborativeLocalCommitPipelineV3({ prepareLocalState }).commit({
      document: reordered,
      latestState,
      publisher,
      forcePrepareLocalState: true,
    });

    expect(prepareLocalState).toHaveBeenCalledOnce();
    expect(publisher.publishStatementChanges).toHaveBeenCalledWith(expect.objectContaining({
      statementOrder: ['line_2', 'line_1'],
    }));
  });
});
