/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportProgress, ExportResult } from '../api/types/export';
import { DEFAULT_PROJECT_ASSET_ROOTS, type ProjectState } from '../api/types/project';

const mocks = vi.hoisted(() => ({
  export: vi.fn(),
  playback: { getDuration: () => 10 },
  project: null as ProjectState | null,
}));
vi.mock('../ui/context/AppContext', () => ({
  useOptionalApp: () => ({ services: { projectWorkspace: { subscribe: () => () => {}, getCurrentProject: () => mocks.project } } }),
  usePlaybackAdapter: () => mocks.playback,
  useExportAdapter: () => ({ export: mocks.export }),
}));

import ExportDialog from '../ui/ExportDialog';

describe('ExportDialog cancellation', () => {
  it('applies high quality without opening advanced settings', async () => {
    mocks.export.mockResolvedValue({ success: true });
    const view = render(<ExportDialog onClose={vi.fn()} />);
    expect(view.container.querySelector('details')?.open).toBe(false);
    fireEvent.click(screen.getByRole('combobox', { name: '编码质量' }));
    fireEvent.click(screen.getByRole('option', { name: '高画质' }));
    expect(Number((screen.getByLabelText('目标码率 (Mbps)') as HTMLInputElement).value)).toBe(20);
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    await screen.findByRole('button', { name: '关闭' });
    expect(mocks.export).toHaveBeenCalledWith(expect.objectContaining({ encoding: expect.objectContaining({ quality: 'high', allowH264Intermediate: false }) }), expect.any(Function), expect.any(AbortSignal));
  });

  it('passes custom CRF and intermediate bitrate to the exporter', async () => {
    mocks.export.mockResolvedValue({ success: true });
    render(<ExportDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('combobox', { name: '编码标准' }));
    fireEvent.click(screen.getByRole('option', { name: 'H.265 / HEVC' }));
    fireEvent.click(screen.getByText('高级编码设置'));
    fireEvent.change(screen.getByLabelText('CRF'), { target: { value: '17' } });
    fireEvent.change(screen.getByLabelText('中间流码率 (Mbps)'), { target: { value: '42.5' } });
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    await screen.findByRole('button', { name: '关闭' });
    expect(mocks.export).toHaveBeenCalledWith(expect.objectContaining({ encoding: expect.objectContaining({ quality: 'custom', rateControl: { mode: 'crf', crf: 17 }, intermediateBitrateMbps: 42.5 }) }), expect.any(Function), expect.any(AbortSignal));
  });

  beforeEach(() => {
    mocks.export.mockReset();
    mocks.project = null;
    vi.stubGlobal('aeonStageryAPI', {
      dialog: { showSave: vi.fn().mockResolvedValue({ canceled: false, filePath: '/output/test.mp4' }) },
    });
  });

  it('defaults to project format and supports a custom 4K frame rate', async () => {
    mocks.project = {
      rootPath: '/project', projectFilePath: '/project/project.json',
      metadata: { projectId: 'video', name: 'Video', projectVersion: 2, createdAt: 'now', updatedAt: 'now', defaultSceneId: 'main', scenes: [], assetRoots: DEFAULT_PROJECT_ASSET_ROOTS, videoFormat: { width: 1080, height: 1920, fps: 30 } },
    };
    mocks.export.mockResolvedValue({ success: true });
    const view = render(<ExportDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    await screen.findByRole('button', { name: '关闭' });
    expect(mocks.export).toHaveBeenCalledWith(expect.objectContaining({ width: 1080, height: 1920, fps: 30 }), expect.any(Function), expect.any(AbortSignal));
    view.unmount();
    render(<ExportDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: '跟随项目分辨率与帧率' }));
    fireEvent.change(screen.getByLabelText('宽度 (px)'), { target: { value: '3840' } });
    fireEvent.change(screen.getByLabelText('高度 (px)'), { target: { value: '2160' } });
    fireEvent.change(screen.getByLabelText('帧率 (fps)'), { target: { value: '29.97' } });
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    await screen.findByRole('button', { name: '关闭' });
    expect(mocks.export).toHaveBeenLastCalledWith(expect.objectContaining({ width: 3840, height: 2160, fps: 29.97, fit: 'contain' }), expect.any(Function), expect.any(AbortSignal));
  });

  it('blocks export with invalid custom dimensions before opening the save dialog', () => {
    render(<ExportDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: '跟随项目分辨率与帧率' }));
    fireEvent.change(screen.getByLabelText('宽度 (px)'), { target: { value: '1921' } });
    expect(screen.getByRole('button', { name: '开始导出' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('偶数');
    expect(window.aeonStageryAPI.dialog.showSave).not.toHaveBeenCalled();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each(['capture', 'mix'] as const)('can cancel during %s and waits for cleanup', async (phase) => {
    let signal!: AbortSignal;
    let progress!: (p: ExportProgress) => void;
    let finish!: (result: ExportResult) => void;
    mocks.export.mockImplementation((_config, onProgress, exportSignal) => {
      signal = exportSignal;
      progress = onProgress;
      return new Promise<ExportResult>((resolve) => { finish = resolve; });
    });
    render(<ExportDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    const cancel = await screen.findByRole('button', { name: '取消导出' });
    act(() => progress({ phase, percent: 40 }));
    fireEvent.click(cancel);
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole('button', { name: '正在取消...' }).hasAttribute('disabled')).toBe(true);
    act(() => progress({ phase, percent: 80 }));
    expect(screen.getByRole('status').textContent).toContain('正在取消导出');
    await act(async () => finish({ success: false, cancelled: true }));
    expect(screen.getByRole('status').textContent).toBe('导出已取消');
    expect(screen.queryByText('导出失败')).toBeNull();
    expect(screen.getByRole('button', { name: '关闭' })).toBeDefined();
  });

  it('renders success actions, displays file size, and supports revealing file in manager', async () => {
    const showItemInFolder = vi.fn().mockResolvedValue({ success: true });
    vi.stubGlobal('aeonStageryAPI', {
      dialog: { showSave: vi.fn().mockResolvedValue({ canceled: false, filePath: '/output/test.mp4' }) },
      fs: {
        showItemInFolder,
        stat: vi.fn().mockResolvedValue({ success: true, data: { sizeBytes: 15 * 1024 * 1024 } }),
      },
    });

    mocks.export.mockResolvedValue({ success: true });
    render(<ExportDialog onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    await screen.findByRole('status');
    expect(screen.getByText('导出完成！')).toBeDefined();
    expect(await screen.findByText('15.0 MB')).toBeDefined();

    const revealBtn = screen.getByRole('button', { name: '打开所在文件夹' });
    fireEvent.click(revealBtn);
    expect(showItemInFolder).toHaveBeenCalledWith('/output/test.mp4');

    const againBtn = screen.getByRole('button', { name: '再导出一份' });
    fireEvent.click(againBtn);
    expect(screen.getByRole('button', { name: '开始导出' })).toBeDefined();
  });

  it('closes dialog when header close button is clicked', () => {
    const onClose = vi.fn();
    render(<ExportDialog onClose={onClose} />);
    const closeBtn = screen.getByRole('button', { name: '关闭窗口' });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it('adapts recommended bitrate when resolution and codec change', () => {
    render(<ExportDialog onClose={vi.fn()} />);

    // Default 1080p @ 60fps project format with H.264 recommends 14 Mbps
    const bitrateInput = screen.getByLabelText('目标码率 (Mbps)') as HTMLInputElement;
    expect(Number(bitrateInput.value)).toBe(14);

    // Switch to custom 4K resolution
    fireEvent.click(screen.getByRole('checkbox', { name: '跟随项目分辨率与帧率' }));
    fireEvent.change(screen.getByLabelText('宽度 (px)'), { target: { value: '3840' } });
    fireEvent.change(screen.getByLabelText('高度 (px)'), { target: { value: '2160' } });

    // Bitrate automatically adapts to 4K recommendation (~40 Mbps)
    expect(Number(bitrateInput.value)).toBe(40);

    // User manual override
    fireEvent.change(bitrateInput, { target: { value: '25' } });
    expect(Number(bitrateInput.value)).toBe(25);

    // Changing resolution further does not override user's manual value
    fireEvent.change(screen.getByLabelText('宽度 (px)'), { target: { value: '1920' } });
    fireEvent.change(screen.getByLabelText('高度 (px)'), { target: { value: '1080' } });
    expect(Number(bitrateInput.value)).toBe(25);
  });
});
