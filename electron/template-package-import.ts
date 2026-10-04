import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import { parseTemplatePackageManifest } from '../src/services/template-package/TemplatePackageManifest';
import { TemplatePackageLoader } from '../src/services/template-package/TemplatePackageLoader';
import type { ImportedTemplatePackageSummary } from '../src/api/types/template-package-import';

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRY_COUNT = 100_000;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

export interface TemplatePackageArchiveInspection {
  archivePath: string;
  archiveSize: number;
  archiveMtimeMs: number;
  packagePrefix: string;
  manifest: ReturnType<typeof parseTemplatePackageManifest>;
}

export async function inspectTemplatePackageArchive(
  archivePath: string,
): Promise<TemplatePackageArchiveInspection> {
  const archiveStats = await fs.promises.stat(archivePath);
  if (!archiveStats.isFile()) throw new Error('模板包不是文件');
  if (archiveStats.size > MAX_ARCHIVE_BYTES) throw new Error('模板包压缩文件超过 2 GB 限制');

  const zipFile = await openZipFile(archivePath);
  try {
    const entries = await collectEntries(zipFile);
    const normalizedEntries = validateTemplateArchiveEntries(entries);
    const manifestEntries = normalizedEntries.filter(({ normalizedPath, isDirectory }) => (
      !isDirectory && (normalizedPath === 'manifest.v2.json' || normalizedPath.endsWith('/manifest.v2.json'))
    ));
    if (manifestEntries.length !== 1) {
      throw new Error(`模板包必须且只能包含一个 manifest.v2.json，当前找到 ${manifestEntries.length} 个`);
    }

    const manifestPath = manifestEntries[0].normalizedPath;
    const manifestSegments = manifestPath.split('/');
    if (manifestSegments.length > 2) {
      throw new Error('manifest.v2.json 必须位于压缩包根目录或唯一的一级模板目录中');
    }
    const packagePrefix = manifestSegments.length === 2 ? `${manifestSegments[0]}/` : '';
    for (const entry of normalizedEntries) {
      if (isIgnoredArchiveMetadata(entry.normalizedPath)) continue;
      if (packagePrefix && !entry.normalizedPath.startsWith(packagePrefix)) {
        throw new Error('压缩包只能包含一个顶层模板目录');
      }
    }

    zipFile.close();
    const manifestBuffer = await readArchiveEntryBuffer(
      archivePath,
      manifestEntries[0].entry.fileName,
      MAX_MANIFEST_BYTES,
    );
    const manifest = parseTemplatePackageManifest(JSON.parse(manifestBuffer.toString('utf8')));
    if (manifest.manifestSchemaVersion !== 2) throw new Error('仅支持 manifestSchemaVersion 2 模板包');
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(manifest.template.id)) {
      throw new Error(`模板 ID 不能用于本地安装目录：${manifest.template.id}`);
    }

    return {
      archivePath,
      archiveSize: archiveStats.size,
      archiveMtimeMs: archiveStats.mtimeMs,
      packagePrefix,
      manifest,
    };
  } catch (error) {
    zipFile.close();
    throw error;
  }
}

export async function installTemplatePackageArchive(
  inspection: TemplatePackageArchiveInspection,
  userDataRoot: string,
  replaceExisting: boolean,
): Promise<ImportedTemplatePackageSummary> {
  const templatesRoot = path.join(userDataRoot, 'templates');
  const destinationRoot = path.join(templatesRoot, inspection.manifest.template.id);
  const alreadyExists = await pathExists(destinationRoot);
  if (alreadyExists && !replaceExisting) {
    throw new TemplatePackageAlreadyInstalledError(
      inspection.manifest.template.id,
      inspection.manifest.template.name,
      inspection.manifest.template.version,
    );
  }

  const currentArchiveStats = await fs.promises.stat(inspection.archivePath);
  if (
    currentArchiveStats.size !== inspection.archiveSize
    || currentArchiveStats.mtimeMs !== inspection.archiveMtimeMs
  ) {
    throw new Error('模板压缩包在验证后发生变化，请重新选择文件');
  }

  await fs.promises.mkdir(templatesRoot, { recursive: true });
  const nonce = crypto.randomUUID();
  const stagingRoot = path.join(templatesRoot, `.import-${nonce}`);
  const backupRoot = path.join(templatesRoot, `.backup-${inspection.manifest.template.id}-${nonce}`);
  const zipFile = await openZipFile(inspection.archivePath);
  let movedExisting = false;
  try {
    await fs.promises.mkdir(stagingRoot);
    await extractArchiveEntries(zipFile, inspection.packagePrefix, stagingRoot);

    const stagedPackage = await new TemplatePackageLoader({
      readFile: async (filePath) => ({ path: filePath, data: await fs.promises.readFile(filePath, 'utf8') }),
      join: async (...parts) => path.join(...parts),
      dirname: async (filePath) => path.dirname(filePath),
    }).loadFromPackageRoot('user', stagingRoot);
    if (
      stagedPackage.manifest.template.id !== inspection.manifest.template.id
      || stagedPackage.manifest.template.version !== inspection.manifest.template.version
    ) {
      throw new Error('解压后的模板清单与已验证清单不一致');
    }
    await validateDirectTemplateAssetReferences(stagingRoot, stagedPackage.manifest);
    if (alreadyExists) {
      await fs.promises.rename(destinationRoot, backupRoot);
      movedExisting = true;
    }
    await fs.promises.rename(stagingRoot, destinationRoot);
    if (movedExisting) await fs.promises.rm(backupRoot, { recursive: true, force: true });

    return {
      id: inspection.manifest.template.id,
      name: inspection.manifest.template.name,
      version: inspection.manifest.template.version,
      installPath: destinationRoot,
      replaced: alreadyExists,
    };
  } catch (error) {
    if (movedExisting && !(await pathExists(destinationRoot)) && await pathExists(backupRoot)) {
      await fs.promises.rename(backupRoot, destinationRoot);
    }
    throw error;
  } finally {
    zipFile.close();
    await fs.promises.rm(stagingRoot, { recursive: true, force: true });
    if (!movedExisting || await pathExists(destinationRoot)) {
      await fs.promises.rm(backupRoot, { recursive: true, force: true });
    }
  }
}

export class TemplatePackageAlreadyInstalledError extends Error {
  constructor(
    readonly templateId: string,
    readonly templateName: string,
    readonly templateVersion: string,
  ) {
    super(`模板已安装：${templateName} ${templateVersion}`);
  }
}

export function validateTemplateArchiveEntryPath(entryPath: string): string {
  if (!entryPath || entryPath.includes('\0') || entryPath.includes('\\')) {
    throw new Error(`压缩包包含不安全路径：${entryPath}`);
  }
  if (entryPath.startsWith('/') || /^[a-zA-Z]:/.test(entryPath)) {
    throw new Error(`压缩包包含绝对路径：${entryPath}`);
  }
  const segments = entryPath.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`压缩包路径试图越过安装目录：${entryPath}`);
  }
  return segments.filter(Boolean).join('/') + (entryPath.endsWith('/') ? '/' : '');
}

function validateTemplateArchiveEntries(entries: yauzl.Entry[]) {
  if (entries.length === 0) throw new Error('模板压缩包为空');
  if (entries.length > MAX_ENTRY_COUNT) throw new Error(`模板包文件数超过 ${MAX_ENTRY_COUNT} 限制`);
  let unpackedBytes = 0;
  const seenPaths = new Set<string>();
  return entries.map((entry) => {
    const normalizedPath = validateTemplateArchiveEntryPath(entry.fileName);
    const isDirectory = normalizedPath.endsWith('/');
    const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
    if (unixType === 0o120000) throw new Error(`模板包不能包含符号链接：${normalizedPath}`);
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > MAX_ENTRY_BYTES) {
      throw new Error(`模板包单个文件超过 1 GB 限制：${normalizedPath}`);
    }
    unpackedBytes += entry.uncompressedSize;
    if (unpackedBytes > MAX_UNPACKED_BYTES) throw new Error('模板包解压后超过 4 GB 限制');
    const pathKey = normalizedPath.toLowerCase();
    if (seenPaths.has(pathKey)) throw new Error(`模板包包含重复路径：${normalizedPath}`);
    seenPaths.add(pathKey);
    return { entry, normalizedPath, isDirectory };
  });
}

function openZipFile(archivePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, {
      lazyEntries: true,
      autoClose: false,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    }, (error, zipFile) => {
      if (error || !zipFile) reject(error ?? new Error('无法打开模板压缩包'));
      else resolve(zipFile);
    });
  });
}

function collectEntries(zipFile: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: yauzl.Entry[] = [];
    const onEntry = (entry: yauzl.Entry) => {
      entries.push(entry);
      zipFile.readEntry();
    };
    const onEnd = () => {
      cleanup();
      resolve(entries);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      zipFile.removeListener('entry', onEntry);
      zipFile.removeListener('end', onEnd);
      zipFile.removeListener('error', onError);
    };
    zipFile.on('entry', onEntry);
    zipFile.once('end', onEnd);
    zipFile.once('error', onError);
    zipFile.readEntry();
  });
}

function openEntryStream(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error(`无法读取压缩包文件：${entry.fileName}`));
      else resolve(stream);
    });
  });
}

function extractArchiveEntries(
  zipFile: yauzl.ZipFile,
  packagePrefix: string,
  stagingRoot: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    zipFile.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        const [{ normalizedPath, isDirectory }] = validateTemplateArchiveEntries([entry]);
        if (isIgnoredArchiveMetadata(normalizedPath)) return;
        if (packagePrefix && !normalizedPath.startsWith(packagePrefix)) {
          throw new Error('压缩包只能包含一个顶层模板目录');
        }
        const relativePath = packagePrefix
          ? normalizedPath.slice(packagePrefix.length)
          : normalizedPath;
        if (!relativePath) return;
        const targetPath = resolveInside(stagingRoot, relativePath);
        if (isDirectory) {
          await fs.promises.mkdir(targetPath, { recursive: true });
          return;
        }
        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
        const source = await openEntryStream(zipFile, entry);
        await pipeline(source, fs.createWriteStream(targetPath, { flags: 'wx' }));
      })().then(
        () => { if (!settled) zipFile.readEntry(); },
        (error) => finish(() => reject(error)),
      );
    });
    zipFile.once('end', () => finish(resolve));
    zipFile.once('error', (error) => finish(() => reject(error)));
    zipFile.readEntry();
  });
}

async function readEntryBuffer(zipFile: yauzl.ZipFile, entry: yauzl.Entry, maxBytes: number): Promise<Buffer> {
  if (entry.uncompressedSize > maxBytes) throw new Error('manifest.v2.json 过大');
  const stream = await openEntryStream(zipFile, entry);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array>) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error('manifest.v2.json 过大');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readArchiveEntryBuffer(
  archivePath: string,
  targetEntryName: string,
  maxBytes: number,
): Promise<Buffer> {
  const zipFile = await openZipFile(archivePath);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      zipFile.close();
      callback();
    };
    zipFile.on('entry', (entry: yauzl.Entry) => {
      if (entry.fileName !== targetEntryName) {
        zipFile.readEntry();
        return;
      }
      void readEntryBuffer(zipFile, entry, maxBytes).then(
        (buffer) => finish(() => resolve(buffer)),
        (error) => finish(() => reject(error)),
      );
    });
    zipFile.once('end', () => finish(() => reject(new Error(`压缩包条目不存在：${targetEntryName}`))));
    zipFile.once('error', (error) => finish(() => reject(error)));
    zipFile.readEntry();
  });
}

function resolveInside(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(root, relativePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`解压路径越过模板目录：${relativePath}`);
  }
  return resolvedPath;
}

function isIgnoredArchiveMetadata(entryPath: string): boolean {
  return entryPath === '__MACOSX/' || entryPath.startsWith('__MACOSX/');
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function validateDirectTemplateAssetReferences(
  packageRoot: string,
  manifest: ReturnType<typeof parseTemplatePackageManifest>,
): Promise<void> {
  const references = new Set<string>();
  for (const asset of manifest.assets?.index ?? []) {
    references.add(path.posix.join(manifest.assets?.root ?? '.', asset.path.replace(/\\/g, '/')));
  }
  for (const preset of manifest.characterPresets ?? []) {
    if (preset.model) references.add(preset.model);
    for (const variant of preset.variants ?? []) references.add(variant.model);
  }
  collectAssetsDirectoryReferences(manifest, references);

  for (const reference of references) {
    const portablePath = reference.replace(/\\/g, '/');
    if (
      portablePath.startsWith('asset://')
      || portablePath.startsWith('file://')
      || path.isAbsolute(portablePath)
    ) {
      throw new Error(`模板清单必须使用包内相对路径：${reference}`);
    }
    const targetPath = resolveInside(packageRoot, portablePath);
    let targetStats: fs.Stats;
    try {
      targetStats = await fs.promises.stat(targetPath);
    } catch {
      throw new Error(`模板清单引用的文件不存在：${reference}`);
    }
    if (!targetStats.isFile()) throw new Error(`模板清单引用的路径不是文件：${reference}`);
  }
}

function collectAssetsDirectoryReferences(value: unknown, references: Set<string>): void {
  if (typeof value === 'string') {
    const portablePath = value.replace(/\\/g, '/');
    if (portablePath.startsWith('assets/')) references.add(portablePath);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectAssetsDirectoryReferences(item, references);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    collectAssetsDirectoryReferences(item, references);
  }
}
