import { describe, expect, it, vi } from 'vitest';
import {
  COLLABORATION_SCHEMA_VERSION_V2,
  type CollaborativeSceneStateV2,
} from '../api/types/collaboration';
import { SCENE_SCHEMA_VERSION_V4 } from '../api/types/semantic-scene';
import { executeCollaborativeStatePublishPlanV2 } from '../services/collaboration/CollaborativeStatePublishExecutorV2';

function makeState(): CollaborativeSceneStateV2 {
  return {
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V4,
    collaborationProjectId: 'project_1',
    roomId: 'project_1:main',
    sceneId: 'scene_v2',
    meta: { title: 'Executor Scene V2', fps: 60 },
    statementsById: {
      line_1: {
        id: 'line_1',
        time: 1,
        type: 'dialogue',
        params: {
          text: 'Hello',
          durationSeconds: 2,
        },
      },
    },
    statementOrder: ['line_1'],
  };
}

describe('CollaborativeStatePublishExecutorV2', () => {
  it('returns noop state without publishing', async () => {
    const state = makeState();
    const ports = {
      publishState: vi.fn(),
    };

    await expect(executeCollaborativeStatePublishPlanV2({ kind: 'noop', state }, ports))
      .resolves.toBe(state);
    expect(ports.publishState).not.toHaveBeenCalled();
  });

  it('publishes full plans and returns the accepted full state', async () => {
    const state = makeState();
    const ports = {
      publishState: vi.fn(),
    };

    await expect(executeCollaborativeStatePublishPlanV2({
      kind: 'full',
      reason: 'cross-entity-or-scene-change',
      state,
    }, ports)).resolves.toBe(state);
    expect(ports.publishState).toHaveBeenCalledWith(state);
  });

  it('publishes statement entity plans and returns the client-resolved latest state', async () => {
    const state = makeState();
    const accepted: CollaborativeSceneStateV2 = {
      ...state,
      statementsById: {
        line_1: {
          ...state.statementsById.line_1,
          time: 2,
        },
      },
    };
    const ports = {
      publishState: vi.fn(),
      publishStatementChanges: vi.fn(),
      getState: () => accepted,
    };

    await expect(executeCollaborativeStatePublishPlanV2({
      kind: 'entity',
      entity: 'statements',
      changes: {
        upsertStatements: accepted.statementsById,
      },
      state,
    }, ports)).resolves.toBe(accepted);
    expect(ports.publishStatementChanges).toHaveBeenCalledWith({
      upsertStatements: accepted.statementsById,
    });
    expect(ports.publishState).not.toHaveBeenCalled();
  });

  it('publishes companion entity plans through the companion port', async () => {
    const state: CollaborativeSceneStateV2 = {
      ...makeState(),
      companionGroupsByStatementId: {
        line_1: {
          companionsById: {},
          companionOrder: [],
        },
      },
    };
    const ports = {
      publishState: vi.fn(),
      publishCompanionChanges: vi.fn(),
    };

    await expect(executeCollaborativeStatePublishPlanV2({
      kind: 'entity',
      entity: 'companions',
      changes: {
        statementId: 'line_1',
        companionOrder: [],
      },
      state,
    }, ports)).resolves.toEqual(state);
    expect(ports.publishCompanionChanges).toHaveBeenCalledWith({
      statementId: 'line_1',
      companionOrder: [],
    });
    expect(ports.publishState).not.toHaveBeenCalled();
  });

  it('falls back to full publish if an entity port is unavailable', async () => {
    const state = makeState();
    const ports = {
      publishState: vi.fn(),
    };

    await expect(executeCollaborativeStatePublishPlanV2({
      kind: 'entity',
      entity: 'statements',
      changes: { statementOrder: ['line_1'] },
      state,
    }, ports)).resolves.toBe(state);
    expect(ports.publishState).toHaveBeenCalledWith(state);
  });

  it('propagates entity publish rejection and does not read a latest state after failure', async () => {
    const state = makeState();
    const ports = {
      publishState: vi.fn(),
      publishStatementChanges: vi.fn(async () => {
        throw new Error('server rejected statement publish');
      }),
      getState: vi.fn(() => state),
    };

    await expect(executeCollaborativeStatePublishPlanV2({
      kind: 'entity',
      entity: 'statements',
      changes: { statementOrder: ['line_1'] },
      state,
    }, ports)).rejects.toThrow('server rejected statement publish');

    expect(ports.publishState).not.toHaveBeenCalled();
    expect(ports.getState).not.toHaveBeenCalled();
  });
});
