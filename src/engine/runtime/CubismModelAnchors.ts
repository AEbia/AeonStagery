import type { Live2DAnchorName } from '../Live2DAnchorGeometry';

type Point = { x: number; y: number };
type Bounds = Point & { width: number; height: number };

/** Only the geometry needed at the Cubism SDK boundary. */
export interface CubismAnchorModel {
  updateDrawableBounds?: () => void;
  getLocalBounds?: () => Bounds;
  internalModel?: {
    settings?: { moc?: string };
    localTransform: { apply(point: Point): Point };
    getDrawableBounds(index: number, bounds: Bounds): Bounds;
    coreModel: {
      getModel(): {
        parts: { ids: readonly string[] };
        drawables: {
          count: number;
          parentPartIndices: ArrayLike<number>;
          opacities: ArrayLike<number>;
        };
      };
    };
  };
}

// Part IDs are specific to this moc, not a naming convention for other models.
// Long hair, arms and the guitar must not determine the body's horizontal axis.
const STAGE_ANON_ANCHORS: Record<Live2DAnchorName, { parts: readonly string[]; y: number }> = {
  head: { parts: ['Part153'], y: 0.5 }, // face contour
  chest: { parts: ['Part25'], y: 0.35 }, // upper jacket
  center: { parts: ['Part153', 'Part29', 'Part38', 'Part62'], y: 0.5 },
  feet: { parts: ['Part38', 'Part62'], y: 0.97 },
};

/** Current posed anatomy, expressed as fractions of the current local bounds. */
export function resolveCubismModelAnchor(
  model: CubismAnchorModel | null | undefined,
  anchor: Live2DAnchorName,
): Point | null {
  const internal = model?.internalModel;
  if (internal?.settings?.moc?.split(/[\\/]/).pop() !== 'live2d_anon_002_live_01.moc3') return null;

  try {
    model?.updateDrawableBounds?.();
    const bounds = model?.getLocalBounds?.();
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
      || bounds.width <= 0 || bounds.height <= 0) return null;

    const profile = STAGE_ANON_ANCHORS[anchor];
    const raw = internal.coreModel.getModel();
    const found = new Set<string>();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let index = 0; index < raw.drawables.count; index++) {
      const part = raw.parts.ids[raw.drawables.parentPartIndices[index]];
      if (!profile.parts.includes(part) || !(raw.drawables.opacities[index] > 0)) continue;
      const drawable = internal.getDrawableBounds(index, { x: 0, y: 0, width: 0, height: 0 });
      if (![drawable.x, drawable.y, drawable.width, drawable.height].every(Number.isFinite)
        || drawable.width <= 0 || drawable.height <= 0) continue;
      // Transform all corners: authored layout may rotate or reflect the model.
      const corners = [
        { x: drawable.x, y: drawable.y },
        { x: drawable.x + drawable.width, y: drawable.y },
        { x: drawable.x, y: drawable.y + drawable.height },
        { x: drawable.x + drawable.width, y: drawable.y + drawable.height },
      ].map(point => internal.localTransform.apply(point));
      if (!corners.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) continue;
      for (const point of corners) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
      found.add(part);
    }
    // Incomplete/hidden anatomy falls back to the existing anchor policy.
    if (found.size !== profile.parts.length || !(maxX > minX && maxY > minY)) return null;
    return {
      x: ((minX + maxX) / 2 - bounds.x) / bounds.width,
      y: (minY + (maxY - minY) * profile.y - bounds.y) / bounds.height,
    };
  } catch {
    return null;
  }
}
