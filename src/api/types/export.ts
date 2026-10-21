export type ExportVideoCodec = 'h264' | 'hevc' | 'vp9' | 'av1' | 'prores';
export type ExportEncodingSpeed = 'fast' | 'balanced' | 'quality';
export type ExportRateControl = { mode: 'crf'; crf: number } | { mode: 'bitrate'; bitrateMbps: number };

export interface ExportEncodingSettings {
  videoCodec: ExportVideoCodec;
  implementation: 'auto' | 'webcodecs' | 'ffmpeg';
  quality: 'balanced' | 'high' | 'custom';
  /** Omitted or 'auto': choose an available FFmpeg encoder, with software fallback. */
  ffmpegEncoder?: string;
  rateControl?: ExportRateControl;
  speed?: ExportEncodingSpeed;
  allowH264Intermediate?: boolean;
  intermediateBitrateMbps?: number;
}

export interface ExportEncodingInfo {
  implementation: 'webcodecs' | 'ffmpeg' | 'webcodecs-transcode';
  encoder: string;
  attempt: number;
  fallbackReason?: string;
}

export interface ExportOperationResult {
  success: boolean;
  /** Encoded sample size, measured before main-process cleanup. */
  sizeBytes?: number;
  error?: string;
  stderr?: string;
  failureKind?: 'encoder' | 'output' | 'process';
}

export interface ExportConfig {
  format: 'mp4' | 'webm' | 'mkv' | 'mov';
  codec: string;
  bitrateMbps: number;
  /** When present, takes precedence over legacy codec/backend options. */
  encoding?: ExportEncodingSettings;
  fps: number;
  width: number;
  height: number;
  /** Different output aspect ratios preserve proportions, using bars or crop. */
  fit?: import('./video-format').OutputFit;
  rangeStart: number;
  rangeEnd: number;
  includeAudio: boolean;
  /** Include the subtitle layer (dialogue/text layers) in the exported video. Defaults to true when omitted. */
  includeSubtitles?: boolean;
  /**
   * Export only the subtitle layer on a fully transparent background.
   * Requires MOV + Apple ProRes 4444 (yuva444p10le) via the RawPixels
   * backend — the bundled FFmpeg's only reliable alpha-preserving pipeline.
   * Defaults to false.
   */
  subtitleOnly?: boolean;
  /**
   * Export only the subtitle layer over a solid chroma-green background
   * (RGB 0,255,0) for keying in editors. Requires MP4 + H.264 (libx264).
   * Mutually exclusive with subtitleOnly. Defaults to false.
   */
  subtitleChroma?: boolean;
  backend: 'webcodecs' | 'rawpixels';
  outputPath: string;
  /** Forwarded to AudioMixer for FFmpeg frame-progress parsing */
  ffmpegLogCallback?: (msg: string) => void;
}

export interface ExportProgress {
  phase: 'capture' | 'mix' | 'done';
  percent: number;
  frame?: number;
  totalFrames?: number;
  audioSourceCount?: number;
  encoding?: ExportEncodingInfo;
}

export interface ExportResult {
  success: boolean;
  sizeBytes?: number;
  cancelled?: boolean;
  outputPath?: string;
  error?: string;
  encoding?: ExportEncodingInfo;
}

export interface FFmpegAudioSource {
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

export interface FFmpegVideoOptions {
  codec?: string;
  /** Target bitrate in Mbps; only used when crf is absent. */
  bitrate?: number;
  crf?: number;
  speed?: ExportEncodingSpeed;
  transparent?: boolean;
}

export interface FFmpegStreamMuxOptions {
  /** Measure the private task output, then remove it without publishing. */
  measureOnly?: boolean;
  audioSources?: FFmpegAudioSource[];
  audioCodec?: string;
  totalFrames?: number;
  /** Encode the incoming compressed stream instead of copying it. */
  transcode?: FFmpegVideoOptions;
}

export interface FFmpegStreamOptions extends FFmpegVideoOptions, FFmpegStreamMuxOptions {
  fps?: number;
  width?: number;
  height?: number;
  inputFormat?: 'rgba' | 'h264' | 'hevc' | 'ivf';
  vflip?: boolean;
  /** Legacy encoded input defaults to H.264 Annex B. */
  isEncoded?: boolean;
}

export interface FFmpegConvertOptions extends FFmpegVideoOptions {
  fps?: number;
  width?: number;
  height?: number;
  audioPaths?: string[];
  audioSources?: FFmpegAudioSource[];
  audioCodec?: string;
  totalFrames?: number;
}
