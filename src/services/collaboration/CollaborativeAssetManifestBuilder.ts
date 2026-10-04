import {
  type CollaborativeAssetFileEntry,
  type CollaborativeAssetManifest,
  type CollaborativeAssetManifestEntry,
  type ProjectRelativeAssetPath,
} from '../../api/types/collaboration';
import type {
  HistoricalSceneDocumentV4,
  SceneDocumentV5,
} from '../../api/types/semantic-scene';
import type { IFileAccess } from '../io/IFileAccess';
import type { ProjectResourceService } from '../io/ProjectResourceService';
import {
  browserCollaborativeAssetHashAdapter,
  buildBundleManifestEntry,
  buildSingleFileManifestEntry,
  collectLive2DAssetBundleClosure,
  collectCollaborativeSceneDocumentV4AssetRefs,
  collectCollaborativeSceneDocumentV5AssetRefs,
  collectCollaborativeSceneAssetRefs,
  dirnameProjectRelativePath,
  fingerprintCollaborativeAssetFile,
  getCollaborativeSceneDocumentV4AssetReferenceKeys as getCollaborativeSceneDocumentV4AssetReferenceKeysFromPolicy,
  getCollaborativeSceneDocumentV5AssetReferenceKeys as getCollaborativeSceneDocumentV5AssetReferenceKeysFromPolicy,
  getCollaborativeAssetReferenceKeys as getCollaborativeAssetReferenceKeysFromPolicy,
  hashCollaborativeAssetBundle,
  joinProjectRelativePath,
  orderCollaborativeManifestFiles,
  type CollaborativeAssetBytes,
  type CollaborativeAssetRef,
  type LegacyCollaborativeScene,
} from './assets';

export interface CollaborativeAssetManifestBuilderOptions {
  fileAccess: IFileAccess;
  projectResources: Pick<ProjectResourceService, 'resolveForRead'>;
  now?: () => string;
}

const textEncoder = new TextEncoder();

export function getCollaborativeAssetReferenceKeys(scene: LegacyCollaborativeScene): ProjectRelativeAssetPath[] {
  return getCollaborativeAssetReferenceKeysFromPolicy(scene);
}

export function getCollaborativeSceneDocumentV4AssetReferenceKeys(document: HistoricalSceneDocumentV4): ProjectRelativeAssetPath[] {
  return getCollaborativeSceneDocumentV4AssetReferenceKeysFromPolicy(document);
}

export function getCollaborativeSceneDocumentV5AssetReferenceKeys(document: SceneDocumentV5): ProjectRelativeAssetPath[] {
  return getCollaborativeSceneDocumentV5AssetReferenceKeysFromPolicy(document);
}

function hasSameManifestReferences(
  refs: CollaborativeAssetRef[],
  previousManifest: CollaborativeAssetManifest | undefined,
): boolean {
  const nextAssetKeys = refs.map((ref) => ref.projectRelativePath).sort();
  const previousAssetKeys = Object.keys(previousManifest ?? {}).sort();
  const hasSameReferences = (
    nextAssetKeys.length === previousAssetKeys.length &&
    nextAssetKeys.every((key, index) => key === previousAssetKeys[index])
  );
  if (!hasSameReferences) return false;

  for (const ref of refs) {
    const previous = previousManifest?.[ref.projectRelativePath];
    if (!previous) return false;
    if (previous.kind !== ref.kind || previous.importKind !== ref.importKind) return false;
  }

  return true;
}

export function hasUnchangedCollaborativeAssetReferences(
  scene: LegacyCollaborativeScene,
  previousManifest: CollaborativeAssetManifest | undefined,
  options?: Pick<CollaborativeAssetManifestBuilderOptions, 'fileAccess' | 'projectResources'>,
): boolean | Promise<boolean> {
  const nextRefs = collectCollaborativeSceneAssetRefs(scene);
  if (!hasSameManifestReferences(nextRefs, previousManifest)) return false;

  if (!options) return true;

  return manifestFilesMatchCurrentDisk(previousManifest ?? {}, options);
}

export function hasUnchangedCollaborativeSceneDocumentV4AssetReferences(
  document: HistoricalSceneDocumentV4,
  previousManifest: CollaborativeAssetManifest | undefined,
  options?: Pick<CollaborativeAssetManifestBuilderOptions, 'fileAccess' | 'projectResources'>,
): boolean | Promise<boolean> {
  const nextRefs = collectCollaborativeSceneDocumentV4AssetRefs(document);
  if (!hasSameManifestReferences(nextRefs, previousManifest)) return false;

  if (!options) return true;

  return manifestFilesMatchCurrentDisk(previousManifest ?? {}, options);
}

export function hasUnchangedCollaborativeSceneDocumentV5AssetReferences(
  document: SceneDocumentV5,
  previousManifest: CollaborativeAssetManifest | undefined,
  options?: Pick<CollaborativeAssetManifestBuilderOptions, 'fileAccess' | 'projectResources'>,
): boolean | Promise<boolean> {
  const nextRefs = collectCollaborativeSceneDocumentV5AssetRefs(document);
  if (!hasSameManifestReferences(nextRefs, previousManifest)) return false;

  if (!options) return true;

  return manifestFilesMatchCurrentDisk(previousManifest ?? {}, options);
}

async function readAssetBytes(
  projectRelativePath: ProjectRelativeAssetPath,
  options: Pick<CollaborativeAssetManifestBuilderOptions, 'fileAccess' | 'projectResources'>,
): Promise<Uint8Array> {
  const absolutePath = await options.projectResources.resolveForRead(projectRelativePath);
  if (options.fileAccess.readBinaryFile) {
    const { data } = await options.fileAccess.readBinaryFile(absolutePath);
    return new Uint8Array(data);
  }
  const { data } = await options.fileAccess.readFile(absolutePath);
  return textEncoder.encode(data);
}

async function manifestFilesMatchCurrentDisk(
  manifest: CollaborativeAssetManifest,
  options: Pick<CollaborativeAssetManifestBuilderOptions, 'fileAccess' | 'projectResources'>,
): Promise<boolean> {
  const seenFiles = new Set<ProjectRelativeAssetPath>();
  for (const entry of Object.values(manifest)) {
    for (const file of entry.files) {
      if (seenFiles.has(file.relativePath)) continue;
      seenFiles.add(file.relativePath);
      let bytes: Uint8Array;
      try {
        bytes = await readAssetBytes(file.relativePath, options);
      } catch {
        return false;
      }
      if (bytes.byteLength !== file.sizeBytes) return false;
      if ((await browserCollaborativeAssetHashAdapter.sha256(bytes)) !== file.contentHash) return false;
    }
  }
  return true;
}

export class CollaborativeAssetManifestBuilder {
  private readonly fileAccess: IFileAccess;
  private readonly projectResources: Pick<ProjectResourceService, 'resolveForRead'>;
  private readonly now: () => string;

  constructor(options: CollaborativeAssetManifestBuilderOptions) {
    this.fileAccess = options.fileAccess;
    this.projectResources = options.projectResources;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async buildForScene(scene: LegacyCollaborativeScene): Promise<CollaborativeAssetManifest> {
    return this.buildForRefs(collectCollaborativeSceneAssetRefs(scene));
  }

  async buildForSceneDocumentV4(document: HistoricalSceneDocumentV4): Promise<CollaborativeAssetManifest> {
    return this.buildForRefs(collectCollaborativeSceneDocumentV4AssetRefs(document));
  }

  async buildForSceneDocumentV5(document: SceneDocumentV5): Promise<CollaborativeAssetManifest> {
    return this.buildForRefs(collectCollaborativeSceneDocumentV5AssetRefs(document));
  }

  private async buildForRefs(refs: CollaborativeAssetRef[]): Promise<CollaborativeAssetManifest> {
    const manifest: CollaborativeAssetManifest = {};
    for (const ref of refs) {
      const entry = ref.kind === 'live2d-bundle'
        ? await this.buildLive2DBundleEntry(ref)
        : await this.buildSingleFileEntry(ref);
      manifest[entry.projectRelativePath] = entry;
    }
    return manifest;
  }

  private async buildSingleFileEntry(ref: CollaborativeAssetRef): Promise<CollaborativeAssetManifestEntry> {
    const file = await this.readAssetBytes(ref.projectRelativePath);
    const fileEntry = await fingerprintCollaborativeAssetFile(file, browserCollaborativeAssetHashAdapter);
    return buildSingleFileManifestEntry(ref, fileEntry, this.now());
  }

  private async buildLive2DBundleEntry(ref: CollaborativeAssetRef): Promise<CollaborativeAssetManifestEntry> {
    const filePaths = await this.collectLive2DBundlePaths(ref.projectRelativePath);
    const files: CollaborativeAssetBytes[] = [];
    for (const relativePath of filePaths) {
      files.push(await this.readAssetBytes(relativePath));
    }

    const orderedFiles = orderCollaborativeManifestFiles(files);
    const fileEntries: CollaborativeAssetFileEntry[] = [];
    for (const file of orderedFiles) {
      fileEntries.push(await fingerprintCollaborativeAssetFile(file, browserCollaborativeAssetHashAdapter));
    }

    const bundleHash = await hashCollaborativeAssetBundle(orderedFiles, browserCollaborativeAssetHashAdapter);
    return buildBundleManifestEntry(ref, fileEntries, bundleHash, this.now());
  }

  private async collectLive2DBundlePaths(entrypointPath: ProjectRelativeAssetPath): Promise<ProjectRelativeAssetPath[]> {
    const entries = await collectLive2DAssetBundleClosure({
      sourcePath: entrypointPath,
      projectRelativePath: entrypointPath,
    }, {
      readText: (sourcePath) => this.readAssetText(sourcePath as ProjectRelativeAssetPath),
      dirname: (sourcePath) => dirnameProjectRelativePath(sourcePath as ProjectRelativeAssetPath),
      joinSource: (baseDir, childPath) => joinProjectRelativePath(baseDir as ProjectRelativeAssetPath, childPath),
      joinProjectRelative: (baseDir, childPath) => joinProjectRelativePath(baseDir, childPath),
    });

    return entries.map((entry) => entry.projectRelativePath);
  }

  private async readAssetText(projectRelativePath: ProjectRelativeAssetPath): Promise<string> {
    const absolutePath = await this.projectResources.resolveForRead(projectRelativePath);
    const { data } = await this.fileAccess.readFile(absolutePath);
    return data;
  }

  private async readAssetBytes(projectRelativePath: ProjectRelativeAssetPath): Promise<CollaborativeAssetBytes> {
    const absolutePath = await this.projectResources.resolveForRead(projectRelativePath);
    if (this.fileAccess.readBinaryFile) {
      const { data } = await this.fileAccess.readBinaryFile(absolutePath);
      return { relativePath: projectRelativePath, bytes: new Uint8Array(data) };
    }
    const { data } = await this.fileAccess.readFile(absolutePath);
    return { relativePath: projectRelativePath, bytes: textEncoder.encode(data) };
  }

}
