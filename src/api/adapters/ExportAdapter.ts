import type { ExportConfig, ExportProgress, ExportResult } from '../types/export';
import { FrameCaptureEngine } from '../../engine/export/FrameCaptureEngine';
import { AudioMixer, AudioSource } from '../../engine/export/AudioMixer';
import { WebCodecsBackend } from '../../engine/export/WebCodecsBackend';
import { RawPixelsBackend } from '../../engine/export/RawPixelsBackend';
import type { DocumentStore } from '../../ui/store/DocumentStore';
import type { IExportAdapter } from '../../api/interfaces';
import { ProjectResourceService } from '../../services/io/ProjectResourceService';
import { createPreparedFrameCaptureVisualRuntime } from '../../engine/export/PreparedFrameCaptureVisualRuntime';
import { ExportVoiceLipSync } from '../../engine/export/ExportVoiceLipSync';
import { lipSyncEngine } from '../../engine/LipSyncEngine';

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
    let temporaryVideoPath: string | undefined;
    let finalCopyStarted = false;
    let cancellation: Promise<unknown> | undefined;
    let removeLogListener: (() => void) | undefined;
    const cancel = () => {
      cancellation ??= Promise.resolve(this.electronAPI.export.cancelExport());
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

      // Determine video output path — use temp when audio or transcode follows
      let videoPath = outputPath;
      if (includeAudio || isTranscodeNeeded) {
        const tempDir = await this.electronAPI.export.getTempDir();
        const ext = format === 'mp4' ? 'mp4' : format === 'mov' ? 'mov' : 'webm';
        videoPath = await this.electronAPI.path.join(
          tempDir,
          `video_${Date.now()}.${ext}`,
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
          const sources = await this.audioMixer.collectPreparedSources(dialogueOnlyScene, 0, this.playbackAdapter?.getBasePath?.() ?? '');
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
      });
      signal?.throwIfAborted();

      // ── Audio Collection ──
      let audioSources: AudioSource[] = [];
      if (includeAudio) {
        const basePath = this.playbackAdapter?.getBasePath?.() ?? '';
        audioSources = await this.audioMixer.collectPreparedSources(preparedScene, rangeStart, basePath);
      }
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
      } else if (videoPath !== outputPath) {
        // No transcode and no audio — copy temp to final
        const tempData = await this.electronAPI.fs.readFile(videoPath);
        signal?.throwIfAborted();
        if (!tempData.success || !tempData.data) {
          return {
            success: false,
            error: tempData.error || 'Failed to read temporary video file',
          };
        }
        finalCopyStarted = true;
        const writeResult = await this.electronAPI.fs.writeFile(outputPath, tempData.data);
        signal?.throwIfAborted();
        if (!writeResult?.success) {
          return {
            success: false,
            error: writeResult?.error || 'Failed to write final video file',
          };
        }
      }

      signal?.throwIfAborted();
      onProgress({ phase: 'done', percent: 100 });

      return { success: true, outputPath };
    } catch (err: any) {
      if (signal?.aborted) {
        await cancellation;
        return { success: false, cancelled: true };
      }
      return { success: false, error: err.message || 'Unknown export error' };
    } finally {
      signal?.removeEventListener('abort', cancel);
      removeLogListener?.();
      if (signal?.aborted) {
        if (temporaryVideoPath) await this.electronAPI.fs.removeFile(temporaryVideoPath);
        if (finalCopyStarted) await this.electronAPI.fs.removeFile(config.outputPath);
      }
    }
  }
}
