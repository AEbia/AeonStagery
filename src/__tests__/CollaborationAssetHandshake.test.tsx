/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { CollaborativeAssetManifest } from '../api/types/collaboration';
import {
  createAssetAgreementProposal,
  createAssetHandshakeState,
  createEmptyAssetHandshakeState,
  createHandshakeReviewProposal,
  countAgreementProblems,
  formatAssetHandshakeBytes,
  formatAssetHandshakeHash,
  shouldPromptForAssetAgreement,
  summarizeAssetAgreementOperations,
  summarizeAssetHandshake,
} from '../services/collaboration/CollaborationAssetHandshake';
import { deriveCollaborationStatusUx } from '../services/collaboration/CollaborationStatusUxModel';
import { CollaborationAssetHandshakePanel } from '../ui/CollaborationAssetHandshakePanel';
import {
  getCollaborationStatusHint,
  getCollaborativeAssetManifestAgreementSignature,
} from '../ui/CollaborationConnectPanel';
import { CollaborationResourceAgreementDialog } from '../ui/CollaborationResourceAgreementDialog';

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

describe('CollaborationAssetHandshake', () => {
  it('creates sorted handshake items and summarizes resources', () => {
    const state = createAssetHandshakeState(makeManifest(), 'downloading', 'remote', {
      now: '2026-06-08T00:00:00.000Z',
    });

    expect(state.direction).toBe('remote');
    expect(state.status).toBe('downloading');
    expect(state.items.map((item) => item.projectRelativePath)).toEqual([
      'background/livehouse.png',
      'figure/rana/rana.model.json',
    ]);
    expect(summarizeAssetHandshake(state)).toEqual({
      assetCount: 2,
      fileCount: 3,
      totalSizeBytes: 1024 + 2048 + 1024 * 1024,
    });
  });

  it('formats asset byte sizes for compact UI', () => {
    expect(formatAssetHandshakeBytes(0)).toBe('0 B');
    expect(formatAssetHandshakeBytes(512)).toBe('512 B');
    expect(formatAssetHandshakeBytes(1536)).toBe('1.5 KB');
    expect(formatAssetHandshakeBytes(1024 * 1024 * 2)).toBe('2.0 MB');
    expect(formatAssetHandshakeHash('sha256:1234567890abcdef')).toBe('sha256:1234567890');
  });

  it('hides the completed resource panel when every resource is already reusable locally', () => {
    const state = createAssetHandshakeState(makeManifest(), 'verified', 'remote', {
      now: '2026-06-08T00:00:00.000Z',
    });

    render(<CollaborationAssetHandshakePanel state={state} />);

    expect(screen.queryByTestId('collaboration-asset-handshake')).toBeNull();
  });

  it('renders the resource panel with status, totals, and asset rows when work was needed', () => {
    const state = createAssetHandshakeState(makeManifest(), 'verified', 'remote', {
      itemPlans: {
        'figure/rana/rana.model.json': {
          sourceKind: 'project',
          operation: 'reuse',
        },
        'background/livehouse.png': {
          sourceKind: 'server',
          operation: 'download',
        },
      },
      now: '2026-06-08T00:00:00.000Z',
    });

    render(<CollaborationAssetHandshakePanel state={state} />);

    expect(screen.getByTestId('collaboration-asset-handshake')).toBeTruthy();
    expect(screen.getByText('资源就绪')).toBeTruthy();
    expect(screen.getByText('服务器资源')).toBeTruthy();
    expect(screen.getByText('2 个资源')).toBeTruthy();
    expect(screen.getByText('3 个文件')).toBeTruthy();
    expect(screen.getByText('background/livehouse.png')).toBeTruthy();
    expect(screen.getByText('figure/rana/rana.model.json')).toBeTruthy();
    expect(screen.getByText(/sha256:bg/)).toBeTruthy();
    expect(screen.getByText('资源同步已完成')).toBeTruthy();
    expect(screen.getAllByText(/已完成：1 个从服务器下载/).length).toBeGreaterThan(0);
  });

  it('renders an indeterminate transfer progress when no byte or file totals are known', () => {
    const state = createAssetHandshakeState(makeManifest(), 'downloading', 'remote', {
      transfer: {
        currentFilePath: '',
        currentFileBytes: 0,
        currentFileSizeBytes: 0,
        completedFiles: 0,
        totalFiles: 0,
        completedBytes: 0,
        totalBytes: 0,
      },
      now: '2026-06-08T00:00:00.000Z',
    });

    render(<CollaborationAssetHandshakePanel state={state} />);

    expect(screen.getByText('准备中')).toBeTruthy();
    expect(document.querySelector('.collaboration-assets__progress-fill--indeterminate')).toBeTruthy();
  });

  it('renders resource handshake errors', () => {
    const state = createAssetHandshakeState(makeManifest(), 'error', 'local', {
      error: 'hash mismatch',
      now: '2026-06-08T00:00:00.000Z',
    });

    render(<CollaborationAssetHandshakePanel state={state} />);

    expect(screen.getByText('资源异常')).toBeTruthy();
    expect(screen.getByText('本地资源')).toBeTruthy();
    expect(screen.getByText('hash mismatch')).toBeTruthy();
  });

  it('delegates status hints to the collaboration status UX model while preserving seeding phases', () => {
    const verified = createAssetHandshakeState(makeManifest(), 'verified', 'local');
    const confirming = createAssetHandshakeState(makeManifest(), 'confirming', 'remote');
    const downloading = createAssetHandshakeState(makeManifest(), 'downloading', 'remote');
    const preparing = createAssetHandshakeState(makeManifest(), 'preparing', 'remote');
    const empty = createEmptyAssetHandshakeState();

    expect(getCollaborationStatusHint('connected', empty)).toBe(
      deriveCollaborationStatusUx({ status: 'connected', assetHandshake: empty }).detail,
    );
    expect(getCollaborationStatusHint('offline', empty)).toBe(
      deriveCollaborationStatusUx({ status: 'offline', assetHandshake: empty }).detail,
    );
    expect(getCollaborationStatusHint('seeding', verified)).toBe(
      deriveCollaborationStatusUx({ status: 'seeding', assetHandshake: verified }).detail,
    );
    expect(getCollaborationStatusHint('seeding', confirming)).toContain('确认同步计划后继续');
    expect(getCollaborationStatusHint('seeding', downloading)).toContain('服务器资源');
    expect(getCollaborationStatusHint('seeding', preparing)).toContain('正在准备协作资源');
  });

  it('creates a stable resource agreement signature for unchanged manifests', () => {
    const manifest = makeManifest();
    const sameContentManifest: CollaborativeAssetManifest = {
      ...manifest,
      'figure/rana/rana.model.json': {
        ...manifest['figure/rana/rana.model.json'],
        createdAt: '2026-06-09T00:00:00.000Z',
        files: [...manifest['figure/rana/rana.model.json'].files].reverse(),
      },
    };
    const changedManifest: CollaborativeAssetManifest = {
      ...manifest,
      'background/livehouse.png': {
        ...manifest['background/livehouse.png'],
        contentHash: 'sha256:bg-changed',
      },
    };

    expect(getCollaborativeAssetManifestAgreementSignature(sameContentManifest)).toBe(
      getCollaborativeAssetManifestAgreementSignature(manifest),
    );
    expect(getCollaborativeAssetManifestAgreementSignature(changedManifest)).not.toBe(
      getCollaborativeAssetManifestAgreementSignature(manifest),
    );
  });

  it('creates resource agreement proposals with operation plans and problem counts', () => {
    const proposal = createAssetAgreementProposal(makeManifest(), 'remote', {
      reason: 'join-room',
      itemPlans: {
        'figure/rana/rana.model.json': {
          sourceKind: 'external-library',
          operation: 'copy',
        },
        'background/livehouse.png': {
          sourceKind: 'server',
          operation: 'replace',
          problem: {
            severity: 'warning',
            message: '本地同路径文件内容不同',
            filePath: 'background/livehouse.png',
          },
        },
      },
      now: '2026-06-08T00:00:00.000Z',
    });

    expect(proposal.reason).toBe('join-room');
    expect(proposal.warningCount).toBe(1);
    expect(proposal.blockingProblemCount).toBe(0);
    expect(summarizeAssetAgreementOperations(proposal.items)).toMatchObject({
      copy: 1,
      replace: 1,
    });
  });

  it('creates a read-only review proposal from a live handshake with problem counts', () => {
    const state = createAssetHandshakeState(makeManifest(), 'confirming', 'remote', {
      itemPlans: {
        'background/livehouse.png': {
          sourceKind: 'server',
          operation: 'replace',
          problem: {
            severity: 'warning',
            message: '本地同路径文件内容不同',
            filePath: 'background/livehouse.png',
          },
        },
      },
      now: '2026-06-08T00:00:00.000Z',
    });

    const review = createHandshakeReviewProposal(state);

    expect(review.direction).toBe('remote');
    expect(review.warningCount).toBe(1);
    expect(review.blockingProblemCount).toBe(0);
    expect(review.items).toHaveLength(2);
    expect(review.manifest).toEqual({});
  });

  it('blocks local publish operations in remote agreements without showing upload actions', () => {
    const proposal = createAssetAgreementProposal(makeManifest(), 'remote', {
      reason: 'join-room',
      itemPlans: {
        'figure/rana/rana.model.json': {
          sourceKind: 'external-library',
          operation: 'copy-and-upload',
          filePlans: [
            {
              relativePath: 'figure/rana/rana.model.json',
              sourceKind: 'external-library',
              operation: 'copy-and-upload',
            },
          ],
        },
        'background/livehouse.png': {
          sourceKind: 'project',
          operation: 'reuse',
        },
      },
    });

    expect(proposal.blockingProblemCount).toBeGreaterThan(0);
    expect(summarizeAssetAgreementOperations(proposal.items)).toMatchObject({
      blocked: 1,
      'copy-and-upload': 0,
      upload: 0,
    });

    render(
      <CollaborationResourceAgreementDialog
        proposal={proposal}
        title="确认服务器协作资源"
        message="确认这些文件用于协作。"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText(/加入端只接收和准备服务器资源/)).toBeTruthy();
    expect(screen.getAllByText('需要处理').length).toBeGreaterThan(0);
    expect(screen.queryByText(/上传/)).toBeNull();
    expect((screen.getByRole('button', { name: '确认并继续' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('counts a top-level blocking problem even when file plans are present', () => {
    const proposal = createAssetAgreementProposal(makeManifest(), 'remote', {
      reason: 'join-room',
      itemPlans: {
        'figure/rana/rana.model.json': {
          sourceKind: 'project',
          operation: 'upload',
          filePlans: [{
            relativePath: 'figure/rana/rana.model.json',
            sourceKind: 'project',
            operation: 'reuse',
          }],
        },
      },
    });

    const item = proposal.items.find((candidate) => candidate.assetKey === 'figure/rana/rana.model.json');
    expect(item?.operation).toBe('blocked');
    expect(item?.problem?.severity).toBe('blocking');
    expect(countAgreementProblems(proposal.items, 'blocking')).toBe(1);
    expect(proposal.blockingProblemCount).toBe(1);
  });

  it('prompts only for risky or blocking resource agreement plans', () => {
    const reusableProposal = createAssetAgreementProposal(makeManifest(), 'remote', {
      reason: 'join-room',
      itemPlans: {
        'figure/rana/rana.model.json': {
          sourceKind: 'project',
          operation: 'reuse',
        },
        'background/livehouse.png': {
          sourceKind: 'server',
          operation: 'download',
        },
      },
    });
    const copyAndUploadProposal = createAssetAgreementProposal(makeManifest(), 'local', {
      reason: 'initial-host',
      itemPlans: {
        'figure/rana/rana.model.json': {
          sourceKind: 'external-library',
          operation: 'copy-and-upload',
        },
        'background/livehouse.png': {
          sourceKind: 'project',
          operation: 'upload',
        },
      },
    });
    const replaceProposal = createAssetAgreementProposal(makeManifest(), 'remote', {
      reason: 'join-room',
      itemPlans: {
        'figure/rana/rana.model.json': {
          sourceKind: 'project',
          operation: 'reuse',
        },
        'background/livehouse.png': {
          sourceKind: 'server',
          operation: 'replace',
          problem: {
            severity: 'warning',
            message: '项目里已有同路径文件，但内容与服务器资源不同；确认后会写入服务器版本。',
          },
        },
      },
    });

    expect(shouldPromptForAssetAgreement(reusableProposal)).toBe(false);
    expect(shouldPromptForAssetAgreement(copyAndUploadProposal)).toBe(true);
    expect(shouldPromptForAssetAgreement(replaceProposal)).toBe(true);
  });

  it('renders an intrusive resource agreement dialog before continuing collaboration', () => {
    let confirmed = false;
    let cancelled = false;
    const proposal = createAssetAgreementProposal(makeManifest(), 'local', {
      reason: 'initial-host',
      itemPlans: {
        'figure/rana/rana.model.json': {
          sourceKind: 'external-library',
          operation: 'copy-and-upload',
          filePlans: [
            {
              relativePath: 'figure/rana/rana.model.json',
              sourceKind: 'external-library',
              operation: 'copy-and-upload',
            },
            {
              relativePath: 'figure/rana/texture.png',
              sourceKind: 'external-library',
              operation: 'copy-and-upload',
            },
          ],
        },
        'background/livehouse.png': {
          sourceKind: 'project',
          operation: 'upload',
          filePlans: [
            {
              relativePath: 'background/livehouse.png',
              sourceKind: 'project',
              operation: 'upload',
            },
          ],
        },
      },
    });

    render(
      <CollaborationResourceAgreementDialog
        proposal={proposal}
        title="确认本地协作资源"
        message="确认这些文件用于协作。"
        onConfirm={() => { confirmed = true; }}
        onCancel={() => { cancelled = true; }}
      />,
    );

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('确认本地协作资源')).toBeTruthy();
    expect(screen.getByText(/主持房间/)).toBeTruthy();
    expect(screen.getAllByText('复制到项目并上传').length).toBeGreaterThan(0);
    expect(screen.getAllByText('上传到服务器').length).toBeGreaterThan(0);
    expect(screen.getAllByText('figure/rana/rana.model.json').length).toBeGreaterThan(0);
    expect(screen.getByText(/figure\/rana\/texture\.png/)).toBeTruthy();
    expect(screen.getAllByText('background/livehouse.png').length).toBeGreaterThan(0);
    expect(screen.getByText(/入口 figure\/rana\/rana\.model\.json/)).toBeTruthy();
    expect(screen.getAllByText(/指纹 sha256:/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText('确认并继续'));
    expect(confirmed).toBe(true);
    expect(cancelled).toBe(false);
  });

  it('filters problematic resource agreement rows and blocks confirmation for blocking problems', () => {
    const proposal = createAssetAgreementProposal(makeManifest(), 'remote', {
      reason: 'join-room',
      itemPlans: {
        'figure/rana/rana.model.json': {
          sourceKind: 'external-library',
          operation: 'copy',
          filePlans: [
            {
              relativePath: 'figure/rana/rana.model.json',
              sourceKind: 'external-library',
              operation: 'copy',
            },
            {
              relativePath: 'figure/rana/texture.png',
              sourceKind: 'external-library',
              operation: 'copy',
            },
          ],
        },
        'background/livehouse.png': {
          sourceKind: 'unknown',
          operation: 'blocked',
          problem: {
            severity: 'blocking',
            message: '本地找不到这个资源文件，无法继续。',
            filePath: 'background/livehouse.png',
          },
          filePlans: [
            {
              relativePath: 'background/livehouse.png',
              sourceKind: 'unknown',
              operation: 'blocked',
              problem: {
                severity: 'blocking',
                message: '本地找不到这个资源文件，无法继续。',
                filePath: 'background/livehouse.png',
              },
            },
          ],
        },
      },
    });

    render(
      <CollaborationResourceAgreementDialog
        proposal={proposal}
        title="确认服务器协作资源"
        message="确认这些文件用于协作。"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText('本地找不到这个资源文件，无法继续。')).toBeTruthy();
    expect((screen.getByRole('button', { name: '确认并继续' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('只看问题资源'));

    expect(screen.getByText('background/livehouse.png')).toBeTruthy();
    expect(screen.queryByText('figure/rana/rana.model.json')).toBeNull();
  });

  it('renders a read-only resource agreement review without confirmation actions', () => {
    let closed = false;
    const proposal = createAssetAgreementProposal(makeManifest(), 'remote', {
      reason: 'join-room',
      itemPlans: {
        'figure/rana/rana.model.json': {
          sourceKind: 'project',
          operation: 'reuse',
        },
        'background/livehouse.png': {
          sourceKind: 'server',
          operation: 'download',
        },
      },
    });

    render(
      <CollaborationResourceAgreementDialog
        proposal={proposal}
        title="协作资源约定"
        message="当前会话资源。"
        readOnly
        onCancel={() => { closed = true; }}
      />,
    );

    expect(screen.getByText('协作资源约定')).toBeTruthy();
    expect(screen.queryByText('确认并继续')).toBeNull();

    fireEvent.click(screen.getByText('关闭'));
    expect(closed).toBe(true);
  });

});
