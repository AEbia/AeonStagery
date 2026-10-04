export type LibraryRootKind = 'project' | 'external';

export interface LibraryRootsPolicyInput {
  projectRoot?: string | null;
  externalRoots: string[];
}

export interface LibraryRootDescriptor {
  root: string;
  kind: LibraryRootKind;
  writable: boolean;
}

export interface LibraryRootsPolicy {
  resolveRoots(input: LibraryRootsPolicyInput): string[];
  describeRoot(root: string, kind: LibraryRootKind): LibraryRootDescriptor;
}

export function createLibraryRootsPolicy(): LibraryRootsPolicy {
  return new DefaultLibraryRootsPolicy();
}

class DefaultLibraryRootsPolicy implements LibraryRootsPolicy {
  resolveRoots(input: LibraryRootsPolicyInput): string[] {
    const roots: string[] = [];
    const projectRoot = normalizeRoot(input.projectRoot ?? '');
    if (projectRoot) {
      roots.push(projectRoot);
    }

    for (const root of input.externalRoots) {
      const normalized = normalizeRoot(root);
      if (!normalized) continue;
      if (!roots.some((existing) => sameRoot(existing, normalized))) {
        roots.push(normalized);
      }
    }

    return roots;
  }

  describeRoot(root: string, kind: LibraryRootKind): LibraryRootDescriptor {
    return {
      root,
      kind,
      writable: kind === 'project',
    };
  }
}

function normalizeRoot(root: string): string {
  return root.replace(/\\/g, '/').trim().replace(/\/+$/, '');
}

function sameRoot(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
