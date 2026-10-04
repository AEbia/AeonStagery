import { promises as fs, type Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as Y from 'yjs';
import { COLLABORATION_SCHEMA_VERSION_V3 } from '../../src/api/types/collaboration';
import { SCENE_SCHEMA_VERSION_V5 } from '../../src/api/types/semantic-scene';
import { COLLABORATIVE_SCENE_ROOT } from '../../src/services/collaboration/CollaborativeYDocStore';

const SESSION_ROOT_NAME = 'collaboration-sessions';
const STATE_FILE_NAME = 'room-state.bin';

export interface CollaborationSessionSummary {
  name: string;
  dataDir: string;
  sizeBytes: number;
  updatedAt: string;
  hasState: boolean;
  active: boolean;
}

export interface ClearCollaborationSessionsResult {
  cleared: CollaborationSessionSummary[];
  skippedActive: CollaborationSessionSummary[];
}

interface DirectorySummary {
  sizeBytes: number;
  updatedAtMs: number;
}

export function getCollaborationSessionsRoot(userDataPath: string): string {
  return path.resolve(userDataPath, SESSION_ROOT_NAME);
}

async function hasRoomState(dataDir: string): Promise<boolean> {
  try {
    const state = await fs.stat(path.join(dataDir, STATE_FILE_NAME));
    return state.isFile() && state.size > 0;
  } catch {
    return false;
  }
}

/** Keep room storage tied to project identity so a later host can resume it. */
export async function resolveProjectCollaborationSessionDataDir(
  userDataPath: string,
  projectId: string,
): Promise<string> {
  if (!projectId.trim()) throw new Error('A project ID is required to host collaboration');
  const root = getCollaborationSessionsRoot(userDataPath);
  const digest = createHash('sha256').update(projectId).digest('hex');
  const stableDir = path.join(root, `project-${digest}`);
  if (await hasRoomState(stableDir)) return stableDir;

  // Older releases created a timestamped directory for every host attempt.
  // Inspect only their room state files, newest first, to recover the last room.
  const candidates = await Promise.all((await readSessionEntries(root))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !/^project-[0-9a-f]{64}$/.test(entry.name))
    .map(async (entry) => {
      const dataDir = path.join(root, entry.name);
      try {
        const state = await fs.stat(path.join(dataDir, STATE_FILE_NAME));
        return state.isFile() && state.size > 0 ? { dataDir, modifiedAt: state.mtimeMs } : null;
      } catch {
        return null;
      }
    }));
  candidates.sort((left, right) => (right?.modifiedAt ?? 0) - (left?.modifiedAt ?? 0));
  for (const candidate of candidates) {
    if (!candidate) continue;
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, new Uint8Array(await fs.readFile(path.join(candidate.dataDir, STATE_FILE_NAME))));
      const scene = doc.getMap<unknown>(COLLABORATIVE_SCENE_ROOT);
      if (
        scene.get('schemaVersion') === COLLABORATION_SCHEMA_VERSION_V3
        && scene.get('sceneSchemaVersion') === SCENE_SCHEMA_VERSION_V5
        && scene.get('collaborationProjectId') === projectId
      ) return candidate.dataDir;
    } catch {
      // An unrelated or damaged historical room must not prevent a new one.
    } finally {
      doc.destroy();
    }
  }
  return stableDir;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

async function summarizePath(targetPath: string): Promise<DirectorySummary> {
  const stat = await fs.lstat(targetPath);
  if (!stat.isDirectory()) {
    return { sizeBytes: stat.isFile() ? stat.size : 0, updatedAtMs: stat.mtimeMs };
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  let sizeBytes = 0;
  let updatedAtMs = stat.mtimeMs;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const child = await summarizePath(path.join(targetPath, entry.name));
    sizeBytes += child.sizeBytes;
    updatedAtMs = Math.max(updatedAtMs, child.updatedAtMs);
  }
  return { sizeBytes, updatedAtMs };
}

async function readSessionEntries(rootPath: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(rootPath, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function buildSessionSummary(
  rootPath: string,
  entry: Dirent,
  activeDataDir: string | undefined,
): Promise<CollaborationSessionSummary | null> {
  if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
  const dataDir = path.join(rootPath, entry.name);
  const summary = await summarizePath(dataDir);
  let hasState = false;
  try {
    const state = await fs.stat(path.join(dataDir, STATE_FILE_NAME));
    hasState = state.isFile() && state.size > 0;
  } catch {
    hasState = false;
  }

  return {
    name: entry.name,
    dataDir,
    sizeBytes: summary.sizeBytes,
    updatedAt: new Date(summary.updatedAtMs).toISOString(),
    hasState,
    active: !!activeDataDir && samePath(dataDir, activeDataDir),
  };
}

export async function listCollaborationSessions(
  userDataPath: string,
  activeDataDir?: string,
): Promise<CollaborationSessionSummary[]> {
  const rootPath = getCollaborationSessionsRoot(userDataPath);
  const entries = await readSessionEntries(rootPath);
  const sessions = await Promise.all(
    entries.map((entry) => buildSessionSummary(rootPath, entry, activeDataDir)),
  );
  return sessions
    .filter((session): session is CollaborationSessionSummary => !!session)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function clearPreviousCollaborationSessions(
  userDataPath: string,
  activeDataDir?: string,
): Promise<ClearCollaborationSessionsResult> {
  const sessions = await listCollaborationSessions(userDataPath, activeDataDir);
  const cleared: CollaborationSessionSummary[] = [];
  const skippedActive: CollaborationSessionSummary[] = [];
  for (const session of sessions) {
    if (session.active) {
      skippedActive.push(session);
      continue;
    }
    await fs.rm(session.dataDir, { recursive: true, force: true });
    cleared.push(session);
  }
  return { cleared, skippedActive };
}
