import type { Live2DAnchorName } from '../Live2DAnchorGeometry';

type Point = { x: number; y: number };
type Bounds = Point & { width: number; height: number };

const anatomyMetadata = new WeakMap<object, {
  names: ReadonlyMap<string, string>;
  categories?: readonly (Anatomy | null)[];
  hasInstruments?: boolean;
}>();

type DisplayInfoSettings = {
  json?: { FileReferences?: { DisplayInfo?: string } };
  resolveURL?: (file: string) => string;
};
type DisplayInfoModel = { internalModel?: { settings?: DisplayInfoSettings } };

/** DisplayInfo supplies semantic names; exported Part IDs are model-local. */
export function setCubismModelDisplayInfo(model: object, value: unknown): void {
  const names = new Map<string, string>();
  if (value && typeof value === 'object' && 'Parts' in value && Array.isArray(value.Parts)) {
    for (const part of value.Parts as unknown[]) {
      if (part && typeof part === 'object' && 'Id' in part && 'Name' in part
        && typeof part.Id === 'string' && typeof part.Name === 'string') {
        names.set(part.Id, part.Name);
      }
    }
  }
  anatomyMetadata.set(model, { names });
}

/** Only the geometry needed at the Cubism SDK boundary. */
export interface CubismAnchorModel extends DisplayInfoModel {
  updateDrawableBounds?: () => void;
  getLocalBounds?: () => Bounds;
  internalModel?: {
    settings?: DisplayInfoSettings;
    localTransform: { apply(point: Point): Point };
    getDrawableBounds(index: number, bounds: Bounds): Bounds;
    coreModel: {
      getModel(): {
        parts: { ids: readonly string[]; parentIndices?: ArrayLike<number> };
        drawables: {
          count: number;
          parentPartIndices: ArrayLike<number>;
          opacities: ArrayLike<number>;
        };
      };
    };
  };
}

// Positive anatomy selection prevents instruments, long hair and posed arms
// from defining the body axis. Names come from DisplayInfo, never a moc name
// or a table of model-specific Part IDs.
type Anatomy = 'face' | 'torso' | 'legs';
const FACE = /^(?:輪郭|顔|顏|脸|臉|face(?:[ _-]?contour)?)$/i;
const TORSO = /^(?:上半身(?:衣装|_服|服)?|胴体(?:肌)?|体|身体_素体|[左右]?(?:アウター|ジャケット)|(?:T|白)?シャツ|シャツ_中央|胸(?:[（(][^）)]*[）)])?|インナー|デニム胸|コルセット|衣装|ライブ服|body|torso|chest|jacket)$/i;
const LEGS = /^(?:[左右])?(?:脚|足|靴|ブーツ)(?:new|[（(]座[）)])?$/i;
const INSTRUMENT = /ギター|ベース|キーボード|ドラム|シンバル|楽器|guitar|bass|keyboard|drum|cymbal|instrument/i;
const EXCLUDED = /ギター|ベース|キーボード|ドラム|シンバル|楽器|スティック|ペダル|椅子|マイク|髪|腕|手|袖|肩|ケープ|guitar|bass|keyboard|drum|cymbal|instrument|microphone|hair|arm|hand|sleeve|cape/i;

/** Optional authoring metadata; a missing CDI must not prevent model loading. */
export async function loadCubismModelDisplayInfo(model: DisplayInfoModel): Promise<void> {
  const settings = model.internalModel?.settings;
  const file = settings?.json?.FileReferences?.DisplayInfo;
  if (!file || !settings?.resolveURL) return;
  try {
    const response = await fetch(settings.resolveURL(file));
    if (response.ok) setCubismModelDisplayInfo(model, await response.json());
  } catch {
    // Models without readable semantic metadata retain existing bounds anchors.
  }
}

function classifyPart(name: string): Anatomy | 'excluded' | null {
  const normalized = name.normalize('NFKC').replace(/^[*★\s]+/, '').trim();
  if (EXCLUDED.test(normalized)) return 'excluded';
  if (FACE.test(normalized)) return 'face';
  if (TORSO.test(normalized)) return 'torso';
  if (LEGS.test(normalized)) return 'legs';
  return null;
}

function drawableAnatomy(
  partIndex: number,
  parts: { ids: readonly string[]; parentIndices?: ArrayLike<number> },
  names: ReadonlyMap<string, string>,
): Anatomy | null {
  let anatomy: Anatomy | null = null;
  // Traverse even after finding anatomy: an instrument's nested "body" is
  // not a human torso. Bound traversal also tolerates malformed parent cycles.
  for (let depth = 0; partIndex >= 0 && partIndex < parts.ids.length && depth < parts.ids.length; depth++) {
    const category = classifyPart(names.get(parts.ids[partIndex]) ?? '');
    if (category === 'excluded') return null;
    anatomy ??= category;
    partIndex = parts.parentIndices?.[partIndex] ?? -1;
  }
  return anatomy;
}

function union(a: Bounds | undefined, b: Bounds): Bounds {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Current posed anatomy, expressed as fractions of the current local bounds. */
export function resolveCubismModelAnchor(
  model: CubismAnchorModel | null | undefined,
  anchor: Live2DAnchorName,
): Point | null {
  const internal = model?.internalModel;
  const metadata = model ? anatomyMetadata.get(model) : undefined;
  if (!internal || !metadata?.names.size) return null;

  try {
    const raw = internal.coreModel.getModel();
    // Ordinary figures retain their existing hit-area/bounds policy, even
    // when their authoring metadata contains recognizable body part names.
    const hasInstruments = metadata.hasInstruments ??= raw.parts.ids.some(id =>
      INSTRUMENT.test(metadata.names.get(id) ?? ''));
    if (!hasInstruments) return null;
    model?.updateDrawableBounds?.();
    const bounds = model?.getLocalBounds?.();
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
      || bounds.width <= 0 || bounds.height <= 0) return null;

    // Part IDs/hierarchy are immutable within a loaded moc; only geometry and
    // visibility change with the pose. Avoid repeating name matching per mesh.
    const categories = metadata.categories ??= raw.parts.ids.map((_, index) =>
      drawableAnatomy(index, raw.parts, metadata.names));
    const anatomy: Partial<Record<Anatomy, Bounds>> = {};
    for (let index = 0; index < raw.drawables.count; index++) {
      if (!(raw.drawables.opacities[index] > 0)) continue;
      const category = categories[raw.drawables.parentPartIndices[index]];
      if (!category) continue;
      const drawable = internal.getDrawableBounds(index, { x: 0, y: 0, width: 0, height: 0 });
      if (![drawable.x, drawable.y, drawable.width, drawable.height].every(Number.isFinite)
        || drawable.width <= 0 || drawable.height <= 0) continue;
      anatomy[category] = union(anatomy[category], drawable);
    }
    const body = Object.values(anatomy).reduce<Bounds | undefined>((all, part) => union(all, part), undefined);
    const selected = anchor === 'head' ? anatomy.face
      : anchor === 'chest' ? anatomy.torso ?? (anatomy.face && anatomy.legs ? body : undefined)
      : anchor === 'feet' ? anatomy.legs : body;
    if (!selected) return null;
    const yFraction = anchor === 'chest' ? (anatomy.torso ? 0.35 : 0.28)
      : anchor === 'feet' ? 0.97 : 0.5;
    // Compute the anatomical point before transforming it. A rotated layout's
    // axis-aligned bounding box no longer has the same anatomical proportions.
    const point = internal.localTransform.apply({
      x: selected.x + selected.width * 0.5,
      y: selected.y + selected.height * yFraction,
    });
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    return { x: (point.x - bounds.x) / bounds.width, y: (point.y - bounds.y) / bounds.height };
  } catch {
    return null;
  }
}
