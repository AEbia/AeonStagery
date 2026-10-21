import { Live2DCompositeModel } from './Live2DCompositeModel';
import { captureLive2DAnchorOffsets, type Live2DAnchorName } from './Live2DAnchorGeometry';
import type { CameraPosition } from './CameraStateResolver';
import { STAGE_HEIGHT, STAGE_WIDTH } from './StageDimensions';

type GeometryModel = {
  height?: number;
  pivot?: { x: number; y: number };
  _baseHeight?: number;
  _flipX?: boolean;
  localTransform?: { apply: (point: { x: number; y: number }) => { x: number; y: number } };
  updateLocalTransform?: () => void;
  getLocalBounds?: () => { x: number; y: number; width: number; height: number };
  updateDrawableBounds?: () => void;
};

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

/** Temporary live-stage compatibility seam; historical callers use prepared tracks. */
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
    return point && isFinitePoint(point) ? point : base ?? origin ?? null;
  };
}

function isFinitePoint(point: StagePoint | null | undefined): point is StagePoint {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

export interface CameraAnchorCharacterState {
  readonly position?: readonly [number, number] | { readonly x: number; readonly y: number };
  readonly scale?: number;
  readonly rotation?: number;
  readonly config?: { readonly flipX?: boolean };
}

export interface CameraAnchorGeometryInput {
  readonly state: CameraAnchorCharacterState;
  readonly displayObject: GeometryModel;
  /** Unscaled logical model height captured before authored Bake transforms. */
  readonly baseHeight?: number;
  readonly headFraction?: { readonly x: number; readonly y: number } | null;
}

/** Resolve all semantic anchor positions from one already posed isolated model. */
export function resolveCameraAnchorPositions(
  input: CameraAnchorGeometryInput,
): Readonly<Partial<Record<'origin' | 'head' | 'chest' | 'feet' | 'center', CameraPosition | null>>> {
  const position = input.state.position;
  const tuple = Array.isArray(position) ? position as readonly [number, number] : null;
  const objectPosition = position && !tuple ? position as { readonly x: number; readonly y: number } : null;
  const x = tuple ? tuple[0] : objectPosition?.x;
  const y = tuple ? tuple[1] : objectPosition?.y;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    return { origin: null, head: null, chest: null, feet: null, center: null };
  }
  const origin = { x, y };
  const result: Partial<Record<'origin' | 'head' | 'chest' | 'feet' | 'center', CameraPosition | null>> = {
    origin,
    head: null,
    chest: null,
    feet: null,
    center: null,
  };
  const root = input.displayObject;
  const scale = Number.isFinite(input.state.scale) ? input.state.scale! : 1;
  const flipX = input.state.config?.flipX ?? root._flipX ?? false;
  const degrees = Number.isFinite(input.state.rotation) ? input.state.rotation! : 0;
  const radians = degrees * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const rootPivot = root.pivot ?? { x: 0, y: 0 };
  const composite = root as GeometryModel & { mainModel?: GeometryModel; subModels?: GeometryModel[] };
  const isComposite = root instanceof Live2DCompositeModel;

  const assign = (anchors: readonly Live2DAnchorName[], source: GeometryModel | undefined) => {
    if (!source) return;
    if (source !== root) source.updateLocalTransform?.();
    const logicalBaseHeight = Number.isFinite(input.baseHeight) && input.baseHeight! > 0
      ? input.baseHeight!
      : root.getLocalBounds?.().height;
    const offsets = captureLive2DAnchorOffsets(
      source,
      anchors,
      logicalBaseHeight,
      input.headFraction,
      rootPivot,
      source !== root ? source.localTransform : undefined,
    );
    for (const anchor of anchors) {
      const offset = offsets?.[anchor];
      if (!offset) continue;
      const localX = offset.x * STAGE_HEIGHT * scale * (flipX ? -1 : 1);
      const localY = offset.y * STAGE_HEIGHT * scale;
      const point = {
        x: (x + (localX * cos - localY * sin) / STAGE_WIDTH),
        y: (y + (localX * sin + localY * cos) / STAGE_HEIGHT),
      };
      result[anchor] = Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
    }
  };

  if (isComposite) {
    assign(['head'], composite.subModels?.[0] ?? composite.mainModel);
    assign(['chest', 'feet', 'center'], composite.mainModel);
  } else {
    assign(['head', 'chest', 'feet', 'center'], root);
  }
  return Object.freeze(result);
}
