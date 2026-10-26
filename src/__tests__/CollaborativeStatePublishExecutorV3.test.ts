import { describe, expect, it, vi } from 'vitest';
import {
  COLLABORATION_SCHEMA_VERSION_V3,
  type CollaborativeSceneStateV3,
} from '../api/types/collaboration';
import { SCENE_SCHEMA_VERSION_V5 } from '../api/types/semantic-scene';
import { executeCollaborativeStatePublishPlanV3 } from '../services/collaboration/CollaborativeStatePublishExecutorV3';

function makeState(): CollaborativeSceneStateV3 {
  return {
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V5,
    collaborationProjectId: 'project_1',
    roomId: 'project_1:main',
    sceneId: 'scene_v3',
    meta: { title: 'Executor Scene V3', fps: 60 },
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

describe('CollaborativeStatePublishExecutorV3', () => {
  it('returns noop state without publishing', async () => {
    const state = makeState();
    const ports = {
      publishState: vi.fn(),
    };

    await expect(executeCollaborativeStatePublishPlanV3({ kind: 'noop', state }, ports))
      .resolves.toBe(state);
    expect(ports.publishState).not.toHaveBeenCalled();
  });

  it('publishes full plans and returns the accepted full state', async () => {
    const state = makeState();
    const ports = {
      publishState: vi.fn(),
    };

    await expect(executeCollaborativeStatePublishPlanV3({
      kind: 'full',
      reason: 'cross-entity-or-scene-change',
      state,
    }, ports)).resolves.toBe(state);
    expect(ports.publishState).toHaveBeenCalledWith(state);
  });

  it('publishes statement entity plans and returns the client-resolved latest state', async () => {
    const state = makeState();
    const accepted: CollaborativeSceneStateV3 = {
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

    await expect(executeCollaborativeStatePublishPlanV3({
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
    const state: CollaborativeSceneStateV3 = {
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

    await expect(executeCollaborativeStatePublishPlanV3({
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

    await expect(executeCollaborativeStatePublishPlanV3({
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

    await expect(executeCollaborativeStatePublishPlanV3({
      kind: 'entity',
      entity: 'statements',
      changes: { statementOrder: ['line_1'] },
      state,
    }, ports)).rejects.toThrow('server rejected statement publish');

    expect(ports.publishState).not.toHaveBeenCalled();
    expect(ports.getState).not.toHaveBeenCalled();
  });
});
