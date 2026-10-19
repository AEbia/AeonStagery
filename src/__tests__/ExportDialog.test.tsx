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
});
