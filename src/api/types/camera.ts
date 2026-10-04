import type { Vec2 } from './common';

export interface CameraMoveConfig {
  target?: Vec2;
  /** Alias for target */
  position?: Vec2;
  /** Target a character's specific body part */
  targetCharacter?: string;
  targetPart?: 'head' | 'chest' | 'feet' | 'center';
  /** Offset from the body part position (normalized, added to getPoint result) */
  offsetX?: number;
  offsetY?: number;
  zoom?: number | string;
  rotation?: number;
  duration: number;
  ease?: string;
  /** Delay before starting this move */
  delay?: number;
}

export interface CameraShakeConfig {
  intensity?: number;    // 0-1, default 0.5
  frequency?: number;    // Hz, default 15
  duration?: number;     // seconds, default 0.5
  decay?: boolean;       // fade out intensity, default true
  direction?: 'both' | 'horizontal' | 'vertical';
}

export interface CameraKeyframe {
  /** Time position in seconds (relative to path start) */
  time: number;
  /** Camera position in normalized coords */
  position?: Vec2;
  /** Zoom level */
  zoom?: number;
  /** Rotation in degrees */
  rotation?: number;
  /** GSAP easing for interpolation TO this keyframe */
  ease?: string;
  /** Optional label for this keyframe */
  label?: string;
}

export interface CameraPathConfig {
  /** Start time offset on master timeline */
  startTime?: number;
  /** Loop the path */
  loop?: boolean;
  /** Repeat count (-1 = infinite) */
  repeat?: number;
  /** Yoyo back and forth */
  yoyo?: boolean;
  /** Default ease for keyframes without explicit ease */
  defaultEase?: string;
}

export interface CameraFollowConfig {
  /** Offset from character center */
  offset?: Vec2;
  /** Follow smoothness (0 = instant, 1 = very smooth) */
  smoothing?: number;
  /** Min/max zoom limits */
  zoomRange?: [number, number];
  /** Auto-zoom based on number of visible characters */
  autoZoom?: boolean;
}

export interface CameraHitchcockConfig {
  /** Character to focus on during the dolly zoom */
  characterId: string;
  /** Body part to keep at a fixed screen position */
  targetPart?: 'head' | 'chest' | 'feet' | 'center';
  /** Desired screen position for the target part (normalized [0-1]) */
  screenTarget?: Vec2;
  /** Starting camera zoom */
  zoomStart: number;
  /** Ending camera zoom */
  zoomEnd: number;
  /** Starting character scale */
  scaleStart: number;
  /** Ending character scale (should satisfy scaleStart * zoomStart = scaleEnd * zoomEnd) */
  scaleEnd: number;
  /** Duration in seconds */
  duration: number;
  /** GSAP easing */
  ease?: string;
  /** Delay before starting */
  delay?: number;
}

export interface CameraState {
  position: Vec2;
  zoom: number;
  rotation: number;
}

/** Physical camera movement types — extensible vocabulary for future moves */
export type CameraMoveType =
  | 'push'     // Camera pushes towards subject (zoom in)
  | 'pull'     // Camera pulls away from subject (zoom out)
  | 'pan'      // Horizontal sweep
  | 'tilt'     // Vertical sweep
  | 'zoom'     // Pure focal change without position compensation
  | 'rotate'   // Rotation (Dutch angle, vertigo)
  | 'dolly'    // Hitchcock dolly zoom with Y-axis compensation
  | 'shake'    // Camera instability / handheld
  | 'follow';  // Continuous character tracking

/**
 * Emotional easing profiles.
 * Same physical move + different easing = completely different emotional reception.
 */
export type CameraEasing =
  | 'smooth'       // 缓入缓出 — balanced, natural, emotional build
  | 'accelerate'   // 先慢后快(急出) — sudden rush, urgency, shock
  | 'overshoot'    // 回弹 — overshoots then settles, emphatic
  | 'linear'       // 匀速 — mechanical, calm observation, farewell
  | 'decelerate'   // 先快后慢(缓入) — fast start → gentle stop
  | 'bounce'       // 弹跳 — playful, comedic
  | 'anticipate'   // 预备动作 — wind-up before release, dramatic
  | 'hesitate';    // 犹豫 — slow uncertain start, reluctant

export interface CameraMotionConfig {
  /** Physical camera movement — what the camera does */
  move: CameraMoveType;
  /** Emotional velocity profile — how it feels */
  easing: CameraEasing;
  /** Who/what the camera looks at */
  focus?: {
    character?: string;
    part?: 'head' | 'chest' | 'center';
    point?: Vec2;
    offsetX?: number;
    offsetY?: number;
  };

  // ── Target ──
  characterId?: string;
  targetPart?: 'head' | 'chest' | 'feet' | 'center';
  target?: Vec2;
  to?: Vec2;

  // ── Zoom ──
  zoom?: number | string; // push/pull: GSAP relative string; zoom: absolute target; dolly: use zoomStart/zoomEnd
  zoomDelta?: number;   // (deprecated, use zoom)
  zoomLevel?: number;   // (deprecated, use zoom)
  zoomStart?: number;
  zoomEnd?: number;

  // ── Scale (for dolly) ──
  scaleStart?: number;
  scaleEnd?: number;

  // ── Rotation ──
  angle?: number;
  rotations?: number;
  direction?: 'cw' | 'ccw';

  // ── Pan / Tilt / Rotate ──
  strength?: number;   // movement magnitude (normalized, for pan/tilt)

  // ── Shake ──
  intensity?: number;
  frequency?: number;
  decay?: boolean;
  shakeDirection?: 'both' | 'horizontal' | 'vertical';

  // ── Follow ──
  offset?: Vec2;
  smoothing?: number;
  autoUnfollow?: boolean;  // stop following after duration

  // ── Tilt ──
  toY?: number;

  // ── Timing ──
  duration: number;
  delay?: number;
}
