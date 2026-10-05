import { authenticatedFetch } from './helpers/collaborationAuth';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COLLABORATION_SCHEMA_VERSION_V2,
  COLLABORATION_SCHEMA_VERSION_V3,
  type CollaborativeSceneStateV2,
  type CollaborativeSceneStateV3,
} from '../api/types/collaboration';
import {
  SCENE_SCHEMA_VERSION_V4,
  SCENE_SCHEMA_VERSION_V5,
  type HistoricalSceneDocumentV4,
  type SceneDocumentV5,
} from '../api/types/semantic-scene';
import {
  startCollaborationServer,
  type RunningCollaborationServer,
} from '../../server/collaboration/server';

function makeStateV3(): CollaborativeSceneStateV3 {
  return {
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V5,
    collaborationProjectId: 'project_v3',
    roomId: 'project_v3:main',
    sceneId: 'scene_v3',
    meta: { title: 'Server Scene V3', fps: 60 },
    statementsById: {
      line_1: {
        id: 'line_1',
        time: 1,
        type: 'dialogue',
        params: {
          text: 'Hello from v3 server',
          durationSeconds: 2,
        },
      },
    },
    statementOrder: ['line_1'],
  };
}

function makeStateV2(): CollaborativeSceneStateV2 {
  return {
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V4,
    collaborationProjectId: 'project_v2',
    roomId: 'project_v2:main',
    sceneId: 'scene_v2',
    meta: { title: 'Server Scene V2', fps: 60 },
    statementsById: {
      line_1: {
        id: 'line_1',
        time: 1,
        type: 'dialogue',
        params: {
          text: 'Hello from v2 server',
          durationSeconds: 2,
        },
      },
    },
    statementOrder: ['line_1'],
  };
}

async function readJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

describe('CollaborationServer V3 and V2 backward compatibility', () => {
  let tempDir: string;
  let server: RunningCollaborationServer | null = null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aeonstagery-collab-server-v3-'));
  });

  afterEach(async () => {
    await server?.stop();
    server = null;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('serves collaboration schema v3 state and canonical scene v5 snapshot when started in v3 mode', async () => {
    server = await startCollaborationServer({
      host: '127.0.0.1',
      port: 0,
      dataDir: tempDir,
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
    });

    const status = server.getStatus();
    expect(status.schemaVersion).toBe(COLLABORATION_SCHEMA_VERSION_V3);

    const health = await readJson<{ schemaVersion: number; hasState: boolean }>(
      await authenticatedFetch(status, `${status.localUrl}/health`),
    );
    expect(health.schemaVersion).toBe(COLLABORATION_SCHEMA_VERSION_V3);
    expect(health.hasState).toBe(false);

    // Seed with v3 state
    const seedResponse = await authenticatedFetch(status, `${status.localUrl}/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeStateV3()),
    });
    expect(seedResponse.status).toBe(201);

    // /state returns CollaborativeSceneStateV3
    const state = await readJson<CollaborativeSceneStateV3>(await authenticatedFetch(status, `${status.localUrl}/state`));
    expect(state.schemaVersion).toBe(COLLABORATION_SCHEMA_VERSION_V3);
    expect(state.sceneSchemaVersion).toBe(SCENE_SCHEMA_VERSION_V5);
    expect(state.statementOrder).toEqual(['line_1']);

    // /snapshot returns canonical SceneDocumentV5
    const snapshot = await readJson<SceneDocumentV5>(
      await authenticatedFetch(status, `${status.localUrl}/snapshot`),
    );
    expect(snapshot.schemaVersion).toBe(SCENE_SCHEMA_VERSION_V5);
    expect(snapshot.statements.map((statement) => statement.id)).toEqual(['line_1']);

    // /yjs-state returns binary
    const yjsResponse = await authenticatedFetch(status, `${status.localUrl}/yjs-state`);
    expect(yjsResponse.status).toBe(200);
    const bytes = new Uint8Array(await yjsResponse.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it('rejects v2 seed payloads when running in v3 mode', async () => {
    server = await startCollaborationServer({
      host: '127.0.0.1',
      port: 0,
      dataDir: tempDir,
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
    });

    const status = server.getStatus();
    const seedResponse = await authenticatedFetch(status, `${status.localUrl}/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeStateV2()),
    });

    expect(seedResponse.status).toBe(400);
    const body = await readJson<{ error: string }>(seedResponse);
    expect(body.error).toContain(`schema version ${COLLABORATION_SCHEMA_VERSION_V3}`);
    expect(server.getStatus().hasState).toBe(false);
  });

  it('refuses to start v3 server on a dataDir containing persisted v2 state, providing export-and-reseed guidance', async () => {
    // 1. First run a v2 server to persist v2 state
    const v2Server = await startCollaborationServer({
      host: '127.0.0.1',
      port: 0,
      dataDir: tempDir,
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
    });
    const v2SeedResponse = await authenticatedFetch(v2Server.getStatus(), `${v2Server.getStatus().localUrl}/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeStateV2()),
    });
    expect(v2SeedResponse.status).toBe(201);
    await v2Server.stop();

    // 2. Try to start v3 server on the same dataDir
    await expect(startCollaborationServer({
      host: '127.0.0.1',
      port: 0,
      dataDir: tempDir,
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
    })).rejects.toThrow(/schema version 2|scene schema version 4/i);

    // 3. Verify the v2 server can still run and serve the room for export
    const v2AdminServer = await startCollaborationServer({
      host: '127.0.0.1',
      port: 0,
      dataDir: tempDir,
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
    });
    const snapshot = await readJson<HistoricalSceneDocumentV4>(
      await authenticatedFetch(v2AdminServer.getStatus(), `${v2AdminServer.getStatus().localUrl}/snapshot`),
    );
    expect(snapshot.schemaVersion).toBe(SCENE_SCHEMA_VERSION_V4);
    expect(snapshot.sceneId).toBe('scene_v2');
    await v2AdminServer.stop();
  });
});
