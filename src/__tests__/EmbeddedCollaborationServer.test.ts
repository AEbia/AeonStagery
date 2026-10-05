import { authenticatedFetch } from './helpers/collaborationAuth';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EmbeddedCollaborationServer } from '../../electron/embeddedCollaborationServer';
import { startCollaborationServer } from '../../server/collaboration/server';
import {
  getCollaborationSessionsRoot,
  resolveProjectCollaborationSessionDataDir,
} from '../../server/collaboration/sessionStore';
import { COLLABORATION_SCHEMA_VERSION_V3 } from '../api/types/collaboration';
import { SCENE_SCHEMA_VERSION_V5 } from '../api/types/semantic-scene';

describe('embedded collaboration server', () => {
  let userDataPath: string;
  let manager: EmbeddedCollaborationServer;

  beforeEach(async () => {
    userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'aeonstagery-embedded-collab-'));
    manager = new EmbeddedCollaborationServer();
  });

  afterEach(async () => {
    await manager.stop();
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  it('keeps an active room on repeat start and restores its state after stop', async () => {
    const input = { userDataPath, projectId: 'project-one', host: '127.0.0.1', port: 0 };
    const { status: first } = await manager.start(input);
    const seed = await authenticatedFetch(first, `${first.localUrl}/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
        sceneSchemaVersion: SCENE_SCHEMA_VERSION_V5,
        collaborationProjectId: 'project-one',
        roomId: 'project-one:main',
        sceneId: 'scene-one',
        meta: { title: 'Saved room', fps: 60 },
        statementsById: {},
        statementOrder: [],
      }),
    });
    expect(seed.status).toBe(201);

    const reused = await manager.start(input);
    expect(reused.reused).toBe(true);
    expect(reused.status.port).toBe(first.port);
    expect(reused.status.dataDir).toBe(first.dataDir);
    expect(reused.status.hasState).toBe(true);
    expect((await authenticatedFetch(first, `${first.localUrl}/health`)).ok).toBe(true);

    await manager.stop();
    const { status: restored } = await manager.start(input);
    expect(restored.dataDir).toBe(first.dataDir);
    expect(restored.hasState).toBe(true);
    expect((await (await authenticatedFetch(restored, `${restored.localUrl}/state`)).json()).collaborationProjectId).toBe('project-one');
  });

  it('coalesces simultaneous starts for one project', async () => {
    const input = { userDataPath, projectId: 'project-one', host: '127.0.0.1', port: 0 };
    const [first, second] = await Promise.all([manager.start(input), manager.start(input)]);
    expect(second.status.port).toBe(first.status.port);
    expect(second.status.dataDir).toBe(first.status.dataDir);
  });

  it('keeps different projects in separate rooms', async () => {
    const first = await manager.start({ userDataPath, projectId: 'project-one', host: '127.0.0.1', port: 0 });
    const second = await manager.start({ userDataPath, projectId: 'project-two', host: '127.0.0.1', port: 0 });
    expect(second.status.dataDir).not.toBe(first.status.dataDir);
    expect(second.status.hasState).toBe(false);
  });

  it('rejects a seed for a different project without occupying the selected room', async () => {
    const { status } = await manager.start({
      userDataPath,
      projectId: 'project-one',
      host: '127.0.0.1',
      port: 0,
    });
    const seed = (projectId: string) => authenticatedFetch(status, `${status.localUrl}/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
        sceneSchemaVersion: SCENE_SCHEMA_VERSION_V5,
        collaborationProjectId: projectId,
        roomId: `${projectId}:main`,
        sceneId: 'scene-one',
        meta: { title: 'Saved room', fps: 60 },
        statementsById: {},
        statementOrder: [],
      }),
    });

    const wrongProject = await seed('project-two');
    expect(wrongProject.status).toBe(409);
    expect(manager.getStatus()?.hasState).toBe(false);
    expect((await seed('project-one')).status).toBe(201);
  });

  it('refuses to resume a room containing another project identity', async () => {
    const dataDir = await resolveProjectCollaborationSessionDataDir(userDataPath, 'project-one');
    const oldServer = await startCollaborationServer({ host: '127.0.0.1', port: 0, dataDir });
    try {
      const response = await authenticatedFetch(oldServer.getStatus(), `${oldServer.getStatus().localUrl}/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
          sceneSchemaVersion: SCENE_SCHEMA_VERSION_V5,
          collaborationProjectId: 'project-two',
          roomId: 'project-two:main',
          sceneId: 'scene-two',
          meta: { title: 'Other room', fps: 60 },
          statementsById: {},
          statementOrder: [],
        }),
      });
      expect(response.status).toBe(201);
    } finally {
      await oldServer.stop();
    }

    await expect(manager.start({
      userDataPath,
      projectId: 'project-one',
      host: '127.0.0.1',
      port: 0,
    })).rejects.toThrow(/project-one.*project-two|project-two.*project-one/);
  });

  it('rejects a realtime update that changes the selected project identity', async () => {
    const { status } = await manager.start({
      userDataPath,
      projectId: 'project-one',
      host: '127.0.0.1',
      port: 0,
    });
    const seedResponse = await authenticatedFetch(status, `${status.localUrl}/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
        sceneSchemaVersion: SCENE_SCHEMA_VERSION_V5,
        collaborationProjectId: 'project-one',
        roomId: 'project-one:main',
        sceneId: 'scene-one',
        meta: { title: 'Saved room', fps: 60 },
        statementsById: {},
        statementOrder: [],
      }),
    });
    expect(seedResponse.status).toBe(201);

    const doc = new Y.Doc();
    const response = await authenticatedFetch(status, `${status.localUrl}/yjs-state`);
    Y.applyUpdate(doc, new Uint8Array(await response.arrayBuffer()));
    const stateVector = Y.encodeStateVector(doc);
    doc.getMap('collaborativeScene').set('collaborationProjectId', 'project-two');

    const socket = new WebSocket(`${status.localUrl.replace(/^http/, 'ws')}/sync?clientId=identity-test&displayName=Test`, ['aeonstagery-collaboration', `aeonstagery-auth.${status.accessToken}`]);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      const errorMessage = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Expected a project identity rejection')), 1500);
        socket.on('message', (data, isBinary) => {
          if (isBinary) return;
          const message = JSON.parse(data.toString()) as { type?: string; message?: string };
          if (message.type !== 'collaboration:error') return;
          clearTimeout(timeout);
          resolve(message.message ?? '');
        });
      });
      socket.send(Buffer.from(Y.encodeStateAsUpdate(doc, stateVector)));
      await expect(errorMessage).resolves.toMatch(/project-one.*project-two/);
      const state = await (await authenticatedFetch(status, `${status.localUrl}/state`)).json();
      expect(state.collaborationProjectId).toBe('project-one');
    } finally {
      socket.terminate();
      doc.destroy();
    }
  });

  it('restores a seeded room from the old timestamped directory', async () => {
    const oldDir = path.join(getCollaborationSessionsRoot(userDataPath), 'Old-2026-09-29T12-00-00');
    const oldServer = await startCollaborationServer({ host: '127.0.0.1', port: 0, dataDir: oldDir });
    try {
      const response = await authenticatedFetch(oldServer.getStatus(), `${oldServer.getStatus().localUrl}/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
          sceneSchemaVersion: SCENE_SCHEMA_VERSION_V5,
          collaborationProjectId: 'project-one',
          roomId: 'project-one:main',
          sceneId: 'scene-one',
          meta: { title: 'Previous room', fps: 60 },
          statementsById: {},
          statementOrder: [],
        }),
      });
      expect(response.status).toBe(201);
    } finally {
      await oldServer.stop();
    }

    const { status } = await manager.start({ userDataPath, projectId: 'project-one', host: '127.0.0.1', port: 0 });
    expect(status.dataDir).toBe(oldDir);
    expect(status.hasState).toBe(true);
  });

  it('does not clear a room whose start is still queued', async () => {
    const start = manager.start({ userDataPath, projectId: 'project-one', host: '127.0.0.1', port: 0 });
    const clear = manager.clearPreviousSessions(userDataPath);
    const [{ status }, result] = await Promise.all([start, clear]);
    expect(result.skippedActive.map((session) => session.dataDir)).toContain(status.dataDir);
    await expect(fs.stat(status.dataDir)).resolves.toBeTruthy();
  });
});
