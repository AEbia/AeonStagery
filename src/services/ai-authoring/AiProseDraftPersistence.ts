import {
  assertSafeDraftPathSegment,
  type DraftSession,
} from './AiProseDraftSession';
import {
  AiProseDraftMigrationError,
  migrateDraft,
} from './AiProseDraftMigration';

export interface AiProseDraftFileAccess {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<{ data: string; path?: string } | string>;
  writeFile(path: string, data: string): Promise<void>;
  replaceFile?(temporaryPath: string, destinationPath: string): Promise<void>;
  rename?(temporaryPath: string, destinationPath: string): Promise<void>;
  /** Explicit deletion seam for applied archives and stale drafts. */
  removeFile?(path: string): Promise<void>;
  ensureDir(path: string): Promise<void>;
  join(...parts: string[]): Promise<string> | string;
  dirname(path: string): Promise<string> | string;
}

export interface AiProseDraftPathAccess {
  join?(...parts: string[]): Promise<string> | string;
  dirname?(path: string): Promise<string> | string;
  resolveAbsolute?(projectRoot: string, relativePath: string): Promise<string> | string;
}

export interface AiProseDraftProject {
  projectRoot: string;
  assetRoots: { project: string };
}

export interface AiProseDraftProjectState {
  rootPath: string;
  metadata: { assetRoots: { project: string } };
}

export type AiProseDraftProjectInput = AiProseDraftProject | AiProseDraftProjectState;

export type AiProseDraftPersistenceErrorCode =
  | 'missing'
  | 'corrupt-json'
  | 'invalid-structure'
  | 'future-schema'
  | 'unsupported-schema'
  | 'unreadable'
  | 'invalid-path'
  | 'read-only'
  | 'atomic-write-unavailable'
  | 'write-failed'
  | 'delete-unavailable'
  | 'delete-failed';

export class AiProseDraftPersistenceError extends Error {
  constructor(
    message: string,
    readonly code: AiProseDraftPersistenceErrorCode,
    readonly path?: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AiProseDraftPersistenceError';
  }
}

export type AiProseDraftLoadResult =
  | {
      status: 'loaded';
      kind: 'loaded';
      path: string;
      draft: DraftSession;
      migratedFrom?: number;
    }
  | AiProseDraftLoadFailure;

export type AiProseDraftLoadFailure = {
  status: Exclude<AiProseDraftPersistenceErrorCode, 'read-only' | 'invalid-path'>;
  kind: Exclude<AiProseDraftPersistenceErrorCode, 'read-only' | 'invalid-path'>;
  path: string;
  error: AiProseDraftPersistenceError;
};

export class AiProseDraftPersistence {
  constructor(
    private readonly fileAccess: AiProseDraftFileAccess,
    private readonly pathAccess: AiProseDraftPathAccess = fileAccess,
  ) {}

  async resolvePath(
    project: AiProseDraftProjectInput,
    sceneId: string,
    sessionId: string,
  ): Promise<string> {
    try {
      assertSafeDraftPathSegment(sceneId, 'sceneId');
      assertSafeDraftPathSegment(sessionId, 'sessionId');
    } catch (cause) {
      throw new AiProseDraftPersistenceError(
        cause instanceof Error ? cause.message : 'sceneId and sessionId must be safe path segments',
        'invalid-path',
        undefined,
        cause,
      );
    }
    const context = normalizeProject(project);
    const assetRoot = normalizeAssetRoot(context.assetRoots.project);
    const relativePath = [assetRoot, 'ai-authoring', sceneId, `${sessionId}.json`].join('/');
    try {
      if (this.pathAccess.resolveAbsolute) {
        return await this.pathAccess.resolveAbsolute(context.projectRoot, relativePath);
      }
      if (!this.pathAccess.join) {
        throw new Error('A draft path seam must provide join or resolveAbsolute');
      }
      return await this.pathAccess.join(
        context.projectRoot,
        assetRoot,
        'ai-authoring',
        sceneId,
        `${sessionId}.json`,
      );
    } catch (cause) {
      throw new AiProseDraftPersistenceError(
        'Unable to resolve the AI prose draft path',
        'invalid-path',
        undefined,
        cause,
      );
    }
  }

  async saveCheckpoint(project: AiProseDraftProjectInput, draft: DraftSession): Promise<string> {
    const validated = validateForSave(draft, 'active');
    return this.write(project, validated);
  }

  async archiveApplied(project: AiProseDraftProjectInput, draft: DraftSession): Promise<string> {
    const validated = validateForSave(draft, 'applied');
    return this.write(project, validated);
  }

  async save(project: AiProseDraftProjectInput, draft: DraftSession): Promise<string> {
    return draft.status === 'applied'
      ? this.archiveApplied(project, draft)
      : this.saveCheckpoint(project, draft);
  }

  async loadResult(
    project: AiProseDraftProjectInput,
    sceneId: string,
    sessionId: string,
  ): Promise<AiProseDraftLoadResult> {
    const path = await this.resolvePath(project, sceneId, sessionId);
    let present: boolean;
    try {
      present = await this.fileAccess.exists(path);
    } catch (cause) {
      return this.failure(path, 'unreadable', 'Unable to determine whether the draft file exists', cause);
    }
    if (!present) return this.failure(path, 'missing', `Draft file does not exist: ${path}`);

    let rawJson: string;
    try {
      const result = await this.fileAccess.readFile(path);
      rawJson = typeof result === 'string' ? result : result.data;
    } catch (cause) {
      return this.failure(path, 'unreadable', `Unable to read draft file: ${path}`, cause);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(rawJson);
    } catch (cause) {
      return this.failure(path, 'corrupt-json', `Draft file contains invalid JSON: ${path}`, cause);
    }

    const originalVersion = readSchemaVersion(raw);
    try {
      const draft = migrateDraft(raw);
      return {
        status: 'loaded',
        kind: 'loaded',
        path,
        draft,
        ...(originalVersion !== undefined && originalVersion < draft.schemaVersion
          ? { migratedFrom: originalVersion }
          : {}),
      };
    } catch (cause) {
      if (cause instanceof AiProseDraftMigrationError) {
        return this.failure(path, cause.code, cause.message, cause);
      }
      return this.failure(path, 'invalid-structure', `Draft file has an invalid structure: ${path}`, cause);
    }
  }

  async load(
    project: AiProseDraftProjectInput,
    sceneId: string,
    sessionId: string,
  ): Promise<DraftSession> {
    const result = await this.loadResult(project, sceneId, sessionId);
    if (result.status === 'loaded') return result.draft;
    throw result.error;
  }

  async loadOrNull(
    project: AiProseDraftProjectInput,
    sceneId: string,
    sessionId: string,
  ): Promise<DraftSession | null> {
    const result = await this.loadResult(project, sceneId, sessionId);
    if (result.status === 'loaded') return result.draft;
    if (result.status === 'missing') return null;
    throw result.error;
  }

  /**
   * Explicitly delete a draft file (active checkpoint or applied archive).
   * Deletion is irreversible; the path is resolved exactly like save/load so
   * only drafts inside the project ai-authoring directory can be removed.
   */
  async deleteDraft(
    project: AiProseDraftProjectInput,
    sceneId: string,
    sessionId: string,
  ): Promise<void> {
    const path = await this.resolvePath(project, sceneId, sessionId);
    if (!this.fileAccess.removeFile) {
      throw new AiProseDraftPersistenceError(
        'Draft deletion is unavailable; the file was not modified',
        'delete-unavailable',
        path,
      );
    }
    let present: boolean;
    try {
      present = await this.fileAccess.exists(path);
    } catch (cause) {
      throw new AiProseDraftPersistenceError(
        'Unable to determine whether the draft file exists',
        'delete-failed',
        path,
        cause,
      );
    }
    if (!present) {
      throw new AiProseDraftPersistenceError(
        `Draft file does not exist: ${path}`,
        'missing',
        path,
      );
    }
    try {
      await this.fileAccess.removeFile(path);
    } catch (cause) {
      throw new AiProseDraftPersistenceError(
        `Unable to delete draft file: ${path}`,
        'delete-failed',
        path,
        cause,
      );
    }
  }

  private async write(project: AiProseDraftProjectInput, draft: DraftSession): Promise<string> {
    const path = await this.resolvePath(project, draft.sceneId, draft.sessionId);
    if (!this.fileAccess.replaceFile && !this.fileAccess.rename) {
      throw new AiProseDraftPersistenceError(
        'Atomic draft replacement is unavailable; the formal draft file was not modified',
        'atomic-write-unavailable',
        path,
      );
    }
    const directory = await (this.pathAccess.dirname
      ? this.pathAccess.dirname(path)
      : this.fileAccess.dirname(path));
    await this.fileAccess.ensureDir(directory);
    const temporaryPath = `${path}.tmp-${nextTemporaryFileId()}`;
    try {
      await this.fileAccess.writeFile(temporaryPath, JSON.stringify(draft, null, 2));
      // Keep the file access object as the receiver. ElectronFileAccess methods
      // use `this.api`, so extracting replaceFile/rename would lose their context.
      if (this.fileAccess.replaceFile) {
        await this.fileAccess.replaceFile(temporaryPath, path);
      } else {
        await this.fileAccess.rename!(temporaryPath, path);
      }
    } catch (cause) {
      throw new AiProseDraftPersistenceError(
        'Unable to atomically replace the AI prose draft file',
        'write-failed',
        path,
        cause,
      );
    }
    return path;
  }

  private failure(
    path: string,
    code: AiProseDraftPersistenceErrorCode,
    message: string,
    cause?: unknown,
  ): AiProseDraftLoadFailure {
    const error = new AiProseDraftPersistenceError(message, code, path, cause);
    return { status: code as AiProseDraftLoadFailure['status'], kind: code as AiProseDraftLoadFailure['kind'], path, error };
  }
}

export const AiProseDraftRepository = AiProseDraftPersistence;

function validateForSave(draft: DraftSession, expectedStatus: 'active' | 'applied'): DraftSession {
  if (draft.status !== expectedStatus) {
    if (draft.status === 'applied') {
      throw new AiProseDraftPersistenceError(
        'Applied draft sessions can only be saved through archiveApplied',
        'read-only',
      );
    }
    throw new AiProseDraftPersistenceError(
      `Expected a ${expectedStatus} draft session`,
      'invalid-structure',
    );
  }
  try {
    return migrateDraft(draft);
  } catch (cause) {
    if (cause instanceof AiProseDraftMigrationError) {
      throw new AiProseDraftPersistenceError(cause.message, cause.code, undefined, cause);
    }
    throw cause;
  }
}

function normalizeProject(project: AiProseDraftProjectInput): AiProseDraftProject {
  if ('projectRoot' in project) return project;
  return {
    projectRoot: project.rootPath,
    assetRoots: project.metadata.assetRoots,
  };
}

function normalizeAssetRoot(value: string): string {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.startsWith('/')
    || value.startsWith('\\')
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.includes('://')
    || value.replace(/\\/g, '/').trim().startsWith('@mount/')
    || value.replace(/\\/g, '/').trim().startsWith('.aeonstagery/mounts/')
  ) {
    throw new AiProseDraftPersistenceError(
      'assetRoots.project must be a project-relative path',
      'invalid-path',
    );
  }
  const normalized = value.replace(/\\/g, '/').trim();
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new AiProseDraftPersistenceError(
      'assetRoots.project must not contain traversal segments',
      'invalid-path',
    );
  }
  return segments.join('/');
}

function readSchemaVersion(input: unknown): number | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>).schemaVersion;
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

let temporaryFileSequence = 0;

function nextTemporaryFileId(): string {
  temporaryFileSequence += 1;
  return `${Date.now().toString(36)}-${temporaryFileSequence.toString(36)}`;
}
