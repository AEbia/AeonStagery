import { STAGE_HEIGHT, STAGE_WIDTH } from './StageDimensions';

export type Live2DAnchorName = 'head' | 'chest' | 'feet' | 'center';

export interface LogicalHeightAnchorOffset {
  /** Horizontal displacement from the authored model origin, in logical heights. */
  readonly x: number;
  /** Vertical displacement from the authored model origin, in logical heights. */
  readonly y: number;
}

export interface Live2DAnchorTransform {
  readonly position: readonly [number, number];
  readonly scale?: number;
  readonly rotation?: number;
  readonly flipX?: boolean;
}

export interface NormalizedAnchorPosition {
  readonly x: number;
  readonly y: number;
}

/** Apply authored stage transforms to offsets captured once from a posed model. */
export function transformLive2DAnchorOffsets(
  offsets: Partial<Record<Live2DAnchorName, LogicalHeightAnchorOffset>>,
  state: Live2DAnchorTransform,
): Partial<Record<Live2DAnchorName, NormalizedAnchorPosition>> {
  const scale = Number.isFinite(state.scale) ? state.scale! : 1;
  const radians = (Number.isFinite(state.rotation) ? state.rotation! : 0) * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const result: Partial<Record<Live2DAnchorName, NormalizedAnchorPosition>> = {};
  for (const [anchor, offset] of Object.entries(offsets) as Array<[Live2DAnchorName, LogicalHeightAnchorOffset]>) {
    const localX = offset.x * STAGE_HEIGHT * scale * (state.flipX ? -1 : 1);
    const localY = offset.y * STAGE_HEIGHT * scale;
    const point = {
      x: state.position[0] + (localX * cos - localY * sin) / STAGE_WIDTH,
      y: state.position[1] + (localX * sin + localY * cos) / STAGE_HEIGHT,
    };
    if (Number.isFinite(point.x) && Number.isFinite(point.y)) result[anchor] = point;
  }
  return result;
}

type Bounds = { x: number; y: number; width: number; height: number };
type RefreshableModel = {
  getLocalBounds?: () => Bounds;
  updateDrawableBounds?: () => void;
};
type Point = { x: number; y: number };
type LocalTransform = { apply: (point: Point) => Point };

const FALLBACK_FRACTIONS: Readonly<Record<Live2DAnchorName, number>> = {
  head: 0.18,
  chest: 0.42,
  center: 0.5,
  feet: 0.95,
};

/**
 * Refresh and capture one posed semantic anchor in model-local logical-height
 * units. Cubism's renderer normally refreshes drawable bounds; doing it here
 * lets geometry consumers read the current Core pose without rendering.
 */
export function captureLive2DAnchorOffset(
  model: RefreshableModel | null | undefined,
  anchor: Live2DAnchorName,
  logicalHeight: number | null | undefined,
  headFraction?: { readonly x: number; readonly y: number } | null,
  origin: Point = { x: 0, y: 0 },
  localTransform?: LocalTransform,
): LogicalHeightAnchorOffset | null {
  return captureLive2DAnchorOffsets(model, [anchor], logicalHeight, headFraction, origin, localTransform)?.[anchor] ?? null;
}

/** Refresh one posed model once, then derive every requested semantic anchor. */
export function captureLive2DAnchorOffsets(
  model: RefreshableModel | null | undefined,
  anchors: readonly Live2DAnchorName[],
  logicalHeight: number | null | undefined,
  headFraction?: { readonly x: number; readonly y: number } | null,
  origin: Point = { x: 0, y: 0 },
  localTransform?: LocalTransform,
): Partial<Record<Live2DAnchorName, LogicalHeightAnchorOffset>> | null {
  if (!model) return null;

  const refreshable = model as RefreshableModel;
  try {
    refreshable.updateDrawableBounds?.();
    const bounds = refreshable.getLocalBounds?.();
    if (!isValidBounds(bounds)) return null;
    const unitHeight = Number.isFinite(logicalHeight) && logicalHeight! > 0
      ? logicalHeight!
      : bounds.height;
    const offsets: Partial<Record<Live2DAnchorName, LogicalHeightAnchorOffset>> = {};
    for (const anchor of anchors) {
      const fractionX = anchor === 'head' && isFiniteFraction(headFraction?.x) ? headFraction.x : 0.5;
      const fractionY = anchor === 'head' && isFiniteFraction(headFraction?.y)
        ? headFraction.y
        : FALLBACK_FRACTIONS[anchor];
      const anchorPoint = { x: bounds.x + bounds.width * fractionX, y: bounds.y + bounds.height * fractionY };
      const transformed = localTransform?.apply(anchorPoint) ?? anchorPoint;
      const x = (transformed.x - origin.x) / unitHeight;
      const y = (transformed.y - origin.y) / unitHeight;
      if (Number.isFinite(x) && Number.isFinite(y)) offsets[anchor] = { x, y };
    }
    return offsets;
  } catch {
    return null;
  }
}

function isFiniteFraction(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function isValidBounds(bounds: Bounds | undefined): bounds is Bounds {
  return !!bounds
    && Number.isFinite(bounds.x)
    && Number.isFinite(bounds.y)
    && Number.isFinite(bounds.width)
    && Number.isFinite(bounds.height)
    && bounds.width > 0
    && bounds.height > 0;
}
