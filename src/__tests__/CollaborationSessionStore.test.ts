import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearPreviousCollaborationSessions,
  getCollaborationSessionsRoot,
  listCollaborationSessions,
  resolveProjectCollaborationSessionDataDir,
} from '../../server/collaboration/sessionStore';

describe('collaboration session store', () => {
  let userDataPath: string;

  beforeEach(async () => {
    userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'aeonstagery-collaboration-sessions-'));
  });

  afterEach(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  it('lists direct session directories with size, state, and active status', async () => {
    const root = getCollaborationSessionsRoot(userDataPath);
    const activeDir = path.join(root, 'active-session');
    const historyDir = path.join(root, 'history-session');
    await fs.mkdir(activeDir, { recursive: true });
    await fs.mkdir(historyDir, { recursive: true });
    await fs.writeFile(path.join(activeDir, 'room-state.bin'), Buffer.from([1, 2]));
    await fs.writeFile(path.join(historyDir, 'asset-manifest.json'), '{"ok":true}');

    const sessions = await listCollaborationSessions(userDataPath, activeDir);

    expect(sessions).toHaveLength(2);
    expect(sessions.find((session) => session.name === 'active-session')).toMatchObject({
      hasState: true,
      active: true,
      sizeBytes: 2,
    });
    expect(sessions.find((session) => session.name === 'history-session')).toMatchObject({
      hasState: false,
      active: false,
    });
  });

  it('clears historical sessions while retaining the active server directory', async () => {
    const root = getCollaborationSessionsRoot(userDataPath);
    const activeDir = path.join(root, 'active-session');
    const historyDir = path.join(root, 'history-session');
    await fs.mkdir(activeDir, { recursive: true });
    await fs.mkdir(historyDir, { recursive: true });
    await fs.writeFile(path.join(activeDir, 'room-state.bin'), Buffer.from([1]));
    await fs.writeFile(path.join(historyDir, 'scene-snapshot.json'), '{}');

    const result = await clearPreviousCollaborationSessions(userDataPath, activeDir);

    expect(result.cleared.map((session) => session.name)).toEqual(['history-session']);
    expect(result.skippedActive.map((session) => session.name)).toEqual(['active-session']);
    await expect(fs.stat(activeDir)).resolves.toBeTruthy();
    await expect(fs.stat(historyDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses one stable directory for the same project and separates different projects', async () => {
    const first = await resolveProjectCollaborationSessionDataDir(userDataPath, 'project-one');
    const again = await resolveProjectCollaborationSessionDataDir(userDataPath, 'project-one');
    const other = await resolveProjectCollaborationSessionDataDir(userDataPath, 'project-two');

    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(path.dirname(first)).toBe(getCollaborationSessionsRoot(userDataPath));
  });

  it('finds an existing room from the previous timestamped session layout', async () => {
    const root = getCollaborationSessionsRoot(userDataPath);
    const oldDir = path.join(root, 'project-scene-2026-09-29T12-00-00');
    await fs.mkdir(oldDir, { recursive: true });
    const doc = new Y.Doc();
    const scene = doc.getMap('collaborativeScene');
    scene.set('schemaVersion', 3);
    scene.set('sceneSchemaVersion', 5);
    scene.set('collaborationProjectId', 'project-one');
    await fs.writeFile(path.join(oldDir, 'room-state.bin'), Buffer.from(Y.encodeStateAsUpdate(doc)));
    doc.destroy();

    expect(await resolveProjectCollaborationSessionDataDir(userDataPath, 'project-one')).toBe(oldDir);
    expect(await resolveProjectCollaborationSessionDataDir(userDataPath, 'project-two')).not.toBe(oldDir);
  });
});
