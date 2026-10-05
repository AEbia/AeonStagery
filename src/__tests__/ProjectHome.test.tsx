/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CollaborativeAssetManifest } from '../api/types/collaboration';
import { releaseCollaborationJoinHomeLockAfterRoomCreated } from '../App';
import {
  createAssetHandshakeState,
  createEmptyAssetHandshakeState,
} from '../services/collaboration/CollaborationAssetHandshake';
import { ProjectHome } from '../ui/onboarding/ProjectHome';

const collaborationManifest: CollaborativeAssetManifest = {
  'background/livehouse.png': {
    assetId: 'background-image:sha256:livehouse',
    kind: 'background-image',
    importKind: 'background',
    projectRelativePath: 'background/livehouse.png',
    entrypointPath: 'background/livehouse.png',
    contentHash: 'sha256:livehouse',
    createdAt: '2026-07-31T00:00:00.000Z',
    files: [{
      relativePath: 'background/livehouse.png',
      contentHash: 'sha256:livehouse-file',
      sizeBytes: 2048,
      mimeType: 'image/png',
    }],
  },
};

function makeTransferHandshake(status: 'uploading' | 'downloading') {
  return createAssetHandshakeState(
    collaborationManifest,
    status,
    status === 'uploading' ? 'local' : 'remote',
    {
      transfer: {
        currentFilePath: status === 'uploading' ? 'uploading/texture.png' : 'downloading/texture.png',
        currentFileBytes: 0,
        currentFileSizeBytes: 1024,
        completedFiles: 1,
        totalFiles: status === 'uploading' ? 2 : 4,
        completedBytes: 1024,
        totalBytes: status === 'uploading' ? 2048 : 4096,
      },
    },
  );
}

function renderHome(overrides: Partial<React.ComponentProps<typeof ProjectHome>> = {}) {
  const props: React.ComponentProps<typeof ProjectHome> = {
    defaultProjectName: 'Demo',
    defaultProjectLocation: 'D:/projects',
    collaborationEndpoint: '127.0.0.1:12345',
    collaborationDisplayName: '导演',
    collaborationStatus: 'disconnected',
    assetHandshake: createEmptyAssetHandshakeState(),
    collaborationServerStatus: null,
    shouldPromptExternalLibrary: false,
    externalLibraryPaths: [],
    recentProjects: [],
    onCreateProject: vi.fn(),
    onBrowseCreateLocation: vi.fn(async () => 'D:/chosen'),
    onRegisterWebGalAssetSource: vi.fn(async () => null),
    onBrowseCollaborationDirectory: vi.fn(async () => 'D:/join'),
    onOpenProject: vi.fn(),
    onImportTemplatePackage: vi.fn(),
    onOpenRecentProject: vi.fn(),
    onRemoveRecentProject: vi.fn(),
    onHostNewCollaboration: vi.fn(),
    onHostExistingCollaboration: vi.fn(),
    onJoinCollaboration: vi.fn(),
    onStopCollaborationServer: vi.fn(),
    onStartTutorial: vi.fn(),
    onChooseExternalLibrary: vi.fn(),
    onReplaceExternalLibrary: vi.fn(),
    onRemoveExternalLibrary: vi.fn(),
    onSkipExternalLibrary: vi.fn(),
    ...overrides,
  };
  render(<ProjectHome {...props} />);
  return props;
}

function makeRecentProjects(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    name: `Project ${index + 1}`,
    projectFilePath: `D:/projects/project-${index + 1}/project.json`,
    rootPath: `D:/projects/project-${index + 1}`,
    lastOpenedAt: `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
  }));
}

describe('ProjectHome collaboration entry', () => {
  it('caps recent projects and confirms removal before updating recents', () => {
    const onRemoveRecentProject = vi.fn();
    renderHome({
      recentProjects: makeRecentProjects(7),
      onRemoveRecentProject,
    });

    expect(screen.getAllByRole('button', { name: /打开最近项目：/ })).toHaveLength(6);
    expect(screen.queryByText('Project 7')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '移除最近项目：Project 1' }));
    expect(onRemoveRecentProject).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog').textContent).toContain('Project 1');

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onRemoveRecentProject).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '移除最近项目：Project 1' }));
    fireEvent.click(screen.getByRole('button', { name: '移除' }));
    expect(onRemoveRecentProject).toHaveBeenCalledWith('D:/projects/project-1/project.json');
  });

  it('keeps the home locked after failed or cancelled setup and unlocks after room creation', () => {
    const setLocked = vi.fn();

    releaseCollaborationJoinHomeLockAfterRoomCreated(false, setLocked);
    expect(setLocked).not.toHaveBeenCalled();

    releaseCollaborationJoinHomeLockAfterRoomCreated(true, setLocked);
    expect(setLocked).toHaveBeenCalledOnce();
    expect(setLocked).toHaveBeenCalledWith(false);
  });

  it('renders tutorial, create, open, and collaboration as first-class start actions', () => {
    renderHome();

    expect(screen.getByRole('button', { name: /开始教程/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /新建项目/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /打开项目/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /导入模板包/ })).toBeTruthy();
    expect(screen.getByText('外部库与模板')).toBeTruthy();
    expect(screen.getByRole('button', { name: /协作/ })).toBeTruthy();
  });

  it('imports a template package from the home action', async () => {
    const onImportTemplatePackage = vi.fn(async () => undefined);
    renderHome({ onImportTemplatePackage });

    fireEvent.click(screen.getByRole('button', { name: /导入模板包/ }));

    expect(onImportTemplatePackage).toHaveBeenCalledOnce();
  });

  it('enables every available template by default and submits deliberate selection changes', async () => {
    const onCreateProject = vi.fn(async () => undefined);
    renderHome({
      templatePackages: [
        { id: 'template.alpha', name: 'Alpha', version: '1.0.0', scope: 'project' },
        { id: 'template.beta', name: 'Beta', version: '1.0.0', scope: 'user' },
      ],
      onCreateProject,
    });

    fireEvent.click(screen.getByRole('button', { name: /^新建项目$/ }));
    const alpha = screen.getByRole('checkbox', { name: '启用模板 Alpha' }) as HTMLInputElement;
    const beta = screen.getByRole('checkbox', { name: '启用模板 Beta' }) as HTMLInputElement;
    expect(alpha.checked).toBe(true);
    expect(beta.checked).toBe(true);

    fireEvent.click(alpha);
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));

    await waitFor(() => expect(onCreateProject).toHaveBeenCalledOnce());
    expect(onCreateProject).toHaveBeenCalledWith(expect.objectContaining({
      templates: expect.objectContaining({ enabledTemplateIds: ['template.beta'] }),
    }));
  });

  it('starts the first lesson from the primary home action', () => {
    const onStartTutorial = vi.fn();
    renderHome({ onStartTutorial });

    fireEvent.click(screen.getByRole('button', { name: /开始教程/ }));

    expect(onStartTutorial).toHaveBeenCalledOnce();
  });

  it('switches between collaboration host and join flows', () => {
    renderHome();

    fireEvent.click(screen.getByRole('button', { name: /协作/ }));
    expect(screen.getByRole('button', { name: /主持新剧本/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /主持已有剧本/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /加入房间/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /加入房间/ }));
    expect(screen.getByText('服务器')).toBeTruthy();
    expect(screen.getByText('本地协作工作区')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: '返回' })[1]);
    fireEvent.click(screen.getByRole('button', { name: /主持新剧本/ }));
    expect(screen.getByText('项目名称')).toBeTruthy();
    expect(screen.getByText('端口')).toBeTruthy();
  });

  it.each([
    { status: 'connecting' as const, label: '连接中', endpoint: '192.168.1.8:12345' },
    { status: 'seeding' as const, label: '准备协作', endpoint: '10.0.0.5:12345' },
  ])('shows the collaboration phase and server address on the home surface', ({ status, label, endpoint }) => {
    renderHome({ collaborationStatus: status, collaborationEndpoint: endpoint });

    fireEvent.click(screen.getByRole('button', { name: /协作/ }));

    const progress = screen.getByRole('status');
    expect(progress.textContent).toContain(label);
    expect(progress.textContent).toContain('服务器地址');
    expect(progress.textContent).toContain(endpoint);
  });

  it('renders shared upload progress and forwards the cancel action', () => {
    const onCancelResourceTransfer = vi.fn();
    renderHome({
      assetHandshake: makeTransferHandshake('uploading'),
      onCancelResourceTransfer,
    });

    fireEvent.click(screen.getByRole('button', { name: /协作/ }));

    const panel = screen.getByTestId('collaboration-asset-handshake');
    expect(panel.textContent).toContain('uploading/texture.png');
    expect(panel.textContent).toContain('上传');
    expect(panel.textContent).toContain('50%');
    expect(panel.textContent).toContain('1.0 KB / 2.0 KB');
    expect(panel.textContent).toContain('1/2 文件');

    fireEvent.click(screen.getByRole('button', { name: '取消传输' }));
    expect(onCancelResourceTransfer).toHaveBeenCalledOnce();
  });

  it('renders shared download progress with path, percentage, and byte totals', () => {
    renderHome({ assetHandshake: makeTransferHandshake('downloading') });

    fireEvent.click(screen.getByRole('button', { name: /协作/ }));

    const panel = screen.getByTestId('collaboration-asset-handshake');
    expect(panel.textContent).toContain('downloading/texture.png');
    expect(panel.textContent).toContain('下载');
    expect(panel.textContent).toContain('25%');
    expect(panel.textContent).toContain('1.0 KB / 4.0 KB');
    expect(panel.textContent).toContain('1/4 文件');
  });

  it('submits join flow with endpoint, display name, and selected local directory', () => {
    const onJoinCollaboration = vi.fn();
    renderHome({ onJoinCollaboration });

    fireEvent.click(screen.getByRole('button', { name: /协作/ }));
    fireEvent.click(screen.getByRole('button', { name: /加入房间/ }));
    fireEvent.change(screen.getByPlaceholderText('127.0.0.1:12345'), {
      target: { value: '192.168.1.8:12345' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^加入房间$/ }));

    expect(onJoinCollaboration).toHaveBeenCalledWith({
      endpoint: '192.168.1.8:12345',
      displayName: '导演',
      rootPath: 'D:/projects/AeonStagery Collaboration Session',
    });
  });

  it('provides a clean collaboration view without warning clutter, with password visibility toggle', () => {
    renderHome();

    fireEvent.click(screen.getByRole('button', { name: /协作/ }));
    expect(screen.queryByText(/资源同步会先确认，再写入/)).toBeNull();
    expect(screen.queryByText(/同步计划会先展示/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /加入房间/ }));
    expect(screen.queryByText(/加入前会校验服务器资源/)).toBeNull();
    expect(screen.queryByText(/确认后，服务器剧本会覆写本地项目的主剧本 JSON/)).toBeNull();

    const pwdInput = screen.getByPlaceholderText('输入主持人提供的密码') as HTMLInputElement;
    expect(pwdInput.type).toBe('password');
    const eyeToggle = screen.getByRole('button', { name: '显示密码' });
    fireEvent.click(eyeToggle);
    expect(pwdInput.type).toBe('text');
    expect(screen.getByRole('button', { name: '隐藏密码' })).toBeTruthy();
  });

  it('reads a selected WebGAL script and shows a conversion preview', async () => {
    const originalApi = (window as any).aeonStageryAPI;
    (window as any).aeonStageryAPI = {
      dialog: {
        showOpen: vi.fn(async () => ({ canceled: false, filePaths: ['D:/scripts/1.txt'] })),
      },
      fs: {
        readTextFile: vi.fn(async () => ({ success: true, data: 'changeBg:A.png;\n:你好;' })),
      },
    };
    try {
      renderHome();
      fireEvent.click(screen.getByRole('button', { name: /新建项目/ }));
      fireEvent.click(screen.getByRole('button', { name: /选择剧本文件/ }));
      expect(await screen.findByText(/对白 1 句/)).toBeTruthy();
      expect(screen.getByText(/背景 1 处/)).toBeTruthy();
      expect(screen.getByText(/1\.txt/)).toBeTruthy();
    } finally {
      (window as any).aeonStageryAPI = originalApi;
    }
  });

  it('shows an error when the selected WebGAL script cannot be read', async () => {
    const originalApi = (window as any).aeonStageryAPI;
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    (window as any).aeonStageryAPI = {
      dialog: {
        showOpen: vi.fn(async () => ({ canceled: false, filePaths: ['D:/scripts/missing.txt'] })),
      },
      fs: {
        readTextFile: vi.fn(async () => ({ success: false, error: 'ENOENT' })),
      },
    };
    try {
      renderHome();
      fireEvent.click(screen.getByRole('button', { name: /新建项目/ }));
      fireEvent.click(screen.getByRole('button', { name: /选择剧本文件/ }));
      await screen.findByRole('button', { name: /选择剧本文件/ });
      expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('读取 WebGAL 剧本失败'));
    } finally {
      alertSpy.mockRestore();
      (window as any).aeonStageryAPI = originalApi;
    }
  });

  it('navigates seamlessly through create subviews and returns via breadcrumbs and back buttons', () => {
    renderHome();

    // Start -> Create form
    fireEvent.click(screen.getByRole('button', { name: /新建项目/ }));
    expect(screen.getByPlaceholderText('例如：第 1 话演出稿')).toBeTruthy();
    expect(screen.getByRole('button', { name: '开始制作' })).toBeTruthy();

    // Create form -> Template capabilities
    fireEvent.click(screen.getByRole('button', { name: /配置模板能力/ }));
    expect(screen.getByText('服装模型导入方式')).toBeTruthy();
    expect(screen.getByText('默认对白样式')).toBeTruthy();
    expect(screen.queryByText('默认镜头')).toBeNull();
    expect(screen.queryByText('默认光照')).toBeNull();
    expect(screen.getByRole('button', { name: '新建项目' })).toBeTruthy();

    // Template capabilities -> Create form via breadcrumb
    fireEvent.click(screen.getByRole('button', { name: '新建项目' }));
    expect(screen.getByPlaceholderText('例如：第 1 话演出稿')).toBeTruthy();

    // Create form -> Start via breadcrumb
    fireEvent.click(screen.getByRole('button', { name: '开始制作' }));
    expect(screen.getByRole('button', { name: /开始教程/ })).toBeTruthy();
  });

  it('supports direct ancestor navigation via breadcrumbs in collaboration mode', () => {
    renderHome();

    // Start -> Collab
    fireEvent.click(screen.getByRole('button', { name: /协作/ }));
    expect(screen.getByRole('button', { name: /主持新剧本/ })).toBeTruthy();

    // Collab -> Host New
    fireEvent.click(screen.getByRole('button', { name: /主持新剧本/ }));
    expect(screen.getByPlaceholderText('例如：第 1 话协作')).toBeTruthy();

    // Click '开始制作' breadcrumb to return directly to root start view
    fireEvent.click(screen.getByRole('button', { name: '开始制作' }));
    expect(screen.getByRole('button', { name: /新建项目/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /开始教程/ })).toBeTruthy();
  });
  it('defaults hosting to network access and forwards a local-only/password choice', async () => {
    const onHostExistingCollaboration = vi.fn(async () => undefined);
    renderHome({ onHostExistingCollaboration });
    fireEvent.click(screen.getByRole('button', { name: /协作/ }));
    fireEvent.click(screen.getByRole('button', { name: /主持已有剧本/ }));
    const network = screen.getByRole('checkbox', { name: /允许其他设备连接/ }) as HTMLInputElement;
    expect(network.checked).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('留空自动生成随机密码'), { target: { value: 'my room password' } });
    fireEvent.click(network);
    fireEvent.click(screen.getByRole('button', { name: /选择项目并主持/ }));
    await waitFor(() => expect(onHostExistingCollaboration).toHaveBeenCalledWith({
      displayName: '导演', port: 12345, allowNetwork: false, password: 'my room password',
    }));
  });

  it('forwards a manual connection password without adding it to the address', () => {
    const onJoinCollaboration = vi.fn(async () => undefined);
    renderHome({ onJoinCollaboration });
    fireEvent.click(screen.getByRole('button', { name: /协作/ }));
    fireEvent.click(screen.getByRole('button', { name: /加入房间/ }));
    fireEvent.change(screen.getByPlaceholderText('输入主持人提供的密码'), { target: { value: 'my room password' } });
    fireEvent.click(screen.getByRole('button', { name: /^加入房间$/ }));
    expect(onJoinCollaboration).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '127.0.0.1:12345', password: 'my room password',
    }));
  });

  it('switches directly between collaboration modes using segmented tabs without menu bounce', () => {
    renderHome();

    fireEvent.click(screen.getByRole('button', { name: /协作/ }));
    fireEvent.click(screen.getByRole('button', { name: /加入房间/ }));
    expect(screen.getByText('服务器')).toBeTruthy();

    // Directly switch to host existing via tab
    fireEvent.click(screen.getByRole('tab', { name: '切换到主持已有剧本' }));
    expect(screen.getByRole('button', { name: /选择项目并主持/ })).toBeTruthy();

    // Directly switch to host new via tab
    fireEvent.click(screen.getByRole('tab', { name: '切换到主持新剧本' }));
    expect(screen.getByPlaceholderText('例如：第 1 话协作')).toBeTruthy();
    expect(screen.getByRole('button', { name: /创建并主持/ })).toBeTruthy();
  });

  it('renders server credentials card with view and copy capabilities for password and token', () => {
    const onStopCollaborationServer = vi.fn();
    renderHome({
      collaborationServerStatus: {
        running: true,
        host: '127.0.0.1',
        port: 12345,
        dataDir: 'D:/data',
        localUrl: 'http://127.0.0.1:12345',
        lanUrls: ['http://192.168.1.10:12345'],
        connectionPassword: 'secret-password',
        accessToken: 'secret-access-token-12345',
        inviteUrls: ['http://192.168.1.10:12345/#token=secret-access-token-12345'],
        assetRoot: 'D:/data/assets',
        hasState: true,
      },
      onStopCollaborationServer,
    });

    fireEvent.click(screen.getByRole('button', { name: /协作/ }));

    // Status header is rendered
    expect(screen.getByText(/本机服务器 运行中/)).toBeTruthy();
    expect(screen.getByText('http://127.0.0.1:12345')).toBeTruthy();
    expect(screen.getByRole('button', { name: '停止服务器' })).toBeTruthy();

    // Invite URL item
    expect(screen.getByDisplayValue('http://192.168.1.10:12345/#token=secret-access-token-12345')).toBeTruthy();
    expect(screen.getByRole('button', { name: '复制链接' })).toBeTruthy();

    // Password item with eye toggle
    const pwdInput = screen.getByLabelText('协作连接密码') as HTMLInputElement;
    expect(pwdInput.value).toBe('secret-password');
    expect(pwdInput.type).toBe('password');
    const pwdEye = screen.getAllByRole('button', { name: '显示密码' })[0];
    fireEvent.click(pwdEye);
    expect(pwdInput.type).toBe('text');
    expect(screen.getByRole('button', { name: '复制密码' })).toBeTruthy();

    // Token item with eye toggle
    const tokenInput = screen.getByLabelText('协作访问 Token') as HTMLInputElement;
    expect(tokenInput.value).toBe('secret-access-token-12345');
    expect(tokenInput.type).toBe('password');
    const tokenEye = screen.getByRole('button', { name: '显示 Token' });
    fireEvent.click(tokenEye);
    expect(tokenInput.type).toBe('text');
    expect(screen.getByRole('button', { name: '复制 Token' })).toBeTruthy();

    // Details initially hidden
    expect(screen.queryByText('资源目录')).toBeNull();

    // Toggle details
    fireEvent.click(screen.getByRole('button', { name: '连接详情' }));
    expect(screen.getByText('资源目录')).toBeTruthy();
    expect(screen.getByText('http://192.168.1.10:12345')).toBeTruthy();

    // Stop server action
    fireEvent.click(screen.getByRole('button', { name: '停止服务器' }));
    expect(onStopCollaborationServer).toHaveBeenCalledOnce();
  });

});
