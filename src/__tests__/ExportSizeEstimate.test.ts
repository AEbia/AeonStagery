import { describe, expect, it, vi } from 'vitest';
import { estimateExportSizeFromBitrate, estimateExportSizeFromSamples, planExportSizeSamples, type ExportSizeEstimateConfig } from '../api/exportSizeEstimate';
import { sampleExportSize } from '../engine/export/ExportSizeSampler';
import type { ExportConfig, ExportResult } from '../api/types/export';

const config: ExportSizeEstimateConfig = {
  format: 'mp4', codec: 'libx264', bitrateMbps: 8,
  width: 1920, height: 1080, fps: 30,
  rangeStart: 0, rangeEnd: 60, includeAudio: true, backend: 'rawpixels',
  encoding: { videoCodec: 'h264', implementation: 'ffmpeg', quality: 'balanced' },
};

function dependencies() {
  return {
    exportVideo: vi.fn<(config: ExportConfig, signal?: AbortSignal) => Promise<ExportResult>>().mockResolvedValue({
      success: true, sizeBytes: 1_000_000, encoding: { implementation: 'ffmpeg', encoder: 'libx264', attempt: 1 },
    }),
    playback: { getCurrentTime: () => 17, pause: vi.fn(), seek: vi.fn().mockResolvedValue(undefined) },
    electron: {
      export: { getTempDir: vi.fn().mockResolvedValue('/tmp/exports') },
      path: { join: vi.fn(async (...parts: string[]) => parts.join('/')) },
      fs: {
        stat: vi.fn().mockResolvedValue({ success: true, data: { isFile: true, sizeBytes: 1_000_000 } }),
        removeFile: vi.fn().mockResolvedValue({ success: true }),
      },
    },
  };
}

describe('measured export size estimation', () => {
  it('uses measured output rather than combining speculative native and CRF ranges', () => {
    const estimate = estimateExportSizeFromSamples(config, [
      { bytes: 1_000_000, frames: 60 }, { bytes: 2_000_000, frames: 60 }, { bytes: 3_000_000, frames: 60 },
    ]);
    expect(estimate).toEqual({ basis: 'sample', bytes: 60_000_000, sampledFrames: 180, totalFrames: 1800, sampleCount: 3 });
    expect(estimate).not.toHaveProperty('minBytes');
    expect(estimate).not.toHaveProperty('maxBytes');
    expect(estimateExportSizeFromSamples({ ...config, bitrateMbps: 500 }, [
      { bytes: 1_000_000, frames: 60 }, { bytes: 2_000_000, frames: 60 }, { bytes: 3_000_000, frames: 60 },
    ]).bytes).toBe(60_000_000);
  });

  it('calculates native VBR from its target, ignores inactive CRF and adds one audio track', () => {
    const estimate = estimateExportSizeFromBitrate(config, 8);
    expect(estimate).toMatchObject({ basis: 'bitrate', bytes: 62_054_400, sampleCount: 0, sampledFrames: 0 });
    expect(estimateExportSizeFromBitrate({ ...config, includeAudio: false }, 8).bytes).toBe(60_600_000);
    expect(estimateExportSizeFromBitrate({ ...config, format: 'webm' }, 8).bytes).toBe(61_569_600);
  });

  it('plans non-overlapping clips at the beginning, middle and end', () => {
    const ranges = planExportSizeSamples(config);
    expect(ranges).toHaveLength(3);
    expect(ranges.map(range => range.frames)).toEqual([60, 60, 60]);
    expect(Math.floor(ranges[0].rangeStart * config.fps)).toBe(0);
    expect(Math.ceil(ranges[2].rangeEnd * config.fps)).toBe(1800);
    expect(ranges[0].rangeEnd).toBeLessThan(ranges[1].rangeStart);
    expect(ranges[1].rangeEnd).toBeLessThan(ranges[2].rangeStart);
  });

  it.each([23.976, 29.97, 59.94, 60, 240])('preserves frame counts at %s fps and non-zero starts', fps => {
    const ranges = planExportSizeSamples({ ...config, fps, rangeStart: 10.01, rangeEnd: 100.123 });
    for (const range of ranges) {
      expect(Math.ceil(range.rangeEnd * fps) - Math.floor(range.rangeStart * fps)).toBe(range.frames);
    }
  });

  it('measures the whole range once for videos up to six seconds', () => {
    expect(planExportSizeSamples({ ...config, rangeStart: 0.01, rangeEnd: 5.99 })).toEqual([
      { rangeStart: 0.01, rangeEnd: 5.99, frames: 180 },
    ]);
    expect(estimateExportSizeFromSamples({ ...config, rangeEnd: 6 }, [{ bytes: 1_234_567, frames: 180 }]).bytes).toBe(1_234_567);
  });

  it('refuses to mix different actual encoding paths', () => {
    expect(() => estimateExportSizeFromSamples(config, [
      { bytes: 1_000_000, frames: 60, encoding: { implementation: 'webcodecs', encoder: 'h264', attempt: 1 } },
      { bytes: 1_000_000, frames: 60, encoding: { implementation: 'ffmpeg', encoder: 'libx264', attempt: 2 } },
    ])).toThrow('编码路径发生变化');
  });

  it.each([{ width: 1921 }, { fps: 0 }, { rangeStart: -1 }, { rangeEnd: 0 }, { rangeEnd: Infinity }, { bitrateMbps: 0 }])('does not sample invalid input %j', patch => {
    expect(planExportSizeSamples({ ...config, ...patch })).toEqual([]);
  });

  it.each([{ bytes: 0, frames: 60 }, { bytes: Infinity, frames: 60 }, { bytes: 100, frames: 0 }, { bytes: 100, frames: 1801 }])('rejects unusable measured output %j', sample => {
    expect(() => estimateExportSizeFromSamples(config, [sample])).toThrow();
  });

  it('uses sizes measured in the main process and restores the playhead without renderer file cleanup', async () => {
    const deps = dependencies();
    const estimate = await sampleExportSize(config, deps);
    expect(estimate.bytes).toBe(30_000_000);
    expect(deps.exportVideo).toHaveBeenCalledTimes(3);
    expect(deps.electron.fs.stat).not.toHaveBeenCalled();
    expect(deps.electron.fs.removeFile).not.toHaveBeenCalled();
    for (const [sample] of deps.exportVideo.mock.calls) {
      expect(sample).toMatchObject({ encoding: config.encoding, includeAudio: true, width: config.width, fps: config.fps });
      expect(sample.outputPath).toMatch(/^\/tmp\/exports\/size-sample-.+\.mp4$/);
    }
    expect(deps.playback.seek).toHaveBeenLastCalledWith(17, true);
  });

  it('cancels active encoding, waits for restoration, and never starts another clip', async () => {
    const deps = dependencies();
    const controller = new AbortController();
    deps.exportVideo.mockImplementation(async (_sample, signal) => {
      controller.abort();
      expect(signal?.aborted).toBe(true);
      return { success: false, cancelled: true };
    });
    await expect(sampleExportSize(config, deps, controller.signal)).rejects.toThrow();
    expect(deps.exportVideo).toHaveBeenCalledOnce();
    expect(deps.electron.fs.removeFile).not.toHaveBeenCalled();
    expect(deps.playback.seek).toHaveBeenCalledWith(17, true);
  });

  it('restores the stage after an encoding failure', async () => {
    const deps = dependencies();
    deps.exportVideo.mockResolvedValue({ success: false, error: 'encoding failed' });
    await expect(sampleExportSize(config, deps)).rejects.toThrow('encoding failed');
    expect(deps.exportVideo).toHaveBeenCalledOnce();
    expect(deps.electron.fs.removeFile).not.toHaveBeenCalled();
    expect(deps.playback.seek).toHaveBeenCalledWith(17, true);
  });

  it.each([undefined, 0, Infinity])('rejects an invalid main-process measurement %s and restores the stage', async sizeBytes => {
    const deps = dependencies();
    deps.exportVideo.mockResolvedValue({ success: true, sizeBytes });
    await expect(sampleExportSize(config, deps)).rejects.toThrow('无法读取抽样视频大小');
    expect(deps.playback.seek).toHaveBeenCalledWith(17, true);
  });

  it('does no work if already cancelled', async () => {
    const deps = dependencies();
    const controller = new AbortController();
    controller.abort();
    await expect(sampleExportSize(config, deps, controller.signal)).rejects.toThrow();
    expect(deps.exportVideo).not.toHaveBeenCalled();
    expect(deps.electron.export.getTempDir).not.toHaveBeenCalled();
    expect(deps.playback.pause).not.toHaveBeenCalled();
  });
});
