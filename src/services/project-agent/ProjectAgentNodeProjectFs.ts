import * as fs from 'fs';
import * as path from 'path';
import type {
  ProjectAgentFsDirEntry,
  ProjectAgentFsStat,
  ProjectAgentProjectFs,
} from './ProjectAgentProjectFs';

/**
 * Node-fs-backed implementation of the project workspace seam. Used by the
 * bounded project read sandbox tests and non-Electron hosts; the Electron
 * renderer uses ProjectAgentIFileAccessFs over the preload IPC instead.
 */
export class ProjectAgentNodeProjectFs implements ProjectAgentProjectFs {
  async readDir(dir: string): Promise<readonly ProjectAgentFsDirEntry[]> {
    return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));
  }

  async stat(entryPath: string): Promise<ProjectAgentFsStat | null> {
    try {
      const stat = fs.lstatSync(entryPath);
      return {
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        isSymbolicLink: stat.isSymbolicLink(),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    } catch {
      return null;
    }
  }

  async readTextFile(filePath: string): Promise<string> {
    return fs.readFileSync(filePath, 'utf-8');
  }

  async readHead(filePath: string, maxBytes: number): Promise<Uint8Array | null> {
    try {
      const fd = fs.openSync(filePath, 'r');
      try {
        const buffer = Buffer.allocUnsafe(maxBytes);
        const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
        return new Uint8Array(buffer.subarray(0, bytesRead));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  async realpath(entryPath: string): Promise<string> {
    return fs.realpathSync(entryPath);
  }

  async join(...parts: string[]): Promise<string> {
    return path.join(...parts);
  }
}
