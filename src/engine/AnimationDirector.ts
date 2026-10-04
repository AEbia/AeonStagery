/**
 * AeonStagery — Animation Director
 *
 * Central GSAP animation coordinator. Manages the master timeline,
 * character entrance/exit presets, and custom animation registration.
 * All animations are composable GSAP timelines.
 */

import gsap from 'gsap';
import { live2DManager } from './Live2DManager';
import type { Vec2 } from '../api/types/common';
import { resolveVec2 } from './utils/math';
import {
  CHARACTER_STAGE_HEIGHT,
  CHARACTER_STAGE_WIDTH,
  DEFAULT_CHARACTER_ENTER_EASE,
  DEFAULT_CHARACTER_EXIT_EASE,
  characterSlideEntranceOffsetPixels,
  normalizeCharacterEase,
  resolveCharacterModelHeight,
} from './CharacterAnimationContract';

const STAGE_WIDTH = CHARACTER_STAGE_WIDTH;
const STAGE_HEIGHT = CHARACTER_STAGE_HEIGHT;

/** Built-in enter animation presets */
type EnterPreset = 'fadeIn' | 'slideFromLeft' | 'slideFromRight' | 'slideFromBottom' |
  'zoomIn' | 'dropIn' | 'none';

/** Built-in exit animation presets */
type ExitPreset = 'fadeOut' | 'slideToLeft' | 'slideToRight' | 'slideToTop' |
  'flyUp' | 'dissolve' | 'zoomOut' | 'none';

/** Custom animation preset factory */
type AnimPresetFactory = (target: any, config: any) => gsap.core.Timeline;

class AnimationDirector {
  private masterTimeline: gsap.core.Timeline;
  private customPresets: Map<string, AnimPresetFactory> = new Map();

  constructor() {
    this.masterTimeline = gsap.timeline({ paused: true });
  }

  /**
   * Get the master timeline.
   */
  getMasterTimeline(): gsap.core.Timeline {
    return this.masterTimeline;
  }

  /**
   * Create a new master timeline (resets all animations).
   */
  resetMasterTimeline(): gsap.core.Timeline {
    this.masterTimeline.kill();
    this.masterTimeline = gsap.timeline({ paused: true });
    return this.masterTimeline;
  }

  /**
   * Create a sub-timeline that can be added to the master.
   */
  createTimeline(label?: string): gsap.core.Timeline {
    const tl = gsap.timeline();
    if (label) {
      this.masterTimeline.add(tl, label);
    }
    return tl;
  }

  /**
   * Play entrance animation for a character.
   */
  characterEnter(
    characterId: string,
    preset: EnterPreset = 'fadeIn',
    duration: number = 0.8,
    ease: string = DEFAULT_CHARACTER_ENTER_EASE,
    proxy?: any,
    targetOpacity?: number
  ): gsap.core.Timeline {
    // Older authored/runtime scenes used the compact `fade` spelling. Keep
    // that compatibility at the animation boundary so it still participates
    // in the same master-controlled timeline as the current `fadeIn` preset.
    const normalizedPreset = (preset as string) === 'fade' ? 'fadeIn' : preset;
    const resolvedEase = normalizeCharacterEase(ease, DEFAULT_CHARACTER_ENTER_EASE);
    const model = live2DManager.getModel(characterId);
    const container = live2DManager.getContainer(characterId);
    const target = proxy || container;

    // Model/container creation can still be pending while the scheduler is
    // being built. Preserve a master-timeline timing boundary instead of
    // dereferencing an unavailable target.
    if (!target) {
      const noTargetTimeline = gsap.timeline();
      if (normalizedPreset !== 'none') noTargetTimeline.to({}, { duration, ease: resolvedEase });
      return noTargetTimeline;
    }
    
    // Use proxy property names if proxy is provided, otherwise PIXI names
    const propX = proxy ? 'x' : 'x';
    const propY = proxy ? 'y' : 'y';
    const propAlpha = proxy ? 'opacity' : 'alpha';
    const propScale = proxy ? 'scale' : 'scale';

    const tl = gsap.timeline();
    
    // Save final states from current target values (or defaults)
    const finalX = target[propX] ?? 0;
    const finalY = target[propY] ?? 0;
    let finalAlpha = targetOpacity ?? target[propAlpha] ?? 1;
    if (targetOpacity === undefined && finalAlpha === 0 && normalizedPreset !== 'none') {
      finalAlpha = 1;
    }

    // Model dimensions for offset calculations (fallback if not loaded)
    const mWidth = characterSlideEntranceOffsetPixels(model) * 2;
    const mHeight = resolveCharacterModelHeight(model);

    switch (normalizedPreset) {
      case 'fadeIn':
        tl.fromTo(target, { [propAlpha]: 0 }, { [propAlpha]: finalAlpha, duration, ease: resolvedEase, immediateRender: true });
        break;

      case 'slideFromLeft':
        tl.fromTo(target, { [propX]: finalX - mWidth * 0.5, [propAlpha]: 0 }, { [propX]: finalX, [propAlpha]: finalAlpha, duration, ease: resolvedEase });
        break;

      case 'slideFromRight':
        tl.fromTo(target, { [propX]: finalX + mWidth * 0.5, [propAlpha]: 0 }, { [propX]: finalX, [propAlpha]: finalAlpha, duration, ease: resolvedEase });
        break;

      case 'slideFromBottom':
        tl.fromTo(target, { [propY]: finalY + mHeight * 0.3, [propAlpha]: 0 }, { [propY]: finalY, [propAlpha]: finalAlpha, duration, ease: resolvedEase });
        break;

      case 'zoomIn':
        const finalScale = target[propScale] ?? 1;
        if (proxy) {
          tl.fromTo(target, { [propScale]: finalScale * 0.3, [propAlpha]: 0 }, { [propScale]: finalScale, [propAlpha]: finalAlpha, duration, ease: resolvedEase });
        } else {
          tl.set(target, { [propAlpha]: 0 });
          tl.fromTo(target.scale, { x: finalScale * 0.3, y: Math.abs(finalScale * 0.3) }, { x: finalScale, y: Math.abs(finalScale), duration, ease: resolvedEase });
          tl.to(target, { [propAlpha]: finalAlpha, duration, ease: resolvedEase }, 0);
        }
        break;

      case 'dropIn':
        tl.fromTo(target, { [propY]: finalY - mHeight * 0.5, [propAlpha]: 0 }, {
          [propY]: finalY,
          [propAlpha]: finalAlpha,
          duration,
          ease: 'bounce.out',
        });
        break;

      case 'none':
        tl.set(target, { [propAlpha]: finalAlpha });
        break;
    }

    return tl;
  }

  /**
   * Play exit animation for a character.
   */
  characterExit(
    characterId: string,
    preset: ExitPreset = 'fadeOut',
    duration: number = 0.6,
    ease: string = DEFAULT_CHARACTER_EXIT_EASE,
    proxy?: any
  ): gsap.core.Timeline {
    // Keep the compact legacy spelling usable for scenes created before the
    // explicit fadeIn/fadeOut preset names were introduced.
    const normalizedPreset = (preset as string) === 'fade' ? 'fadeOut' : preset;
    const resolvedEase = normalizeCharacterEase(ease, DEFAULT_CHARACTER_EXIT_EASE);
    const model = live2DManager.getModel(characterId);
    const container = live2DManager.getContainer(characterId);
    const target = proxy || model || container;
    
    const propAlpha = (proxy || target === model) ? (proxy ? 'opacity' : 'alpha') : 'alpha';
    const propScale = proxy ? 'scale' : 'scale';

    const tl = gsap.timeline({
      onComplete: () => {
        if (normalizedPreset !== 'none') live2DManager.removeCharacter(characterId);
      },
    });

    // Keep a missing model/container on the master timeline as a timed no-op.
    // The model can be unavailable while an async entrance is still warming up,
    // but the lifecycle boundary must remain deterministic.
    if (!target && normalizedPreset !== 'none') {
      tl.to({}, { duration, ease: resolvedEase });
      return tl;
    }

    const mWidth = characterSlideEntranceOffsetPixels(model) * 2;
    const mHeight = resolveCharacterModelHeight(model);

    switch (normalizedPreset) {
      case 'fadeOut':
        tl.to(target, { [propAlpha]: 0, duration, ease: resolvedEase });
        break;

      case 'slideToLeft':
        tl.to(target, { x: -mWidth, [propAlpha]: 0, duration, ease: resolvedEase });
        break;

      case 'slideToRight':
        tl.to(target, { x: STAGE_WIDTH + mWidth, [propAlpha]: 0, duration, ease: resolvedEase });
        break;

      case 'slideToTop':
        tl.to(target, { y: -mHeight, [propAlpha]: 0, duration, ease: resolvedEase });
        break;

      case 'flyUp':
        tl.to(target, {
          y: -mHeight,
          [propAlpha]: 0,
          duration,
          ease: 'power3.in',
        });
        break;

      case 'dissolve':
        tl.to(target, { [propAlpha]: 0, duration: duration * 1.5, ease: 'power1.out' });
        if (proxy) {
          tl.to(target, { scale: target.scale * 1.1, duration: duration * 1.5, ease: 'power1.out' }, 0);
        } else {
          tl.to(target.scale, {
            x: target.scale.x * 1.1,
            y: target.scale.y * 1.1,
            duration: duration * 1.5,
            ease: 'power1.out',
          }, 0);
        }
        break;

      case 'zoomOut':
        tl.to(target, { [propAlpha]: 0, duration, ease: resolvedEase });
        if (proxy) {
          tl.to(target, { [propScale]: 0, duration, ease: resolvedEase }, 0);
        } else {
          tl.to(target.scale, { x: 0, y: 0, duration, ease: resolvedEase }, 0);
        }
        break;

      case 'none':
        // Even immediate removal is scheduled by the parent timeline. This
        // keeps seek/reconstruction from mutating stage state while building it.
        tl.to({}, { duration: 0.001, onStart: () => live2DManager.removeCharacter(characterId) }, 0);
        break;
    }

    return tl;
  }

  /**
   * Move a character to a new position.
   */
  characterMoveTo(
    characterId: string,
    target: Vec2,
    duration: number,
    ease: string = 'power2.inOut'
  ): gsap.core.Tween {
    const container = live2DManager.getContainer(characterId);
    const pos = resolveVec2(target);
    return gsap.to(container, {
      x: (pos.x ?? 0.5) * STAGE_WIDTH,
      y: (pos.y ?? 0.5) * STAGE_HEIGHT,
      duration,
      ease: normalizeCharacterEase(ease, 'power2.inOut'),
    });
  }

  /**
   * Scale a character.
   */
  characterScale(
    characterId: string,
    scale: number,
    duration: number = 0.5,
    ease: string = 'power2.inOut'
  ): gsap.core.Tween {
    const model = live2DManager.getModel(characterId);
    if (!model) {
      console.warn(`[AnimationDirector] Character "${characterId}" not found for scale`);
      return gsap.to({}, { duration: 0 });
    }

    const currentScaleSign = Math.sign(model.scale.x); // Preserve flip
    return gsap.to(model.scale, {
      x: scale * currentScaleSign,
      y: scale,
      duration,
      ease: normalizeCharacterEase(ease, 'power2.inOut'),
    });
  }

  /**
   * Fade a character's opacity.
   */
  characterFade(
    characterId: string,
    opacity: number,
    duration: number = 0.5,
    ease: string = 'power2.inOut'
  ): gsap.core.Tween {
    const model = live2DManager.getModel(characterId);
    if (!model) {
      console.warn(`[AnimationDirector] Character "${characterId}" not found for fade`);
      return gsap.to({}, { duration: 0 });
    }

    return gsap.to(model, { alpha: opacity, duration, ease: normalizeCharacterEase(ease, 'power2.inOut') });
  }

  /**
   * Register a custom animation preset.
   * The factory receives a target and config and returns a GSAP timeline.
   */
  registerPreset(name: string, factory: AnimPresetFactory): void {
    this.customPresets.set(name, factory);
  }

  /**
   * Play a registered preset.
   */
  playPreset(name: string, target: any, config?: any): gsap.core.Timeline | null {
    const factory = this.customPresets.get(name);
    if (!factory) {
      console.warn(`[AnimationDirector] Preset "${name}" not found`);
      return null;
    }
    return factory(target, config);
  }

  /**
   * Add a tween to the master timeline at a specific time.
   */
  addTween(time: number, target: any, vars: any): gsap.core.Tween {
    const tween = gsap.to(target, vars);
    this.masterTimeline.add(tween, time);
    return tween;
  }

  /**
   * Play the master timeline.
   */
  play(): void {
    this.masterTimeline.play();
  }

  /**
   * Pause the master timeline.
   */
  pause(): void {
    this.masterTimeline.pause();
  }

  /**
   * Seek to a specific time.
   */
  seek(time: number): void {
    this.masterTimeline.seek(time);
  }

  /**
   * Get the total duration of the master timeline.
   */
  getDuration(): number {
    return this.masterTimeline.duration();
  }
}

export const animationDirector = new AnimationDirector();
export default AnimationDirector;
