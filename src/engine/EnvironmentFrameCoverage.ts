import { projectToScreen } from './Projection';
import type { EnvironmentLayerRenderState } from './environmentLayerModel';
import type { ResolvedCameraState } from './CameraStateResolver';

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

interface Point { readonly x: number; readonly y: number }
type Polygon = readonly Point[];
const EPSILON = 1e-8;

function side(point: Point, from: Point, to: Point): number {
  return (to.x - from.x) * (point.y - from.y) - (to.y - from.y) * (point.x - from.x);
}

function clip(polygon: Polygon, from: Point, to: Point, inside: boolean): Point[] {
  const result: Point[] = [];
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const da = side(a, from, to);
    const db = side(b, from, to);
    const keepA = inside ? da >= 0 : da <= 0;
    const keepB = inside ? db >= 0 : db <= 0;
    if (keepA) result.push(a);
    if (keepA !== keepB) {
      const weight = da / (da - db);
      result.push({ x: a.x + (b.x - a.x) * weight, y: a.y + (b.y - a.y) * weight });
    }
  }
  return result;
}

function hasArea(polygon: Polygon): boolean {
  let area = 0;
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) > EPSILON;
}

/** Subtract a convex image quad, retaining disjoint convex uncovered pieces. */
function subtract(subject: Polygon, cover: Polygon): Polygon[] {
  const uncovered: Polygon[] = [];
  let remainder = subject;
  for (let index = 0; index < cover.length && remainder.length > 0; index++) {
    const from = cover[index];
    const to = cover[(index + 1) % cover.length];
    const outside = clip(remainder, from, to, false);
    if (hasArea(outside)) uncovered.push(outside);
    remainder = clip(remainder, from, to, true);
  }
  return uncovered;
}

export function isValidImageSize(size: ImageSize | undefined): size is ImageSize {
  return size !== undefined && Number.isFinite(size.width) && size.width > 0
    && Number.isFinite(size.height) && size.height > 0;
}

/**
 * Geometric coverage of the final frame, matching StageManager's cover-fit
 * and projection. Image alpha pixels are intentionally outside this contract.
 * Undefined means an image size is unavailable, so exposure is unproven.
 */
export function hasUncoveredEnvironmentFrame(
  layers: Iterable<EnvironmentLayerRenderState>,
  camera: Pick<ResolvedCameraState, 'position' | 'zoom' | 'rotation'>,
  reference: ImageSize,
  imageSize: (path: string) => ImageSize | undefined,
): boolean | undefined {
  if (!isValidImageSize(reference) || !(camera.zoom > 0)) return undefined;
  let uncovered: Polygon[] = [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]];
  let unknown = false;
  let artwork = false;
  for (const layer of layers) {
    artwork ||= layer.images.length > 0;
    if ((layer.opacityMultiplier ?? 1) <= 0) continue;
    for (const image of layer.images) {
      if (!(image.weight > 0)) continue;
      const transform = { ...layer, ...image.transform };
      if ((transform.opacity ?? 1) <= 0 || transform.scale === 0) continue;
      const size = transform.layoutMode === 'tile' ? reference : imageSize(image.image);
      if (!isValidImageSize(size)) { unknown = true; continue; }
      const projected = projectToScreen({
        x: (transform.x ?? 0.5) * reference.width,
        y: (transform.y ?? 0.5) * reference.height,
        scale: transform.scale ?? 1,
        rotation: transform.rotation ?? 0,
        parallaxDepth: transform.z ?? 0,
      }, { ...camera, position: camera.position }, { w: reference.width, h: reference.height });
      const fit = Math.max(reference.width / size.width, reference.height / size.height);
      const halfW = size.width * fit * Math.abs(projected.screenScale) / 2;
      const halfH = size.height * fit * Math.abs(projected.screenScale) / 2;
      const angle = projected.screenRotation * Math.PI / 180;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      const quad = [[-halfW, -halfH], [halfW, -halfH], [halfW, halfH], [-halfW, halfH]].map(([x, y]) => ({
        x: (projected.screenX + x * cosine - y * sine) / reference.width,
        y: (projected.screenY + x * sine + y * cosine) / reference.height,
      }));
      uncovered = uncovered.flatMap(polygon => subtract(polygon, quad));
      if (uncovered.length === 0) return false;
    }
  }
  // Scenes without environment artwork may intentionally use a solid stage.
  return unknown || !artwork ? undefined : true;
}
