import type { ProjectRelativeAssetPath } from '../../../api/types/collaboration';
import {
  dirnameProjectRelativePath,
  joinProjectRelativePath,
} from './CollaborativeAssetScopePolicy';
import {
  describeLive2DModelEntrypoint,
  isLive2DAssetBundleEntrypoint,
} from './Live2DModelEntry';

function addStringRef(refs: Set<string>, value: unknown): void {
  if (typeof value !== 'string' || !value.trim()) return;
  refs.add(value);
}

export function collectLive2DModelJsonRawReferences(modelJson: any): string[] {
  const refs = new Set<string>();
  addStringRef(refs, modelJson.model);
  addStringRef(refs, modelJson.physics);
  addStringRef(refs, modelJson.pose);

  for (const texture of modelJson.textures || []) {
    addStringRef(refs, texture);
  }

  for (const expression of modelJson.expressions || []) {
    addStringRef(refs, expression?.file);
  }

  for (const motionGroup of Object.values(modelJson.motions || {})) {
    if (!Array.isArray(motionGroup)) continue;
    for (const motion of motionGroup) {
      addStringRef(refs, motion?.file);
      addStringRef(refs, motion?.sound);
    }
  }

  const fileReferences = modelJson.FileReferences;
  if (fileReferences && typeof fileReferences === 'object') {
    addStringRef(refs, fileReferences.Moc);
    addStringRef(refs, fileReferences.Physics);
    addStringRef(refs, fileReferences.Pose);
    addStringRef(refs, fileReferences.UserData);
    addStringRef(refs, fileReferences.DisplayInfo);

    for (const texture of fileReferences.Textures || []) {
      addStringRef(refs, texture);
    }

    for (const expression of fileReferences.Expressions || []) {
      addStringRef(refs, expression?.File ?? expression?.file);
    }

    for (const motionGroup of Object.values(fileReferences.Motions || {})) {
      if (!Array.isArray(motionGroup)) continue;
      for (const motion of motionGroup) {
        addStringRef(refs, motion?.File ?? motion?.file);
        addStringRef(refs, motion?.Sound ?? motion?.sound);
      }
    }
  }

  return Array.from(refs);
}

export function collectWmdlRawReferences(wmdl: any): string[] {
  const refs = new Set<string>();
  addStringRef(refs, wmdl.modelRelativePath);
  for (const subModel of wmdl.subModels || []) {
    addStringRef(refs, subModel?.modelRelativePath);
  }
  return Array.from(refs);
}

export function collectLive2DAssetBundleRawReferences(parsedEntrypoint: any, entrypointPath: string): string[] {
  const entry = describeLive2DModelEntrypoint(entrypointPath, parsedEntrypoint);
  return entry.format === 'wmdl'
    ? collectWmdlRawReferences(parsedEntrypoint)
    : collectLive2DModelJsonRawReferences(parsedEntrypoint);
}

export function collectLive2DAssetBundleDependencyPaths(
  parsedEntrypoint: any,
  entrypointPath: ProjectRelativeAssetPath,
): ProjectRelativeAssetPath[] {
  const baseDir = dirnameProjectRelativePath(entrypointPath);
  return collectLive2DAssetBundleRawReferences(parsedEntrypoint, entrypointPath)
    .map((ref) => joinProjectRelativePath(baseDir, ref));
}

export interface Live2DAssetBundleClosureEntry {
  sourcePath: string;
  projectRelativePath: ProjectRelativeAssetPath;
}

export interface Live2DAssetBundleClosureAdapter {
  readText(sourcePath: string): Promise<string>;
  dirname(sourcePath: string): Promise<string> | string;
  joinSource(baseDir: string, childPath: string): Promise<string> | string;
  joinProjectRelative(baseDir: ProjectRelativeAssetPath, childPath: string): ProjectRelativeAssetPath;
  normalizeSourcePath?(sourcePath: string): string;
  validateReference?(ref: string, current: Live2DAssetBundleClosureEntry): void;
}

export async function collectLive2DAssetBundleClosure(
  entrypoint: Live2DAssetBundleClosureEntry,
  adapter: Live2DAssetBundleClosureAdapter,
): Promise<Live2DAssetBundleClosureEntry[]> {
  const entries: Live2DAssetBundleClosureEntry[] = [];
  const seenProjectPaths = new Set<string>();
  const visitedSources = new Set<string>();
  const queue: Live2DAssetBundleClosureEntry[] = [{
    sourcePath: entrypoint.sourcePath.replace(/\\/g, '/'),
    projectRelativePath: entrypoint.projectRelativePath,
  }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const projectKey = current.projectRelativePath.toLowerCase();
    if (!seenProjectPaths.has(projectKey)) {
      seenProjectPaths.add(projectKey);
      entries.push(current);
    }

    if (!isLive2DAssetBundleEntrypoint(current.sourcePath)) continue;
    const sourceKey = adapter.normalizeSourcePath?.(current.sourcePath)
      ?? current.sourcePath.replace(/\\/g, '/').toLowerCase();
    if (visitedSources.has(sourceKey)) continue;
    visitedSources.add(sourceKey);

    let parsed: any;
    try {
      parsed = JSON.parse(await adapter.readText(current.sourcePath));
    } catch {
      continue;
    }
    if (!describeLive2DModelEntrypoint(current.sourcePath, parsed).isBundleEntrypoint) continue;

    const sourceDir = await adapter.dirname(current.sourcePath);
    const projectDir = dirnameProjectRelativePath(current.projectRelativePath);
    for (const ref of collectLive2DAssetBundleRawReferences(parsed, current.sourcePath)) {
      adapter.validateReference?.(ref, current);
      const childSourcePath = (await adapter.joinSource(sourceDir, ref)).replace(/\\/g, '/');
      const childProjectRelativePath = adapter.joinProjectRelative(projectDir, ref);
      queue.push({
        sourcePath: childSourcePath,
        projectRelativePath: childProjectRelativePath,
      });
    }
  }

  return entries;
}
