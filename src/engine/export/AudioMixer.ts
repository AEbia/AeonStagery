import type { PreparedCompiledAction, PreparedCompiledScene, PreparedRuntimeValue } from '../../api/types/semantic-scene';
import { ProjectResourceService } from '../../services/io/ProjectResourceService';

export interface AudioSource {
  path: string;
  delayMs: number;
  startOffset?: number;
  duration?: number;
  volume?: number;
  fadeIn?: number;
  fadeInStartGain?: number;
  fadeOut?: number;
  fadeOutStartGain?: number;
  loop?: boolean;
}

interface ElectronFsAPI {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<{ success: boolean; data?: ArrayBuffer; error?: string }>;
  writeFile(path: string, data: ArrayBuffer): Promise<{ success: boolean; error?: string }>;
}

interface ElectronExportAPI {
  convert(inputPath: string, outputPath: string, options?: Record<string, unknown>): Promise<{ success: boolean; error?: string; stderr?: string; path?: string }>;
}


interface AudioMixConfig {
  fps: number;
  codec: string;
  audioCodec?: string;
  width: number;
  height: number;
  totalFrames: number;
  bitrateMbps: number;
  /** Preserve the alpha channel (yuva420p) when re-encoding — subtitle-only exports. */
  transparent?: boolean;
}

interface AudioInterval {
  id: string;
  file: string;
  startTime: number;
  duration?: number;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
  loop?: boolean;
}

type AudioTimelineAction = {
  readonly action: string;
  readonly time?: number;
  readonly params?: { readonly [key: string]: unknown } | null;
};

interface AudioTimelineScene {
  readonly audio?: {
    readonly bgm?: {
      readonly file: string;
      readonly volume?: number;
      readonly loop?: boolean;
      readonly fadeIn?: number;
      readonly fadeOut?: number;
    };
  };
  readonly timeline: readonly AudioTimelineAction[];
}

/**
 * Legacy scene documents carried BGM outside the action list. Prepared
 * semantic scenes normally do not expose this field, but accepting it here
 * keeps old prepared-shaped snapshots exportable without re-projecting them.
 */
type PreparedSceneWithLegacyAudio = PreparedCompiledScene & {
  readonly audio?: AudioTimelineScene['audio'];
};

export class AudioMixer {
  private fsAPI: ElectronFsAPI;
  private exportAPI: ElectronExportAPI;
  private projectResources?: ProjectResourceService | null;

  constructor(
    fsAPI?: ElectronFsAPI | null,
    exportAPI?: ElectronExportAPI | null,
    projectResources?: ProjectResourceService | null,
  ) {
    this.fsAPI = fsAPI as any;
    this.exportAPI = exportAPI as any;
    this.projectResources = projectResources;
  }

  /**
   * Scan the scene script for scene BGM, timeline audio intervals, and dialogue voice files.
   * Each source gets timing calculated relative to the export range start.
   */
  async collectSources(
    sceneData: AudioTimelineScene | null,
    basePath: string,
    exportStart: number,
  ): Promise<AudioSource[]> {
    if (!sceneData) return [];

    const sources: AudioSource[] = [];
    const hasTimelineBGM = sceneData.timeline.some((action) => action.action === 'setBGM');

    // Scene-level BGM is a runtime fallback only when no timeline BGM exists.
    if (sceneData.audio?.bgm?.file && !hasTimelineBGM) {
      const bgm = sceneData.audio.bgm as {
        file: string;
        volume?: number;
        loop?: boolean;
        fadeIn?: number;
        fadeOut?: number;
      };
      const source = await this.createSourceFromInterval({
        id: 'bgm',
        file: bgm.file,
        startTime: 0,
        volume: bgm.volume ?? 0.5,
        loop: bgm.loop ?? true,
        fadeIn: bgm.fadeIn ?? 2,
        fadeOut: bgm.fadeOut,
      }, basePath, exportStart);
      if (source) sources.push(source);
    }

    for (const interval of this.collectTimelineAudioIntervals(sceneData.timeline)) {
      const source = await this.createSourceFromInterval(interval, basePath, exportStart);
      if (source) sources.push(source);
    }

    // Dialogue voice files
    for (const action of sceneData.timeline) {
      if (action.action === 'dialogue' && action.params?.voice) {
        const voiceFile = action.params.voice as string;
        const source = await this.createSourceFromInterval({
          id: `dialogue-${action.time ?? 0}`,
          file: voiceFile,
          startTime: action.time ?? 0,
          duration: finiteNumber(action.params.duration),
          volume: finiteNumber(action.params.volume),
          fadeOut: finiteNumber(action.params.fadeOut),
        }, basePath, exportStart);
        if (source) sources.push(source);
      }
    }

    return sources;
  }

  async collectPreparedSources(
    scene: PreparedCompiledScene,
    exportStart: number,
    basePath = '',
  ): Promise<AudioSource[]> {
    const sources: AudioSource[] = [];
    const legacyScene = scene as PreparedSceneWithLegacyAudio;
    const hasTimelineBGM = scene.actions.some((action) => action.action === 'setBGM');
    const bgm = legacyScene.audio?.bgm;
    const legacyBgmFile = bgm ? readPreparedString(bgm.file) : undefined;
    if (legacyBgmFile && !hasTimelineBGM) {
      const source = await this.createSourceFromInterval({
        id: 'bgm',
        file: legacyBgmFile,
        startTime: 0,
        volume: bgm?.volume ?? 0.5,
        loop: bgm?.loop ?? true,
        fadeIn: bgm?.fadeIn ?? 2,
        fadeOut: bgm?.fadeOut,
      }, basePath, exportStart);
      if (source) sources.push(source);
    }

    for (const interval of this.collectTimelineAudioIntervals(scene.actions)) {
      const source = await this.createSourceFromInterval(interval, basePath, exportStart);
      if (source) sources.push(source);
    }

    for (const action of scene.actions) {
      if (action.action !== 'dialogue') continue;
      const voiceFile = readPreparedString(action.params.voice);
      if (!voiceFile) continue;
      const source = await this.createSourceFromInterval({
        id: `dialogue-${action.id}`,
        file: voiceFile,
        startTime: action.time ?? 0,
        duration: finiteNumber(action.params.duration),
        volume: finiteNumber(action.params.volume),
        fadeOut: finiteNumber(action.params.fadeOut),
      }, basePath, exportStart);
      if (source) sources.push(source);
    }

    return sources;
  }

  private collectTimelineAudioIntervals(actions: readonly AudioTimelineAction[] | readonly PreparedCompiledAction[]): AudioInterval[] {
    const active = new Map<string, AudioInterval>();
    const intervals: AudioInterval[] = [];
    const sortedTimeline = actions
      .map((action, index) => ({ action, index }))
      .sort((a, b) => (a.action.time ?? 0) - (b.action.time ?? 0) || a.index - b.index);

    const closeInterval = (id: string, endTime: number, fadeOut?: number) => {
      const current = active.get(id);
      if (!current) return;
      const explicitEnd = current.duration === undefined ? Infinity : current.startTime + current.duration;
      const resolvedEnd = Math.min(endTime, explicitEnd);
      if (resolvedEnd > current.startTime) {
        intervals.push({
          ...current,
          ...(fadeOut !== undefined ? { fadeOut } : {}),
          duration: Number.isFinite(resolvedEnd) ? resolvedEnd - current.startTime : current.duration,
        });
      }
      active.delete(id);
    };

    const openInterval = (interval: AudioInterval) => {
      closeInterval(interval.id, interval.startTime);
      active.set(interval.id, interval);
    };

    sortedTimeline.forEach(({ action, index }) => {
      const time = action.time ?? 0;
      const params = action.params ?? {};
      if (action.action === 'setBGM') {
        const file = readPreparedString(params.file);
        if (!file) return;
        openInterval({
          id: 'bgm',
          file,
          startTime: time,
          volume: finiteNumber(params.volume) ?? 0.5,
          fadeIn: finiteNumber(params.fadeIn) ?? 2,
          fadeOut: finiteNumber(params.fadeOut),
          loop: params.loop === undefined ? true : params.loop === true,
        });
        return;
      }

      if (action.action === 'playAudio') {
        const file = readPreparedString(params.file);
        if (!file) return;
        const explicitId = readPreparedString(params.id);
        const id = explicitId
          ? explicitId
          : `audio-${index}`;
        const explicitDuration = finiteNumber(params.duration);
        openInterval({
          id,
          file,
          startTime: time,
          duration: explicitDuration ?? (params.loop === true ? undefined : 10),
          volume: finiteNumber(params.volume),
          fadeIn: finiteNumber(params.fadeIn),
          fadeOut: finiteNumber(params.fadeOut),
          ...(params.loop === true ? { loop: true } : {}),
        });
        return;
      }

      const id = readPreparedString(params.id);
      if (action.action === 'stopAudio' && id) {
        closeInterval(id, time, finiteNumber(params.fadeOut));
      }
    });

    for (const interval of active.values()) {
      intervals.push(interval);
    }

    return intervals.sort((a, b) => a.startTime - b.startTime);
  }

  private async createSourceFromInterval(
    interval: AudioInterval,
    basePath: string,
    exportStart: number,
  ): Promise<AudioSource | null> {
    const fullPath = await this.resolveAudioPath(interval.file, basePath);
    if (!(await this.fsAPI.exists(fullPath))) {
      console.warn(`[AudioMixer] Audio file not found: ${fullPath}`);
      return null;
    }

    const timing = this.resolveExportTiming(interval.startTime, interval.duration, exportStart);
    if (!timing) return null;
    const envelope = resolveExportEnvelope(interval, timing.startOffset ?? 0);
    return {
      path: fullPath,
      ...timing,
      ...(interval.volume !== undefined ? { volume: interval.volume } : {}),
      ...envelope,
      ...(interval.loop !== undefined ? { loop: interval.loop } : {}),
    };
  }

  private resolveExportTiming(
    startTime: number,
    duration: number | undefined,
    exportStart: number,
  ): Pick<AudioSource, 'delayMs' | 'startOffset' | 'duration'> | null {
    const startOffset = Math.max(0, exportStart - startTime);
    const delayMs = Math.round(Math.max(0, startTime - exportStart) * 1000);
    if (duration !== undefined) {
      const remainingDuration = duration - startOffset;
      if (remainingDuration <= 0) return null;
      return {
        delayMs,
        ...(startOffset > 0 ? { startOffset } : {}),
        duration: remainingDuration,
      };
    }
    return {
      delayMs,
      ...(startOffset > 0 ? { startOffset } : {}),
    };
  }

  private async resolveAudioPath(relativeOrAbsolutePath: string, basePath: string): Promise<string> {
    if (!relativeOrAbsolutePath) return relativeOrAbsolutePath;
    const normalized = relativeOrAbsolutePath.replace(/\\/g, '/');
    if (normalized.startsWith('asset://localhost/')) {
      return decodeURIComponent(normalized.slice('asset://localhost/'.length));
    }
    if (normalized.startsWith('file:///')) {
      return decodeURIComponent(normalized.slice('file:///'.length));
    }
    const looksProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(normalized);
    const looksAbsolute = /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('/');
    if (looksProtocol || looksAbsolute) {
      return normalized;
    }
    if (this.projectResources?.getCurrentProject()) {
      return this.projectResources.resolveForRead(normalized);
    }
    return basePath
      ? `${basePath.replace(/\\/g, '/').replace(/\/+$/, '')}/${normalized.replace(/^\/+/, '')}`
      : normalized;
  }

  /**
   * Mux audio sources and/or transcode video via FFmpeg.
   * If sources is empty and no transcode needed, copies the temp video to final path.
   */
  async mix(
    videoPath: string,
    outputPath: string,
    sources: AudioSource[],
    config: AudioMixConfig,
    isTranscodeNeeded: boolean,
  ): Promise<{ success: boolean; error?: string }> {
    if (sources.length > 0 || isTranscodeNeeded) {
      const result = await this.exportAPI.convert(videoPath, outputPath, {
        fps: config.fps,
        codec: isTranscodeNeeded ? config.codec : 'copy',
        audioCodec: config.audioCodec,
        audioSources: sources,
        width: config.width,
        height: config.height,
        totalFrames: config.totalFrames,
        bitrate: config.bitrateMbps,
        ...(config.transparent === true ? { transparent: true } : {}),
      });

      if (!result.success) {
        return {
          success: false,
          error: `Video conversion failed: ${result.error || result.stderr}`,
        };
      }
      return { success: true };
    }

    // No transcode and no audio — copy temp video to final path
    const tempData = await this.fsAPI.readFile(videoPath);
    if (tempData.success && tempData.data) {
      const writeResult = await this.fsAPI.writeFile(outputPath, tempData.data);
      if (writeResult.success) return { success: true };
      return { success: false, error: writeResult.error || 'Failed to write final video file' };
    }

    return { success: false, error: 'Failed to read temp video file' };
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function resolveExportEnvelope(
  interval: AudioInterval,
  startOffset: number,
): Pick<AudioSource, 'fadeIn' | 'fadeInStartGain' | 'fadeOut' | 'fadeOutStartGain'> {
  const envelope: Pick<AudioSource, 'fadeIn' | 'fadeInStartGain' | 'fadeOut' | 'fadeOutStartGain'> = {};
  const elapsed = Math.max(0, startOffset);

  if (interval.fadeIn !== undefined) {
    if (interval.fadeIn <= 0 || elapsed === 0) {
      envelope.fadeIn = interval.fadeIn;
    } else if (elapsed < interval.fadeIn) {
      envelope.fadeIn = interval.fadeIn - elapsed;
      envelope.fadeInStartGain = clampUnit(elapsed / interval.fadeIn);
    }
    // Once fade-in has completed, omitting fadeIn keeps the current gain at 1.
  }

  if (interval.fadeOut !== undefined) {
    const duration = interval.duration;
    const fadeOut = interval.fadeOut;
    const fadeOutStart = duration === undefined ? undefined : duration - fadeOut;
    if (
      fadeOut > 0
      && duration !== undefined
      && Number.isFinite(duration)
      && elapsed < duration
      && (elapsed > (fadeOutStart ?? duration) || (fadeOutStart ?? 0) < 0)
    ) {
      const remaining = duration - elapsed;
      envelope.fadeOut = remaining;
      envelope.fadeOutStartGain = clampUnit(remaining / fadeOut);
    } else {
      envelope.fadeOut = interval.fadeOut;
    }
  }

  return envelope;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function readPreparedString(value: PreparedRuntimeValue | unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? value : undefined;
  }
  if (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { runtimeUri?: unknown }).runtimeUri === 'string'
  ) {
    const runtimeUri = (value as { runtimeUri: string }).runtimeUri;
    return runtimeUri.trim() ? runtimeUri : undefined;
  }
  return undefined;
}
