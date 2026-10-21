/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportProgress, ExportResult } from '../api/types/export';
import type { ExportSizeEstimateConfig, ExportSizeEstimate } from '../api/exportSizeEstimate';
import { resolveExportEncoding } from '../api/exportEncoding';
import { DEFAULT_PROJECT_ASSET_ROOTS, type ProjectState } from '../api/types/project';

const mocks = vi.hoisted(() => ({
  export: vi.fn(),
  estimateSize: vi.fn(),
  playback: { getDuration: () => 10 },
  project: null as ProjectState | null,
}));
vi.mock('../ui/context/AppContext', () => ({
  useOptionalApp: () => ({ services: { projectWorkspace: { subscribe: () => () => {}, getCurrentProject: () => mocks.project } } }),
  usePlaybackAdapter: () => mocks.playback,
  useExportAdapter: () => ({ export: mocks.export, estimateSize: mocks.estimateSize }),
}));

import ExportDialog from '../ui/ExportDialog';

describe('ExportDialog cancellation', () => {
  const select = (label: string, option: string | RegExp) => {
    fireEvent.click(screen.getByRole('combobox', { name: label }));
    fireEvent.click(screen.getByRole('option', { name: option }));
  };

  it('uses the main bitrate by default for FFmpeg, including the export configuration', async () => {
    mocks.export.mockResolvedValue({ success: true });
    render(<ExportDialog onClose={vi.fn()} />);
    select('编码方式', 'FFmpeg');
    expect(screen.getByRole('combobox', { name: 'FFmpeg 质量控制' }).textContent).toContain('目标码率');
    expect(screen.queryByLabelText('CRF')).toBeNull();
    expect(screen.queryByLabelText('FFmpeg 码率 (Mbps)')).toBeNull();
    fireEvent.change(screen.getByLabelText('目标码率 (Mbps)'), { target: { value: '12.5' } });
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    await screen.findByRole('button', { name: '关闭' });
    const config = mocks.export.mock.calls[0][0];
    expect(resolveExportEncoding(config).rateControl).toEqual({ mode: 'bitrate', bitrateMbps: 12.5 });
  });

  it('syncs the bitrate slider with precise input and exports the dragged value', async () => {
    mocks.export.mockResolvedValue({ success: true });
    render(<ExportDialog onClose={vi.fn()} />);
    const slider = screen.getByRole('slider', { name: '目标码率滑块 (Mbps)' }) as HTMLInputElement;
    const input = screen.getByLabelText('目标码率 (Mbps)') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '125.5' } });
    expect(slider.value).toBe('125.5');
    expect(Number(slider.max)).toBeGreaterThanOrEqual(125.5);
    fireEvent.change(slider, { target: { value: '18.5' } });
    expect(input.value).toBe('18.5');
    expect(slider.getAttribute('aria-valuetext')).toBe('18.5 Mbps');
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    await screen.findByRole('button', { name: '关闭' });
    expect(resolveExportEncoding(mocks.export.mock.calls[0][0]).rateControl).toEqual({ mode: 'bitrate', bitrateMbps: 18.5 });
  });

  it.each(['bitrate', 'crf'] as const)('does not exceed the update depth during a continuous %s drag', async mode => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const actEnvironment: unknown = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    try {
      render(<ExportDialog onClose={vi.fn()} />);
      if (mode === 'crf') {
        select('编码方式', 'FFmpeg');
        select('FFmpeg 质量控制', '恒定质量 (CRF)');
      }
      const slider = screen.getByRole('slider', { name: mode === 'crf' ? 'CRF 滑块' : '目标码率滑块 (Mbps)' });
      fireEvent.pointerDown(slider);
      // act flushes pending effects after each event and hides this bug. Use
      // native input events separated only by microtasks to model a rapid drag.
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      for (let index = 1; index <= 160; index += 1) {
        setValue.call(slider, String(mode === 'crf' ? index % 52 : 10 + index / 10));
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        await Promise.resolve();
      }
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', actEnvironment);
      fireEvent.pointerUp(window);
      expect((screen.getByLabelText(mode === 'crf' ? 'CRF' : '目标码率 (Mbps)') as HTMLInputElement).value).toBe(mode === 'crf' ? '4' : '26');
      expect(errors.mock.calls.filter(args => String(args[0]).includes('Maximum update depth exceeded'))).toEqual([]);
    } finally {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', actEnvironment);
      errors.mockRestore();
    }
  });

  it('uses codec-specific CRF slider bounds and exports zero CRF', async () => {
    mocks.export.mockResolvedValue({ success: true });
    render(<ExportDialog onClose={vi.fn()} />);
    select('编码方式', 'FFmpeg');
    select('FFmpeg 质量控制', '恒定质量 (CRF)');
    const slider = screen.getByRole('slider', { name: 'CRF 滑块' }) as HTMLInputElement;
    expect(slider.max).toBe('51');
    select('编码标准', 'AV1');
    expect(slider.max).toBe('63');
    fireEvent.change(screen.getByLabelText('CRF'), { target: { value: '17' } });
    expect(slider.value).toBe('17');
    fireEvent.change(slider, { target: { value: '0' } });
    expect((screen.getByLabelText('CRF') as HTMLInputElement).value).toBe('0');
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    await screen.findByRole('button', { name: '关闭' });
    expect(resolveExportEncoding(mocks.export.mock.calls[0][0]).rateControl).toEqual({ mode: 'crf', crf: 0 });
  });

  it.each(['自动', 'WebCodecs'])('hides inactive FFmpeg controls in %s mode', mode => {
    render(<ExportDialog onClose={vi.fn()} />);
    select('编码方式', mode);
    select('编码标准', 'H.265 / HEVC');
    expect(screen.queryByRole('combobox', { name: 'FFmpeg 编码器' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'FFmpeg 质量控制' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'FFmpeg 编码速度' })).toBeNull();
    expect(screen.queryByLabelText('CRF')).toBeNull();
    expect(screen.getByLabelText('目标码率 (Mbps)')).toBeDefined();
    expect(screen.getByLabelText('允许 H.264 中转加速')).toBeDefined();
  });

  it.each(['均衡', '高画质'])('preserves the %s preset when switching codecs', quality => {
    render(<ExportDialog onClose={vi.fn()} />);
    select('编码质量', quality);
    select('编码标准', 'H.265 / HEVC');
    expect(screen.getByRole('combobox', { name: '编码质量' }).textContent).toContain(quality);
    expect(Number((screen.getByLabelText('目标码率 (Mbps)') as HTMLInputElement).value)).toBe(quality === '高画质' ? 13 : 9);
    if (quality === '高画质') {
      expect((screen.getByLabelText('允许 H.264 中转加速') as HTMLInputElement).checked).toBe(false);
    }
  });

  it('shows only the active rate control and reuses the main bitrate when switching paths', async () => {
    mocks.export.mockResolvedValue({ success: true });
    render(<ExportDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('目标码率 (Mbps)'), { target: { value: '12.5' } });
    select('编码方式', 'FFmpeg');
    select('FFmpeg 质量控制', '恒定质量 (CRF)');
    fireEvent.change(screen.getByLabelText('CRF'), { target: { value: '17' } });
    expect(screen.queryByLabelText('目标码率 (Mbps)')).toBeNull();
    select('编码方式', 'WebCodecs');
    expect(screen.queryByLabelText('CRF')).toBeNull();
    expect((screen.getByLabelText('目标码率 (Mbps)') as HTMLInputElement).value).toBe('12.5');
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    await screen.findByRole('button', { name: '关闭' });
    expect(resolveExportEncoding(mocks.export.mock.calls[0][0]).rateControl).toEqual({ mode: 'bitrate', bitrateMbps: 12.5 });
  });

  it('preserves high-quality defaults when changing advanced settings', async () => {
    mocks.export.mockResolvedValue({ success: true });
    render(<ExportDialog onClose={vi.fn()} />);
    select('编码标准', 'H.265 / HEVC');
    select('编码质量', '高画质');
    select('编码方式', 'FFmpeg');
    select('FFmpeg 质量控制', '恒定质量 (CRF)');
    expect((screen.getByLabelText('CRF') as HTMLInputElement).value).toBe('20');
    select('FFmpeg 编码速度', '快速');
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    await screen.findByRole('button', { name: '关闭' });
    expect(mocks.export).toHaveBeenCalledWith(expect.objectContaining({
      encoding: expect.objectContaining({ allowH264Intermediate: false, rateControl: { mode: 'crf', crf: 20 } }),
    }), expect.any(Function), expect.any(AbortSignal));
  });

  it('retains compatible codec settings when changing containers or clicking the selected container', () => {
    render(<ExportDialog onClose={vi.fn()} />);
    select('编码标准', 'AV1');
    select('编码质量', '高画质');
    select('编码方式', 'FFmpeg');
    select('FFmpeg 质量控制', '恒定质量 (CRF)');
    select('编码质量', '高画质');
    for (const name of [/MP4 \(\.mp4\)/, /MKV \(\.mkv\)/, /WebM \(\.webm\)/]) {
      fireEvent.click(screen.getByRole('button', { name }));
      expect(screen.getByRole('combobox', { name: '编码标准' }).textContent).toContain('AV1');
      expect(screen.getByRole('combobox', { name: '编码质量' }).textContent).toContain('高画质');
      expect((screen.getByLabelText('CRF') as HTMLInputElement).value).toBe('28');
    }
  });

  it('keeps custom values when selecting custom quality or exporting again', async () => {
    mocks.export.mockResolvedValue({ success: true });
    render(<ExportDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('目标码率 (Mbps)'), { target: { value: '12.5' } });
    select('编码方式', 'FFmpeg');
    select('FFmpeg 质量控制', '恒定质量 (CRF)');
    fireEvent.change(screen.getByLabelText('CRF'), { target: { value: '17' } });
    select('编码质量', '自定义');
    expect((screen.getByLabelText('CRF') as HTMLInputElement).value).toBe('17');
    select('FFmpeg 质量控制', '目标码率');
    expect((screen.getByLabelText('目标码率 (Mbps)') as HTMLInputElement).value).toBe('12.5');
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    await screen.findByRole('button', { name: '再导出一份' });
    fireEvent.click(screen.getByRole('button', { name: '再导出一份' }));
    expect((screen.getByLabelText('目标码率 (Mbps)') as HTMLInputElement).value).toBe('12.5');
  });

  it('shows bitrate controls for green-screen subtitles while keeping the required pipeline fixed', async () => {
    mocks.export.mockResolvedValue({ success: true });
    render(<ExportDialog onClose={vi.fn()} />);
    select('字幕层导出模式', /独立字幕轨.*MP4 H\.264.*绿幕背景/);
    expect(screen.queryByRole('combobox', { name: '编码标准' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: '编码方式' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'FFmpeg 编码器' })).toBeNull();
    fireEvent.change(screen.getByLabelText('目标码率 (Mbps)'), { target: { value: '6.5' } });
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    await screen.findByRole('button', { name: '关闭' });
    expect(mocks.export).toHaveBeenCalledWith(expect.objectContaining({
      subtitleChroma: true, format: 'mp4', codec: 'libx264', backend: 'rawpixels',
      encoding: expect.objectContaining({ implementation: 'ffmpeg', rateControl: { mode: 'bitrate', bitrateMbps: 6.5 } }),
    }), expect.any(Function), expect.any(AbortSignal));
  });

  it('keeps transparent subtitle export on its fixed ProRes pipeline without bitrate or CRF controls', async () => {
    mocks.export.mockResolvedValue({ success: true });
    render(<ExportDialog onClose={vi.fn()} />);
    select('字幕层导出模式', /独立字幕轨.*MOV Apple ProRes 4444.*透明通道/);
    expect(screen.queryByLabelText('目标码率 (Mbps)')).toBeNull();
    expect(screen.queryByLabelText('CRF')).toBeNull();
    expect(screen.queryByRole('combobox', { name: '编码方式' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    await screen.findByRole('button', { name: '关闭' });
    expect(mocks.export).toHaveBeenCalledWith(expect.objectContaining({
      subtitleOnly: true, format: 'mov', codec: 'prores_ks', backend: 'rawpixels',
      encoding: expect.objectContaining({ videoCodec: 'prores', implementation: 'ffmpeg' }),
    }), expect.any(Function), expect.any(AbortSignal));
  });

  it('uses only active rate control for size estimates', async () => {
    vi.useFakeTimers();
    render(<ExportDialog onClose={vi.fn()} />);
    select('编码方式', 'FFmpeg');
    select('FFmpeg 质量控制', '恒定质量 (CRF)');
    fireEvent.change(screen.getByLabelText('CRF'), { target: { value: '17' } });
    await act(async () => vi.advanceTimersByTime(600));
    expect(mocks.estimateSize).toHaveBeenLastCalledWith(expect.objectContaining({
      encoding: expect.objectContaining({ implementation: 'ffmpeg', rateControl: { mode: 'crf', crf: 17 } }),
    }), expect.any(AbortSignal));
    select('编码方式', '自动');
    await act(async () => vi.advanceTimersByTime(600));
    expect(mocks.estimateSize).toHaveBeenLastCalledWith(expect.objectContaining({
      encoding: expect.objectContaining({ implementation: 'auto', rateControl: { mode: 'bitrate', bitrateMbps: 14 } }),
    }), expect.any(AbortSignal));
  });

  it.each([
    ['H.264', 'h264', 'libx264'], ['H.265 / HEVC', 'hevc', 'libx265'],
    ['VP9', 'vp9', 'libvpx-vp9'], ['AV1', 'av1', 'libaom-av1'],
  ])('exports MKV with %s and a matching save filter', async (label, videoCodec, codec) => {
    mocks.export.mockResolvedValue({ success: true });
    vi.mocked(window.aeonStageryAPI.dialog.showSave).mockResolvedValue({ canceled: false, filePath: '/output/test.mkv' });
    render(<ExportDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /MKV \(\.mkv\)/ }));
    fireEvent.click(screen.getByRole('combobox', { name: '编码标准' }));
    fireEvent.click(screen.getByRole('option', { name: label }));
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    await screen.findByRole('button', { name: '关闭' });
    expect(window.aeonStageryAPI.dialog.showSave).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: expect.stringMatching(/\.mkv$/),
      filters: [{ name: 'MKV Video', extensions: ['mkv'] }],
    }));
    expect(mocks.export).toHaveBeenCalledWith(expect.objectContaining({
      format: 'mkv', codec, outputPath: '/output/test.mkv',
      encoding: expect.objectContaining({ videoCodec }),
    }), expect.any(Function), expect.any(AbortSignal));
  });

  it('resets MKV codec settings when switching back to MP4 or WebM', () => {
    render(<ExportDialog onClose={vi.fn()} />);
    const codec = screen.getByRole('combobox', { name: '编码标准' });
    fireEvent.click(screen.getByRole('button', { name: /MKV \(\.mkv\)/ }));
    expect(codec.textContent).toContain('H.264');
    fireEvent.click(codec);
    fireEvent.click(screen.getByRole('option', { name: 'VP9' }));
    select('编码方式', 'FFmpeg');
    select('FFmpeg 质量控制', '恒定质量 (CRF)');
    fireEvent.change(screen.getByLabelText('CRF'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /MP4 \(\.mp4\)/ }));
    expect(codec.textContent).toContain('H.264');
    expect((screen.getByLabelText('CRF') as HTMLInputElement).value).toBe('20');
    fireEvent.click(codec);
    expect(screen.queryByRole('option', { name: 'VP9' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'H.264' }));
    fireEvent.click(screen.getByRole('button', { name: /WebM \(\.webm\)/ }));
    expect(codec.textContent).toContain('VP9');
    fireEvent.click(codec);
    expect(screen.queryByRole('option', { name: 'H.264' })).toBeNull();
  });

  it('keeps encoding method visible and only offers advanced FFmpeg controls for FFmpeg', () => {
    const view = render(<ExportDialog onClose={vi.fn()} />);
    const mode = screen.getByRole('combobox', { name: '编码方式' });
    expect(mode.closest('details')).toBeNull();
    expect(view.container.querySelector('details.export-encoding-advanced')).toBeNull();
    select('编码方式', 'FFmpeg');
    const encoder = screen.getByRole('combobox', { name: 'FFmpeg 编码器' });
    expect(encoder.closest('details.export-encoding-advanced')).not.toBeNull();
    expect(mode.closest('details')).toBeNull();
    select('编码标准', 'H.265 / HEVC');
    expect(screen.getByRole('combobox', { name: '编码方式' }).textContent).toContain('FFmpeg');
    expect(screen.getByRole('combobox', { name: 'FFmpeg 编码器' }).textContent).toContain('自动');
  });

  it('defaults the FFmpeg encoder to automatic and allows returning to automatic after a manual choice', async () => {
    mocks.export.mockResolvedValue({ success: true });
    render(<ExportDialog onClose={vi.fn()} />);
    select('编码方式', 'FFmpeg');
    const encoder = screen.getByRole('combobox', { name: 'FFmpeg 编码器' });
    expect(encoder.textContent).toContain('自动');
    fireEvent.click(screen.getByText('高级编码设置'));
    select('FFmpeg 编码器', '软件编码 · x264');
    select('FFmpeg 编码器', '自动');
    select('编码标准', 'H.265 / HEVC');
    expect(encoder.textContent).toContain('自动');
    select('FFmpeg 编码器', '自动');
    select('FFmpeg 质量控制', '恒定质量 (CRF)');
    expect(encoder.textContent).toContain('自动');
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    await screen.findByRole('button', { name: '关闭' });
    const config = mocks.export.mock.calls[0][0];
    expect(config.codec).toBe('libx265');
    expect(config.encoding.ffmpegEncoder).toBe('auto');
    expect(resolveExportEncoding(config).rateControl.mode).toBe('crf');
  });

  it('applies high quality without opening advanced settings', async () => {
    mocks.export.mockResolvedValue({ success: true });
    const view = render(<ExportDialog onClose={vi.fn()} />);
    expect(view.container.querySelector('details[open]')).toBeNull();
    fireEvent.click(screen.getByRole('combobox', { name: '编码质量' }));
    fireEvent.click(screen.getByRole('option', { name: '高画质' }));
    expect(Number((screen.getByLabelText('目标码率 (Mbps)') as HTMLInputElement).value)).toBe(20);
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    await screen.findByRole('button', { name: '关闭' });
    expect(mocks.export).toHaveBeenCalledWith(expect.objectContaining({ encoding: expect.objectContaining({ quality: 'high', allowH264Intermediate: false }) }), expect.any(Function), expect.any(AbortSignal));
  });

  it('passes an explicit custom CRF to FFmpeg', async () => {
    mocks.export.mockResolvedValue({ success: true });
    render(<ExportDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('combobox', { name: '编码标准' }));
    fireEvent.click(screen.getByRole('option', { name: 'H.265 / HEVC' }));
    select('编码方式', 'FFmpeg');
    select('FFmpeg 质量控制', '恒定质量 (CRF)');
    fireEvent.change(screen.getByLabelText('CRF'), { target: { value: '17' } });
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    await screen.findByRole('button', { name: '关闭' });
    expect(mocks.export).toHaveBeenCalledWith(expect.objectContaining({ encoding: expect.objectContaining({ quality: 'custom', rateControl: { mode: 'crf', crf: 17 } }) }), expect.any(Function), expect.any(AbortSignal));
  });

  it('keeps intermediate bitrate independent from the final target', async () => {
    mocks.export.mockResolvedValue({ success: true });
    render(<ExportDialog onClose={vi.fn()} />);
    select('编码标准', 'H.265 / HEVC');
    fireEvent.change(screen.getByLabelText('中间流码率 (Mbps)'), { target: { value: '42.5' } });
    fireEvent.change(screen.getByLabelText('目标码率 (Mbps)'), { target: { value: '12.5' } });
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    await screen.findByRole('button', { name: '关闭' });
    expect(mocks.export).toHaveBeenCalledWith(expect.objectContaining({
      encoding: expect.objectContaining({ rateControl: { mode: 'bitrate', bitrateMbps: 12.5 }, intermediateBitrateMbps: 42.5 }),
    }), expect.any(Function), expect.any(AbortSignal));
  });

  beforeEach(() => {
    mocks.export.mockReset();
    mocks.estimateSize.mockReset().mockImplementation(async (config: ExportSizeEstimateConfig) => ({
      basis: 'sample', bytes: (config.rangeEnd - config.rangeStart) * 1_000_000,
      sampledFrames: 60, totalFrames: 600, sampleCount: 3,
    }));
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('delays real sampling, debounces edits, and clears outdated sizes', async () => {
    vi.useFakeTimers();
    render(<ExportDialog onClose={vi.fn()} />);
    const estimate = screen.getByRole('status');
    expect(estimate.textContent).toBe('正在预估');
    await act(async () => vi.advanceTimersByTime(599));
    expect(mocks.estimateSize).not.toHaveBeenCalled();
    expect(estimate.textContent).toBe('正在预估');
    await act(async () => vi.advanceTimersByTime(1));
    expect(estimate.textContent).toMatch(/预估大小：约 [\d.]+ MB/);
    const original = estimate.textContent;

    fireEvent.change(screen.getByRole('spinbutton', { name: /结束时间/ }), { target: { value: '5' } });
    expect(estimate.textContent).toBe('正在预估');
    act(() => vi.advanceTimersByTime(300));
    fireEvent.change(screen.getByRole('spinbutton', { name: /结束时间/ }), { target: { value: '2' } });
    await act(async () => vi.advanceTimersByTime(599));
    expect(mocks.estimateSize).toHaveBeenCalledTimes(1);
    expect(estimate.textContent).toBe('正在预估');
    await act(async () => vi.advanceTimersByTime(1));
    expect(estimate.textContent).toMatch(/预估大小：约 [\d.]+ MB/);
    expect(estimate.textContent).not.toBe(original);
    expect(mocks.estimateSize).toHaveBeenCalledTimes(2);
    expect(mocks.export).not.toHaveBeenCalled();
    expect(window.aeonStageryAPI.dialog.showSave).not.toHaveBeenCalled();
  });

  it.each([
    ['bitrate', 'pointerUp'], ['crf', 'pointerUp'],
    ['bitrate', 'pointerCancel'], ['crf', 'blur'],
  ] as const)('waits until the %s slider finishes with %s before estimating again', async (mode, finishEvent) => {
    vi.useFakeTimers();
    render(<ExportDialog onClose={vi.fn()} />);
    if (mode === 'crf') {
      select('编码方式', 'FFmpeg');
      select('FFmpeg 质量控制', '恒定质量 (CRF)');
    }
    await act(async () => vi.advanceTimersByTime(600));
    expect(mocks.estimateSize).toHaveBeenCalledTimes(1);
    const slider = screen.getByRole('slider', { name: mode === 'crf' ? 'CRF 滑块' : '目标码率滑块 (Mbps)' });
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '18' } });
    await act(async () => vi.advanceTimersByTime(1200));
    expect(mocks.estimateSize).toHaveBeenCalledTimes(1);
    fireEvent.change(slider, { target: { value: '17' } });
    await act(async () => vi.advanceTimersByTime(1200));
    expect(mocks.estimateSize).toHaveBeenCalledTimes(1);
    // Releasing outside the slider must resume estimates with the final value.
    fireEvent[finishEvent](window);
    await act(async () => vi.advanceTimersByTime(599));
    expect(mocks.estimateSize).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(1));
    expect(mocks.estimateSize).toHaveBeenCalledTimes(2);
    expect(mocks.estimateSize).toHaveBeenLastCalledWith(expect.objectContaining({
      encoding: expect.objectContaining({ rateControl: mode === 'crf'
        ? { mode: 'crf', crf: 17 }
        : { mode: 'bitrate', bitrateMbps: 17 } }),
    }), expect.any(AbortSignal));
  });

  it('aborts an active estimate on slider press and waits for its cleanup before restarting', async () => {
    vi.useFakeTimers();
    let finish!: (estimate: ExportSizeEstimate) => void;
    mocks.estimateSize.mockImplementationOnce(() => new Promise<ExportSizeEstimate>(resolve => { finish = resolve; }));
    render(<ExportDialog onClose={vi.fn()} />);
    await act(async () => vi.advanceTimersByTime(600));
    const signal = mocks.estimateSize.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    const slider = screen.getByRole('slider', { name: '目标码率滑块 (Mbps)' });
    fireEvent.pointerDown(slider);
    expect(signal.aborted).toBe(true);
    fireEvent.change(slider, { target: { value: '18' } });
    await act(async () => vi.advanceTimersByTime(1200));
    expect(mocks.estimateSize).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(window);
    await act(async () => vi.advanceTimersByTime(600));
    expect(mocks.estimateSize).toHaveBeenCalledTimes(1);
    await act(async () => finish({ basis: 'sample', bytes: 1, sampledFrames: 1, totalFrames: 1, sampleCount: 1 }));
    expect(mocks.estimateSize).toHaveBeenCalledTimes(2);
    expect(mocks.estimateSize).toHaveBeenLastCalledWith(expect.objectContaining({ bitrateMbps: 18 }), expect.any(AbortSignal));
    expect(screen.getByRole('status').textContent).toMatch(/预估大小：约 [\d.]+ MB/);
  });

  it('reports unavailable size for invalid settings and cancels pending work on unmount', async () => {
    vi.useFakeTimers();
    const view = render(<ExportDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: '跟随项目分辨率与帧率' }));
    fireEvent.change(screen.getByLabelText('宽度 (px)'), { target: { value: '1921' } });
    await act(async () => vi.advanceTimersByTime(600));
    expect(screen.getByRole('status').textContent).toContain('暂无法估算');
    fireEvent.change(screen.getByLabelText('宽度 (px)'), { target: { value: '1920' } });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('only shows computing while sampling and aborts immediately on page exit', async () => {
    vi.useFakeTimers();
    let sampleSignal: AbortSignal | undefined;
    let finish!: (estimate: ExportSizeEstimate) => void;
    mocks.estimateSize.mockImplementation((_config: ExportSizeEstimateConfig, signal: AbortSignal) => {
      sampleSignal = signal;
      return new Promise<ExportSizeEstimate>(resolve => { finish = resolve; });
    });
    const close = vi.fn();
    const view = render(<ExportDialog onClose={close} />);
    await act(async () => vi.advanceTimersByTime(600));
    expect(screen.getByRole('status').textContent).toBe('正在预估');
    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));
    expect(sampleSignal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    view.unmount();
    await act(async () => finish({ basis: 'sample', bytes: 1, sampledFrames: 1, totalFrames: 1, sampleCount: 1 }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for sample cancellation and restoration before starting the actual export', async () => {
    vi.useFakeTimers();
    let sampleSignal: AbortSignal | undefined;
    let finish!: (estimate: ExportSizeEstimate) => void;
    mocks.estimateSize.mockImplementation((_config: ExportSizeEstimateConfig, signal: AbortSignal) => {
      sampleSignal = signal;
      return new Promise<ExportSizeEstimate>(resolve => { finish = resolve; });
    });
    mocks.export.mockResolvedValue({ success: true });
    render(<ExportDialog onClose={vi.fn()} />);
    await act(async () => vi.advanceTimersByTime(600));
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    expect(sampleSignal?.aborted).toBe(true);
    expect(window.aeonStageryAPI.dialog.showSave).not.toHaveBeenCalled();
    expect(mocks.export).not.toHaveBeenCalled();
    await act(async () => finish({ basis: 'sample', bytes: 1, sampledFrames: 1, totalFrames: 1, sampleCount: 1 }));
    expect(mocks.export).toHaveBeenCalledOnce();
  });

  it.each(['close', 'unmount'] as const)('cancels pending export startup on %s while waiting for sampling', async action => {
    vi.useFakeTimers();
    let finish!: (estimate: ExportSizeEstimate) => void;
    mocks.estimateSize.mockImplementationOnce(() => new Promise<ExportSizeEstimate>(resolve => { finish = resolve; }));
    const view = render(<ExportDialog onClose={vi.fn()} />);
    await act(async () => vi.advanceTimersByTime(600));
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    expect(window.aeonStageryAPI.dialog.showSave).not.toHaveBeenCalled();
    if (action === 'close') fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));
    view.unmount();
    await act(async () => finish({ basis: 'sample', bytes: 1, sampledFrames: 1, totalFrames: 1, sampleCount: 1 }));
    expect(window.aeonStageryAPI.dialog.showSave).not.toHaveBeenCalled();
    expect(mocks.export).not.toHaveBeenCalled();
  });

  it('does not export when unmounted while the save dialog is pending', async () => {
    let save!: (result: { canceled: boolean; filePath: string }) => void;
    vi.mocked(window.aeonStageryAPI.dialog.showSave).mockImplementationOnce(() => new Promise(resolve => { save = resolve; }));
    const view = render(<ExportDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    await act(async () => {});
    expect(window.aeonStageryAPI.dialog.showSave).toHaveBeenCalledOnce();
    view.unmount();
    await act(async () => save({ canceled: false, filePath: '/output/test.mp4' }));
    expect(mocks.export).not.toHaveBeenCalled();
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
    await waitFor(() => expect(showItemInFolder).toHaveBeenCalledWith('/output/test.mp4'));

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
