import type {
  CollaborativeAssetManifest,
  ContentHash,
} from '../../api/types/collaboration';
import type { IFileAccess } from '../io/IFileAccess';
import type { ProjectResourceService } from '../io/ProjectResourceService';
import { ProjectResourceResolutionError } from '../../api/types/project';
import {
  type CollaborativeAssetFileTransferOptions,
  type CollaborativeAssetTransferOptions,
  type CollaborativeAssetTransferProgress,
  throwIfTransferAborted,
} from './CollaborativeAssetTransfer';

export interface CollaborativeAssetDownloadClient {
  downloadAssetFile(
    projectRelativePath: string,
    options?: CollaborativeAssetFileTransferOptions,
  ): Promise<Uint8Array>;
}

export interface CollaborativeAssetDownloaderOptions {
  fileAccess: IFileAccess;
  projectResources: Pick<ProjectResourceService, 'resolveForProjectWrite'> & Partial<Pick<ProjectResourceService, 'resolveForRead'>>;
  client: CollaborativeAssetDownloadClient;
}

interface ManifestFileFingerprint {
  contentHash: ContentHash;
  sizeBytes: number;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function sha256(bytes: Uint8Array): Promise<ContentHash> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('crypto.subtle is required to verify collaborative asset hashes');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

export class CollaborativeAssetDownloader {
  private readonly fileAccess: IFileAccess;
  private readonly projectResources: Pick<ProjectResourceService, 'resolveForProjectWrite'> & Partial<Pick<ProjectResourceService, 'resolveForRead'>>;
  private readonly client: CollaborativeAssetDownloadClient;

  constructor(options: CollaborativeAssetDownloaderOptions) {
    this.fileAccess = options.fileAccess;
    this.projectResources = options.projectResources;
    this.client = options.client;
  }

  async downloadManifest(manifest: CollaborativeAssetManifest, options: CollaborativeAssetTransferOptions = {}): Promise<void> {
    if (!this.fileAccess.writeBinaryFile) {
      throw new Error('Binary file writes are required to download collaborative assets');
    }

    const seenFiles = new Map<string, ManifestFileFingerprint>();
    for (const entry of Object.values(manifest)) {
      for (const file of entry.files) {
        const previous = seenFiles.get(file.relativePath);
        if (previous) {
          if (previous.contentHash !== file.contentHash || previous.sizeBytes !== file.sizeBytes) {
            throw new Error(`Collaborative asset manifest has conflicting file metadata: ${file.relativePath}`);
          }
          continue;
        }
        seenFiles.set(file.relativePath, {
          contentHash: file.contentHash,
          sizeBytes: file.sizeBytes,
        });
      }
    }

    const files = Array.from(seenFiles.entries()).map(([relativePath, fingerprint]) => ({
      relativePath,
      ...fingerprint,
    }));
    const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
    let completedFiles = 0;
    let completedBytes = 0;
    const emitProgress = (
      currentFilePath?: string,
      currentFileBytes = 0,
      currentFileSizeBytes = 0,
    ): void => {
      const progress: CollaborativeAssetTransferProgress = {
        currentFilePath,
        currentFileBytes,
        currentFileSizeBytes,
        completedFiles,
        totalFiles: files.length,
        completedBytes,
        totalBytes,
      };
      options.onProgress?.(progress);
    };

    emitProgress();
    for (const file of files) {
      throwIfTransferAborted(options.signal);
      emitProgress(file.relativePath, 0, file.sizeBytes);
      const targetPath = await this.projectResources.resolveForProjectWrite(file.relativePath);
      const readablePath = await this.resolveForRead(file.relativePath, targetPath);
      if (await this.hasMatchingLocalFile(readablePath, file.contentHash, file.sizeBytes)) {
        if (normalizeAbsolutePath(readablePath) !== normalizeAbsolutePath(targetPath)) {
          await this.fileAccess.ensureDir(await this.fileAccess.dirname(targetPath));
          await this.fileAccess.copyFile(readablePath, targetPath);
        }
        emitProgress(file.relativePath, file.sizeBytes, file.sizeBytes);
        completedFiles += 1;
        completedBytes += file.sizeBytes;
        emitProgress(file.relativePath, file.sizeBytes, file.sizeBytes);
        continue;
      }

      if (await this.hasMatchingLocalFile(targetPath, file.contentHash, file.sizeBytes)) {
        emitProgress(file.relativePath, file.sizeBytes, file.sizeBytes);
        completedFiles += 1;
        completedBytes += file.sizeBytes;
        emitProgress(file.relativePath, file.sizeBytes, file.sizeBytes);
        continue;
      }

      throwIfTransferAborted(options.signal);
      const transferOptions: CollaborativeAssetFileTransferOptions = {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress
          ? {
            totalBytes: file.sizeBytes,
            onProgress: (transfer: { loadedBytes: number; totalBytes: number }) => {
              emitProgress(
                file.relativePath,
                Math.min(file.sizeBytes, transfer.loadedBytes),
                file.sizeBytes,
              );
            },
          }
          : {}),
      };
      const bytes = Object.keys(transferOptions).length > 0
        ? await this.client.downloadAssetFile(file.relativePath, transferOptions)
        : await this.client.downloadAssetFile(file.relativePath);
      if (bytes.byteLength !== file.sizeBytes) {
        throw new Error(`Downloaded collaborative asset size mismatch: ${file.relativePath}`);
      }

      const actualHash = await sha256(bytes);
      if (actualHash !== file.contentHash) {
        throw new Error(`Downloaded collaborative asset hash mismatch: ${file.relativePath}`);
      }

      throwIfTransferAborted(options.signal);
      await this.fileAccess.ensureDir(await this.fileAccess.dirname(targetPath));
      await this.fileAccess.writeBinaryFile(targetPath, toArrayBuffer(bytes));
      emitProgress(file.relativePath, file.sizeBytes, file.sizeBytes);
      completedFiles += 1;
      completedBytes += file.sizeBytes;
      emitProgress(file.relativePath, file.sizeBytes, file.sizeBytes);
    }
  }

  private async resolveForRead(relativePath: string, fallbackPath: string): Promise<string> {
    try {
      return await this.projectResources.resolveForRead?.(relativePath) ?? fallbackPath;
    } catch (error) {
      // A missing local copy is expected when joining a room. Continue with
      // the project destination so the server download can materialize it.
      if (error instanceof ProjectResourceResolutionError
        && error.resolution.status === 'project-asset-missing') {
        return fallbackPath;
      }
      throw error;
    }
  }

  private async hasMatchingLocalFile(
    path: string,
    expectedHash: ContentHash,
    expectedSizeBytes: number,
  ): Promise<boolean> {
    if (!this.fileAccess.readBinaryFile) return false;
    if (!(await this.fileAccess.exists(path))) return false;

    const { data } = await this.fileAccess.readBinaryFile(path);
    if (data.byteLength !== expectedSizeBytes) return false;
    return (await sha256(new Uint8Array(data))) === expectedHash;
  }
}

function normalizeAbsolutePath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
