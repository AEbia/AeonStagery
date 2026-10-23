import type { ExportConfig, ExportResult } from '../../api/types/export';
import type { AeonStageryElectronAPI } from '../../api/types/window';
import type { IPlaybackAdapter } from '../../api/interfaces/IPlaybackAdapter';
import { estimateExportSizeFromSamples, planExportSizeSamples, type ExportSizeEstimateConfig, type ExportSizeSample } from '../../api/exportSizeEstimate';

interface Dependencies {
  exportVideo(config: ExportConfig, signal?: AbortSignal): Promise<ExportResult>;
  playback: Pick<IPlaybackAdapter, 'getCurrentTime' | 'pause' | 'seek'>;
  electron: {
    export: Pick<AeonStageryElectronAPI['export'], 'getTempDir'>;
    path: Pick<AeonStageryElectronAPI['path'], 'join'>;
  };
}

/** Uses the real export pipeline, with identical settings and actual audio. */
export async function sampleExportSize(config: ExportSizeEstimateConfig, dependencies: Dependencies, signal?: AbortSignal) {
  const ranges = planExportSizeSamples(config);
  if (!ranges.length) throw new Error('请先设置有效的导出规格和时间范围');
  signal?.throwIfAborted();
  const { playback, electron, exportVideo } = dependencies;
  const originalTime = playback.getCurrentTime();
  const samples: ExportSizeSample[] = [];
  const directory = await electron.export.getTempDir();
  signal?.throwIfAborted();
  playback.pause();
  try {
    for (const range of ranges) {
      signal?.throwIfAborted();
      const outputPath = await electron.path.join(directory, `size-sample-${crypto.randomUUID()}.${config.format}`);
      signal?.throwIfAborted();
      // The main process measures and cleans its private output before replying.
      const result = await exportVideo({ ...config, rangeStart: range.rangeStart, rangeEnd: range.rangeEnd, outputPath }, signal);
      signal?.throwIfAborted();
      if (!result.success) throw new Error(result.error || '视频大小抽样编码失败');
      if (result.sizeBytes === undefined || !Number.isSafeInteger(result.sizeBytes) || result.sizeBytes <= 0) {
        throw new Error('无法读取抽样视频大小');
      }
      samples.push({ bytes: result.sizeBytes, frames: range.frames, encoding: result.encoding });
    }
    signal?.throwIfAborted();
    return estimateExportSizeFromSamples(config, samples);
  } finally {
    // Await restoration even on cancellation, before another capture may start.
    await playback.seek(originalTime, true);
  }
}
