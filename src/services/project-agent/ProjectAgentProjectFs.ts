import type { IFileAccess } from '../io/IFileAccess';

/**
 * Minimal no-follow filesystem seam used by the bounded project read ports.
 * Implementations must never follow symlinks for directory traversal and must
 * report symbolic links explicitly so callers can apply containment checks.
 */
export interface ProjectAgentFsDirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

export interface ProjectAgentFsStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

export interface ProjectAgentProjectFs {
  readDir(dir: string): Promise<readonly ProjectAgentFsDirEntry[]>;
  stat(path: string): Promise<ProjectAgentFsStat | null>;
  readTextFile(path: string): Promise<string>;
  /** Reads at most maxBytes from the head of a file; null when unreadable. */
  readHead(path: string, maxBytes: number): Promise<Uint8Array | null>;
  realpath(path: string): Promise<string>;
  join(...parts: string[]): Promise<string>;
}

/**
 * Thrown by the IFileAccess adapter when the host does not provide the
 * stat/realpath capabilities the containment and size checks depend on.
 * Ports treat this as "read unavailable", never as a pass-through read.
 */
export class ProjectAgentFsCapabilityError extends Error {
  constructor(readonly capability: 'stat' | 'realpath') {
    super(`IFileAccess host does not provide ${capability}`);
    this.name = 'ProjectAgentFsCapabilityError';
  }
}

/**
 * Production adapter over the editor IFileAccess seam. Symlink detection and
 * canonical containment require the optional stat/realpath methods; when they
 * are absent the adapter fails closed by throwing ProjectAgentFsCapabilityError
 * so the ports surface the read as unavailable instead of bypassing the checks.
 */
export class ProjectAgentIFileAccessFs implements ProjectAgentProjectFs {
  constructor(private readonly fileAccess: IFileAccess) {}

  async readDir(dir: string): Promise<readonly ProjectAgentFsDirEntry[]> {
    const entries = await this.fileAccess.readDir(dir);
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory,
      // IFileAccess.readDir predates symlink reporting; absence means the
      // backend cannot tell, so the caller must not rely on exclusion alone.
      isSymbolicLink: 'isSymbolicLink' in entry ? Boolean((entry as { isSymbolicLink?: boolean }).isSymbolicLink) : false,
    }));
  }

  async stat(path: string): Promise<ProjectAgentFsStat | null> {
    if (!this.fileAccess.stat) throw new ProjectAgentFsCapabilityError('stat');
    return this.fileAccess.stat(path);
  }

  async readTextFile(path: string): Promise<string> {
    const content = await this.fileAccess.readFile(path);
    return content.data;
  }

  async readHead(path: string, maxBytes: number): Promise<Uint8Array | null> {
    if (!this.fileAccess.readBinaryFile) return null;
    const result = await this.fileAccess.readBinaryFile(path);
    const bytes = new Uint8Array(result.data.slice(0, maxBytes));
    return bytes;
  }

  async realpath(path: string): Promise<string> {
    if (!this.fileAccess.realpath) throw new ProjectAgentFsCapabilityError('realpath');
    return this.fileAccess.realpath(path);
  }

  async join(...parts: string[]): Promise<string> {
    return this.fileAccess.join(...parts);
  }
}
