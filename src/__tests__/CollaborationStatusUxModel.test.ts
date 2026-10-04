import { describe, expect, it } from 'vitest';
import type { CollaborativeAssetManifest } from '../api/types/collaboration';
import { createAssetHandshakeState } from '../services/collaboration/CollaborationAssetHandshake';
import { deriveCollaborationStatusUx } from '../services/collaboration/CollaborationStatusUxModel';

function makeManifest(): CollaborativeAssetManifest {
  return {
    'figure/rana/rana.model.json': {
      assetId: 'live2d-bundle:sha256:bundle',
      kind: 'live2d-bundle',
      importKind: 'figure',
      projectRelativePath: 'figure/rana/rana.model.json',
      entrypointPath: 'figure/rana/rana.model.json',
      contentHash: 'sha256:bundle',
      createdAt: '2026-06-08T00:00:00.000Z',
      files: [
        {
          relativePath: 'figure/rana/rana.model.json',
          contentHash: 'sha256:model',
          sizeBytes: 1024,
          mimeType: 'application/json',
        },
        {
          relativePath: 'figure/rana/texture.png',
          contentHash: 'sha256:texture',
          sizeBytes: 2048,
          mimeType: 'image/png',
        },
      ],
    },
    'background/livehouse.png': {
      assetId: 'background-image:sha256:bg',
      kind: 'background-image',
      importKind: 'background',
      projectRelativePath: 'background/livehouse.png',
      entrypointPath: 'background/livehouse.png',
      contentHash: 'sha256:bg',
      createdAt: '2026-06-08T00:00:00.000Z',
      files: [
        {
          relativePath: 'background/livehouse.png',
          contentHash: 'sha256:bg',
          sizeBytes: 1024 * 1024,
          mimeType: 'image/png',
        },
      ],
    },
  };
}

describe('CollaborationStatusUxModel', () => {
  it('describes connected collaboration as server-backed realtime state instead of local-file-backed state', () => {
    const ux = deriveCollaborationStatusUx({
      status: 'connected',
      self: { clientId: 'self-1', displayName: '导演' },
      peers: [{ clientId: 'peer-1', displayName: '分镜师' }],
    });

    expect(flattenCopy(ux)).toContain('服务器协作状态');
    expect(flattenCopy(ux)).toContain('实时通道');
    expect(flattenCopy(ux)).not.toContain('本地文件是事实来源');
    expect(ux.sourceOfTruthFact.detail).toContain('服务器');
    expect(ux.sourceOfTruthFact.detail).not.toContain('本地文件');
  });

  it('describes offline collaboration as paused shared editing without promising offline queued edits', () => {
    const ux = deriveCollaborationStatusUx({ status: 'offline' });

    expect(flattenCopy(ux)).toContain('共享编辑已暂停');
    expect(flattenCopy(ux)).toContain('自动重试次数已用完');
    expect(flattenCopy(ux)).not.toContain('离线提交');
    expect(flattenCopy(ux)).not.toContain('离线队列');
  });

  it('describes reconnecting collaboration as paused while the realtime channel is restored', () => {
    const ux = deriveCollaborationStatusUx({ status: 'reconnecting' });

    expect(ux.label).toBe('正在重连');
    expect(ux.detail).toContain('正在自动重试');
    expect(ux.offlineEditMessage).toContain('共享编辑已暂停');
  });

  it('derives seeding copy from the resource handshake state for each handshake status', () => {
    const cases = [
      { status: 'confirming' as const, expected: '确认同步计划后继续' },
      { status: 'checking' as const, expected: '正在校验协作资源' },
      { status: 'preparing' as const, expected: '正在准备协作资源' },
      { status: 'uploading' as const, expected: 'uploading/texture.png · 50% · 1/2 文件 · 1.0 KB / 2.0 KB' },
      { status: 'downloading' as const, expected: 'downloading/texture.png · 25% · 1/4 文件 · 1.0 KB / 4.0 KB' },
      { status: 'verified' as const, expected: '可以继续实时协作' },
      { status: 'error' as const, expected: '资源同步失败' },
    ];

    for (const entry of cases) {
      const ux = deriveCollaborationStatusUx({
        status: 'seeding',
        assetHandshake: createAssetHandshakeState(makeManifest(), entry.status, entry.status === 'uploading' ? 'local' : 'remote', {
          error: entry.status === 'error' ? 'hash mismatch' : undefined,
          itemPlans: entry.status === 'confirming' ? {
            'background/livehouse.png': { sourceKind: 'server', operation: 'download' },
          } : undefined,
          transfer: entry.status === 'uploading' ? {
            currentFilePath: 'uploading/texture.png',
            currentFileBytes: 0,
            currentFileSizeBytes: 1024,
            completedFiles: 1,
            totalFiles: 2,
            completedBytes: 1024,
            totalBytes: 2048,
          } : entry.status === 'downloading' ? {
            currentFilePath: 'downloading/texture.png',
            currentFileBytes: 0,
            currentFileSizeBytes: 1024,
            completedFiles: 1,
            totalFiles: 4,
            completedBytes: 1024,
            totalBytes: 4096,
          } : undefined,
          now: '2026-06-08T00:00:00.000Z',
        }),
      });

      expect(flattenCopy(ux), entry.status).toContain(entry.expected);
      expect(ux.resourceFact.detail, entry.status).toContain(entry.expected);
    }
  });

  it('states presence awareness does not lock actions', () => {
    const ux = deriveCollaborationStatusUx({
      status: 'connected',
      peers: [
        {
          clientId: 'peer-1',
          displayName: '分镜师',
        },
      ],
    });

    expect(ux.presenceFact.detail).toContain('在线成员的选择和编辑位置仅用于协作感知');
    expect(ux.presenceFact.detail).toContain('不限制你的操作');
  });

  it('reflects handshake failures, blocking issues, and transfers in the connected resource fact', () => {
    const errorUx = deriveCollaborationStatusUx({
      status: 'connected',
      assetHandshake: createAssetHandshakeState(makeManifest(), 'error', 'remote', {
        error: 'hash mismatch',
      }),
    });
    expect(errorUx.resourceFact.tone).toBe('danger');
    expect(errorUx.resourceFact.label).toContain('资源同步失败');

    const blockedUx = deriveCollaborationStatusUx({
      status: 'connected',
      assetHandshake: createAssetHandshakeState(makeManifest(), 'confirming', 'remote', {
        itemPlans: {
          'background/livehouse.png': {
            sourceKind: 'server',
            operation: 'replace',
            problem: {
              severity: 'blocking',
              message: '路径不可写',
              filePath: 'background/livehouse.png',
            },
            filePlans: [{
              relativePath: 'background/livehouse.png',
              sourceKind: 'server',
              operation: 'replace',
              problem: {
                severity: 'blocking',
                message: '路径不可写',
                filePath: 'background/livehouse.png',
              },
            }],
          },
        },
      }),
    });
    expect(blockedUx.resourceFact.tone).toBe('danger');
    expect(blockedUx.resourceFact.label).toContain('需要先处理');

    const transferUx = deriveCollaborationStatusUx({
      status: 'connected',
      assetHandshake: createAssetHandshakeState(makeManifest(), 'downloading', 'remote', {
        transfer: {
          currentFilePath: 'downloading/texture.png',
          currentFileBytes: 0,
          currentFileSizeBytes: 1024,
          completedFiles: 1,
          totalFiles: 4,
          completedBytes: 1024,
          totalBytes: 4096,
        },
      }),
    });
    expect(transferUx.resourceFact.tone).toBe('info');
    expect(transferUx.resourceFact.label).toContain('正在下载');
  });

  it('keeps generic retry guidance when showing lastError details', () => {
    const ux = deriveCollaborationStatusUx({ status: 'error', lastError: 'socket closed: 1006' });

    expect(ux.headline).toBe('协作连接异常');
    expect(ux.detail).toContain('socket closed: 1006');
    expect(ux.detail).toContain('请检查服务器连接后重试');
    expect(ux.tooltip).toContain('socket closed: 1006');
    expect(ux.tooltip).toContain('请检查服务器连接后重试');
  });

  it('omits misleading locking, ownership, permission, offline-submit, and local-source-of-truth terms from trust copy', () => {
    const misleadingTerms = ['锁定', '占用', '权限', '离线提交', '本地文件是事实来源'];
    const states = [
      deriveCollaborationStatusUx({ status: 'disconnected' }),
      deriveCollaborationStatusUx({ status: 'connecting' }),
      deriveCollaborationStatusUx({ status: 'seeding', assetHandshake: createAssetHandshakeState(makeManifest(), 'checking', 'remote') }),
      deriveCollaborationStatusUx({ status: 'connected' }),
      deriveCollaborationStatusUx({ status: 'offline' }),
      deriveCollaborationStatusUx({ status: 'error', lastError: 'socket closed: 1006' }),
    ];

    for (const ux of states) {
      const trustCopy = ux.trustFacts.map((fact) => `${fact.label} ${fact.detail}`).join('\n');
      for (const term of misleadingTerms) {
        expect(trustCopy).not.toContain(term);
      }
    }
  });
});

function flattenCopy(model: ReturnType<typeof deriveCollaborationStatusUx>): string {
  return [
    model.label,
    model.shortLabel,
    model.footerLabel,
    model.headline,
    model.detail,
    model.tooltip,
    model.offlineEditMessage,
    model.memberSummary,
    model.sourceOfTruthFact.label,
    model.sourceOfTruthFact.detail,
    model.resourceFact.label,
    model.resourceFact.detail,
    model.editFact.label,
    model.editFact.detail,
    model.presenceFact.label,
    model.presenceFact.detail,
    ...model.trustFacts.flatMap((fact) => [fact.label, fact.detail]),
  ].filter(Boolean).join('\n');
}
