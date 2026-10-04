import type { IFileAccess } from '../io/IFileAccess';
import type { LoadedTemplatePackage, TemplateResourceConvention } from '../template-package/TemplatePackageManifest';
import { ResourceIndex } from './ResourceIndex';
import { listResourceFiles } from './ResourceFileScanner';
import type { ResourceCandidateSource, ResourceKind } from './ResourceAuthoringTypes';

export type TemplateConventionFileAccess = Pick<IFileAccess, 'readDir' | 'join'>;

export class TemplateResourceConventionScanner {
  private readonly cache = new Map<string, Promise<readonly string[]>>();

  constructor(private readonly fileAccess: TemplateConventionFileAccess) {}

  async addPackage(index: ResourceIndex, templatePackage: LoadedTemplatePackage): Promise<void> {
    const conventions = templatePackage.manifest.resourceConventions;
    if (!conventions) return;
    const assetRootName = templatePackage.manifest.assets?.root ?? 'assets';
    const assetRoot = await this.fileAccess.join(templatePackage.source.packageRoot, assetRootName);
    const cacheKey = `${templatePackage.source.packageRoot}\0${assetRootName}`;
    const files = await this.cachedFiles(cacheKey, assetRoot);
    const namespace = templatePackage.manifest.template.id;
    for (const [kind, convention] of Object.entries(conventions) as Array<[ResourceKind, TemplateResourceConvention]>) {
      for (const pattern of convention.patterns) {
        const matcher = compileConventionPattern(pattern, convention);
        for (const file of files) {
          const match = matcher.match(file);
          if (!match) continue;
          const ownerId = match.character;
          const outfitId = match.outfit;
          const name = match.name ?? outfitId;
          if (!name) continue;
          index.add({
            key: { kind, name, ...(ownerId ? { ownerId } : {}), ...(outfitId ? { outfitId } : {}) },
            namespace,
            portablePath: file,
            source: candidateSource(ownerId, outfitId),
          });
        }
      }
    }
  }

  clearCache(packageRoot?: string): void {
    if (!packageRoot) this.cache.clear();
    else for (const key of this.cache.keys()) if (key.startsWith(`${packageRoot}\0`)) this.cache.delete(key);
  }

  private cachedFiles(key: string, root: string): Promise<readonly string[]> {
    const cached = this.cache.get(key);
    if (cached) return cached;
    const pending = listResourceFiles(this.fileAccess, root);
    this.cache.set(key, pending);
    return pending;
  }
}

function candidateSource(ownerId?: string, outfitId?: string): ResourceCandidateSource {
  if (outfitId) return 'outfit';
  if (ownerId) return 'owner';
  return 'convention';
}

function compileConventionPattern(pattern: string, convention: TemplateResourceConvention): {
  match(path: string): Record<string, string> | null;
} {
  const tokens: string[] = [];
  let expression = '^';
  let cursor = 0;
  for (const match of pattern.matchAll(/\{([^}]+)\}/g)) {
    expression += escapeRegex(pattern.slice(cursor, match.index));
    const token = match[1];
    tokens.push(token);
    const choices = token === 'entrypoint' ? convention.entrypoints : token === 'extension' ? convention.extensions : undefined;
    expression += choices?.length
      ? `(${choices.map(escapeRegex).join('|')})`
      : '([^/]+)';
    cursor = (match.index ?? 0) + match[0].length;
  }
  expression += `${escapeRegex(pattern.slice(cursor))}$`;
  const regex = new RegExp(expression);
  return {
    match(path) {
      const result = regex.exec(path);
      if (!result) return null;
      return Object.fromEntries(tokens.map((token, index) => [token, result[index + 1]]));
    },
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
