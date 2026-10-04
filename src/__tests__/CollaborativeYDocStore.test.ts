import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  COLLABORATION_SCHEMA_VERSION_V2,
  type CollaborativeSceneStateV2,
} from '../api/types/collaboration';
import {
  SCENE_SCHEMA_VERSION_V4,
  type HistoricalSceneDocumentV4,
} from '../api/types/semantic-scene';
import { materializeCollaborativeSceneDocumentV4 } from '../services/collaboration/CollaborativeSceneStateV2';
import {
  COLLABORATIVE_SCENE_ROOT,
  hasCollaborativeStateV2,
  readCollaborativeStateV2FromYDoc,
  writeCollaborativeCompanionChangesV2ToYDoc,
  writeCollaborativeMarkerChangesToYDoc,
  writeCollaborativeStateV2ToYDoc,
  writeCollaborativeStatementChangesV2ToYDoc,
  writeCollaborativeVisualTargetChangesToYDoc,
} from '../services/collaboration/CollaborativeYDocStore';

function makeDocument(): HistoricalSceneDocumentV4 {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION_V4,
    sceneId: 'scene_v2',
    meta: {
      title: 'Collaborative Scene V2',
      fps: 60,
      markers: [{ markerId: 'm1', time: 1, label: 'Beat' }],
      characters: [{ id: 'tomori', name: 'Tomori', model: 'figure/tomori/model.json' }],
    },
    visual: {
      visualTargets: {
        background: {
          targetType: 'background',
          targetEnvironmentOverride: { warmthBias: 0.25 },
        },
      },
    },
    statements: [
      {
        id: 'line_1',
        time: 1,
        type: 'dialogue',
        params: { speakerId: 'tomori', text: 'Hello', durationSeconds: 2 },
        companions: [
          {
            id: 'focus',
            anchor: 'start',
            offset: 0,
            type: 'camera',
            params: { mode: 'focus', target: '$speaker' },
          },
          {
            id: 'smile',
            anchor: 'start',
            offset: 0,
            type: 'characterPerformance',
            params: { target: '$speaker', expression: 'smile' },
          },
        ],
      },
      {
        id: 'bg',
        time: 1,
        type: 'environmentLayer',
        params: { mode: 'set', layerId: 'background', image: 'background/classroom.png' },
      },
      {
        id: 'sfx',
        time: 3,
        type: 'audio',
        params: { role: 'sfx', mode: 'play', instanceId: 'door', file: 'sfx/door.ogg', durationSeconds: 1 },
      },
    ],
  };
}

function makeState(): CollaborativeSceneStateV2 {
  return {
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V4,
    collaborationProjectId: 'project_v2',
    roomId: 'project_v2:main',
    sceneId: 'scene_v2',
    meta: makeDocument().meta,
    visual: makeDocument().visual,
    statementsById: {
      line_1: makeDocument().statements[0],
      bg: makeDocument().statements[1],
      sfx: makeDocument().statements[2],
    },
    statementOrder: ['line_1', 'bg', 'sfx'],
    companionGroupsByStatementId: {
      line_1: {
        companionsById: {
          focus: makeDocument().statements[0].companions![0],
          smile: makeDocument().statements[0].companions![1],
        },
        companionOrder: ['focus', 'smile'],
      },
    },
  };
}

describe('CollaborativeYDocStore v2', () => {
  it('round-trips source state and nested companion groups through a Y.Doc', () => {
    const doc = new Y.Doc();
    const state = makeState();

    writeCollaborativeStateV2ToYDoc(doc, state);

    const root = doc.getMap<unknown>(COLLABORATIVE_SCENE_ROOT);
    expect(root.get('statementsById')).toBeInstanceOf(Y.Map);
    expect(root.get('statementOrder')).toBeInstanceOf(Y.Array);
    expect(root.get('companionGroupsByStatementId')).toBeInstanceOf(Y.Map);
    expect(readCollaborativeStateV2FromYDoc(doc)).toEqual(state);
    expect(hasCollaborativeStateV2(doc)).toBe(true);
    expect(materializeCollaborativeSceneDocumentV4(state).statements.map((statement) => statement.id))
      .toEqual(['line_1', 'bg', 'sfx']);
  });

  it('round-trips v2 state through a binary Yjs update', () => {
    const source = new Y.Doc();
    writeCollaborativeStateV2ToYDoc(source, makeState());

    const target = new Y.Doc();
    Y.applyUpdate(target, Y.encodeStateAsUpdate(source));

    const restored = readCollaborativeStateV2FromYDoc(target);
    expect(restored?.sceneId).toBe('scene_v2');
    expect(restored?.statementOrder).toEqual(['line_1', 'bg', 'sfx']);
    expect(restored?.companionGroupsByStatementId?.line_1.companionOrder).toEqual(['focus', 'smile']);
  });

  it('rejects a legacy schema marker without exposing a v1 reader', () => {
    const doc = new Y.Doc();
    writeCollaborativeStateV2ToYDoc(doc, makeState());
    doc.getMap<unknown>(COLLABORATIVE_SCENE_ROOT).set('schemaVersion', 1);

    expect(readCollaborativeStateV2FromYDoc(doc)).toBeNull();
    expect(hasCollaborativeStateV2(doc)).toBe(false);
  });

  it('filters statement, companion, marker, and visual tombstones on full writes', () => {
    const doc = new Y.Doc();
    const state = makeState();
    state.statementOrder = ['line_1', 'bg'];
    state.tombstones = {
      statements: { sfx: { id: 'sfx', deletedAt: '2026-07-15T00:00:00.000Z' } },
      companions: { line_1: { smile: { id: 'smile', deletedAt: '2026-07-15T00:00:00.000Z' } } },
      markers: { m1: { id: 'm1', deletedAt: '2026-07-15T00:00:00.000Z' } },
      visualTargets: { background: { id: 'background', deletedAt: '2026-07-15T00:00:00.000Z' } },
    };

    writeCollaborativeStateV2ToYDoc(doc, state);
    const restored = readCollaborativeStateV2FromYDoc(doc)!;

    expect(restored.statementsById.sfx).toBeUndefined();
    expect(restored.statementOrder).toEqual(['line_1', 'bg']);
    expect(restored.companionGroupsByStatementId?.line_1.companionsById.smile).toBeUndefined();
    expect(restored.companionGroupsByStatementId?.line_1.companionOrder).toEqual(['focus']);
    expect(restored.markersById).toBeUndefined();
    expect(restored.visual).toBeUndefined();
    expect(materializeCollaborativeSceneDocumentV4(restored).statements.map((statement) => statement.id))
      .toEqual(['line_1', 'bg']);
  });

  it('applies statement and companion changes with delete tombstones', () => {
    const doc = new Y.Doc();
    writeCollaborativeStateV2ToYDoc(doc, makeState());

    writeCollaborativeStatementChangesV2ToYDoc(doc, {
      upsertStatements: {
        bg: {
          id: 'bg',
          time: 2,
          type: 'environmentLayer',
          params: { mode: 'set', layerId: 'background', image: 'background/evening.png' },
        },
      },
      deleteStatementIds: ['sfx'],
      statementOrder: ['line_1', 'bg'],
      deletedAt: '2026-07-15T00:00:00.000Z',
      deletedBy: 'client-a',
    });
    writeCollaborativeCompanionChangesV2ToYDoc(doc, {
      statementId: 'line_1',
      deleteCompanionIds: ['smile'],
      companionOrder: ['focus'],
      deletedAt: '2026-07-15T00:00:00.000Z',
      deletedBy: 'client-a',
    });

    const restored = readCollaborativeStateV2FromYDoc(doc)!;
    expect(restored.statementsById.bg.time).toBe(2);
    expect(restored.statementsById.sfx).toBeUndefined();
    expect(restored.tombstones?.statements?.sfx?.deletedBy).toBe('client-a');
    expect(restored.companionGroupsByStatementId?.line_1.companionOrder).toEqual(['focus']);
    expect(restored.tombstones?.companions?.line_1?.smile?.deletedBy).toBe('client-a');
  });

  it('applies marker and visual target changes through the v2 root', () => {
    const doc = new Y.Doc();
    writeCollaborativeStateV2ToYDoc(doc, makeState());

    writeCollaborativeMarkerChangesToYDoc(doc, {
      deleteMarkerIds: ['m1'],
      deletedAt: '2026-07-15T00:00:00.000Z',
    });
    writeCollaborativeVisualTargetChangesToYDoc(doc, {
      deleteVisualTargetIds: ['background'],
      deletedAt: '2026-07-15T00:00:00.000Z',
    });

    const restored = readCollaborativeStateV2FromYDoc(doc)!;
    expect(restored.markersById).toBeUndefined();
    expect(restored.visual).toBeUndefined();
    expect(restored.tombstones?.markers?.m1).toBeDefined();
    expect(restored.tombstones?.visualTargets?.background).toBeDefined();
  });

  it('keeps statement deletes winning over concurrent late updates', () => {
    const seed = new Y.Doc();
    writeCollaborativeStateV2ToYDoc(seed, makeState());
    const deleting = new Y.Doc();
    const updating = new Y.Doc();
    const seedUpdate = Y.encodeStateAsUpdate(seed);
    Y.applyUpdate(deleting, seedUpdate);
    Y.applyUpdate(updating, seedUpdate);
    const deleteVector = Y.encodeStateVector(deleting);
    const updateVector = Y.encodeStateVector(updating);

    writeCollaborativeStatementChangesV2ToYDoc(deleting, {
      deleteStatementIds: ['sfx'],
      statementOrder: ['line_1', 'bg'],
      deletedBy: 'client-delete',
    });
    writeCollaborativeStatementChangesV2ToYDoc(updating, {
      upsertStatements: {
        sfx: {
          id: 'sfx',
          time: 9,
          type: 'audio',
          params: { role: 'sfx', mode: 'play', instanceId: 'door', file: 'sfx/late.ogg', durationSeconds: 1 },
        },
      },
    });

    Y.applyUpdate(deleting, Y.encodeStateAsUpdate(updating, updateVector));
    Y.applyUpdate(updating, Y.encodeStateAsUpdate(deleting, deleteVector));
    expect(readCollaborativeStateV2FromYDoc(deleting)!.statementsById.sfx).toBeUndefined();
    expect(readCollaborativeStateV2FromYDoc(updating)!.statementsById.sfx).toBeUndefined();
  });
});
