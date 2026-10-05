export interface ExportConfig {
  format: 'mp4' | 'webm' | 'mov';
  codec: string;
  bitrateMbps: number;
  fps: number;
  width: number;
  height: number;
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
}

export interface ExportResult {
  success: boolean;
  cancelled?: boolean;
  outputPath?: string;
  error?: string;
}
