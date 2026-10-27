import gsap from 'gsap';
import type CameraController from './CameraController';
import type { CameraMotionConfig } from '../api/types/camera';
import { resolveVec2 } from './utils/math';

export type MoveHandlerFn = (
  this: CameraController,
  config: CameraMotionConfig & { resolveFocusPosition?: CameraFocusPositionResolver },
  ease: string
) => gsap.core.Tween | gsap.core.Timeline;

export type CameraFocusPositionResolver = (characterId: string, part: string) => { x: number; y: number } | null;

export const MOVE_HANDLERS: Record<string, MoveHandlerFn> = {
  /**
   * push — Camera pushes towards the focus target (zoom in).
   * Emotional mapping:
   *   smooth: creeping tension, gradual focus on inner change
   *   accelerate: sudden revelation, shock zoom
   *   overshoot: emphatic punctuation, comedic beat
   */
  push(config, ease) {
    const {
      characterId, targetPart = 'head', target,
      duration = 2.0, delay = 0,
    } = config;
    const ox = config.focus?.offsetX ?? 0;
    const oy = config.focus?.offsetY ?? 0;
    
    const targetZoom: number | string = config.zoom !== undefined ? config.zoom : '+=0.3';
    
    if (characterId) {
      return this.moveTo({ targetCharacter: characterId, targetPart, offsetX: ox, offsetY: oy, zoom: targetZoom, duration, ease, delay }, config.resolveFocusPosition);
    }
    return this.moveTo({ target: target ?? [0.5, 0.4], zoom: targetZoom, duration, ease, delay });
  },

  /**
   * pull — Camera pulls away from subject (zoom out).
   *   linear: calm observation, emotional distancing, farewell
   *   decelerate: fast retreat then gentle settle
   */
  pull(config, ease) {
    const {
      characterId, targetPart = 'center', target,
      duration = 2.0, delay = 0,
    } = config;
    const ox = config.focus?.offsetX ?? 0;
    const oy = config.focus?.offsetY ?? 0;
    
    const targetZoom: number | string = config.zoom !== undefined ? config.zoom : '-=0.3';
    
    if (characterId) {
      return this.moveTo({ targetCharacter: characterId, targetPart, offsetX: ox, offsetY: oy, zoom: targetZoom, duration, ease, delay }, config.resolveFocusPosition);
    }
    return this.moveTo({ target: target ?? [0.5, 0.5], zoom: targetZoom, duration, ease, delay });
  },

  /**
   * pan — Horizontal sweep between subjects or points.
   *   impact (accelerate): whip pan — spatial continuity, "meanwhile"
   *   smooth: gentle lateral drift
   *   hesitate: reluctant look away
   */
  pan(config, ease) {
    const { characterId, targetPart = 'chest', target, to, strength, duration = 1.0, delay = 0 } = config;
    const ox = config.focus?.offsetX ?? 0;
    const oy = config.focus?.offsetY ?? 0;
    
    if (characterId) {
      return this.moveTo({ targetCharacter: characterId, targetPart, offsetX: ox, offsetY: oy, duration, ease, delay }, config.resolveFocusPosition);
    }

    const tl = gsap.timeline({ delay });
    let targetX: number | string = 0.5;
    let targetY: number | string | undefined = 0.5;
    
    if (to || target) {
      const p = resolveVec2(to || target!);
      targetX = p.x;
      targetY = p.y;
    } else if (strength !== undefined) {
      // Use GSAP relative string for runtime evaluation
      targetX = strength < 0 ? `-=${Math.abs(strength)}` : `+=${strength}`;
      // y stays at its runtime current value (no tween on y)
      targetY = undefined;
    }
    
    const vars: gsap.TweenVars = { duration, ease, onUpdate: () => this.applyTransform() };
    if (targetX !== undefined) vars.x = targetX;
    if (targetY !== undefined) vars.y = targetY;
    
    tl.to(this.state.position, vars, 0);

    if (config.zoom !== undefined || config.angle !== undefined) {
      const anim: gsap.TweenVars = {};
      if (config.zoom !== undefined) anim.zoom = config.zoom;
      if (config.angle !== undefined) anim.rotation = config.angle;
      tl.to(this.state, { ...anim, duration, ease, onUpdate: () => this.applyTransform() }, 0);
    }

    return tl;
  },

  /**
   * tilt — Vertical scan revealing/concealing information.
   *   smooth: slow scrutiny, vertical reveal of character/environment
   *   hesitate: reluctant gaze upward/downward
   */
  tilt(config, ease) {
    const { toY, strength, duration = 3.0, delay = 0 } = config;
    const tl = gsap.timeline({ delay });
    const pos = this.state.position as { x: number; y: number };

    let endY: number | string = 0.7;
    if (toY !== undefined) {
      endY = toY;
    } else if (strength !== undefined) {
      endY = strength < 0 ? `-=${Math.abs(strength)}` : `+=${strength}`;
    }
    
    tl.to(pos, {
      y: endY,
      duration,
      ease,
      onUpdate: () => this.applyTransform(),
    }, 0);

    if (config.zoom !== undefined || config.angle !== undefined) {
      const anim: gsap.TweenVars = {};
      if (config.zoom !== undefined) anim.zoom = config.zoom;
      if (config.angle !== undefined) anim.rotation = config.angle;
      tl.to(this.state, { ...anim, duration, ease, onUpdate: () => this.applyTransform() }, 0);
    }

    return tl;
  },

  /**
   * zoom — Pure focal change without position compensation.
   *   accelerate: crash zoom into detail
   *   overshoot: emphatic zoom with bounce
   */
  zoom(config, ease) {
    const {
      characterId, targetPart = 'center', target,
      zoom = 1.5, duration = 1.0, delay = 0,
    } = config;
    const ox = config.focus?.offsetX ?? 0;
    const oy = config.focus?.offsetY ?? 0;
    if (characterId) {
      return this.moveTo({ targetCharacter: characterId, targetPart, offsetX: ox, offsetY: oy, zoom, duration, ease, delay }, config.resolveFocusPosition);
    }
    return this.moveTo({ target: target ?? [0.5, 0.5], zoom, duration, ease, delay });
  },

  rotate(config, ease) {
    const {
      characterId, targetPart = 'center',
      angle = 12, rotations, direction = 'cw',
      zoomEnd, duration = 2.0, delay = 0, target
    } = config;

    const totalAngle = rotations
      ? rotations * 360 * (direction === 'ccw' ? -1 : 1)
      : angle;

    if (characterId) {
      return this.moveTo({ targetCharacter: characterId, targetPart, rotation: totalAngle, zoom: zoomEnd, duration, ease, delay }, config.resolveFocusPosition);
    }

    if (target) {
      return this.moveTo({ target, rotation: totalAngle, zoom: zoomEnd, duration, ease, delay });
    }

    const tl = gsap.timeline({ delay });
    const vars: gsap.TweenVars = { duration, ease, onUpdate: () => this.applyTransform() };
    if (zoomEnd !== undefined) {
      tl.to(this.state, { rotation: totalAngle, zoom: zoomEnd, ...vars }, 0);
    } else {
      tl.to(this.state, { rotation: totalAngle, ...vars }, 0);
    }
    return tl;
  },

  /**
   * dolly — Hitchcock dolly zoom with per-frame Y-axis compensation.
   *   smooth: slow psychological unraveling
   *   accelerate: sudden vertigo / realization
   *   Uses S(t)·Z(t) = constant to keep the focus point fixed on screen.
   */
  dolly(config, ease) {
    const {
      characterId, targetPart = 'head',
      zoomStart = 1.0, zoomEnd = 1.5,
      scaleStart = 1.0, scaleEnd,
      duration = 2.0, delay = 0,
    } = config;

    if (!characterId) {
      throw new Error('[Camera] dolly move requires a focus character (characterId or focus.character)');
    }

    const resolvedScaleEnd = scaleEnd ?? (scaleStart * zoomStart) / zoomEnd;

    return this.hitchcockZoom({
      characterId,
      targetPart,
      screenTarget: [0.5, 0.3],
      zoomStart,
      zoomEnd,
      scaleStart,
      scaleEnd: resolvedScaleEnd,
      duration,
      ease,
      delay,
    });
  },

  /**
   * shake — Camera instability simulating handheld / tremor.
   *   smooth (low intensity): subtle documentary realism
   *   accelerate (high intensity): sudden crisis, explosion impact
   *   hesitate (irregular): nervous trembling
   */
  shake(config, _ease) {
    const {
      intensity = 0.3, frequency = 12,
      duration = 2.0, decay = false,
      shakeDirection = 'both', delay = 0,
    } = config;
    const tl = gsap.timeline({ delay });
    tl.add(this.shake({ intensity, frequency, duration, decay, direction: shakeDirection }), 0);
    return tl;
  },

  /**
   * follow — Continuous character tracking via PixiJS ticker.
   *   Uses smooth lerp towards the character's current position each frame.
   *   Tracking persists until an explicit release; timing only delays its start.
   */
  follow(config, _ease) {
    const {
      characterId, delay = 0,
      offset = [0, -0.1], smoothing = 0.85,
    } = config;

    if (!characterId) {
      throw new Error('[Camera] follow requires a focus character');
    }

    const tl = gsap.timeline({ delay });
    tl.call(() => {
      this.follow(characterId, { offset, smoothing });
    });
    return tl;
  },
};
