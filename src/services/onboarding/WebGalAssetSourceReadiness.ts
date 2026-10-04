import type { Live2DRuntimeFamily } from '../collaboration/assets';
import { describeLive2DModelEntrypoint } from '../collaboration/assets';

export type WebGalAssetSourceReadinessStatus = 'checking' | 'found' | 'needs_reselect';

export type WebGalAssetSourceReadinessFailureCode =
  | 'missing-figure-directory'
  | 'no-loadable-model'
  | 'model-entry-unreadable'
  | 'model-entry-invalid-json'
  | 'model-format-unrecognized'
  | 'model-runtime-unavailable'
  | 'model-body-missing'
  | 'model-texture-missing';

export interface WebGalAssetSourceReadinessFound {
  status: 'found';
  rootPath: string;
  figurePath: string;
  modelEntryPath: string;
  modelEntryRelativePath: string;
  runtimeFamily: Exclude<Live2DRuntimeFamily, 'unknown' | 'wmdl'>;
}

export interface WebGalAssetSourceReadinessNeedsReselect {
  status: 'needs_reselect';
  code: WebGalAssetSourceReadinessFailureCode;
}

export type WebGalAssetSourceReadinessResult =
  | { status: 'checking' }
  | WebGalAssetSourceReadinessFound
  | WebGalAssetSourceReadinessNeedsReselect;

export interface WebGalAssetSourceDirEntry {
  name: string;
  isDirectory: boolean;
  path?: string;
}

export interface WebGalAssetSourceFileAccess {
  readFile(path: string): Promise<{ data: string; path?: string } | string>;
  readDir(path: string): Promise<WebGalAssetSourceDirEntry[]>;
  exists(path: string): Promise<boolean>;
  join(...parts: string[]): Promise<string> | string;
  dirname(path: string): Promise<string> | string;
}

export interface WebGalAssetSourceReadinessOptions {
  isRuntimeFamilyAvailable?: (runtimeFamily: Exclude<Live2DRuntimeFamily, 'unknown' | 'wmdl'>) => boolean;
  maxVisitedDirectories?: number;
}

export type FirstLessonLive2DModelReadinessResult =
  | {
    status: 'found';
    modelEntryPath: string;
    runtimeFamily: Exclude<Live2DRuntimeFamily, 'unknown' | 'wmdl'>;
  }
  | WebGalAssetSourceReadinessNeedsReselect;

interface CandidateEvaluation {
  loadable: boolean;
  code?: WebGalAssetSourceReadinessFailureCode;
  runtimeFamily?: Exclude<Live2DRuntimeFamily, 'unknown' | 'wmdl'>;
}

const DEFAULT_MAX_VISITED_DIRECTORIES = 2_000;

export async function checkWebGalAssetSourceReadiness(
  rootPath: string,
  fileAccess: WebGalAssetSourceFileAccess,
  options: WebGalAssetSourceReadinessOptions = {},
): Promise<WebGalAssetSourceReadinessResult> {
  const normalizedRoot = normalizePath(rootPath);
  if (!normalizedRoot) return { status: 'needs_reselect', code: 'missing-figure-directory' };

  const figurePath = await findDirectFigureDirectory(normalizedRoot, fileAccess);
  if (!figurePath) return { status: 'needs_reselect', code: 'missing-figure-directory' };

  const maxVisitedDirectories = options.maxVisitedDirectories ?? DEFAULT_MAX_VISITED_DIRECTORIES;
  const isRuntimeFamilyAvailable = options.isRuntimeFamilyAvailable ?? ((runtimeFamily) => runtimeFamily === 'cubism2');
  let firstFailure: WebGalAssetSourceReadinessFailureCode | null = null;
  let visitedDirectories = 0;
  const queue = [figurePath];

  while (queue.length > 0 && visitedDirectories < maxVisitedDirectories) {
    const directoryPath = queue.shift()!;
    visitedDirectories += 1;

    let entries: WebGalAssetSourceDirEntry[];
    try {
      entries = await fileAccess.readDir(directoryPath);
    } catch {
      if (!firstFailure) firstFailure = 'no-loadable-model';
      continue;
    }

    const sortedEntries = [...entries].sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of sortedEntries) {
      const entryPath = normalizePath(entry.path ?? await fileAccess.join(directoryPath, entry.name));
      if (entry.isDirectory) {
        queue.push(entryPath);
        continue;
      }

      if (!isFirstLessonLive2DEntryName(entry.name)) continue;
      const evaluation = await evaluateLive2DEntryForFirstLesson(
        entryPath,
        fileAccess,
        isRuntimeFamilyAvailable,
      );
      if (evaluation.loadable && evaluation.runtimeFamily) {
        return {
          status: 'found',
          rootPath: normalizedRoot,
          figurePath,
          modelEntryPath: entryPath,
          modelEntryRelativePath: normalizeRelativePath(entryPath.slice(figurePath.length).replace(/^\/+/, '')),
          runtimeFamily: evaluation.runtimeFamily,
        };
      }
      if (!firstFailure && evaluation.code) firstFailure = evaluation.code;
    }
  }

  return {
    status: 'needs_reselect',
    code: firstFailure ?? 'no-loadable-model',
  };
}

export function isFirstLessonLive2DEntryName(fileName: string): boolean {
  const normalized = fileName.replace(/\\/g, '/').trim().toLowerCase();
  const baseName = normalized.slice(normalized.lastIndexOf('/') + 1);
  return baseName === 'model.json' ||
    baseName.endsWith('.model.json') ||
    baseName.endsWith('.model3.json');
}

export async function checkFirstLessonLive2DModelReadiness(
  modelEntryPath: string,
  fileAccess: WebGalAssetSourceFileAccess,
  options: Pick<WebGalAssetSourceReadinessOptions, 'isRuntimeFamilyAvailable'> = {},
): Promise<FirstLessonLive2DModelReadinessResult> {
  const normalizedEntryPath = normalizePath(modelEntryPath);
  if (!normalizedEntryPath || !isFirstLessonLive2DEntryName(normalizedEntryPath)) {
    return { status: 'needs_reselect', code: 'model-format-unrecognized' };
  }

  const isRuntimeFamilyAvailable = options.isRuntimeFamilyAvailable
    ?? ((runtimeFamily) => runtimeFamily === 'cubism2');
  const evaluation = await evaluateLive2DEntryForFirstLesson(
    normalizedEntryPath,
    fileAccess,
    isRuntimeFamilyAvailable,
  );
  if (!evaluation.loadable || !evaluation.runtimeFamily) {
    return {
      status: 'needs_reselect',
      code: evaluation.code ?? 'no-loadable-model',
    };
  }

  return {
    status: 'found',
    modelEntryPath: normalizedEntryPath,
    runtimeFamily: evaluation.runtimeFamily,
  };
}

async function findDirectFigureDirectory(
  rootPath: string,
  fileAccess: WebGalAssetSourceFileAccess,
): Promise<string | null> {
  let entries: WebGalAssetSourceDirEntry[];
  try {
    entries = await fileAccess.readDir(rootPath);
  } catch {
    return null;
  }

  const figure = entries.find((entry) => entry.isDirectory && entry.name.toLowerCase() === 'figure');
  if (!figure) return null;
  const figurePath = normalizePath(figure.path ?? await fileAccess.join(rootPath, figure.name));
  return await fileAccess.exists(figurePath) ? figurePath : null;
}

async function evaluateLive2DEntryForFirstLesson(
  entryPath: string,
  fileAccess: WebGalAssetSourceFileAccess,
  isRuntimeFamilyAvailable: (runtimeFamily: Exclude<Live2DRuntimeFamily, 'unknown' | 'wmdl'>) => boolean,
): Promise<CandidateEvaluation> {
  let raw: string;
  try {
    const loaded = await fileAccess.readFile(entryPath);
    raw = typeof loaded === 'string' ? loaded : loaded.data;
  } catch {
    return { loadable: false, code: 'model-entry-unreadable' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { loadable: false, code: 'model-entry-invalid-json' };
  }

  const entry = describeLive2DModelEntrypoint(entryPath, parsed);
  if (entry.runtimeFamily !== 'cubism2' && entry.runtimeFamily !== 'cubism3-plus') {
    return { loadable: false, code: 'model-format-unrecognized' };
  }

  const required = collectFirstLessonRequiredLive2DDependencies(parsed, entry.runtimeFamily);
  if (!required.modelBody) return { loadable: false, code: 'model-body-missing' };
  if (required.textures.length === 0) return { loadable: false, code: 'model-texture-missing' };

  const entryDir = await fileAccess.dirname(entryPath);
  if (!await dependencyExists(fileAccess, entryDir, required.modelBody)) {
    return { loadable: false, code: 'model-body-missing' };
  }
  for (const texture of required.textures) {
    if (!await dependencyExists(fileAccess, entryDir, texture)) {
      return { loadable: false, code: 'model-texture-missing' };
    }
  }

  if (!isRuntimeFamilyAvailable(entry.runtimeFamily)) {
    return { loadable: false, code: 'model-runtime-unavailable' };
  }

  return {
    loadable: true,
    runtimeFamily: entry.runtimeFamily,
  };
}

function collectFirstLessonRequiredLive2DDependencies(
  parsed: unknown,
  runtimeFamily: Exclude<Live2DRuntimeFamily, 'unknown' | 'wmdl'>,
): { modelBody: string | null; textures: string[] } {
  if (!parsed || typeof parsed !== 'object') return { modelBody: null, textures: [] };
  const modelJson = parsed as Record<string, unknown>;

  if (runtimeFamily === 'cubism3-plus') {
    const fileReferences = modelJson.FileReferences;
    if (!fileReferences || typeof fileReferences !== 'object') {
      return { modelBody: null, textures: [] };
    }
    const refs = fileReferences as Record<string, unknown>;
    return {
      modelBody: normalizeDependencyRef(refs.Moc, '.moc3'),
      textures: normalizeDependencyList(refs.Textures),
    };
  }

  return {
    modelBody: normalizeDependencyRef(modelJson.model, '.moc'),
    textures: normalizeDependencyList(modelJson.textures),
  };
}

async function dependencyExists(
  fileAccess: WebGalAssetSourceFileAccess,
  entryDir: string,
  dependencyRef: string,
): Promise<boolean> {
  if (!isRelativeDependencyRef(dependencyRef)) return false;
  const dependencyPath = normalizePath(await fileAccess.join(entryDir, dependencyRef));
  return fileAccess.exists(dependencyPath);
}

function normalizeDependencyRef(value: unknown, requiredExtension: string): string | null {
  if (typeof value !== 'string') return null;
  const ref = normalizeRelativePath(value);
  return ref.toLowerCase().endsWith(requiredExtension) ? ref : null;
}

function normalizeDependencyList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && !!item.trim())
    .map(normalizeRelativePath);
}

function isRelativeDependencyRef(value: string): boolean {
  const normalized = normalizeRelativePath(value);
  return !!normalized &&
    !normalized.startsWith('/') &&
    !/^[a-z]+:\/\//i.test(normalized) &&
    !/^[a-z]:\//i.test(normalized) &&
    !normalized.split('/').includes('..');
}

function normalizeRelativePath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').trim().replace(/^\/+/, '').replace(/\/+/g, '/');
}

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').trim().replace(/\/+$/, '');
}
