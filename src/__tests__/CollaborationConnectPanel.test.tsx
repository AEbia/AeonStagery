/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CollaborationPresencePeerV2 } from '../api/types/collaboration';
import {
  createAssetAgreementProposal,
  createAssetHandshakeState,
  createEmptyAssetHandshakeState,
} from '../services/collaboration/CollaborationAssetHandshake';
import { CollaborationConnectPanel } from '../ui/CollaborationConnectPanel';
import { SCENE_SCHEMA_VERSION } from '../api/types/semantic-scene';
import type { SemanticCollaborationSessionController } from '../ui/useSemanticCollaborationSession';

function makeController(overrides: Partial<SemanticCollaborationSessionController> = {}): SemanticCollaborationSessionController {
  return {
    endpoint: '127.0.0.1:12345',
    setEndpoint: vi.fn(),
    displayName: '导演',
    setDisplayName: vi.fn(),
    lastError: null,
    assetHandshake: createEmptyAssetHandshakeState(),
    resourceAgreement: null,
    lastResourceAgreementProposal: null,
    serverSceneAgreement: null,
    isRefreshingResources: false,
    isResourceTransferActive: false,
    isBusy: false,
    isConnected: true,
    isOffline: false,
    statusHint: '旧状态提示不应直接渲染',
    selfIdentity: { clientId: 'self-1', displayName: '导演' },
    connectCurrentProject: vi.fn(async () => true),
    hostCurrentScene: vi.fn(async () => true),
    joinExistingRoom: vi.fn(async () => true),
    retryConnection: vi.fn(),
    refreshCollaborativeResources: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    completeResourceAgreement: vi.fn(),
    completeServerSceneAgreement: vi.fn(),
    cancelResourceTransfer: vi.fn(),
    sessionCredentials: null,
    ...overrides,
  };
}

function makePeers(count: number): CollaborationPresencePeerV2[] {
  return Array.from({ length: count }, (_, index) => ({
    clientId: `peer-${index + 1}`,
    displayName: `成员${index + 1}`,
    ...(index === 0 ? { pingMs: 23 } : {}),
    selectedStatementIds: [],
    editingTarget: null,
  }));
}

function makeSingleAssetManifest() {
  return {
    'background/bg.png': {
      assetId: 'asset-bg',
      kind: 'background-image' as const,
      importKind: 'background' as const,
      projectRelativePath: 'background/bg.png',
      entrypointPath: 'background/bg.png',
      contentHash: 'sha256:abcdef1234567890',
      files: [{
        relativePath: 'background/bg.png',
        contentHash: 'sha256:abcdef1234567890',
        sizeBytes: 42,
      }],
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

describe('CollaborationConnectPanel status UX', () => {
  it('renders tabbed status, members, and resources views', () => {
    render(
      <CollaborationConnectPanel
        currentProject={{ metadata: { name: '协作项目' } } as any}
        sceneDocument={{ schemaVersion: SCENE_SCHEMA_VERSION, sceneId: 'scene-1', meta: { title: '协作场景' }, statements: [] }}
        status="connected"
        peers={makePeers(6)}
        controller={makeController()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /协作/ }));

    expect(screen.getByRole('tab', { name: '状态' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByText('事实来源')).toBeNull();
    expect(screen.queryByText('编辑方式')).toBeNull();
    expect(screen.getByText('协作已连接')).toBeTruthy();
    expect(screen.getByText('连接目标')).toBeTruthy();
    expect(screen.getByText('房间')).toBeTruthy();
    expect(screen.queryByText('旧状态提示不应直接渲染')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: '成员' }));
    expect(screen.getByRole('tab', { name: '成员' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('成员提示')).toBeTruthy();
    expect(screen.getAllByText(/不限制你的操作/).length).toBeGreaterThan(0);
    expect(screen.getByText(/另有\s*1\s*人在线/)).toBeTruthy();
    expect(screen.getByText('Ping 23 ms')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: '资源' }));
    expect(screen.getByRole('tab', { name: '资源' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('资源约定')).toBeTruthy();
    expect(screen.getAllByText(/资源校验已完成/).length).toBeGreaterThan(0);
  });

  it('offers a manual retry for an active session after an error', () => {
    const retryConnection = vi.fn();
    render(
      <CollaborationConnectPanel
        currentProject={{ metadata: { name: '协作项目' } } as any}
        sceneDocument={{ schemaVersion: SCENE_SCHEMA_VERSION, sceneId: 'scene-1', meta: { title: '协作场景' }, statements: [] }}
        status="error"
        peers={[]}
        controller={makeController({ lastError: '远端剧本无法解析', isConnected: false, retryConnection })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /协作/ }));
    expect(screen.getByText(/自动重试已停止，可手动重试/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '立即重连' }));

    expect(retryConnection).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '结束协作' })).toBeTruthy();
  });

  it('closes the popover with Escape and on outside pointer down', () => {
    render(
      <CollaborationConnectPanel
        currentProject={{ metadata: { name: '协作项目' } } as any}
        sceneDocument={{ schemaVersion: SCENE_SCHEMA_VERSION, sceneId: 'scene-1', meta: { title: '协作场景' }, statements: [] }}
        status="connected"
        peers={[]}
        controller={makeController()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /协作/ }));
    expect(screen.getByRole('dialog', { name: '实时协作' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '实时协作' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /协作/ }));
    expect(screen.getByRole('dialog', { name: '实时协作' })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: '实时协作' })).toBeNull();
  });

  it('opens a read-only plan review from the current handshake without a stored proposal', () => {
    const handshake = createAssetHandshakeState(makeSingleAssetManifest(), 'checking', 'remote', {
      now: '2026-01-01T00:00:00.000Z',
    });
    render(
      <CollaborationConnectPanel
        currentProject={{ metadata: { name: '协作项目' } } as any}
        sceneDocument={{ schemaVersion: SCENE_SCHEMA_VERSION, sceneId: 'scene-1', meta: { title: '协作场景' }, statements: [] }}
        status="connected"
        peers={[]}
        controller={makeController({ assetHandshake: handshake })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /协作/ }));
    fireEvent.click(screen.getByRole('tab', { name: '资源' }));
    fireEvent.click(screen.getByRole('button', { name: '查看同步计划' }));

    expect(screen.getByText('当前资源同步计划')).toBeTruthy();
    expect(screen.getAllByText(/background\/bg\.png/).length).toBeGreaterThan(0);
    expect(screen.queryByText('确认并继续')).toBeNull();
  });

  it('marks the resources tab with a danger badge and auto-switches on handshake failure', () => {
    const failedHandshake = createAssetHandshakeState(makeSingleAssetManifest(), 'error', 'remote', {
      error: 'hash mismatch',
      now: '2026-01-01T00:00:00.000Z',
    });
    const { rerender } = render(
      <CollaborationConnectPanel
        currentProject={{ metadata: { name: '协作项目' } } as any}
        sceneDocument={{ schemaVersion: SCENE_SCHEMA_VERSION, sceneId: 'scene-1', meta: { title: '协作场景' }, statements: [] }}
        status="connected"
        peers={[]}
        controller={makeController()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /协作/ }));
    const resourcesTab = screen.getByRole('tab', { name: '资源' });
    expect(resourcesTab.querySelector('.collaboration-tab__badge')).toBeNull();
    expect(screen.getByRole('tab', { name: '状态' }).getAttribute('aria-selected')).toBe('true');

    rerender(
      <CollaborationConnectPanel
        currentProject={{ metadata: { name: '协作项目' } } as any}
        sceneDocument={{ schemaVersion: SCENE_SCHEMA_VERSION, sceneId: 'scene-1', meta: { title: '协作场景' }, statements: [] }}
        status="connected"
        peers={[]}
        controller={makeController({ assetHandshake: failedHandshake })}
      />,
    );

    expect(screen.getByRole('tab', { name: '资源' }).querySelector('.collaboration-tab__badge--danger')).toBeTruthy();
    expect(screen.getByRole('tab', { name: '资源' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows server scene resource file plans before confirming overwrite', () => {
    const assetAgreementProposal = createAssetAgreementProposal({
      'background/bg.png': {
        assetId: 'asset-bg',
        kind: 'background-image',
        importKind: 'background',
        projectRelativePath: 'background/bg.png',
        entrypointPath: 'background/bg.png',
        contentHash: 'sha256:abcdef1234567890',
        files: [{
          relativePath: 'background/bg.png',
          contentHash: 'sha256:abcdef1234567890',
          sizeBytes: 42,
        }],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    }, 'remote', {
      reason: 'join-room',
      itemPlans: {
        'background/bg.png': {
          sourceKind: 'server',
          operation: 'replace',
          problem: {
            severity: 'warning',
            message: '项目里已有同路径文件，但内容与服务器资源不同；确认后会写入服务器版本。',
            filePath: 'background/bg.png',
          },
          filePlans: [{
            relativePath: 'background/bg.png',
            sourceKind: 'server',
            operation: 'replace',
            problem: {
              severity: 'warning',
              message: '项目里已有同路径文件，但内容与服务器资源不同；确认后会写入服务器版本。',
              filePath: 'background/bg.png',
            },
          }],
        },
      },
      now: '2026-01-01T00:00:00.000Z',
    });

    render(
      <CollaborationConnectPanel
        currentProject={{ metadata: { name: '协作项目' } } as any}
        sceneDocument={{ schemaVersion: SCENE_SCHEMA_VERSION, sceneId: 'local', meta: { title: '本地' }, statements: [] }}
        status="connecting"
        peers={[]}
        controller={makeController({
          isConnected: false,
          serverSceneAgreement: {
            localDocument: { schemaVersion: 5, sceneId: 'local', meta: { title: '本地', fps: 60 }, statements: [] },
            serverDocument: { schemaVersion: 5, sceneId: 'server', meta: { title: '服务器', fps: 60 }, statements: [] },
            serverState: {
              schemaVersion: 3,
              sceneSchemaVersion: 5,
              collaborationProjectId: 'project-1',
              roomId: 'project-1:main',
              sceneId: 'server',
              meta: { title: '服务器', fps: 60 },
              statementsById: {},
              statementOrder: [],
              assets: assetAgreementProposal.manifest,
            },
            assetAgreementProposal,
            blockingIssues: [],
            jsonBackupPath: 'D:/project/.aeonstagery/backups/main.scene.json',
            backupPath: 'D:/project/.aeonstagery/backups/main.scene.json',
            targetScenePath: 'D:/project/project/main.scene.json',
          },
        })}
      />,
    );

    expect(screen.getByText('文件计划')).toBeTruthy();
    expect(screen.getAllByText('用服务器版替换').length).toBeGreaterThan(0);
    expect(screen.queryByText(/本地同路径文件存在但内容不同/)).toBeNull();
    expect(screen.getAllByText(/background\/bg\.png/).length).toBeGreaterThan(0);
    expect(screen.getByText('同步并加入')).toBeTruthy();
  });

  it('renders v3 server scene agreement dialog with canonical v5 document comparison', () => {
    render(
      <CollaborationConnectPanel
        currentProject={{ metadata: { name: '协作项目 V3' } } as any}
        sceneDocument={{ schemaVersion: 5, sceneId: 'local-v5', meta: { title: '本地 V5', fps: 60 }, statements: [] }}
        status="connecting"
        peers={[]}
        controller={makeController({
          isConnected: false,
          serverSceneAgreement: {
            localDocument: { schemaVersion: 5, sceneId: 'local-v5', meta: { title: '本地 V5', fps: 60 }, statements: [] },
            serverDocument: {
              schemaVersion: 5,
              sceneId: 'server-v5',
              meta: { title: '服务器 V5', fps: 60 },
              statements: [
                {
                  id: 'line_1',
                  time: 1,
                  type: 'dialogue',
                  params: { text: 'Remote speech', durationSeconds: 3 },
                },
              ],
            },
            serverState: {
              schemaVersion: 3,
              sceneSchemaVersion: 5,
              collaborationProjectId: 'proj-v3',
              roomId: 'proj-v3:main',
              sceneId: 'server-v5',
              meta: { title: '服务器 V5', fps: 60 },
              statementsById: {
                line_1: {
                  id: 'line_1',
                  time: 1,
                  type: 'dialogue',
                  params: { text: 'Remote speech', durationSeconds: 3 },
                },
              },
              statementOrder: ['line_1'],
            },
            blockingIssues: [],
            targetScenePath: '/path/to/project/main.scene.json',
          },
        })}
      />,
    );

    expect(screen.getByText('加入协作房间')).toBeTruthy();
    expect(screen.getByText('1 条语句')).toBeTruthy();
    expect(screen.getByText('同步并加入')).toBeTruthy();
  });

  it('displays connection error reason in the status popover when lastError is set', () => {
    render(
      <CollaborationConnectPanel
        currentProject={{ metadata: { name: '协作项目' } } as any}
        sceneDocument={{ schemaVersion: 5, sceneId: 'scene-1', meta: { title: '协作场景', fps: 60 }, statements: [] }}
        status="error"
        peers={[]}
        controller={makeController({
          isConnected: false,
          lastError: 'Server rejected admission: unknown_fields_present',
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /协作/ }));
    expect(screen.getByText(/Server rejected admission: unknown_fields_present/)).toBeTruthy();
  });

  it('shows the invite link and password without a standalone token row', () => {
    render(
      <CollaborationConnectPanel
        currentProject={{ metadata: { name: '协作项目' } } as any}
        sceneDocument={{ schemaVersion: SCENE_SCHEMA_VERSION, sceneId: 'scene-1', meta: { title: '协作场景' }, statements: [] }}
        status="connected"
        peers={[]}
        controller={makeController()}
        serverCredentials={{
          connectionPassword: 'secret123',
          accessToken: 'tok_abc',
          inviteUrls: ['ws://192.168.1.100:12345?token=tok_abc'],
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /协作/ }));

    // Credentials section should be present
    expect(screen.getByTestId('collaboration-credentials')).toBeTruthy();

    // Invite link input
    const inviteInput = screen.getByLabelText('协作邀请链接') as HTMLInputElement;
    expect(inviteInput.value).toBe('ws://192.168.1.100:12345?token=tok_abc');

    // Password input – masked by default
    const passwordInput = screen.getByLabelText('协作房间密码') as HTMLInputElement;
    expect(passwordInput.value).toBe('secret123');
    expect(passwordInput.type).toBe('password');

    expect(screen.queryByLabelText('协作访问 Token')).toBeNull();

    // Clicking the eye button reveals the password
    fireEvent.click(screen.getByLabelText('显示密码'));
    expect((screen.getByLabelText('协作房间密码') as HTMLInputElement).type).toBe('text');

    // Copy buttons exist
    expect(screen.getByTitle('复制邀请链接')).toBeTruthy();
    expect(screen.getByTitle('复制密码')).toBeTruthy();
    expect(screen.queryByTitle('复制 Token')).toBeNull();
  });

  it('hides the credentials section when serverCredentials is null', () => {
    render(
      <CollaborationConnectPanel
        currentProject={{ metadata: { name: '协作项目' } } as any}
        sceneDocument={{ schemaVersion: SCENE_SCHEMA_VERSION, sceneId: 'scene-1', meta: { title: '协作场景' }, statements: [] }}
        status="connected"
        peers={[]}
        controller={makeController()}
        serverCredentials={null}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /协作/ }));
    expect(screen.queryByTestId('collaboration-credentials')).toBeNull();
  });

  it('shows server credentials in the members tab when switching tabs', () => {
    render(
      <CollaborationConnectPanel
        currentProject={{ metadata: { name: '协作项目' } } as any}
        sceneDocument={{ schemaVersion: SCENE_SCHEMA_VERSION, sceneId: 'scene-1', meta: { title: '协作场景' }, statements: [] }}
        status="connected"
        peers={makePeers(2)}
        controller={makeController()}
        serverCredentials={{
          connectionPassword: 'room_secret_999',
          serverAddress: '192.168.1.50:12345',
          inviteUrls: ['ws://192.168.1.50:12345?token=tok_member'],
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /协作/ }));
    // Switch to members tab
    fireEvent.click(screen.getByRole('tab', { name: '成员' }));

    // Credentials section should be visible in members tab too
    expect(screen.getByTestId('collaboration-credentials')).toBeTruthy();
    const inviteInput = screen.getByLabelText('协作邀请链接') as HTMLInputElement;
    expect(inviteInput.value).toBe('ws://192.168.1.50:12345?token=tok_member');
    const passwordInput = screen.getByLabelText('协作房间密码') as HTMLInputElement;
    expect(passwordInput.value).toBe('room_secret_999');
    const addressInput = screen.getByLabelText('协作服务地址') as HTMLInputElement;
    expect(addressInput.value).toBe('192.168.1.50:12345');
  });

  it('shows server address row and falls back to generating invite URL when inviteUrls is empty', () => {
    render(
      <CollaborationConnectPanel
        currentProject={{ metadata: { name: '协作项目' } } as any}
        sceneDocument={{ schemaVersion: SCENE_SCHEMA_VERSION, sceneId: 'scene-1', meta: { title: '协作场景' }, statements: [] }}
        status="connected"
        peers={[]}
        controller={makeController({ endpoint: '127.0.0.1:54321' })}
        serverCredentials={{
          accessToken: 'tok_derived',
          localUrl: '127.0.0.1:54321',
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /协作/ }));
    expect(screen.getByTestId('collaboration-credentials')).toBeTruthy();

    // Derived invite URL from token and localUrl
    const inviteInput = screen.getByLabelText('协作邀请链接') as HTMLInputElement;
    expect(inviteInput.value).toContain('token=tok_derived');
    expect(inviteInput.value).toContain('127.0.0.1:54321');

    // Server address row
    const addressInput = screen.getByLabelText('协作服务地址') as HTMLInputElement;
    expect(addressInput.value).toBe('127.0.0.1:54321');
  });

  it('copies credentials to clipboard when copy buttons are clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });

    render(
      <CollaborationConnectPanel
        currentProject={{ metadata: { name: '协作项目' } } as any}
        sceneDocument={{ schemaVersion: SCENE_SCHEMA_VERSION, sceneId: 'scene-1', meta: { title: '协作场景' }, statements: [] }}
        status="connected"
        peers={[]}
        controller={makeController()}
        serverCredentials={{
          connectionPassword: 'mypassword',
          accessToken: 'mytoken',
          serverAddress: '10.0.0.5:12345',
          inviteUrls: ['ws://10.0.0.5:12345?token=mytoken'],
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /协作/ }));

    await act(async () => {
      fireEvent.click(screen.getByTitle('复制服务地址'));
    });
    expect(writeText).toHaveBeenCalledWith('10.0.0.5:12345');

    await act(async () => {
      fireEvent.click(screen.getByTitle('复制密码'));
    });
    expect(writeText).toHaveBeenCalledWith('mypassword');

    await act(async () => {
      fireEvent.click(screen.getByTitle('复制邀请链接'));
    });
    expect(writeText).toHaveBeenCalledWith('ws://10.0.0.5:12345?token=mytoken');

    // The raw access token is no longer surfaced as its own copyable row; it only
    // travels inside the invite link.
    expect(screen.queryByTitle('复制 Token')).toBeNull();
    expect(writeText).not.toHaveBeenCalledWith('mytoken');
  });
});
