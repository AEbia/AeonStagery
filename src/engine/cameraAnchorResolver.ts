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
 * getPosition()`. Both measurements come from the same (possibly stale) model
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
 * part queries return `statementBase + (livePart − liveBody)`, body queries
 * return the statement base, and live values fill in when no statement
 * position exists for the character.
 */
export function createStageAnchorResolver(source: StageAnchorSource): StageAnchorResolver {
  return (characterId: string, part?: string): StagePoint | null => {
    const base = source.desiredPosition?.(characterId) ?? null;
    const partName = normalizePart(part);

    if (partName) {
      const partPoint = isFinitePoint(source.getPoint?.(characterId, partName))
        ? source.getPoint!(characterId, partName)!
        : null;
      const bodyPoint = isFinitePoint(source.getPosition?.(characterId))
        ? source.getPosition!(characterId)!
        : null;

      // Compose only when both sides of the delta are measurable — they are
      // captured from the same model state so the offset is time-consistent.
      if (partPoint && bodyPoint) {
        const delta = { x: partPoint.x - bodyPoint.x, y: partPoint.y - bodyPoint.y };
        if (base) {
          return { x: base.x + delta.x, y: base.y + delta.y };
        }
        return partPoint;
      }
      if (!base && partPoint) {
        return partPoint;
      }
    }

    if (base) {
      return { x: base.x, y: base.y };
    }

    const bodyPoint = source.getPosition?.(characterId);
    return isFinitePoint(bodyPoint) ? { x: bodyPoint.x, y: bodyPoint.y } : null;
  };
}
