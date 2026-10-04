import type { Vec2 } from '../api/types/common';
import { resolveVec2 } from './utils/math';

export const DEFAULT_FOCAL_LENGTH = 500;

/**
 * Maximum z-index value for text/UI layers.
 * Used ONLY for PixiJS zIndex sorting (screen-space).
 * NEVER feed this into the parallax formula — subtitles are screen-space UI!
 */
export const MAX_Z_TEXT = 9999;

export interface ViewportSize {
  w: number;
  h: number;
}

export interface ProjectedTransform {
  screenX: number;
  screenY: number;
  screenScale: number;
}

/**
 * ECS projection: proxy local-space coords → screen-space coords.
 *
 * Two-step formula (fixes zoom spatial-collapse):
 *
 *   Step 1 — World-space with parallax-modulated camera offset:
 *     parallax    = 1 + proxy.z / focalLength
 *     camOffsetX  = (0.5 - camera.position.x) * viewportW
 *     worldX      = proxy.x + camOffsetX * parallax
 *
 *   Step 2 — Zoom around screen center (replicates old pivot-based behavior):
 *     screenX     = viewportW/2 + (worldX - viewportW/2) * camera.zoom
 *     screenScale = proxy.scale * camera.zoom
 *
 * When ALL proxy.z = 0 (the 2D default): parallax = 1 everywhere, and the
 * formula degenerates to simple pan+zoom — identical to the old pivot-based system.
 *
 * Proof (z=0, parallax=1):
 *   worldX  = proxy.x + (0.5 - cam.x) * W
 *   screenX = W/2 + (proxy.x + (0.5 - cam.x)*W - W/2) * zoom
 *           = W/2 + (proxy.x - cam.x*W) * zoom
 *   This matches: (proxy.x - pivotX) * zoom + W/2  where pivotX = cam.x * W
 */
export function projectToScreen(
  proxy: { x: number; y: number; scale: number; z?: number },
  camera: { position: Vec2; zoom: number },
  viewport: ViewportSize,
): ProjectedTransform {
  const z = proxy.z ?? 0;
  const parallax = 1 + z / DEFAULT_FOCAL_LENGTH;
  const camPos = resolveVec2(camera.position);

  // Step 1: world-space position with parallax-adjusted camera offset
  const camOffsetX = (0.5 - camPos.x) * viewport.w;
  const camOffsetY = (0.5 - camPos.y) * viewport.h;
  const worldX = proxy.x + camOffsetX * parallax;
  const worldY = proxy.y + camOffsetY * parallax;

  // Step 2: zoom around screen center
  const halfW = viewport.w / 2;
  const halfH = viewport.h / 2;

  return {
    screenX: halfW + (worldX - halfW) * camera.zoom,
    screenY: halfH + (worldY - halfH) * camera.zoom,
    screenScale: proxy.scale * camera.zoom,
  };
}
