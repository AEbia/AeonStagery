/**
 * AeonStagery — Stage Anchor Resolver
 *
 * Produces the character-anchor resolution used by the deterministic camera
 * state resolver. Playback camera moves target LIVE part anchors
 * (`getPoint(id, part)`); seek reconstruction must frame identically without
 * depending on model transforms being current for the query time.
 *
 * Strategy: compose the statement-derived model position (valid at any time)
 * with a part offset MEASURED from the live model — `getPoint(part) −
 * proxy origin`. Both measurements come from the same (possibly stale) model
 * state, so their delta stays valid regardless of seek staleness, while the
 * base keeps the anchor deterministic.
 */

export interface StagePoint {
  x: number;
  y: number;
}

export type StagePartName = 'head' | 'chest' | 'feet' | 'center';

export interface StageAnchorSource {
  /** Statement-derived model position at the query time, if known. */
  desiredPosition?: (characterId: string) => StagePoint | null | undefined;
  getPoint?: (characterId: string, part: StagePartName) => StagePoint | null | undefined;
  getPosition?: (characterId: string) => StagePoint | null | undefined;
  /** Authored proxy origin, distinct from the model's visual center. */
  getOrigin?: (characterId: string) => StagePoint | null | undefined;
}

export type StageAnchorResolver = (characterId: string, part?: string) => StagePoint | null;

const VALID_PARTS: ReadonlySet<string> = new Set(['head', 'chest', 'feet', 'center']);

function normalizePart(part: string | undefined): StagePartName | null {
  if (!part) return null;
  return VALID_PARTS.has(part) ? (part as StagePartName) : 'center';
}

function isFinitePoint(point: StagePoint | null | undefined): point is StagePoint {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

/**
 * Build an anchor resolver that keeps seek framing faithful to playback:
 * anchors return `statementBase + (liveAnchor − liveOrigin)`. When an origin
 * is unavailable, body queries use the statement base; live anchors fill in
 * when no statement position exists.
 */
export function createStageAnchorResolver(source: StageAnchorSource): StageAnchorResolver {
  return (characterId: string, part?: string): StagePoint | null => {
    const base = source.desiredPosition?.(characterId) ?? null;
    const partName = normalizePart(part);

    if (partName || source.getOrigin) {
      const measuredPart = partName
        ? source.getPoint?.(characterId, partName)
        : source.getPosition?.(characterId);
      const measuredOrigin = source.getOrigin?.(characterId) ?? source.getPosition?.(characterId);
      const partPoint = isFinitePoint(measuredPart) ? measuredPart : null;
      const origin = isFinitePoint(measuredOrigin) ? measuredOrigin : null;

      if (partPoint && origin && base) {
        return { x: base.x + (partPoint.x - origin.x), y: base.y + (partPoint.y - origin.y) };
      }
      if (!base && partPoint) return partPoint;
    }

    if (base) {
      return { x: base.x, y: base.y };
    }

    const bodyPoint = source.getPosition?.(characterId);
    return isFinitePoint(bodyPoint) ? { x: bodyPoint.x, y: bodyPoint.y } : null;
  };
}
