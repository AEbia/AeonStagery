import type {
  AgentProjectFileEntry,
  AgentProjectTextHit,
} from '../../api/types/project-agent';
import type { ExternalLibraryMount } from '../../api/types/project';
import {
  isCanonicalPathWithinRoot,
  isForbiddenProjectPath,
  stableSortBy,
} from './ProjectAgentPathRules';
import type {
  ProjectAgentFileListPort,
  ProjectAgentTextReadPort,
  ProjectAgentTextSearchPort,
} from './ProjectAgentPorts';
import type { ProjectAgentProjectFs } from './ProjectAgentProjectFs';

/**
 * Typed port error carrying only a safe code. The tool layer maps these to
 * AgentToolResult failures with generic messages: no stack traces, absolute
 * paths or rejected-file contents ever reach the model.
 */
export class ProjectAgentPortError extends Error {
  constructor(
    readonly code: 'forbidden_path' | 'not_found' | 'result_too_large',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectAgentPortError';
  }
}

/** Files larger than this are never read whole for line views or search. */
export const MAX_PORT_READ_FILE_BYTES = 16 * 1024 * 1024;
/** Head bytes examined for NUL/UTF-8 binary sniffing. */
const BINARY_SNIFF_BYTES = 8192;
/** Hard scan cap so pathological trees cannot explode the agent context. */
const MAX_SEARCH_HITS = 5000;

const MIME_BY_EXT: Record<string, string> = {
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.csv': 'text/csv',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tga': 'image/tga',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

export interface ProjectAgentProjectReadPortsOptions {
  readonly fs: ProjectAgentProjectFs;
  readonly getProjectRoot: () => string | null;
  /** Stable external mounts available for explicit @mount text reads. */
  readonly getExternalMounts?: () => readonly ExternalLibraryMount[];
}

export interface ProjectAgentProjectReadPorts {
  readonly files: ProjectAgentFileListPort;
  readonly text: ProjectAgentTextReadPort;
  readonly textSearch: ProjectAgentTextSearchPort;
}

/**
 * ADR0023 production ports for the four bounded project read tools. Every
 * operation resolves through canonical root containment, never follows
 * symlinks out of the workspace, strips forbidden categories (project.json,
 * formal scenes, AI prose drafts, journals, VCS, environment/credentials),
 * and returns binary files as metadata only.
 */
export function createProjectAgentProjectReadPorts(
  options: ProjectAgentProjectReadPortsOptions,
): ProjectAgentProjectReadPorts {
  const ports = new ProjectAgentProjectReadPortsImpl(options);
  return {
    files: { listFiles: (listOptions) => ports.listFiles(listOptions) },
    text: {
      readText: (path) => ports.readText(path),
      exists: (path) => ports.exists(path),
    },
    textSearch: { searchText: (searchOptions) => ports.searchText(searchOptions) },
  };
}

class ProjectAgentProjectReadPortsImpl {
  private readonly fs: ProjectAgentProjectFs;
  private readonly getProjectRoot: () => string | null;
  private readonly getExternalMounts: () => readonly ExternalLibraryMount[];

  constructor(options: ProjectAgentProjectReadPortsOptions) {
    this.fs = options.fs;
    this.getProjectRoot = options.getProjectRoot;
    this.getExternalMounts = options.getExternalMounts ?? (() => []);
  }

  async listFiles(options: { prefix?: string }): Promise<{
    entries: readonly AgentProjectFileEntry[];
    revision: string;
    excludedCount: number;
  }> {
    const containment = await this.resolveRootContainment();
    if (!containment) return { entries: [], revision: emptyRevision(), excludedCount: 0 };
    const prefix = (options.prefix ?? '').replace(/\/+$/, '');
    const prefixAbs = await this.fs.join(containment.root, prefix);
    const canonicalPrefix = await this.canonicalizeContained(prefixAbs, containment.canonicalRoot);
    if (!canonicalPrefix) return { entries: [], revision: emptyRevision(), excludedCount: 0 };

    const entries: AgentProjectFileEntry[] = [];
    const revisionParts: string[] = [];
    // Protected entries are skipped silently by policy; count them so the
    // tool layer can expose total/excludedCount transparently.
    let excludedCount = 0;
    await this.walk(prefixAbs, prefix, containment.canonicalRoot, async (relative, absolute) => {
      if (isForbiddenProjectPath(relative)) {
        excludedCount += 1;
        return;
      }
      const stat = await this.fs.stat(absolute);
      if (stat && !stat.isFile) return;
      let binary: boolean | undefined;
      let mimeType: string | undefined;
      let sizeBytes: number | undefined;
      if (stat) {
        sizeBytes = stat.sizeBytes;
        mimeType = mimeTypeFor(relative);
        if (sizeBytes > 0) {
          const head = await this.fs.readHead(absolute, BINARY_SNIFF_BYTES);
          binary = head === null ? false : sniffBinary(head);
        } else {
          binary = false;
        }
        revisionParts.push(`${relative}:${stat.sizeBytes}:${stat.mtimeMs.toFixed(3)}`);
      } else {
        revisionParts.push(`${relative}:0:0`);
      }
      entries.push({
        path: relative,
        kind: 'file',
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        ...(mimeType !== undefined ? { mimeType } : {}),
        ...(binary !== undefined ? { binary } : {}),
      });
    }, () => {
      excludedCount += 1;
    });
    return {
      entries: stableSortBy(entries, (entry) => entry.path),
      // Hash over stable order: readdir order is filesystem-dependent and an
      // unchanged tree must never spuriously surface pagination_changed.
      revision: hashRevision(stableSortBy(revisionParts, (part) => part)),
      excludedCount,
    };
  }

  /**
   * Stat-only existence probe (no content read): whether the path names an
   * existing regular file inside the workspace (or registered mount). Lets
   * the tool layer report not_found for missing files even when the path is
   * policy-forbidden (e.g. a nonexistent scene path).
   */
  async exists(path: string): Promise<boolean> {
    let containment: { root: string; canonicalRoot: string; relativePath: string } | null;
    try {
      containment = await this.resolveTextContainment(path);
    } catch {
      return false;
    }
    if (!containment) return false;
    try {
      const targetAbs = await this.fs.join(containment.root, containment.relativePath);
      const stat = await this.fs.stat(targetAbs);
      return stat !== null && stat.isFile;
    } catch {
      return false;
    }
  }

  async readText(path: string): Promise<{
    lines: readonly string[];
    binary: boolean;
    mimeType?: string;
    sizeBytes?: number;
    tooLarge?: true;
  }> {
    const containment = await this.resolveTextContainment(path);
    if (!containment) throw new ProjectAgentPortError('not_found', 'No active project workspace');
    const targetAbs = await this.fs.join(containment.root, containment.relativePath);
    let canonical: string;    try {
      canonical = await this.fs.realpath(targetAbs);
    } catch {
      throw new ProjectAgentPortError('not_found', 'Project file does not exist inside the workspace');
    }
    if (!isCanonicalPathWithinRoot(canonical, containment.canonicalRoot)) {
      throw new ProjectAgentPortError('forbidden_path', 'Path resolves outside the project workspace');
    }
    const stat = await this.fs.stat(targetAbs);
    if (stat && !stat.isFile) {
      throw new ProjectAgentPortError('not_found', 'Project path does not name a file');
    }
    const mimeType = mimeTypeFor(path);
    const sizeBytes = stat?.sizeBytes;
    if (sizeBytes !== undefined && sizeBytes > MAX_PORT_READ_FILE_BYTES) {
      return { lines: [], binary: false, mimeType, sizeBytes, tooLarge: true };
    }
    if (sizeBytes !== undefined && sizeBytes > 0) {
      const head = await this.fs.readHead(targetAbs, BINARY_SNIFF_BYTES);
      if (head !== null && sniffBinary(head)) {
        return { lines: [], binary: true, mimeType, sizeBytes };
      }
    }
    let bytes: Uint8Array | null;
    try {
      // Size-capped full read: the stat check above guarantees the file fits
      // in MAX_PORT_READ_FILE_BYTES, so this captures the whole content.
      bytes = await this.fs.readHead(targetAbs, MAX_PORT_READ_FILE_BYTES);
    } catch {
      bytes = null;
    }
    if (bytes === null) {
      throw new ProjectAgentPortError('not_found', 'Project file could not be read');
    }
    let text: string;
    try {
      // Fatal decode over the FULL content: readFileSync('utf-8') would have
      // silently replaced invalid bytes with U+FFFD, so decode from raw bytes
      // and reject as binary metadata-only when invalid UTF-8 appears anywhere.
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { lines: [], binary: true, mimeType, sizeBytes };
    }
    const lines = text.length === 0 ? [] : text.split(/\r?\n/u);
    return { lines, binary: false, mimeType, sizeBytes };
  }

  async searchText(options: { query: string; prefix?: string }): Promise<{
    hits: readonly AgentProjectTextHit[];
    revision: string;
  }> {
    const containment = await this.resolveRootContainment();
    if (!containment) return { hits: [], revision: emptyRevision() };
    const prefix = (options.prefix ?? '').replace(/\/+$/, '');
    const prefixAbs = await this.fs.join(containment.root, prefix);
    if (!(await this.canonicalizeContained(prefixAbs, containment.canonicalRoot))) {
      return { hits: [], revision: emptyRevision() };
    }
    const needle = options.query.toLowerCase();
    const hits: AgentProjectTextHit[] = [];
    const revisionParts: string[] = [];
    await this.walk(prefixAbs, prefix, containment.canonicalRoot, async (relative, absolute) => {
      if (isForbiddenProjectPath(relative)) return;
      const stat = await this.fs.stat(absolute);
      if (stat && !stat.isFile) return;
      const sizeBytes = stat?.sizeBytes;
      if (sizeBytes !== undefined && sizeBytes > MAX_PORT_READ_FILE_BYTES) return;
      const head = await this.fs.readHead(absolute, BINARY_SNIFF_BYTES);
      if (head !== null && sniffBinary(head)) return;
      let text: string;
      try {
        const bytes = await this.fs.readHead(absolute, MAX_PORT_READ_FILE_BYTES);
        if (bytes === null) return;
        // Fatal decode of the full content: files with invalid UTF-8 anywhere
        // are skipped instead of searched with U+FFFD-replaced bytes.
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return;
      }
      const lines = text.split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        const lineText = lines[index]!;
        if (lineText.toLowerCase().includes(needle)) {
          hits.push({ path: relative, line: index + 1, text: lineText });
          revisionParts.push(`${relative}:${index + 1}:${lineText}`);
          if (hits.length > MAX_SEARCH_HITS) {
            throw new ProjectAgentPortError('result_too_large', 'Search hit cap exceeded');
          }
        }
      }
      if (stat) revisionParts.push(`file:${relative}:${stat.sizeBytes}:${stat.mtimeMs.toFixed(3)}`);
    });
    return {
      hits: stableSortBy(hits, (hit) => `${hit.path}:${String(hit.line).padStart(8, '0')}`),
      revision: hashRevision(revisionParts),
    };
  }

  private async resolveRootContainment(): Promise<{ root: string; canonicalRoot: string } | null> {
    const root = this.getProjectRoot();
    if (!root) return null;
    try {
      return { root, canonicalRoot: await this.fs.realpath(root) };
    } catch {
      return null;
    }
  }

  /**
   * readProjectText accepts a stable mounted reference only when it names a
   * currently registered library. The tool layer has already normalized the
   * reference; this second check keeps the filesystem seam fail-closed.
   */
  private async resolveTextContainment(path: string): Promise<{
    root: string;
    canonicalRoot: string;
    relativePath: string;
  } | null> {
    let root: string | null;
    let relativePath: string;
    if (path.startsWith('@mount/')) {
      const mounted = parseMountedReference(path);
      if (!mounted) {
        throw new ProjectAgentPortError('forbidden_path', 'Invalid mounted resource reference');
      }
      root = this.getExternalMounts().find((mount) => mount.id === mounted.mountId)?.path ?? null;
      relativePath = mounted.relativePath;
    } else {
      root = this.getProjectRoot();
      relativePath = path;
    }
    if (!root) return null;
    try {
      return {
        root,
        canonicalRoot: await this.fs.realpath(root),
        relativePath,
      };
    } catch {
      return null;
    }
  }

  private async canonicalizeContained(
    absPath: string,
    canonicalRoot: string,
  ): Promise<string | null> {
    try {
      const canonical = await this.fs.realpath(absPath);
      return isCanonicalPathWithinRoot(canonical, canonicalRoot) ? canonical : null;
    } catch {
      return null;
    }
  }

  /**
   * Recursive walk with no-follow semantics: symbolic links are never
   * descended into and never reported as readable files. `onForbiddenDir` is
   * invoked once per policy-forbidden directory that is skipped whole.
   */
  private async walk(
    dirAbs: string,
    relativeDir: string,
    canonicalRoot: string,
    onFile: (relative: string, absolute: string) => Promise<void>,
    onForbiddenDir?: (relative: string) => void,
  ): Promise<void> {
    let entries: readonly { name: string; isDirectory: boolean; isSymbolicLink: boolean }[];
    try {
      entries = await this.fs.readDir(dirAbs);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink) continue;
      const relative = relativeDir.length > 0 ? `${relativeDir}/${entry.name}` : entry.name;
      const absolute = await this.fs.join(dirAbs, entry.name);
      if (entry.isDirectory) {
        if (isForbiddenProjectPath(relative)) {
          onForbiddenDir?.(relative);
          continue;
        }
        const canonical = await this.canonicalizeContained(absolute, canonicalRoot);
        if (!canonical) continue;
        await this.walk(absolute, relative, canonicalRoot, onFile, onForbiddenDir);
      } else {
        await onFile(relative, absolute);
      }
    }
  }
}

function mimeTypeFor(path: string): string | undefined {
  const lower = path.toLowerCase();
  for (const ext of Object.keys(MIME_BY_EXT)) {
    if (lower.endsWith(ext)) return MIME_BY_EXT[ext];
  }
  return undefined;
}

function sniffBinary(head: Uint8Array): boolean {
  if (head.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head);
    return false;
  } catch {
    return true;
  }
}

function hashRevision(parts: readonly string[]): string {
  let hash = 2166136261;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      hash ^= part.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 10;
  }
  return (hash >>> 0).toString(16);
}

function emptyRevision(): string {
  return '0';
}

function parseMountedReference(reference: string): {
  mountId: string;
  relativePath: string;
} | null {
  const rest = reference.slice('@mount/'.length);
  const separator = rest.indexOf('/');
  if (separator <= 0 || separator === rest.length - 1) return null;
  const mountId = rest.slice(0, separator);
  const relativePath = rest.slice(separator + 1);
  if (
    !mountId
    || relativePath.startsWith('/')
    || relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return null;
  }
  return { mountId, relativePath };
}
