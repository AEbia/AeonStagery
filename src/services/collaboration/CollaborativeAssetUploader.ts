import type {
  CollaborativeAssetFileEntry,
  CollaborativeAssetManifest,
} from '../../api/types/collaboration';
import type { IFileAccess } from '../io/IFileAccess';
import type { ProjectResourceService } from '../io/ProjectResourceService';
import {
  type CollaborativeAssetFileTransferOptions,
  type CollaborativeAssetTransferOptions,
  type CollaborativeAssetTransferProgress,
  throwIfTransferAborted,
} from './CollaborativeAssetTransfer';

export interface CollaborativeAssetUploadClient {
  uploadAssetFile(
    projectRelativePath: string,
    bytes: Uint8Array,
    options?: CollaborativeAssetFileTransferOptions,
  ): Promise<void>;
}

export interface CollaborativeAssetUploaderOptions {
  fileAccess: IFileAccess;
  projectResources: Pick<ProjectResourceService, 'resolveForRead'>;
  client: CollaborativeAssetUploadClient;
}

const textEncoder = new TextEncoder();

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('crypto.subtle is required to verify collaborative asset uploads');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

function assertCompatibleManifestFile(
  previous: CollaborativeAssetFileEntry | undefined,
  next: CollaborativeAssetFileEntry,
): void {
  if (!previous) return;
  if (previous.contentHash === next.contentHash && previous.sizeBytes === next.sizeBytes) return;

  throw new Error(
    `Collaborative asset path conflict: "${next.relativePath}" is listed with multiple fingerprints `
    + `(${previous.contentHash}/${previous.sizeBytes} bytes and ${next.contentHash}/${next.sizeBytes} bytes). `
    + 'Make the asset paths unique before hosting collaboration.',
  );
}

export class CollaborativeAssetUploader {
  private readonly fileAccess: IFileAccess;
  private readonly projectResources: Pick<ProjectResourceService, 'resolveForRead'>;
  private readonly client: CollaborativeAssetUploadClient;
  private readonly uploadedFileHashes = new Map<string, string>();

  constructor(options: CollaborativeAssetUploaderOptions) {
    this.fileAccess = options.fileAccess;
    this.projectResources = options.projectResources;
    this.client = options.client;
  }

  async uploadManifest(manifest: CollaborativeAssetManifest, options: CollaborativeAssetTransferOptions = {}): Promise<void> {
    const manifestFiles = new Map<string, CollaborativeAssetFileEntry>();
    const uploaded = new Set<string>();

    for (const entry of Object.values(manifest)) {
      for (const file of entry.files) {
        assertCompatibleManifestFile(manifestFiles.get(file.relativePath), file);
        manifestFiles.set(file.relativePath, file);
      }
    }

    const files = Array.from(manifestFiles.values());
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
      if (uploaded.has(file.relativePath)) continue;
      uploaded.add(file.relativePath);
      emitProgress(file.relativePath, 0, file.sizeBytes);
      if (this.uploadedFileHashes.get(file.relativePath) !== file.contentHash) {
        const bytes = await this.readAssetBytes(file.relativePath);
        throwIfTransferAborted(options.signal);
        await this.assertFileMatchesManifest(file, bytes);
        throwIfTransferAborted(options.signal);
        const transferOptions: CollaborativeAssetFileTransferOptions = {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.onProgress
            ? {
              totalBytes: bytes.byteLength,
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
        if (Object.keys(transferOptions).length > 0) {
          await this.client.uploadAssetFile(file.relativePath, bytes, transferOptions);
        } else {
          await this.client.uploadAssetFile(file.relativePath, bytes);
        }
        this.uploadedFileHashes.set(file.relativePath, file.contentHash);
      }
      emitProgress(file.relativePath, file.sizeBytes, file.sizeBytes);
      completedFiles += 1;
      completedBytes += file.sizeBytes;
      emitProgress(file.relativePath, file.sizeBytes, file.sizeBytes);
    }
  }

  private async readAssetBytes(projectRelativePath: string): Promise<Uint8Array> {
    const absolutePath = await this.projectResources.resolveForRead(projectRelativePath);
    if (this.fileAccess.readBinaryFile) {
      const { data } = await this.fileAccess.readBinaryFile(absolutePath);
      return new Uint8Array(data);
    }
    const { data } = await this.fileAccess.readFile(absolutePath);
    return textEncoder.encode(data);
  }

  private async assertFileMatchesManifest(file: CollaborativeAssetFileEntry, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength !== file.sizeBytes) {
      throw new Error(
        `Collaborative asset upload mismatch: "${file.relativePath}" has size ${bytes.byteLength}, `
        + `expected ${file.sizeBytes}.`,
      );
    }

    const actualHash = await sha256(bytes);
    if (actualHash !== file.contentHash) {
      throw new Error(
        `Collaborative asset upload mismatch: "${file.relativePath}" has hash ${actualHash}, `
        + `expected ${file.contentHash}.`,
      );
    }
  }
}
