import * as PIXI from 'pixi.js';
import { PIXI_V8_FILTER_VERTEX } from './PixiV8Filter';

/**
 * A single-pass, alpha-driven rim light for Live2D containers.
 *
 * DropShadowFilter is a multi-pass filter. Cubism 2 renders with its own GL
 * program and can leave Pixi's shader cache pointing at that program while the
 * filter pipeline is being restored. Keeping the rim light in one pass also
 * makes the intended visual contract explicit: only pixels outside the model
 * alpha receive light; the model body is never recolored by the effect.
 */
export const RIM_LIGHT_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
// Pixi's default filter vertex shader uses highp for this shared uniform.
// WebGL links the stages only when the uniform precision matches.
uniform highp vec4 uInputSize;
uniform vec4 uInputClamp;
uniform vec3 rimColor;
uniform float rimAlpha;
uniform vec2 rimDirection;
uniform float rimThickness;
uniform float rimSoftness;

float sampleAlpha(vec2 uv) {
  return texture(uTexture, clamp(uv, uInputClamp.xy, uInputClamp.zw)).a;
}

float directionalAlpha(vec2 uv, vec2 direction, vec2 tangent, float radius) {
  vec2 offset = vec2(uInputSize.z * radius, uInputSize.w * radius);
  float sampleRadius = max(radius, 0.0);
  float maxAlpha = 0.0;

  maxAlpha = max(maxAlpha, sampleAlpha(uv - direction * offset));
  maxAlpha = max(maxAlpha, sampleAlpha(uv - direction * offset - tangent * offset * 0.65));
  maxAlpha = max(maxAlpha, sampleAlpha(uv - direction * offset + tangent * offset * 0.65));
  maxAlpha = max(maxAlpha, sampleAlpha(uv - tangent * offset * 0.65));
  maxAlpha = max(maxAlpha, sampleAlpha(uv + tangent * offset * 0.65));

  // Keep a stable center sample when the requested thickness is zero.
  if (sampleRadius <= 0.0) {
    maxAlpha = sampleAlpha(uv);
  }
  return maxAlpha;
}

void main(void) {
  vec4 source = texture(uTexture, vTextureCoord);
  if (rimAlpha <= 0.0 || rimThickness <= 0.0) {
    finalColor = source;
    return;
  }

  vec2 direction = normalize(rimDirection);
  vec2 tangent = vec2(-direction.y, direction.x);
  float outerAlpha = directionalAlpha(vTextureCoord, direction, tangent, rimThickness);
  float softness = max(rimSoftness, 0.0);
  if (softness > 0.0) {
    float midAlpha = directionalAlpha(vTextureCoord, direction, tangent, rimThickness + softness * 0.5);
    float farAlpha = directionalAlpha(vTextureCoord, direction, tangent, rimThickness + softness);
    outerAlpha = max(outerAlpha, midAlpha * 0.65);
    outerAlpha = max(outerAlpha, farAlpha * 0.3);
  }

  // Subtract the current alpha and gate by transparent area. This prevents
  // the source pixels inside the character from becoming a white silhouette.
  float edgeAlpha = clamp((outerAlpha - source.a) * rimAlpha, 0.0, 1.0);
  edgeAlpha *= 1.0 - source.a;
  vec4 rim = vec4(rimColor * edgeAlpha, edgeAlpha);
  finalColor = source + rim;
}
`;

export interface RimLightFilterOptions {
  distance?: number;
  rotation?: number;
  blur?: number;
  alpha?: number;
  color?: number;
}

export class RimLightFilter extends PIXI.Filter {
  readonly uniforms: {
    rimAlpha: number;
    rimColor: Float32Array;
    rimDirection: Float32Array;
    rimSoftness: number;
    rimThickness: number;
  };
  private _distance = 0;
  private _rotation = 0;
  private _blur = 0;
  private _alpha = 0;
  private _color = 0xffffff;

  constructor(options: RimLightFilterOptions = {}) {
    super({
      glProgram: PIXI.GlProgram.from({
        vertex: PIXI_V8_FILTER_VERTEX,
        fragment: RIM_LIGHT_FRAGMENT,
        name: 'aeon-rim-light-filter',
      }),
      resources: {
        rimUniforms: {
          rimAlpha: { value: 0, type: 'f32' },
          rimColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          rimDirection: { value: new Float32Array([1, 0]), type: 'vec2<f32>' },
          rimSoftness: { value: 0, type: 'f32' },
          rimThickness: { value: 0, type: 'f32' },
        },
      },
    });
    this.uniforms = this.resources.rimUniforms.uniforms as typeof this.uniforms;

    this.color = options.color ?? 0xffffff;
    this.distance = options.distance ?? 0;
    this.rotation = options.rotation ?? 0;
    this.blur = options.blur ?? 0;
    this.alpha = options.alpha ?? 0;
  }

  apply(filterManager: any, input: any, output: any, clearMode?: any): void {
    // Cubism 2 can leave its own program bound while Pixi still caches a
    // previous program. Invalidate that cache immediately before FilterSystem
    // binds this filter so all uniform locations belong to the program in use.
    // v8 seam: GlShaderSystem.resetState() (v7's shader.reset() is gone; `?.`
    // on it silently did nothing). Still optional-chained because the WebGPU
    // renderer exposes no `shader` system at all.
    filterManager?.renderer?.shader?.resetState?.();
    filterManager.applyFilter(this, input, output, clearMode);
  }

  get distance(): number {
    return this._distance;
  }

  set distance(value: number) {
    this._distance = Math.max(0, finiteOr(value, 0));
    this.uniforms.rimThickness = this._distance;
    this.updatePadding();
  }

  get rotation(): number {
    return this._rotation;
  }

  set rotation(value: number) {
    this._rotation = finiteOr(value, 0);
    const radians = (this._rotation * Math.PI) / 180;
    this.uniforms.rimDirection[0] = Math.cos(radians);
    this.uniforms.rimDirection[1] = Math.sin(radians);
  }

  get blur(): number {
    return this._blur;
  }

  set blur(value: number) {
    this._blur = Math.max(0, finiteOr(value, 0));
    this.uniforms.rimSoftness = this._blur;
    this.updatePadding();
  }

  get alpha(): number {
    return this._alpha;
  }

  set alpha(value: number) {
    this._alpha = Math.max(0, finiteOr(value, 0));
    this.uniforms.rimAlpha = this._alpha;
  }

  get color(): number {
    return this._color;
  }

  set color(value: number) {
    this._color = Number.isFinite(value) ? Math.max(0, Math.min(0xffffff, Math.round(value))) : 0xffffff;
    const uniform = this.uniforms.rimColor as Float32Array;
    uniform[0] = ((this._color >> 16) & 0xff) / 255;
    uniform[1] = ((this._color >> 8) & 0xff) / 255;
    uniform[2] = (this._color & 0xff) / 255;
  }

  private updatePadding(): void {
    this.padding = this._distance + this._blur * 2;
  }
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
