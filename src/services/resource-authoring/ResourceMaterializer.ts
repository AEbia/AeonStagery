import type { ResourceImportKind } from '../../api/types/project';
import type { ProjectResourceService } from '../io/ProjectResourceService';
import { TemplateAssetResolver } from '../template-package/TemplateAssetResolver';
import {
  templateMetadataMatchesId,
  type LoadedTemplatePackage,
} from '../template-package/TemplatePackageManifest';
import type { ResourceCandidate, ResourceKey } from './ResourceAuthoringTypes';

export interface MaterializedResourceReceipt {
  input: string;
  key: ResourceKey;
  namespace: string;
  sourcePath: string;
  projectPath: string;
  operation: 'existing-project-reference' | 'copied-template-resource' | 'imported-explicit-path';
  importKind: ResourceImportKind;
}

export interface MaterializedResource {
  reference: string;
  receipt: MaterializedResourceReceipt;
}

type MaterializerFileAccess = ConstructorParameters<typeof TemplateAssetResolver>[0];

export class ResourceMaterializer {
  private readonly templateAssets: TemplateAssetResolver;

  constructor(
    fileAccess: MaterializerFileAccess,
    private readonly projectResources: Pick<ProjectResourceService, 'materializeFromTrustedRoot' | 'normalizeForStorage' | 'importIntoProject'>,
    private readonly getTemplatePackages: () => readonly LoadedTemplatePackage[],
  ) {
    this.templateAssets = new TemplateAssetResolver(fileAccess);
  }

  async materialize(input: string, candidate: ResourceCandidate): Promise<MaterializedResource> {
    if (candidate.namespace === 'project') {
      const importKind = importKindFor(candidate.key.kind);
      return {
        reference: candidate.portablePath,
        receipt: {
          input,
          key: candidate.key,
          namespace: 'project',
          sourcePath: candidate.portablePath,
          projectPath: candidate.portablePath,
          operation: 'existing-project-reference',
          importKind,
        },
      };
    }
    if (candidate.namespace === 'path') {
      const importKind = importKindFor(candidate.key.kind);
      const sourcePath = candidate.portablePath;
      const imported = isAbsolutePath(sourcePath)
        ? await this.projectResources.importIntoProject(sourcePath, importKind, 'copy')
        : await this.projectResources.normalizeForStorage(sourcePath, importKind);
      return {
        reference: imported.relativePath,
        receipt: {
          input,
          key: candidate.key,
          namespace: 'path',
          sourcePath,
          projectPath: imported.relativePath,
          operation: imported.relativePath === sourcePath.replace(/\\/g, '/')
            ? 'existing-project-reference'
            : 'imported-explicit-path',
          importKind,
        },
      };
    }

    const templatePackage = this.getTemplatePackages().find(
      (item) => templateMetadataMatchesId(item.manifest.template, candidate.namespace),
    );
    if (!templatePackage) throw new Error(`Template namespace is no longer available: "${candidate.namespace}"`);
    const sourcePath = await this.templateAssets.resolveAsset(templatePackage, candidate.portablePath);
    const importKind = importKindFor(candidate.key.kind);
    const projectPath = preferredProjectPath(candidate, importKind);
    const imported = await this.projectResources.materializeFromTrustedRoot(
      templatePackage.source.packageRoot,
      sourcePath,
      importKind,
      projectPath,
    );
    return {
      reference: imported.relativePath,
      receipt: {
        input,
        key: candidate.key,
        namespace: candidate.namespace,
        sourcePath,
        projectPath: imported.relativePath,
        operation: 'copied-template-resource',
        importKind,
      },
    };
  }
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function importKindFor(kind: ResourceKey['kind']): ResourceImportKind {
  switch (kind) {
    case 'live2dModel':
    case 'live2dMotion':
    case 'live2dExpression': return 'figure';
    case 'background': return 'background';
    case 'bgm': return 'bgm';
    case 'voice': return 'vocal';
    case 'animation': return 'animation';
    case 'image':
    case 'icon':
    case 'font':
    case 'lut':
    case 'mask': return 'images';
    case 'sfx': return 'generic';
  }
}

function preferredProjectPath(candidate: ResourceCandidate, kind: ResourceImportKind): string {
  const root = kind === 'generic' ? 'audio' : kind;
  const portablePath = candidate.portablePath.replace(/\\/g, '/');
  const withoutRepeatedRoot = portablePath.startsWith(`${root}/`)
    ? portablePath.slice(root.length + 1)
    : portablePath;
  return `${root}/${candidate.namespace}/${withoutRepeatedRoot}`;
}
