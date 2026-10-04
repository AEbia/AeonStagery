import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  COLLABORATION_SCHEMA_VERSION_V2,
  type CollaborativeSceneStateV2,
} from '../api/types/collaboration';
import {
  SCENE_SCHEMA_VERSION_V4,
  SCENE_SCHEMA_VERSION_V5,
  type HistoricalSceneDocumentV4,
  type SceneDocumentV5,
} from '../api/types/semantic-scene';
import { getSceneDocumentCanonicalOrder } from '../services/semantic-scene';
import {
  createCollaborativeSceneStateV2FromDocument,
  materializeCollaborativeSceneDocumentV4,
} from '../services/collaboration/CollaborativeSceneStateV2';

function makeDocument(): HistoricalSceneDocumentV4 {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION_V4,
    sceneId: 'scene_v2',
    meta: {
      title: 'Collaborative V2',
      fps: 60,
      markers: [
        { markerId: 'm1', time: 1, label: 'Beat' },
      ],
      characters: [
        { id: 'tomori', name: 'Tomori', model: 'figure/tomori/model.json' },
      ],
    },
    statements: [
      {
        id: 'line_1',
        time: 1,
        type: 'dialogue',
        params: {
          speakerId: 'tomori',
          text: 'Hello',
          durationSeconds: 2,
        },
        companions: [
          {
            id: 'focus',
            anchor: 'start',
            offset: 0,
            type: 'camera',
            params: {
              mode: 'focus',
              target: '$speaker',
            },
          },
          {
            id: 'smile',
            anchor: 'start',
            offset: 0,
            type: 'characterPerformance',
            params: {
              target: '$speaker',
              expression: 'smile',
            },
          },
        ],
      },
      {
        id: 'bg',
        time: 1,
        type: 'environmentLayer',
        params: {
          mode: 'set',
          layerId: 'background',
          image: 'background/classroom.png',
        },
      },
      {
        id: 'sfx',
        time: 3,
        type: 'audio',
        params: {
          role: 'sfx',
          mode: 'play',
          instanceId: 'door',
          file: 'sfx/door.ogg',
          durationSeconds: 1,
        },
      },
    ],
  };
}

describe('CollaborativeSceneStateV2', () => {
  it('creates statement-backed collaboration-v2 state from the historical scene-v4 contract', () => {
    const state = createCollaborativeSceneStateV2FromDocument(makeDocument(), {
      collaborationProjectId: 'project_1',
      roomId: 'project_1:main',
    });

    expect(state.schemaVersion).toBe(COLLABORATION_SCHEMA_VERSION_V2);
    expect(state.sceneSchemaVersion).toBe(SCENE_SCHEMA_VERSION_V4);
    expect(state.statementOrder).toEqual(['line_1', 'bg', 'sfx']);
    expect(Object.keys(state.statementsById)).toEqual(['line_1', 'bg', 'sfx']);
    expect('companions' in state.statementsById.line_1).toBe(false);
    expect(state.companionGroupsByStatementId?.line_1.companionOrder).toEqual(['focus', 'smile']);
    expect(state.markersById?.m1.label).toBe('Beat');
    expect(state.meta).toEqual({
      title: 'Collaborative V2',
      fps: 60,
      characters: [
        { id: 'tomori', name: 'Tomori', model: 'figure/tomori/model.json' },
      ],
    });
  });

  it('does not admit a v5 document through the historical v2 seam', () => {
    const v5: SceneDocumentV5 = {
      schemaVersion: SCENE_SCHEMA_VERSION_V5,
      sceneId: 'scene-v5',
      meta: { title: 'Future scene' },
      statements: [],
    };
    expectTypeOf<SceneDocumentV5>().not.toMatchTypeOf<HistoricalSceneDocumentV4>();

    expect(() => createCollaborativeSceneStateV2FromDocument(
      v5 as unknown as HistoricalSceneDocumentV4,
      { collaborationProjectId: 'project_1', roomId: 'project_1:main' },
    )).toThrow(/historical scene schema version 4/);
  });

  it('materializes statements and companions with explicit collaborative order', () => {
    const state = createCollaborativeSceneStateV2FromDocument(makeDocument(), {
      collaborationProjectId: 'project_1',
      roomId: 'project_1:main',
    });
    state.statementOrder = ['bg', 'line_1', 'sfx'];
    state.companionGroupsByStatementId!.line_1.companionOrder = ['smile', 'focus'];

    const document = materializeCollaborativeSceneDocumentV4(state);

    expect(document.statements.map((statement) => statement.id)).toEqual(['bg', 'line_1', 'sfx']);
    expect(document.statements[1].companions?.map((companion) => companion.id)).toEqual(['smile', 'focus']);
    expect(document.meta.markers?.map((marker) => marker.markerId)).toEqual(['m1']);
  });

  it('retains canonical statementOrder metadata when materialized statements are time-sorted', () => {
    const state = createCollaborativeSceneStateV2FromDocument(makeDocument(), {
      collaborationProjectId: 'project_1',
      roomId: 'project_1:main',
    });
    state.statementOrder = ['sfx', 'line_1', 'bg'];

    const document = materializeCollaborativeSceneDocumentV4(state);

    expect(document.statements.map((statement) => statement.id)).toEqual(['line_1', 'bg', 'sfx']);
    expect(getSceneDocumentCanonicalOrder(document)).toEqual(['sfx', 'line_1', 'bg']);
  });

  it('filters tombstoned statements and companions only after their order entries are removed', () => {
    const state = createCollaborativeSceneStateV2FromDocument(makeDocument(), {
      collaborationProjectId: 'project_1',
      roomId: 'project_1:main',
    });
    state.statementOrder = ['line_1', 'bg'];
    state.companionGroupsByStatementId!.line_1.companionOrder = ['focus'];
    state.tombstones = {
      statements: {
        sfx: { id: 'sfx', deletedAt: '2026-07-14T00:00:00.000Z' },
      },
      companions: {
        line_1: {
          smile: { id: 'smile', deletedAt: '2026-07-14T00:00:00.000Z' },
        },
      },
    };

    const document = materializeCollaborativeSceneDocumentV4(state);

    expect(document.statements.map((statement) => statement.id)).toEqual(['line_1', 'bg']);
    expect(document.statements[0].companions?.map((companion) => companion.id)).toEqual(['focus']);
  });

  it('rejects missing, duplicate, and dangling statement order entries', () => {
    const state = createCollaborativeSceneStateV2FromDocument(makeDocument(), {
      collaborationProjectId: 'project_1',
      roomId: 'project_1:main',
    });

    expect(() => materializeCollaborativeSceneDocumentV4({
      ...state,
      statementOrder: ['line_1', 'bg'],
    })).toThrow(/Missing id "sfx" in statementOrder/);

    expect(() => materializeCollaborativeSceneDocumentV4({
      ...state,
      statementOrder: ['line_1', 'bg', 'bg', 'sfx'],
    })).toThrow(/Duplicate id "bg" in statementOrder/);

    expect(() => materializeCollaborativeSceneDocumentV4({
      ...state,
      statementOrder: ['line_1', 'bg', 'sfx', 'missing'],
    })).toThrow(/Dangling id "missing" in statementOrder/);
  });

  it('rejects missing companion order entries and dangling companion groups', () => {
    const state = createCollaborativeSceneStateV2FromDocument(makeDocument(), {
      collaborationProjectId: 'project_1',
      roomId: 'project_1:main',
    });

    expect(() => materializeCollaborativeSceneDocumentV4({
      ...state,
      companionGroupsByStatementId: {
        ...state.companionGroupsByStatementId,
        line_1: {
          companionsById: state.companionGroupsByStatementId!.line_1.companionsById,
          companionOrder: ['focus'],
        },
      },
    })).toThrow(/Missing id "smile" in companionOrder\[line_1\]/);

    expect(() => materializeCollaborativeSceneDocumentV4({
      ...state,
      companionGroupsByStatementId: {
        ...state.companionGroupsByStatementId,
        missing: {
          companionsById: {},
          companionOrder: [],
        },
      },
    })).toThrow(/Dangling companion group/);
  });

  it('rejects mixed collaboration and scene schema versions before materialization', () => {
    const state = createCollaborativeSceneStateV2FromDocument(makeDocument(), {
      collaborationProjectId: 'project_1',
      roomId: 'project_1:main',
    });

    expect(() => materializeCollaborativeSceneDocumentV4({
      ...state,
      schemaVersion: 1,
    } as unknown as CollaborativeSceneStateV2)).toThrow(/collaboration schema version 2/);

    expect(() => materializeCollaborativeSceneDocumentV4({
      ...state,
      sceneSchemaVersion: 1,
    } as unknown as CollaborativeSceneStateV2)).toThrow(/scene schema version 4/);
  });
});
