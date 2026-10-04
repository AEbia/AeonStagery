import { promises as fs } from 'node:fs';
import path from 'node:path';

export class CollaborationAssetStore {
  readonly rootDir: string;
  private readonly assetRevisions = new Map<string, number>();

  constructor(dataDir: string) {
    this.rootDir = path.join(path.resolve(dataDir), 'assets');
  }

  async ensure(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  resolveAssetPath(projectRelativePath: string): string {
    const normalized = this.normalizeAssetPath(projectRelativePath);

    const target = path.resolve(this.rootDir, normalized);
    const relative = path.relative(this.rootDir, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Asset path escapes asset store: ${projectRelativePath}`);
    }
    return target;
  }

  async hasAsset(projectRelativePath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(this.resolveAssetPath(projectRelativePath));
      return stat.isFile();
    } catch {
      return false;
    }
  }

  async writeAsset(projectRelativePath: string, data: Uint8Array): Promise<string> {
    const normalizedPath = this.normalizeAssetPath(projectRelativePath);
    const target = this.resolveAssetPath(normalizedPath);
    this.bumpAssetRevision(normalizedPath);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, data);
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
    return fs.readFile(this.resolveAssetPath(projectRelativePath));
  }

  private normalizeAssetPath(projectRelativePath: string): string {
    const input = projectRelativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!input || input.split('/').includes('..')) {
      throw new Error(`Invalid project-relative asset path: ${projectRelativePath}`);
    }

    const normalized = path.posix.normalize(input);
    if (!normalized || normalized === '.' || normalized.startsWith('../')) {
      throw new Error(`Invalid project-relative asset path: ${projectRelativePath}`);
    }
    return normalized;
  }

  private bumpAssetRevision(projectRelativePath: string): void {
    const key = projectRelativePath.toLowerCase();
    this.assetRevisions.set(key, (this.assetRevisions.get(key) ?? 0) + 1);
  }
}
