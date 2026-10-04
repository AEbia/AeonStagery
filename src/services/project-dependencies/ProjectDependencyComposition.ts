import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import type { ProjectExternalLibraryBindings } from '../../api/types/project';
import type { IFileAccess } from '../io/IFileAccess';
import type { ProjectResourceService } from '../io/ProjectResourceService';
import { ProjectDependencyScanner } from './ProjectDependencyScanner';
import { ExternalLibraryBindingService } from './ExternalLibraryBindingService';
import { ProjectDependencyScanService, type ProjectDependencyIssueSink } from './ProjectDependencyScanService';

export interface ProjectDependencyCompositionDeps {
  projectResources: ProjectResourceService;
  fileAccess: Pick<IFileAccess, 'join' | 'exists' | 'readFile'>;
  /** Receives the aggregated per-mount diagnostics after every scan. */
  issueSink: ProjectDependencyIssueSink;
  getBindings: () => ProjectExternalLibraryBindings;
  setBindings: (next: ProjectExternalLibraryBindings) => void;
  /** Unsaved editor document keyed by the project-relative scene path. */
  getUnsavedDocument: () => { path: string; document: CurrentSceneDocument } | null;
  /** Parse a scene file into a document without touching the open session. */
  readSceneDocumentFromPath: (absolutePath: string) => Promise<CurrentSceneDocument | null>;
  /** Drop resolution caches that would otherwise shadow a fresh binding. */
  clearResolutionCaches: () => void;
  reprojectCurrentScene: () => Promise<void>;
}

export interface ProjectDependencyComposition {
  scanner: ProjectDependencyScanner;
  scanService: ProjectDependencyScanService;
  bindingService: ExternalLibraryBindingService;
}

/**
 * Wires the project dependency scanner, its diagnostics publisher and the
 * machine-local binding service together. Lives outside the engine bootstrapper
 * so the composition can be exercised without a running editor.
 */
export function createProjectDependencyServices(
  deps: ProjectDependencyCompositionDeps,
): ProjectDependencyComposition {
  const scanner = new ProjectDependencyScanner(
    deps.projectResources,
    {
      readSceneDocument: async (scene) => {
        const project = deps.projectResources.getCurrentProject();
        if (!project) return null;
        const absolutePath = await deps.fileAccess.join(project.rootPath, scene.path);
        return deps.readSceneDocumentFromPath(absolutePath);
      },
    },
    deps.getBindings,
    deps.getUnsavedDocument,
  );

  const scanService = new ProjectDependencyScanService(scanner, deps.issueSink);

  const bindingService = new ExternalLibraryBindingService(deps.projectResources, scanner, {
    getBindings: deps.getBindings,
    setBindings: deps.setBindings,
    fileExistsInDirectory: async (directory, relativePath) => {
      const candidate = await deps.fileAccess.join(directory, relativePath);
      return deps.fileAccess.exists(candidate);
    },
    invalidateCaches: () => {
      deps.clearResolutionCaches();
      scanner.invalidateLastReport();
    },
    rescan: () => scanService.scan(),
    reprojectCurrentScene: deps.reprojectCurrentScene,
  });

  return { scanner, scanService, bindingService };
}
