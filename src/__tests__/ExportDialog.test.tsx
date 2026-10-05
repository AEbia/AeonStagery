/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportProgress, ExportResult } from '../api/types/export';

const mocks = vi.hoisted(() => ({
  export: vi.fn(),
  playback: { getDuration: () => 10 },
}));
vi.mock('../ui/context/AppContext', () => ({
  usePlaybackAdapter: () => mocks.playback,
  useExportAdapter: () => ({ export: mocks.export }),
}));

import ExportDialog from '../ui/ExportDialog';

describe('ExportDialog cancellation', () => {
  beforeEach(() => {
    mocks.export.mockReset();
    vi.stubGlobal('aeonStageryAPI', {
      dialog: { showSave: vi.fn().mockResolvedValue({ canceled: false, filePath: '/output/test.mp4' }) },
    });
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
