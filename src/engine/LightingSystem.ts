/**
 * AeonStagery — Lighting System
 *
 * Applies visual filter effects to the stage for lighting/mood changes.
 * Uses PixiJS filters (ColorMatrix, etc.) with GSAP transitions.
 */

import * as PIXI from 'pixi.js';
import 'pixi.js/advanced-blend-modes';
import gsap from 'gsap';
import type { BlendMode } from '../api/types/blend-mode';
import { GodrayFilter, AdvancedBloomFilter, AdjustmentFilter, RGBSplitFilter } from 'pixi-filters';
import { stageManager } from './StageManager';
import { live2DManager } from './Live2DManager';
import type { VisualLightingOverlay } from './visual-runtime/VisualRuntimeResolver';
import {
  createEmptyPresetWeights,
  DEFAULT_POST_PROCESSING_SNAPSHOT,
  deriveLightingSnapshotAtTime as deriveLightingSnapshotForTime,
  normalizeLightingSnapshot,
  type LightingPostProcessingSnapshot,
  type LightingPointLightSnapshot,
  type LightingPresetName,
  type LightingSnapshot,
} from './LightingSnapshot';
import { targetPostProcessingController } from './visual-runtime/TargetPostProcessingController';

/** Built-in lighting presets */
type LightingPreset = LightingPresetName;

interface LightingConfig {
  preset: LightingPreset;
  intensity?: number;   // 0-1, how strong the effect is
  duration?: number;
  ease?: string;
}

interface VignetteOverlay {
  displayObject: PIXI.Container;
  intensity: number;
}

class LightingSystem {
  private initialized = false;
  private colorFilter: PIXI.ColorMatrixFilter;
  private blurFilter: PIXI.BlurFilter;
  private bgBlurFilter: PIXI.BlurFilter;
  private charBlurFilter: PIXI.BlurFilter;
  
  // Post-processing filters
  private godrayFilter: GodrayFilter;
  private bloomFilter: AdvancedBloomFilter;
  private adjustmentFilter: AdjustmentFilter;
  private rgbSplitFilter: RGBSplitFilter;

  private vignette: VignetteOverlay | null = null;
  private presetIntensities: Record<LightingPreset, number> = {
    normal: 0,
    sunset: 0,
    night: 0,
    dawn: 0,
    spotlight: 0,
    dramatic: 0,
    sepia: 0,
    cold: 0,
    warm: 0,
    dim: 0
  };
  private blurProxy = { value: 0 };
  private bgBlurProxy = { value: 0 };
  private charBlurProxy = { value: 0 };
  // Authored snapshot IDs and imperative legacy resources have independent lifecycles.
  private authoredPointLights = new Map<string, PIXI.Sprite>();
  private runtimePointLights = new Map<string, PIXI.Sprite>();
  private reservedRuntimePointLightIds = new Set<string>();
  private nextPointLightId = 0;
  
  // Color overlays (Multiply/Screen) for high-performance mood lighting
  private colorOverlays: PIXI.Graphics[] = [];
  private visualOverlays: PIXI.Graphics[] = [];
  // Targeted panorama overlays live in the camera-affected scene container;
  // legacy addColorOverlay remains on the UI overlay layer for compatibility.
  private scenePostOverlay: PIXI.Graphics | null = null;

  // Proxies for GSAP
  private ppProxy: LightingPostProcessingSnapshot = { ...DEFAULT_POST_PROCESSING_SNAPSHOT };
  private visualOverlayState: VisualLightingOverlay | null = null;
  private godrayTimeTween: gsap.core.Tween | null = null;

  constructor() {
    this.colorFilter = new PIXI.ColorMatrixFilter();
    this.blurFilter = new PIXI.BlurFilter();
    this.blurFilter.blur = 0;
    this.blurFilter.enabled = false;

    this.bgBlurFilter = new PIXI.BlurFilter();
    this.bgBlurFilter.blur = 0;
    this.bgBlurFilter.enabled = false;

    this.charBlurFilter = new PIXI.BlurFilter();
    this.charBlurFilter.blur = 0;
    this.charBlurFilter.enabled = false;

    // Initialize Post-processing filters
    this.godrayFilter = new GodrayFilter({ time: 0, gain: 0.5, lacunarity: 2.5, angle: 30, parallel: true });
    this.godrayFilter.enabled = false;
    
    this.bloomFilter = new AdvancedBloomFilter({ threshold: 0.5, bloomScale: 1.0, brightness: 1.0, blur: 8, quality: 4 });
    this.bloomFilter.enabled = false;

    this.adjustmentFilter = new AdjustmentFilter({ gamma: 1, contrast: 1, saturation: 1, brightness: 1, red: 1, green: 1, blue: 1 });
    this.adjustmentFilter.enabled = false;

    this.rgbSplitFilter = new RGBSplitFilter({ red: [0, 0], green: [0, 0], blue: [0, 0] });
    this.rgbSplitFilter.enabled = false;
  }

  /**
   * Initialize and attach the filter to the stage.
   */
  init(): void {
    const scene = stageManager.getSceneContainer();
    this.attachSceneFilters(scene);

    if (this.initialized) {
      this.syncEffects();
      return;
    }

    // Add layer-specific blur filters
    const bgLayer = stageManager.getLayer('background');
    bgLayer.filters = [this.bgBlurFilter];

    const charLayer = stageManager.getLayer('characters');
    charLayer.filters = [this.charBlurFilter];
    this.initialized = true;
  }

  private attachSceneFilters(scene: PIXI.Container): void {
    // A filter target with no visible children has zero bounds, which prevents standalone
    // godrays from producing a fullscreen render target.
    scene.filterArea = new PIXI.Rectangle(0, 0, stageManager.getWidth(), stageManager.getHeight());
    // Add all filters to the scene. For performance, filters are disabled until used.
    scene.filters = [
      this.colorFilter,
      this.adjustmentFilter,
      this.godrayFilter,
      this.blurFilter,
      this.bloomFilter,
      this.rgbSplitFilter,
    ];
  }

  /**
   * Apply a lighting preset with smooth transition.
   */
  setLighting(config: LightingConfig): gsap.core.Timeline {
    const {
      preset,
      intensity = 0.8,
      duration = 1.0,
      ease = 'power2.inOut',
    } = config;

    const tl = gsap.timeline();

    // Animate the target preset to its target intensity, and all other presets to 0!
    const targetObj: Record<string, number> = {};
    (Object.keys(this.presetIntensities) as LightingPreset[]).forEach(p => {
      targetObj[p] = (p === preset) ? (preset === 'normal' ? 0 : intensity) : 0;
    });

    tl.to(this.presetIntensities, {
      ...targetObj,
      duration,
      ease,
      onUpdate: () => {
        this.applyAllActivePresets();
      },
    });

    return tl;
  }

  private applyAllActivePresets(): void {
    this.colorFilter.reset();
    let hasActivePreset = false;

    // Apply each preset sequentially if its active intensity > 0
    (Object.keys(this.presetIntensities) as LightingPreset[]).forEach(p => {
      const val = this.presetIntensities[p];
      if (val > 0.001) {
        hasActivePreset = true;
        this.applyPresetAtIntensity(p, val);
      }
    });

    this.colorFilter.enabled = hasActivePreset && !this.shouldSuspendSceneFiltersForWarmup();
  }

  /**
   * Apply a preset at a given intensity (0 = no effect, 1 = full effect).
   */
  private applyPresetAtIntensity(preset: LightingPreset, intensity: number): void {
    if (intensity <= 0) return;

    switch (preset) {
      case 'normal':
        break;

      case 'sunset':
        // Warm orange tint
        this.colorFilter.saturate(0.2 * intensity, true);
        this.colorFilter.brightness(1 - 0.05 * intensity, true);
        // Tint towards orange/golden
        this.blendTint(1.0 + 0.15 * intensity, 0.95, 0.75 - 0.1 * intensity, intensity);
        break;

      case 'night':
        // Cool blue, dark
        this.colorFilter.brightness(0.4 + 0.6 * (1 - intensity), true);
        this.colorFilter.saturate(-0.3 * intensity, true);
        this.blendTint(0.7, 0.8, 1.0 + 0.2 * intensity, intensity);
        break;

      case 'dawn':
        // Soft pink/purple
        this.colorFilter.brightness(0.85 + 0.15 * (1 - intensity), true);
        this.blendTint(1.0 + 0.1 * intensity, 0.85, 1.0 + 0.05 * intensity, intensity);
        break;

      case 'spotlight':
        // High contrast, slight vignette effect via brightness
        this.colorFilter.contrast(0.15 * intensity, true);
        this.colorFilter.brightness(1.1, true);
        break;

      case 'dramatic':
        // High contrast, desaturated
        this.colorFilter.contrast(0.3 * intensity, true);
        this.colorFilter.saturate(-0.4 * intensity, true);
        break;

      case 'sepia':
        this.colorFilter.sepia(true);
        break;

      case 'cold':
        this.colorFilter.saturate(-0.1 * intensity, true);
        this.blendTint(0.85, 0.95, 1.0 + 0.15 * intensity, intensity);
        break;

      case 'warm':
        this.colorFilter.saturate(0.1 * intensity, true);
        this.blendTint(1.0 + 0.1 * intensity, 1.0, 0.85, intensity);
        break;

      case 'dim':
        this.colorFilter.brightness(0.5 + 0.5 * (1 - intensity), true);
        this.colorFilter.saturate(-0.2 * intensity, true);
        break;
    }
  }

  /**
   * Apply a color tint by multiplying R/G/B channels.
   */
  private blendTint(r: number, g: number, b: number, _intensity: number): void {
    // Apply as a color matrix multiplication
    const m = this.colorFilter.matrix;
    m[0] *= r;  // R
    m[6] *= g;  // G
    m[12] *= b; // B
  }

  /**
   * Add a vignette overlay (darkened edges).
   */
  addVignette(intensity: number = 0.5, duration: number = 1.0): gsap.core.Tween {
    this.removeVignette();

    const layer = stageManager.getLayer('overlay');
    const w = 1920;
    const h = 1080;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    if (ctx) {
      const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.sqrt(w * w + h * h) / 1.5);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(0.5, 'rgba(0,0,0,0)');
      grad.addColorStop(1, `rgba(0,0,0,${intensity})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }

    const texture = PIXI.Texture.from(canvas);
    const sprite = new PIXI.Sprite(texture);
    sprite.alpha = 0;

    layer.addChild(sprite);
    this.vignette = { displayObject: sprite, intensity };

    return gsap.to(sprite, { alpha: 1, duration, ease: 'power2.inOut' });
  }

  /**
   * Remove vignette overlay.
   */
  removeVignette(duration: number = 0.5): void {
    if (!this.vignette) return;

    const obj = this.vignette.displayObject;
    gsap.to(obj, {
      alpha: 0,
      duration,
      onComplete: () => {
        obj.parent?.removeChild(obj);
        obj.destroy();
      },
    });
    this.vignette = null;
  }

  /**
   * Flash the screen white (for impact moments).
   */
  flashScreen(
    color: number = 0xFFFFFF,
    duration: number = 0.3,
    intensity: number = 0.8
  ): gsap.core.Timeline {
    const layer = stageManager.getLayer('overlay');
    const flash = new PIXI.Graphics();
    flash.beginFill(color, intensity);
    flash.drawRect(0, 0, 1920, 1080);
    flash.endFill();
    flash.alpha = 0;
    layer.addChild(flash);

    const tl = gsap.timeline();
    tl.to(flash, { alpha: 1, duration: duration * 0.2, ease: 'power2.out' });
    tl.to(flash, {
      alpha: 0,
      duration: duration * 0.8,
      ease: 'power2.in',
      onComplete: () => {
        layer.removeChild(flash);
        flash.destroy();
      },
    });

    return tl;
  }

  /**
   * Set blur (depth of field effect).
   */
  setBlur(
    intensity: number,
    duration: number = 1.0,
    ease: string = 'power2.inOut',
    target: 'global' | 'background' | 'characters' = 'global'
  ): gsap.core.Tween {
    const isGlobal = !target || target === 'global';
    const isBg = target === 'background';

    const filter = isGlobal ? this.blurFilter : (isBg ? this.bgBlurFilter : this.charBlurFilter);
    const proxy = isGlobal ? this.blurProxy : (isBg ? this.bgBlurProxy : this.charBlurProxy);

    return gsap.to(proxy, {
      value: intensity,
      duration,
      ease,
      onStart: () => {
        filter.enabled = true;
      },
      onUpdate: () => {
        filter.blur = proxy.value;
        filter.enabled = proxy.value > 0;
      },
      onComplete: () => {
        filter.enabled = proxy.value > 0;
      }
    });
  }

  /**
   * Post-Processing: Set Bloom, Chromatic Aberration, Color Grading.
   * Only active filters are enabled to save performance.
   */
  setPostProcessing(params: Partial<typeof this.ppProxy>, duration: number = 1.0, ease: string = 'power2.inOut'): gsap.core.Tween {
    return gsap.to(this.ppProxy, {
      ...params,
      duration,
      ease,
      onUpdate: () => {
        this.renderVisualOverlays();
        this.syncScenePostOverlay();
        this.syncPostProcessingFilters();
      }
    });
  }

  /**
   * Godrays (Tyndall effect).
   */
  setGodrays(intensity: number, angle: number = 30, duration: number = 1.0): gsap.core.Tween {
    // Start continuous animation if not already running
    if (intensity > 0 && !this.godrayTimeTween) {
      this.godrayTimeTween = gsap.to(this.godrayFilter, {
        time: 100,
        duration: 100,
        repeat: -1,
        ease: 'none'
      });
    }

    return gsap.to(this.ppProxy, {
      godrayGain: intensity,
      godrayAngle: angle,
      duration,
      ease: 'power2.inOut',
      onUpdate: () => {
        this.renderVisualOverlays();
        this.syncPostProcessingFilters();
      },
      onComplete: () => {
        if (this.ppProxy.godrayGain <= 0.01 && this.godrayTimeTween) {
          this.godrayTimeTween.kill();
          this.godrayTimeTween = null;
        }
      }
    });
  }

  /**
   * Add a highly performant Color Overlay (Multiply or Screen mode).
   * Multiply is great for dimming/tinting (shadows).
   * Screen is great for brightening/lightening (haze/glow).
   */
  addColorOverlay(color: number | string, mode: BlendMode = 'multiply', intensity: number = 0.5, duration: number = 1.0): gsap.core.Tween {
    const state = { alpha: 0 };
    let overlay: PIXI.Graphics | null = null;
    const syncOverlayAlpha = () => {
      overlay = this.ensureColorOverlay(overlay, color, mode);
      overlay.alpha = state.alpha;
    };

    return gsap.to(state, {
      alpha: intensity,
      duration,
      ease: 'power2.inOut',
      onStart: syncOverlayAlpha,
      onUpdate: syncOverlayAlpha,
      onComplete: syncOverlayAlpha,
    });
  }

  removeColorOverlays(duration: number = 0): gsap.core.Tween {
    const state = { progress: 0 };
    let overlays: Array<{ overlay: PIXI.Graphics; alpha: number }> = [];
    const captureOverlays = () => {
      overlays = this.colorOverlays
        .filter((overlay) => !overlay.destroyed)
        .map((overlay) => ({ overlay, alpha: overlay.alpha }));
    };
    const syncOverlayRemoval = () => {
      overlays.forEach(({ overlay, alpha }) => {
        if (!overlay.destroyed) {
          overlay.alpha = alpha * (1 - state.progress);
        }
      });
    };
    const finalizeRemoval = () => {
      if (overlays.length === 0) {
        captureOverlays();
      }
      overlays.forEach(({ overlay }) => this.destroyColorOverlay(overlay));
      this.pruneDestroyedColorOverlays();
    };

    return gsap.to(state, {
      progress: 1,
      duration,
      ease: 'power2.inOut',
      onStart: () => {
        captureOverlays();
        if (duration <= 0) {
          finalizeRemoval();
        } else {
          syncOverlayRemoval();
        }
      },
      onUpdate: () => {
        if (duration > 0) {
          syncOverlayRemoval();
        }
      },
      onComplete: finalizeRemoval,
    });
  }

  clearPointLights(duration: number = 0): gsap.core.Tween {
    const state = { progress: 0 };
    let lights: Array<{ light: PIXI.Sprite; alpha: number }> = [];
    const captureLights = () => {
      lights = this.getAllPointLights()
        .filter((light) => !light.destroyed)
        .map((light) => ({ light, alpha: light.alpha }));
    };
    const syncRemoval = () => {
      lights.forEach(({ light, alpha }) => {
        if (!light.destroyed) {
          light.alpha = alpha * (1 - state.progress);
        }
      });
    };
    const finalizeRemoval = () => {
      if (lights.length === 0) {
        captureLights();
      }
      lights.forEach(({ light }) => this.destroyPointLight(light));
      this.pruneDestroyedPointLights();
    };

    return gsap.to(state, {
      progress: 1,
      duration,
      ease: 'power2.inOut',
      onStart: () => {
        captureLights();
        if (duration <= 0) {
          finalizeRemoval();
        } else {
          syncRemoval();
        }
      },
      onUpdate: () => {
        if (duration > 0) {
          syncRemoval();
        }
      },
      onComplete: finalizeRemoval,
    });
  }

  deriveLightingSnapshotAtTime(time: number, timeline: readonly any[], visualOverlay: VisualLightingOverlay | null = null): LightingSnapshot {
    return deriveLightingSnapshotForTime(time, timeline, visualOverlay);
  }

  applySnapshot(snapshot: LightingSnapshot): void {
    const safeSnapshot = normalizeLightingSnapshot(snapshot);

    this.colorOverlays.forEach((overlay) => this.destroyColorOverlay(overlay));
    this.colorOverlays = [];

    this.visualOverlayState = safeSnapshot.visualOverlay;
    this.ppProxy = { ...DEFAULT_POST_PROCESSING_SNAPSHOT, ...safeSnapshot.postProcessing };
    this.blurProxy.value = safeSnapshot.blur.global;
    this.bgBlurProxy.value = safeSnapshot.blur.background;
    this.charBlurProxy.value = safeSnapshot.blur.characters;
    this.presetIntensities = { ...createEmptyPresetWeights(), ...safeSnapshot.presetWeights };

    safeSnapshot.colorOverlays.forEach((entry) => {
      const overlay = this.createColorOverlay(entry.color, entry.mode);
      overlay.alpha = entry.alpha;
    });
    this.reconcilePointLights(safeSnapshot.pointLights);
    targetPostProcessingController.applySnapshot(safeSnapshot);
    this.syncScenePostOverlay();

    this.syncEffects();
  }

  private resetPostProcessingState(): void {
    this.ppProxy = { ...DEFAULT_POST_PROCESSING_SNAPSHOT };
  }

  private clearVisualOverlays(): void {
    this.visualOverlays.forEach(o => {
      o.parent?.removeChild(o);
      o.destroy();
    });
    this.visualOverlays = [];
  }

  private getEffectivePostProcessingState(): LightingPostProcessingSnapshot {
    const effective: LightingPostProcessingSnapshot = { ...this.ppProxy };
    const overlay = this.visualOverlayState;
    if (!overlay) return effective;

    effective.adjBrightness *= overlay.adjustment.adjBrightness;
    effective.adjBlue *= overlay.adjustment.adjBlue;
    effective.adjContrast *= overlay.adjustment.adjContrast;
    effective.adjGreen *= overlay.adjustment.adjGreen;
    effective.adjRed *= overlay.adjustment.adjRed;
    effective.adjSaturation *= overlay.adjustment.adjSaturation;

    effective.bloomBloomScale += overlay.postProcessing.bloomBloomScale;
    effective.bloomBrightness *= overlay.postProcessing.bloomBrightness;
    effective.godrayGain += overlay.postProcessing.godrayGain;
    effective.rgbSplitX += overlay.postProcessing.rgbSplitX;
    effective.rgbSplitY += overlay.postProcessing.rgbSplitY;

    if (overlay.postProcessing.bloomThreshold !== undefined) {
      effective.bloomThreshold = Math.min(effective.bloomThreshold, overlay.postProcessing.bloomThreshold);
    }
    if (overlay.postProcessing.godrayAngle !== undefined) {
      effective.godrayAngle = overlay.postProcessing.godrayAngle;
    }

    return effective;
  }

  private syncPostProcessingFilters(): void {
    const effective = this.getEffectivePostProcessingState();
    const suspendSceneFilters = this.shouldSuspendSceneFiltersForWarmup();

    this.bloomFilter.threshold = effective.bloomThreshold;
    this.bloomFilter.bloomScale = effective.bloomBloomScale;
    this.bloomFilter.brightness = effective.bloomBrightness;
    this.bloomFilter.enabled = !suspendSceneFilters && effective.bloomBloomScale > 0.01;

    this.rgbSplitFilter.red = [effective.rgbSplitX, effective.rgbSplitY];
    this.rgbSplitFilter.blue = [-effective.rgbSplitX, -effective.rgbSplitY];
    this.rgbSplitFilter.enabled = !suspendSceneFilters && (Math.abs(effective.rgbSplitX) > 0.1 || Math.abs(effective.rgbSplitY) > 0.1);

    this.adjustmentFilter.gamma = effective.adjGamma;
    this.adjustmentFilter.contrast = effective.adjContrast;
    this.adjustmentFilter.saturation = effective.adjSaturation;
    this.adjustmentFilter.brightness = effective.adjBrightness;
    this.adjustmentFilter.red = effective.adjRed;
    this.adjustmentFilter.green = effective.adjGreen;
    this.adjustmentFilter.blue = effective.adjBlue;
    this.adjustmentFilter.enabled =
      !suspendSceneFilters && (
        effective.adjGamma !== 1 || effective.adjContrast !== 1 ||
        effective.adjSaturation !== 1 || effective.adjBrightness !== 1 ||
        effective.adjRed !== 1 || effective.adjGreen !== 1 || effective.adjBlue !== 1
      );

    this.godrayFilter.gain = effective.godrayGain;
    this.godrayFilter.lacunarity = effective.godrayLacunarity;
    this.godrayFilter.angle = effective.godrayAngle;
    this.godrayFilter.enabled = !suspendSceneFilters && effective.godrayGain > 0.01;
  }

  /** Render the integrated panorama overlay on the camera-affected scene only. */
  private syncScenePostOverlay(): void {
    const state = this.ppProxy;
    const intensity = Math.max(0, Math.min(1, state.overlayIntensity));
    let scene: PIXI.Container;
    try {
      scene = stageManager.getSceneContainer();
    } catch {
      return;
    }

    if (!this.scenePostOverlay) {
      this.scenePostOverlay = new PIXI.Graphics();
      (this.scenePostOverlay as any).name = 'panorama-post-processing-overlay';
      (this.scenePostOverlay as any).zIndex = Number.MAX_SAFE_INTEGER;
      if (typeof (scene as any).addChild === 'function') {
        scene.addChild(this.scenePostOverlay);
      }
    } else if (this.scenePostOverlay.parent !== scene && typeof (scene as any).addChild === 'function') {
      scene.addChild(this.scenePostOverlay);
    }

    const overlay = this.scenePostOverlay;
    const color = typeof state.overlayColor === 'number'
      ? state.overlayColor
      : parseInt(String(state.overlayColor).replace(/^#/, '0x'), 16);
    const safeColor = Number.isFinite(color) ? color : 0;
    if (typeof (overlay as any).clear === 'function') {
      (overlay as any).clear();
    }
    overlay.beginFill(safeColor, 1);
    overlay.drawRect(0, 0, stageManager.getWidth(), stageManager.getHeight());
    overlay.endFill();
    overlay.alpha = intensity;
    overlay.visible = intensity > 0.001;
    overlay.blendMode = state.overlayBlendMode;
    (overlay as any)._filtersDirty = true;
  }

  private shouldSuspendSceneFiltersForWarmup(): boolean {
    return live2DManager.hasActiveFilterWarmup();
  }

  private renderVisualOverlays(): void {
    this.clearVisualOverlays();
    if (!this.visualOverlayState) return;

    const layer = stageManager.getLayer('overlay');
    for (const entry of this.visualOverlayState.overlays) {
      if (entry.intensity <= 0.001) continue;
      const overlay = new PIXI.Graphics();
      const hex = parseInt(entry.color.replace('#', '0x'));
      overlay.beginFill(hex, 1.0);
      overlay.drawRect(0, 0, 1920, 1080);
      overlay.endFill();
      overlay.alpha = entry.intensity;
      overlay.blendMode = entry.mode;
      layer.addChild(overlay);
      this.visualOverlays.push(overlay);
    }
  }

  applyVisualOverlay(overlay: VisualLightingOverlay | null): void {
    this.visualOverlayState = overlay;
    this.syncEffects();
  }

  private radialTexture: PIXI.Texture | null = null;

  /**
   * Get or create a reusable white radial gradient texture.
   */
  private getRadialTexture(): PIXI.Texture {
    if (this.radialTexture) return this.radialTexture;
    
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    
    if (ctx) {
      const center = size / 2;
      const grad = ctx.createRadialGradient(center, center, 0, center, center, center);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.15, '#ffffff'); // Sharp bright core
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
    }

    this.radialTexture = PIXI.Texture.from(canvas);
    return this.radialTexture;
  }

  private createColorOverlay(color: number | string, mode: BlendMode): PIXI.Graphics {
    const layer = stageManager.getLayer('overlay');
    const overlay = new PIXI.Graphics();
    const hex = typeof color === 'string' ? parseInt(color.replace('#', '0x')) : color;
    overlay.beginFill(hex, 1.0);
    overlay.drawRect(0, 0, 1920, 1080);
    overlay.endFill();
    overlay.alpha = 0;
    overlay.blendMode = mode;
    layer.addChild(overlay);
    this.colorOverlays.push(overlay);
    return overlay;
  }

  private destroyColorOverlay(overlay: PIXI.Graphics): void {
    if (overlay.destroyed) {
      return;
    }
    overlay.parent?.removeChild(overlay);
    overlay.destroy();
  }

  private pruneDestroyedColorOverlays(): void {
    this.colorOverlays = this.colorOverlays.filter((overlay) => !overlay.destroyed);
  }

  private ensureColorOverlay(
    overlay: PIXI.Graphics | null,
    color: number | string,
    mode: BlendMode,
  ): PIXI.Graphics {
    if (overlay && !overlay.destroyed) {
      return overlay;
    }
    return this.createColorOverlay(color, mode);
  }

  private createPointLight(
    id: string,
    x: number,
    y: number,
    color: string | number,
    radius: number,
    registry: Map<string, PIXI.Sprite>,
  ): PIXI.Sprite {
    const layer = stageManager.getLayer('effects');
    const texture = this.getRadialTexture();
    const sprite = new PIXI.Sprite(texture);
    sprite.anchor.set(0.5);
    sprite.x = x;
    sprite.y = y;
    sprite.width = radius * 2;
    sprite.height = radius * 2;
    sprite.alpha = 0;

    if (typeof color === 'string') {
      sprite.tint = parseInt(color.replace('#', '0x'));
    } else {
      sprite.tint = color;
    }

    sprite.blendMode = 'add';
    layer.addChild(sprite);
    registry.set(id, sprite);
    return sprite;
  }

  private destroyPointLight(light: PIXI.Sprite): void {
    for (const registry of [this.authoredPointLights, this.runtimePointLights]) {
      for (const [id, activeLight] of registry) {
        if (activeLight === light) {
          registry.delete(id);
          break;
        }
      }
    }
    if (light.destroyed) {
      return;
    }
    light.parent?.removeChild(light);
    light.destroy();
  }

  private pruneDestroyedPointLights(): void {
    for (const registry of [this.authoredPointLights, this.runtimePointLights]) {
      for (const [id, light] of registry) {
        if (light.destroyed) registry.delete(id);
      }
    }
  }

  private getAllPointLights(): PIXI.Sprite[] {
    return [...new Set([
      ...this.authoredPointLights.values(),
      ...this.runtimePointLights.values(),
    ])];
  }

  private updatePointLight(
    light: PIXI.Sprite,
    x: number,
    y: number,
    color: string | number,
    radius: number,
  ): void {
    light.x = x;
    light.y = y;
    light.width = radius * 2;
    light.height = radius * 2;
    light.tint = typeof color === 'string' ? parseInt(color.replace('#', '0x')) : color;
  }

  private reconcilePointLights(entries: readonly LightingPointLightSnapshot[]): void {
    const activeIds = new Set<string>();

    entries.forEach((entry, index) => {
      const id = typeof entry.id === 'string' && entry.id.length > 0
        ? entry.id
        : `legacy-point-light-${index}`;
      if (activeIds.has(id)) return;
      activeIds.add(id);

      let light = this.authoredPointLights.get(id);
      if (!light || light.destroyed) {
        if (light) this.authoredPointLights.delete(id);
        light = this.createPointLight(id, entry.x, entry.y, entry.color, entry.radius, this.authoredPointLights);
      } else {
        this.updatePointLight(light, entry.x, entry.y, entry.color, entry.radius);
      }
      light.alpha = entry.alpha;
    });

    for (const [id, light] of this.authoredPointLights) {
      if (!activeIds.has(id)) this.destroyPointLight(light);
    }
    this.pruneDestroyedPointLights();
  }

  private allocateRuntimePointLightId(): string {
    let id: string;
    do {
      id = `runtime-point-light-${++this.nextPointLightId}`;
    } while (
      this.authoredPointLights.has(id) ||
      this.runtimePointLights.has(id) ||
      this.reservedRuntimePointLightIds.has(id)
    );
    this.reservedRuntimePointLightIds.add(id);
    return id;
  }

  private ensurePointLight(
    id: string,
    sprite: PIXI.Sprite | null,
    x: number,
    y: number,
    color: string | number,
    radius: number,
  ): PIXI.Sprite {
    if (sprite && !sprite.destroyed) {
      this.updatePointLight(sprite, x, y, color, radius);
      this.reservedRuntimePointLightIds.delete(id);
      return sprite;
    }
    const existing = this.runtimePointLights.get(id);
    if (existing && !existing.destroyed) {
      this.updatePointLight(existing, x, y, color, radius);
      this.reservedRuntimePointLightIds.delete(id);
      return existing;
    }
    if (existing) this.runtimePointLights.delete(id);
    const created = this.createPointLight(id, x, y, color, radius, this.runtimePointLights);
    this.reservedRuntimePointLightIds.delete(id);
    return created;
  }

  /**
   * Add a point light to the effects layer using a smooth radial gradient.
   */
  addPointLight(x: number, y: number, color: string | number = '#ffffff', radius: number = 400, intensity: number = 0.8, duration: number = 1.0): gsap.core.Tween {
    // Additive blending is very sensitive
    const targetAlpha = Math.min(intensity, 1.0);
    const state = { alpha: 0 };
    let sprite: PIXI.Sprite | null = null;
    const id = this.allocateRuntimePointLightId();
    const syncPointLightAlpha = () => {
      sprite = this.ensurePointLight(id, sprite, x, y, color, radius);
      sprite.alpha = state.alpha;
    };

    return gsap.to(state, {
      alpha: targetAlpha,
      duration,
      ease: 'power2.out',
      onStart: syncPointLightAlpha,
      onUpdate: syncPointLightAlpha,
      onComplete: syncPointLightAlpha,
    });
  }

  /**
   * Reset all lighting effects to default.
   */
  resetRuntimeState(): void {
    // 1. Clear all point lights
    this.getAllPointLights().forEach((light) => this.destroyPointLight(light));
    this.authoredPointLights.clear();
    this.runtimePointLights.clear();

    // Clear color overlays
    this.colorOverlays.forEach((overlay) => this.destroyColorOverlay(overlay));
    this.colorOverlays = [];
    this.clearVisualOverlays();
    this.visualOverlayState = null;
    targetPostProcessingController.clear();
    if (this.scenePostOverlay) {
      this.scenePostOverlay.parent?.removeChild(this.scenePostOverlay);
      this.scenePostOverlay.destroy();
      this.scenePostOverlay = null;
    }

    // 2. Remove vignette
    this.removeVignette(0);

    // 3. Reset filters
    this.colorFilter.reset();
    this.colorFilter.enabled = false;
    (Object.keys(this.presetIntensities) as LightingPreset[]).forEach(p => {
      this.presetIntensities[p] = 0;
    });

    // 4. Reset blur
    this.blurFilter.blur = 0;
    this.blurProxy.value = 0;
    this.blurFilter.enabled = false;

    this.bgBlurFilter.blur = 0;
    this.bgBlurProxy.value = 0;
    this.bgBlurFilter.enabled = false;

    this.charBlurFilter.blur = 0;
    this.charBlurProxy.value = 0;
    this.charBlurFilter.enabled = false;

    // 5. Reset post-processing
    gsap.killTweensOf(this.ppProxy);
    this.resetPostProcessingState();
    
    this.bloomFilter.enabled = false;
    this.rgbSplitFilter.enabled = false;
    this.adjustmentFilter.enabled = false;
    
    if (this.godrayTimeTween) {
      this.godrayTimeTween.kill();
      this.godrayTimeTween = null;
    }
    this.godrayFilter.enabled = false;
  }

  reset(): void {
    this.resetRuntimeState();
  }

  getCurrentPreset(): LightingPreset {
    let bestPreset: LightingPreset = 'normal';
    let maxVal = 0.001;
    (Object.keys(this.presetIntensities) as LightingPreset[]).forEach(p => {
      if (this.presetIntensities[p] > maxVal) {
        maxVal = this.presetIntensities[p];
        bestPreset = p;
      }
    });
    return bestPreset;
  }

  /** Called during fast-export when GSAP onUpdate is suppressed. */
  syncEffects(): void {
    // A target may have been authored before its runtime container existed.
    // Retry those states on every lighting reconciliation without requiring a
    // new timeline snapshot.
    targetPostProcessingController.reconcilePendingTargets();
    const suspendSceneFilters = this.shouldSuspendSceneFiltersForWarmup();
    this.applyAllActivePresets();
    this.renderVisualOverlays();
    this.syncScenePostOverlay();
    
    this.blurFilter.blur = this.blurProxy.value;
    this.blurFilter.enabled = !suspendSceneFilters && this.blurProxy.value > 0;

    this.bgBlurFilter.blur = this.bgBlurProxy.value;
    this.bgBlurFilter.enabled = this.bgBlurProxy.value > 0;

    this.charBlurFilter.blur = this.charBlurProxy.value;
    this.charBlurFilter.enabled = !suspendSceneFilters && this.charBlurProxy.value > 0;

    this.syncPostProcessingFilters();

    const effective = this.getEffectivePostProcessingState();
    if (!suspendSceneFilters && effective.godrayGain > 0.01 && !this.godrayTimeTween) {
      this.godrayTimeTween = gsap.to(this.godrayFilter, {
        time: 100,
        duration: 100,
        repeat: -1,
        ease: 'none',
      });
    } else if ((suspendSceneFilters || effective.godrayGain <= 0.01) && this.godrayTimeTween) {
      this.godrayTimeTween.kill();
      this.godrayTimeTween = null;
    }
  }

  /**
   * Reconcile the exact lighting, blur, overlays, and post-processing state 
   * at any given time in the timeline. Highly performant, linear interpolation-aware,
   * and completely deterministic for seek/scrubbing compatibility.
   */
  reconcile(time: number, timeline: any[]): void {
    this.applySnapshot(this.deriveLightingSnapshotAtTime(time, timeline, this.visualOverlayState));

    // Re-trigger continuous godray animation during playback if needed
    if (this.getEffectivePostProcessingState().godrayGain > 0.01 && !this.godrayTimeTween) {
      this.godrayTimeTween = gsap.to(this.godrayFilter, {
        time: 100,
        duration: 100,
        repeat: -1,
        ease: 'none'
      });
    }
  }
}

export const lightingSystem = new LightingSystem();
export default LightingSystem;
