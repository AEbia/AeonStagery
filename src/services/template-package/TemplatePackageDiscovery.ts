import type { IFileAccess } from '../io/IFileAccess';
import type { LoadedTemplatePackage, TemplatePackageScope } from './TemplatePackageManifest';
import { TEMPLATE_PACKAGE_MANIFEST_FILE, TemplatePackageLoader } from './TemplatePackageLoader';

const LEGACY_TEMPLATE_MANIFEST_FILE = 'manifest.json';

export interface TemplatePackageDiscoveryOptions {
  libraryRoots: string[];
  projectRoot?: string | null;
}

export interface TemplatePackageDiscoveryResult {
  packages: LoadedTemplatePackage[];
  issues: TemplatePackageDiscoveryIssue[];
}

export interface TemplatePackageDiscoveryIssue {
  root: string;
  path: string;
  message: string;
}

export class TemplatePackageDiscovery {
  private loader: TemplatePackageLoader;

  constructor(private fileAccess: IFileAccess) {
    this.loader = new TemplatePackageLoader(fileAccess);
  }

  async discoverFromLibraryRoots(options: TemplatePackageDiscoveryOptions): Promise<TemplatePackageDiscoveryResult> {
    const packages: LoadedTemplatePackage[] = [];
    const issues: TemplatePackageDiscoveryIssue[] = [];
    const seenRoots = new Set<string>();

    for (const root of options.libraryRoots) {
      const normalizedRoot = normalizeRoot(root);
      if (!normalizedRoot || seenRoots.has(normalizedRoot.toLowerCase())) continue;
      seenRoots.add(normalizedRoot.toLowerCase());

      const scope = sameRoot(normalizedRoot, options.projectRoot) ? 'project' : 'user';
      for (const directoryName of ['template', 'templates']) {
        const templateRoot = await this.fileAccess.join(normalizedRoot, directoryName);
        const result = await this.discoverTemplateRoot(scope, normalizedRoot, templateRoot);
        packages.push(...result.packages);
        issues.push(...result.issues);
      }
    }

    const identities = new Map<string, string>();
    for (const templatePackage of packages) {
      const metadata = templatePackage.manifest.template;
      for (const id of [metadata.id, ...(metadata.aliases ?? [])]) {
        const previous = identities.get(id);
        if (previous && previous !== metadata.id) {
          issues.push({
            root: templatePackage.source.packageRoot,
            path: templatePackage.source.manifestPath ?? templatePackage.source.packageRoot,
            message: `Template identity "${id}" is claimed by both "${previous}" and "${metadata.id}" (alias collision).`,
          });
        } else identities.set(id, metadata.id);
      }
    }

    return { packages, issues };
  }

  private async discoverTemplateRoot(
    scope: TemplatePackageScope,
    root: string,
    templateRoot: string,
  ): Promise<TemplatePackageDiscoveryResult> {
    const packages: LoadedTemplatePackage[] = [];
    const issues: TemplatePackageDiscoveryIssue[] = [];

    try {
      const manifestPath = await this.fileAccess.join(templateRoot, TEMPLATE_PACKAGE_MANIFEST_FILE);
      if (await this.fileAccess.exists(manifestPath)) {
        packages.push(await this.loader.loadFromPackageRoot(scope, templateRoot));
      } else if (await this.fileAccess.exists(await this.fileAccess.join(templateRoot, LEGACY_TEMPLATE_MANIFEST_FILE))) {
        issues.push(createIssue(
          root,
          templateRoot,
          new Error(`Template package root requires ${TEMPLATE_PACKAGE_MANIFEST_FILE}; manifest.json is legacy-only`),
        ));
      }
    } catch (error) {
      issues.push(createIssue(root, templateRoot, error));
    }

    let entries: Awaited<ReturnType<IFileAccess['readDir']>>;
    try {
      entries = await this.fileAccess.readDir(templateRoot);
    } catch {
      return { packages, issues };
    }

    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      try {
        const manifestPath = await this.fileAccess.join(entry.path, TEMPLATE_PACKAGE_MANIFEST_FILE);
        if (!(await this.fileAccess.exists(manifestPath))) {
          if (await this.fileAccess.exists(await this.fileAccess.join(entry.path, LEGACY_TEMPLATE_MANIFEST_FILE))) {
            issues.push(createIssue(
              root,
              entry.path,
              new Error(`Template package requires ${TEMPLATE_PACKAGE_MANIFEST_FILE}; manifest.json is legacy-only`),
            ));
          }
          continue;
        }
        packages.push(await this.loader.loadFromManifestPath(scope, manifestPath));
      } catch (error) {
        issues.push(createIssue(root, entry.path, error));
      }
    }

    return { packages, issues };
  }
}

function createIssue(root: string, path: string, error: unknown): TemplatePackageDiscoveryIssue {
  return {
    root,
    path,
    message: error instanceof Error ? error.message : String(error),
  };
}

function normalizeRoot(root: string): string {
  return root.replace(/\\/g, '/').trim().replace(/\/+$/, '');
}

function sameRoot(left: string, right?: string | null): boolean {
  const normalizedRight = normalizeRoot(right ?? '');
  return !!normalizedRight && normalizeRoot(left).toLowerCase() === normalizedRight.toLowerCase();
}
