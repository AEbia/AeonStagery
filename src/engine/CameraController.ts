/**
 * AeonStagery — Camera Controller
 *
 * Advanced camera system supporting:
 * - Pan, zoom, rotation with GSAP easing
 * - Multi-keyframe camera paths for cinematic sequences
 * - Camera shake with configurable frequency/direction/decay
 * - Character follow mode with smoothing
 * - Reusable camera presets
 *
 * The camera works by transforming the sceneContainer (NOT the full stage),
 * so UI layers (subtitle, overlay) remain unaffected by camera transforms.
 */

import gsap from 'gsap';
import { stageManager } from './StageManager';
import { live2DManager } from './Live2DManager';
import { hookSystem } from '../api/hooks';
import type { Vec2 } from '../api/types/common';
import { DEFAULT_CAMERA_FOCUS_PART } from '../api/types/camera';
import type {
  CameraMoveConfig,
  CameraShakeConfig,
  CameraKeyframe,
  CameraPathConfig,
  CameraFollowConfig,
  CameraState,
  CameraHitchcockConfig,
  CameraMotionConfig,
} from '../api/types/camera';
import { resolveVec2 } from './utils/math';
import { CAMERA_EASING_MAP } from './utils/cameraEasing';
import { MOVE_HANDLERS } from './MoveHandlers';
import { normalizeCharacterEase } from './CharacterAnimationContract';

class CameraController {
  /** Virtual camera state (normalized coordinates). Public so move handlers can read current values. */
  state: CameraState = {
    position: { x: 0.5, y: 0.5 },
    zoom: 1,
    rotation: 0,
  };

  /** Shake offset (pixels) applied on top of state */
  private _shakeOffset = { x: 0, y: 0 };

  /** Named presets */
  private presets: Map<string, CameraKeyframe[]> = new Map();

  /** Follow mode */
  private followTarget: string | null = null;
  private followConfig: CameraFollowConfig = {};
  private followTicker: (() => void) | null = null;

  /** Active shake animation */
  private shakeTimeline: gsap.core.Timeline | null = null;

  /** Exposed for CameraCoordinator — kills the shake timeline and resets offset. */
  getShakeTimeline(): gsap.core.Timeline | null {
    return this.shakeTimeline;
  }

  /** Exposed for CameraCoordinator — replaces shakeTimeline and resets offset in one atomic operation. */
  resetShake(): void {
    if (this.shakeTimeline) {
      this.shakeTimeline.kill();
      this.shakeTimeline = null;
    }
    this._shakeOffset.x = 0;
    this._shakeOffset.y = 0;
  }

  /**
   * DEPRECATED: Camera no longer manipulates PixiJS containers.
   * Projection is now handled per-proxy in applyProxyTransform via projectToScreen().
   * This method is retained as a no-op for backward compatibility — the 20+
   * GSAP `onUpdate: () => this.applyTransform()` callbacks throughout this class
   * now harmlessly call this empty method without needing any code changes.
   */
  applyTransform(): void {
    // no-op — projection is per-proxy via projectToScreen()
  }

  /**
   * Initialize camera (reset to default).
   */
  init(): void {
    // NEVER replace the state/position objects — GSAP tweens hold references to them.
    const pos = this.state.position as { x: number; y: number };
    pos.x = 0.5;
    pos.y = 0.5;
    this.state.zoom = 1;
    this.state.rotation = 0;
    this._shakeOffset.x = 0;
    this._shakeOffset.y = 0;
    this.unfollow();
    this.applyTransform();
  }

  /**
   * Pan the camera to a target position.
   */
  panTo(target: Vec2, duration: number, ease: string = 'power3.inOut', delay: number = 0): gsap.core.Tween {
    const pos = resolveVec2(target);
    hookSystem.execute('camera:move', { type: 'pan', target: pos, duration });

    const tween = gsap.to(this.state.position as { x: number; y: number }, {
      x: pos.x,
      y: pos.y,
      duration,
      ease,
      delay,
      onUpdate: () => this.applyTransform(),
    });

    return tween;
  }

  /**
   * Zoom the camera.
   */
  zoomTo(scale: number, duration: number, ease: string = 'power3.inOut'): gsap.core.Tween {
    hookSystem.execute('camera:move', { type: 'zoom', scale, duration });

    return gsap.to(this.state, {
      zoom: scale,
      duration,
      ease,
      onUpdate: () => this.applyTransform(),
    });
  }

  /**
   * Simultaneous pan + zoom + rotate.
   * This is the primary method for complex camera work.
   *
   * When targeting a character, the position is captured at the moment the
   * timeline segment actually plays (via call()), not at construction time.
   * This avoids the stale-target bug: if the character model finishes loading
   * or its animation settles between construction and playback, the camera
   * moves to the correct live position.
   */
  moveTo(config: CameraMoveConfig): gsap.core.Tween {
    const duration = config.duration ?? 1;
    const ease = config.ease ?? 'power3.inOut';
    const delay = config.delay ?? 0;

    const tl = gsap.timeline();

    // ── Zoom + Rotation ────────────────────────────────────
    if (config.zoom !== undefined || config.rotation !== undefined) {
      const anim: any = {};
      if (config.zoom !== undefined) anim.zoom = config.zoom;
      if (config.rotation !== undefined) anim.rotation = config.rotation;

      tl.to(this.state, {
        ...anim,
        duration, ease, delay,
        onUpdate: () => this.applyTransform(),
      }, 0);
    }

    // ── Position ──────────────────────────────────────────
    if (config.targetCharacter) {
      const charId = config.targetCharacter;
      const part = config.targetPart ?? 'chest';
      const ox = config.offsetX ?? 0;
      const oy = config.offsetY ?? 0;

      tl.to(this.state.position as { x: number; y: number }, {
        x: () => {
          const p = live2DManager.getPoint(charId, part);
          if (p) {
            let Z = this.state.zoom ?? 1;
            if (typeof config.zoom === 'number') Z = config.zoom;
            else if (typeof (config.zoom as any) === 'string') {
              const zStr = config.zoom as any as string;
              if (zStr.startsWith('+=')) Z += parseFloat(zStr.slice(2));
              else if (zStr.startsWith('-=')) Z -= parseFloat(zStr.slice(2));
              else Z = parseFloat(zStr);
            }
            if (isNaN(Z) || Z <= 0) Z = 1;
            const halfView = 0.5 / Z;
            return Math.max(halfView, Math.min(p.x + ox, 1 - halfView));
          }
          return (this.state.position as { x: number; y: number }).x;
        },
        y: () => {
          const p = live2DManager.getPoint(charId, part);
          if (p) {
            let Z = this.state.zoom ?? 1;
            if (typeof config.zoom === 'number') Z = config.zoom;
            else if (typeof (config.zoom as any) === 'string') {
              const zStr = config.zoom as any as string;
              if (zStr.startsWith('+=')) Z += parseFloat(zStr.slice(2));
              else if (zStr.startsWith('-=')) Z -= parseFloat(zStr.slice(2));
              else Z = parseFloat(zStr);
            }
            if (isNaN(Z) || Z <= 0) Z = 1;
            const halfView = 0.5 / Z;
            return Math.max(halfView, Math.min(p.y + oy, 1 - halfView));
          }
          return (this.state.position as { x: number; y: number }).y;
        },
        duration, ease, delay,
        onUpdate: () => this.applyTransform(),
      }, 0);
    } else if (config.target || config.position) {
      const targetPos = resolveVec2(config.target || config.position);
      
      // GSAP relative string support
      let tx: any = targetPos.x;
      let ty: any = targetPos.y;
      
      if (typeof config.target === 'string' && (config.target as string).startsWith('+=')) tx = config.target;
      if (typeof config.target === 'string' && (config.target as string).startsWith('-=')) tx = config.target;
      
      tl.to(this.state.position as { x: number; y: number }, {
        x: tx, y: ty,
        duration, ease, delay,
        onUpdate: () => this.applyTransform(),
      }, 0);
    }

    hookSystem.execute('camera:move', { type: 'moveTo', config });
    return tl as any;
  }

  /**
   * Camera shake effect.
   */
  shake(config: CameraShakeConfig = {}): gsap.core.Timeline {
    const {
      intensity = 0.5,
      frequency = 15,
      duration = 0.5,
      decay = true,
      direction = 'both',
    } = config;

    // Kill existing shake
    if (this.shakeTimeline) {
      this.shakeTimeline.kill();
    }

    hookSystem.execute('camera:shake', config);

    const maxOffset = intensity * 30; // pixels

    const tl = gsap.timeline();
    const steps = Math.ceil(frequency * duration);
    const stepDuration = duration / steps;

    for (let i = 0; i < steps; i++) {
      const progress = i / steps;
      const decayFactor = decay ? (1 - progress) : 1;
      const offsetX = (direction !== 'vertical')
        ? (Math.random() * 2 - 1) * maxOffset * decayFactor
        : 0;
      const offsetY = (direction !== 'horizontal')
        ? (Math.random() * 2 - 1) * maxOffset * decayFactor
        : 0;

      tl.to(this._shakeOffset, {
        x: offsetX,
        y: offsetY,
        duration: stepDuration,
        ease: 'none',
        onUpdate: () => this.applyTransform(),
      });
    }

    // Return to center
    tl.to(this._shakeOffset, {
      x: 0,
      y: 0,
      duration: stepDuration,
      ease: 'power3.out',
      onUpdate: () => this.applyTransform(),
    });

    this.shakeTimeline = tl;
    return tl;
  }

  /**
   * Rotate the camera.
   */
  rotateTo(angle: number, duration: number, ease: string = 'power3.inOut', delay: number = 0): gsap.core.Tween {
    return gsap.to(this.state, {
      rotation: angle,
      duration,
      ease,
      delay,
      onUpdate: () => this.applyTransform(),
    });
  }

  /**
   * Hitchcock / Dolly Zoom with Y-axis dynamic compensation.
   *
   * Simultaneously animates camera zoom and character scale while
   * recalculating targetY every frame so the target body part stays
   * at a fixed screen position throughout the animation.
   *
   * Formula: S(t) * Z(t) = S_start * Z_start (constant)
   *          targetY(t) = (Py - S(t)) + (0.5 - Sy_desired) / Z(t)
   */
  hitchcockZoom(config: CameraHitchcockConfig): gsap.core.Timeline {
    const {
      characterId,
      targetPart = DEFAULT_CAMERA_FOCUS_PART,
      screenTarget,
      zoomStart,
      zoomEnd,
      scaleStart,
      scaleEnd,
      duration,
      ease = 'power3.inOut',
      delay = 0,
    } = config;

    const tl = gsap.timeline({ delay });

    // Resolve desired screen position of the target body part
    const screenTargetResolved = resolveVec2(screenTarget);
    const SyDesired = screenTargetResolved.y;

    // Pre-compute the Hitchcock constant
    const hitchcockConstant = scaleStart * zoomStart;
    if (hitchcockConstant === 0) {
      console.warn('[Camera] Hitchcock constant is zero; check scaleStart and zoomStart.');
    }

    // Get the character's anchor Y position (fixed)
    const initialPoint = live2DManager.getPoint(characterId, targetPart);
    const initialPos = live2DManager.getPosition(characterId);
    // Px, Py = character anchor position in normalized coords
    const Px = initialPoint ? initialPoint.x : 0.5;
    const Py = initialPos ? initialPos.y : 1.0;

    // Set initial character scale
    live2DManager.setCharacterScale(characterId, scaleStart);

    // Set initial camera state
    this.state.zoom = zoomStart;
    (this.state.position as { x: number; y: number }).x = Px;
    (this.state.position as { x: number; y: number }).y =
      (Py - scaleStart) + (0.5 - SyDesired) / zoomStart;
    this.applyTransform();

    // Animate zoom with per-frame Y-axis compensation
    tl.to(this.state, {
      zoom: zoomEnd,
      duration,
      ease,
      onUpdate: () => {
        const Z = this.state.zoom;
        if (Z === 0) return;

        // Per-frame character scale from Hitchcock formula
        const S = hitchcockConstant / Z;

        // Apply character scale
        live2DManager.setCharacterScale(characterId, S);

        // Per-frame targetY to keep the body part at fixed screen position
        // Formula: targetY = (Py - S) + (0.5 - Sy_desired) / Z
        let targetY = (Py - S) + (0.5 - SyDesired) / Z;

        // targetX: track the character's current head X position
        const currentPoint = live2DManager.getPoint(characterId, targetPart);
        let targetX = currentPoint ? currentPoint.x : Px;

        // Viewport clamping to prevent black borders
        const halfView = 0.5 / Z;
        targetX = Math.max(halfView, Math.min(targetX, 1.0 - halfView));
        targetY = Math.max(halfView, Math.min(targetY, 1.0 - halfView));

        // Apply
        (this.state.position as { x: number; y: number }).x = targetX;
        (this.state.position as { x: number; y: number }).y = targetY;

        this.applyTransform();
      },
      onComplete: () => {
        // Ensure final scale is exactly as specified
        live2DManager.setCharacterScale(characterId, scaleEnd);
      },
    });

    hookSystem.execute('camera:move', { type: 'hitchcockZoom', config });
    return tl;
  }

  /**
   * Execute a semantic camera motion.
   *
   * Combines a physical move type with an emotional easing profile and a focus target.
   * Three semantic axes: move (what), easing (how it feels), focus (who/where).
   *
   * Multiple motions overlapping on the same timeline compose naturally —
   * each affects different camera properties (zoom, position, rotation, shake).
   */
  executeMotion(config: CameraMotionConfig): gsap.core.Tween | gsap.core.Timeline {
    const gsapEasing = CAMERA_EASING_MAP[config.easing] || 'power2.inOut';

    // Resolve focus: explicit `focus` field takes precedence over legacy flat params
    const focus = config.focus;
    const effectiveCharId = focus?.character || config.characterId;
    const effectivePart = focus?.part || config.targetPart || DEFAULT_CAMERA_FOCUS_PART;
    const effectivePoint = focus?.point || config.target;

    const handler = MOVE_HANDLERS[config.move];
    if (!handler) {
      throw new Error(`[Camera] Unknown move type: "${config.move}". Valid: ${Object.keys(MOVE_HANDLERS).join(', ')}`);
    }

    // Attach resolved focus back so each handler can read it uniformly
    const resolved: CameraMotionConfig = {
      ...config,
      characterId: effectiveCharId,
      targetPart: effectivePart,
      target: effectivePoint,
    };

    const result = handler.call(this, resolved, gsapEasing);
    hookSystem.execute('camera:move', { type: 'motion', config: resolved });
    return result;
  }

  /**
   * Reset camera to default state.
   */
  reset(duration: number = 1, ease: string = 'power3.inOut'): gsap.core.Timeline {
    const tl = gsap.timeline();
    tl.call(() => {
      this.unfollow();
      this.resetShake();
    }, undefined, 0);

    const gsapEase = normalizeCharacterEase(ease, 'power3.inOut');

    tl.to(this.state.position, {
      x: 0.5,
      y: 0.5,
      duration,
      ease: gsapEase,
      onUpdate: () => this.applyTransform(),
    }, 0);

    tl.to(this.state, {
      zoom: 1,
      rotation: 0,
      duration,
      ease: gsapEase,
      onUpdate: () => this.applyTransform(),
    }, 0);

    return tl;
  }

  /**
   * Create a complex camera path with multiple keyframes.
   *
   * This is the most powerful method for cinematic camera work. Example:
   * ```
   * camera.createPath([
   *   { time: 0,   position: [0.2, 0.5], zoom: 1.0 },
   *   { time: 1.5, position: [0.5, 0.3], zoom: 1.5, ease: 'power2.inOut' },
   *   { time: 3.0, position: [0.8, 0.5], zoom: 1.2, rotation: 5 },
   *   { time: 4.5, position: [0.5, 0.5], zoom: 1.0, rotation: 0 },
   * ]);
   * ```
   */
  createPath(keyframes: CameraKeyframe[], config: CameraPathConfig = {}): gsap.core.Timeline {
    // ── Parse JSON-string keyframes from the UI ──
    let kfs: CameraKeyframe[];
    if (typeof keyframes === 'string') {
      try {
        kfs = JSON.parse(keyframes);
      } catch {
        throw new Error('[Camera] Path keyframes must be valid JSON (array of keyframes)');
      }
    } else {
      kfs = keyframes;
    }

    if (!Array.isArray(kfs) || kfs.length < 2) {
      throw new Error('[Camera] Path requires at least 2 keyframes (array)');
    }

    // ── Sort by time ascending (robustness against manual-edited JSON) ──
    kfs = [...kfs].sort((a, b) => (a.time ?? 0) - (b.time ?? 0));

    const tl = gsap.timeline({
      repeat: config.repeat ?? 0,
      yoyo: config.yoyo ?? false,
      delay: config.startTime ?? 0,
    });

    // ── Fix 1: Use .set() for the initial keyframe, NOT imperative code ──
    //    This keeps the first-frame state inside the GSAP timeline so it only
    //    applies when the timeline actually plays (or is seeked to).
    // ── Fix 2: Never replace the position object reference — mutate properties
    //    so existing tweens on this.state.position stay connected.
    const posRef = this.state.position as { x: number; y: number };
    const first = kfs[0];
    if (first.position) {
      const p = resolveVec2(first.position);
      tl.set(posRef, { x: p.x, y: p.y }, 0);
    }
    if (first.zoom !== undefined) {
      tl.set(this.state, { zoom: first.zoom }, 0);
    }
    if (first.rotation !== undefined) {
      tl.set(this.state, { rotation: first.rotation }, 0);
    }

    // Animate through remaining keyframes
    for (let i = 1; i < kfs.length; i++) {
      const prev = kfs[i - 1];
      const kf = kfs[i];
      const duration = kf.time - prev.time;
      const ease = normalizeCharacterEase(kf.ease ?? config.defaultEase, 'power2.inOut');
      const timeOffset = prev.time;

      if (kf.position) {
        const pos = resolveVec2(kf.position);
        tl.to(posRef, {
          x: pos.x,
          y: pos.y,
          duration,
          ease,
          onUpdate: () => this.applyTransform(),
        }, timeOffset);
      }

      if (kf.zoom !== undefined) {
        tl.to(this.state, {
          zoom: kf.zoom,
          duration,
          ease,
          onUpdate: () => this.applyTransform(),
        }, timeOffset);
      }

      if (kf.rotation !== undefined) {
        tl.to(this.state, {
          rotation: kf.rotation,
          duration,
          ease,
          onUpdate: () => this.applyTransform(),
        }, timeOffset);
      }

      if (kf.label) {
        tl.addLabel(kf.label, kf.time);
      }
    }

    hookSystem.execute('camera:move', { type: 'path', keyframes: kfs, config });
    return tl;
  }

  /**
   * Follow a character with the camera.
   */
  follow(characterId: string, config: CameraFollowConfig = {}): void {
    this.unfollow();

    this.followTarget = characterId;
    // Resolve defaults AFTER merging: callers like CameraCoordinator pass raw
    // statement params whose offset/smoothing keys exist but may be undefined,
    // and a later spread would otherwise clobber the built-in defaults.
    const merged: CameraFollowConfig = { ...config };
    merged.offset = merged.offset ?? [0, -0.1];
    merged.smoothing = merged.smoothing ?? 0.85;
    this.followConfig = merged;

    const app = stageManager.getApp();
    const tickerFn = (ticker?: { deltaTime?: number }) => {
      // PixiJS ticker.deltaTime is scalar frames (60fps baseline) → seconds.
      const dt = typeof ticker?.deltaTime === 'number' ? ticker.deltaTime / 60 : undefined;
      this.tickFollow(false, dt);
    };
    app.ticker.add(tickerFn as any);
    this.followTicker = tickerFn as any;
  }

  /**
   * Tick the follow logic (can be called manually during seek/scrub when ticker is paused).
   *
   * `deltaSeconds` makes the smoothing frame-rate independent; when omitted it
   * falls back to the legacy per-frame behavior calibrated at a 60fps baseline.
   */
  tickFollow(forceInstant: boolean = false, deltaSeconds: number = 1 / 60): void {
    if (!this.followTarget) return;

    const pos = live2DManager.getPosition(this.followTarget);
    if (!pos) return;

    const currentPos = this.state.position as { x: number; y: number };
    const offset = resolveVec2(this.followConfig.offset ?? [0, 0]);
    // Same viewport clamp as moveTo()/hitchcockZoom(): keep the view inside the
    // stage extent for the current zoom so tracking never reveals black edges.
    const zoom = this.state.zoom > 0 ? this.state.zoom : 1;
    const halfView = 0.5 / zoom;
    const targetX = Math.max(halfView, Math.min(pos.x + offset.x, 1 - halfView));
    const targetY = Math.max(halfView, Math.min(pos.y + offset.y, 1 - halfView));

    let alpha: number;
    if (forceInstant) {
      alpha = 1;
    } else {
      const smoothing = this.followConfig.smoothing ?? 0.85;
      alpha = 1 - Math.pow(smoothing, Math.max(0, deltaSeconds) * 60);
    }

    currentPos.x += (targetX - currentPos.x) * alpha;
    currentPos.y += (targetY - currentPos.y) * alpha;

    this.applyTransform();
  }

  /**
   * Stop following a character.
   */
  unfollow(): void {
    if (this.followTicker) {
      const app = stageManager.getApp();
      app.ticker.remove(this.followTicker as any);
      this.followTicker = null;
    }
    this.followTarget = null;
  }

  /**
   * Release follow tracking as a timeline action: stops the ticker without
   * touching the composed camera state (position/zoom/rotation stay put).
   * Follow only owns the position channel — unlike reset().
   */
  stopFollow(): gsap.core.Timeline {
    const tl = gsap.timeline();
    tl.call(() => this.unfollow());
    return tl;
  }

  /**
   * Restore the position channel to the stage-default center baseline.
   * Zoom/rotation/follow/shake are untouched — used by seek reconciliation
   * when the target time precedes every positional camera effect, so stale
   * values written by a follow ticker cannot leak into uncovered regions.
   */
  resetPosition(): void {
    const pos = this.state.position as { x: number; y: number };
    pos.x = 0.5;
    pos.y = 0.5;
    this.applyTransform();
  }

  /**
   * Hard-set the given camera channels in place (CameraCoordinator baseline
   * restoration). Only patched keys are written; object references are kept
   * so live GSAP tweens stay connected to the state.
   */
  applyResolvedState(patch: {
    position?: { x: number; y: number };
    zoom?: number;
    rotation?: number;
  }): void {
    if (patch.position) {
      const pos = this.state.position as { x: number; y: number };
      pos.x = patch.position.x;
      pos.y = patch.position.y;
    }
    if (patch.zoom !== undefined) this.state.zoom = patch.zoom;
    if (patch.rotation !== undefined) this.state.rotation = patch.rotation;
    this.applyTransform();
  }

  /**
   * Create a reusable camera preset.
   */
  createPreset(name: string, keyframes: CameraKeyframe[]): void {
    this.presets.set(name, keyframes);
  }

  /**
   * Play a saved camera preset.
   */
  playPreset(name: string, config?: CameraPathConfig): gsap.core.Timeline | null {
    const keyframes = this.presets.get(name);
    if (!keyframes) {
      console.warn(`[Camera] Preset "${name}" not found.`);
      return null;
    }
    return this.createPath(keyframes, config);
  }

  /**
   * Get the current camera state.
   */
  getState(): CameraState {
    const position = resolveVec2(this.state.position);
    return {
      position,
      zoom: this.state.zoom,
      rotation: this.state.rotation,
    };
  }
}

export const cameraController = new CameraController();
export default CameraController;
