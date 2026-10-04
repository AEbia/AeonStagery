import type { ProjectState, ProjectAssetRoots } from '../../api/types/project';
import type { IFileAccess } from '../io/IFileAccess';
import { ResourceIndex } from './ResourceIndex';
import { listResourceFiles } from './ResourceFileScanner';
import type { ResourceKind } from './ResourceAuthoringTypes';
import { isLive2DModelEntryPath } from '../collaboration/assets/Live2DModelEntry';

type ProjectIndexFileAccess = Pick<IFileAccess, 'readDir' | 'join'>;

const SIMPLE_ROOTS: Array<{ root: keyof ProjectAssetRoots; kind: ResourceKind }> = [
  { root: 'background', kind: 'background' },
  { root: 'images', kind: 'image' },
  { root: 'bgm', kind: 'bgm' },
  { root: 'vocal', kind: 'voice' },
  { root: 'animation', kind: 'animation' },
];

const EXTENSIONS: Partial<Record<ResourceKind, readonly string[]>> = {
  background: ['png', 'jpg', 'jpeg', 'webp', 'avif'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'svg'],
  bgm: ['mp3', 'ogg', 'wav', 'm4a', 'flac'],
  voice: ['mp3', 'ogg', 'wav', 'm4a', 'flac'],
  animation: ['json'],
};

export async function createProjectResourceIndex(
  project: ProjectState,
  fileAccess: ProjectIndexFileAccess,
): Promise<ResourceIndex> {
  const index = new ResourceIndex();
  for (const definition of SIMPLE_ROOTS) {
    const rootName = project.metadata.assetRoots[definition.root];
    const absoluteRoot = await fileAccess.join(project.rootPath, rootName);
    for (const relative of await listResourceFiles(fileAccess, absoluteRoot)) {
      const name = resourceName(relative, definition.kind);
      if (!name) continue;
      const ownerId = definition.kind === 'voice' && relative.includes('/') ? relative.split('/')[0] : undefined;
      index.add({
        key: { kind: definition.kind, name, ...(ownerId ? { ownerId } : {}) },
        namespace: 'project',
        portablePath: `${rootName}/${relative}`,
        source: 'convention',
      });
    }
  }
  await addProjectModels(index, project, fileAccess);
  return index;
}

async function addProjectModels(index: ResourceIndex, project: ProjectState, fileAccess: ProjectIndexFileAccess): Promise<void> {
  const rootName = project.metadata.assetRoots.figure;
  const absoluteRoot = await fileAccess.join(project.rootPath, rootName);
  for (const relative of await listResourceFiles(fileAccess, absoluteRoot)) {
    if (!isLive2DModelEntryPath(relative)) continue;
    const parts = relative.split('/');
    const modelsIndex = parts.lastIndexOf('models');
    const ownerId = modelsIndex > 0 ? parts[modelsIndex - 1] : parts.length >= 3 ? parts[parts.length - 3] : undefined;
    const outfitId = modelsIndex >= 0 ? parts[modelsIndex + 1] : parts.length >= 3 ? parts[parts.length - 2] : undefined;
    if (!ownerId || !outfitId) continue;
    index.add({
      key: { kind: 'live2dModel', name: outfitId, ownerId, outfitId },
      namespace: 'project',
      portablePath: `${rootName}/${relative}`,
      source: 'outfit',
    });
  }
}

function resourceName(relative: string, kind: ResourceKind): string | undefined {
  const file = relative.split('/').at(-1) ?? '';
  const extension = EXTENSIONS[kind]?.find((candidate) => file.toLowerCase().endsWith(`.${candidate}`));
  if (!extension) return undefined;
  return file.slice(0, -(extension.length + 1));
}
