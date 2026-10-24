import type { Vec2 } from '../api/types/common';
import { resolveVec2 } from './utils/math';

/** Internal artistic parallax model; this value is not a physical focal length. */
export const CAMERA_PROJECTION_MODEL = 'artistic-parallax-v1';
export const ARTISTIC_PARALLAX_DEPTH_SCALE = 500;
/** @deprecated Kept as a compatibility export for existing callers. */
export const DEFAULT_FOCAL_LENGTH = ARTISTIC_PARALLAX_DEPTH_SCALE;

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
  screenRotation: number;
  drawOrder?: number;
}

/**
 * Artistic camera projection from authored world coordinates to logical stage coordinates.
 *
 * Projection order keeps artistic depth, camera-plane rotation, and screen shake distinct:
 *
 *   Step 1 — World-space with parallax-modulated camera offset:
 *     parallax    = 1 + parallaxDepth / ARTISTIC_PARALLAX_DEPTH_SCALE
 *     camOffsetX  = (0.5 - camera.position.x) * viewportW
 *     worldX      = proxy.x + camOffsetX * parallax
 *
 *   Step 2 — Zoom around screen center, then rotate by the inverse camera angle.
 *   Step 3 — Add logical authoring-unit shake after both transforms.
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
  proxy: { x: number; y: number; scale: number; rotation?: number; parallaxDepth?: number; drawOrder?: number; z?: number },
  camera: { position: Vec2; zoom: number; rotation?: number; shakeOffset?: { x: number; y: number } },
  viewport: ViewportSize,
): ProjectedTransform {
  // Legacy z intentionally maps to both independent concepts until callers provide them.
  const parallaxDepth = proxy.parallaxDepth ?? proxy.z ?? 0;
  const drawOrder = proxy.drawOrder ?? proxy.z;
  const parallax = 1 + parallaxDepth / ARTISTIC_PARALLAX_DEPTH_SCALE;
  const camPos = resolveVec2(camera.position);

  // Step 1: world-space position with parallax-adjusted camera offset
  const camOffsetX = (0.5 - camPos.x) * viewport.w;
  const camOffsetY = (0.5 - camPos.y) * viewport.h;
  const worldX = proxy.x + camOffsetX * parallax;
  const worldY = proxy.y + camOffsetY * parallax;

  // Step 2: zoom around screen center
  const halfW = viewport.w / 2;
  const halfH = viewport.h / 2;

  const cameraAngle = camera.rotation ?? 0;
  const angleRadians = -cameraAngle * Math.PI / 180;
  const zoomedX = halfW + (worldX - halfW) * camera.zoom;
  const zoomedY = halfH + (worldY - halfH) * camera.zoom;
  const dx = zoomedX - halfW;
  const dy = zoomedY - halfH;

  return {
    screenX: halfW + dx * Math.cos(angleRadians) - dy * Math.sin(angleRadians) + (camera.shakeOffset?.x ?? 0),
    screenY: halfH + dx * Math.sin(angleRadians) + dy * Math.cos(angleRadians) + (camera.shakeOffset?.y ?? 0),
    screenScale: proxy.scale * camera.zoom,
    screenRotation: (proxy.rotation ?? 0) - cameraAngle,
    drawOrder,
  };
}
