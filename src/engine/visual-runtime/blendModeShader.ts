import type { BlendMode } from '../../api/types/blend-mode';

export const BLEND_MODE_SHADER_INDEX: Record<BlendMode, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  darken: 3,
  lighten: 4,
  overlay: 5,
  'soft-light': 6,
  'hard-light': 7,
};

export const BLEND_MODE_SHADER_GLSL = `
vec3 overlayBlend(vec3 base, vec3 blendColor) {
  return mix(
    2.0 * base * blendColor,
    1.0 - 2.0 * (1.0 - base) * (1.0 - blendColor),
    step(0.5, base)
  );
}

vec3 hardLightBlend(vec3 base, vec3 blendColor) {
  return mix(
    2.0 * base * blendColor,
    1.0 - 2.0 * (1.0 - base) * (1.0 - blendColor),
    step(0.5, blendColor)
  );
}

vec3 softLightBlend(vec3 base, vec3 blendColor) {
  vec3 curve = mix(
    sqrt(max(base, vec3(0.0))),
    ((16.0 * base - 12.0) * base + 4.0) * base,
    step(base, vec3(0.25))
  );
  vec3 low = base - (1.0 - 2.0 * blendColor) * base * (1.0 - base);
  vec3 high = base + (2.0 * blendColor - 1.0) * (curve - base);
  return mix(low, high, step(vec3(0.5), blendColor));
}

vec3 applyBlendMode(vec3 base, vec3 blendColor, float mode) {
  if (mode < 0.5) return blendColor;
  if (mode < 1.5) return base * blendColor;
  if (mode < 2.5) return base + blendColor - base * blendColor;
  if (mode < 3.5) return min(base, blendColor);
  if (mode < 4.5) return max(base, blendColor);
  if (mode < 5.5) return overlayBlend(base, blendColor);
  if (mode < 6.5) return softLightBlend(base, blendColor);
  return hardLightBlend(base, blendColor);
}
`;
