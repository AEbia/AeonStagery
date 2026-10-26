import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COLLABORATION_SCHEMA_VERSION_V3,
  type CollaborativeSceneStateV3,
} from '../api/types/collaboration';
import {
  SCENE_SCHEMA_VERSION_V4,
  SCENE_SCHEMA_VERSION_V5,
} from '../api/types/semantic-scene';
import { CollaborationPersistence } from '../../server/collaboration/persistence';
import {
  SingleRoomCollaborationRoomV3,
} from '../../server/collaboration/room';
import { writeLegacyCollaborationStateFixture, type LegacyCollaborationStateFixture } from './helpers/legacyCollaborationFixture';

function makeStateV3(): CollaborativeSceneStateV3 {
  return {
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V5,
    collaborationProjectId: 'project_v3',
    roomId: 'project_v3:main',
    sceneId: 'scene_v3',
    meta: { title: 'Seeded Scene V3', fps: 60 },
    statementsById: {
      line_1: {
        id: 'line_1',
        time: 1,
        type: 'dialogue',
        params: {
          text: 'Hello from v3 room',
          durationSeconds: 2,
        },
      },
    },
    statementOrder: ['line_1'],
  };
}

function makeStateV2(): LegacyCollaborationStateFixture {
  return {
    schemaVersion: 2,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V4,
    collaborationProjectId: 'project_v2',
    roomId: 'project_v2:main',
    sceneId: 'scene_v2',
    meta: { title: 'Seeded Scene V2', fps: 60 },
    statementsById: {
      line_1: {
        id: 'line_1',
        time: 1,
        type: 'dialogue',
        params: {
          text: 'Hello from v2 room',
          durationSeconds: 2,
        },
      },
    },
    statementOrder: ['line_1'],
  };
}

describe('SingleRoomCollaborationRoomV3', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aeonstagery-collab-v3-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('seeds and reloads a v3 room with source-document snapshot persistence for scene v5', async () => {
    const persistence = new CollaborationPersistence(tempDir);
    const room = new SingleRoomCollaborationRoomV3(persistence);

    await room.seed(makeStateV3());

    expect(room.hasState()).toBe(true);
    expect(await persistence.hasPersistedState()).toBe(true);
    const snapshot = await persistence.loadSnapshotV3();
    expect(snapshot?.schemaVersion).toBe(SCENE_SCHEMA_VERSION_V5);
    expect(snapshot?.statements.map((statement) => statement.id)).toEqual(['line_1']);

    const reloaded = new SingleRoomCollaborationRoomV3(new CollaborationPersistence(tempDir));
    await reloaded.load();
    expect(reloaded.getState()?.schemaVersion).toBe(COLLABORATION_SCHEMA_VERSION_V3);
    expect(reloaded.getState()?.sceneSchemaVersion).toBe(SCENE_SCHEMA_VERSION_V5);
    expect(reloaded.getState()?.sceneId).toBe('scene_v3');
    expect(reloaded.getMaterializedSceneDocument()?.meta.title).toBe('Seeded Scene V3');
    expect(reloaded.getMaterializedSceneDocument()?.schemaVersion).toBe(SCENE_SCHEMA_VERSION_V5);
  });

  it('refuses to load persisted v2 room data, provides clear export-and-reseed guidance, and leaves room untouched', async () => {
    const v2Persistence = new CollaborationPersistence(tempDir);
    const legacyDoc = new Y.Doc();
    writeLegacyCollaborationStateFixture(legacyDoc, makeStateV2());
    await v2Persistence.saveDoc(legacyDoc);
    legacyDoc.destroy();
    await fs.writeFile(v2Persistence.paths.snapshotFile, JSON.stringify({ schemaVersion: 4, sceneId: 'scene_v2' }));
    await v2Persistence.saveManifest({});

    // Record persisted files on disk
    const stateFileBytesBefore = await fs.readFile(v2Persistence.paths.stateFile);
    const snapshotFileBytesBefore = await fs.readFile(v2Persistence.paths.snapshotFile);
    const manifestFileBytesBefore = await fs.readFile(v2Persistence.paths.manifestFile);

    // 2. Try to load the dataDir with SingleRoomCollaborationRoomV3
    const v3Persistence = new CollaborationPersistence(tempDir);
    const v3Room = new SingleRoomCollaborationRoomV3(v3Persistence);

    await expect(v3Room.load()).rejects.toThrow(/schema version 2.*scene schema version 4/i);
    await expect(v3Room.load()).rejects.toThrow(/older AeonStagery release/);

    // 3. Verify the files on disk were left completely untouched
    const stateFileBytesAfter = await fs.readFile(v2Persistence.paths.stateFile);
    const snapshotFileBytesAfter = await fs.readFile(v2Persistence.paths.snapshotFile);
    const manifestFileBytesAfter = await fs.readFile(v2Persistence.paths.manifestFile);

    expect(stateFileBytesAfter.equals(stateFileBytesBefore)).toBe(true);
    expect(snapshotFileBytesAfter.equals(snapshotFileBytesBefore)).toBe(true);
    expect(manifestFileBytesAfter.equals(manifestFileBytesBefore)).toBe(true);

  });

  it('rejects an update with a non-v3 schema marker in a v3 room', async () => {
    const room = new SingleRoomCollaborationRoomV3(new CollaborationPersistence(tempDir));
    await room.seed(makeStateV3());

    const clientDoc = new Y.Doc();
    Y.applyUpdate(clientDoc, room.encodeStateAsUpdate());
    const stateVector = Y.encodeStateVector(clientDoc);
    clientDoc.getMap<unknown>('collaborativeScene').set('schemaVersion', 2);
    const mixedVersionUpdate = Y.encodeStateAsUpdate(clientDoc, stateVector);

    await expect(room.applyUpdate(mixedVersionUpdate))
      .rejects.toThrow('schema version 3 state');
    expect(room.getState()?.sceneId).toBe('scene_v3');
  });
});
