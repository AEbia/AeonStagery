import type { IFileAccess } from './IFileAccess';

export interface LibraryEntry {
  name: string;
  isDirectory: boolean;
  path: string;
  source?: string;
}

const STANDARD_LIBRARY_DIRECTORIES = ['animation', 'background', 'bgm', 'figure', 'project', 'template', 'vocal'] as const;

export class LibraryCatalog {
  constructor(private fileAccess: IFileAccess) {}

  async readMergedDirectory(roots: string[], subDir: string): Promise<LibraryEntry[]> {
    if (roots.length === 0) return [];

    const allEntries: LibraryEntry[] = [];
    for (const root of roots) {
      const fullPath = await this.fileAccess.join(root, subDir);
      try {
        const entries = await this.fileAccess.readDir(fullPath);
        const label = this.getLibraryLabel(root);
        for (const entry of entries) {
          allEntries.push({
            name: entry.name,
            isDirectory: entry.isDirectory,
            path: entry.path.replace(/\\/g, '/'),
            source: roots.length > 1 ? label : undefined,
          });
        }
      } catch {
        // Ignore missing directories in a root.
      }
    }

    allEntries.sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

    return allEntries;
  }

  async readRootDirectories(roots: string[]): Promise<LibraryEntry[]> {
    if (roots.length === 0) return [];

    const entries: LibraryEntry[] = [];
    const seen = new Set<string>();
    for (const dir of STANDARD_LIBRARY_DIRECTORIES) {
      for (const root of roots) {
        const fullPath = await this.fileAccess.join(root, dir);
        try {
          const exists = await this.fileAccess.exists(fullPath);
          if (exists && !seen.has(dir)) {
            seen.add(dir);
            entries.push({ name: dir, isDirectory: true, path: fullPath.replace(/\\/g, '/') });
          }
        } catch {
          // Ignore missing roots.
        }
      }
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    return entries;
  }

  getStandardDirectories(): readonly string[] {
    return STANDARD_LIBRARY_DIRECTORIES;
  }

  private getLibraryLabel(rootPath: string): string {
    const parts = rootPath.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.slice(-2).join('/') || rootPath;
  }
}
