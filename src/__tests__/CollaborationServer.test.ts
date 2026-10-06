import { authenticatedFetch } from './helpers/collaborationAuth';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COLLABORATION_SCHEMA_VERSION_V2,
  type CollaborativeSceneStateV2,
} from '../api/types/collaboration';
import { SCENE_SCHEMA_VERSION_V4 } from '../api/types/semantic-scene';
import { startCollaborationServer, type RunningCollaborationServer } from '../../server/collaboration/server';

function makeLegacyStatePayload(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    collaborationProjectId: 'project_1',
    roomId: 'project_1:main',
    sceneId: 'scene_v1',
    meta: { title: 'Server Scene V1' },
    actionsById: { wait_1: { _id: 'wait_1', action: 'wait', time: 1, params: {} } },
    timelineOrder: ['wait_1'],
  };
}

function makeStateV2(): CollaborativeSceneStateV2 {
  return {
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V4,
    collaborationProjectId: 'project_1',
    roomId: 'project_1:main',
    sceneId: 'scene_v2',
    meta: { title: 'Server Scene V2', fps: 60 },
    statementsById: {
      line_1: {
        id: 'line_1',
        time: 1,
        type: 'dialogue',
        params: {
          text: 'Hello from v2',
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

describe('startCollaborationServer', () => {
  let tempDir: string;
  let server: RunningCollaborationServer | null = null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aeonstagery-collab-server-'));
  });

  afterEach(async () => {
    await server?.stop();
    server = null;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('serves collaboration schema v2 state and source-document snapshots in v2 mode', async () => {
    server = await startCollaborationServer({
      host: '127.0.0.1',
      port: 0,
      dataDir: tempDir,
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
    });

    const status = server.getStatus();
    expect(status.schemaVersion).toBe(COLLABORATION_SCHEMA_VERSION_V2);

    const health = await readJson<{ schemaVersion: number; hasState: boolean }>(
      await authenticatedFetch(status, `${status.localUrl}/health`),
    );
    expect(health.schemaVersion).toBe(COLLABORATION_SCHEMA_VERSION_V2);
    expect(health.hasState).toBe(false);

    const seedResponse = await authenticatedFetch(status, `${status.localUrl}/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeStateV2()),
    });
    expect(seedResponse.status).toBe(201);

    const state = await readJson<CollaborativeSceneStateV2>(await authenticatedFetch(status, `${status.localUrl}/state`));
    expect(state.schemaVersion).toBe(COLLABORATION_SCHEMA_VERSION_V2);
    expect(state.statementOrder).toEqual(['line_1']);

    const snapshot = await readJson<{ schemaVersion: number; statements: Array<{ id: string }> }>(
      await authenticatedFetch(status, `${status.localUrl}/snapshot`),
    );
    expect(snapshot.schemaVersion).toBe(SCENE_SCHEMA_VERSION_V4);
    expect(snapshot.statements.map((statement) => statement.id)).toEqual(['line_1']);
  });

  it('rejects legacy v1 seed payloads in schema v2 mode', async () => {
    server = await startCollaborationServer({
      host: '127.0.0.1',
      port: 0,
      dataDir: tempDir,
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
    });

    const status = server.getStatus();
    const seedResponse = await authenticatedFetch(status, `${status.localUrl}/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeLegacyStatePayload()),
    });

    expect(seedResponse.status).toBe(400);
    const body = await readJson<{ error: string }>(seedResponse);
    expect(body.error).toContain(`schema version ${COLLABORATION_SCHEMA_VERSION_V2}`);
    expect(server.getStatus().hasState).toBe(false);
  });
});
