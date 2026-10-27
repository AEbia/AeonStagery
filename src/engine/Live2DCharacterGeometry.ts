/** Keeps character projection, opacity guards and semantic anchors together. */
import * as PIXI from 'pixi.js';
import gsap from 'gsap';
import type { CharacterTransformConfig } from '../api/types/character';
import type { Vec2 } from '../api/types/common';
import type { CharacterEntry } from './Live2DConfig';
import { STAGE_WIDTH, STAGE_HEIGHT } from './Live2DConfig';
import { Live2DCompositeModel } from './Live2DCompositeModel';
import { captureLive2DAnchorOffset, LIVE2D_ANCHOR_FRACTIONS } from './Live2DAnchorGeometry';
import { getBoundRuntimeHandle } from './live2d/runtime/BoundRuntimeAccess';
import { projectToScreen } from './Projection';
import { resolveVec2 } from './utils/math';
import type { TransformationProxy } from './actions/types';

type CharacterCamera = { position: Vec2; zoom: number; rotation?: number; shakeOffset?: { x: number; y: number } };
type CharacterPoint = 'head' | 'chest' | 'feet' | 'center';

type SpatialModel = {
  height: number;
  alpha: number;
  scale: { x: number; y: number; set: (x: number, y?: number) => unknown };
  _baseHeight?: number;
  _flipX?: boolean;
  pivot?: { x: number; y: number };
  localTransform?: { apply: (point: { x: number; y: number }) => { x: number; y: number } };
  updateLocalTransform?: () => void;
  getBounds?: () => { x: number; y: number; width: number; height: number };
  getLocalBounds?: () => { x: number; y: number; width: number; height: number };
  toGlobal?: (point: { x: number; y: number }) => { x: number; y: number };
};

type FilterContainer = PIXI.Container & {
  _alphaFilter?: PIXI.AlphaFilter;
  _filtersDirty?: boolean;
};

export type Live2DGeometrySceneContext = {
  isReconstructing?: boolean;
  transformationProxies?: ReadonlyMap<string, TransformationProxy>;
};

export class Live2DCharacterGeometry {
  private readonly projectedZoom = new WeakMap<PIXI.Container, number>();

  constructor(
    private readonly characters: ReadonlyMap<string, CharacterEntry>,
    private readonly pendingConfigs: Map<string, Partial<CharacterTransformConfig>[]>,
    private readonly getContainer: (id: string) => PIXI.Container,
    private readonly getSceneContext: () => Live2DGeometrySceneContext | null,
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

  private resolveAnchorFraction(entry: CharacterEntry, pointName: CharacterPoint): { x: number; y: number; posed?: true } | null {
    const character = getBoundRuntimeHandle(entry)?.character;
    const target = entry.model instanceof Live2DCompositeModel && pointName === 'head' ? 'head' : 'main';
    const posed = character?.getAnchor?.(pointName, target);
    return posed ? { ...posed, posed: true }
      : (pointName === 'head' ? character?.getHeadAnchor(target) : null)
      ?? null;
  }

  getPoint(id: string, pointName: CharacterPoint, out?: { x: number; y: number }): { x: number, y: number } | null {
    const entry = this.characters.get(id);

    // Capture posed geometry in model-local units, then compose it with the
    // authored proxy. Camera and editor viewport transforms never enter this
    // trajectory, and the bounds refresh does not require a render pass.
    const proxy = this.getSceneContext()?.transformationProxies?.get(id);
    if (entry?.model && proxy) {
      try {
        const source = this.resolvePointSourceModel(entry.model, pointName);
        const anchorFraction = this.resolveAnchorFraction(entry, pointName);
        const logicalHeight = entry.baseHeight ?? source?._baseHeight ?? source?.height;
        const rootModel = entry.model as SpatialModel;
        if (source !== rootModel) source?.updateLocalTransform?.();
        const offset = captureLive2DAnchorOffset(
          source,
          pointName,
          logicalHeight,
          anchorFraction,
          rootModel.pivot,
          source !== rootModel ? source?.localTransform : undefined,
        );
        if (offset) {
          const flipX = entry.config?.flipX ?? source?._flipX ?? false;
          const scale = proxy.scale ?? 1;
          const localX = offset.x * (flipX ? -1 : 1) * STAGE_HEIGHT * scale;
          const localY = offset.y * STAGE_HEIGHT * scale;
          const radians = (proxy.rotation ?? 0) * Math.PI / 180;
          const cos = Math.cos(radians);
          const sin = Math.sin(radians);
          const point = {
            x: (proxy.x + localX * cos - localY * sin) / STAGE_WIDTH,
            y: (proxy.y + localX * sin + localY * cos) / STAGE_HEIGHT,
          };
          if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
          if (out) {
            out.x = point.x;
            out.y = point.y;
            return out;
          }
          return point;
        }
      } catch {
        // Try the model's measured bounds when local runtime geometry is absent.
      }
    }

    // Prefer runtime anatomy and authored head hit areas over bounds estimates.
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
          const anchorFraction = this.resolveAnchorFraction(entry, pointName);

          let x = centerX;
          let y = bounds.y + bounds.height * LIVE2D_ANCHOR_FRACTIONS[pointName];
          if (anchorFraction) {
            x = bounds.x + bounds.width * anchorFraction.x;
            y = bounds.y + bounds.height * anchorFraction.y;
            const localBounds = anchorFraction.posed ? model?.getLocalBounds?.() : null;
            if (localBounds && model?.toGlobal) {
              const global = model.toGlobal({
                x: localBounds.x + localBounds.width * anchorFraction.x,
                y: localBounds.y + localBounds.height * anchorFraction.y,
              });
              x = global.x;
              y = global.y;
            }
          }

          const proxy = this.getSceneContext()?.transformationProxies?.get(id);
          if (proxy) {
            // Bounds are global pixels, including editor viewport and camera
            // transforms. Recover the model offset before composing it with
            // the authored stage position. Use the last APPLIED zoom: the
            // camera may already have advanced before this anchor is queried.
            const container = this.getContainer(id);
            const localBounds = typeof model?.getLocalBounds === 'function' && typeof model.toGlobal === 'function'
              ? model.getLocalBounds()
              : null;
            let local: { x: number; y: number };
            if (model && localBounds && localBounds.width > 0 && localBounds.height > 0 && model.toGlobal) {
              const localCenterX = localBounds.x + localBounds.width * 0.5;
              const localAnchorX = anchorFraction
                ? localBounds.x + localBounds.width * anchorFraction.x
                : localCenterX;
              const localAnchorY = anchorFraction
                ? localBounds.y + localBounds.height * anchorFraction.y
                : localBounds.y + localBounds.height * LIVE2D_ANCHOR_FRACTIONS[pointName];
              local = container.toLocal(model.toGlobal({ x: localAnchorX, y: localAnchorY }));
            } else {
              local = container.toLocal({ x, y });
            }
            const zoom = this.projectedZoom.get(container) ?? 1;
            // Camera rotation is a presentation transform. Character anchor
            // trajectories stay in authored world space.
            const authoredRotation = (proxy.rotation ?? 0) * Math.PI / 180;
            const cos = Math.cos(authoredRotation);
            const sin = Math.sin(authoredRotation);
            x = proxy.x + (local.x * cos - local.y * sin) / zoom;
            y = proxy.y + (local.x * sin + local.y * cos) / zoom;
          }
          const normalizedX = x / STAGE_WIDTH;
          const normalizedY = y / STAGE_HEIGHT;
          if (!Number.isFinite(normalizedX) || !Number.isFinite(normalizedY)) return null;
          if (out) {
            out.x = normalizedX;
            out.y = normalizedY;
            return out;
          }
          return { x: normalizedX, y: normalizedY };
        }
      } catch {
        // Unavailable geometry is a missing anchor.
      }
    }

    // Authored origins and guessed body proportions are not posed anchors.
    // Focus must capture the absence rather than freeze an invented target.
    return null;
  }

  /** Normalized picture coordinates, before editor viewport/CSS transforms. */
  getScreenPoint(id: string, pointName: CharacterPoint, out?: { x: number; y: number }): { x: number; y: number } | null {
    const point = this.getPoint(id, pointName, out);
    if (!point) return null;
    const camera = this.getCamera();
    const proxy = this.getSceneContext()?.transformationProxies?.get(id);
    // Without a proxy, getPoint uses the legacy measured display bounds.
    if (!camera || !proxy) return point;
    const projected = projectToScreen(
      { x: point.x * STAGE_WIDTH, y: point.y * STAGE_HEIGHT, scale: 1, parallaxDepth: proxy.z ?? 0 },
      camera,
      { w: STAGE_WIDTH, h: STAGE_HEIGHT },
    );
    point.x = projected.screenX / STAGE_WIDTH;
    point.y = projected.screenY / STAGE_HEIGHT;
    return point;
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
          { x: proxy.x, y: proxy.y, scale: proxy.scale ?? 1, rotation: proxy.rotation, parallaxDepth: proxy.z ?? 0, drawOrder: proxy.z },
          camera,
          { w: STAGE_WIDTH, h: STAGE_HEIGHT },
        )
      : {
          screenX: proxy.x,
          screenY: proxy.y,
          screenScale: effectiveScale,
          screenRotation: proxy.rotation ?? 0,
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
    const cam: CharacterCamera | null = camera !== undefined ? camera : this.getCamera();

    const container = this.getContainer(id) as FilterContainer;
    if (container) {
      // ── ECS Projection (replaces old pivot-based camera) ──
      if (cam && proxy.x !== undefined && proxy.y !== undefined) {
        const projected = projectToScreen(
          { x: proxy.x, y: proxy.y, scale: proxy.scale ?? 1, rotation: proxy.rotation, parallaxDepth: proxy.z ?? 0, drawOrder: proxy.z },
          cam,
          { w: STAGE_WIDTH, h: STAGE_HEIGHT },
        );
        if (isFinite(projected.screenX)) container.x = projected.screenX;
        if (isFinite(projected.screenY)) container.y = projected.screenY;
        if (isFinite(projected.screenRotation)) container.angle = projected.screenRotation;
      } else {
        // 2D fallback — no camera, use raw proxy position
        if (proxy.x !== undefined && isFinite(proxy.x)) container.x = proxy.x;
        if (proxy.y !== undefined && isFinite(proxy.y)) container.y = proxy.y;
      }

      if (!cam && proxy.rotation !== undefined && isFinite(proxy.rotation)) container.angle = proxy.rotation;

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
            alphaFilter = new PIXI.AlphaFilter({ alpha: opacity, resolution: 'inherit' });
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
          if (container) this.projectedZoom.set(container, cam?.zoom || 1);
        }
      }
      if (proxy.opacity !== undefined && isFinite(proxy.opacity)) {
        const opacity = Math.max(0, Math.min(1, proxy.opacity));
        model.alpha = opacity < 0.999 ? 1.0 : opacity;
      }
    }
  }
}
