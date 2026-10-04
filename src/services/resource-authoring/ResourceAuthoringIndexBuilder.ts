import type { ProjectState } from '../../api/types/project';
import type { IFileAccess } from '../io/IFileAccess';
import type { LoadedTemplatePackage } from '../template-package/TemplatePackageManifest';
import { createProjectResourceIndex } from './ProjectResourceIndex';
import { ResourceIndex } from './ResourceIndex';
import { createScannedTemplateResourceIndex } from './TemplateResourceIndex';
import { TemplateResourceConventionScanner } from './TemplateResourceConventionScanner';

type IndexFileAccess = Pick<IFileAccess, 'readDir' | 'join'>;

export class ResourceAuthoringIndexBuilder {
  private readonly templateScanner: TemplateResourceConventionScanner;

  constructor(private readonly fileAccess: IndexFileAccess) {
    this.templateScanner = new TemplateResourceConventionScanner(fileAccess);
  }

  async build(
    project: ProjectState,
    packages: readonly LoadedTemplatePackage[],
    enabledTemplateIds = project.metadata.templates?.enabledTemplateIds,
  ): Promise<ResourceIndex> {
    const combined = await createProjectResourceIndex(project, this.fileAccess);
    combined.addAll(await createScannedTemplateResourceIndex(
      packages,
      this.fileAccess,
      enabledTemplateIds,
      this.templateScanner,
    ));
    return combined;
  }

  invalidateTemplate(packageRoot?: string): void {
    this.templateScanner.clearCache(packageRoot);
  }
}
