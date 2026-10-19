import type { ExportConfig, ExportProgress, ExportResult } from '../types/export';
import { FrameCaptureEngine } from '../../engine/export/FrameCaptureEngine';
import { AudioMixer, AudioResourceCache } from '../../engine/export/AudioMixer';
import { WebCodecsBackend } from '../../engine/export/WebCodecsBackend';
import { RawPixelsBackend } from '../../engine/export/RawPixelsBackend';
import type { DocumentStore } from '../../ui/store/DocumentStore';
import type { IExportAdapter } from '../../api/interfaces';
import { ProjectResourceService } from '../../services/io/ProjectResourceService';
import { createPreparedFrameCaptureVisualRuntime } from '../../engine/export/PreparedFrameCaptureVisualRuntime';
import { ExportVoiceLipSync } from '../../engine/export/ExportVoiceLipSync';
import { lipSyncEngine } from '../../engine/LipSyncEngine';
import { validateVideoFormat } from '../types/video-format';

export class ExportAdapter implements IExportAdapter {
  private captureEngine: FrameCaptureEngine;
  private audioMixer: AudioMixer;
  private playbackAdapter: any;
  private documentStore: DocumentStore;
  private electronAPI: any;

  /**
   * @param stageAdapter    — StageAdapter for PIXI app access and ticker control
   * @param cameraAdapter   — CameraAdapter for camera init/reset
   * @param playbackAdapter — PlaybackAdapter for seek/pause/duration/silentMode
   * @param lightingSystem  — LightingSystem singleton (injected; no adapter exists)
   * @param live2DManager   — Live2DManager singleton (injected; its API is export-specific)
   * @param documentStore   — DocumentStore for prepared semantic scene snapshots
   * @param electronAPI     — window.aeonStageryAPI for IPC (fs/dialog/export/path)
   */
  constructor(
    stageAdapter: any,
    cameraAdapter: any,
    playbackAdapter: any,
    lightingSystem: any,
    private readonly live2DManager: any,
    documentStore: DocumentStore,
    electronAPI: any,
    projectResources?: ProjectResourceService | null,
  ) {
    this.playbackAdapter = playbackAdapter;
    this.documentStore = documentStore;
    this.electronAPI = electronAPI;

    this.captureEngine = new FrameCaptureEngine(
      stageAdapter,
      playbackAdapter,
      lightingSystem,
      live2DManager,
      cameraAdapter,
    );

    this.audioMixer = new AudioMixer(
      electronAPI?.fs,
      electronAPI?.export,
      projectResources,
    );
  }

  async export(config: ExportConfig, onProgress: (p: ExportProgress) => void, signal?: AbortSignal): Promise<ExportResult> {
    if (signal?.aborted) return { success: false, cancelled: true };
    const formatError = validateVideoFormat(config);
    if (formatError) return { success: false, error: formatError };
    let temporaryVideoPath: string | undefined;
    let directCaptureOutputStarted = false;
    let backendOutputStarted = false;
    let exportCompleted = false;
    let cancellation: Promise<unknown> | undefined;
    let removeLogListener: (() => void) | undefined;
    const cancel = () => {
      cancellation ??= Promise.resolve().then(() => this.electronAPI.export.cancelExport());
      // Observe IPC errors immediately; the cancellation path awaits cleanup below.
      void cancellation.catch(() => {});
    };
    if (signal?.aborted) return { success: false, cancelled: true };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const preparedScene = this.documentStore.getPreparedSceneSnapshot();
      if (!preparedScene) {
        return { success: false, error: 'No prepared semantic scene loaded' };
      }
      const visualRuntime = createPreparedFrameCaptureVisualRuntime(preparedScene);

      const {
        format, codec, bitrateMbps, fps, width, height,
        rangeStart, rangeEnd, includeAudio, backend: backendChoice, outputPath,
        includeSubtitles, subtitleOnly, subtitleChroma, ffmpegLogCallback,
      } = config;

      const isSubtitleOnly = subtitleOnly === true;
      const isSubtitleChroma = subtitleChroma === true;
      if (isSubtitleOnly && isSubtitleChroma) {
        return {
          success: false,
          error: '透明背景与绿幕背景不能同时启用，请二选一。',
        };
      }
      if (isSubtitleOnly && !(format === 'mov' && codec === 'prores_ks')) {
        return {
          success: false,
          error: '字幕-only 导出仅支持 MOV + Apple ProRes 4444（透明通道），请调整格式与编码器。',
        };
      }
      if (isSubtitleChroma && !(format === 'mp4' && codec === 'libx264')) {
        return {
          success: false,
          error: '绿幕字幕导出仅支持 MP4 + H.264 (libx264)，请调整格式与编码器。',
        };
      }

      const bitrateBps = bitrateMbps * 1_000_000;
      const startFrame = Math.floor(rangeStart * fps);
      const endFrame = Math.ceil(rangeEnd * fps);
      const totalFrames = endFrame - startFrame;

      const hasWebCodecs =
        !isSubtitleOnly &&
        !isSubtitleChroma &&
        backendChoice === 'webcodecs' &&
        typeof (window as any).VideoEncoder !== 'undefined';

      const isTranscodeNeeded = hasWebCodecs && codec !== 'libx264';

      const basePath = this.playbackAdapter?.getBasePath?.() ?? '';
      const audioCache = new AudioResourceCache();
      const audioSources = includeAudio
        ? await this.audioMixer.collectPreparedSources(preparedScene, rangeStart, basePath, audioCache)
        : [];
      signal?.throwIfAborted();

      // Use an intermediate video only when there is actual post-processing.
      let videoPath = outputPath;
      if (audioSources.length > 0 || isTranscodeNeeded) {
        const tempDir = await this.electronAPI.export.getTempDir();
        const ext = format === 'mp4' ? 'mp4' : format === 'mov' ? 'mov' : 'webm';
        videoPath = await this.electronAPI.path.join(
          tempDir,
          `video_${crypto.randomUUID()}.${ext}`,
        );
        temporaryVideoPath = videoPath;
      }
      signal?.throwIfAborted();

      // ── Capture Phase ──
      const backend = hasWebCodecs
        ? new WebCodecsBackend(this.electronAPI.export)
        : new RawPixelsBackend(this.electronAPI.export);

      const mouthTarget = typeof this.live2DManager === 'function' ? this.live2DManager() : this.live2DManager;
      const voiceLipSync = new ExportVoiceLipSync(
        mouthTarget,
        (speaker) => lipSyncEngine.stop(speaker),
        (text, duration, offset) => lipSyncEngine.computeTextMouthOpenness(text, duration, offset),
      );
      if (!isSubtitleOnly && !isSubtitleChroma) {
        await voiceLipSync.prepare(preparedScene, rangeStart, rangeEnd, async (voiceScene) => {
          const dialogueOnlyScene = { ...voiceScene, audio: undefined };
          const sources = await this.audioMixer.collectPreparedSources(dialogueOnlyScene, 0, basePath, audioCache);
          signal?.throwIfAborted();
          const source = sources.find((candidate) => candidate.path);
          if (!source) throw new Error('Voice audio is unavailable for export lip sync.');
          const result = await this.electronAPI.fs.readFile(source.path);
          if (!result.success || !result.data) throw new Error(result.error || 'Cannot read voice audio for export lip sync.');
          return result.data;
        });
      }
      signal?.throwIfAborted();

      await this.captureEngine.capture({
        fps,
        rangeStart,
        rangeEnd,
        width,
        height,
        fit: config.fit,
        bitrateBps,
        outputPath: videoPath,
        codec,
        backend,
        onProgress, // capture phase: 0-90%
        visualRuntime,
        voiceLipSync,
        includeSubtitles: includeSubtitles !== false,
        subtitleOnly: isSubtitleOnly,
        subtitleChroma: isSubtitleChroma,
        signal,
        onBackendStarted: () => {
          backendOutputStarted = true;
          if (videoPath === outputPath) directCaptureOutputStarted = true;
        },
      });
      signal?.throwIfAborted();

      // ── Mix Phase ──
      if (audioSources.length > 0 || isTranscodeNeeded) {
        onProgress({
          phase: 'mix',
          percent: 90,
          audioSourceCount: audioSources.length,
        });

        // Wire FFmpeg log callback if provided
        if (ffmpegLogCallback) {
          removeLogListener = this.electronAPI.export.onLog(ffmpegLogCallback);
        }
        signal?.throwIfAborted();

        const mixResult = await this.audioMixer.mix(
          videoPath,
          outputPath,
          audioSources,
          {
            fps,
            // Subtitle-layer streams are RawPixels-encoded; copy the stream
            // during audio muxing to preserve alpha (ProRes 4444) or lossless
            // green-screen frames (H.264).
            codec: isSubtitleOnly || isSubtitleChroma ? 'copy' : (hasWebCodecs ? codec : 'copy'),
            audioCodec: format === 'webm' ? 'libopus' : 'aac',
            width,
            height,
            totalFrames,
            bitrateMbps,
            transparent: isSubtitleOnly,
          },
          isTranscodeNeeded,
        );
        signal?.throwIfAborted();

        if (!mixResult.success) {
          return { success: false, error: mixResult.error };
        }

        onProgress({ phase: 'mix', percent: 100 });
      }

      signal?.throwIfAborted();
      onProgress({ phase: 'done', percent: 100 });

      exportCompleted = true;
      return { success: true, outputPath };
    } catch (err: unknown) {
      if (signal?.aborted) {
        return { success: false, cancelled: true };
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      signal?.removeEventListener('abort', cancel);
      removeLogListener?.();
      if (!exportCompleted && backendOutputStarted) cancel();
      if (cancellation) {
        await cancellation.catch((error: unknown) => console.error('[Export] Cancellation cleanup failed:', error));
      }
      const cleanupPaths = [
        ...(temporaryVideoPath ? [temporaryVideoPath] : []),
        ...(signal?.aborted && directCaptureOutputStarted ? [config.outputPath] : []),
      ];
      for (const cleanupPath of cleanupPaths) {
        try {
          const result = await this.electronAPI.fs.removeFile(cleanupPath);
          if (result?.success === false) console.error('[Export] File cleanup failed:', result.error);
        } catch (error) {
          console.error('[Export] File cleanup failed:', error);
        }
      }
    }
  }
}
