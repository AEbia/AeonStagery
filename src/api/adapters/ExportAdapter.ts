import type { ExportConfig, ExportProgress, ExportResult, ExportEncodingInfo, ExportVideoCodec, FFmpegVideoOptions } from '../types/export';
import { assertExportOperation, ExportEncodingError, getSoftwareEncoder, isHardwareEncoder, resolveExportEncoding } from '../exportEncoding';
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
    const temporaryPaths = new Set<string>();
    let directCaptureOutputStarted = false;
    let backendOutputStarted = false;
    let exportCompleted = false;
    let cancellation: Promise<unknown> | undefined;
    let removeLogListener: (() => void) | undefined;
    let encodingInfo: ExportEncodingInfo | undefined;
    const cancel = () => {
      cancellation ??= Promise.resolve().then(() => this.electronAPI.export.cancelExport());
      void cancellation.catch(() => {});
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      signal?.throwIfAborted();
      const preparedScene = this.documentStore.getPreparedSceneSnapshot();
      if (!preparedScene) return { success: false, error: 'No prepared semantic scene loaded' };
      const { format, fps, width, height, rangeStart, rangeEnd, includeAudio, outputPath,
        includeSubtitles, subtitleOnly, subtitleChroma, ffmpegLogCallback } = config;
      const isSubtitleOnly = subtitleOnly === true, isSubtitleChroma = subtitleChroma === true;
      if (isSubtitleOnly && isSubtitleChroma) return { success: false, error: '透明背景与绿幕背景不能同时启用，请二选一。' };
      if (isSubtitleOnly && !(format === 'mov' && config.codec === 'prores_ks')) {
        return { success: false, error: '字幕-only 导出仅支持 MOV + Apple ProRes 4444（透明通道），请调整格式与编码器。' };
      }
      if (isSubtitleChroma && !(format === 'mp4' && config.codec === 'libx264')) {
        return { success: false, error: '绿幕字幕导出仅支持 MP4 + H.264 (libx264)，请调整格式与编码器。' };
      }
      const settings = resolveExportEncoding(config);
      const allowed: Record<ExportConfig['format'], readonly ExportVideoCodec[]> = {
        mp4: ['h264', 'hevc', 'av1'], webm: ['vp9', 'av1'], mov: ['prores', 'h264', 'hevc', 'av1'],
      };
      if (!allowed[format].includes(settings.videoCodec)) return { success: false, error: '编码标准与封装格式不兼容' };
      if ((isSubtitleOnly && settings.videoCodec !== 'prores') || (isSubtitleChroma && settings.videoCodec !== 'h264')) {
        return { success: false, error: '编码设置与字幕导出模式不兼容' };
      }
      const softwareEncoder = getSoftwareEncoder(settings.videoCodec);
      let finalEncoder = settings.encoder;
      let fallbackReason: string | undefined;
      let ffmpegFallbackReason: string | undefined;
      if (settings.rateControl.mode === 'crf' && isHardwareEncoder(finalEncoder)) {
        finalEncoder = softwareEncoder;
        ffmpegFallbackReason = 'CRF 使用软件编码';
      }
      // Compiled-in availability is advisory; initialization can still fail on a
      // machine without the corresponding GPU/driver and is retried below.
      const capabilities = await this.electronAPI.export.getEncodingCapabilities?.();
      if (capabilities?.success && !capabilities.encoders.includes(finalEncoder)) {
        ffmpegFallbackReason = `${finalEncoder} 不可用，已切换软件编码`;
        finalEncoder = softwareEncoder;
      }
      signal?.throwIfAborted();
      const videoOptions = (encoder: string): FFmpegVideoOptions => ({
        codec: encoder, speed: settings.speed, ...(isSubtitleOnly ? { transparent: true } : {}),
        ...(settings.rateControl.mode === 'crf'
          ? { crf: settings.rateControl.crf }
          : { bitrate: settings.rateControl.bitrateMbps }),
      });
      const totalFrames = Math.ceil(rangeEnd * fps) - Math.floor(rangeStart * fps);
      if (totalFrames <= 0 || !Number.isFinite(totalFrames) || rangeStart < 0 || rangeEnd <= rangeStart) {
        return { success: false, error: '导出时间范围无效' };
      }
      const basePath = this.playbackAdapter?.getBasePath?.() ?? '';
      const audioCache = new AudioResourceCache();
      const audioSources = includeAudio
        ? await this.audioMixer.collectPreparedSources(preparedScene, rangeStart, basePath, audioCache) : [];
      signal?.throwIfAborted();
      const canUseWebCodecs = !isSubtitleOnly && !isSubtitleChroma && settings.implementation !== 'ffmpeg'
        && typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
      if (!canUseWebCodecs && settings.implementation !== 'ffmpeg' && !isSubtitleOnly && !isSubtitleChroma) {
        fallbackReason ??= 'WebCodecs 不可用，已切换 FFmpeg';
      }
      type Attempt = { native: boolean; intermediate: boolean; encoder: string; videoCodec: ExportVideoCodec };
      const attempts: Attempt[] = [];
      if (canUseWebCodecs) {
        attempts.push({ native: true, intermediate: false, encoder: getSoftwareEncoder(settings.videoCodec), videoCodec: settings.videoCodec });
        if (settings.allowH264Intermediate && settings.videoCodec !== 'h264') {
          attempts.push({ native: true, intermediate: true, encoder: 'libx264', videoCodec: 'h264' });
        }
      }
      attempts.push({ native: false, intermediate: false, encoder: finalEncoder, videoCodec: settings.videoCodec });
      if (finalEncoder !== softwareEncoder) attempts.push({ native: false, intermediate: false, encoder: softwareEncoder, videoCodec: settings.videoCodec });
      let captured: { path: string; intermediate: boolean } | undefined;
      for (let index = 0; index < attempts.length; index++) {
        const attempt = attempts[index];
        signal?.throwIfAborted();
        let videoPath = outputPath;
        if (audioSources.length > 0 || attempt.intermediate) {
          const tempDir = await this.electronAPI.export.getTempDir();
          videoPath = await this.electronAPI.path.join(tempDir, `video_${crypto.randomUUID()}.${attempt.intermediate ? 'mp4' : format}`);
          temporaryPaths.add(videoPath);
        }
        const attemptReason = fallbackReason ?? (!attempt.native || attempt.intermediate ? ffmpegFallbackReason : undefined);
        encodingInfo = {
          implementation: attempt.intermediate ? 'webcodecs-transcode' : attempt.native ? 'webcodecs' : 'ffmpeg',
          encoder: attempt.intermediate ? finalEncoder : attempt.native ? attempt.videoCodec : attempt.encoder,
          attempt: index + 1, ...(attemptReason ? { fallbackReason: attemptReason } : {}),
        };
        onProgress({ phase: 'capture', percent: 0, frame: 0, totalFrames, encoding: encodingInfo });
        const backend = attempt.native ? new WebCodecsBackend(this.electronAPI.export) : new RawPixelsBackend(this.electronAPI.export);
        const mouthTarget = typeof this.live2DManager === 'function' ? this.live2DManager() : this.live2DManager;
        const voiceLipSync = new ExportVoiceLipSync(mouthTarget, (speaker) => lipSyncEngine.stop(speaker),
          (text, duration, offset) => lipSyncEngine.computeTextMouthOpenness(text, duration, offset));
        try {
          if (!isSubtitleOnly && !isSubtitleChroma) {
            await voiceLipSync.prepare(preparedScene, rangeStart, rangeEnd, async (voiceScene) => {
              const sources = await this.audioMixer.collectPreparedSources(voiceScene, 0, basePath, audioCache);
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
            fps, rangeStart, rangeEnd, width, height, fit: config.fit,
            bitrateBps: (attempt.intermediate ? settings.intermediateBitrateMbps : settings.bitrateMbps) * 1_000_000,
            outputPath: videoPath, codec: attempt.encoder, videoCodec: attempt.videoCodec,
            encoding: attempt.native ? undefined : videoOptions(attempt.encoder), backend,
            onProgress: (progress) => onProgress({ ...progress, encoding: encodingInfo }),
            visualRuntime: createPreparedFrameCaptureVisualRuntime(preparedScene), voiceLipSync,
            includeSubtitles: includeSubtitles !== false, subtitleOnly: isSubtitleOnly, subtitleChroma: isSubtitleChroma, signal,
            onBackendStarted: () => { backendOutputStarted = true; if (videoPath === outputPath) directCaptureOutputStarted = true; },
          });
          captured = { path: videoPath, intermediate: attempt.intermediate };
          break;
        } catch (error) {
          voiceLipSync.dispose();
          if (signal?.aborted || !(error instanceof ExportEncodingError) || index === attempts.length - 1) throw error;
          // Wait for the old process and pending writes before opening the next
          // stream. A new capture reconstructs the scene from the range start.
          await this.electronAPI.export.cancelExport();
          signal?.throwIfAborted();
          fallbackReason = error.message;
          if (videoPath !== outputPath || directCaptureOutputStarted) await this.electronAPI.fs.removeFile(videoPath);
        }
      }
      signal?.throwIfAborted();
      if (!captured) throw new Error('No video was captured');
      if (audioSources.length > 0 || captured.intermediate) {
        onProgress({ phase: 'mix', percent: 90, audioSourceCount: audioSources.length, encoding: encodingInfo });
        if (ffmpegLogCallback) removeLogListener = this.electronAPI.export.onLog(ffmpegLogCallback);
        const mix = (encoder: string) => this.audioMixer.mix(captured.path, outputPath, audioSources, {
          fps, codec: captured.intermediate ? encoder : 'copy', audioCodec: format === 'webm' ? 'libopus' : 'aac',
          width, height, totalFrames, bitrateMbps: settings.bitrateMbps, transparent: isSubtitleOnly,
          encoding: videoOptions(encoder),
        }, captured.intermediate);
        let mixResult = await mix(finalEncoder);
        signal?.throwIfAborted();
        if (!mixResult.success && captured.intermediate && finalEncoder !== softwareEncoder) {
          try { assertExportOperation(mixResult, 'FFmpeg transcode'); }
          catch (error) {
            if (!(error instanceof ExportEncodingError)) throw error;
            finalEncoder = softwareEncoder;
            encodingInfo = { ...encodingInfo!, encoder: finalEncoder, fallbackReason: error.message };
            onProgress({ phase: 'mix', percent: 90, audioSourceCount: audioSources.length, encoding: encodingInfo });
            mixResult = await mix(finalEncoder);
          }
        }
        signal?.throwIfAborted();
        assertExportOperation(mixResult, 'FFmpeg audio/video mix');
        onProgress({ phase: 'mix', percent: 100, encoding: encodingInfo });
      }
      signal?.throwIfAborted();
      onProgress({ phase: 'done', percent: 100, encoding: encodingInfo });
      exportCompleted = true;
      return { success: true, outputPath, ...(config.encoding ? { encoding: encodingInfo } : {}) };
    } catch (error: unknown) {
      if (signal?.aborted) return { success: false, cancelled: true };
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      signal?.removeEventListener('abort', cancel);
      removeLogListener?.();
      if (!exportCompleted && backendOutputStarted) cancel();
      if (cancellation) await cancellation.catch((error: unknown) => console.error('[Export] Cancellation cleanup failed:', error));
      const cleanupPaths = [...temporaryPaths, ...(signal?.aborted && directCaptureOutputStarted ? [config.outputPath] : [])];
      for (const cleanupPath of cleanupPaths) {
        try {
          const result = await this.electronAPI.fs.removeFile(cleanupPath);
          if (result?.success === false) console.error('[Export] File cleanup failed:', result.error);
        } catch (error) { console.error('[Export] File cleanup failed:', error); }
      }
    }
  }
}
