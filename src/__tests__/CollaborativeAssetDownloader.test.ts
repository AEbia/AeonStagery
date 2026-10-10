import { describe, expect, it, vi } from 'vitest';
import type { CollaborativeAssetManifest } from '../api/types/collaboration';
import { CollaborativeAssetDownloader } from '../services/collaboration/CollaborativeAssetDownloader';
import type { IFileAccess } from '../services/io/IFileAccess';
import { ProjectPathResolver } from '../services/io/ProjectPathResolver';
import { ProjectResourceService } from '../services/io/ProjectResourceService';
import { DEFAULT_PROJECT_ASSET_ROOTS, ProjectResourceResolutionError } from '../api/types/project';

const encoder = new TextEncoder();

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function hashText(value: string): Promise<string> {
  const bytes = encoder.encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

class FakeBinaryFileAccess implements Partial<IFileAccess> {
  readonly writes = new Map<string, Uint8Array>();
  readonly ensuredDirs: string[] = [];
  readonly copies: Array<{ sourcePath: string; destPath: string }> = [];

  constructor(private readonly existingFiles: Record<string, string> = {}) {}

  async readBinaryFile(path: string): Promise<{ data: ArrayBuffer; path: string }> {
    const data = this.existingFiles[path];
    if (data === undefined) throw new Error(`Missing test file: ${path}`);
    return { data: toArrayBuffer(encoder.encode(data)), path };
  }

  async writeBinaryFile(path: string, data: ArrayBuffer): Promise<void> {
    this.writes.set(path, new Uint8Array(data));
  }

  async copyFile(sourcePath: string, destPath: string): Promise<void> {
    this.copies.push({ sourcePath, destPath });
    const data = this.existingFiles[sourcePath];
    if (data !== undefined) {
      this.existingFiles[destPath] = data;
    }
  }

  async ensureDir(path: string): Promise<void> {
    this.ensuredDirs.push(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.existingFiles[path] !== undefined;
  }

  async dirname(path: string): Promise<string> {
    return path.split('/').slice(0, -1).join('/') || '.';
  }
}

function makeManifest(contentHash: string): CollaborativeAssetManifest {
  return {
    'background/bg.png': {
      assetId: 'asset_bg',
      kind: 'background-image',
      importKind: 'background',
      projectRelativePath: 'background/bg.png',
      entrypointPath: 'background/bg.png',
      contentHash,
      files: [
        { relativePath: 'background/bg.png', contentHash, sizeBytes: 2 },
      ],
      createdAt: '2026-06-06T00:00:00.000Z',
    },
  };
}

function makeManifestWithFile(
  manifestKey: string,
  filePath: string,
  contentHash: string,
  sizeBytes: number,
): CollaborativeAssetManifest {
  return {
    [manifestKey]: {
      assetId: `asset:${manifestKey}`,
      kind: 'background-image',
      importKind: 'background',
      projectRelativePath: manifestKey,
      entrypointPath: filePath,
      contentHash,
      files: [
        { relativePath: filePath, contentHash, sizeBytes },
      ],
      createdAt: '2026-06-06T00:00:00.000Z',
    },
  };
}

describe('CollaborativeAssetDownloader', () => {
  it.each(['background/1.png', '.aeonstagery/mounts/game/background/1.png'])(
    'downloads a server asset absent from every local readable root: %s',
    async (relativePath) => {
      const contentHash = await hashText('bg');
      const fileAccess = new FakeBinaryFileAccess();
      const client = { downloadAssetFile: vi.fn(async () => encoder.encode('bg')) };
      const projectResources = new ProjectResourceService(
        fileAccess as unknown as IFileAccess,
        new ProjectPathResolver(null),
      );
      projectResources.setCurrentProject({
        rootPath: 'D:/project',
        projectFilePath: 'D:/project/project.json',
        metadata: {
          projectId: 'demo',
          name: 'Demo',
          projectVersion: 2,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          defaultSceneId: 'main',
          scenes: [{ id: 'main', name: 'Main', path: 'project/main.scene.json' }],
          assetRoots: { ...DEFAULT_PROJECT_ASSET_ROOTS },
        },
      });
      const downloader = new CollaborativeAssetDownloader({
        fileAccess: fileAccess as unknown as IFileAccess,
        projectResources,
        client,
      });

      await downloader.downloadManifest(makeManifestWithFile(relativePath, relativePath, contentHash, 2));

      expect(client.downloadAssetFile).toHaveBeenCalledWith(relativePath);
      expect(fileAccess.writes.get(`D:/project/${relativePath}`)).toEqual(encoder.encode('bg'));
    },
  );

  it.each([
    new Error('Filesystem permission denied'),
    new ProjectResourceResolutionError({
      status: 'invalid-reference', reference: 'invalid', reason: 'Invalid asset path',
    }),
  ])('preserves local resolution failures unrelated to missing project files: %s', async (error) => {
    const contentHash = await hashText('bg');
    const fileAccess = new FakeBinaryFileAccess();
    const client = { downloadAssetFile: vi.fn() };
    const downloader = new CollaborativeAssetDownloader({
      fileAccess: fileAccess as unknown as IFileAccess,
      projectResources: {
        resolveForProjectWrite: async (relativePath) => `D:/project/${relativePath}`,
        resolveForRead: async () => { throw error; },
      },
      client,
    });

    await expect(downloader.downloadManifest(makeManifest(contentHash))).rejects.toBe(error);
    expect(client.downloadAssetFile).not.toHaveBeenCalled();
    expect(fileAccess.writes.size).toBe(0);
  });

  it('downloads missing manifest files into the active project', async () => {
    const contentHash = await hashText('bg');
    const fileAccess = new FakeBinaryFileAccess();
    const client = { downloadAssetFile: vi.fn(async () => encoder.encode('bg')) };
    const downloader = new CollaborativeAssetDownloader({
      fileAccess: fileAccess as unknown as IFileAccess,
      projectResources: {
        resolveForProjectWrite: async (relativePath: string) => `D:/project/${relativePath}`,
      },
      client,
    });

    await downloader.downloadManifest(makeManifest(contentHash));

    expect(client.downloadAssetFile).toHaveBeenCalledWith('background/bg.png');
    expect(fileAccess.ensuredDirs).toEqual(['D:/project/background']);
    expect(fileAccess.writes.get('D:/project/background/bg.png')).toEqual(encoder.encode('bg'));
  });

  it('skips local files that already match the manifest hash', async () => {
    const contentHash = await hashText('bg');
    const fileAccess = new FakeBinaryFileAccess({ 'D:/project/background/bg.png': 'bg' });
    const client = { downloadAssetFile: vi.fn(async () => encoder.encode('bg')) };
    const downloader = new CollaborativeAssetDownloader({
      fileAccess: fileAccess as unknown as IFileAccess,
      projectResources: {
        resolveForProjectWrite: async (relativePath: string) => `D:/project/${relativePath}`,
      },
      client,
    });

    await downloader.downloadManifest(makeManifest(contentHash));

    expect(client.downloadAssetFile).not.toHaveBeenCalled();
    expect(fileAccess.writes.size).toBe(0);
  });

  it('reuses matching readable library files instead of downloading them again', async () => {
    const contentHash = await hashText('bg');
    const fileAccess = new FakeBinaryFileAccess({ 'E:/library/background/bg.png': 'bg' });
    const client = { downloadAssetFile: vi.fn(async () => encoder.encode('bg')) };
    const downloader = new CollaborativeAssetDownloader({
      fileAccess: fileAccess as unknown as IFileAccess,
      projectResources: {
        resolveForRead: async (relativePath: string) => `E:/library/${relativePath}`,
        resolveForProjectWrite: async (relativePath: string) => `D:/project/${relativePath}`,
      },
      client,
    });

    await downloader.downloadManifest(makeManifest(contentHash));

    expect(client.downloadAssetFile).not.toHaveBeenCalled();
    expect(fileAccess.copies).toEqual([{
      sourcePath: 'E:/library/background/bg.png',
      destPath: 'D:/project/background/bg.png',
    }]);
    expect(fileAccess.writes.size).toBe(0);
  });

  it('rejects downloaded files whose size does not match the manifest', async () => {
    const contentHash = await hashText('bg');
    const fileAccess = new FakeBinaryFileAccess();
    const client = { downloadAssetFile: vi.fn(async () => encoder.encode('bg')) };
    const downloader = new CollaborativeAssetDownloader({
      fileAccess: fileAccess as unknown as IFileAccess,
      projectResources: {
        resolveForProjectWrite: async (relativePath: string) => `D:/project/${relativePath}`,
      },
      client,
    });

    await expect(downloader.downloadManifest(makeManifestWithFile(
      'background/bg.png',
      'background/bg.png',
      contentHash,
      999,
    ))).rejects.toThrow('Downloaded collaborative asset size mismatch: background/bg.png');
    expect(fileAccess.writes.size).toBe(0);
  });

  it('does not treat a same-hash local file as ready when its manifest size differs', async () => {
    const contentHash = await hashText('bg');
    const fileAccess = new FakeBinaryFileAccess({ 'D:/project/background/bg.png': 'bg' });
    const client = { downloadAssetFile: vi.fn(async () => encoder.encode('bg')) };
    const downloader = new CollaborativeAssetDownloader({
      fileAccess: fileAccess as unknown as IFileAccess,
      projectResources: {
        resolveForProjectWrite: async (relativePath: string) => `D:/project/${relativePath}`,
      },
      client,
    });

    await expect(downloader.downloadManifest(makeManifestWithFile(
      'background/bg.png',
      'background/bg.png',
      contentHash,
      999,
    ))).rejects.toThrow('Downloaded collaborative asset size mismatch: background/bg.png');
    expect(client.downloadAssetFile).toHaveBeenCalledWith('background/bg.png');
    expect(fileAccess.writes.size).toBe(0);
  });

  it('rejects manifests with conflicting metadata for the same file path', async () => {
    const bgHash = await hashText('bg');
    const otherHash = await hashText('other');
    const fileAccess = new FakeBinaryFileAccess();
    const client = { downloadAssetFile: vi.fn(async () => encoder.encode('bg')) };
    const downloader = new CollaborativeAssetDownloader({
      fileAccess: fileAccess as unknown as IFileAccess,
      projectResources: {
        resolveForProjectWrite: async (relativePath: string) => `D:/project/${relativePath}`,
      },
      client,
    });

    await expect(downloader.downloadManifest({
      ...makeManifestWithFile('background/bg.png', 'shared/file.bin', bgHash, 2),
      ...makeManifestWithFile('background/other.png', 'shared/file.bin', otherHash, 5),
    })).rejects.toThrow('Collaborative asset manifest has conflicting file metadata: shared/file.bin');
  });

  it('reports download progress for manifest files', async () => {
    const contentHash = await hashText('bg');
    const fileAccess = new FakeBinaryFileAccess();
    const client = { downloadAssetFile: vi.fn(async () => encoder.encode('bg')) };
    const onProgress = vi.fn();
    const downloader = new CollaborativeAssetDownloader({
      fileAccess: fileAccess as unknown as IFileAccess,
      projectResources: {
        resolveForProjectWrite: async (relativePath: string) => `D:/project/${relativePath}`,
      },
      client,
    });

    await downloader.downloadManifest(makeManifest(contentHash), { onProgress });

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

  it('honors cancellation before downloading a manifest file', async () => {
    const contentHash = await hashText('bg');
    const fileAccess = new FakeBinaryFileAccess();
    const client = { downloadAssetFile: vi.fn(async () => encoder.encode('bg')) };
    const controller = new AbortController();
    const downloader = new CollaborativeAssetDownloader({
      fileAccess: fileAccess as unknown as IFileAccess,
      projectResources: {
        resolveForProjectWrite: async (relativePath: string) => `D:/project/${relativePath}`,
      },
      client,
    });

    await expect(downloader.downloadManifest(makeManifest(contentHash), {
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.currentFilePath === 'background/bg.png') controller.abort();
      },
    })).rejects.toThrow('已取消协作资源传输');

    expect(client.downloadAssetFile).not.toHaveBeenCalled();
    expect(fileAccess.writes.size).toBe(0);
  });
});
