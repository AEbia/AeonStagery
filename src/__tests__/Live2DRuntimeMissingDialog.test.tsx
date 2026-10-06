/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Live2DRuntimeMissingDialog } from '../ui/live2d/Live2DRuntimeMissingDialog';
import type { Live2DRuntimeStatusReport } from '../api/types/live2dRuntime';

describe('Live2DRuntimeMissingDialog', () => {
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
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
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

    expect(screen.getByText('Live2D Cubism 运行时配置引导')).toBeInTheDocument();
    expect(screen.getByText(/不随附任何 Live2D Inc. 专有运行时核心代码/)).toBeInTheDocument();
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
    expect(screen.getByText('完成并进入')).toBeInTheDocument();
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

  it('copies path and sync command to clipboard when copy buttons are clicked', async () => {
    render(
      <Live2DRuntimeMissingDialog
        isOpen={true}
        onClose={vi.fn()}
        report={defaultReport}
      />,
    );

    const copyButtons = screen.getAllByTitle('复制路径');
    expect(copyButtons.length).toBeGreaterThanOrEqual(1);

    fireEvent.click(copyButtons[0]);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('.local/live2d/live2d.min.js');

    const copyCmdBtn = screen.getByTitle('复制同步命令');
    fireEvent.click(copyCmdBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('npm run sync:live2d-runtime');
  });
});
