import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COLLABORATION_SCHEMA_VERSION_V2,
  type CollaborativeSceneStateV2,
} from '../api/types/collaboration';
import { SCENE_SCHEMA_VERSION_V4 } from '../api/types/semantic-scene';
import { CollaborationPersistence } from '../../server/collaboration/persistence';
import {
  SingleRoomCollaborationRoomV2,
} from '../../server/collaboration/room';

function makeStateV2(): CollaborativeSceneStateV2 {
  return {
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V4,
    collaborationProjectId: 'project_1',
    roomId: 'project_1:main',
    sceneId: 'scene_v2',
    meta: { title: 'Seeded Scene V2', fps: 60 },
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

describe('SingleRoomCollaborationRoomV2', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aeonstagery-collab-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('seeds and reloads a v2 room with source-document snapshot persistence', async () => {
    const persistence = new CollaborationPersistence(tempDir);
    const room = new SingleRoomCollaborationRoomV2(persistence);

    await room.seed(makeStateV2());

    expect(room.hasState()).toBe(true);
    expect(await persistence.hasPersistedState()).toBe(true);
    expect((await persistence.loadSnapshotV2())?.statements.map((statement) => statement.id)).toEqual(['line_1']);

    const reloaded = new SingleRoomCollaborationRoomV2(new CollaborationPersistence(tempDir));
    await reloaded.load();
    expect(reloaded.getState()?.sceneId).toBe('scene_v2');
    expect(reloaded.getMaterializedSceneDocument()?.meta.title).toBe('Seeded Scene V2');
  });

  it('rejects an update with a legacy schema marker in a v2 room', async () => {
    const room = new SingleRoomCollaborationRoomV2(new CollaborationPersistence(tempDir));
    await room.seed(makeStateV2());

    const clientDoc = new Y.Doc();
    Y.applyUpdate(clientDoc, room.encodeStateAsUpdate());
    const stateVector = Y.encodeStateVector(clientDoc);
    clientDoc.getMap<unknown>('collaborativeScene').set('schemaVersion', 1);
    const mixedVersionUpdate = Y.encodeStateAsUpdate(clientDoc, stateVector);

    await expect(room.applyUpdate(mixedVersionUpdate))
      .rejects.toThrow('schema version 2 state');
    expect(room.getState()?.sceneId).toBe('scene_v2');
  });
});
