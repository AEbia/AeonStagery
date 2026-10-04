export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'darken',
  'lighten',
  'overlay',
  'soft-light',
  'hard-light',
] as const;

export type BlendMode = (typeof BLEND_MODES)[number];

const blendModeSet: ReadonlySet<string> = new Set(BLEND_MODES);

export function isBlendMode(value: unknown): value is BlendMode {
  return typeof value === 'string' && blendModeSet.has(value);
}

export function normalizeBlendMode(value: unknown, fallback: BlendMode): BlendMode {
  return isBlendMode(value) ? value : fallback;
}
