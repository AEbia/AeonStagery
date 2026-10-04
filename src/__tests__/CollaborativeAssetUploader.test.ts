import { describe, expect, it, vi } from 'vitest';
import type { CollaborativeAssetManifest } from '../api/types/collaboration';
import { CollaborativeAssetUploader } from '../services/collaboration/CollaborativeAssetUploader';
import type { IFileAccess } from '../services/io/IFileAccess';

class FakeBinaryFileAccess implements Partial<IFileAccess> {
  constructor(private files: Record<string, string>) {}

  async readFile(path: string): Promise<{ data: string; path: string }> {
    const data = this.files[path];
    if (data === undefined) throw new Error(`Missing test file: ${path}`);
    return { data, path };
  }

  async readBinaryFile(path: string): Promise<{ data: ArrayBuffer; path: string }> {
    const { data } = await this.readFile(path);
    const bytes = new TextEncoder().encode(data);
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return { data: buffer, path };
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function hashText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

describe('CollaborativeAssetUploader', () => {
  it('uploads each manifest file once using project-relative paths', async () => {
    const bgHash = await hashText('bg');
    const manifest: CollaborativeAssetManifest = {
      'background/bg.png': {
        assetId: 'asset_bg',
        kind: 'background-image',
        importKind: 'background',
        projectRelativePath: 'background/bg.png',
        entrypointPath: 'background/bg.png',
        contentHash: bgHash,
        files: [
          { relativePath: 'background/bg.png', contentHash: bgHash, sizeBytes: 2 },
        ],
        createdAt: '2026-06-06T00:00:00.000Z',
      },
      'background/bg-copy.png': {
        assetId: 'asset_bg_copy',
        kind: 'background-image',
        importKind: 'background',
        projectRelativePath: 'background/bg-copy.png',
        entrypointPath: 'background/bg-copy.png',
        contentHash: bgHash,
        files: [
          { relativePath: 'background/bg.png', contentHash: bgHash, sizeBytes: 2 },
        ],
        createdAt: '2026-06-06T00:00:00.000Z',
      },
    };
    const client = { uploadAssetFile: vi.fn(async () => undefined) };
    const uploader = new CollaborativeAssetUploader({
      fileAccess: new FakeBinaryFileAccess({ 'resolved/background/bg.png': 'bg' }) as unknown as IFileAccess,
      projectResources: {
        resolveForRead: async (relativePath: string) => `resolved/${relativePath}`,
      },
      client,
    });

    await uploader.uploadManifest(manifest);

    expect(client.uploadAssetFile).toHaveBeenCalledTimes(1);
    expect(client.uploadAssetFile).toHaveBeenCalledWith('background/bg.png', new TextEncoder().encode('bg'));
  });

  it('rejects manifest files that share a path with different fingerprints', async () => {
    const bgHash = await hashText('bg');
    const changedHash = await hashText('changed');
    const manifest: CollaborativeAssetManifest = {
      'background/bg.png': {
        assetId: 'asset_bg',
        kind: 'background-image',
        importKind: 'background',
        projectRelativePath: 'background/bg.png',
        entrypointPath: 'background/bg.png',
        contentHash: bgHash,
        files: [
          { relativePath: 'background/shared.png', contentHash: bgHash, sizeBytes: 2 },
        ],
        createdAt: '2026-06-06T00:00:00.000Z',
      },
      'background/other.png': {
        assetId: 'asset_other',
        kind: 'background-image',
        importKind: 'background',
        projectRelativePath: 'background/other.png',
        entrypointPath: 'background/other.png',
        contentHash: changedHash,
        files: [
          { relativePath: 'background/shared.png', contentHash: changedHash, sizeBytes: 7 },
        ],
        createdAt: '2026-06-06T00:00:00.000Z',
      },
    };
    const client = { uploadAssetFile: vi.fn(async () => undefined) };
    const uploader = new CollaborativeAssetUploader({
      fileAccess: new FakeBinaryFileAccess({ 'resolved/background/shared.png': 'bg' }) as unknown as IFileAccess,
      projectResources: {
        resolveForRead: async (relativePath: string) => `resolved/${relativePath}`,
      },
      client,
    });

    await expect(uploader.uploadManifest(manifest)).rejects.toThrow(
      'Collaborative asset path conflict: "background/shared.png"',
    );
    expect(client.uploadAssetFile).not.toHaveBeenCalled();
  });

  it('rejects local bytes that do not match the manifest before uploading', async () => {
    const expectedHash = await hashText('expected');
    const manifest: CollaborativeAssetManifest = {
      'background/bg.png': {
        assetId: 'asset_bg',
        kind: 'background-image',
        importKind: 'background',
        projectRelativePath: 'background/bg.png',
        entrypointPath: 'background/bg.png',
        contentHash: expectedHash,
        files: [
          { relativePath: 'background/bg.png', contentHash: expectedHash, sizeBytes: 8 },
        ],
        createdAt: '2026-06-06T00:00:00.000Z',
      },
    };
    const client = { uploadAssetFile: vi.fn(async () => undefined) };
    const uploader = new CollaborativeAssetUploader({
      fileAccess: new FakeBinaryFileAccess({ 'resolved/background/bg.png': 'actual' }) as unknown as IFileAccess,
      projectResources: {
        resolveForRead: async (relativePath: string) => `resolved/${relativePath}`,
      },
      client,
    });

    await expect(uploader.uploadManifest(manifest)).rejects.toThrow(
      'Collaborative asset upload mismatch: "background/bg.png" has size 6, expected 8.',
    );
    expect(client.uploadAssetFile).not.toHaveBeenCalled();
  });

  it('reports upload progress for manifest files', async () => {
    const bgHash = await hashText('bg');
    const manifest: CollaborativeAssetManifest = {
      'background/bg.png': {
        assetId: 'asset_bg',
        kind: 'background-image',
        importKind: 'background',
        projectRelativePath: 'background/bg.png',
        entrypointPath: 'background/bg.png',
        contentHash: bgHash,
        files: [
          { relativePath: 'background/bg.png', contentHash: bgHash, sizeBytes: 2 },
        ],
        createdAt: '2026-06-06T00:00:00.000Z',
      },
    };
    const client = { uploadAssetFile: vi.fn(async () => undefined) };
    const onProgress = vi.fn();
    const uploader = new CollaborativeAssetUploader({
      fileAccess: new FakeBinaryFileAccess({ 'resolved/background/bg.png': 'bg' }) as unknown as IFileAccess,
      projectResources: {
        resolveForRead: async (relativePath: string) => `resolved/${relativePath}`,
      },
      client,
    });

    await uploader.uploadManifest(manifest, { onProgress });

    expect(onProgress).toHaveBeenLastCalledWith({
      currentFilePath: 'background/bg.png',
      currentFileBytes: 2,
      currentFileSizeBytes: 2,
      completedFiles: 1,
      totalFiles: 1,
      completedBytes: 2,
      totalBytes: 2,
    });
  });

  it('honors cancellation before uploading the next manifest file', async () => {
    const bgHash = await hashText('bg');
    const manifest: CollaborativeAssetManifest = {
      'background/bg.png': {
        assetId: 'asset_bg',
        kind: 'background-image',
        importKind: 'background',
        projectRelativePath: 'background/bg.png',
        entrypointPath: 'background/bg.png',
        contentHash: bgHash,
        files: [
          { relativePath: 'background/bg.png', contentHash: bgHash, sizeBytes: 2 },
        ],
        createdAt: '2026-06-06T00:00:00.000Z',
      },
    };
    const client = { uploadAssetFile: vi.fn(async () => undefined) };
    const controller = new AbortController();
    const uploader = new CollaborativeAssetUploader({
      fileAccess: new FakeBinaryFileAccess({ 'resolved/background/bg.png': 'bg' }) as unknown as IFileAccess,
      projectResources: {
        resolveForRead: async (relativePath: string) => `resolved/${relativePath}`,
      },
      client,
    });

    await expect(uploader.uploadManifest(manifest, {
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.currentFilePath === 'background/bg.png') controller.abort();
      },
    })).rejects.toThrow('已取消协作资源传输');

    expect(client.uploadAssetFile).not.toHaveBeenCalled();
  });
});
