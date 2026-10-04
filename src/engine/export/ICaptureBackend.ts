/**
 * Capture backend strategy — decouples the frame loop from the
 * specific capture mechanism (WebCodecs encoder vs raw-pixel extraction).
 */

export interface BackendInit {
  width: number;
  height: number;
  fps: number;
  bitrate: number; // in bps (e.g. 12_000_000)
  outputPath: string;
  codec: string;   // FFmpeg codec for the stream export
  isEncoded: boolean;
  /** Preserve the alpha channel through the FFmpeg encode (yuva420p, subtitle-only exports). */
  transparent?: boolean;
}

export interface BackendFrame {
  /** Zero-copy: provide a canvas for VideoFrame capture */
  canvas?: HTMLCanvasElement;
  /** Raw-pixels fallback: provide a Uint8Array or Uint8ClampedArray of RGBA pixels */
  pixels?: Uint8Array | Uint8ClampedArray;
  /** Frame index in the capture sequence */
  frameIndex: number;
  fps: number;
}

export interface ICaptureBackend {
  /** One-time setup — configure encoder, start stream export */
  init(config: BackendInit): Promise<void>;

  /** Encode/push a single frame. Returns a promise that resolves when backpressure clears. */
  encodeFrame(frame: BackendFrame): Promise<void>;

  /** Flush remaining encoder frames, close stream, return the video path */
  finish(): Promise<void>;
}
