import { ProjectPathResolver } from '../io/ProjectPathResolver';
import type { LoadedTemplatePackage } from './TemplatePackageManifest';

type FileAccessLike = {
  join(...parts: string[]): Promise<string>;
};

export class TemplateAssetResolver {
  private pathResolver = new ProjectPathResolver();

  constructor(private fileAccess: FileAccessLike) {}

  async resolvePackageRelative(templatePackage: LoadedTemplatePackage, packageRelativePath: string): Promise<string> {
    const normalizedRelative = this.pathResolver.normalizeRelativePath(packageRelativePath);
    return this.fileAccess.join(templatePackage.source.packageRoot, normalizedRelative);
  }

  async resolveAsset(templatePackage: LoadedTemplatePackage, assetRelativePath: string): Promise<string> {
    const assetRoot = templatePackage.manifest.assets?.root ?? 'assets';
    return this.resolvePackageRelative(templatePackage, `${assetRoot}/${assetRelativePath}`);
  }
}
