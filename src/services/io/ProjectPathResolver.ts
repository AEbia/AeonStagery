import type { AeonStageryElectronAPI } from '../../api/types/window';

export class ProjectPathResolver {
  constructor(private api?: AeonStageryElectronAPI | null) {}

  isUrlLike(input: string): boolean {
    return /^(https?:|asset:|file:)/i.test(input) || input.startsWith('//');
  }

  isAbsolutePath(input: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(input) || input.startsWith('\\\\') || input.startsWith('/');
  }

  normalizeRelativePath(input: string): string {
    if (!input) throw new Error('Path cannot be empty');
    if (this.isUrlLike(input) || this.isAbsolutePath(input)) {
      throw new Error(`Expected project-relative path, got "${input}"`);
    }

    const normalized = input.replace(/\\/g, '/').trim();
    const segments = normalized.split('/').filter(Boolean);
    const out: string[] = [];

    for (const segment of segments) {
      if (segment === '.') continue;
      if (segment === '..') {
        if (out.length === 0) {
          throw new Error(`Path escapes project root: "${input}"`);
        }
        out.pop();
        continue;
      }
      out.push(segment);
    }

    const result = out.join('/');
    if (!result) throw new Error(`Path resolves to project root: "${input}"`);
    return result;
  }

  async resolveAbsolute(projectRoot: string, relativePath: string): Promise<string> {
    const normalizedRelative = this.normalizeRelativePath(relativePath);
    if (this.api?.path?.join) {
      return this.api.path.join(projectRoot, normalizedRelative);
    }
    return `${projectRoot.replace(/\\/g, '/')}/${normalizedRelative}`.replace(/\/+/g, '/');
  }

  async relativeFromProject(projectRoot: string, absolutePath: string): Promise<string | null> {
    if (!this.isAbsolutePath(absolutePath)) {
      return this.normalizeRelativePath(absolutePath);
    }

    const normalizedRoot = projectRoot.replace(/\\/g, '/');
    const normalizedAbsolute = absolutePath.replace(/\\/g, '/');

    if (this.api?.path?.relative) {
      const relative = await this.api.path.relative(normalizedRoot, normalizedAbsolute);
      if (!relative) return null;
      if (this.isAbsolutePath(relative) || this.isUrlLike(relative) || relative.startsWith('..')) {
        return null;
      }
      return this.normalizeRelativePath(relative);
    }

    const rootWithSlash = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
    if (!normalizedAbsolute.toLowerCase().startsWith(rootWithSlash.toLowerCase())) {
      return null;
    }

    const relative = normalizedAbsolute.slice(rootWithSlash.length).replace(/^\/+/, '');
    return relative ? this.normalizeRelativePath(relative) : null;
  }

  async classifySource(projectRoot: string, sourcePath: string): Promise<'insideProject' | 'outsideProject'> {
    const relative = await this.relativeFromProject(projectRoot, sourcePath);
    return relative ? 'insideProject' : 'outsideProject';
  }
}
