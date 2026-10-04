import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  COLLABORATION_SCHEMA_VERSION_V3,
  type CollaborativeSceneStateV2,
  type CollaborativeSceneStateV3,
} from '../api/types/collaboration';
import {
  SCENE_SCHEMA_VERSION_V5,
  type HistoricalSceneDocumentV4,
  type SceneDocumentV5,
} from '../api/types/semantic-scene';
import { getSceneDocumentCanonicalOrder } from '../services/semantic-scene';
import {
  createCollaborativeSceneStateV3FromDocument,
  materializeCollaborativeSceneDocumentV5,
} from '../services/collaboration/CollaborativeSceneStateV3';

function makeCanonicalV5Document(): SceneDocumentV5 {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION_V5,
    sceneId: 'scene_v3_room',
    meta: {
      title: 'Collaborative V3 Canonical Scene',
      fps: 60,
      markers: [
        { markerId: 'm1', time: 1, label: 'Beat' },
      ],
      characters: [
        { id: 'tomori', name: 'Tomori', model: 'figure/tomori/model.json' },
      ],
    },
    visual: {
      visualTargets: {
        tomori: {
          targetType: 'character',
          rimLightBaseline: {
            color: '#FFFFFF',
            intensity: 0.8,
            thickness: 0.2,
            angle: 45,
            softness: 0.5,
          },
        },
      },
      segments: {
        intro: {
          boundaryRef: { startMarkerId: 'm1' },
          lensStyleBaseline: {
            grade: {
              recipeId: 'warm_grade',
            },
          },
        },
      },
      recipeOverlay: {
        warm_grade: {
          stack: 'lens',
          slot: 'grade',
          payload: { brightness: 1.1 },
        },
      },
    },
    statements: [
      {
        id: 'line_1',
        time: 1,
        type: 'dialogue',
        params: {
          speakerId: 'tomori',
          text: 'Hello from canonical v5',
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

describe('CollaborativeSceneStateV3', () => {
  it('creates statement-backed collaboration-v3 state from canonical scene-v5 contract', () => {
    const v5Doc = makeCanonicalV5Document();
    const state = createCollaborativeSceneStateV3FromDocument(v5Doc, {
      collaborationProjectId: 'project_v3',
      roomId: 'project_v3:main',
    });

    expect(state.schemaVersion).toBe(COLLABORATION_SCHEMA_VERSION_V3);
    expect(state.sceneSchemaVersion).toBe(SCENE_SCHEMA_VERSION_V5);
    expect(state.statementOrder).toEqual(['line_1', 'bg', 'sfx']);
    expect(state.statementsById.line_1.type).toBe('dialogue');
    expect((state.statementsById.line_1 as any).companions).toBeUndefined();
    expect(state.companionGroupsByStatementId?.line_1.companionOrder).toEqual(['focus', 'smile']);
    expect(state.companionGroupsByStatementId?.line_1.companionsById.focus.type).toBe('camera');
    expect(state.markersById?.m1.label).toBe('Beat');
    expect(state.visual?.visualTargets?.tomori).toBeDefined();
    expect(state.visual?.segments?.intro).toBeDefined();
    expect(state.visual?.recipeOverlay?.warm_grade).toBeDefined();

    expectTypeOf(state).toMatchTypeOf<CollaborativeSceneStateV3>();
    expectTypeOf(state).not.toMatchTypeOf<CollaborativeSceneStateV2>();
  });

  it('materializes canonical SceneDocumentV5 preserving statement/companion ordering, markers, and visual block', () => {
    const v5Doc = makeCanonicalV5Document();
    const state = createCollaborativeSceneStateV3FromDocument(v5Doc, {
      collaborationProjectId: 'project_v3',
      roomId: 'project_v3:main',
    });

    const materialized = materializeCollaborativeSceneDocumentV5(state);
    expect(materialized.schemaVersion).toBe(SCENE_SCHEMA_VERSION_V5);
    expect(materialized.sceneId).toBe('scene_v3_room');
    expect(materialized.meta.title).toBe('Collaborative V3 Canonical Scene');
    expect(materialized.meta.markers?.map((m) => m.markerId)).toEqual(['m1']);
    expect(materialized.statements.map((s) => s.id)).toEqual(['line_1', 'bg', 'sfx']);
    expect(materialized.statements[0].companions?.map((c) => c.id)).toEqual(['focus', 'smile']);
    expect(materialized.visual?.visualTargets?.tomori).toBeDefined();
    expect(getSceneDocumentCanonicalOrder(materialized)).toEqual(['line_1', 'bg', 'sfx']);

    expectTypeOf(materialized).toMatchTypeOf<SceneDocumentV5>();
    expectTypeOf(materialized).not.toMatchTypeOf<HistoricalSceneDocumentV4>();
  });

  it('materializes correctly with tombstoned statements, companions, and markers filtered out', () => {
    const v5Doc = makeCanonicalV5Document();
    const state = createCollaborativeSceneStateV3FromDocument(v5Doc, {
      collaborationProjectId: 'project_v3',
      roomId: 'project_v3:main',
    });
    state.statementOrder = ['line_1', 'bg'];
    state.companionGroupsByStatementId!.line_1.companionOrder = ['focus'];
    state.tombstones = {
      statements: {
        sfx: { id: 'sfx', deletedAt: '2026-08-18T00:00:00.000Z' },
      },
      companions: {
        line_1: {
          smile: { id: 'smile', deletedAt: '2026-08-18T00:00:00.000Z' },
        },
      },
      markers: {
        m1: { id: 'm1', deletedAt: '2026-08-18T00:00:00.000Z' },
      },
    };

    const materialized = materializeCollaborativeSceneDocumentV5(state);
    expect(materialized.statements.map((s) => s.id)).toEqual(['line_1', 'bg']);
    expect(materialized.statements[0].companions?.map((c) => c.id)).toEqual(['focus']);
    expect(materialized.meta.markers).toBeUndefined();
  });

  it('rejects creation from non-v5 scene documents or scenes with unknown fields', () => {
    const v4Doc: any = {
      schemaVersion: 4,
      sceneId: 'scene_v4',
      meta: { title: 'V4' },
      statements: [],
    };

    expect(() => createCollaborativeSceneStateV3FromDocument(v4Doc, {
      collaborationProjectId: 'proj',
      roomId: 'room',
    })).toThrow();

    const v5WithUnknown: any = {
      ...makeCanonicalV5Document(),
      unknownRootProp: 'extra',
    };

    expect(() => createCollaborativeSceneStateV3FromDocument(v5WithUnknown, {
      collaborationProjectId: 'proj',
      roomId: 'room',
    })).toThrow();
  });
});
