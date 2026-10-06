/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Live2DRuntimeMissingDialog } from '../ui/live2d/Live2DRuntimeMissingDialog';
import type { Live2DRuntimeStatusReport } from '../api/types/live2dRuntime';

describe('Live2DRuntimeMissingDialog', () => {
  const originalElectronApi = window.aeonStageryAPI;
  const defaultReport: Live2DRuntimeStatusReport = {
    cubism2: false,
    cubism3Plus: true,
    missingAny: true,
    isDev: true,
    paths: {
      localDir: '.local/live2d',
      seedRoot: 'public',
      runtimeRoot: 'userData/live2d-runtime',
    },
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, 'aeonStageryAPI');
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    window.aeonStageryAPI = originalElectronApi;
    vi.restoreAllMocks();
  });

  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <Live2DRuntimeMissingDialog
        isOpen={false}
        onClose={vi.fn()}
        report={defaultReport}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders title, notice, and both runtime cards when isOpen is true', () => {
    render(
      <Live2DRuntimeMissingDialog
        isOpen={true}
        onClose={vi.fn()}
        report={defaultReport}
      />,
    );

    expect(screen.getByText('Live2D 运行时配置引导')).toBeInTheDocument();
    expect(screen.getByText(/本软件不随附 Live2D 运行时/)).toBeInTheDocument();
    expect(screen.getByText('Cubism 2.1 核心运行时')).toBeInTheDocument();
    expect(screen.getByText('Cubism 3/4/5 核心运行时')).toBeInTheDocument();
    expect(screen.getAllByText('live2d.min.js').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('live2dcubismcore.min.js').length).toBeGreaterThanOrEqual(1);
  });

  it('shows missing badge for Cubism 2 and ready badge for Cubism 3/4/5 in default report', () => {
    render(
      <Live2DRuntimeMissingDialog
        isOpen={true}
        onClose={vi.fn()}
        report={defaultReport}
      />,
    );

    expect(screen.getByText('缺失')).toBeInTheDocument();
    expect(screen.getByText('已就绪')).toBeInTheDocument();
  });

  it('shows both missing when report has both false', () => {
    const bothMissing: Live2DRuntimeStatusReport = {
      ...defaultReport,
      cubism2: false,
      cubism3Plus: false,
      missingAny: true,
    };

    render(
      <Live2DRuntimeMissingDialog
        isOpen={true}
        onClose={vi.fn()}
        report={bothMissing}
      />,
    );

    const badges = screen.getAllByText('缺失');
    expect(badges.length).toBe(2);
  });

  it('shows both ready when both are present', () => {
    const bothReady: Live2DRuntimeStatusReport = {
      ...defaultReport,
      cubism2: true,
      cubism3Plus: true,
      missingAny: false,
    };

    render(
      <Live2DRuntimeMissingDialog
        isOpen={true}
        onClose={vi.fn()}
        report={bothReady}
      />,
    );

    const readyBadges = screen.getAllByText('已就绪');
    expect(readyBadges.length).toBe(2);
    expect(screen.getByText('配置完成，进入')).toBeInTheDocument();
  });

  it('calls onClose when close icon or dismiss button is clicked', () => {
    const handleClose = vi.fn();
    render(
      <Live2DRuntimeMissingDialog
        isOpen={true}
        onClose={handleClose}
        report={defaultReport}
      />,
    );

    fireEvent.click(screen.getByTitle('关闭引导'));
    expect(handleClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('我知道了 / 稍后配置'));
    expect(handleClose).toHaveBeenCalledTimes(2);
  });

  it('calls onClose when Escape key is pressed', () => {
    const handleClose = vi.fn();
    render(
      <Live2DRuntimeMissingDialog
        isOpen={true}
        onClose={handleClose}
        report={defaultReport}
      />,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('calls onRefresh and updates status when refresh button is clicked', async () => {
    const updatedReport: Live2DRuntimeStatusReport = {
      ...defaultReport,
      cubism2: true,
      cubism3Plus: true,
      missingAny: false,
    };
    const handleRefresh = vi.fn().mockResolvedValue(updatedReport);

    render(
      <Live2DRuntimeMissingDialog
        isOpen={true}
        onClose={vi.fn()}
        report={defaultReport}
        onRefresh={handleRefresh}
      />,
    );

    fireEvent.click(screen.getByText('重新检测'));
    expect(handleRefresh).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      const readyBadges = screen.getAllByText('已就绪');
      expect(readyBadges.length).toBe(2);
    });
  });

  it('copies path to clipboard when copy path button is clicked', async () => {
    render(
      <Live2DRuntimeMissingDialog
        isOpen={true}
        onClose={vi.fn()}
        report={defaultReport}
      />,
    );

    const copyBtn = screen.getByTitle('复制目录路径');
    fireEvent.click(copyBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('userData/live2d-runtime');
  });

  it('guides browser users to public and does not require an unavailable directory button', () => {
    render(
      <Live2DRuntimeMissingDialog
        isOpen={true}
        onClose={vi.fn()}
        report={{ ...defaultReport, paths: { localDir: '.local/live2d', runtimeRoot: 'public' } }}
      />,
    );

    expect(screen.getByText(/项目根目录下的/)).toHaveTextContent('public');
    expect(screen.queryByRole('button', { name: '打开运行时目录' })).not.toBeInTheDocument();
    expect(screen.getByText(/检测到所需运行时后刷新页面/)).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('复制目录路径'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('public');
  });

  it('uses public as the browser target before a status report is available', () => {
    render(<Live2DRuntimeMissingDialog isOpen={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByTitle('复制目录路径'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('public');
  });

  it('keeps the desktop fallback when the Electron status report has no path', () => {
    window.aeonStageryAPI = {} as NonNullable<Window['aeonStageryAPI']>;
    render(
      <Live2DRuntimeMissingDialog
        isOpen={true}
        onClose={vi.fn()}
        report={{ ...defaultReport, paths: { localDir: '' } }}
      />,
    );

    fireEvent.click(screen.getByTitle('复制目录路径'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('%APPDATA%\\AeonStagery\\live2d-runtime');
    expect(screen.getByRole('button', { name: '打开运行时目录' })).toBeInTheDocument();
    expect(screen.queryByText(/项目根目录下的/)).not.toBeInTheDocument();
  });

  it.each(['cubism2', 'cubism3Plus'] as const)('offers a working restart after installing only %s', async (family) => {
    const restart = vi.fn().mockResolvedValue({ success: true });
    window.aeonStageryAPI = { app: { restart } } as unknown as NonNullable<Window['aeonStageryAPI']>;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const initialReport = { ...defaultReport, cubism2: false, cubism3Plus: false };
    const onRefresh = vi.fn().mockResolvedValue({ ...initialReport, [family]: true });
    render(
      <Live2DRuntimeMissingDialog
        isOpen={true}
        onClose={vi.fn()}
        report={initialReport}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByText('重新检测'));
    const restartButton = await screen.findByRole('button', { name: '重启应用以加载' });
    expect(screen.getAllByText('已就绪')).toHaveLength(1);
    expect(screen.getAllByText('缺失')).toHaveLength(1);

    // A second scan must retain the pending restart for the already discovered file.
    fireEvent.click(screen.getByText('重新检测'));
    await waitFor(() => expect(screen.getByRole('button', { name: '重新检测' })).toBeEnabled());
    expect(onRefresh).toHaveBeenCalledTimes(2);
    fireEvent.click(restartButton);
    await waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
  });

  it('offers a page refresh after installing one runtime in the browser', async () => {
    const initialReport = {
      ...defaultReport,
      cubism2: false,
      cubism3Plus: false,
      paths: { localDir: '.local/live2d', runtimeRoot: 'public' },
    };
    render(
      <Live2DRuntimeMissingDialog
        isOpen={true}
        onClose={vi.fn()}
        report={initialReport}
        onRefresh={vi.fn().mockResolvedValue({ ...initialReport, cubism2: true })}
      />,
    );

    fireEvent.click(screen.getByText('重新检测'));
    expect(await screen.findByRole('button', { name: '刷新页面以加载' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '稍后刷新' })).toBeInTheDocument();
  });
});
