import { describe, expect, it } from 'vitest';
import {
  COLLABORATION_SCHEMA_VERSION_V2,
  type CollaborativeSceneStateV2,
} from '../api/types/collaboration';
import { SCENE_SCHEMA_VERSION_V4 } from '../api/types/semantic-scene';
import {
  addCollaborativeTombstonesForDeletedRecordsV2,
  filterTombstonedCollaborativeRecordsV2,
  planCollaborativeStateTransactionV2,
} from '../services/collaboration/CollaborativeStateTransactionPlannerV2';

const FULL_CAPABILITIES_V2 = {
  statements: true,
  companions: true,
};

function makeState(): CollaborativeSceneStateV2 {
  return {
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V4,
    collaborationProjectId: 'project_1',
    roomId: 'project_1:main',
    sceneId: 'scene_v2',
    meta: {
      title: 'Planner Scene V2',
      fps: 60,
    },
    statementsById: {
      line_1: {
        id: 'line_1',
        time: 1,
        type: 'dialogue',
        params: {
          speakerId: 'tomori',
          text: 'Hello',
          durationSeconds: 2,
        },
      },
      bg: {
        id: 'bg',
        time: 1,
        type: 'environmentLayer',
        params: {
          mode: 'set',
          layerId: 'background',
          image: 'background/classroom.png',
        },
      },
    },
    statementOrder: ['line_1', 'bg'],
    companionGroupsByStatementId: {
      line_1: {
        companionsById: {
          focus: {
            id: 'focus',
            anchor: 'start',
            offset: 0,
            type: 'camera',
            params: {
              mode: 'focus',
              target: '$speaker',
            },
          },
          smile: {
            id: 'smile',
            anchor: 'start',
            offset: 0,
            type: 'characterPerformance',
            params: {
              target: '$speaker',
              expression: 'smile',
            },
          },
        },
        companionOrder: ['focus', 'smile'],
      },
    },
  };
}

describe('CollaborativeStateTransactionPlannerV2', () => {
  it('plans statement-only changes as an entity transaction when the capability exists', () => {
    const previous = makeState();
    const next: CollaborativeSceneStateV2 = {
      ...previous,
      statementsById: {
        line_1: {
          ...previous.statementsById.line_1,
          time: 3,
        },
      },
      statementOrder: ['line_1'],
      companionGroupsByStatementId: {
        line_1: previous.companionGroupsByStatementId!.line_1,
      },
    };

    expect(planCollaborativeStateTransactionV2(previous, next, FULL_CAPABILITIES_V2)).toEqual({
      kind: 'entity',
      entity: 'statements',
      changes: {
        upsertStatements: {
          line_1: {
            ...previous.statementsById.line_1,
            time: 3,
          },
        },
        deleteStatementIds: ['bg'],
        statementOrder: ['line_1'],
      },
      state: next,
    });
  });

  it('keeps ordinary statement time patches from changing statement order', () => {
    const previous = makeState();
    const next: CollaborativeSceneStateV2 = {
      ...previous,
      statementsById: {
        ...previous.statementsById,
        bg: {
          ...previous.statementsById.bg,
          time: 4,
        },
      },
    };

    const plan = planCollaborativeStateTransactionV2(previous, next, FULL_CAPABILITIES_V2);

    expect(plan).toEqual(expect.objectContaining({
      kind: 'entity',
      entity: 'statements',
      changes: {
        upsertStatements: {
          bg: {
            ...previous.statementsById.bg,
            time: 4,
          },
        },
      },
    }));
  });

  it('plans companion-only changes as an entity transaction when the capability exists', () => {
    const previous = makeState();
    const next: CollaborativeSceneStateV2 = {
      ...previous,
      companionGroupsByStatementId: {
        line_1: {
          companionsById: {
            focus: {
              ...previous.companionGroupsByStatementId!.line_1.companionsById.focus,
              offset: 0.5,
            },
          },
          companionOrder: ['focus'],
        },
      },
    };

    expect(planCollaborativeStateTransactionV2(previous, next, FULL_CAPABILITIES_V2)).toEqual({
      kind: 'entity',
      entity: 'companions',
      changes: {
        statementId: 'line_1',
        upsertCompanions: {
          focus: {
            ...previous.companionGroupsByStatementId!.line_1.companionsById.focus,
            offset: 0.5,
          },
        },
        deleteCompanionIds: ['smile'],
        companionOrder: ['focus'],
      },
      state: next,
    });
  });

  it('falls back to tombstone-aware full state when statement capability is missing', () => {
    const previous = makeState();
    const next: CollaborativeSceneStateV2 = {
      ...previous,
      statementsById: {
        bg: previous.statementsById.bg,
      },
      statementOrder: ['bg'],
      companionGroupsByStatementId: {},
    };

    const plan = planCollaborativeStateTransactionV2(previous, next, {
      ...FULL_CAPABILITIES_V2,
      statements: false,
    }, { deletedAt: '2026-07-15T00:00:00.000Z' });

    expect(plan.kind).toBe('full');
    expect(plan).toEqual(expect.objectContaining({
      kind: 'full',
      reason: 'missing-statements-capability',
      state: expect.objectContaining({
        statementsById: {
          bg: previous.statementsById.bg,
        },
        statementOrder: ['bg'],
        tombstones: {
          statements: {
            line_1: { id: 'line_1', deletedAt: '2026-07-15T00:00:00.000Z' },
          },
          companions: {
            line_1: {
              focus: { id: 'focus', deletedAt: '2026-07-15T00:00:00.000Z' },
              smile: { id: 'smile', deletedAt: '2026-07-15T00:00:00.000Z' },
            },
          },
        },
      }),
    }));
  });

  it('falls back to full state for cross-entity or scene changes', () => {
    const previous = makeState();
    const next: CollaborativeSceneStateV2 = {
      ...previous,
      meta: { title: 'Renamed', fps: 60 },
      statementsById: {
        ...previous.statementsById,
        bg: {
          ...previous.statementsById.bg,
          time: 4,
        },
      },
    };

    expect(planCollaborativeStateTransactionV2(previous, next, FULL_CAPABILITIES_V2)).toEqual(expect.objectContaining({
      kind: 'full',
      reason: 'cross-entity-or-scene-change',
      state: next,
    }));
  });

  it('plans noop when no changes remain after tombstone filtering', () => {
    const previous: CollaborativeSceneStateV2 = {
      ...makeState(),
      tombstones: {
        statements: {
          stale: { id: 'stale', deletedAt: '2026-07-15T00:00:00.000Z' },
        },
      },
    };
    const next: CollaborativeSceneStateV2 = {
      ...previous,
      statementsById: {
        ...previous.statementsById,
        stale: {
          id: 'stale',
          time: 9,
          type: 'audio',
          params: {
            role: 'sfx',
            mode: 'play',
            instanceId: 'stale',
            file: 'sfx/stale.ogg',
            durationSeconds: 1,
          },
        },
      },
      statementOrder: [...previous.statementOrder, 'stale'],
    };

    const plan = planCollaborativeStateTransactionV2(previous, next, FULL_CAPABILITIES_V2);

    expect(plan).toEqual({
      kind: 'noop',
      state: filterTombstonedCollaborativeRecordsV2(next),
    });
    expect(plan.state.statementOrder).toEqual(['line_1', 'bg']);
    expect(plan.state.statementsById).not.toHaveProperty('stale');
  });

  it('adds v2 tombstones for removed statements, companions, visual records, and assets', () => {
    const previous: CollaborativeSceneStateV2 = {
      ...makeState(),
      visual: {
        visualTargets: {
          background: { targetType: 'background' },
        },
      },
      assets: {
        'background/classroom.png': {
          assetId: 'asset_bg',
          kind: 'background-image',
          importKind: 'background',
          projectRelativePath: 'background/classroom.png',
          entrypointPath: 'background/classroom.png',
          contentHash: 'sha256:bg',
          files: [],
          createdAt: '2026-07-15T00:00:00.000Z',
        },
      },
    };
    const next: CollaborativeSceneStateV2 = {
      ...previous,
      statementsById: {
        bg: previous.statementsById.bg,
      },
      statementOrder: ['bg'],
      companionGroupsByStatementId: {},
      visual: {},
      assets: {},
    };

    const withTombstones = addCollaborativeTombstonesForDeletedRecordsV2(
      previous,
      next,
      '2026-07-15T00:00:00.000Z',
    );

    expect(withTombstones.tombstones).toEqual({
      statements: {
        line_1: { id: 'line_1', deletedAt: '2026-07-15T00:00:00.000Z' },
      },
      companions: {
        line_1: {
          focus: { id: 'focus', deletedAt: '2026-07-15T00:00:00.000Z' },
          smile: { id: 'smile', deletedAt: '2026-07-15T00:00:00.000Z' },
        },
      },
      visualTargets: {
        background: { id: 'background', deletedAt: '2026-07-15T00:00:00.000Z' },
      },
      assets: {
        'background/classroom.png': {
          id: 'background/classroom.png',
          deletedAt: '2026-07-15T00:00:00.000Z',
        },
      },
    });
  });
});
