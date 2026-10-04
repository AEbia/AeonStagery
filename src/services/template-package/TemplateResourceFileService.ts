import type { ProjectState, ResourceImportKind, ResourceKind } from '../../api/types/project';
import type { IFileAccess } from '../io/IFileAccess';
import { ProjectPathResolver } from '../io/ProjectPathResolver';
import type { SceneAssetHooks } from '../io/SceneAssetService';
import { createScannedTemplateResourceIndex } from '../resource-authoring/TemplateResourceIndex';
import { TemplateResourceConventionScanner } from '../resource-authoring/TemplateResourceConventionScanner';
import { TemplateAssetResolver } from './TemplateAssetResolver';
import type { ITemplatePackageCatalog } from './TemplatePackageCatalog';
import { createTemplatePackageView } from './TemplatePackageLoader';
import type { LoadedTemplatePackage } from './TemplatePackageManifest';

export interface TemplateResourceFileReference {
  templateId: string;
  packageRelativePath: string;
}

export interface TemplateResourceFileEntry {
  name: string;
  isDirectory: boolean;
  path: string;
  source: string;
  templateResource?: TemplateResourceFileReference;
}

interface ResourceFile extends TemplateResourceFileEntry {
  browsePath: string;
  kind: ResourceImportKind;
  packageRoot: string;
  templateResource: TemplateResourceFileReference;
}

const DIRECTORIES: Partial<Record<ResourceKind, string>> = {
  live2dModel: 'figure', background: 'background', bgm: 'bgm', voice: 'vocal',
  sfx: 'sfx', animation: 'animation', image: 'images', icon: 'images',
  font: 'images', lut: 'images', mask: 'images',
};

type ProjectSource = {
  getCurrentProject(): ProjectState | null;
  subscribe(listener: () => void): () => void;
};

/** Projects enabled template entrypoints into the standard file-browser directories. */
export class TemplateResourceFileService {
  private readonly resolver = new ProjectPathResolver();
  private readonly assetResolver: TemplateAssetResolver;
  private readonly scanner: TemplateResourceConventionScanner;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribers: Array<() => void>;
  private revision = 0;
  private cache?: { signature: string; files: Promise<ResourceFile[]> };

  constructor(
    private readonly fileAccess: Pick<IFileAccess, 'readDir' | 'join' | 'exists'>,
    private readonly catalog: ITemplatePackageCatalog,
    private readonly projects: ProjectSource,
    private readonly sceneAssets: Pick<SceneAssetHooks, 'importTemplateAssetPath'>,
  ) {
    this.assetResolver = new TemplateAssetResolver(fileAccess);
    this.scanner = new TemplateResourceConventionScanner(fileAccess);
    this.unsubscribers = [catalog.subscribe(() => this.invalidate()), projects.subscribe(() => this.invalidate())];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  invalidate(): void {
    this.revision += 1;
    this.cache = undefined;
    this.scanner.clearCache();
    this.listeners.forEach((listener) => listener());
  }

  dispose(): void {
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.listeners.clear();
    this.cache = undefined;
    this.scanner.clearCache();
  }

  async readDirectory(subDir: string): Promise<TemplateResourceFileEntry[]> {
    const directory = this.resolver.normalizeRelativePath(subDir);
    const files = await this.getFiles();
    const entries = new Map<string, TemplateResourceFileEntry>();
    for (const file of files) {
      if (!file.browsePath.startsWith(`${directory}/`)) continue;
      const remainder = file.browsePath.slice(directory.length + 1);
      const parts = remainder.split('/');
      if (parts.length === 1) {
        entries.set(file.path, {
          name: file.name, isDirectory: false, path: file.path,
          source: file.source, templateResource: file.templateResource,
        });
      } else {
        const path = `${file.path.slice(0, -remainder.length)}${parts[0]}`;
        entries.set(path, { name: parts[0], isDirectory: true, path, source: file.source });
      }
    }
    return [...entries.values()];
  }

  async importFile(reference: TemplateResourceFileReference, sourcePath: string, kind: ResourceImportKind): Promise<string> {
    const project = this.projects.getCurrentProject();
    const revision = this.revision;
    const normalizedPath = this.resolver.normalizeRelativePath(reference.packageRelativePath);
    const files = await this.getFiles();
    const file = files.find((item) => item.templateResource.templateId === reference.templateId
      && item.templateResource.packageRelativePath === normalizedPath
      && item.path === sourcePath.replace(/\\/g, '/') && item.kind === kind);
    if (!project || revision !== this.revision || this.projects.getCurrentProject() !== project || !file) {
      throw new Error('模板资源已不可用，请刷新资源列表后重试。');
    }
    if (!(await this.fileAccess.exists(file.path))) {
      throw new Error('模板资源文件不存在，请检查模板包后重试。');
    }
    if (revision !== this.revision || this.projects.getCurrentProject() !== project || !this.getEnabledPackages().some((pkg) => (
      pkg.manifest.template.id === reference.templateId && pkg.source.packageRoot === file.packageRoot
    ))) throw new Error('项目或模板配置已变化，请刷新资源列表后重试。');
    const imported = await this.sceneAssets.importTemplateAssetPath(file.path, file.packageRoot, kind);
    if (!imported?.trim()) throw new Error('资源服务未返回可用路径。');
    if (this.projects.getCurrentProject() !== project) throw new Error('项目已切换，资源未提交。');
    this.invalidate();
    return imported;
  }

  private getEnabledPackages(): LoadedTemplatePackage[] {
    const project = this.projects.getCurrentProject();
    if (!project) return [];
    const view = createTemplatePackageView([...this.catalog.getPackages()], {
      enabledTemplateIds: project.metadata.templates?.enabledTemplateIds ?? [],
    });
    const seen = new Set<string>();
    return view.packages.filter((pkg) => {
      if (seen.has(pkg.manifest.template.id)) return false;
      seen.add(pkg.manifest.template.id);
      return true;
    });
  }

  private getFiles(): Promise<ResourceFile[]> {
    const project = this.projects.getCurrentProject();
    if (!project) return Promise.resolve([]);
    const signature = JSON.stringify([project.rootPath, project.metadata.templates?.enabledTemplateIds ?? [], this.catalog.getRevision()]);
    if (this.cache?.signature === signature) return this.cache.files;
    const files = this.collectFiles(this.getEnabledPackages()).catch((error) => {
      if (this.cache?.files === files) this.cache = undefined;
      throw error;
    });
    this.cache = { signature, files };
    return files;
  }

  private async collectFiles(packages: LoadedTemplatePackage[]): Promise<ResourceFile[]> {
    const view = createTemplatePackageView(packages);
    // Explicit asset and preset identities follow the catalog's merged precedence.
    const indexedPackages = packages.map((pkg) => ({ ...pkg, manifest: {
      ...pkg.manifest,
      assets: { ...pkg.manifest.assets, index: view.assetEntries.filter((entry) => entry.source.packageRoot === pkg.source.packageRoot) },
    } }));
    const index = await createScannedTemplateResourceIndex(indexedPackages, this.fileAccess, undefined, this.scanner);
    const files = new Map<string, ResourceFile>();
    const add = async (pkg: LoadedTemplatePackage, packagePath: string, portablePath: string, directory: string) => {
      const packageRelativePath = this.resolver.normalizeRelativePath(packagePath);
      const path = (await this.assetResolver.resolvePackageRelative(pkg, packageRelativePath)).replace(/\\/g, '/');
      if (files.has(path) || !(await this.fileAccess.exists(path))) return;
      const relative = this.resolver.normalizeRelativePath(portablePath);
      const browsePath = relative.startsWith(`${directory}/`) ? relative : `${directory}/${relative}`;
      files.set(path, {
        name: relative.split('/').at(-1)!, isDirectory: false, path, browsePath,
        source: `模板：${pkg.manifest.template.name}`, packageRoot: pkg.source.packageRoot,
        kind: directory === 'sfx' ? 'generic' : directory as ResourceImportKind,
        templateResource: { templateId: pkg.manifest.template.id, packageRelativePath },
      });
    };
    for (const candidate of index.entries()) {
      const directory = DIRECTORIES[candidate.key.kind];
      const pkg = packages.find((item) => item.manifest.template.id === candidate.namespace);
      if (!directory || !pkg) continue;
      await add(pkg, `${pkg.manifest.assets?.root ?? 'assets'}/${candidate.portablePath}`, candidate.portablePath, directory);
    }
    for (const preset of view.characterPresets) {
      const pkg = packages.find((item) => item.source.packageRoot === preset.source.packageRoot);
      if (!pkg) continue;
      for (const model of [preset.model, ...(preset.variants ?? []).map((variant) => variant.model)]) {
        if (!model || this.resolver.isAbsolutePath(model) || this.resolver.isUrlLike(model)) continue;
        const assetRoot = (pkg.manifest.assets?.root ?? 'assets').replace(/\\/g, '/').replace(/\/$/, '');
        const portable = model.replace(/\\/g, '/');
        await add(pkg, portable, portable.startsWith(`${assetRoot}/`) ? portable.slice(assetRoot.length + 1) : portable, 'figure');
      }
    }
    return [...files.values()];
  }
}
