/**
 * Parses the WebGAL `-transform` JSON used by changeBg/changeFigure/setTransform
 * and the `setTempAnimation` keyframe fragments. Only the transform fields
 * AeonStagery can express are surfaced; every unrecognized field is collected
 * so the importer can report what had to be dropped.
 *
 * See https://docs.openwebgal.com/script-reference/others/transform-reference.html
 * for the WebGAL side.
 */

export interface WebGalTransformEffects {
  position?: { x?: number; y?: number };
  rotation?: number;
  scale?: { x?: number; y?: number };
  alpha?: number;
  blur?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  gamma?: number;
  colorRed?: number;
  colorGreen?: number;
  colorBlue?: number;
  bloom?: number;
  bloomBrightness?: number;
  bloomBlur?: number;
  bloomThreshold?: number;
  bevel?: number;
  bevelThickness?: number;
  bevelRed?: number;
  bevelGreen?: number;
  bevelBlue?: number;
  bevelRotation?: number;
  bevelSoftness?: number;
  oldFilm?: number;
  dotFilm?: number;
  rgbFilm?: number;
  glitchFilm?: number;
  godrayFilm?: number;
  reflectionFilm?: number;
  shockwave?: number;
  radiusAlpha?: number;
  /** Transform fields WebGAL knows but AeonStagery cannot express. */
  unknown: string[];
}

const KNOWN_FIELDS = new Set([
  'position',
  'rotation',
  'scale',
  'alpha',
  'blur',
  'brightness',
  'contrast',
  'saturation',
  'gamma',
  'colorRed',
  'colorGreen',
  'colorBlue',
  'bloom',
  'bloomBrightness',
  'bloomBlur',
  'bloomThreshold',
  'bevel',
  'bevelThickness',
  'bevelRed',
  'bevelGreen',
  'bevelBlue',
  'bevelRotation',
  'bevelSoftness',
  'oldFilm',
  'dotFilm',
  'rgbFilm',
  'glitchFilm',
  'godrayFilm',
  'reflectionFilm',
  'shockwave',
  'radiusAlpha',
]);

export function parseWebGalTransform(raw: string | undefined): WebGalTransformEffects | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;

  const record = parsed as Record<string, unknown>;
  const effects: WebGalTransformEffects = { unknown: [] };
  let recognized = false;

  const position = readVec2(record.position);
  if (position) {
    effects.position = position;
    recognized = true;
  }
  const rotation = readFiniteNumber(record.rotation);
  if (rotation !== undefined) {
    effects.rotation = rotation;
    recognized = true;
  }
  const scale = readVec2(record.scale);
  if (scale) {
    effects.scale = scale;
    recognized = true;
  }
  for (const field of NUMBER_FIELDS) {
    const value = readFiniteNumber(record[field]);
    if (value !== undefined) {
      effects[field] = value;
      recognized = true;
    }
  }

  for (const key of Object.keys(record)) {
    if (!KNOWN_FIELDS.has(key)) effects.unknown.push(key);
  }

  return recognized ? effects : undefined;
}

/** WebGAL keeps transforms sticky: a field absent from a later statement
 * inherits the previous value. This helper merges two parsed transforms. */
export function mergeWebGalTransforms(
  base: WebGalTransformEffects,
  next: WebGalTransformEffects,
): WebGalTransformEffects {
  return {
    ...base,
    ...next,
    unknown: [...base.unknown, ...next.unknown],
  };
}

const NUMBER_FIELDS = [
  'alpha',
  'blur',
  'brightness',
  'contrast',
  'saturation',
  'gamma',
  'colorRed',
  'colorGreen',
  'colorBlue',
  'bloom',
  'bloomBrightness',
  'bloomBlur',
  'bloomThreshold',
  'bevel',
  'bevelThickness',
  'bevelRed',
  'bevelGreen',
  'bevelBlue',
  'bevelRotation',
  'bevelSoftness',
  'oldFilm',
  'dotFilm',
  'rgbFilm',
  'glitchFilm',
  'godrayFilm',
  'reflectionFilm',
  'shockwave',
  'radiusAlpha',
] as const;

/** Whether the transform carries anything besides position/rotation/scale/alpha. */
export function hasFilterEffects(effects: WebGalTransformEffects): boolean {
  return effects.blur !== undefined
    || effects.brightness !== undefined
    || effects.contrast !== undefined
    || effects.saturation !== undefined
    || effects.gamma !== undefined
    || effects.colorRed !== undefined
    || effects.colorGreen !== undefined
    || effects.colorBlue !== undefined
    || effects.bloom !== undefined
    || effects.bloomBrightness !== undefined
    || effects.bloomBlur !== undefined
    || effects.bloomThreshold !== undefined
    || effects.bevel !== undefined
    || effects.bevelThickness !== undefined
    || effects.bevelRed !== undefined
    || effects.bevelGreen !== undefined
    || effects.bevelBlue !== undefined
    || effects.bevelRotation !== undefined
    || effects.bevelSoftness !== undefined
    || effects.oldFilm !== undefined
    || effects.dotFilm !== undefined
    || effects.rgbFilm !== undefined
    || effects.glitchFilm !== undefined
    || effects.godrayFilm !== undefined
    || effects.reflectionFilm !== undefined
    || effects.shockwave !== undefined
    || effects.radiusAlpha !== undefined;
}

/**
 * WebGAL easing names mapped onto GSAP easing strings the runtime accepts.
 * WebGAL: linear/easeIn/easeOut/easeInOut/circIn/circOut/circInOut/
 * backIn/backOut/backInOut/bounceIn/bounceOut/bounceInOut/anticipate.
 */
const WEBGAL_EASE_TO_GSAP: Record<string, string> = {
  linear: 'linear',
  easein: 'easein',
  easeout: 'easeout',
  easeinout: 'easeinout',
  circin: 'circ.in',
  circout: 'circ.out',
  circinout: 'circ.inOut',
  backin: 'back.in(1.7)',
  backout: 'back.out(1.7)',
  backinout: 'back.inOut(1.7)',
  bouncein: 'bounce.in',
  bounceout: 'bounce.out',
  bounceinout: 'bounce.inOut',
  anticipate: 'anticipate',
};

/** Resolves a WebGAL `-ease=...` value; unknown values stay undefined so the
 * runtime falls back to its default easing. */
export function resolveWebGalEase(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  return WEBGAL_EASE_TO_GSAP[normalized];
}

/** WebGAL `-duration`/`-enter`/`-exit`/`-enterDuration`/`-exitDuration` values
 * are milliseconds; scene statements use seconds. */
export function readMillisecondsAsSeconds(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value / 1000 : undefined;
}

function readVec2(value: unknown): { x?: number; y?: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const x = readFiniteNumber(record.x);
  const y = readFiniteNumber(record.y);
  return x !== undefined || y !== undefined ? { ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}) } : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}
