import type { Live2DAnchorName } from './Live2DAnchorGeometry';
import type { CameraPosition } from './CameraStateResolver';

export type StagePoint = CameraPosition;
export type StagePartName = Live2DAnchorName;

export interface StageAnchorSource {
  readonly desiredPosition?: (characterId: string) => StagePoint | null | undefined;
  readonly getPoint?: (characterId: string, part: StagePartName) => StagePoint | null | undefined;
  readonly getPosition?: (characterId: string) => StagePoint | null | undefined;
  readonly getOrigin?: (characterId: string) => StagePoint | null | undefined;
}

export type StageAnchorResolver = (characterId: string, part?: string) => StagePoint | null;
export type StageAnchorResolverDependencies = StageAnchorSource;

/** Compose authored character positions with the current visible part geometry. */
export function createStageAnchorResolver(dependencies: StageAnchorResolverDependencies): StageAnchorResolver {
  return (characterId: string, part?: string): StagePoint | null => {
    const base = dependencies.desiredPosition?.(characterId) ?? null;
    const proxyOrigin = dependencies.getOrigin?.(characterId);
    const bodyPoint = dependencies.getPosition?.(characterId);
    const origin = proxyOrigin ?? bodyPoint;
    if (!part) {
      if (base && proxyOrigin && bodyPoint && isFinitePoint(base) && isFinitePoint(proxyOrigin) && isFinitePoint(bodyPoint)) {
        return { x: base.x + bodyPoint.x - proxyOrigin.x, y: base.y + bodyPoint.y - proxyOrigin.y };
      }
      return base ?? origin ?? null;
    }
    const normalizedPart: StagePartName = part === 'head' || part === 'chest' || part === 'feet' || part === 'center'
      ? part
      : 'center';
    const point = dependencies.getPoint?.(characterId, normalizedPart);
    if (point && base && origin && isFinitePoint(point) && isFinitePoint(base) && isFinitePoint(origin)) {
      if (base.x === origin.x && base.y === origin.y) return point;
      return { x: base.x + point.x - origin.x, y: base.y + point.y - origin.y };
    }
    // A body/origin position cannot stand in for an unavailable part anchor:
    // focus captures this result once, including a missing destination.
    return point && isFinitePoint(point) ? point : null;
  };
}

function isFinitePoint(point: StagePoint | null | undefined): point is StagePoint {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
}
