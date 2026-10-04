import type { IProjectWorkspaceService, ILibraryRoots } from '../../api/interfaces';
import { createLibraryRootsPolicy, type LibraryRootsPolicy } from '../settings/LibraryRootsPolicy';

export class LibraryRoots implements ILibraryRoots {
  constructor(
    private projectWorkspace: IProjectWorkspaceService,
    private getExternalLibraryRoots: () => string[],
    private subscribeExternalLibraryRoots: (listener: () => void) => () => void,
    private policy: LibraryRootsPolicy = createLibraryRootsPolicy(),
  ) {}

  getRoots(): string[] {
    const currentProject = this.projectWorkspace.getCurrentProject();
    return this.policy.resolveRoots({
      projectRoot: currentProject?.rootPath,
      externalRoots: this.getExternalLibraryRoots(),
    });
  }

  subscribe(listener: () => void): () => void {
    const unsubProject = this.projectWorkspace.subscribe(listener);
    const unsubExternalRoots = this.subscribeExternalLibraryRoots(listener);
    return () => {
      unsubProject();
      unsubExternalRoots();
    };
  }

}
