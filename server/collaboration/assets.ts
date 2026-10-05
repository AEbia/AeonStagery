import { promises as fs, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CollaborationRequestError } from './security';
import path from 'node:path';

export class CollaborationAssetStore {
  readonly rootDir: string;
  private readonly assetRevisions = new Map<string, number>();

  constructor(dataDir: string) {
    this.rootDir = path.join(path.resolve(dataDir), 'assets');
  }

  async ensure(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    await this.assertDirectory(this.rootDir);
  }

  resolveAssetPath(projectRelativePath: string): string {
    const normalized = this.normalizeAssetPath(projectRelativePath);

    const target = path.resolve(this.rootDir, normalized);
    const relative = path.relative(this.rootDir, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new CollaborationRequestError(400, 'Asset path escapes asset store');
    }
    return target;
  }

  async hasAsset(projectRelativePath: string): Promise<boolean> {
    try {
      const handle = await this.openAsset(projectRelativePath);
      await handle.close();
      return true;
    } catch {
      return false;
    }
  }

  async writeAsset(projectRelativePath: string, data: Uint8Array): Promise<string> {
    const normalizedPath = this.normalizeAssetPath(projectRelativePath);
    const target = this.resolveAssetPath(normalizedPath);
    this.bumpAssetRevision(normalizedPath);
    try {
      await this.ensure();
      await this.prepareDirectories(target, true);
      // Replace atomically: an existing symlink or hardlink cannot redirect writes.
      const temporary = path.join(path.dirname(target), `.upload-${randomUUID()}`);
      try {
        const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(data); }
        finally { await handle.close(); }
        await fs.rename(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    } finally {
      this.bumpAssetRevision(normalizedPath);
    }
    return target;
  }

  getAssetRevision(projectRelativePath: string): number {
    const normalizedPath = this.normalizeAssetPath(projectRelativePath);
    return this.assetRevisions.get(normalizedPath.toLowerCase()) ?? 0;
  }

  async readAsset(projectRelativePath: string): Promise<Buffer> {
    const handle = await this.openAsset(projectRelativePath);
    try { return await handle.readFile(); }
    finally { await handle.close(); }
  }

  private async assertDirectory(directory: string): Promise<void> {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new CollaborationRequestError(400, 'Asset directory must not be a symbolic link');
    }
  }

  private async prepareDirectories(target: string, create: boolean): Promise<void> {
    await this.assertDirectory(this.rootDir);
    const parts = path.relative(this.rootDir, path.dirname(target)).split(path.sep).filter(Boolean);
    let directory = this.rootDir;
    for (const part of parts) {
      directory = path.join(directory, part);
      if (create) {
        try { await fs.mkdir(directory); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      await this.assertDirectory(directory);
    }
  }

  private async openAsset(projectRelativePath: string): Promise<fs.FileHandle> {
    const target = this.resolveAssetPath(projectRelativePath);
    await this.prepareDirectories(target, false);
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
      throw new CollaborationRequestError(400, 'Asset must be a regular file');
    }
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.nlink > 1) {
      await handle.close();
      throw new CollaborationRequestError(400, 'Asset must be a regular file');
    }
    return handle;
  }

  private normalizeAssetPath(projectRelativePath: string): string {
    const input = projectRelativePath.replace(/\\/g, '/');
    if (!input || input.length > 4096 || input.startsWith('/') || /[\u0000-\u001f\u007f:]/.test(input)
      || input.split('/').some((part) => part === '..' || /[. ]$/.test(part)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new CollaborationRequestError(400, 'Invalid project-relative asset path');
    }

    const normalized = path.posix.normalize(input);
    if (!normalized || normalized === '.' || normalized.startsWith('../')) {
      throw new CollaborationRequestError(400, 'Invalid project-relative asset path');
    }
    return normalized;
  }

  private bumpAssetRevision(projectRelativePath: string): void {
    const key = projectRelativePath.toLowerCase();
    this.assetRevisions.set(key, (this.assetRevisions.get(key) ?? 0) + 1);
  }
}
