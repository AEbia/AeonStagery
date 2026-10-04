import { describe, expect, it, vi } from 'vitest';
import type { CollaborativeAssetManifest } from '../api/types/collaboration';
import { CollaborativeAssetReadinessGate } from '../services/collaboration/CollaborativeAssetReadinessGate';
import type { IFileAccess } from '../services/io/IFileAccess';
import type { LooseTimelineScene as SceneScript } from './fixtures/TimelineTestTypes';
import type { HistoricalSceneDocumentV4, SceneDocumentV5 } from '../api/types/semantic-scene';

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

class FakeFileAccess implements Partial<IFileAccess> {
  readonly copies: Array<{ sourcePath: string; destPath: string }> = [];
  readonly ensuredDirs: string[] = [];

  constructor(private readonly files: Record<string, string> = {}) {}

  async exists(path: string): Promise<boolean> {
    return this.files[path] !== undefined;
  }

  async readFile(path: string): Promise<{ data: string; path: string }> {
    const data = this.files[path];
    if (data === undefined) throw new Error(`Missing file: ${path}`);
    return { data, path };
  }

  async readBinaryFile(path: string): Promise<{ data: ArrayBuffer; path: string }> {
    const { data } = await this.readFile(path);
    return { data: toArrayBuffer(encoder.encode(data)), path };
  }

  async ensureDir(path: string): Promise<void> {
    this.ensuredDirs.push(path);
  }

  async dirname(path: string): Promise<string> {
    return path.split('/').slice(0, -1).join('/') || '.';
  }

  async copyFile(sourcePath: string, destPath: string): Promise<void> {
    this.copies.push({ sourcePath, destPath });
    this.files[destPath] = this.files[sourcePath];
  }
}

function makeManifest(contentHash: string, sizeBytes = 2): CollaborativeAssetManifest {
  return {
    'background/bg.png': {
      assetId: `background-image:${contentHash}`,
      kind: 'background-image',
      importKind: 'background',
      projectRelativePath: 'background/bg.png',
      entrypointPath: 'background/bg.png',
      contentHash,
      files: [
        { relativePath: 'background/bg.png', contentHash, sizeBytes },
      ],
      createdAt: '2026-06-21T00:00:00.000Z',
    },
  };
}

describe('CollaborativeAssetReadinessGate', () => {
  const scene: SceneScript = {
    sceneId: 'scene_1',
    meta: { title: 'Readiness Scene' },
    timeline: [],
  };

  const document: HistoricalSceneDocumentV4 = {
    schemaVersion: 4,
    sceneId: 'scene_v2',
    meta: { title: 'Readiness Scene V2' },
    statements: [],
  };

  it('plans, confirms, copies, uploads, and verifies local publish readiness', async () => {
    const contentHash = await hashText('bg');
    const manifest = makeManifest(contentHash);
    const fileAccess = new FakeFileAccess({ 'E:/library/background/bg.png': 'bg' });
    const uploader = { uploadManifest: vi.fn(async () => undefined) };
    const events: string[] = [];
    const gate = new CollaborativeAssetReadinessGate({
      fileAccess: fileAccess as unknown as IFileAccess,
      projectResources: {
        resolveForRead: async (relativePath: string) => `E:/library/${relativePath}`,
        resolveForProjectWrite: async (relativePath: string) => `D:/project/${relativePath}`,
      },
      uploader,
      downloader: { downloadManifest: vi.fn() },
      confirmAgreement: vi.fn(async () => undefined),
      onHandshake: (event) => events.push(`${event.direction}:${event.status}:${event.proposal?.items[0]?.operation ?? 'none'}`),
    });

    await expect(gate.ensureLocalPublishReadiness(manifest, {
      reason: 'initial-host',
      title: 'Confirm',
      message: 'Confirm assets',
    })).resolves.toEqual(expect.objectContaining({
      signature: expect.any(String),
      reusedVerifiedSignature: false,
    }));

    expect(fileAccess.copies).toEqual([{
      sourcePath: 'E:/library/background/bg.png',
      destPath: 'D:/project/background/bg.png',
    }]);
    expect(uploader.uploadManifest).toHaveBeenCalledWith(manifest, expect.objectContaining({
      signal: expect.any(AbortSignal),
      onProgress: expect.any(Function),
    }));
    expect(events).toContain('local:confirming:copy-and-upload');
    expect(events).toContain('local:uploading:copy-and-upload');
    expect(events).toContain('local:verified:copy-and-upload');
  });

  it('blocks local publish readiness when a required local file is missing', async () => {
    const manifest = makeManifest(await hashText('bg'));
    const uploader = { uploadManifest: vi.fn(async () => undefined) };
    const gate = new CollaborativeAssetReadinessGate({
      fileAccess: new FakeFileAccess() as unknown as IFileAccess,
      projectResources: {
        resolveForRead: async (relativePath: string) => `D:/project/${relativePath}`,
        resolveForProjectWrite: async (relativePath: string) => `D:/project/${relativePath}`,
      },
      uploader,
      downloader: { downloadManifest: vi.fn() },
      confirmAgreement: vi.fn(async () => undefined),
    });

    await expect(gate.ensureLocalPublishReadiness(manifest, {
      reason: 'local-asset-changed',
      title: 'Confirm',
      message: 'Confirm assets',
    })).rejects.toThrow('资源约定包含阻塞问题');
    expect(uploader.uploadManifest).not.toHaveBeenCalled();
  });

  it('reuses remote project files that already match the manifest before applying state', async () => {
    const contentHash = await hashText('bg');
    const manifest = makeManifest(contentHash);
    const downloader = { downloadManifest: vi.fn(async () => undefined) };
    const events: string[] = [];
    const gate = new CollaborativeAssetReadinessGate({
      fileAccess: new FakeFileAccess({ 'D:/project/background/bg.png': 'bg' }) as unknown as IFileAccess,
      projectResources: {
        resolveForRead: async (relativePath: string) => `D:/project/${relativePath}`,
        resolveForProjectWrite: async (relativePath: string) => `D:/project/${relativePath}`,
      },
      uploader: { uploadManifest: vi.fn() },
      downloader,
      onHandshake: (event) => events.push(`${event.direction}:${event.status}:${event.proposal?.items[0]?.operation ?? 'none'}`),
    });

    await expect(gate.ensureRemoteApplyReadiness(manifest, {
      reason: 'join-room',
      title: 'Confirm',
      message: 'Confirm assets',
    })).resolves.toEqual(expect.objectContaining({
      reusedVerifiedSignature: false,
    }));

    expect(downloader.downloadManifest).not.toHaveBeenCalled();
    expect(events).toEqual(['remote:verified:reuse']);
  });

  it('downloads remote files before reporting readiness', async () => {
    const contentHash = await hashText('bg');
    const manifest = makeManifest(contentHash);
    const downloader = { downloadManifest: vi.fn(async () => undefined) };
    const gate = new CollaborativeAssetReadinessGate({
      fileAccess: new FakeFileAccess() as unknown as IFileAccess,
      projectResources: {
        resolveForRead: async (relativePath: string) => `D:/project/${relativePath}`,
        resolveForProjectWrite: async (relativePath: string) => `D:/project/${relativePath}`,
      },
      uploader: { uploadManifest: vi.fn() },
      downloader,
    });

    await gate.ensureRemoteApplyReadiness(manifest, {
      reason: 'join-room',
      title: 'Confirm',
      message: 'Confirm assets',
    });

    expect(downloader.downloadManifest).toHaveBeenCalledWith(manifest, expect.objectContaining({
      signal: expect.any(AbortSignal),
      onProgress: expect.any(Function),
    }));
  });

  it('uses an already accepted remote proposal without showing a second resource agreement', async () => {
    const contentHash = await hashText('bg');
    const manifest = makeManifest(contentHash);
    const downloader = { downloadManifest: vi.fn(async () => undefined) };
    const confirmAgreement = vi.fn(async () => {
      throw new Error('should not prompt twice');
    });
    const gate = new CollaborativeAssetReadinessGate({
      fileAccess: new FakeFileAccess({ 'D:/project/background/bg.png': 'different-content' }) as unknown as IFileAccess,
      projectResources: {
        resolveForRead: async (relativePath: string) => `D:/project/${relativePath}`,
        resolveForProjectWrite: async (relativePath: string) => `D:/project/${relativePath}`,
      },
      uploader: { uploadManifest: vi.fn() },
      downloader,
      confirmAgreement,
    });
    const acceptedProposal = await gate.buildAgreementProposal(manifest, 'remote', 'join-room');

    await expect(gate.ensureRemoteApplyReadiness(manifest, {
      reason: 'join-room',
      title: 'Confirm',
      message: 'Confirm assets',
      acceptedProposal,
    })).resolves.toEqual(expect.objectContaining({
      reusedVerifiedSignature: false,
    }));

    expect(acceptedProposal.items[0].operation).toBe('replace');
    expect(confirmAgreement).not.toHaveBeenCalled();
    expect(downloader.downloadManifest).toHaveBeenCalledTimes(1);
  });

  it('prepares local publish by projectizing the scene and reusing an unchanged previous manifest', async () => {
    const contentHash = await hashText('bg');
    const manifest = makeManifest(contentHash);
    const manifestBuilder = { buildForScene: vi.fn(async () => manifest) };
    const uploader = { uploadManifest: vi.fn(async () => undefined) };
    const gate = new CollaborativeAssetReadinessGate({
      sceneProjectizer: {
        prepareCollaborativeAssetReferences: vi.fn(async (inputScene: SceneScript) => ({
          ...inputScene,
          sceneId: 'projectized',
        })),
      },
      manifestBuilder,
      manifestReuseChecker: {
        hasUnchangedReferences: vi.fn(async () => true),
      },
      uploader,
      downloader: { downloadManifest: vi.fn() },
    });

    await expect(gate.prepareLocalPublish({
      scene,
      previousManifest: manifest,
      reason: 'local-asset-changed',
      title: 'Confirm',
      message: 'Confirm assets',
    })).resolves.toEqual(expect.objectContaining({
      scene: expect.objectContaining({ sceneId: 'projectized' }),
      assets: manifest,
      reusedPreviousManifest: true,
    }));
    expect(manifestBuilder.buildForScene).not.toHaveBeenCalled();
    expect(uploader.uploadManifest).not.toHaveBeenCalled();
  });

  it('reuses an unchanged HistoricalSceneDocumentV4 manifest without rebuilding or uploading', async () => {
    const manifest = makeManifest(await hashText('bg'));
    const manifestBuilder = {
      buildForScene: vi.fn(),
      buildForSceneDocumentV4: vi.fn(),
    };
    const gate = new CollaborativeAssetReadinessGate({
      manifestBuilder,
      manifestReuseChecker: {
        hasUnchangedReferences: vi.fn(),
        hasUnchangedSceneDocumentV4References: vi.fn(async () => true),
      },
      uploader: { uploadManifest: vi.fn() },
      downloader: { downloadManifest: vi.fn() },
    });

    await expect(gate.prepareLocalPublishV3({
      document,
      previousManifest: manifest,
      reason: 'local-asset-changed',
      title: 'Confirm',
      message: 'Confirm assets',
    })).resolves.toEqual(expect.objectContaining({
      document,
      assets: manifest,
      reusedPreviousManifest: true,
    }));

    expect(manifestBuilder.buildForSceneDocumentV4).not.toHaveBeenCalled();
  });

  it('builds and verifies a HistoricalSceneDocumentV4 manifest when references changed', async () => {
    const contentHash = await hashText('bg');
    const manifest = makeManifest(contentHash);
    const manifestBuilder = {
      buildForScene: vi.fn(),
      buildForSceneDocumentV4: vi.fn(async () => manifest),
    };
    const uploader = { uploadManifest: vi.fn(async () => undefined) };
    const gate = new CollaborativeAssetReadinessGate({
      fileAccess: new FakeFileAccess({ 'D:/project/background/bg.png': 'bg' }) as unknown as IFileAccess,
      projectResources: {
        resolveForRead: async (relativePath: string) => `D:/project/${relativePath}`,
        resolveForProjectWrite: async (relativePath: string) => `D:/project/${relativePath}`,
      },
      manifestBuilder,
      uploader,
      downloader: { downloadManifest: vi.fn() },
      confirmAgreement: vi.fn(async () => undefined),
    });

    await expect(gate.prepareLocalPublishV3({
      document,
      previousManifest: {},
      reason: 'initial-host',
      forceAgreement: true,
      title: 'Confirm',
      message: 'Confirm assets',
    })).resolves.toEqual(expect.objectContaining({
      document,
      assets: manifest,
      reusedPreviousManifest: false,
      reusedVerifiedSignature: false,
    }));

    expect(manifestBuilder.buildForSceneDocumentV4).toHaveBeenCalledWith(document);
    expect(uploader.uploadManifest).toHaveBeenCalledTimes(1);
  });

  it('projectizes a HistoricalSceneDocumentV4 before manifest reuse checks and building', async () => {
    const projectizedDocument = {
      ...document,
      meta: { ...document.meta, title: 'Projectized' },
    };
    const manifest = makeManifest(await hashText('bg'));
    const manifestBuilder = {
      buildForScene: vi.fn(),
      buildForSceneDocumentV4: vi.fn(async () => manifest),
    };
    const reuseChecker = {
      hasUnchangedReferences: vi.fn(),
      hasUnchangedSceneDocumentV4References: vi.fn(async () => false),
    };
    const gate = new CollaborativeAssetReadinessGate({
      fileAccess: new FakeFileAccess({ 'D:/project/background/bg.png': 'bg' }) as unknown as IFileAccess,
      projectResources: {
        resolveForRead: async (relativePath: string) => `D:/project/${relativePath}`,
        resolveForProjectWrite: async (relativePath: string) => `D:/project/${relativePath}`,
      },
      sceneProjectizer: {
        prepareCollaborativeAssetReferences: vi.fn(async (scene) => scene),
        prepareCollaborativeV2SceneDocumentAssetReferences: vi.fn(async () => projectizedDocument),
      },
      manifestBuilder,
      manifestReuseChecker: reuseChecker,
      uploader: { uploadManifest: vi.fn(async () => undefined) },
      downloader: { downloadManifest: vi.fn() },
      confirmAgreement: vi.fn(async () => undefined),
    });

    const result = await gate.prepareLocalPublishV3({
      document,
      previousManifest: {},
      reason: 'initial-host',
      forceAgreement: true,
      title: 'Confirm',
      message: 'Confirm assets',
    });

    expect(result.document).toBe(projectizedDocument);
    expect(manifestBuilder.buildForSceneDocumentV4).toHaveBeenCalledWith(projectizedDocument);
  });

  it('projectizes a SceneDocumentV5 before manifest reuse checks and building', async () => {
    const documentV5: SceneDocumentV5 = {
      schemaVersion: 5,
      sceneId: 'scene_v3',
      meta: { title: 'Readiness Scene V3' },
      statements: [],
    };
    const projectizedDocument = {
      ...documentV5,
      meta: { ...documentV5.meta, title: 'Projectized V3' },
    };
    const manifest = makeManifest(await hashText('bg'));
    const manifestBuilder = {
      buildForScene: vi.fn(),
      buildForSceneDocumentV5: vi.fn(async () => manifest),
    };
    const reuseChecker = {
      hasUnchangedReferences: vi.fn(),
      hasUnchangedSceneDocumentV5References: vi.fn(async () => false),
    };
    const gate = new CollaborativeAssetReadinessGate({
      fileAccess: new FakeFileAccess({ 'D:/project/background/bg.png': 'bg' }) as unknown as IFileAccess,
      projectResources: {
        resolveForRead: async (relativePath: string) => `D:/project/${relativePath}`,
        resolveForProjectWrite: async (relativePath: string) => `D:/project/${relativePath}`,
      },
      sceneProjectizer: {
        prepareCollaborativeAssetReferences: vi.fn(async (scene) => scene),
        prepareCollaborativeV5SceneDocumentAssetReferences: vi.fn(async () => projectizedDocument),
      },
      manifestBuilder,
      manifestReuseChecker: reuseChecker,
      uploader: { uploadManifest: vi.fn(async () => undefined) },
      downloader: { downloadManifest: vi.fn() },
      confirmAgreement: vi.fn(async () => undefined),
    });

    const result = await gate.prepareLocalPublishV5({
      document: documentV5,
      previousManifest: {},
      reason: 'initial-host',
      forceAgreement: true,
      title: 'Confirm',
      message: 'Confirm assets',
    });

    expect(result.document).toBe(projectizedDocument);
    expect(manifestBuilder.buildForSceneDocumentV5).toHaveBeenCalledWith(projectizedDocument);
  });

  it('refuses to publish a SceneDocumentV5 when the projectizer cannot projectize mounts', async () => {
    const documentV5: SceneDocumentV5 = {
      schemaVersion: 5,
      sceneId: 'scene_v3',
      meta: { title: 'Readiness Scene V3' },
      statements: [],
    };
    const gate = new CollaborativeAssetReadinessGate({
      sceneProjectizer: {
        prepareCollaborativeAssetReferences: vi.fn(async (scene) => scene),
      },
      manifestBuilder: {
        buildForScene: vi.fn(),
        buildForSceneDocumentV5: vi.fn(),
      },
      uploader: { uploadManifest: vi.fn() },
      downloader: { downloadManifest: vi.fn() },
    });

    await expect(gate.prepareLocalPublishV5({
      document: documentV5,
      previousManifest: {},
      reason: 'initial-host',
      forceAgreement: true,
      title: 'Confirm',
      message: 'Confirm assets',
    })).rejects.toThrow(/missing V5 asset projectization support/i);
  });

  it('stores verified local signatures and skips repeated same-manifest uploads', async () => {
    const contentHash = await hashText('bg');
    const manifest = makeManifest(contentHash);
    const uploader = { uploadManifest: vi.fn(async () => undefined) };
    const gate = new CollaborativeAssetReadinessGate({
      fileAccess: new FakeFileAccess({ 'D:/project/background/bg.png': 'bg' }) as unknown as IFileAccess,
      projectResources: {
        resolveForRead: async (relativePath: string) => `D:/project/${relativePath}`,
        resolveForProjectWrite: async (relativePath: string) => `D:/project/${relativePath}`,
      },
      manifestBuilder: { buildForScene: vi.fn(async () => manifest) },
      uploader,
      downloader: { downloadManifest: vi.fn() },
    });

    await gate.prepareLocalPublish({
      scene,
      previousManifest: {},
      reason: 'manual-refresh',
      forceAgreement: true,
      title: 'Confirm',
      message: 'Confirm assets',
    });
    await expect(gate.prepareLocalPublish({
      scene,
      previousManifest: {},
      reason: 'manual-refresh',
      forceAgreement: true,
      title: 'Confirm',
      message: 'Confirm assets',
    })).resolves.toEqual(expect.objectContaining({
      reusedVerifiedSignature: true,
    }));

    expect(uploader.uploadManifest).toHaveBeenCalledTimes(1);
  });

  it('stores verified remote signatures and skips repeated same-manifest downloads', async () => {
    const contentHash = await hashText('bg');
    const manifest = makeManifest(contentHash);
    const files: Record<string, string> = {};
    const downloader = {
      downloadManifest: vi.fn(async () => {
        files['D:/project/background/bg.png'] = 'bg';
      }),
    };
    const gate = new CollaborativeAssetReadinessGate({
      fileAccess: new FakeFileAccess(files) as unknown as IFileAccess,
      projectResources: {
        resolveForRead: async (relativePath: string) => `D:/project/${relativePath}`,
        resolveForProjectWrite: async (relativePath: string) => `D:/project/${relativePath}`,
      },
      uploader: { uploadManifest: vi.fn() },
      downloader,
    });

    await gate.prepareRemoteApply({
      manifest,
      reason: 'join-room',
      title: 'Confirm',
      message: 'Confirm assets',
    });
    await expect(gate.prepareRemoteApply({
      manifest,
      reason: 'remote-manifest-changed',
      title: 'Confirm',
      message: 'Confirm assets',
    })).resolves.toEqual({
      signature: expect.any(String),
      proposal: null,
      reusedVerifiedSignature: true,
    });
    expect(downloader.downloadManifest).toHaveBeenCalledTimes(1);
  });

  it('rechecks the disk before reusing a previously verified remote manifest', async () => {
    const contentHash = await hashText('bg');
    const manifest = makeManifest(contentHash);
    const files: Record<string, string> = {};
    const downloader = {
      downloadManifest: vi.fn(async () => {
        files['D:/project/background/bg.png'] = 'bg';
      }),
    };
    const gate = new CollaborativeAssetReadinessGate({
      fileAccess: new FakeFileAccess(files) as unknown as IFileAccess,
      projectResources: {
        resolveForRead: async (relativePath: string) => `D:/project/${relativePath}`,
        resolveForProjectWrite: async (relativePath: string) => `D:/project/${relativePath}`,
      },
      uploader: { uploadManifest: vi.fn() },
      downloader,
    });

    await gate.prepareRemoteApply({
      manifest,
      reason: 'join-room',
      title: 'Confirm',
      message: 'Confirm assets',
    });
    delete files['D:/project/background/bg.png'];

    await gate.prepareRemoteApply({
      manifest,
      reason: 'remote-manifest-changed',
      title: 'Confirm',
      message: 'Confirm assets',
    });

    expect(downloader.downloadManifest).toHaveBeenCalledTimes(2);
  });

  it('cancels the active local transfer and clears the active controller', async () => {
    const contentHash = await hashText('bg');
    const manifest = makeManifest(contentHash);
    let capturedSignal: AbortSignal | undefined;
    let uploadStarted: (() => void) | undefined;
    const uploadStartedPromise = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    const uploader = {
      uploadManifest: vi.fn(async (_manifest: CollaborativeAssetManifest, options?: { signal?: AbortSignal }) => {
        capturedSignal = options?.signal;
        uploadStarted?.();
        await new Promise<void>((_resolve, reject) => {
          capturedSignal?.addEventListener('abort', () => reject(new Error('已取消协作资源传输')), { once: true });
        });
      }),
    };
    const controllers: Array<AbortController | null> = [];
    const gate = new CollaborativeAssetReadinessGate({
      fileAccess: new FakeFileAccess({ 'D:/project/background/bg.png': 'bg' }) as unknown as IFileAccess,
      projectResources: {
        resolveForRead: async (relativePath: string) => `D:/project/${relativePath}`,
        resolveForProjectWrite: async (relativePath: string) => `D:/project/${relativePath}`,
      },
      uploader,
      downloader: { downloadManifest: vi.fn() },
      onTransferController: (controller) => controllers.push(controller),
    });

    const pending = gate.ensureLocalPublishReadiness(manifest, {
      reason: 'manual-refresh',
      title: 'Confirm',
      message: 'Confirm assets',
    });
    await uploadStartedPromise;
    gate.cancelActiveTransfer();

    await expect(pending).rejects.toThrow('已取消协作资源传输');
    expect(capturedSignal?.aborted).toBe(true);
    expect(controllers[0]).toBeInstanceOf(AbortController);
    expect(controllers.at(-1)).toBeNull();
  });

  it('stops local publish readiness when the user rejects the resource agreement', async () => {
    const contentHash = await hashText('bg');
    const manifest = makeManifest(contentHash);
    const fileAccess = new FakeFileAccess({ 'E:/library/background/bg.png': 'bg' });
    const uploader = { uploadManifest: vi.fn(async () => undefined) };
    const gate = new CollaborativeAssetReadinessGate({
      fileAccess: fileAccess as unknown as IFileAccess,
      projectResources: {
        resolveForRead: async (relativePath: string) => `E:/library/${relativePath}`,
        resolveForProjectWrite: async (relativePath: string) => `D:/project/${relativePath}`,
      },
      uploader,
      downloader: { downloadManifest: vi.fn() },
      confirmAgreement: vi.fn(async () => {
        throw new Error('user rejected agreement');
      }),
    });

    await expect(gate.ensureLocalPublishReadiness(manifest, {
      reason: 'manual-refresh',
      title: 'Confirm',
      message: 'Confirm assets',
    })).rejects.toThrow('user rejected agreement');

    expect(fileAccess.copies).toEqual([]);
    expect(uploader.uploadManifest).not.toHaveBeenCalled();
  });

  it('stops remote apply readiness when the user rejects the resource agreement', async () => {
    const contentHash = await hashText('bg');
    const manifest = makeManifest(contentHash);
    const downloader = { downloadManifest: vi.fn(async () => undefined) };
    const gate = new CollaborativeAssetReadinessGate({
      fileAccess: new FakeFileAccess({ 'D:/project/background/bg.png': 'different-content' }) as unknown as IFileAccess,
      projectResources: {
        resolveForRead: async (relativePath: string) => `D:/project/${relativePath}`,
        resolveForProjectWrite: async (relativePath: string) => `D:/project/${relativePath}`,
      },
      uploader: { uploadManifest: vi.fn() },
      downloader,
      confirmAgreement: vi.fn(async () => {
        throw new Error('user rejected remote agreement');
      }),
    });

    await expect(gate.ensureRemoteApplyReadiness(manifest, {
      reason: 'join-room',
      title: 'Confirm',
      message: 'Confirm assets',
    })).rejects.toThrow('user rejected remote agreement');

    expect(downloader.downloadManifest).not.toHaveBeenCalled();
  });
});
