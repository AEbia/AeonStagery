import * as PIXI from 'pixi.js';
import { PIXI_V8_FILTER_VERTEX } from './PixiV8Filter';

/**
 * A single-pass inner contour light matching WebGAL's highlight-only bevel.
 *
 * DropShadowFilter is a multi-pass filter. Cubism 2 renders with its own GL
 * program and can leave Pixi's shader cache pointing at that program while the
 * filter pipeline is being restored. Evaluate the directional motion-blurred
 * alpha mask inline so softness does not require another render pass. At
 * fractional offsets this approximates the two-pass mask's interpolation.
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

float maskAlpha(vec2 uv, vec2 transform) {
  float alpha = sampleAlpha(uv);
  if (rimSoftness > 0.0) {
    // WebGAL uses MotionBlurFilter with kernelSize=11, offset=0 and
    // velocity=-direction*thickness*softness. Its kernel includes the
    // center sample plus ten taps at i/10 - 0.5 (i=0..9).
    vec2 velocity = -transform * rimSoftness;
    for (int i = 0; i < 10; i++) {
      alpha += sampleAlpha(uv + velocity * (float(i) / 10.0 - 0.5));
    }
    alpha /= 11.0;
  }
  return alpha;
}

void main(void) {
  vec4 source = texture(uTexture, vTextureCoord);
  if (rimAlpha <= 0.0 || rimThickness <= 0.0) {
    finalColor = source;
    return;
  }

  vec2 transform = rimDirection * rimThickness * uInputSize.zw;
  float light = maskAlpha(vTextureCoord - transform, transform);
  float strength = clamp((source.a - light) * rimAlpha, 0.0, 1.0);
  // Filter textures use premultiplied alpha. Blend in straight color space,
  // then premultiply again so antialiased edges remain valid PMA pixels.
  // WebGAL disables bevel shadows, so there is no opposite-side darkening.
  vec3 sourceColor = source.a > 0.0 ? source.rgb / source.a : vec3(0.0);
  vec3 highlight = vec3(1.0) - (vec3(1.0) - sourceColor) * (vec3(1.0) - rimColor);
  finalColor = vec4(mix(sourceColor, highlight, strength) * source.a, source.a);
}
`;

export interface RimLightFilterOptions {
  distance?: number;
  rotation?: number;
  /** Directional mask blur radius in pixels. */
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
      resolution: 'inherit',
      padding: 1,
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

  override apply(filterManager: PIXI.FilterSystem, input: PIXI.Texture, output: PIXI.RenderSurface, clearMode: boolean): void {
    // Cubism 2 can leave its own program bound while Pixi still caches a
    // previous program. Invalidate that cache immediately before FilterSystem
    // binds this filter so all uniform locations belong to the program in use.
    // WebGPU has no GL shader system to reset.
    const shader = filterManager.renderer.shader;
    if ('resetState' in shader) shader.resetState();
    filterManager.applyFilter(this, input, output, clearMode);
  }

  get distance(): number {
    return this._distance;
  }

  set distance(value: number) {
    this._distance = Math.max(0, finiteOr(value, 0));
    this.uniforms.rimThickness = this._distance;
    this.updateMaskGeometry();
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
    this.updateMaskGeometry();
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

  private updateMaskGeometry(): void {
    this.uniforms.rimSoftness = this._distance > 0 ? this._blur / this._distance : 0;
    // Cubism's raster coverage can touch the filter frame after its drawable
    // bounds are rounded. A one-pixel border can therefore contain opacity;
    // clamping shifted mask taps to it erases part of the head contour. Reserve
    // the full sampling footprint plus a transparent guard band independently
    // of the entrance AlphaFilter's temporary padding.
    this.padding = Math.ceil(this._distance + this._blur * 0.5) + 1;
  }
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
