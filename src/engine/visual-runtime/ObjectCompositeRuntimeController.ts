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
import { BACKGROUND_LAYER_ID, STAGE_HEIGHT, STAGE_WIDTH } from '../environmentLayerModel';
import { DEFAULT_FOCAL_LENGTH } from '../Projection';
import { resolveVec2 } from '../utils/math';
import { PIXI_V8_FILTER_VERTEX } from '../PixiV8Filter';
import { BLEND_MODE_SHADER_GLSL, BLEND_MODE_SHADER_INDEX } from './blendModeShader';

interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

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
type ColorStopSet = [number, number, number, number];
type EnvironmentSamplingMode = 'interactive' | 'export';
const INTERACTIVE_PROBE_SMOOTH_DT_CAP_SECONDS = 1 / 24;
const INITIAL_PROBE_SMOOTH_DT_SECONDS = 1 / 120;
const EXPORT_PROBE_SMOOTH_DT_SECONDS = 1 / 60;
const PROBE_SMOOTH_STEP_SECONDS = 1 / 60;
const BACKWARD_TIME_EPSILON_SECONDS = 1 / 120;

interface EnvironmentProbeSnapshot {
  color: number;
  colorStops: ColorStopSet;
  luma: number;
  saturation: number;
  shadowColor: number;
  shadowRotation: number;
}

interface EnvironmentProbeState {
  smoothingRemainder: number;
  raw: EnvironmentProbeSnapshot | null;
  display: EnvironmentProbeSnapshot | null;
  lastAppliedTime: number | null;
  lastSampleTime: number;
  lastSampleKey: string | null;
}

interface BackgroundProbeCache {
  data: Uint8ClampedArray | null;
  width: number;
  height: number;
  lastSampleTime: number;
  lastSampleKey: string | null;
  lastCompositionKey: string | null;
  lastObservedBounds: RectLike | null;
  coordinateSpace: 'screen' | 'background-local';
}

interface EnvironmentLayerProxySnapshot {
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
  z?: number;
}

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseColor(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clamp(Math.round(value), 0x000000, 0xffffff);
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return null;
  return parseInt(normalized, 16);
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

function averageColor(stops: ColorStopSet): number {
  const channels = stops.reduce(
    (sum, color) => {
      sum.r += (color >> 16) & 0xff;
      sum.g += (color >> 8) & 0xff;
      sum.b += color & 0xff;
      return sum;
    },
    { r: 0, g: 0, b: 0 },
  );
  const r = Math.round(channels.r / stops.length);
  const g = Math.round(channels.g / stops.length);
  const b = Math.round(channels.b / stops.length);
  return (r << 16) | (g << 8) | b;
}

function colorChannels(value: number): { r: number; g: number; b: number } {
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

function packColor(r: number, g: number, b: number): number {
  return (clamp(Math.round(r), 0, 255) << 16)
    | (clamp(Math.round(g), 0, 255) << 8)
    | clamp(Math.round(b), 0, 255);
}

function mixColor(a: number, b: number, alpha: number): number {
  const mixAmount = clamp(alpha, 0, 1);
  const ca = colorChannels(a);
  const cb = colorChannels(b);
  return packColor(
    ca.r + (cb.r - ca.r) * mixAmount,
    ca.g + (cb.g - ca.g) * mixAmount,
    ca.b + (cb.b - ca.b) * mixAmount,
  );
}

function scaleColor(value: number, factor: number): number {
  const { r, g, b } = colorChannels(value);
  return packColor(r * factor, g * factor, b * factor);
}

function saturateColor(value: number, saturationDelta: number): number {
  const amount = clamp(saturationDelta, -1, 1);
  const { r, g, b } = colorChannels(value);
  const avg = (r + g + b) / 3;
  return packColor(
    avg + (r - avg) * (1 + amount),
    avg + (g - avg) * (1 + amount),
    avg + (b - avg) * (1 + amount),
  );
}

function luminanceOfColor(value: number): number {
  const { r, g, b } = colorChannels(value);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function saturationOfColor(value: number): number {
  const { r, g, b } = colorChannels(value);
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  return max <= 0 ? 0 : (max - min) / max;
}

function cloneColorStops(stops: ColorStopSet): ColorStopSet {
  return [stops[0], stops[1], stops[2], stops[3]];
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
    (displayObject as any)._filtersDirty = true;
  }
}

function markOwnedFilter<T extends PIXI.Filter>(filter: T): T {
  (filter as any)[OWNED_FILTER] = true;
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
  const externalFilters = existingFilters.filter(filter => !(filter as any)[OWNED_FILTER]);
  const ownedFilters = existingFilters.filter(filter => Boolean((filter as any)[OWNED_FILTER]));
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

function getDisplayBounds(displayObject: PIXI.Container | null): RectLike | null {
  if (!displayObject || typeof (displayObject as any).getBounds !== 'function') return null;
  try {
    return (displayObject as any).getBounds() as RectLike;
  } catch {
    return null;
  }
}

function getEffectiveEnvironmentZ(backgroundTarget: PIXI.Container): number {
  const parentZ = Number((backgroundTarget.parent as any)?.zIndex);
  if (Number.isFinite(parentZ)) return parentZ;
  const ownZ = Number((backgroundTarget as any).zIndex);
  return Number.isFinite(ownZ) ? ownZ : 0;
}

function getCameraNeutralDisplayOrigin(
  backgroundTarget: PIXI.Container,
  camera?: { position: any; zoom: number } | null,
): { x: number; y: number; scaleX: number; scaleY: number; rotation: number } | null {
  const zoom = camera && Number.isFinite(camera.zoom) && camera.zoom > 0 ? camera.zoom : 1;
  let x = Number((backgroundTarget as any).x);
  let y = Number((backgroundTarget as any).y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  if (camera) {
    const position = resolveVec2(camera.position);
    const parallax = 1 + getEffectiveEnvironmentZ(backgroundTarget) / DEFAULT_FOCAL_LENGTH;
    const halfW = STAGE_WIDTH / 2;
    const halfH = STAGE_HEIGHT / 2;
    const worldX = halfW + (x - halfW) / zoom;
    const worldY = halfH + (y - halfH) / zoom;
    x = worldX - (0.5 - position.x) * STAGE_WIDTH * parallax;
    y = worldY - (0.5 - position.y) * STAGE_HEIGHT * parallax;
  }

  const scale = (backgroundTarget as any).scale;
  const scaleX = Number(scale?.x ?? 1) / zoom;
  const scaleY = Number(scale?.y ?? 1) / zoom;
  const rotation = Number((backgroundTarget as any).rotation ?? 0);
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || Math.abs(scaleX) <= 0.0001 || Math.abs(scaleY) <= 0.0001) {
    return null;
  }

  return {
    x,
    y,
    scaleX,
    scaleY,
    rotation: Number.isFinite(rotation) ? rotation : 0,
  };
}

function getCameraNeutralBackgroundLocalPoint(
  backgroundTarget: PIXI.Container,
  worldX: number,
  worldY: number,
  camera?: { position: any; zoom: number } | null,
): PIXI.Point | null {
  const origin = getCameraNeutralDisplayOrigin(backgroundTarget, camera);
  if (!origin) return null;

  const dx = worldX - origin.x;
  const dy = worldY - origin.y;
  const cos = Math.cos(origin.rotation);
  const sin = Math.sin(origin.rotation);
  const localX = (dx * cos + dy * sin) / origin.scaleX;
  const localY = (-dx * sin + dy * cos) / origin.scaleY;
  if (!Number.isFinite(localX) || !Number.isFinite(localY)) {
    return null;
  }
  return new PIXI.Point(localX, localY);
}

function normalizeEnvironmentProxyX(value: number): number {
  return Math.abs(value) <= 2 ? value * STAGE_WIDTH : value;
}

function normalizeEnvironmentProxyY(value: number): number {
  return Math.abs(value) <= 2 ? value * STAGE_HEIGHT : value;
}

function getProxyAnchoredBackgroundLocalPoint(
  worldX: number,
  worldY: number,
  proxy: EnvironmentLayerProxySnapshot,
  backgroundLocalBounds: RectLike,
): PIXI.Point | null {
  const proxyX = Number(proxy.x ?? 0.5);
  const proxyY = Number(proxy.y ?? 0.5);
  const proxyScale = Number(proxy.scale ?? 1);
  const proxyRotation = Number(proxy.rotation ?? 0);
  if (
    !Number.isFinite(proxyX) ||
    !Number.isFinite(proxyY) ||
    !Number.isFinite(proxyScale) ||
    !Number.isFinite(proxyRotation) ||
    Math.abs(proxyScale) <= 0.0001 ||
    backgroundLocalBounds.width <= 0 ||
    backgroundLocalBounds.height <= 0
  ) {
    return null;
  }

  const baseScale = Math.max(
    STAGE_WIDTH / Math.max(1, backgroundLocalBounds.width),
    STAGE_HEIGHT / Math.max(1, backgroundLocalBounds.height),
  );
  const scale = baseScale * proxyScale;
  if (!Number.isFinite(scale) || Math.abs(scale) <= 0.0001) {
    return null;
  }

  const dx = worldX - normalizeEnvironmentProxyX(proxyX);
  const dy = worldY - normalizeEnvironmentProxyY(proxyY);
  const radians = (proxyRotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const localX = (dx * cos + dy * sin) / scale;
  const localY = (-dx * sin + dy * cos) / scale;
  if (!Number.isFinite(localX) || !Number.isFinite(localY)) {
    return null;
  }
  return new PIXI.Point(localX, localY);
}

function getBackgroundLocalBounds(backgroundTarget: PIXI.Container): RectLike | null {
  if (typeof (backgroundTarget as any).getLocalBounds !== 'function') return null;
  try {
    return (backgroundTarget as any).getLocalBounds() as RectLike;
  } catch {
    return null;
  }
}

function getCanvasImageSourceDimensions(
  source: CanvasImageSource | null | undefined,
): { width: number; height: number } | null {
  if (!source) return null;
  const candidate = source as {
    width?: number;
    height?: number;
    videoWidth?: number;
    videoHeight?: number;
    naturalWidth?: number;
    naturalHeight?: number;
  };
  const width = candidate.videoWidth ?? candidate.naturalWidth ?? candidate.width ?? 0;
  const height = candidate.videoHeight ?? candidate.naturalHeight ?? candidate.height ?? 0;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

interface TextureSourceRevision {
  value: number;
}

// PixiJS 8 exposes texture updates as events rather than a stable dirty counter.
const textureSourceRevisions = new WeakMap<object, TextureSourceRevision>();

function getTextureSourceRevision(source: unknown): number {
  if (!source || typeof source !== 'object') return 0;

  let revision = textureSourceRevisions.get(source);
  if (!revision) {
    revision = { value: 0 };
    textureSourceRevisions.set(source, revision);
    const eventSource = source as {
      on?: (event: string, listener: () => void) => unknown;
    };
    if (typeof eventSource.on === 'function') {
      const markUpdated = () => { revision!.value += 1; };
      eventSource.on('update', markUpdated);
    }
  }

  return revision.value;
}

function getBackgroundLocalProbeSource(
  backgroundTarget: PIXI.Container | null,
): { source: CanvasImageSource; width: number; height: number; sampleKey: string } | null {
  if (!backgroundTarget || backgroundTarget instanceof PIXI.TilingSprite) {
    return null;
  }

  const texture = (backgroundTarget as any).texture as PIXI.Texture | undefined;
  if (!texture) return null;

  const textureSource = (texture as any).source;
  const baseTexture = (texture as any).baseTexture;
  const source = (
    baseTexture?.resource?.source ||
    textureSource?.resource?.source ||
    textureSource?.resource ||
    (texture as any).resource?.source ||
    baseTexture?.realSource ||
    textureSource
  ) as CanvasImageSource | null | undefined;
  const dimensions = getCanvasImageSourceDimensions(source);
  if (!source || !dimensions) {
    return null;
  }

  const imageKey = (backgroundTarget as any).__imageKey
    ?? (texture as any).textureCacheIds?.[0]
    ?? baseTexture?.uid
    ?? textureSource?.uid
    ?? `${dimensions.width}x${dimensions.height}`;
  const videoTime = typeof (source as HTMLVideoElement).currentTime === 'number'
    ? (source as HTMLVideoElement).currentTime
    : '';
  const sourceRevision = [
    baseTexture?.uid ?? '',
    textureSource?.uid ?? '',
    baseTexture?.dirtyId ?? '',
    textureSource?.dirtyId ?? '',
    textureSource?._resourceId ?? '',
    getTextureSourceRevision(baseTexture),
    getTextureSourceRevision(textureSource),
    videoTime,
  ].join(':');

  return {
    source,
    width: dimensions.width,
    height: dimensions.height,
    sampleKey: `local:${String(imageKey)}:${dimensions.width}x${dimensions.height}:${sourceRevision}`,
  };
}

function getBackgroundStableProbeKey(backgroundTarget: PIXI.Container | null): string {
  const localSource = getBackgroundLocalProbeSource(backgroundTarget);
  if (localSource) {
    return localSource.sampleKey;
  }
  if (!backgroundTarget) {
    return 'background:none';
  }

  const texture = (backgroundTarget as any).texture as PIXI.Texture | undefined;
  const baseTexture = (texture as any)?.baseTexture;
  const source = (
    baseTexture?.resource?.source ||
    (texture as any)?.resource?.source ||
    baseTexture?.realSource ||
    (texture as any)?.source
  ) as CanvasImageSource | null | undefined;
  const dimensions = getCanvasImageSourceDimensions(source);
  const imageKey = (backgroundTarget as any).__imageKey
    ?? (texture as any)?.textureCacheIds?.[0]
    ?? baseTexture?.uid
    ?? (backgroundTarget as any).name
    ?? backgroundTarget.constructor?.name
    ?? 'unknown';
  const layoutMode = (backgroundTarget as any).__layoutMode ?? 'cover';
  const sizeKey = dimensions ? `${dimensions.width}x${dimensions.height}` : 'unknown-size';
  return `background:${String(imageKey)}:${String(layoutMode)}:${sizeKey}`;
}

function getDisplayCompositionKey(root: PIXI.Container): string {
  const parts: string[] = [];
  const visit = (displayObject: any) => {
    const scale = displayObject.scale;
    const pivot = displayObject.pivot;
    const anchor = displayObject.anchor;
    const tilePosition = displayObject.tilePosition;
    const tileScale = displayObject.tileScale;
    parts.push([
      displayObject.constructor?.name ?? '',
      displayObject.visible === false ? 0 : 1,
      displayObject.renderable === false ? 0 : 1,
      displayObject.alpha ?? 1,
      displayObject.x ?? 0,
      displayObject.y ?? 0,
      displayObject.rotation ?? 0,
      scale?.x ?? 1,
      scale?.y ?? 1,
      pivot?.x ?? 0,
      pivot?.y ?? 0,
      anchor?.x ?? 0,
      anchor?.y ?? 0,
      tilePosition?.x ?? 0,
      tilePosition?.y ?? 0,
      tileScale?.x ?? 1,
      tileScale?.y ?? 1,
      displayObject.zIndex ?? 0,
      displayObject.__imageKey ?? '',
      displayObject.__baseAlpha ?? 1,
      displayObject.__transitionAlpha ?? 1,
    ].join(','));
    for (const child of displayObject.children ?? []) visit(child);
  };
  visit(root);
  return parts.join(';');
}

function environmentProbesEqual(
  left: EnvironmentProbeSnapshot | null,
  right: EnvironmentProbeSnapshot,
): boolean {
  return Boolean(left)
    && left!.color === right.color
    && left!.luma === right.luma
    && left!.saturation === right.saturation
    && left!.shadowColor === right.shadowColor
    && left!.shadowRotation === right.shadowRotation
    && left!.colorStops.every((color, index) => color === right.colorStops[index]);
}

function getEffectEnvironmentKey(effect: ObjectCompositeEffectSpec): string {
  return JSON.stringify({
    responsive: Boolean(effect.environmentResponsive),
    shadowResponsive: Boolean(effect.shadowResponsive),
    overlayMode: effect.colorOverlay?.mode ?? null,
  });
}

// Probe just outside the stable character bounds; animation must not move the sampling frame.
function createProbeSamplePoints(bounds: RectLike): PIXI.Point[] {
  const sampleBounds = new PIXI.Rectangle(
    bounds.x - bounds.width * 0.08,
    bounds.y - bounds.height * 0.08,
    Math.max(2, bounds.width * 1.16),
    Math.max(2, bounds.height * 1.16),
  );
  return [
    new PIXI.Point(sampleBounds.x, sampleBounds.y),
    new PIXI.Point(sampleBounds.x + sampleBounds.width, sampleBounds.y),
    new PIXI.Point(sampleBounds.x, sampleBounds.y + sampleBounds.height),
    new PIXI.Point(sampleBounds.x + sampleBounds.width, sampleBounds.y + sampleBounds.height),
    new PIXI.Point(sampleBounds.x + sampleBounds.width * 0.5, sampleBounds.y + sampleBounds.height * 0.5),
  ];
}

function buildLocalRegionFromPoints(
  localPoints: PIXI.Point[],
  backgroundLocalBounds: RectLike,
): PIXI.Rectangle | null {
  if (localPoints.length === 0) {
    return null;
  }

  const minX = Math.min(...localPoints.map(point => point.x));
  const maxX = Math.max(...localPoints.map(point => point.x));
  const minY = Math.min(...localPoints.map(point => point.y));
  const maxY = Math.max(...localPoints.map(point => point.y));
  const clampedMinX = clamp(minX, backgroundLocalBounds.x, backgroundLocalBounds.x + backgroundLocalBounds.width);
  const clampedMaxX = clamp(maxX, backgroundLocalBounds.x, backgroundLocalBounds.x + backgroundLocalBounds.width);
  const clampedMinY = clamp(minY, backgroundLocalBounds.y, backgroundLocalBounds.y + backgroundLocalBounds.height);
  const clampedMaxY = clamp(maxY, backgroundLocalBounds.y, backgroundLocalBounds.y + backgroundLocalBounds.height);

  if (clampedMaxX - clampedMinX < 0.5 || clampedMaxY - clampedMinY < 0.5) {
    return null;
  }

  return new PIXI.Rectangle(
    clampedMinX,
    clampedMinY,
    clampedMaxX - clampedMinX,
    clampedMaxY - clampedMinY,
  );
}

function mapWorldBoundsToBackgroundLocalRegion(
  backgroundTarget: PIXI.Container,
  worldBounds: RectLike,
  backgroundLocalBounds: RectLike,
  environmentProxy?: EnvironmentLayerProxySnapshot | null,
  camera?: { position: any; zoom: number } | null,
): PIXI.Rectangle | null {
  if (backgroundLocalBounds.width <= 0 || backgroundLocalBounds.height <= 0) {
    return null;
  }

  const localPoints = createProbeSamplePoints(worldBounds)
    .map(point => (
      environmentProxy
        ? getProxyAnchoredBackgroundLocalPoint(point.x, point.y, environmentProxy, backgroundLocalBounds)
        : getCameraNeutralBackgroundLocalPoint(backgroundTarget, point.x, point.y, camera)
    ))
    .filter((point): point is PIXI.Point => Boolean(point));
  return buildLocalRegionFromPoints(localPoints, backgroundLocalBounds);
}

function cloneBounds(bounds: RectLike | null): PIXI.Rectangle | null {
  if (!bounds) return null;
  return new PIXI.Rectangle(bounds.x, bounds.y, bounds.width, bounds.height);
}

function computeBoundsMotionScore(previous: RectLike | null, next: RectLike | null): number {
  if (!previous || !next) return 0;
  return Math.max(
    Math.abs(previous.x - next.x),
    Math.abs(previous.y - next.y),
    Math.abs(previous.width - next.width),
    Math.abs(previous.height - next.height),
  );
}

function adjustEnvironmentColor(color: number, override?: TargetEnvironmentOverride): number {
  let next = color;
  if (override?.environmentColor) {
    const parsed = parseColor(override.environmentColor);
    if (parsed !== null) {
      next = parsed;
    }
  }
  if (typeof override?.warmthBias === 'number' && Math.abs(override.warmthBias) > 0.001) {
    const warmth = clamp(override.warmthBias, -1, 1);
    const warmTarget = warmth >= 0 ? 0xd6a374 : 0x7aa8d8;
    next = mixColor(next, warmTarget, Math.abs(warmth) * 0.22);
    next = saturateColor(next, warmth * 0.08);
  }
  if (typeof override?.exposureBias === 'number' && Math.abs(override.exposureBias) > 0.001) {
    next = scaleColor(next, 1 + clamp(override.exposureBias, -1, 1) * 0.18);
  }
  return next;
}

function resolveShadowRotation(probeRotation: number, override?: TargetEnvironmentOverride): number {
  switch (override?.primaryLightDirection) {
    case 'left':
      return 118;
    case 'right':
      return 62;
    case 'center':
      return 90;
    case 'mixed':
      return 90;
    default:
      return probeRotation;
  }
}

function createFallbackProbe(baseColor: number, override?: TargetEnvironmentOverride): EnvironmentProbeSnapshot {
  const adjustedColor = adjustEnvironmentColor(baseColor, override);
  const shadowBase = mixColor(scaleColor(adjustedColor, 0.34), 0x202734, 0.45);
  return {
    color: adjustedColor,
    colorStops: [adjustedColor, adjustedColor, adjustedColor, adjustedColor],
    luma: luminanceOfColor(adjustedColor),
    saturation: saturationOfColor(adjustedColor),
    shadowColor: shadowBase,
    shadowRotation: resolveShadowRotation(90, override),
  };
}

function sampleBilinearColor(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const clampedX = clamp(x, 0, Math.max(0, width - 1));
  const clampedY = clamp(y, 0, Math.max(0, height - 1));
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = clampedX - x0;
  const ty = clampedY - y0;

  const sample = (sx: number, sy: number) => {
    const index = (sy * width + sx) * 4;
    return {
      r: data[index],
      g: data[index + 1],
      b: data[index + 2],
      a: data[index + 3] / 255,
    };
  };

  const c00 = sample(x0, y0);
  const c10 = sample(x1, y0);
  const c01 = sample(x0, y1);
  const c11 = sample(x1, y1);

  const interpolate = (v00: number, v10: number, v01: number, v11: number) => {
    const top = v00 + (v10 - v00) * tx;
    const bottom = v01 + (v11 - v01) * tx;
    return top + (bottom - top) * ty;
  };

  const alpha = interpolate(c00.a, c10.a, c01.a, c11.a);
  if (alpha <= 0.001) {
    return 0x808080;
  }

  return packColor(
    interpolate(c00.r, c10.r, c01.r, c11.r),
    interpolate(c00.g, c10.g, c01.g, c11.g),
    interpolate(c00.b, c10.b, c01.b, c11.b),
  );
}

function sampleKernelAverageColor(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
): number {
  const offsets = [-1, 0, 1];
  let totalWeight = 0;
  let r = 0;
  let g = 0;
  let b = 0;

  for (const oy of offsets) {
    for (const ox of offsets) {
      const weight = (ox === 0 ? 1.4 : 0.8) * (oy === 0 ? 1.4 : 0.8);
      const color = sampleBilinearColor(
        data,
        width,
        height,
        centerX + ox * radiusX,
        centerY + oy * radiusY,
      );
      const channels = colorChannels(color);
      totalWeight += weight;
      r += channels.r * weight;
      g += channels.g * weight;
      b += channels.b * weight;
    }
  }

  if (totalWeight <= 0.001) {
    return 0x808080;
  }
  return packColor(r / totalWeight, g / totalWeight, b / totalWeight);
}

function inferContinuousShadowRotation(topLeft: number, topRight: number, bottomLeft: number, bottomRight: number): number {
  const leftLuma = (luminanceOfColor(topLeft) + luminanceOfColor(bottomLeft)) / 2;
  const rightLuma = (luminanceOfColor(topRight) + luminanceOfColor(bottomRight)) / 2;
  const lumaDelta = leftLuma - rightLuma;
  return 90 + clamp(lumaDelta * 140, -28, 28);
}

function buildProbeFromImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  override?: TargetEnvironmentOverride,
): EnvironmentProbeSnapshot {
  const radiusX = Math.max(1, width * 0.09);
  const radiusY = Math.max(1, height * 0.09);
  const topLeft = adjustEnvironmentColor(sampleKernelAverageColor(data, width, height, width * 0.28, height * 0.28, radiusX, radiusY), override);
  const topRight = adjustEnvironmentColor(sampleKernelAverageColor(data, width, height, width * 0.72, height * 0.28, radiusX, radiusY), override);
  const bottomLeft = adjustEnvironmentColor(sampleKernelAverageColor(data, width, height, width * 0.28, height * 0.72, radiusX, radiusY), override);
  const bottomRight = adjustEnvironmentColor(sampleKernelAverageColor(data, width, height, width * 0.72, height * 0.72, radiusX, radiusY), override);
  const colorStops: ColorStopSet = [topLeft, topRight, bottomLeft, bottomRight];
  const average = averageColor(colorStops);
  const inferredRotation = inferContinuousShadowRotation(topLeft, topRight, bottomLeft, bottomRight);
  const darkness = 0.28 + (1 - luminanceOfColor(average)) * 0.2;
  const shadowColor = mixColor(scaleColor(average, darkness), 0x202734, 0.42);

  return {
    color: average,
    colorStops,
    luma: luminanceOfColor(average),
    saturation: saturationOfColor(average),
    shadowColor,
    shadowRotation: resolveShadowRotation(inferredRotation, override),
  };
}

function buildProbeFromRegion(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  xStart: number,
  xEnd: number,
  yStart: number,
  yEnd: number,
  override?: TargetEnvironmentOverride,
): EnvironmentProbeSnapshot {
  const safeXStart = clamp(xStart, 0, Math.max(0, width - 1));
  const safeXEnd = clamp(xEnd, safeXStart + 1, width);
  const safeYStart = clamp(yStart, 0, Math.max(0, height - 1));
  const safeYEnd = clamp(yEnd, safeYStart + 1, height);
  const sampleX = (t: number) => safeXStart + (safeXEnd - safeXStart) * t;
  const sampleY = (t: number) => safeYStart + (safeYEnd - safeYStart) * t;
  const radiusX = Math.max(0.8, (safeXEnd - safeXStart) * 0.08);
  const radiusY = Math.max(0.8, (safeYEnd - safeYStart) * 0.08);
  const topLeft = adjustEnvironmentColor(sampleKernelAverageColor(data, width, height, sampleX(0), sampleY(0), radiusX, radiusY), override);
  const topRight = adjustEnvironmentColor(sampleKernelAverageColor(data, width, height, sampleX(1), sampleY(0), radiusX, radiusY), override);
  const bottomLeft = adjustEnvironmentColor(sampleKernelAverageColor(data, width, height, sampleX(0), sampleY(1), radiusX, radiusY), override);
  const bottomRight = adjustEnvironmentColor(sampleKernelAverageColor(data, width, height, sampleX(1), sampleY(1), radiusX, radiusY), override);
  const colorStops: ColorStopSet = [topLeft, topRight, bottomLeft, bottomRight];
  const average = averageColor(colorStops);
  const inferredRotation = inferContinuousShadowRotation(topLeft, topRight, bottomLeft, bottomRight);
  const darkness = 0.28 + (1 - luminanceOfColor(average)) * 0.2;
  const shadowColor = mixColor(scaleColor(average, darkness), 0x202734, 0.42);

  return {
    color: average,
    colorStops,
    luma: luminanceOfColor(average),
    saturation: saturationOfColor(average),
    shadowColor,
    shadowRotation: resolveShadowRotation(inferredRotation, override),
  };
}

function cloneProbeSnapshot(snapshot: EnvironmentProbeSnapshot): EnvironmentProbeSnapshot {
  return {
    color: snapshot.color,
    colorStops: cloneColorStops(snapshot.colorStops),
    luma: snapshot.luma,
    saturation: snapshot.saturation,
    shadowColor: snapshot.shadowColor,
    shadowRotation: snapshot.shadowRotation,
  };
}

function applyTargetOverrideToProbe(
  probe: EnvironmentProbeSnapshot,
  override?: TargetEnvironmentOverride,
): EnvironmentProbeSnapshot {
  if (!override) {
    return cloneProbeSnapshot(probe);
  }

  const colorStops = probe.colorStops.map((color) => adjustEnvironmentColor(color, override)) as ColorStopSet;
  const color = adjustEnvironmentColor(probe.color, override);
  const shadowRotation = resolveShadowRotation(probe.shadowRotation, override);
  const darkness = 0.28 + (1 - luminanceOfColor(color)) * 0.2;
  const shadowColor = mixColor(scaleColor(color, darkness), 0x202734, 0.42);

  return {
    color,
    colorStops,
    luma: luminanceOfColor(color),
    saturation: saturationOfColor(color),
    shadowColor,
    shadowRotation,
  };
}

function moveTowards(value: number, target: number, maxDelta: number): number {
  if (target > value) return Math.min(target, value + maxDelta);
  return Math.max(target, value - maxDelta);
}

function moveColorTowards(current: number, target: number, maxChannelDelta: number): number {
  const a = colorChannels(current);
  const b = colorChannels(target);
  return packColor(
    moveTowards(a.r, b.r, maxChannelDelta),
    moveTowards(a.g, b.g, maxChannelDelta),
    moveTowards(a.b, b.b, maxChannelDelta),
  );
}

function smoothProbeSnapshot(from: EnvironmentProbeSnapshot, to: EnvironmentProbeSnapshot, deltaTime: number): EnvironmentProbeSnapshot {
  const dt = Math.max(deltaTime, 0);
  const maxColorStep = 52 * dt;
  const maxLumaStep = 0.22 * dt;
  const maxSaturationStep = 0.32 * dt;
  const maxRotationStep = 42 * dt;

  return {
    color: moveColorTowards(from.color, to.color, maxColorStep),
    colorStops: [
      moveColorTowards(from.colorStops[0], to.colorStops[0], maxColorStep),
      moveColorTowards(from.colorStops[1], to.colorStops[1], maxColorStep),
      moveColorTowards(from.colorStops[2], to.colorStops[2], maxColorStep),
      moveColorTowards(from.colorStops[3], to.colorStops[3], maxColorStep),
    ],
    luma: moveTowards(from.luma, to.luma, maxLumaStep),
    saturation: moveTowards(from.saturation, to.saturation, maxSaturationStep),
    shadowColor: moveColorTowards(from.shadowColor, to.shadowColor, maxColorStep * 0.75),
    shadowRotation: moveTowards(from.shadowRotation, to.shadowRotation, maxRotationStep),
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
  private environmentStates = new Map<VisualTargetId, EnvironmentProbeState>();
  private probeCanvas: HTMLCanvasElement | null = null;
  private probeContext: CanvasRenderingContext2D | null = null;
  private backgroundProbeCache: BackgroundProbeCache = {
    data: null,
    width: 0,
    height: 0,
    lastSampleTime: Number.NEGATIVE_INFINITY,
    lastSampleKey: null,
    lastCompositionKey: null,
    lastObservedBounds: null,
    coordinateSpace: 'screen',
  };
  private samplingMode: EnvironmentSamplingMode = 'interactive';
  private snapFirstEnvironmentSample = false;

  setSamplingMode(mode: EnvironmentSamplingMode): void {
    this.samplingMode = mode;
  }

  private getProbeContext(): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } | null {
    if (typeof document === 'undefined') {
      return null;
    }

    if (!this.probeCanvas) {
      this.probeCanvas = document.createElement('canvas');
      this.probeCanvas.width = 64;
      this.probeCanvas.height = 36;
    }

    if (!this.probeContext) {
      const context = this.probeCanvas.getContext(
        '2d',
        { willReadFrequently: true } as CanvasRenderingContext2DSettings,
      );
      if (!context) {
        this.probeCanvas = null;
        this.probeContext = null;
        return null;
      }
      this.probeContext = context;
    }

    return { canvas: this.probeCanvas, context: this.probeContext };
  }

  invalidateEnvironmentSamples(targetId?: VisualTargetId, options?: { snapToSample?: boolean }): void {
    // Preserve an export/seek snap request across invalidations triggered inside seek().
    if (options?.snapToSample !== undefined) {
      this.snapFirstEnvironmentSample = options.snapToSample;
    }
    if (targetId) {
      this.environmentStates.delete(targetId);
    } else {
      this.environmentStates.clear();
    }
    this.backgroundProbeCache = {
      data: null,
      width: 0,
      height: 0,
      lastSampleTime: Number.NEGATIVE_INFINITY,
      lastSampleKey: null,
      lastCompositionKey: null,
      lastObservedBounds: null,
      coordinateSpace: 'screen',
    };
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

  private getOrCreateEnvironmentState(targetId: VisualTargetId): EnvironmentProbeState {
    let state = this.environmentStates.get(targetId);
    if (!state) {
      state = {
        smoothingRemainder: 0,
        raw: null,
        display: null,
        lastAppliedTime: null,
        lastSampleTime: Number.NEGATIVE_INFINITY,
        lastSampleKey: null,
      };
      this.environmentStates.set(targetId, state);
    }
    return state;
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

  private getBackgroundSamplingTarget(): PIXI.Container | null {
    return (
      stageManager.getEnvironmentSamplingContainer?.() ||
      stageManager.getEnvironmentLayerDisplayObject?.(BACKGROUND_LAYER_ID) ||
      stageManager.getBackgroundSprite?.() ||
      stageManager.getLayer('background')
    );
  }

  private getSamplingIntervalSeconds(isMoving: boolean): number {
    if (this.samplingMode === 'export') {
      return 0;
    }
    return isMoving ? 1 / 24 : 1 / 5;
  }

  private shouldRefreshBackgroundProbe(time: number): {
    shouldSample: boolean;
    sampleKey: string;
    isMoving: boolean;
    compositionChanged: boolean;
    compositionKey: string | null;
  } {
    const backgroundTarget = this.getBackgroundSamplingTarget();
    const backgroundLocalSource = getBackgroundLocalProbeSource(backgroundTarget);
    if (backgroundLocalSource) {
      this.backgroundProbeCache.lastObservedBounds = cloneBounds(getDisplayBounds(backgroundTarget));
      return {
        shouldSample: !this.backgroundProbeCache.data
        || this.backgroundProbeCache.coordinateSpace !== 'background-local'
          || this.backgroundProbeCache.lastSampleKey !== backgroundLocalSource.sampleKey,
        sampleKey: backgroundLocalSource.sampleKey,
        isMoving: false,
        compositionChanged: false,
        compositionKey: null,
      };
    }

    const backgroundBounds = getDisplayBounds(backgroundTarget);
    const sampleKey = getBackgroundStableProbeKey(backgroundTarget);
    const motionScore = computeBoundsMotionScore(this.backgroundProbeCache.lastObservedBounds, backgroundBounds);
    // A composite can change through fades or layer motion without changing its bounds.
    const isMoving = motionScore > 0.75 || backgroundTarget === stageManager.getEnvironmentSamplingContainer?.();
    const interval = this.getSamplingIntervalSeconds(isMoving);
    const missing = !this.backgroundProbeCache.data;
    const changed = this.backgroundProbeCache.lastSampleKey !== sampleKey;
    const elapsed = time - this.backgroundProbeCache.lastSampleTime;
    const intervalElapsed = interval === 0 ? elapsed > 0 : elapsed >= interval;
    // Composition edits while paused must still invalidate the probe, but walking
    // every environment child on every playback frame is far more expensive than
    // the sampling cadence itself. During playback, the scheduled probe refresh
    // already captures animated changes; only inspect the tree on the first sample
    // or when time is stationary/seeking.
    const shouldCheckComposition = missing || elapsed <= BACKWARD_TIME_EPSILON_SECONDS;
    const currentCompositionKey = backgroundTarget && shouldCheckComposition
      ? getDisplayCompositionKey(backgroundTarget)
      : null;
    const compositionChanged = currentCompositionKey !== null
      && this.backgroundProbeCache.lastCompositionKey !== currentCompositionKey;
    this.backgroundProbeCache.lastObservedBounds = cloneBounds(backgroundBounds);
    return {
      shouldSample: missing || changed || elapsed < -BACKWARD_TIME_EPSILON_SECONDS || intervalElapsed
        || (compositionChanged && elapsed <= 0),
      sampleKey,
      isMoving,
      compositionChanged,
      compositionKey: currentCompositionKey,
    };
  }

  private refreshBackgroundProbe(time: number, compositionKey: string | null = null): void {
    const backgroundTarget = this.getBackgroundSamplingTarget();
    if (!backgroundTarget) {
      this.backgroundProbeCache.data = null;
      this.backgroundProbeCache.width = 0;
      this.backgroundProbeCache.height = 0;
      this.backgroundProbeCache.coordinateSpace = 'screen';
      this.backgroundProbeCache.lastSampleKey = null;
      this.backgroundProbeCache.lastObservedBounds = cloneBounds(getDisplayBounds(backgroundTarget));
      return;
    }

    try {
      const backgroundLocalSource = getBackgroundLocalProbeSource(backgroundTarget);
      if (typeof document === 'undefined') {
        this.backgroundProbeCache.data = null;
        this.backgroundProbeCache.width = 0;
        this.backgroundProbeCache.height = 0;
        this.backgroundProbeCache.coordinateSpace = 'screen';
        this.backgroundProbeCache.lastSampleKey = null;
        this.backgroundProbeCache.lastObservedBounds = cloneBounds(getDisplayBounds(backgroundTarget));
        return;
      }
      const probe = this.getProbeContext();
      if (!probe) {
        this.backgroundProbeCache.data = null;
        this.backgroundProbeCache.width = 0;
        this.backgroundProbeCache.height = 0;
        this.backgroundProbeCache.coordinateSpace = 'screen';
        this.backgroundProbeCache.lastSampleKey = null;
        this.backgroundProbeCache.lastObservedBounds = cloneBounds(getDisplayBounds(backgroundTarget));
        return;
      }
      const { canvas: probeCanvas, context } = probe;

      context.clearRect(0, 0, probeCanvas.width, probeCanvas.height);
      if (backgroundLocalSource) {
        context.drawImage(
          backgroundLocalSource.source,
          0,
          0,
          backgroundLocalSource.width,
          backgroundLocalSource.height,
          0,
          0,
          probeCanvas.width,
          probeCanvas.height,
        );
        const imageData = context.getImageData(0, 0, probeCanvas.width, probeCanvas.height);
        this.backgroundProbeCache.data = imageData.data;
        this.backgroundProbeCache.width = probeCanvas.width;
        this.backgroundProbeCache.height = probeCanvas.height;
        this.backgroundProbeCache.lastSampleTime = time;
        this.backgroundProbeCache.lastSampleKey = backgroundLocalSource.sampleKey;
        this.backgroundProbeCache.lastCompositionKey = null;
        this.backgroundProbeCache.lastObservedBounds = cloneBounds(getDisplayBounds(backgroundTarget));
        this.backgroundProbeCache.coordinateSpace = 'background-local';
        return;
      }

      const app = stageManager.getApp();
      const extractCanvas = (app.renderer as any)?.extract?.canvas?.bind((app.renderer as any).extract);
      if (typeof extractCanvas !== 'function') {
        this.backgroundProbeCache.data = null;
        this.backgroundProbeCache.width = 0;
        this.backgroundProbeCache.height = 0;
        this.backgroundProbeCache.coordinateSpace = 'screen';
        this.backgroundProbeCache.lastSampleKey = null;
        this.backgroundProbeCache.lastObservedBounds = cloneBounds(getDisplayBounds(backgroundTarget));
        return;
      }

      // Keep GPU readback small; the probe itself is only 64 x 36 pixels.
      const sampledCanvas = extractCanvas({ target: backgroundTarget, resolution: 1 / 30 }) as HTMLCanvasElement;
      if (!sampledCanvas || sampledCanvas.width <= 0 || sampledCanvas.height <= 0) {
        this.backgroundProbeCache.data = null;
        this.backgroundProbeCache.width = 0;
        this.backgroundProbeCache.height = 0;
        this.backgroundProbeCache.coordinateSpace = 'screen';
        this.backgroundProbeCache.lastSampleKey = null;
        this.backgroundProbeCache.lastObservedBounds = cloneBounds(getDisplayBounds(backgroundTarget));
        return;
      }

      context.drawImage(
        sampledCanvas,
        0,
        0,
        sampledCanvas.width,
        sampledCanvas.height,
        0,
        0,
        probeCanvas.width,
        probeCanvas.height,
      );

      const imageData = context.getImageData(0, 0, probeCanvas.width, probeCanvas.height);
      this.backgroundProbeCache.data = imageData.data;
      this.backgroundProbeCache.width = probeCanvas.width;
      this.backgroundProbeCache.height = probeCanvas.height;
      this.backgroundProbeCache.lastSampleTime = time;
      this.backgroundProbeCache.lastSampleKey = getBackgroundStableProbeKey(backgroundTarget);
      if (compositionKey !== null) {
        this.backgroundProbeCache.lastCompositionKey = compositionKey;
      }
      this.backgroundProbeCache.lastObservedBounds = cloneBounds(getDisplayBounds(backgroundTarget));
      this.backgroundProbeCache.coordinateSpace = 'screen';
    } catch {
      this.backgroundProbeCache.data = null;
      this.backgroundProbeCache.width = 0;
      this.backgroundProbeCache.height = 0;
      this.backgroundProbeCache.coordinateSpace = 'screen';
      this.backgroundProbeCache.lastSampleKey = null;
      this.backgroundProbeCache.lastObservedBounds = cloneBounds(getDisplayBounds(backgroundTarget));
    }
  }

  private deriveCharacterProbeFromBackgroundCache(
    targetId: VisualTargetId,
    override?: TargetEnvironmentOverride,
  ): EnvironmentProbeSnapshot | null {
    if (!this.backgroundProbeCache.data || this.backgroundProbeCache.width <= 0 || this.backgroundProbeCache.height <= 0) {
      return override?.environmentColor
        ? createFallbackProbe(parseColor(override.environmentColor) ?? 0x808080, override)
        : null;
    }

    const backgroundTarget = this.getBackgroundSamplingTarget();
    const worldTargetBounds = (live2DManager as any).getStableWorldSampleBounds?.(targetId) as RectLike | null | undefined;
    if (!backgroundTarget) {
      return override?.environmentColor
        ? createFallbackProbe(parseColor(override.environmentColor) ?? 0x808080, override)
        : buildProbeFromImageData(this.backgroundProbeCache.data, this.backgroundProbeCache.width, this.backgroundProbeCache.height);
    }

    if (this.backgroundProbeCache.coordinateSpace === 'background-local') {
      const backgroundLocalBounds = getBackgroundLocalBounds(backgroundTarget);
      const environmentProxy = (live2DManager as any).getEnvironmentLayerProxy?.(BACKGROUND_LAYER_ID) as EnvironmentLayerProxySnapshot | null | undefined;
      let localRegion = backgroundLocalBounds && worldTargetBounds
        ? mapWorldBoundsToBackgroundLocalRegion(
            backgroundTarget,
            worldTargetBounds,
            backgroundLocalBounds,
            environmentProxy ?? null,
            environmentProxy ? null : ((live2DManager as any).currentCamera ?? null),
          )
        : null;
      if (backgroundLocalBounds && localRegion) {
        const normalizedXStart = (localRegion.x - backgroundLocalBounds.x) / backgroundLocalBounds.width;
        const normalizedXEnd = (localRegion.x + localRegion.width - backgroundLocalBounds.x) / backgroundLocalBounds.width;
        const normalizedYStart = (localRegion.y - backgroundLocalBounds.y) / backgroundLocalBounds.height;
        const normalizedYEnd = (localRegion.y + localRegion.height - backgroundLocalBounds.y) / backgroundLocalBounds.height;

        return buildProbeFromRegion(
          this.backgroundProbeCache.data,
          this.backgroundProbeCache.width,
          this.backgroundProbeCache.height,
          clamp(normalizedXStart, 0, 1) * this.backgroundProbeCache.width,
          clamp(normalizedXEnd, 0, 1) * this.backgroundProbeCache.width,
          clamp(normalizedYStart, 0, 1) * this.backgroundProbeCache.height,
          clamp(normalizedYEnd, 0, 1) * this.backgroundProbeCache.height,
        );
      }
      return override?.environmentColor
        ? createFallbackProbe(parseColor(override.environmentColor) ?? 0x808080, override)
        : null;
    }

    // Extraction renders the environment container in its local (stage) space.
    // Sample only the region behind this character, rather than the whole stage.
    const environmentBounds = getBackgroundLocalBounds(backgroundTarget);
    const characterBounds = live2DManager.getStableSampleBounds?.(targetId);
    if (environmentBounds && environmentBounds.width > 0 && environmentBounds.height > 0 && characterBounds) {
      const region = buildLocalRegionFromPoints(createProbeSamplePoints(characterBounds), environmentBounds);
      if (region) {
        const { data, width, height } = this.backgroundProbeCache;
        return buildProbeFromRegion(
          data, width, height,
          (region.x - environmentBounds.x) / environmentBounds.width * width,
          (region.x + region.width - environmentBounds.x) / environmentBounds.width * width,
          (region.y - environmentBounds.y) / environmentBounds.height * height,
          (region.y + region.height - environmentBounds.y) / environmentBounds.height * height,
        );
      }
    }
    return buildProbeFromImageData(this.backgroundProbeCache.data, this.backgroundProbeCache.width, this.backgroundProbeCache.height);
  }

  private applyResponsiveEnvironment(
    targetId: VisualTargetId,
    effect: ObjectCompositeEffectSpec,
    visualRecord: VisualTargetRecord | undefined,
    time: number,
  ): ObjectCompositeEffectSpec {
    if (!effect.environmentResponsive && !effect.shadowResponsive) {
      return effect;
    }

    const override = visualRecord?.targetEnvironmentOverride;
    const state = this.getOrCreateEnvironmentState(targetId);
    const targetDisplayObject = this.getTargetDisplayObject(targetId, 'character');
    const { shouldSample, sampleKey, compositionChanged, compositionKey } = this.shouldRefreshBackgroundProbe(time);

    if (shouldSample) {
      this.refreshBackgroundProbe(time, compositionKey);
    }

    const probeKey = `${sampleKey}|${targetId}|${getEffectEnvironmentKey(effect)}`;
    // Each character must read the latest shared pixels, including when a previous
    // character refreshed them this frame or this character moved within the image.
    const sampled = this.deriveCharacterProbeFromBackgroundCache(targetId, override);
    const environmentChanged = Boolean(sampled && !environmentProbesEqual(state.raw, sampled));
    if (sampled) {
      state.raw = sampled;
      state.lastSampleTime = time;
      state.lastSampleKey = probeKey;
    }

    if (!state.raw) {
      return effect;
    }

    const elapsed = state.lastAppliedTime === null ? 0 : time - state.lastAppliedTime;
    const movedBackward = elapsed < -BACKWARD_TIME_EPSILON_SECONDS;
    const smoothingDelta = this.samplingMode === 'export'
      ? EXPORT_PROBE_SMOOTH_DT_SECONDS
      : state.lastAppliedTime === null
        ? INITIAL_PROBE_SMOOTH_DT_SECONDS
        : clamp(Math.max(elapsed, 0), INITIAL_PROBE_SMOOTH_DT_SECONDS, INTERACTIVE_PROBE_SMOOTH_DT_CAP_SECONDS);
    const snapForEnvironmentChange = Boolean(
      state.display
      && environmentChanged
      && compositionChanged
      && elapsed <= BACKWARD_TIME_EPSILON_SECONDS,
    );
    if (!state.display || movedBackward || snapForEnvironmentChange) {
      state.smoothingRemainder = 0;
      const currentProbe = !movedBackward && !snapForEnvironmentChange && !override && !this.snapFirstEnvironmentSample
        ? readCurrentEnvironmentProbe(targetDisplayObject)
        : null;
      state.display = currentProbe
        ? smoothProbeSnapshot(currentProbe, state.raw, smoothingDelta)
        : cloneProbeSnapshot(state.raw);
    } else {
      state.smoothingRemainder += smoothingDelta;
      while (state.smoothingRemainder + 1e-9 >= PROBE_SMOOTH_STEP_SECONDS) {
        state.display = smoothProbeSnapshot(state.display, state.raw, PROBE_SMOOTH_STEP_SECONDS);
        state.smoothingRemainder = Math.max(0, state.smoothingRemainder - PROBE_SMOOTH_STEP_SECONDS);
      }
    }
    state.lastAppliedTime = time;

    return applyEnvironmentProbeToEffect(effect, applyTargetOverrideToProbe(state.display, override), override);
  }

  private applyTarget(targetId: VisualTargetId, targetType: VisualTargetType, effect: ObjectCompositeEffectSpec): void {
    const displayObject = this.getTargetDisplayObject(targetId, targetType);
    if (!displayObject) return;
    updateOwnedFilters(displayObject, effect);
  }

  private targetHasOwnedFilters(targetId: VisualTargetId, targetType: VisualTargetType): boolean {
    const displayObject = this.getTargetDisplayObject(targetId, targetType);
    return Boolean(
      ((displayObject?.filters as PIXI.Filter[] | null) || []).some(filter => Boolean((filter as any)[OWNED_FILTER])),
    );
  }

  private clearTarget(scene: VisualTimelineScene | null, targetId: VisualTargetId): void {
    const targetType = scene ? inferTargetType(scene, targetId) : null;
    if (!targetType) return;
    const displayObject = this.getTargetDisplayObject(targetId, targetType);
    if (!displayObject) return;
    const remaining = ((displayObject.filters as PIXI.Filter[] | null) || []).filter(filter => !(filter as any)[OWNED_FILTER]);
    commitFilters(displayObject, remaining.length > 0 ? remaining : null);
  }
}

export const objectCompositeRuntimeController = new ObjectCompositeRuntimeController();
