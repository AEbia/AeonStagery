export type LookAtStagePoint = { x: number; y: number };

/**
 * Resolves a character's normalized on-stage anchor (same contract as
 * Live2DManager.getPoint: stage pixels divided by the 1920×1080 stage).
 */
export type LookAtPointLookup = (
  id: string,
  part: 'head' | 'chest' | 'feet' | 'center',
) => LookAtStagePoint | null;

interface LookAtFocusParams {
  /** Gaze target: another character's id (“注视目标”). */
  target?: unknown;
  /** Explicit semantic focus point in [-1, 1]. */
  point?: unknown;
  /** Runtime actions written before the point tuple contract. */
  focusX?: unknown;
  focusY?: unknown;
  enabled?: unknown;
  /** Gaze strength multiplier in [0, 1]; 1 / undefined = full deflection. */
  intensity?: unknown;
}

const NEUTRAL_FOCUS: readonly [number, number] = [0, 0];
/** The full stage span maps onto the focus controller's [-1, 1] range. */
const STAGE_TO_FOCUS_SCALE = 2;

function readFiniteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveTargetDirection(
  params: LookAtFocusParams,
  lookup: LookAtPointLookup,
  selfId: string,
): readonly [number, number] | null {
  const self = lookup(selfId, 'head');
  const target = lookup(params.target as string, 'head');
  if (!self || !target) return null;

  const dx = (target.x - self.x) * STAGE_TO_FOCUS_SCALE;
  const dy = (target.y - self.y) * STAGE_TO_FOCUS_SCALE;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  // Coincident characters have no gaze direction; keep them neutral instead of
  // snapping the eyes sideways.
  if (dx === 0 && dy === 0) return NEUTRAL_FOCUS;

  // Use the actual stage-space displacement (clamped to the focus controller's
  // [-1, 1] range), not a unit direction. A target slightly to the right should
  // produce a small rightward gaze instead of snapping to hard-left/hard-right.
  // The screen-Y flip keeps positive focusY looking up.
  return [
    Math.max(-1, Math.min(1, dx)),
    Math.max(-1, Math.min(1, -dy)),
  ];
}

/**
 * Resolves the runtime focus tuple for a characterLookAt action.
 *
 * Priority: 注视目标（another character）→ semantic point → legacy scalars →
 * neutral. The gaze target wins over an explicit point because the compiler
 * injects a default `point: [0, 0]` whenever the source omits one; without
 * this precedence every target-authored gaze would be masked back to staring
 * straight ahead.
 *
 * Returns focus-controller coordinates in [-1, 1].
 */
export function resolveLookAtFocus(
  params: LookAtFocusParams,
  lookup?: LookAtPointLookup,
  selfId?: unknown,
): readonly [number, number] {
  if (params.enabled === false) return NEUTRAL_FOCUS;

  let base: readonly [number, number];

  const targetId = readTrimmedString(params.target);
  const selfKey = readTrimmedString(selfId);
  if (lookup && targetId && selfKey && targetId !== selfKey) {
    base = resolveTargetDirection(params, lookup, selfKey) ?? resolvePointFallback(params);
  } else {
    base = resolvePointFallback(params);
  }

  const intensity = readFiniteNumber(params.intensity);
  if (intensity === null || intensity === 1) return base;
  return [base[0] * intensity, base[1] * intensity];
}

function resolvePointFallback(params: LookAtFocusParams): readonly [number, number] {
  if (Array.isArray(params.point) && params.point.length === 2) {
    const x = Number(params.point[0]);
    const y = Number(params.point[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) return [x, y];
  }

  // Compatibility for runtime actions written before the semantic point
  // contract was introduced.
  const x = Number(params.focusX);
  const y = Number(params.focusY);
  if (Number.isFinite(x) && Number.isFinite(y)) return [x, y];
  return NEUTRAL_FOCUS;
}
