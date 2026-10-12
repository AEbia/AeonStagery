/** Keeps character projection, opacity guards and semantic anchors together. */
import * as PIXI from 'pixi.js';
import gsap from 'gsap';
import type { CharacterTransformConfig } from '../api/types/character';
import type { Vec2 } from '../api/types/common';
import type { CharacterEntry } from './Live2DConfig';
import { STAGE_WIDTH, STAGE_HEIGHT } from './Live2DConfig';
import { Live2DCompositeModel } from './Live2DCompositeModel';
import { getLive2DRuntimeAdapter } from './Live2DRuntimeAdapter';
import { projectToScreen } from './Projection';
import { resolveVec2 } from './utils/math';
import type { TransformationProxy } from './actions/types';

type CharacterCamera = { position: Vec2; zoom: number };
type CharacterPoint = 'head' | 'chest' | 'feet' | 'center';

type SpatialModel = {
  height: number;
  alpha: number;
  scale: { x: number; y: number; set: (x: number, y?: number) => unknown };
  _baseHeight?: number;
  _flipX?: boolean;
  getBounds?: () => { x: number; y: number; width: number; height: number };
  getLocalBounds?: () => { x: number; y: number; width: number; height: number };
};

type FilterContainer = PIXI.Container & {
  _alphaFilter?: PIXI.AlphaFilter;
  _filtersDirty?: boolean;
};

type SceneContext = {
  isReconstructing?: boolean;
  transformationProxies?: ReadonlyMap<string, TransformationProxy>;
};

export class Live2DCharacterGeometry {
  constructor(
    private readonly characters: ReadonlyMap<string, CharacterEntry>,
    private readonly pendingConfigs: Map<string, Partial<CharacterTransformConfig>[]>,
    private readonly getContainer: (id: string) => PIXI.Container,
    private readonly getSceneContext: () => SceneContext | null,
    private readonly getCamera: () => CharacterCamera | null,
  ) {}

  transform(id: string, config: Partial<CharacterTransformConfig>): void {
    const entry = this.characters.get(id);
    if (!entry) {
      if (!this.pendingConfigs.has(id)) {
        this.pendingConfigs.set(id, []);
      }
      this.pendingConfigs.get(id)!.push(config);
      return;
    }

    const container = this.getContainer(id);
    const model: SpatialModel = entry.model;

    // During timeline reconstruction (e.g. backward seeking), force all transitions
    // to be instant to reflect the exact state at that frame.
    const isReconstructing = this.getSceneContext()?.isReconstructing;

    if (isReconstructing) {
      // Direct set — no GSAP tweens. Avoids tween-on-destroyed-target crashes
      // during rapid seekback when models/containers may be recycled.
      if (config.position) {
        const pos = resolveVec2(config.position);
        container.x = pos.x * STAGE_WIDTH;
        container.y = pos.y * STAGE_HEIGHT;
      }
      if (config.rotation !== undefined) {
        container.angle = config.rotation;
      }
      if (config.scale !== undefined) {
        const targetHeight = STAGE_HEIGHT * config.scale;
        const modelScale = targetHeight / model.height;
        const sign = entry.config.flipX ? -1 : 1;
        model.scale.set(modelScale * sign, modelScale);
      }
      if (config.opacity !== undefined) {
        model.alpha = config.opacity;
      }
      return;
    }

    const duration = config.duration ?? 1;
    const ease = config.ease ?? 'power2.inOut';

    const anim: gsap.TweenVars = {
      duration,
      ease,
    };

    if (config.position) {
      const pos = resolveVec2(config.position);
      anim.x = pos.x * STAGE_WIDTH;
      anim.y = pos.y * STAGE_HEIGHT;
    }

    if (config.rotation !== undefined) {
      anim.angle = config.rotation;
    }

    // Animate the container for position/rotation
    gsap.to(container, anim);

    // Animate the model for scale/opacity
    const modelAnim: gsap.TweenVars = {
      duration,
      ease,
    };

    if (config.scale !== undefined) {
      const targetHeight = STAGE_HEIGHT * (config.scale ?? 1.3);
      const modelScale = targetHeight / model.height;
      modelAnim.pixi = { scale: modelScale };
    }

    if (config.opacity !== undefined) {
      modelAnim.alpha = config.opacity;
    }

    if (Object.keys(modelAnim).length > 2) {
      gsap.to(model, modelAnim);
    }
  }

  private resolvePointSourceModel(model: SpatialModel | null | undefined, pointName: CharacterPoint): SpatialModel | null {
    if (!model) return null;

    if (model instanceof Live2DCompositeModel) {
      if (pointName === 'head') {
        return model.subModels?.[0] ?? model.mainModel ?? model;
      }
      if (pointName === 'chest') {
        return model.mainModel ?? model;
      }
    }

    return model;
  }

  getPoint(id: string, pointName: CharacterPoint, out?: { x: number; y: number }): { x: number, y: number } | null {
    const entry = this.characters.get(id);

    // 1. Prefer model-defined head hit areas when available.
    // This gives us the semantic head anchor instead of guessing from the full container bounds.
    if (entry?.model) {
      try {
        const model = this.resolvePointSourceModel(entry.model, pointName);
        const bounds = typeof model?.getBounds === 'function'
          ? model.getBounds()
          : typeof model?.getLocalBounds === 'function'
            ? model.getLocalBounds()
            : null;

        if (bounds && isFinite(bounds.x) && isFinite(bounds.y) && isFinite(bounds.width) && isFinite(bounds.height) && bounds.width > 0 && bounds.height > 0) {
          const centerX = bounds.x + bounds.width * 0.5;
          const centerY = bounds.y + bounds.height * 0.5;
          const headAnchor = pointName === 'head'
            ? getLive2DRuntimeAdapter(entry.runtime).getControls().getHeadAnchor(model)
            : null;

          let x = centerX;
          let y = centerY;
          if (headAnchor && pointName === 'head') {
            x = bounds.x + bounds.width * headAnchor.x;
            y = bounds.y + bounds.height * headAnchor.y;
          } else {
            switch (pointName) {
              case 'head':
                y = bounds.y + bounds.height * 0.18;
                break;
              case 'chest':
                y = bounds.y + bounds.height * 0.42;
                break;
              case 'center':
                y = centerY;
                break;
              case 'feet':
                y = bounds.y + bounds.height * 0.95;
                break;
            }
          }

          const normalizedX = x / 1920;
          const normalizedY = y / 1080;
          if (out) {
            out.x = normalizedX;
            out.y = normalizedY;
            return out;
          }
          return { x: normalizedX, y: normalizedY };
        }
      } catch {
        // Fall back to proxy-based estimation below.
      }
    }

    // 2. When the live model cannot provide bounds, fall back to the pure proxy estimate.
    // This keeps seek/scrub stable even before the model is fully available.
    const proxies = this.getSceneContext()?.transformationProxies;
    if (proxies) {
      const proxy = proxies.get(id);
      if (proxy) {
        const nx = proxy.x / 1920;
        const ny = proxy.y / 1080;
        const scale = proxy.scale !== undefined ? proxy.scale : 1.0;

        let targetY = ny;
        switch (pointName) {
          case 'head':   targetY = ny - 0.60 * scale; break;
          case 'chest':  targetY = ny - 0.38 * scale; break;
          case 'center': targetY = ny - 0.40 * scale; break;
          case 'feet':   targetY = ny; break;
        }

        if (out) {
          out.x = nx;
          out.y = targetY;
          return out;
        }
        return { x: nx, y: targetY };
      }
    }

    // Final fallback.
    if (!entry || !entry.model) return null;
    return { x: 0.5, y: 0.5 };
  }

  getStableSampleBounds(id: string, camera: CharacterCamera | null): PIXI.Rectangle | null {
    const entry = this.characters.get(id);
    if (!entry) return null;

    const proxy = this.getSceneContext()?.transformationProxies?.get(id);
    if (!proxy) return null;

    const effectiveScale = (proxy.scale ?? 1) * (camera?.zoom ?? 1);
    if (!Number.isFinite(effectiveScale) || effectiveScale <= 0) return null;

    const projected = camera
      ? projectToScreen(
          { x: proxy.x, y: proxy.y, scale: proxy.scale ?? 1, z: proxy.z ?? 0 },
          camera,
          { w: STAGE_WIDTH, h: STAGE_HEIGHT },
        )
      : {
          screenX: proxy.x,
          screenY: proxy.y,
          screenScale: effectiveScale,
        };

    const height = STAGE_HEIGHT * effectiveScale;
    const aspectRatio = entry.baseWidth && entry.baseHeight
      ? entry.baseWidth / entry.baseHeight
      : 0.58;
    const width = height * aspectRatio;

    // Stable reference frame:
    // x uses center anchor, y uses the long-lived feet anchor with a small under-foot allowance.
    const left = projected.screenX - width * 0.5;
    const top = projected.screenY - height * 0.9;
    return new PIXI.Rectangle(left, top, width, height);
  }

  applyProxyTransform(
    id: string,
    proxy: Partial<TransformationProxy> | null | undefined,
    modelOverride?: SpatialModel,
    camera?: CharacterCamera,
  ): void {
    const entry = this.characters.get(id);
    if (!proxy) return;

    // Resolve effective camera: explicit param > stored currentCamera > null (2D fallback)
    const cam = camera !== undefined ? camera : this.getCamera();

    const container = this.getContainer(id) as FilterContainer;
    if (container) {
      // ── ECS Projection (replaces old pivot-based camera) ──
      if (cam && proxy.x !== undefined && proxy.y !== undefined) {
        const projected = projectToScreen(
          { x: proxy.x, y: proxy.y, scale: proxy.scale ?? 1, z: proxy.z ?? 0 },
          cam,
          { w: STAGE_WIDTH, h: STAGE_HEIGHT },
        );
        if (isFinite(projected.screenX)) container.x = projected.screenX;
        if (isFinite(projected.screenY)) container.y = projected.screenY;
      } else {
        // 2D fallback — no camera, use raw proxy position
        if (proxy.x !== undefined && isFinite(proxy.x)) container.x = proxy.x;
        if (proxy.y !== undefined && isFinite(proxy.y)) container.y = proxy.y;
      }

      if (proxy.rotation !== undefined && isFinite(proxy.rotation)) container.angle = proxy.rotation;

      // ── Z-index for depth ordering ──
      if (proxy.z !== undefined && isFinite(proxy.z)) {
        container.zIndex = proxy.z;
      }

      // Use AlphaFilter as the single opacity authority while transparent.
      // Some Live2D draw paths can ignore container/model alpha for a frame;
      // switching this filter off during warmup causes an opaque entrance flash.
      if (proxy.opacity !== undefined && isFinite(proxy.opacity)) {
        const opacity = Math.max(0, Math.min(1, proxy.opacity));
        const isTransparent = opacity < 0.999;
        container.renderable = opacity > 0.0001;

        if (isTransparent) {
          container.alpha = 1.0;

          let alphaFilter = container._alphaFilter;
          if (!alphaFilter) {
            alphaFilter = new PIXI.AlphaFilter({ alpha: opacity });
            alphaFilter.padding = 50;
            container._alphaFilter = alphaFilter;
          } else {
            alphaFilter.alpha = opacity;
          }

          // PixiJS 8 freezes the array returned by the `filters` getter
          // (effectsMixin `Object.freeze(value.slice(0))`) — in-place
          // push/splice throws "Cannot delete property '0'". Mutations must
          // go through the setter with a fresh array.
          const currentFilters = container.filters;
          if (!currentFilters || currentFilters.length === 0) {
            container.filters = [alphaFilter];
            container._filtersDirty = true;
          } else if (currentFilters.indexOf(alphaFilter) === -1) {
            container.filters = [...currentFilters, alphaFilter];
            container._filtersDirty = true;
          }
        } else {
          container.alpha = opacity;
          container.renderable = true;

          const alphaFilter = container._alphaFilter;
          const currentFilters = container.filters;
          if (currentFilters && alphaFilter && currentFilters.indexOf(alphaFilter) !== -1) {
            const remaining = currentFilters.filter((f) => f !== alphaFilter);
            container.filters = remaining.length > 0 ? remaining : null;
            container._filtersDirty = true;
          }
        }
      }
    }

    const model: SpatialModel | undefined = modelOverride || entry?.model;
    if (model) {
      if (proxy.scale !== undefined && isFinite(proxy.scale)) {
        // Apply camera zoom to scale (replicates old container-level zoom behavior)
        const effectiveScale = cam ? proxy.scale * cam.zoom : proxy.scale;
        const targetHeight = STAGE_HEIGHT * effectiveScale;
        const baseH = entry?.baseHeight || model._baseHeight || model.height;
        const modelScale = targetHeight / baseH;

        if (isFinite(modelScale)) {
          const flipX = entry?.config?.flipX || model._flipX;
          const sign = flipX ? -1 : 1;
          model.scale.set(modelScale * sign, modelScale);
        }
      }
      if (proxy.opacity !== undefined && isFinite(proxy.opacity)) {
        const opacity = Math.max(0, Math.min(1, proxy.opacity));
        model.alpha = opacity < 0.999 ? 1.0 : opacity;
      }
    }
  }
}
