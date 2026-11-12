import * as PIXI from 'pixi.js';
import type { BlendMode } from '../../api/types/blend-mode';
import { AdjustmentFilter, RGBSplitFilter } from 'pixi-filters';
import type {
  CompositeSlot,
  SemanticStyleOverride,
  SlotRecipeState,
  TargetEnvironmentOverride,
  VisualTargetId,
  VisualTargetRecord,
  VisualTargetType,
} from '../../api/types/visual';
import type {
  ResolvedCompositeSlotState,
  ResolvedCompositeTargetState,
  ResolvedVisualState,
  VisualTimelineScene,
} from '../../services/visual-authoring/VisualStateResolver';
import {
  resolveCompositeRecipePayload,
  type BuiltInCompositeRecipe,
} from './BuiltInVisualRecipeCatalog';
import { stageManager } from '../StageManager';
import { live2DManager } from '../Live2DManager';
import { textLayerManager } from '../TextLayerManager';
import { BACKGROUND_LAYER_ID } from '../environmentLayerModel';
import { PIXI_V8_FILTER_VERTEX } from '../PixiV8Filter';
import { BLEND_MODE_SHADER_GLSL, BLEND_MODE_SHADER_INDEX } from './blendModeShader';
import {
  averageColor,
  clamp,
  cloneColorStops,
  colorChannels,
  luminanceOfColor,
  mixColor,
  parseColor,
  saturationOfColor,
  scaleColor,
  type ColorStopSet,
} from './compositeColor';
import {
  ObjectCompositeEnvironmentProbe,
  type EnvironmentProbeSnapshot,
  type EnvironmentSamplingMode,
} from './ObjectCompositeEnvironmentProbe';

interface ObjectCompositeEffectSpec {
  adjustment?: {
    brightness: number;
    contrast: number;
    saturation: number;
    red: number;
    green: number;
    blue: number;
  };
  colorOverlay?: {
    alpha: number;
    color: number;
    colorStops?: [number, number, number, number];
    mode: BlendMode;
  };
  blur?: number;
  rgbSplit?: {
    x: number;
    y: number;
  };
  shadow?: {
    alpha: number;
    blur: number;
    color: number;
    distance: number;
    rotation: number;
  };
  environmentResponsive?: boolean;
  environmentIntensity?: number;
  shadowResponsive?: boolean;
}

const OWNED_FILTER = '__visualCompositeOwnedFilter';
type CompositeFilter = PIXI.Filter & { [OWNED_FILTER]?: boolean };
const ENVIRONMENT_COLOR_BLEND_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
// Shared uniforms must match the highp vertex declarations under Pixi defaults.
uniform highp vec4 uInputSize;
uniform vec4 uInputClamp;
uniform highp vec4 uOutputFrame;
uniform vec3 color;
uniform vec3 topLeftColor;
uniform vec3 topRightColor;
uniform vec3 bottomLeftColor;
uniform vec3 bottomRightColor;
uniform float alpha;
uniform float blendMode;
uniform float gradientMix;

${BLEND_MODE_SHADER_GLSL}

float luminance(vec3 colorValue) {
  return dot(colorValue, vec3(0.2126, 0.7152, 0.0722));
}

float maskAt(vec2 uv) {
  vec2 inside = step(uInputClamp.xy, uv) * step(uv, uInputClamp.zw);
  return texture(uTexture, clamp(uv, uInputClamp.xy, uInputClamp.zw)).a * inside.x * inside.y;
}

float silhouetteEdge(vec2 uv, float centerAlpha) {
  // Radius is in logical pixels, independent of render resolution / pooled texture size.
  float radius = clamp(min(uOutputFrame.z, uOutputFrame.w) * 0.012, 1.5, 6.0);
  vec2 d = uInputSize.zw * radius;
  float surrounding = maskAt(uv + vec2(d.x, 0.0)) + maskAt(uv - vec2(d.x, 0.0));
  surrounding += maskAt(uv + vec2(0.0, d.y)) + maskAt(uv - vec2(0.0, d.y));
  surrounding += maskAt(uv + d * 0.7071) + maskAt(uv - d * 0.7071);
  surrounding += maskAt(uv + vec2(d.x, -d.y) * 0.7071) + maskAt(uv + vec2(-d.x, d.y) * 0.7071);
  return clamp((centerAlpha - surrounding * 0.125) / max(centerAlpha, 0.0001) * 2.0, 0.0, 1.0);
}

void main(void) {
  vec4 source = texture(uTexture, vTextureCoord);
  // Pixi filter textures are premultiplied. Grade straight RGB, then premultiply once.
  vec3 base = source.a > 0.0001 ? source.rgb / source.a : vec3(0.0);
  vec2 objectUV = clamp(vTextureCoord * uInputSize.xy / max(uOutputFrame.zw, vec2(1.0)), 0.0, 1.0);
  vec3 topColor = mix(topLeftColor, topRightColor, objectUV.x);
  vec3 bottomColor = mix(bottomLeftColor, bottomRightColor, objectUV.x);
  // Pixi filter UVs follow the model's top-down local coordinates: 0 is top, 1 is bottom.
  vec3 gradientColor = mix(topColor, bottomColor, objectUV.y);
  vec3 environmentColor = mix(color, gradientColor, gradientMix);
  float strength = clamp(alpha, 0.0, 1.0);
  vec3 graded = mix(base, applyBlendMode(base, environmentColor, blendMode), strength);
  // Light wrap stays inside the silhouette; internal ink / facial features do not blur.
  float edge = silhouetteEdge(vTextureCoord, source.a);
  float wrap = edge * strength * 0.55 * smoothstep(0.08, 0.65, luminance(environmentColor));
  graded = mix(graded, environmentColor, wrap);
  finalColor = vec4(clamp(graded, 0.0, 1.0) * source.a, source.a);
}
`;

const CHARACTER_GROUNDING_SHADOW_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec4 uInputPixel;
uniform vec2 offset;
uniform vec3 shadowColor;
uniform float alpha;
uniform float softness;

float sampleAlpha(vec2 uv) {
  return texture(uTexture, clamp(uv, vec2(0.0), vec2(1.0))).a;
}

float blurredOffsetAlpha(vec2 uv) {
  vec2 texel = uInputPixel.zw;
  vec2 shifted = uv - offset * texel;
  float radius = max(softness, 0.0);
  vec2 blur = texel * radius * 0.45;

  float total = sampleAlpha(shifted) * 0.22;
  total += sampleAlpha(shifted + vec2( blur.x, 0.0)) * 0.11;
  total += sampleAlpha(shifted + vec2(-blur.x, 0.0)) * 0.11;
  total += sampleAlpha(shifted + vec2(0.0,  blur.y)) * 0.11;
  total += sampleAlpha(shifted + vec2(0.0, -blur.y)) * 0.11;
  total += sampleAlpha(shifted + vec2( blur.x,  blur.y)) * 0.085;
  total += sampleAlpha(shifted + vec2(-blur.x,  blur.y)) * 0.085;
  total += sampleAlpha(shifted + vec2( blur.x, -blur.y)) * 0.085;
  total += sampleAlpha(shifted + vec2(-blur.x, -blur.y)) * 0.085;
  return clamp(total, 0.0, 1.0);
}

void main(void) {
  vec4 source = texture(uTexture, vTextureCoord);
  float mask = source.a;
  float directionalShadow = blurredOffsetAlpha(vTextureCoord) * mask;
  float fullMaskShade = mask * 0.22;
  float shiftedShade = directionalShadow * 0.48;
  float combinedShadow = max(fullMaskShade, shiftedShade);
  float strength = clamp(alpha * combinedShadow, 0.0, 0.92);
  vec3 multiplied = source.rgb * mix(vec3(1.0), shadowColor, 0.88);
  finalColor = vec4(mix(source.rgb, multiplied, strength), source.a);
}
`;

function writeColorUniform(uniform: Float32Array, value: number): void {
  uniform[0] = ((value >> 16) & 0xff) / 255;
  uniform[1] = ((value >> 8) & 0xff) / 255;
  uniform[2] = (value & 0xff) / 255;
}

function colorToVec3(value: number): Float32Array {
  const uniform = new Float32Array([1, 1, 1]);
  writeColorUniform(uniform, value);
  return uniform;
}

class EnvironmentColorBlendFilter extends PIXI.Filter {
  readonly luminanceProtected = true;
  readonly uniforms: {
    alpha: number;
    blendMode: number;
    color: Float32Array;
    bottomLeftColor: Float32Array;
    bottomRightColor: Float32Array;
    gradientMix: number;
    topLeftColor: Float32Array;
    topRightColor: Float32Array;
  };
  private _alpha = 0;
  private _color = 0xffffff;
  private _colorStops: ColorStopSet | null = null;
  private _mode: BlendMode = 'soft-light';

  constructor(color: number, alpha: number, mode: BlendMode, colorStops?: ColorStopSet) {
    super({
      glProgram: PIXI.GlProgram.from({
        vertex: PIXI_V8_FILTER_VERTEX,
        fragment: ENVIRONMENT_COLOR_BLEND_FRAGMENT,
        name: 'aeon-environment-color-blend-filter',
      }),
      resources: {
        environmentUniforms: {
          alpha: { value: 0, type: 'f32' },
          blendMode: { value: 0, type: 'f32' },
          color: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          bottomLeftColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          bottomRightColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          gradientMix: { value: 0, type: 'f32' },
          topLeftColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          topRightColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
        },
      },
    });
    this.uniforms = this.resources.environmentUniforms.uniforms as typeof this.uniforms;
    this.color = color;
    this.colorStops = colorStops ?? null;
    this.alpha = alpha;
    this.mode = mode;
  }

  set alpha(value: number) {
    this._alpha = value;
    this.uniforms.alpha = value;
  }

  get alpha(): number {
    return this._alpha;
  }

  set color(value: number) {
    this._color = value;
    writeColorUniform(this.uniforms.color, value);
    if (!this._colorStops) {
      this.syncColorStops([value, value, value, value]);
    }
  }

  get color(): number {
    return this._color;
  }

  set colorStops(value: ColorStopSet | null) {
    this._colorStops = value;
    this.uniforms.gradientMix = value ? 1 : 0;
    this.syncColorStops(value ?? [this._color, this._color, this._color, this._color]);
  }

  get colorStops(): ColorStopSet | null {
    return this._colorStops;
  }

  set mode(value: BlendMode) {
    this._mode = value;
    this.uniforms.blendMode = BLEND_MODE_SHADER_INDEX[value];
  }

  get mode(): BlendMode {
    return this._mode;
  }

  private syncColorStops(stops: ColorStopSet): void {
    writeColorUniform(this.uniforms.topLeftColor, stops[0]);
    writeColorUniform(this.uniforms.topRightColor, stops[1]);
    writeColorUniform(this.uniforms.bottomLeftColor, stops[2]);
    writeColorUniform(this.uniforms.bottomRightColor, stops[3]);
  }
}

class CharacterGroundingShadowFilter extends PIXI.Filter {
  readonly internalOnly = true;
  readonly maskDriven = true;
  readonly uniforms: {
    alpha: number;
    offset: Float32Array;
    shadowColor: Float32Array;
    softness: number;
  };
  private _alpha = 0;
  private _blur = 0;
  private _color = 0x202734;
  private _distance = 0;
  private _rotation = 90;

  constructor(options: { alpha: number; blur: number; color: number; distance: number; rotation: number }) {
    super({
      glProgram: PIXI.GlProgram.from({
        vertex: PIXI_V8_FILTER_VERTEX,
        fragment: CHARACTER_GROUNDING_SHADOW_FRAGMENT,
        name: 'aeon-character-grounding-shadow-filter',
      }),
      resources: {
        shadowUniforms: {
          alpha: { value: 0, type: 'f32' },
          offset: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
          shadowColor: { value: colorToVec3(options.color), type: 'vec3<f32>' },
          softness: { value: 0, type: 'f32' },
        },
      },
    });
    this.uniforms = this.resources.shadowUniforms.uniforms as typeof this.uniforms;
    this.alpha = options.alpha;
    this.blur = options.blur;
    this.color = options.color;
    this.distance = options.distance;
    this.rotation = options.rotation;
  }

  set alpha(value: number) {
    this._alpha = value;
    this.uniforms.alpha = value;
  }

  get alpha(): number {
    return this._alpha;
  }

  set blur(value: number) {
    this._blur = value;
    this.uniforms.softness = value;
  }

  get blur(): number {
    return this._blur;
  }

  set color(value: number) {
    this._color = value;
    writeColorUniform(this.uniforms.shadowColor, value);
  }

  get color(): number {
    return this._color;
  }

  set distance(value: number) {
    this._distance = value;
    this.syncOffset();
  }

  get distance(): number {
    return this._distance;
  }

  set rotation(value: number) {
    this._rotation = value;
    this.syncOffset();
  }

  get rotation(): number {
    return this._rotation;
  }

  private syncOffset(): void {
    const radians = (this._rotation * Math.PI) / 180;
    this.uniforms.offset[0] = Math.cos(radians) * this._distance;
    this.uniforms.offset[1] = Math.sin(radians) * this._distance;
  }
}

function parseColorStops(value: unknown): ColorStopSet | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value
    .map((entry) => parseColor(entry))
    .filter((entry): entry is number => entry !== null);
  if (parsed.length === 0) return undefined;
  const fallback = parsed[0];
  return [
    parsed[0] ?? fallback,
    parsed[1] ?? fallback,
    parsed[2] ?? fallback,
    parsed[3] ?? fallback,
  ];
}

function mergeSemanticOverride(
  inherited?: SemanticStyleOverride,
  baseline?: SemanticStyleOverride,
  latched?: SemanticStyleOverride,
  modulation?: SemanticStyleOverride,
): SemanticStyleOverride | undefined {
  const merged = {
    ...(inherited || {}),
    ...(baseline || {}),
    ...(latched || {}),
    ...(modulation || {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function resolveSlotRecipe(
  slotState: ResolvedCompositeSlotState | undefined,
  baselineFromTarget: SlotRecipeState | undefined,
): { recipeId?: string; semantics?: SemanticStyleOverride } {
  const recipeId = slotState?.latched?.recipeId || slotState?.baseline?.recipeId || baselineFromTarget?.recipeId;
  const semantics = mergeSemanticOverride(
    baselineFromTarget?.semanticOverride,
    slotState?.baseline?.semanticOverride,
    slotState?.latched?.semanticOverride,
    slotState?.modulation,
  );
  return { recipeId: recipeId?.toLowerCase(), semantics };
}

function recipeWeight(semantics?: SemanticStyleOverride): number {
  return clamp(typeof semantics?.intensity === 'number' ? semantics.intensity : 1, 0, 1.5);
}

function integrationWeight(semantics?: SemanticStyleOverride): number {
  return clamp(typeof semantics?.intensity === 'number' ? semantics.intensity : 0.8, 0, 1.5);
}

function cloneBuiltInCompositeEffect(
  recipe: BuiltInCompositeRecipe | null,
  defaultColorBlendMode: BlendMode = 'soft-light',
): ObjectCompositeEffectSpec {
  const colorOverlayColor = parseColor(recipe?.colorOverlay?.color);
  const colorOverlayStops = parseColorStops(recipe?.colorOverlay?.colorStops);
  const resolvedColorOverlayColor = colorOverlayColor ?? (colorOverlayStops ? averageColor(colorOverlayStops) : null);
  return {
    adjustment: recipe?.adjustment
      ? {
          brightness: recipe.adjustment.brightness ?? 1,
          contrast: recipe.adjustment.contrast ?? 1,
          saturation: recipe.adjustment.saturation ?? 1,
          red: recipe.adjustment.red ?? 1,
          green: recipe.adjustment.green ?? 1,
          blue: recipe.adjustment.blue ?? 1,
        }
      : undefined,
    colorOverlay: recipe?.colorOverlay && resolvedColorOverlayColor !== null
      ? {
          alpha: recipe.colorOverlay.alpha ?? 0.12,
          color: resolvedColorOverlayColor,
          colorStops: colorOverlayStops,
          mode: recipe.colorOverlay.mode ?? defaultColorBlendMode,
        }
      : undefined,
    blur: recipe?.blur,
    rgbSplit: recipe?.rgbSplit ? { ...recipe.rgbSplit } : undefined,
    shadow: recipe?.shadow ? { ...recipe.shadow } : undefined,
  };
}

function buildGroundingEffect(scene: VisualTimelineScene | null, slotState: ResolvedCompositeSlotState | undefined, baseline?: SlotRecipeState): ObjectCompositeEffectSpec | null {
  const { recipeId, semantics } = resolveSlotRecipe(slotState, baseline);
  const recipe = recipeId || '';
  const intensity = recipeWeight(semantics);
  const blend = clamp(typeof semantics?.blend === 'number' ? semantics.blend : 0.35, 0, 1.5);
  const contamination = clamp(typeof semantics?.contamination === 'number' ? semantics.contamination : 0.25, 0, 1.5);
  const warmth = clamp(typeof semantics?.warmth === 'number' ? semantics.warmth : 0, -1, 1);
  const builtIn = cloneBuiltInCompositeEffect(resolveCompositeRecipePayload(scene?.visual, 'grounding', recipeId));

  if (!recipe && !semantics) return null;
  if (!builtIn.shadow && !recipe.includes('ground') && !recipe.includes('shadow') && !recipe.includes('anchor') && !recipe.includes('integration') && !semantics) {
    return null;
  }

  const shadowColor = warmth > 0.25 ? 0x3a271e : warmth < -0.25 ? 0x1b2740 : 0x202734;
  const baseAlpha = builtIn.shadow?.alpha ?? 0.2;
  const baseBlur = builtIn.shadow?.blur ?? 10;
  const baseDistance = builtIn.shadow?.distance ?? 9;
  return {
    shadow: {
      alpha: clamp(baseAlpha * (0.75 + intensity * 0.65) + blend * 0.11 + contamination * 0.08, 0, 0.58),
      blur: baseBlur + intensity * 8 + contamination * 12,
      color: builtIn.shadow?.color ?? shadowColor,
      distance: baseDistance + intensity * 7 + blend * 5,
      rotation: builtIn.shadow?.rotation ?? 90,
    },
    shadowResponsive: true,
  };
}

function buildIntegrationEffect(scene: VisualTimelineScene | null, slotState: ResolvedCompositeSlotState | undefined, baseline?: SlotRecipeState, sampleEnvironment = false): ObjectCompositeEffectSpec | null {
  const { recipeId, semantics } = resolveSlotRecipe(slotState, baseline);
  const recipe = recipeId || '';
  const intensity = integrationWeight(semantics);
  const brightnessControl = clamp(typeof semantics?.brightness === 'number' ? semantics.brightness : 0, -1, 1);
  const warmth = clamp(typeof semantics?.warmth === 'number' ? semantics.warmth : 0, -1, 1);
  const blend = clamp(typeof semantics?.blend === 'number' ? semantics.blend : 0.3, 0, 1.5);
  const contamination = clamp(typeof semantics?.contamination === 'number' ? semantics.contamination : 0.2, 0, 1.5);
  const builtIn = cloneBuiltInCompositeEffect(
    resolveCompositeRecipePayload(scene?.visual, 'integration', recipeId),
    'multiply',
  );

  if ((!recipe && !semantics) || intensity <= 0) return null;

  let red = builtIn.adjustment?.red ?? 1;
  let green = builtIn.adjustment?.green ?? 1;
  let blue = builtIn.adjustment?.blue ?? 1;
  let brightness = builtIn.adjustment?.brightness ?? 1;
  let contrast = builtIn.adjustment?.contrast ?? 1;
  let saturation = builtIn.adjustment?.saturation ?? 1;

  if (!builtIn.adjustment && (recipe.includes('soft') || recipe.includes('integrat'))) {
    brightness *= 0.985;
    contrast *= 0.99;
    saturation *= 0.98;
  }
  // Keep established stronger grades while making small UI adjustments effective.
  const warmthWeight = Math.min(Math.abs(warmth) / 0.1, 1);
  if ((!builtIn.adjustment && recipe.includes('warm')) || warmth > 0) {
    const weight = warmth > 0 ? warmthWeight : 1;
    red *= 1 + 0.045 * intensity * weight + warmth * 0.045;
    green *= 1 + 0.008 * intensity * weight;
    blue *= 1 - 0.018 * intensity * weight;
  }
  if ((!builtIn.adjustment && recipe.includes('cool')) || warmth < 0) {
    const weight = warmth < 0 ? warmthWeight : 1;
    blue *= 1 + 0.045 * intensity * weight + Math.abs(warmth) * 0.045;
    green *= 1 + 0.006 * intensity * weight;
    red *= 1 - 0.018 * intensity * weight;
  }

  brightness *= 1 - blend * 0.035 - contamination * 0.03;
  brightness *= 1 + brightnessControl;
  contrast *= 1 - blend * 0.012;
  saturation *= 1 - contamination * 0.07 - blend * 0.035 - intensity * 0.01;

  const semanticColorStops = sampleEnvironment ? undefined : parseColorStops(semantics?.colorStops);
  const semanticColor = sampleEnvironment ? null : parseColor(semantics?.color) ?? (semanticColorStops ? averageColor(semanticColorStops) : null);
  const overlayMode = semantics?.colorBlendMode ?? builtIn.colorOverlay?.mode ?? 'multiply';
  const colorOverlay = semanticColor !== null
    ? {
        alpha: clamp(intensity * (0.16 + blend * 0.18 + contamination * 0.22), 0, 0.65),
        color: semanticColor,
        colorStops: semanticColorStops,
        mode: overlayMode,
      }
    : builtIn.colorOverlay
      ? {
          alpha: clamp(intensity * ((builtIn.colorOverlay.alpha ?? 0.08) * 2 + blend * 0.18 + contamination * 0.22), 0, 0.65),
          color: sampleEnvironment ? 0x808080 : builtIn.colorOverlay.color,
          colorStops: sampleEnvironment ? [0x808080, 0x808080, 0x808080, 0x808080] as ColorStopSet : builtIn.colorOverlay.colorStops,
          mode: overlayMode,
        }
      : {
          alpha: clamp(intensity * (0.14 + blend * 0.18 + contamination * 0.22), 0, 0.65),
          color: 0x808080,
          colorStops: sampleEnvironment ? [0x808080, 0x808080, 0x808080, 0x808080] as ColorStopSet : undefined,
          mode: overlayMode,
        };

  return {
    adjustment: {
      brightness: 1 + (brightness - 1) * intensity,
      contrast: 1 + (contrast - 1) * intensity,
      saturation: 1 + (saturation - 1) * intensity,
      red: 1 + (red - 1) * intensity,
      green: 1 + (green - 1) * intensity,
      blue: 1 + (blue - 1) * intensity,
    },
    colorOverlay,
    environmentResponsive: semanticColor === null,
    environmentIntensity: intensity,
  };
}

function buildAccentEffect(scene: VisualTimelineScene | null, slotState: ResolvedCompositeSlotState | undefined, baseline?: SlotRecipeState): ObjectCompositeEffectSpec | null {
  const { recipeId, semantics } = resolveSlotRecipe(slotState, baseline);
  const recipe = recipeId || '';
  const intensity = recipeWeight(semantics);
  const builtIn = cloneBuiltInCompositeEffect(resolveCompositeRecipePayload(scene?.visual, 'accent', recipeId));
  if (!recipe && !semantics) return null;

  if (!builtIn.adjustment && !recipe.includes('accent') && !recipe.includes('pop') && !recipe.includes('highlight') && !semantics) {
    return null;
  }

  return {
    adjustment: {
      brightness: (builtIn.adjustment?.brightness ?? 1) + intensity * 0.05,
      contrast: (builtIn.adjustment?.contrast ?? 1) + intensity * 0.08,
      saturation: (builtIn.adjustment?.saturation ?? 1) + intensity * 0.06,
      red: builtIn.adjustment?.red ?? 1,
      green: builtIn.adjustment?.green ?? 1,
      blue: builtIn.adjustment?.blue ?? 1,
    },
  };
}

function buildDistortionEffect(scene: VisualTimelineScene | null, slotState: ResolvedCompositeSlotState | undefined, baseline?: SlotRecipeState): ObjectCompositeEffectSpec | null {
  const { recipeId, semantics } = resolveSlotRecipe(slotState, baseline);
  const recipe = recipeId || '';
  const intensity = recipeWeight(semantics);
  const bloom = clamp(typeof semantics?.bloom === 'number' ? semantics.bloom : 0, 0, 1.5);
  const builtIn = cloneBuiltInCompositeEffect(resolveCompositeRecipePayload(scene?.visual, 'distortion', recipeId));
  if (!recipe && !semantics) return null;

  if (
    !builtIn.blur &&
    !builtIn.rgbSplit &&
    !recipe.includes('distort') &&
    !recipe.includes('rgb') &&
    !recipe.includes('glitch') &&
    !recipe.includes('aberration') &&
    !recipe.includes('blur') &&
    bloom <= 0
  ) {
    return null;
  }

  return {
    blur: clamp((builtIn.blur ?? 0) + intensity * 1.5 + bloom * 2.5, 0, 5),
    rgbSplit: {
      x: clamp((builtIn.rgbSplit?.x ?? 0) + intensity * 0.8 + bloom * 0.8, 0, 3),
      y: clamp((builtIn.rgbSplit?.y ?? 0) + intensity * 0.3 + bloom * 0.3, 0, 1.2),
    },
  };
}

function mergeEffect(target: ObjectCompositeEffectSpec, addition: ObjectCompositeEffectSpec | null): void {
  if (!addition) return;

  if (addition.adjustment) {
    target.adjustment ??= {
      brightness: 1,
      contrast: 1,
      saturation: 1,
      red: 1,
      green: 1,
      blue: 1,
    };
    target.adjustment.brightness *= addition.adjustment.brightness;
    target.adjustment.contrast *= addition.adjustment.contrast;
    target.adjustment.saturation *= addition.adjustment.saturation;
    target.adjustment.red *= addition.adjustment.red;
    target.adjustment.green *= addition.adjustment.green;
    target.adjustment.blue *= addition.adjustment.blue;
  }

  if (addition.shadow) {
    target.shadow = addition.shadow;
  }
  if (addition.colorOverlay) {
    target.colorOverlay = addition.colorOverlay;
  }
  if (addition.blur !== undefined) {
    target.blur = Math.max(target.blur ?? 0, addition.blur);
  }
  if (addition.rgbSplit) {
    target.rgbSplit = {
      x: Math.max(target.rgbSplit?.x ?? 0, addition.rgbSplit.x),
      y: Math.max(target.rgbSplit?.y ?? 0, addition.rgbSplit.y),
    };
  }

  if (addition.environmentResponsive) {
    target.environmentResponsive = true;
    target.environmentIntensity = addition.environmentIntensity ?? 1;
  }
  if (addition.shadowResponsive) {
    target.shadowResponsive = true;
  }
}

function hasEffect(effect: ObjectCompositeEffectSpec): boolean {
  return Boolean(
    effect.shadow ||
    effect.colorOverlay ||
    effect.blur ||
    effect.rgbSplit ||
    effect.adjustment && (
      Math.abs(effect.adjustment.brightness - 1) > 0.001 ||
      Math.abs(effect.adjustment.contrast - 1) > 0.001 ||
      Math.abs(effect.adjustment.saturation - 1) > 0.001 ||
      Math.abs(effect.adjustment.red - 1) > 0.001 ||
      Math.abs(effect.adjustment.green - 1) > 0.001 ||
      Math.abs(effect.adjustment.blue - 1) > 0.001
    )
  );
}

function inferTargetType(scene: VisualTimelineScene, targetId: VisualTargetId): VisualTargetType | null {
  const registryType = scene.visual?.visualTargets?.[targetId]?.targetType;
  if (registryType) return registryType;
  if (targetId === 'background') return 'background';
  if (stageManager.getImageSprite(targetId)) return 'image-layer';
  if (textLayerManager.getLayerContainer(targetId)) return 'text-layer';
  if (live2DManager.hasCharacter(targetId)) return 'character';
  return null;
}

function resolveCompositeEffectForTarget(
  scene: VisualTimelineScene | null,
  targetState: ResolvedCompositeTargetState | undefined,
  baselineOverride?: Partial<Record<CompositeSlot, SlotRecipeState>>,
  sampleEnvironment = false,
): ObjectCompositeEffectSpec | null {
  const effect: ObjectCompositeEffectSpec = {};
  const baseline = targetState?.baseline ?? baselineOverride;

  mergeEffect(effect, buildGroundingEffect(scene, targetState?.slots.grounding, baseline?.grounding));
  mergeEffect(effect, buildIntegrationEffect(scene, targetState?.slots.integration, baseline?.integration, sampleEnvironment));
  mergeEffect(effect, buildAccentEffect(scene, targetState?.slots.accent, baseline?.accent));
  mergeEffect(effect, buildDistortionEffect(scene, targetState?.slots.distortion, baseline?.distortion));

  return hasEffect(effect) ? effect : null;
}

function commitFilters(displayObject: PIXI.Container, filters: PIXI.Filter[] | null): void {
  displayObject.filters = filters;
  if (displayObject instanceof PIXI.Container) {
    (displayObject as typeof displayObject & { _filtersDirty?: boolean })._filtersDirty = true;
  }
}

function markOwnedFilter<T extends PIXI.Filter>(filter: T): T {
  filter.resolution = 'inherit';
  (filter as CompositeFilter)[OWNED_FILTER] = true;
  return filter;
}

function syncAdjustmentFilter(filter: AdjustmentFilter, effect: NonNullable<ObjectCompositeEffectSpec['adjustment']>): void {
  filter.brightness = effect.brightness;
  filter.contrast = effect.contrast;
  filter.saturation = effect.saturation;
  filter.red = effect.red;
  filter.green = effect.green;
  filter.blue = effect.blue;
  filter.gamma = 1;
  filter.enabled = true;
}

function syncShadowFilter(filter: CharacterGroundingShadowFilter, effect: NonNullable<ObjectCompositeEffectSpec['shadow']>): void {
  filter.alpha = effect.alpha;
  filter.blur = effect.blur;
  filter.color = effect.color;
  filter.distance = effect.distance;
  filter.rotation = effect.rotation;
  filter.enabled = true;
}

function syncColorOverlayFilter(filter: EnvironmentColorBlendFilter, effect: NonNullable<ObjectCompositeEffectSpec['colorOverlay']>): void {
  filter.color = effect.color;
  filter.colorStops = effect.colorStops ? cloneColorStops(effect.colorStops) : null;
  filter.alpha = effect.alpha;
  filter.mode = effect.mode;
  filter.enabled = true;
}

function syncBlurFilter(filter: PIXI.BlurFilter, blurAmount: number): void {
  filter.blur = blurAmount;
  filter.enabled = true;
}

function syncRgbSplitFilter(filter: RGBSplitFilter, effect: NonNullable<ObjectCompositeEffectSpec['rgbSplit']>): void {
  filter.red = [effect.x, effect.y];
  filter.green = [0, 0];
  filter.blue = [-effect.x, -effect.y];
  filter.enabled = true;
}

function updateOwnedFilters(displayObject: PIXI.Container, effect: ObjectCompositeEffectSpec): void {
  const existingFilters = (displayObject.filters as PIXI.Filter[] | null) || [];
  const externalFilters = existingFilters.filter(filter => !(filter as CompositeFilter)[OWNED_FILTER]);
  const ownedFilters = existingFilters.filter(filter => Boolean((filter as CompositeFilter)[OWNED_FILTER]));
  const nextOwned: PIXI.Filter[] = [];

  const takeOwnedFilter = <T extends PIXI.Filter>(predicate: (filter: PIXI.Filter) => filter is T): T | null => {
    const index = ownedFilters.findIndex(predicate);
    if (index < 0) return null;
    return ownedFilters.splice(index, 1)[0] as T;
  };

  if (effect.adjustment) {
    const adjustment = takeOwnedFilter(
      (filter): filter is AdjustmentFilter => filter instanceof AdjustmentFilter,
    ) ?? markOwnedFilter(new AdjustmentFilter({
      brightness: 1,
      contrast: 1,
      saturation: 1,
      red: 1,
      green: 1,
      blue: 1,
      gamma: 1,
    }));
    syncAdjustmentFilter(adjustment, effect.adjustment);
    nextOwned.push(adjustment);
  }

  if (effect.shadow && effect.shadow.alpha > 0.01) {
    const shadow = takeOwnedFilter(
      (filter): filter is CharacterGroundingShadowFilter => filter instanceof CharacterGroundingShadowFilter,
    ) ?? markOwnedFilter(new CharacterGroundingShadowFilter({
      alpha: 0,
      blur: 0,
      color: 0x202734,
      distance: 0,
      rotation: 90,
    }));
    syncShadowFilter(shadow, effect.shadow);
    nextOwned.push(shadow);
  }

  if (effect.colorOverlay && effect.colorOverlay.alpha > 0.005) {
    const colorOverlay = takeOwnedFilter(
      (filter): filter is EnvironmentColorBlendFilter => filter instanceof EnvironmentColorBlendFilter,
    ) ?? markOwnedFilter(new EnvironmentColorBlendFilter(0xffffff, 0, 'soft-light'));
    syncColorOverlayFilter(colorOverlay, effect.colorOverlay);
    nextOwned.push(colorOverlay);
  }

  if (effect.blur && effect.blur > 0.01) {
    const blur = takeOwnedFilter(
      (filter): filter is PIXI.BlurFilter => filter instanceof PIXI.BlurFilter,
    ) ?? markOwnedFilter(new PIXI.BlurFilter());
    syncBlurFilter(blur, effect.blur);
    nextOwned.push(blur);
  }

  if (effect.rgbSplit && (effect.rgbSplit.x > 0.01 || effect.rgbSplit.y > 0.01)) {
    const rgbSplit = takeOwnedFilter(
      (filter): filter is RGBSplitFilter => filter instanceof RGBSplitFilter,
    ) ?? markOwnedFilter(new RGBSplitFilter({ red: [0, 0], green: [0, 0], blue: [0, 0] }));
    syncRgbSplitFilter(rgbSplit, effect.rgbSplit);
    nextOwned.push(rgbSplit);
  }

  commitFilters(displayObject, [...externalFilters, ...nextOwned].length > 0 ? [...externalFilters, ...nextOwned] : null);
}

function readCurrentEnvironmentProbe(displayObject: PIXI.Container | null): EnvironmentProbeSnapshot | null {
  const filters = (displayObject?.filters as PIXI.Filter[] | null) || [];
  const colorOverlay = filters.find(
    (filter): filter is EnvironmentColorBlendFilter => filter instanceof EnvironmentColorBlendFilter,
  );
  if (!colorOverlay) {
    return null;
  }

  const color = colorOverlay.color;
  const colorStops = colorOverlay.colorStops
    ? cloneColorStops(colorOverlay.colorStops)
    : [color, color, color, color] as ColorStopSet;
  const shadow = filters.find(
    (filter): filter is CharacterGroundingShadowFilter => filter instanceof CharacterGroundingShadowFilter,
  );
  const shadowColor = shadow?.color ?? mixColor(scaleColor(color, 0.34), 0x202734, 0.45);

  return {
    color,
    colorStops,
    luma: luminanceOfColor(color),
    saturation: saturationOfColor(color),
    shadowColor,
    shadowRotation: shadow?.rotation ?? 90,
  };
}

function applyEnvironmentProbeToEffect(
  effect: ObjectCompositeEffectSpec,
  probe: EnvironmentProbeSnapshot,
  override?: TargetEnvironmentOverride,
): ObjectCompositeEffectSpec {
  if (effect.colorOverlay && effect.environmentResponsive) {
    effect.colorOverlay.color = probe.color;
    effect.colorOverlay.colorStops = cloneColorStops(probe.colorStops);
    effect.colorOverlay.alpha = clamp(
      effect.colorOverlay.alpha * (1 + (override?.atmosphereBias ?? 0) * 0.15),
      0,
      0.65,
    );
  }

  if (effect.adjustment && effect.environmentResponsive) {
    const { r, g, b } = colorChannels(probe.color);
    const averageChannel = (r + g + b) / 3 || 1;
    const intensity = effect.environmentIntensity ?? 1;
    const channelInfluence = 0.05 * intensity;
    const exposureBias = clamp(override?.exposureBias ?? 0, -1, 1);
    effect.adjustment.brightness *= 1 + ((probe.luma - 0.5) * 0.07 + exposureBias * 0.08) * intensity;
    effect.adjustment.red *= 1 + ((r - averageChannel) / 255) * channelInfluence;
    effect.adjustment.green *= 1 + ((g - averageChannel) / 255) * channelInfluence;
    effect.adjustment.blue *= 1 + ((b - averageChannel) / 255) * channelInfluence;
  }

  if (effect.shadow && effect.shadowResponsive) {
    effect.shadow.color = probe.shadowColor;
    effect.shadow.rotation = probe.shadowRotation;
    effect.shadow.alpha = clamp(
      effect.shadow.alpha * (0.9 + (1 - probe.luma) * 0.18 + (override?.atmosphereBias ?? 0) * 0.06),
      0,
      0.58,
    );
  }

  return effect;
}

class ObjectCompositeRuntimeController {
  private appliedKeys = new Map<VisualTargetId, string | null>();
  private readonly environmentProbe = new ObjectCompositeEnvironmentProbe(
    (targetId) => readCurrentEnvironmentProbe(this.getTargetDisplayObject(targetId, 'character')),
  );

  setSamplingMode(mode: EnvironmentSamplingMode): void {
    this.environmentProbe.setSamplingMode(mode);
  }

  invalidateEnvironmentSamples(targetId?: VisualTargetId, options?: { snapToSample?: boolean }): void {
    this.environmentProbe.invalidate(targetId, options);
  }

  clearAll(scene?: VisualTimelineScene | null): void {
    for (const targetId of this.appliedKeys.keys()) {
      this.clearTarget(scene ?? null, targetId);
    }
    this.appliedKeys.clear();
    this.invalidateEnvironmentSamples();
  }

  apply(scene: VisualTimelineScene | null, state: ResolvedVisualState | null, time?: number): void {
    if (!scene || !state) {
      this.clearAll(scene);
      return;
    }

    const resolvedTime = typeof time === 'number' && Number.isFinite(time)
      ? time
      : Date.now() / 1000;

    const targetIds = new Set<VisualTargetId>([
      ...Object.keys(scene.visual?.visualTargets || {}),
      ...Object.keys(state.compositeTargets || {}),
    ]);

    const nextKeys = new Map<VisualTargetId, string | null>();

    for (const targetId of targetIds) {
      const targetType = inferTargetType(scene, targetId);
      const visualRecord = scene.visual?.visualTargets?.[targetId];
      if (!targetType || targetType === 'environment-layer') {
        nextKeys.set(targetId, null);
        this.clearTarget(scene, targetId);
        continue;
      }
      if (targetType === 'character' && !live2DManager.canApplyContainerFilters(targetId)) {
        nextKeys.set(targetId, this.appliedKeys.get(targetId) ?? null);
        continue;
      }

      let effect = resolveCompositeEffectForTarget(
        scene,
        state.compositeTargets[targetId],
        visualRecord?.objectCompositeBaseline,
        targetType === 'character',
      );
      if (effect && targetType === 'character') {
        effect = this.applyResponsiveEnvironment(targetId, effect, visualRecord, resolvedTime);
      }
      const nextKey = effect ? JSON.stringify({ targetType, effect }) : null;
      nextKeys.set(targetId, nextKey);

      if (!nextKey) {
        this.clearTarget(scene, targetId);
        continue;
      }

      if (this.appliedKeys.get(targetId) === nextKey && this.targetHasOwnedFilters(targetId, targetType)) continue;
      this.applyTarget(targetId, targetType, effect!);
    }

    for (const targetId of this.appliedKeys.keys()) {
      if (!nextKeys.has(targetId)) {
        this.clearTarget(scene, targetId);
      }
    }

    this.appliedKeys = nextKeys;
  }

  private getTargetDisplayObject(targetId: VisualTargetId, targetType: VisualTargetType): PIXI.Container | null {
    switch (targetType) {
      case 'background':
        return (
          stageManager.getEnvironmentLayerDisplayObject?.(BACKGROUND_LAYER_ID) ||
          stageManager.getBackgroundSprite?.() ||
          stageManager.getLayer('background')
        );
      case 'character':
        return live2DManager.hasCharacter(targetId) ? live2DManager.getContainer(targetId) : null;
      case 'image-layer':
        return stageManager.getImageSprite(targetId);
      case 'text-layer':
        return textLayerManager.getLayerContainer(targetId);
      default:
        return null;
    }
  }

  private applyResponsiveEnvironment(
    targetId: VisualTargetId,
    effect: ObjectCompositeEffectSpec,
    visualRecord: VisualTargetRecord | undefined,
    time: number,
  ): ObjectCompositeEffectSpec {
    if (!effect.environmentResponsive && !effect.shadowResponsive) return effect;
    const override = visualRecord?.targetEnvironmentOverride;
    const probe = this.environmentProbe.sample(targetId, time, override);
    return probe ? applyEnvironmentProbeToEffect(effect, probe, override) : effect;
  }

  private applyTarget(targetId: VisualTargetId, targetType: VisualTargetType, effect: ObjectCompositeEffectSpec): void {
    const displayObject = this.getTargetDisplayObject(targetId, targetType);
    if (!displayObject) return;
    updateOwnedFilters(displayObject, effect);
  }

  private targetHasOwnedFilters(targetId: VisualTargetId, targetType: VisualTargetType): boolean {
    const displayObject = this.getTargetDisplayObject(targetId, targetType);
    return Boolean(
      ((displayObject?.filters as PIXI.Filter[] | null) || []).some(filter => Boolean((filter as CompositeFilter)[OWNED_FILTER])),
    );
  }

  private clearTarget(scene: VisualTimelineScene | null, targetId: VisualTargetId): void {
    const targetType = scene ? inferTargetType(scene, targetId) : null;
    if (!targetType) return;
    const displayObject = this.getTargetDisplayObject(targetId, targetType);
    if (!displayObject) return;
    const remaining = ((displayObject.filters as PIXI.Filter[] | null) || []).filter(filter => !(filter as CompositeFilter)[OWNED_FILTER]);
    commitFilters(displayObject, remaining.length > 0 ? remaining : null);
  }
}

export const objectCompositeRuntimeController = new ObjectCompositeRuntimeController();
