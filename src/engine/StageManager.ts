/**
 * AeonStagery — Stage Manager
 *
 * Manages the PixiJS application and layer hierarchy.
 * The stage is 1920×1080 with TWO top-level containers:
 *
 *   sceneContainer (affected by camera transforms):
 *     background → characters → effects → customAnimation
 *
 *   uiContainer (NOT affected by camera — always full-screen):
 *     subtitle → overlay
 *
 * This ensures subtitles/UI remain readable during zoom/pan/rotate.
 */

import * as PIXI from 'pixi.js';
import gsap from 'gsap';
import type { LayerName, Vec2 } from '../api/types/common';
import { projectToScreen } from './Projection';
import {
  BACKGROUND_LAYER_ID,
  createEnvironmentState,
  type EnvironmentLayerRenderState,
} from './environmentLayerModel';
import { customAnimHost } from './CustomAnimHost';
import { eventBus } from '../api/events';
// The bridge registers one native pipe that accepts both runtime entries.
import { ensureLive2DRenderPipe } from './Live2DEngineBridge';
import { installPixiFilterResolutionGuard } from './PixiFilterResolutionGuard';
import type { StagePreviewResolution } from '../api/interfaces/IStageAdapter';

const STAGE_WIDTH = 1920;
const STAGE_HEIGHT = 1080;
const MAX_PREVIEW_RESOLUTION = 2;
const PREVIEW_RESOLUTION_VALUES: readonly StagePreviewResolution[] = [1, 0.5, 0.25];

function resolvePreviewResolution(): number {
  const deviceResolution = typeof window === 'undefined'
    ? 1
    : Number(window.devicePixelRatio);
  if (!Number.isFinite(deviceResolution) || deviceResolution <= 1) return 1;
  return Math.min(deviceResolution, MAX_PREVIEW_RESOLUTION);
}

/** Layers that move with the camera */
const SCENE_LAYERS: LayerName[] = [
  'background',
  'characters',
  'effects',
  'customAnimation',
];

/** Layers that stay fixed on screen (UI) */
const UI_LAYERS: LayerName[] = [
  'subtitle',
  'overlay',
];

interface ImageLayerState {
  id: string;
  file: string;
  sprite: PIXI.Sprite | null;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  zIndex: number;
  z?: number;
  active: boolean;
  planned: boolean;
  requestVersion: number;
  epoch: number;
  loadedFile?: string;
  loadError?: string;
  loadPromise: Promise<PIXI.Texture | null> | null;
}

class StageManager {
  private app: PIXI.Application | null = null;
  private layers: Map<LayerName, PIXI.Container> = new Map();
  private imageSprites: Map<string, PIXI.Sprite> = new Map();
  private imageStates: Map<string, ImageLayerState> = new Map();
  private imageErrors: Map<string, string> = new Map();
  private imageErrorCounter = 0;
  private imageEpoch = 0;
  private sceneContainer: PIXI.Container | null = null;
  private uiContainer: PIXI.Container | null = null;
  private stageResizeObserver: ResizeObserver | null = null;
  private initialized = false;
  private previewResolution: StagePreviewResolution = 1;
  private previewBaseResolution = 1;
  private environmentLayerEntries: Map<string, PIXI.Container> = new Map();
  private environmentLayerRequests = new Map<string, object>();
  private environmentTextureLoads = new Map<string, Promise<PIXI.Texture | null>>();
  private pendingEnvironmentLayerClears: Map<string, gsap.core.Tween> = new Map();

  /**
   * Initialize the PixiJS application and mount to a DOM element.
   */
  async init(container: HTMLElement): Promise<void> {
    if (this.initialized) return;

    try {
      await ensureLive2DRenderPipe();
        this.previewBaseResolution = resolvePreviewResolution();
      this.app = new PIXI.Application();
      await this.app.init({
        width: STAGE_WIDTH,
        height: STAGE_HEIGHT,
        backgroundColor: 0x0a0a0f,
        antialias: true,
        resolution: this.previewBaseResolution * this.previewResolution,
        autoDensity: true,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: true, // Required for video capture
        useBackBuffer: true, // Required by Pixi's advanced blend-mode filters.
        preference: 'webgl', // Live2D render pipe and Cubism runtimes are WebGL-based.
      });
      installPixiFilterResolutionGuard(this.app.renderer);
    } catch (err) {
      console.error('[StageManager] Failed to create PIXI.Application:', err);
      throw err;
    }

    const canvas = this.app.canvas;
    canvas.style.display = 'block';
    container.appendChild(canvas);
    customAnimHost.init(container);
    this.setupResponsiveResize(container);

    // ─── Safety monkey-patch: guard PIXI.Assets.load against undefined URLs ───
    // Prevents "Cannot read properties of undefined (reading 'startsWith')"
    // inside checkDataUrl when an undefined URL enters the Assets pipeline.
    // This can happen when ScriptEngine.syncAllStates() calls setBackground
    // with a background image path that resolves to undefined.
    if (PIXI.Assets && PIXI.Assets.load) {
      const _origLoad = PIXI.Assets.load.bind(PIXI.Assets);
      PIXI.Assets.load = function (urls: any, onProgress?: any): Promise<any> {
        if (urls === undefined || urls === null) {
          console.warn(
            '[StageManager] PIXI.Assets.load called with undefined/null urls — blocked',
            new Error('Stack trace for debug').stack,
          );
          return Promise.reject(new Error('Cannot load undefined/null URL'));
        }
        if (Array.isArray(urls)) {
          const filtered = urls.filter((u: any) => u != null);
          if (filtered.length !== urls.length) {
            console.warn(
              `[StageManager] PIXI.Assets.load called with array containing null/undefined entries. Original: ${urls.length}, filtered: ${filtered.length}`,
            );
            if (filtered.length === 0) {
              return Promise.reject(new Error('All URLs in array are null/undefined'));
            }
            urls = filtered;
          }
        }
        return _origLoad(urls, onProgress);
      };
    }

    // Disable all interaction hit testing to prevent "isInteractive is not a function" errors.
    // AeonStagery is a non-interactive video renderer, we don't need pointer events.
    this.app.stage.interactiveChildren = false;
    if ('eventMode' in this.app.stage) {
      (this.app.stage as any).eventMode = 'none';
    }

    // ─── Two-tier container hierarchy ───
    // Scene container: camera transforms apply here
    this.sceneContainer = new PIXI.Container();
    this.sceneContainer.sortableChildren = true;
    this.app.stage.addChild(this.sceneContainer);

    // UI container: always at identity transform (no camera effect)
    this.uiContainer = new PIXI.Container();
    this.uiContainer.sortableChildren = true;
    this.app.stage.addChild(this.uiContainer);

    // Create scene layers (camera-affected)
    let zIndex = 0;
    for (const name of SCENE_LAYERS) {
      const layer = new PIXI.Container();
      (layer as any).name = name;
      layer.sortableChildren = true;
      layer.zIndex = zIndex * 10;
      zIndex++;
      this.layers.set(name, layer);
      this.sceneContainer.addChild(layer);
    }

    // Create UI layers (camera-independent)
    for (const name of UI_LAYERS) {
      const layer = new PIXI.Container();
      (layer as any).name = name;
      layer.sortableChildren = true;
      this.layers.set(name, layer);
      this.uiContainer.addChild(layer);
    }

    this.initialized = true;
    console.log(`[StageManager] Initialized ${STAGE_WIDTH}×${STAGE_HEIGHT} stage (scene + UI layers)`);
  }

  /**
   * Set up responsive resizing to fit the container while keeping 16:9 ratio.
   */
  private setupResponsiveResize(container: HTMLElement): void {
    if (!this.app) return;

    const resize = () => {
      const containerWidth = container.clientWidth;
      const containerHeight = container.clientHeight;
      const scale = Math.min(
        containerWidth / STAGE_WIDTH,
        containerHeight / STAGE_HEIGHT
      );

      const canvas = this.app!.canvas;
      canvas.style.width = `${STAGE_WIDTH * scale}px`;
      canvas.style.height = `${STAGE_HEIGHT * scale}px`;
      canvas.style.position = 'absolute';
      canvas.style.left = `${(containerWidth - STAGE_WIDTH * scale) / 2}px`;
      canvas.style.top = `${(containerHeight - STAGE_HEIGHT * scale) / 2}px`;
    };

    resize();
    if (typeof ResizeObserver === 'undefined') return;
    this.stageResizeObserver?.disconnect();
    this.stageResizeObserver = new ResizeObserver(resize);
    this.stageResizeObserver.observe(container);
  }

  /**
   * Normalize a local file path to the asset:// protocol for Electron.
   */
  private normalizeAssetPath(path: string): string {
    if (!path) {
      console.warn('[StageManager] normalizeAssetPath called with empty/undefined path');
      return '';
    }
    let cleanPath = path.replace(/\\/g, '/');
    if (cleanPath.startsWith('./')) {
      cleanPath = cleanPath.substring(2);
    }
    cleanPath = cleanPath.replace(/\/\.\//g, '/');
    
    if (cleanPath.startsWith('asset://')) return cleanPath;
    if (cleanPath.startsWith('file://')) return cleanPath.replace('file:///', 'asset:///');

    // Check if it's an absolute Windows or POSIX path
    const isAbsolute = /^[a-zA-Z]:[/\\]/.test(cleanPath) || cleanPath.startsWith('/');
    if (isAbsolute) {
      return encodeURI(`asset://localhost/${cleanPath}`);
    }
    return cleanPath;
  }

  /**
   * Get the PixiJS Application instance.
   */
  getApp(): PIXI.Application {
    if (!this.app) throw new Error('[StageManager] Not initialized');
    return this.app;
  }

  getPreviewResolution(): StagePreviewResolution {
    return this.previewResolution;
  }

  setPreviewResolution(resolution: StagePreviewResolution): void {
    const nextResolution = PREVIEW_RESOLUTION_VALUES.includes(resolution)
      ? resolution
      : 1;
    this.previewResolution = nextResolution;
    if (!this.app) return;

    const canvas = this.app.canvas;
    const styleWidth = canvas.style.width;
    const styleHeight = canvas.style.height;
    this.app.renderer.resize(
      STAGE_WIDTH,
      STAGE_HEIGHT,
      this.previewBaseResolution * nextResolution,
    );
    // Pixi autoDensity updates inline CSS size during resize. Restore the
    // responsive stage size so changing quality never changes layout.
    if (styleWidth) canvas.style.width = styleWidth;
    if (styleHeight) canvas.style.height = styleHeight;

    // Resizing the root view invalidates its drawing buffer. Render one
    // complete frame immediately so a paused preview does not stay blank and
    // Live2D offscreen textures are refreshed against the new resolution
    // before the next ticker turn.
    this.app.render();
  }

  /**
   * Get a named layer container.
   */
  getLayer(name: LayerName): PIXI.Container {
    const layer = this.layers.get(name);
    if (!layer) throw new Error(`[StageManager] Layer "${name}" not found`);
    return layer;
  }

  getBackgroundSprite(): PIXI.Sprite | null {
    const envDisplay = this.getEnvironmentLayerDisplayObject(BACKGROUND_LAYER_ID);
    if (envDisplay instanceof PIXI.Sprite) return envDisplay;
    const layer = this.layers.get('background');
    if (!layer || layer.children.length === 0) return null;
    const candidate = layer.children[0];
    return candidate instanceof PIXI.Sprite ? candidate : null;
  }

  getEnvironmentLayerDisplayObject(layerId: string): PIXI.Container | null {
    const container = this.environmentLayerEntries.get(layerId);
    if (!container || container.children.length === 0) return null;
    return container.children[container.children.length - 1] ?? null;
  }

  /**
   * Return the environment-layer container itself. Unlike
   * getEnvironmentLayerDisplayObject this includes every child retained during
   * a cross-fade, allowing target-scoped filters to cover incoming and outgoing
   * artwork consistently.
   */
  getEnvironmentLayerContainer(layerId: string): PIXI.Container | null {
    return this.environmentLayerEntries.get(layerId) ?? null;
  }

  /** All environment layers render behind the character layer, in their own z order. */
  getEnvironmentSamplingContainer(): PIXI.Container | null {
    return this.layers.get('background') ?? null;
  }

  /**
   * Get the scene container (camera transforms apply here).
   * CameraController should transform THIS container, not app.stage.
   */
  getSceneContainer(): PIXI.Container {
    if (!this.sceneContainer) throw new Error('[StageManager] Not initialized');
    return this.sceneContainer;
  }

  /**
   * Get the UI container (not affected by camera).
   */
  getUIContainer(): PIXI.Container {
    if (!this.uiContainer) throw new Error('[StageManager] Not initialized');
    return this.uiContainer;
  }

  /**
   * Get the main stage (root of everything).
   * NOTE: For camera, use getSceneContainer() instead!
   */
  getStage(): PIXI.Container {
    if (!this.app) throw new Error('[StageManager] Not initialized');
    return this.app.stage;
  }

  /**
   * Get the canvas element (for video capture).
   */
  getCanvas(): HTMLCanvasElement {
    if (!this.app) throw new Error('[StageManager] Not initialized');
    return this.app.canvas;
  }

  private getEnvironmentContainer(layerId: string): PIXI.Container {
    this.cancelPendingEnvironmentLayerClear(layerId);
    const bgLayer = this.getLayer('background');
    let container = this.environmentLayerEntries.get(layerId);
    if (!container) {
      container = new PIXI.Container();
      container.sortableChildren = true;
      (container as any).name = `environment:${layerId}`;
      this.environmentLayerEntries.set(layerId, container);
      bgLayer.addChild(container);
    }
    return container;
  }

  private cancelPendingEnvironmentLayerClear(layerId: string): void {
    const pending = this.pendingEnvironmentLayerClears.get(layerId);
    if (pending) {
      pending.kill();
      this.pendingEnvironmentLayerClears.delete(layerId);
    }
  }

  private stopEnvironmentTransitions(container: PIXI.Container): void {
    for (const child of container.children) gsap.killTweensOf(child);
  }

  deferEnvironmentLayerClear(layerId: string, duration: number): void {
    this.cancelPendingEnvironmentLayerClear(layerId);
    let tween: gsap.core.Tween;
    tween = gsap.delayedCall(Math.max(0, duration), () => {
      if (this.pendingEnvironmentLayerClears.get(layerId) !== tween) return;
      this.pendingEnvironmentLayerClears.delete(layerId);
      this.clearEnvironmentLayer(layerId);
    });
    this.pendingEnvironmentLayerClears.set(layerId, tween);
  }

  private async loadEnvironmentTexture(imagePath: string): Promise<PIXI.Texture | null> {
    if (!imagePath) return null;
    const finalUrl = this.normalizeAssetPath(imagePath);
    if (!finalUrl) {
      console.warn('[StageManager] environment image normalized to empty URL — skipping load');
      return null;
    }
    const pending = this.environmentTextureLoads.get(finalUrl);
    if (pending) return pending;
    const load = PIXI.Assets.load<PIXI.Texture>(finalUrl)
      .then((texture) => {
        if (!texture) throw new Error('The asset loader returned no texture');
        return texture;
      })
      .catch((error) => {
        const message = this.reportImageError(undefined, finalUrl, error);
        throw new Error(message);
      })
      .finally(() => this.environmentTextureLoads.delete(finalUrl));
    this.environmentTextureLoads.set(finalUrl, load);
    return load;
  }

  private createEnvironmentSprite(
    texture: PIXI.Texture,
    layoutMode: EnvironmentLayerRenderState['layoutMode'] = 'cover',
  ): PIXI.Sprite | PIXI.TilingSprite {
    if (layoutMode === 'tile') {
      const sprite = new PIXI.TilingSprite({ texture, width: STAGE_WIDTH, height: STAGE_HEIGHT });
      sprite.pivot.set(STAGE_WIDTH / 2, STAGE_HEIGHT / 2);
      return sprite;
    }
    const sprite = new PIXI.Sprite(texture);
    sprite.anchor.set(0.5);
    return sprite;
  }

  private applyEnvironmentDisplayMetadata(
    display: PIXI.Sprite | PIXI.TilingSprite,
    imagePath: string,
    options?: {
      layoutMode?: EnvironmentLayerRenderState['layoutMode'];
      tileScaleX?: number;
      tileScaleY?: number;
      tileOffsetX?: number;
      tileOffsetY?: number;
    },
  ): void {
    (display as any).__imageKey = imagePath;
    (display as any).__baseAlpha = (display as any).__baseAlpha ?? 1;
    (display as any).__transitionAlpha = (display as any).__transitionAlpha ?? 1;
    (display as any).__layoutMode = options?.layoutMode ?? 'cover';
    (display as any).__tileScaleX = options?.tileScaleX;
    (display as any).__tileScaleY = options?.tileScaleY;
    (display as any).__tileOffsetX = options?.tileOffsetX;
    (display as any).__tileOffsetY = options?.tileOffsetY;
  }

  async setEnvironmentLayer(layerId: string, imagePath: string, options?: {
    transition?: 'none' | 'fadeIn' | 'crossFade';
    duration?: number;
    scale?: number;
    x?: number;
    y?: number;
    rotation?: number;
    opacity?: number;
    z?: number;
    layoutMode?: EnvironmentLayerRenderState['layoutMode'];
    tileScaleX?: number;
    tileScaleY?: number;
    tileOffsetX?: number;
    tileOffsetY?: number;
  }): Promise<void> {
    if (!imagePath) {
      this.clearEnvironmentLayer(layerId);
      return;
    }

    const container = this.getEnvironmentContainer(layerId);
    const request = {};
    this.environmentLayerRequests.set(layerId, request);
    const texture = await this.loadEnvironmentTexture(imagePath);
    if (!texture || this.environmentLayerRequests.get(layerId) !== request) return;

    this.stopEnvironmentTransitions(container);

    const sprite = this.createEnvironmentSprite(texture, options?.layoutMode);
    this.applyEnvironmentDisplayMetadata(sprite, imagePath, options);
    (sprite as any).__baseAlpha = 1;
    (sprite as any).__transitionAlpha = 1;

    if (options?.transition === 'fadeIn') {
      container.removeChildren().forEach((child) => child.destroy());
      (sprite as any).__transitionAlpha = 0;
      container.addChild(sprite);
      this.applyEnvironmentLayerTransform(layerId, options ?? {});
      gsap.to(sprite as any, {
        __transitionAlpha: 1,
        duration: options?.duration ?? 1,
        ease: 'power2.out',
      });
      return;
    }

    if (options?.transition === 'crossFade') {
      const oldChildren = [...container.children];
      oldChildren.forEach((child) => {
        (child as any).__outgoingEnvironmentTransform = { ...(child as any).__environmentTransform };
      });
      (sprite as any).__transitionAlpha = 0;
      container.addChild(sprite);
      this.applyEnvironmentLayerTransform(layerId, options ?? {});
      const duration = options?.duration ?? 1;

      gsap.to(sprite as any, {
        __transitionAlpha: 1,
        duration,
        ease: 'linear',
      });

      oldChildren.forEach((child) => {
        gsap.to(child as any, {
          __transitionAlpha: 0,
          duration,
          ease: 'linear',
          onComplete: () => {
            if (child.destroyed) return;
            if (child.parent === container) container.removeChild(child);
            child.destroy();
          },
        });
      });
      return;
    }

    container.removeChildren().forEach((child) => child.destroy());
    container.addChild(sprite);
    this.applyEnvironmentLayerTransform(layerId, options ?? {});
  }

  async setBackground(imagePath: string, options?: {
    transition?: 'none' | 'fadeIn' | 'crossFade';
    duration?: number;
    scale?: number;
    x?: number;
    y?: number;
    rotation?: number;
    opacity?: number;
    offsetX?: number;
    offsetY?: number;
    z?: number;
  }): Promise<void> {
    if (!imagePath) {
      this.clearEnvironmentLayer(BACKGROUND_LAYER_ID);
      return;
    }

    const x = options?.x ?? (STAGE_WIDTH / 2) + (options?.offsetX ?? 0);
    const y = options?.y ?? (STAGE_HEIGHT / 2) + (options?.offsetY ?? 0);

    await this.renderEnvironmentLayer({
      layerId: BACKGROUND_LAYER_ID,
      image: imagePath,
      x: x / STAGE_WIDTH,
      y: y / STAGE_HEIGHT,
      scale: options?.scale ?? 1,
      rotation: options?.rotation ?? 0,
      opacity: options?.opacity ?? 1,
      z: options?.z ?? 0,
      layoutMode: 'cover',
      images: [{ image: imagePath, weight: 1 }],
    });
  }

  async renderEnvironmentLayer(
    layer: EnvironmentLayerRenderState,
    camera?: { position: Vec2; zoom: number },
  ): Promise<void> {
    const container = this.getEnvironmentContainer(layer.layerId);
    const request = {};
    this.environmentLayerRequests.set(layer.layerId, request);
    // Absolute scene state takes ownership of retained sprites as well as new
    // ones. An outgoing tween must not fade or destroy a sprite reused by seek.
    this.stopEnvironmentTransitions(container);
    const desiredImages = layer.images.filter((entry) => entry.image);
    const currentImages = new Set(desiredImages.map((entry) => entry.image));

    for (const child of [...container.children]) {
      const imageKey = (child as any).__imageKey;
      const childLayoutMode = (child as any).__layoutMode ?? 'cover';
      const desiredImage = desiredImages.find((entry) => entry.image === imageKey);
      const layoutMode = desiredImage?.transform?.layoutMode ?? layer.layoutMode ?? 'cover';
      if (!currentImages.has(imageKey) || childLayoutMode !== layoutMode) {
        container.removeChild(child);
        child.destroy();
      }
    }

    for (const imageEntry of desiredImages) {
      const imageTransform = { ...layer, ...imageEntry.transform };
      const layoutMode = imageTransform.layoutMode ?? 'cover';
      let sprite = container.children.find((child) => {
        return (child as any).__imageKey === imageEntry.image && ((child as any).__layoutMode ?? 'cover') === layoutMode;
      }) as PIXI.Sprite | PIXI.TilingSprite | undefined;
      if (!sprite) {
        const texture = await this.loadEnvironmentTexture(imageEntry.image);
        if (this.environmentLayerRequests.get(layer.layerId) !== request) return;
        if (!texture) continue;
        sprite = this.createEnvironmentSprite(texture, layoutMode);
        container.addChild(sprite);
      }
      this.applyEnvironmentDisplayMetadata(sprite, imageEntry.image, {
        layoutMode,
        tileScaleX: imageTransform.tileScaleX,
        tileScaleY: imageTransform.tileScaleY,
        tileOffsetX: imageTransform.tileOffsetX,
        tileOffsetY: imageTransform.tileOffsetY,
      });
      (sprite as any).__outgoingEnvironmentTransform = imageEntry.transform;
      (sprite as any).__baseAlpha = imageEntry.weight;
      (sprite as any).__transitionAlpha = 1;
    }

    container.visible = desiredImages.length > 0;
    this.applyEnvironmentLayerTransform(layer.layerId, layer, camera);
  }

  applyEnvironmentLayerTransform(
    layerId: string,
    layerConfig: {
      x?: number;
      y?: number;
      scale?: number;
      rotation?: number;
      opacity?: number;
      z?: number;
      opacityMultiplier?: number;
      layoutMode?: EnvironmentLayerRenderState['layoutMode'];
      tileScaleX?: number;
      tileScaleY?: number;
      tileOffsetX?: number;
      tileOffsetY?: number;
    },
    camera?: { position: Vec2; zoom: number },
  ): void {
    const container = this.environmentLayerEntries.get(layerId);
    if (!container) return;

    if (layerConfig.z !== undefined) container.zIndex = layerConfig.z;

    container.children.forEach((child) => {
      const sprite = child as PIXI.Sprite | PIXI.TilingSprite;
      if (!sprite.texture) return;
      // Cross-fades retain the outgoing artwork's authored transform, including under camera updates.
      const config = { ...layerConfig, ...(sprite as any).__outgoingEnvironmentTransform };
      (sprite as any).__environmentTransform = createEnvironmentState({
        ...(sprite as any).__environmentTransform,
        ...config,
        layerId,
        layoutMode: config.layoutMode ?? (sprite as any).__layoutMode,
      });
      const x = (config.x ?? 0.5) * STAGE_WIDTH;
      const y = (config.y ?? 0.5) * STAGE_HEIGHT;
      const projected = camera
        ? projectToScreen(
            { x, y, scale: config.scale ?? 1, z: config.z ?? 0 },
            camera,
            { w: STAGE_WIDTH, h: STAGE_HEIGHT },
          )
        : null;

      if (projected) {
        sprite.x = projected.screenX;
        sprite.y = projected.screenY;
      } else {
        sprite.x = x;
        sprite.y = y;
      }

      if (config.scale !== undefined) {
        const effectiveScale = camera ? config.scale * camera.zoom : config.scale;
        const layoutMode = (config.layoutMode ?? (sprite as any).__layoutMode ?? 'cover') as EnvironmentLayerRenderState['layoutMode'];
        if (layoutMode === 'tile' && sprite instanceof PIXI.TilingSprite) {
          sprite.width = STAGE_WIDTH;
          sprite.height = STAGE_HEIGHT;
          sprite.pivot.set(STAGE_WIDTH / 2, STAGE_HEIGHT / 2);
          sprite.scale.set(effectiveScale);
          sprite.tileScale.set(
            (config.tileScaleX ?? (sprite as any).__tileScaleX ?? 1),
            (config.tileScaleY ?? (sprite as any).__tileScaleY ?? 1),
          );
          sprite.tilePosition.set(
            (config.tileOffsetX ?? (sprite as any).__tileOffsetX ?? 0) * STAGE_WIDTH,
            (config.tileOffsetY ?? (sprite as any).__tileOffsetY ?? 0) * STAGE_HEIGHT,
          );
        } else {
          const scaleX = STAGE_WIDTH / sprite.texture.width;
          const scaleY = STAGE_HEIGHT / sprite.texture.height;
          const baseScale = Math.max(scaleX, scaleY);
          sprite.scale.set(baseScale * effectiveScale);
        }
      }

      if (config.rotation !== undefined) sprite.angle = config.rotation;
      if (config.opacity !== undefined) {
        const baseAlpha = (sprite as any).__baseAlpha ?? 1;
        const transitionAlpha = (sprite as any).__transitionAlpha ?? 1;
        sprite.alpha = config.opacity * baseAlpha * transitionAlpha * (config.opacityMultiplier ?? 1);
      } else if (config.opacityMultiplier !== undefined) {
        const baseAlpha = (sprite as any).__baseAlpha ?? 1;
        const transitionAlpha = (sprite as any).__transitionAlpha ?? 1;
        sprite.alpha = baseAlpha * transitionAlpha * config.opacityMultiplier;
      }
    });
  }

  applyBackgroundTransform(
    config: {
      x?: number;
      y?: number;
      scale?: number;
      rotation?: number;
      opacity?: number;
      z?: number;
    },
    camera?: { position: Vec2; zoom: number },
  ): void {
    this.applyEnvironmentLayerTransform(
      BACKGROUND_LAYER_ID,
      {
        ...config,
        x: config.x !== undefined ? config.x / STAGE_WIDTH : undefined,
        y: config.y !== undefined ? config.y / STAGE_HEIGHT : undefined,
      },
      camera,
    );
  }

  removeEnvironmentLayer(layerId: string, options?: {
    transition?: 'none' | 'fadeOut';
    duration?: number;
  }): void {
    this.environmentLayerRequests.delete(layerId);
    const container = this.environmentLayerEntries.get(layerId);
    if (!container) return;
    const transition = options?.transition ?? 'fadeOut';
    const duration = options?.duration ?? 1;
    this.cancelPendingEnvironmentLayerClear(layerId);
    this.stopEnvironmentTransitions(container);

    if (transition === 'none' || duration <= 0) {
      this.clearEnvironmentLayer(layerId);
      return;
    }

    const children = [...container.children];
    children.forEach((child) => {
      gsap.to(child as any, {
        __transitionAlpha: 0,
        duration,
        ease: 'linear',
      });
    });
    this.deferEnvironmentLayerClear(layerId, duration);
  }

  clearEnvironmentLayer(layerId: string): void {
    this.environmentLayerRequests.delete(layerId);
    this.cancelPendingEnvironmentLayerClear(layerId);
    const container = this.environmentLayerEntries.get(layerId);
    if (!container) return;
    this.stopEnvironmentTransitions(container);
    container.removeChildren().forEach((child) => child.destroy());
    if (container.parent) container.parent.removeChild(container);
    container.destroy();
    this.environmentLayerEntries.delete(layerId);
  }

  clearEnvironmentLayers(): void {
    for (const layerId of [...this.environmentLayerEntries.keys()]) {
      this.clearEnvironmentLayer(layerId);
    }
  }

  clearBackground(): void {
    this.clearEnvironmentLayer(BACKGROUND_LAYER_ID);
  }

  setBackgroundColor(color: number): void {
    if (!this.app) return;
    this.app.renderer.background.color = color;
  }

  getWidth(): number {
    return STAGE_WIDTH;
  }

  getHeight(): number {
    return STAGE_HEIGHT;
  }

  /**
   * Pause the PixiJS ticker to stop automatic rendering.
   * Useful during fast export to prevent the main UI from fighting for CPU.
   */
  pauseTicker(): void {
    if (this.app) {
      this.app.ticker.stop();
      console.log('[StageManager] Ticker paused (Export mode)');
    }
  }

  /**
   * Resume the PixiJS ticker for normal interactive rendering.
   */
  resumeTicker(): void {
    if (this.app) {
      this.app.ticker.start();
      console.log('[StageManager] Ticker resumed (Interactive mode)');
    }
  }

  /**
   * Add a static image (JPG/PNG) to the effects layer.
   * Supports full transform: position (normalized 0-1), scale, rotation, opacity, zIndex, z.
   *
   * The sprite is attached immediately with a neutral texture while the actual
   * asset is loaded through PIXI.Assets.load.  This keeps the timeline
   * transform/remove targets stable without relying on Texture.from() being
   * synchronously valid.  Callers that need the asset to be ready can use
   * materializeImage(), which awaits the same load promise.
   */
  addImage(config: {
    id?: string;
    file: string;
    position?: [number, number] | { x: number; y: number };
    scale?: number;
    rotation?: number;
    opacity?: number;
    zIndex?: number;
    duration?: number;
    z?: number;
  }, requestVersion?: number): PIXI.Sprite | null {
    const file = typeof config.file === 'string' ? config.file.trim() : '';
    if (!file) {
      const state = config.id ? this.invalidateImageState(config.id) : null;
      if (state) {
        state.file = '';
        state.planned = true;
        state.active = false;
        state.loadError = undefined;
      }
      if (config.id) this.imageErrors.delete(config.id);
      return null;
    }
    if (!this.app) return null;
    const effectsLayer = this.getLayer('effects');
    if (!effectsLayer) return null;

    let state: ImageLayerState | null = null;
    if (config.id) {
      state = this.getOrCreateImageState(config.id);
      if (requestVersion !== undefined && state.requestVersion !== requestVersion) {
        return null;
      }
      if (requestVersion === undefined) {
        requestVersion = this.beginImageRequest(config.id, config);
      } else {
        // This is the completion of an earlier async request. Its state may
        // already have been changed by transform/remove timelines; applying
        // the original add config here would erase those pending values.
        state.active = true;
        state.planned = true;
        state.epoch = this.imageEpoch;
      }
      if (state.epoch !== this.imageEpoch) return null;
      this.destroyImageStateSprite(state);
    }

    const placeholderTexture = (PIXI.Texture as any).EMPTY ?? (PIXI.Texture as any).WHITE;
    const sprite = placeholderTexture
      ? new PIXI.Sprite(placeholderTexture)
      : new PIXI.Sprite();
    const imageState = state ?? this.createAnonymousImageState(config, sprite);

    imageState.file = file;
    imageState.active = true;
    imageState.planned = Boolean(config.id);
    imageState.epoch = this.imageEpoch;
    if (!config.id) {
      this.applyImageConfigToState(imageState, { ...config, file });
    }

    if (config.id) {
      (sprite as any).imageTargetId = config.id;
      this.imageSprites.set(config.id, sprite);
    }
    (sprite as any).name = `image:${file}`;

    effectsLayer.addChild(sprite);
    imageState.sprite = sprite;
    this.applyImageStateToSprite(imageState);

    const loadPromise = this.loadImageTexture(file, sprite, imageState, requestVersion);
    imageState.loadPromise = loadPromise;
    return sprite;
  }

  /**
   * Register an image action before playback.  Transform/remove timelines can
   * then target a stable state object even though the image asset itself is
   * loaded only when the action becomes active.
   */
  registerImageAction(config: {
    id?: string;
    file: string;
    position?: [number, number] | { x: number; y: number };
    scale?: number;
    rotation?: number;
    opacity?: number;
    zIndex?: number;
    z?: number;
  }): void {
    if (!config.id) return;
    const file = typeof config.file === 'string' ? config.file.trim() : '';
    if (!file) {
      const state = this.invalidateImageState(config.id) ?? this.getOrCreateImageState(config.id);
      this.applyImageConfigToState(state, { ...config, file });
      state.z = config.z;
      state.planned = true;
      state.active = false;
      state.loadError = undefined;
      state.epoch = this.imageEpoch;
      this.imageErrors.delete(config.id);
      this.destroyImageStateSprite(state);
      return;
    }
    const state = this.getOrCreateImageState(config.id);
    this.applyImageConfigToState(state, { ...config, file });
    state.z = config.z;
    state.planned = true;
    state.active = false;
    state.epoch = this.imageEpoch;
    state.loadError = undefined;
    this.imageErrors.delete(config.id);
  }

  /** Begin an asynchronous image action and invalidate older requests. */
  beginImageRequest(
    id: string,
    config?: {
      file?: string;
      position?: [number, number] | { x: number; y: number };
      scale?: number;
      rotation?: number;
      opacity?: number;
      zIndex?: number;
      z?: number;
    },
  ): number {
    const state = this.getOrCreateImageState(id);
    const file = config?.file === undefined ? undefined : config.file.trim();
    if (file === '') {
      const invalidatedState = this.invalidateImageState(id) ?? state;
      invalidatedState.file = '';
      invalidatedState.planned = true;
      invalidatedState.active = false;
      invalidatedState.loadError = undefined;
      invalidatedState.epoch = this.imageEpoch;
      this.imageErrors.delete(id);
      return invalidatedState.requestVersion;
    }

    state.requestVersion += 1;
    state.epoch = this.imageEpoch;
    state.active = true;
    state.planned = true;
    if (config) {
      this.applyImageConfigToState(state, { ...config, file });
      if (config.file !== undefined) state.z = config.z;
    }
    state.loadError = undefined;
    this.imageErrors.delete(id);
    this.destroyImageStateSprite(state);
    state.loadedFile = undefined;
    state.loadPromise = null;
    return state.requestVersion;
  }

  cancelImageRequest(id: string, requestVersion?: number): void {
    const state = this.imageStates.get(id);
    if (state && requestVersion !== undefined && state.requestVersion !== requestVersion) return;
    this.invalidateImageState(id);
  }

  /**
   * Start a new materialized-state pass and hide tracked layers that are not
   * active at the requested scene time.  The returned epoch prevents a slower
   * seek from re-attaching an asset after a newer seek has won the race.
   */
  beginImageReconciliation(activeIds: ReadonlySet<string>): number {
    this.imageEpoch += 1;
    for (const state of this.imageStates.values()) {
      state.epoch = this.imageEpoch;
      if (!activeIds.has(state.id)) {
        state.active = false;
        state.requestVersion += 1;
        this.destroyImageStateSprite(state);
      }
    }
    return this.imageEpoch;
  }

  /**
   * Abort a materialization pass without discarding the queryable error seam.
   * Every in-flight loader observes the new epoch and is prevented from
   * attaching a sprite after a failed seek/export.
   */
  invalidateImageReconciliation(): void {
    this.imageEpoch += 1;
    for (const state of this.imageStates.values()) {
      state.epoch = this.imageEpoch;
      state.active = false;
      state.requestVersion += 1;
      this.destroyImageStateSprite(state);
    }
  }

  /** Ensure an image exists and is fully loaded for seek/export rendering. */
  async materializeImage(config: {
    id: string;
    file: string;
    position?: [number, number] | { x: number; y: number };
    scale?: number;
    rotation?: number;
    opacity?: number;
    zIndex?: number;
    z?: number;
  }, epoch = this.imageEpoch): Promise<PIXI.Sprite | null> {
    if (epoch !== this.imageEpoch) return null;
    const state = this.getOrCreateImageState(config.id);
    const file = typeof config.file === 'string' ? config.file.trim() : '';
    if (!file) {
      this.invalidateImageState(config.id);
      state.file = '';
      state.planned = true;
      state.active = false;
      state.loadError = undefined;
      state.epoch = this.imageEpoch;
      this.imageErrors.delete(config.id);
      return null;
    }

    const canReuse = state.sprite && state.active && !state.loadError && state.file === file;
    if (canReuse) {
      this.applyImageConfigToState(state, { ...config, file });
      state.z = config.z;
      this.applyImageStateToSprite(state);
      if (state.loadPromise) {
        const texture = await state.loadPromise;
        if (!texture || state.loadError) {
          throw new Error(state.loadError ?? `Image layer "${config.id}" failed to load "${file}".`);
        }
      }
      if (state.loadedFile !== file) return null;
      return epoch === this.imageEpoch && state.active ? state.sprite : null;
    }

    const requestVersion = this.beginImageRequest(config.id, { ...config, file });
    const sprite = this.addImage(config, requestVersion);
    if (!sprite) return null;
    this.applyImageStateToSprite(state);
    if (state.loadPromise) {
      const texture = await state.loadPromise;
      if (!texture || state.loadError) {
        throw new Error(state.loadError ?? `Image layer "${config.id}" failed to load "${file}".`);
      }
    }
    if (epoch !== this.imageEpoch || state.requestVersion !== requestVersion || !state.active) {
      return null;
    }
    return sprite;
  }

  /** Apply a materialized runtime transform without creating a new tween. */
  applyImageState(config: {
    id: string;
    position?: [number, number] | { x: number; y: number };
    scale?: number;
    rotation?: number;
    opacity?: number;
    zIndex?: number;
    z?: number;
  }): void {
    const state = this.getOrCreateImageState(config.id);
    this.applyImageConfigToState(state, config);
    state.active = true;
    this.applyImageStateToSprite(state);
  }

  getImageStateIds(): ReadonlySet<string> {
    return new Set(this.imageStates.keys());
  }

  getImageSprite(id: string): PIXI.Sprite | null {
    const sprite = this.imageSprites.get(id);
    if (!sprite || sprite.destroyed || sprite.parent == null) {
      this.imageSprites.delete(id);
      const state = this.imageStates.get(id);
      if (state && state.sprite === sprite) state.sprite = null;
      return null;
    }
    return sprite;
  }

  /** Read the last observable runtime asset error for a stable image id. */
  getImageLoadError(id: string): string | null {
    return this.imageErrors.get(id) ?? null;
  }

  /** Snapshot runtime image errors for export/diagnostic seams. */
  getImageLoadErrors(): ReadonlyMap<string, string> {
    return new Map(this.imageErrors);
  }

  /** Report an image resource failure through the existing user-visible error seam. */
  reportImageError(id: string | undefined, file: string, error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `Failed to load image asset "${file}": ${detail}. Choose an available image resource and retry.`;
    if (id) this.imageErrors.set(id, message);
    console.error(`[StageManager] ${message}`, error);
    void eventBus.emit('toast:show', {
      id: `image_asset_${Date.now()}_${++this.imageErrorCounter}`,
      message,
      type: 'error',
    });
    return message;
  }

  transformImage(config: {
    id: string;
    position?: [number, number] | { x: number; y: number };
    scale?: number;
    rotation?: number;
    opacity?: number;
    zIndex?: number;
    duration?: number;
    ease?: string;
    z?: number;
  }): gsap.core.Timeline {
    const tl = gsap.timeline();
    const state = this.getOrCreateImageState(config.id);
    if (!state) return tl;

    const duration = config.duration ?? 0;
    const ease = config.ease ?? 'power2.inOut';
    const anim: Record<string, number> = {};

    if (config.position !== undefined) {
      const position = Array.isArray(config.position)
        ? { x: config.position[0], y: config.position[1] }
        : config.position;
      anim.x = position.x;
      anim.y = position.y;
    }
    if (config.rotation !== undefined) anim.rotation = config.rotation;
    if (config.opacity !== undefined) anim.opacity = config.opacity;
    if (config.z !== undefined) anim.z = config.z;

    if (config.scale !== undefined) {
      anim.scale = config.scale;
    }
    if (config.zIndex !== undefined) {
      tl.set(state, { zIndex: config.zIndex, onUpdate: () => this.applyImageStateToSprite(state) }, 0);
    }
    if (Object.keys(anim).length > 0) {
      tl.to(state, {
        ...anim,
        duration,
        ease,
        onUpdate: () => this.applyImageStateToSprite(state),
      }, 0);
    }

    return tl;
  }

  removeImage(id: string, duration: number = 0, ease: string = 'power2.out'): gsap.core.Timeline {
    const tl = gsap.timeline();
    const state = this.getOrCreateImageState(id);
    if (!state) return tl;

    const remove = () => {
      if (this.imageStates.get(id) !== state) return;
      state.active = false;
      state.requestVersion += 1;
      this.destroyImageStateSprite(state);
    };

    if (duration > 0) {
      tl.to(state, {
        opacity: 0,
        duration,
        ease,
        onUpdate: () => this.applyImageStateToSprite(state),
        onComplete: remove,
      }, 0);
    } else {
      tl.call(remove, undefined, 0);
    }
    return tl;
  }

  clearImages(): void {
    this.invalidateImageReconciliation();
    const effectsLayer = this.layers.get('effects');
    const sprites = new Set<PIXI.Sprite>(this.imageSprites.values());
    if (effectsLayer) {
      for (const child of effectsLayer.children) {
        const sprite = child as PIXI.Sprite;
        const name = (sprite as any).name;
        if ((sprite as any).imageTargetId || (typeof name === 'string' && name.startsWith('image:'))) {
          sprites.add(sprite);
        }
      }
    }

    for (const sprite of sprites) {
      const id = (sprite as any).imageTargetId;
      if (typeof id === 'string') {
        this.imageSprites.delete(id);
        const state = this.imageStates.get(id);
        if (state) state.loadPromise = null;
      }
      sprite.parent?.removeChild(sprite);
      sprite.destroy({ children: true });
    }
    this.imageSprites.clear();
    this.imageStates.clear();
    this.imageErrors.clear();
  }

  private getOrCreateImageState(id: string): ImageLayerState {
    const existing = this.imageStates.get(id);
    if (existing) return existing;

    const sprite = this.imageSprites.get(id) ?? null;
    const state: ImageLayerState = {
      id,
      file: '',
      sprite,
      x: sprite ? sprite.x / STAGE_WIDTH : 0.5,
      y: sprite ? sprite.y / STAGE_HEIGHT : 0.5,
      scale: 1,
      rotation: sprite?.angle ?? 0,
      opacity: sprite?.alpha ?? 1,
      zIndex: sprite?.zIndex ?? 10,
      z: sprite ? (sprite as any).z : undefined,
      active: Boolean(sprite),
      planned: false,
      requestVersion: 0,
      epoch: this.imageEpoch,
      loadPromise: null,
    };
    this.imageStates.set(id, state);
    return state;
  }

  /**
   * Invalidate a tracked image request before replacing it with a new config
   * or reporting an invalid one.  The state object remains as a tombstone so
   * transform/remove timelines keep a stable target, but no old request or
   * sprite can make the previous image visible again.
   */
  private invalidateImageState(id: string): ImageLayerState | null {
    const state = this.imageStates.get(id);
    if (state) {
      state.requestVersion += 1;
      state.active = false;
      state.loadPromise = null;
      state.loadedFile = undefined;
      this.destroyImageStateSprite(state);
      return state;
    }

    const sprite = this.imageSprites.get(id);
    if (sprite) {
      this.imageSprites.delete(id);
      sprite.parent?.removeChild(sprite);
      sprite.destroy({ children: true });
    }
    return null;
  }

  private createAnonymousImageState(
    config: { file: string; position?: [number, number] | { x: number; y: number }; scale?: number; rotation?: number; opacity?: number; zIndex?: number; z?: number },
    sprite: PIXI.Sprite,
  ): ImageLayerState {
    const position = this.normalizeImagePosition(config.position);
    return {
      id: `anonymous-image-${Math.random().toString(36).slice(2)}`,
      file: config.file,
      sprite,
      x: position.x,
      y: position.y,
      scale: config.scale ?? 1,
      rotation: config.rotation ?? 0,
      opacity: config.opacity ?? 1,
      zIndex: config.zIndex ?? 10,
      z: config.z,
      active: true,
      planned: false,
      requestVersion: 0,
      epoch: this.imageEpoch,
      loadPromise: null,
    };
  }

  private normalizeImagePosition(value?: [number, number] | { x: number; y: number }): { x: number; y: number } {
    if (Array.isArray(value)) {
      return { x: value[0] ?? 0.5, y: value[1] ?? 0.5 };
    }
    return { x: value?.x ?? 0.5, y: value?.y ?? 0.5 };
  }

  private applyImageConfigToState(
    state: ImageLayerState,
    config: {
      file?: string;
      position?: [number, number] | { x: number; y: number };
      scale?: number;
      rotation?: number;
      opacity?: number;
      zIndex?: number;
      z?: number;
    },
  ): void {
    if (config.file !== undefined) state.file = config.file;
    if (config.position !== undefined) {
      const position = this.normalizeImagePosition(config.position);
      state.x = position.x;
      state.y = position.y;
    }
    if (config.scale !== undefined) state.scale = config.scale;
    if (config.rotation !== undefined) state.rotation = config.rotation;
    if (config.opacity !== undefined) state.opacity = config.opacity;
    if (config.zIndex !== undefined) state.zIndex = config.zIndex;
    if (config.z !== undefined) state.z = config.z;
  }

  private applyImageStateToSprite(state: ImageLayerState): void {
    const sprite = state.sprite;
    if (!sprite || sprite.destroyed || !sprite.parent) return;

    sprite.x = state.x * STAGE_WIDTH;
    sprite.y = state.y * STAGE_HEIGHT;
    sprite.anchor.set(0.5);
    sprite.scale.set(state.scale);
    sprite.angle = state.rotation;
    sprite.alpha = state.opacity;
    sprite.zIndex = state.zIndex;

    if (state.z !== undefined) {
      (sprite as any).z = state.z;
      (sprite as any).x_orig = state.x;
      (sprite as any).y_orig = state.y;
      (sprite as any).scale_orig = state.scale;
    } else {
      delete (sprite as any).z;
      delete (sprite as any).x_orig;
      delete (sprite as any).y_orig;
      delete (sprite as any).scale_orig;
    }
  }

  private destroyImageStateSprite(state: ImageLayerState): void {
    const sprite = state.sprite;
    if (!sprite) return;
    if (state.id && this.imageSprites.get(state.id) === sprite) {
      this.imageSprites.delete(state.id);
    }
    sprite.parent?.removeChild(sprite);
    sprite.destroy({ children: true });
    state.sprite = null;
    state.loadedFile = undefined;
  }

  private loadImageTexture(
    file: string,
    sprite: PIXI.Sprite,
    state: ImageLayerState,
    requestVersion?: number,
  ): Promise<PIXI.Texture | null> {
    const canApply = () => (
      state.sprite === sprite
      && state.active
      && state.epoch === this.imageEpoch
      && (requestVersion === undefined || state.requestVersion === requestVersion)
    );

    const promise = Promise.resolve()
      .then(() => {
        if (!PIXI.Assets?.load) {
          throw new Error('PIXI.Assets.load is unavailable');
        }
        return PIXI.Assets.load(file) as Promise<PIXI.Texture>;
      })
      .then((texture) => {
        if (!texture) {
          throw new Error('The asset loader returned no texture');
        }
        if (canApply()) {
          sprite.texture = texture;
          state.loadedFile = file;
        }
        return texture;
      })
      .catch((error) => {
        if (canApply()) {
          state.loadError = this.reportImageError(state.id, file, error);
          state.active = false;
          this.destroyImageStateSprite(state);
        }
        return null;
      });

    return promise;
  }

  /**
   * Update all active custom images in the effects layer that have z-depth values,
   * projecting their screen coordinates/scales based on the camera position and zoom.
   */
  updateImages(camera: { position: Vec2; zoom: number }): void {
    const effectsLayer = this.getLayer('effects');
    if (!effectsLayer) return;

    for (const child of effectsLayer.children) {
      const sprite = child as any;
      if (sprite.z !== undefined && sprite.x_orig !== undefined && sprite.y_orig !== undefined) {
        const projected = projectToScreen(
          {
            x: sprite.x_orig * STAGE_WIDTH,
            y: sprite.y_orig * STAGE_HEIGHT,
            scale: sprite.scale_orig,
            z: sprite.z,
          },
          camera,
          { w: STAGE_WIDTH, h: STAGE_HEIGHT },
        );
        sprite.x = projected.screenX;
        sprite.y = projected.screenY;
        sprite.scale.set(projected.screenScale);
        
        // Update zIndex based on z depth for proper rendering order within effects layer
        sprite.zIndex = sprite.z;
      }
    }
  }

  destroy(): void {
    customAnimHost.destroy();
    this.stageResizeObserver?.disconnect();
    this.stageResizeObserver = null;
    if (this.app) {
      this.app.destroy(
        { removeView: true },
        { children: true, texture: true, textureSource: true },
      );
      this.app = null;
    }
    this.imageSprites.clear();
    this.imageStates.clear();
    this.imageEpoch += 1;
    this.layers.clear();
    this.sceneContainer = null;
    this.uiContainer = null;
    this.initialized = false;
  }
}

export const stageManager = new StageManager();
export default StageManager;
