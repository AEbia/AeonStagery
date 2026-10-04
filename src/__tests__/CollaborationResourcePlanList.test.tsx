/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CollaborativeAssetManifest } from '../api/types/collaboration';
import { createAssetHandshakeState } from '../services/collaboration/CollaborationAssetHandshake';
import { CollaborationResourcePlanList, hasAgreementItemProblem } from '../ui/CollaborationResourcePlanList';

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

describe('CollaborationResourcePlanList', () => {
  it('renders direction-aware operation labels without redundant judgment notes', () => {
    const state = createAssetHandshakeState(makeManifest(), 'confirming', 'remote', {
      itemPlans: {
        'background/livehouse.png': {
          sourceKind: 'server',
          operation: 'download',
        },
      },
      now: '2026-06-08T00:00:00.000Z',
    });

    render(
      <CollaborationResourcePlanList
        items={state.items}
        direction="remote"
        manifest={makeManifest()}
      />,
    );

    expect(screen.getAllByText('从服务器下载').length).toBeGreaterThan(0);
    expect(screen.queryByText(/服务器有这个资源/)).toBeNull();
    expect(screen.getAllByText(/background\/livehouse\.png/).length).toBeGreaterThan(0);
  });

  it('falls back to manifest files with the item operation when file plans are absent', () => {
    const state = createAssetHandshakeState(makeManifest(), 'confirming', 'remote', {
      itemPlans: {
        'background/livehouse.png': {
          sourceKind: 'server',
          operation: 'download',
        },
        'figure/rana/rana.model.json': {
          sourceKind: 'project',
          operation: 'reuse',
        },
      },
      now: '2026-06-08T00:00:00.000Z',
    });

    render(
      <CollaborationResourcePlanList
        items={state.items}
        direction="remote"
        manifest={makeManifest()}
      />,
    );

    expect(screen.queryByText(/待确认/)).toBeNull();
  });

  it('renders the custom empty label when there are no items', () => {
    render(
      <CollaborationResourcePlanList
        items={[]}
        direction="remote"
        emptyLabel="服务器没有声明需要同步的资源"
      />,
    );

    expect(screen.getByText('服务器没有声明需要同步的资源')).toBeTruthy();
  });

  it('detects item problems across file plans', () => {
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
          filePlans: [{
            relativePath: 'background/livehouse.png',
            sourceKind: 'server',
            operation: 'replace',
            problem: {
              severity: 'warning',
              message: '本地同路径文件内容不同',
              filePath: 'background/livehouse.png',
            },
          }],
        },
      },
      now: '2026-06-08T00:00:00.000Z',
    });

    expect(hasAgreementItemProblem(state.items[0])).toBe(true);
    expect(hasAgreementItemProblem(state.items[1])).toBe(false);
  });
});
