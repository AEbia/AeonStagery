import * as PIXI from 'pixi.js';
import type { BlendMode } from '../../api/types/blend-mode';
import {
  AdjustmentFilter,
  AdvancedBloomFilter,
  GodrayFilter,
  RGBSplitFilter,
} from 'pixi-filters';
import { stageManager } from '../StageManager';
import { live2DManager } from '../Live2DManager';
import { PIXI_V8_FILTER_VERTEX } from '../PixiV8Filter';
import { BLEND_MODE_SHADER_GLSL, BLEND_MODE_SHADER_INDEX } from './blendModeShader';
import {
  DEFAULT_POST_PROCESSING_SNAPSHOT,
  type LightingPostProcessingSnapshot,
  type LightingSnapshot,
} from '../LightingSnapshot';

/** Marker used to distinguish filters owned by this controller from host filters. */
export const TARGET_POST_PROCESSING_OWNER = '__targetPostProcessingOwnedFilter';
const TARGET_POST_PROCESSING_KIND = '__targetPostProcessingKind';

type TargetPostFilterKind = 'adjustment' | 'bloom' | 'godray' | 'rgbSplit' | 'overlay';

function markOwnedFilter<T extends PIXI.Filter>(filter: T, kind: TargetPostFilterKind): T {
  (filter as any)[TARGET_POST_PROCESSING_OWNER] = true;
  (filter as any)[TARGET_POST_PROCESSING_KIND] = kind;
  return filter;
}

function isOwnedFilter(filter: PIXI.Filter): boolean {
  return Boolean((filter as any)[TARGET_POST_PROCESSING_OWNER]);
}

function getFilterKind(filter: PIXI.Filter): TargetPostFilterKind | null {
  const kind = (filter as any)[TARGET_POST_PROCESSING_KIND];
  return kind === 'adjustment' || kind === 'bloom' || kind === 'godray' || kind === 'rgbSplit' || kind === 'overlay'
    ? kind
    : null;
}

function parseColor(value: number | string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(0xffffff, Math.round(value)));
  }
  const normalized = String(value).trim().replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(normalized) ? parseInt(normalized, 16) : 0;
}

const TARGET_COLOR_BLEND_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec3 color;
uniform float alpha;
uniform float blendMode;

${BLEND_MODE_SHADER_GLSL}

void main(void) {
  vec4 source = texture(uTexture, vTextureCoord);
  vec3 base = source.a > 0.0001 ? source.rgb / source.a : vec3(0.0);
  vec3 blended = applyBlendMode(base, color, blendMode);
  vec3 result = mix(base, blended, clamp(alpha, 0.0, 1.0));
  finalColor = vec4(clamp(result, 0.0, 1.0) * source.a, source.a);
}
`;

class TargetColorBlendFilter extends PIXI.Filter {
  readonly uniforms: {
    alpha: number;
    blendMode: number;
    color: Float32Array;
  };
  overlayColor: string | number = '#ffffff';
  overlayBlendMode: BlendMode = 'multiply';
  overlayIntensity = 0;

  constructor() {
    super({
      glProgram: PIXI.GlProgram.from({
        vertex: PIXI_V8_FILTER_VERTEX,
        fragment: TARGET_COLOR_BLEND_FRAGMENT,
        name: 'aeon-target-color-blend-filter',
      }),
      resources: {
        targetColorBlendUniforms: {
          alpha: { value: 0, type: 'f32' },
          blendMode: { value: BLEND_MODE_SHADER_INDEX.multiply, type: 'f32' },
          color: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
        },
      },
    });
    this.uniforms = this.resources.targetColorBlendUniforms.uniforms as typeof this.uniforms;
  }

  setOverlay(color: number | string, mode: BlendMode, intensity: number): void {
    const parsedColor = parseColor(color);
    this.uniforms.color[0] = ((parsedColor >> 16) & 0xff) / 255;
    this.uniforms.color[1] = ((parsedColor >> 8) & 0xff) / 255;
    this.uniforms.color[2] = (parsedColor & 0xff) / 255;
    this.uniforms.blendMode = BLEND_MODE_SHADER_INDEX[mode];
    this.uniforms.alpha = intensity;
    this.overlayColor = color;
    this.overlayBlendMode = mode;
    this.overlayIntensity = intensity;
    this.enabled = true;
  }
}

function isDefaultPostProcessing(state: LightingPostProcessingSnapshot): boolean {
  const defaults = DEFAULT_POST_PROCESSING_SNAPSHOT;
  return (
    state.bloomThreshold === defaults.bloomThreshold &&
    state.bloomBloomScale === defaults.bloomBloomScale &&
    state.bloomBrightness === defaults.bloomBrightness &&
    state.rgbSplitX === defaults.rgbSplitX &&
    state.rgbSplitY === defaults.rgbSplitY &&
    state.godrayGain === defaults.godrayGain &&
    state.godrayLacunarity === defaults.godrayLacunarity &&
    state.godrayAngle === defaults.godrayAngle &&
    state.adjGamma === defaults.adjGamma &&
    state.adjContrast === defaults.adjContrast &&
    state.adjSaturation === defaults.adjSaturation &&
    state.adjBrightness === defaults.adjBrightness &&
    state.adjRed === defaults.adjRed &&
    state.adjGreen === defaults.adjGreen &&
    state.adjBlue === defaults.adjBlue &&
    state.overlayIntensity <= 0.001
  );
}

function destroyFilter(filter: PIXI.Filter): void {
  const destroy = (filter as any).destroy;
  if (typeof destroy === 'function') destroy.call(filter);
}

/**
 * Applies target-scoped post-processing without taking ownership of the
 * object's existing composite or host-provided filters. Missing targets stay
 * pending until a later reconciliation pass can resolve their runtime object.
 */
class TargetPostProcessingController {
  private appliedTargets = new Set<string>();
  private pendingTargets = new Map<string, LightingPostProcessingSnapshot>();

  applySnapshot(snapshot: LightingSnapshot): void {
    const targetStates = snapshot.postProcessingTargets || {};
    const nextTargets = new Set(Object.keys(targetStates));

    for (const targetId of new Set([...this.appliedTargets, ...this.pendingTargets.keys()])) {
      if (!nextTargets.has(targetId)) {
        this.clearTarget(targetId);
        this.appliedTargets.delete(targetId);
        this.pendingTargets.delete(targetId);
      }
    }

    for (const [targetId, state] of Object.entries(targetStates)) {
      if (this.applyTarget(targetId, state)) {
        this.appliedTargets.add(targetId);
        this.pendingTargets.delete(targetId);
      } else {
        this.appliedTargets.delete(targetId);
        this.pendingTargets.set(targetId, state);
      }
    }
  }

  /** Alias kept small and explicit for runtime callers that reconcile visual state. */
  apply(snapshot: LightingSnapshot): void {
    this.applySnapshot(snapshot);
  }

  clear(): void {
    for (const targetId of this.appliedTargets) {
      this.clearTarget(targetId);
    }
    this.appliedTargets.clear();
    this.pendingTargets.clear();
  }

  clearAll(): void {
    this.clear();
  }

  /** Retry target states whose runtime display objects were not available yet. */
  reconcilePendingTargets(): void {
    for (const [targetId, state] of this.pendingTargets) {
      if (!this.applyTarget(targetId, state)) continue;
      this.pendingTargets.delete(targetId);
      this.appliedTargets.add(targetId);
    }
  }

  private getTargetDisplayObject(targetId: string): PIXI.Container | null {
    if (typeof (live2DManager as any).hasCharacter === 'function' && live2DManager.hasCharacter(targetId)) {
      if (typeof (live2DManager as any).canApplyContainerFilters === 'function'
        && !(live2DManager as any).canApplyContainerFilters(targetId)) {
        return null;
      }
      return live2DManager.getContainer(targetId);
    }
    return stageManager.getEnvironmentLayerContainer?.(targetId) ?? null;
  }

  private applyTarget(targetId: string, state: LightingPostProcessingSnapshot): boolean {
    const displayObject = this.getTargetDisplayObject(targetId);
    if (!displayObject) return false;

    const existingFilters = ((displayObject.filters as PIXI.Filter[] | null) || []);
    const externalFilters = existingFilters.filter((filter) => !isOwnedFilter(filter));
    const ownedFilters = existingFilters.filter((filter) => isOwnedFilter(filter));
    const nextOwned: PIXI.Filter[] = [];

    const take = <T extends PIXI.Filter>(kind: TargetPostFilterKind): T | null => {
      const index = ownedFilters.findIndex((filter) => getFilterKind(filter) === kind);
      if (index < 0) return null;
      return ownedFilters.splice(index, 1)[0] as T;
    };

    if (!isDefaultPostProcessing(state)) {
      if (
        state.adjGamma !== 1 || state.adjContrast !== 1 || state.adjSaturation !== 1 ||
        state.adjBrightness !== 1 || state.adjRed !== 1 || state.adjGreen !== 1 || state.adjBlue !== 1
      ) {
        const adjustment = take<AdjustmentFilter>('adjustment') ?? markOwnedFilter(new AdjustmentFilter({
          gamma: 1,
          contrast: 1,
          saturation: 1,
          brightness: 1,
          red: 1,
          green: 1,
          blue: 1,
        }), 'adjustment');
        adjustment.gamma = state.adjGamma;
        adjustment.contrast = state.adjContrast;
        adjustment.saturation = state.adjSaturation;
        adjustment.brightness = state.adjBrightness;
        adjustment.red = state.adjRed;
        adjustment.green = state.adjGreen;
        adjustment.blue = state.adjBlue;
        adjustment.enabled = true;
        nextOwned.push(adjustment);
      }

      if (state.bloomBloomScale > 0.001 || Math.abs(state.bloomBrightness - 1) > 0.001 || Math.abs(state.bloomThreshold - 0.5) > 0.001) {
        const bloom = take<AdvancedBloomFilter>('bloom') ?? markOwnedFilter(new AdvancedBloomFilter({
          threshold: DEFAULT_POST_PROCESSING_SNAPSHOT.bloomThreshold,
          bloomScale: 0,
          brightness: 1,
          blur: 8,
          quality: 4,
        }), 'bloom');
        bloom.threshold = state.bloomThreshold;
        bloom.bloomScale = state.bloomBloomScale;
        bloom.brightness = state.bloomBrightness;
        bloom.enabled = true;
        nextOwned.push(bloom);
      }

      if (state.godrayGain > 0.001) {
        const godray = take<GodrayFilter>('godray') ?? markOwnedFilter(new GodrayFilter({
          time: 0,
          gain: 0,
          lacunarity: DEFAULT_POST_PROCESSING_SNAPSHOT.godrayLacunarity,
          angle: DEFAULT_POST_PROCESSING_SNAPSHOT.godrayAngle,
          parallel: true,
        }), 'godray');
        godray.gain = state.godrayGain;
        godray.lacunarity = state.godrayLacunarity;
        godray.angle = state.godrayAngle;
        // Reset the phase on every snapshot application. Playback/export owns
        // time, so target effects must not drift across seek/replay.
        godray.time = 0;
        godray.enabled = true;
        nextOwned.push(godray);
      }

      if (Math.abs(state.rgbSplitX) > 0.001 || Math.abs(state.rgbSplitY) > 0.001) {
        const rgbSplit = take<RGBSplitFilter>('rgbSplit') ?? markOwnedFilter(new RGBSplitFilter({
          red: [0, 0],
          green: [0, 0],
          blue: [0, 0],
        }), 'rgbSplit');
        rgbSplit.red = [state.rgbSplitX, state.rgbSplitY];
        rgbSplit.green = [0, 0];
        rgbSplit.blue = [-state.rgbSplitX, -state.rgbSplitY];
        rgbSplit.enabled = true;
        nextOwned.push(rgbSplit);
      }

      if (state.overlayIntensity > 0.001) {
        const overlay = take<TargetColorBlendFilter>('overlay') ?? markOwnedFilter(new TargetColorBlendFilter(), 'overlay');
        overlay.setOverlay(state.overlayColor, state.overlayBlendMode, state.overlayIntensity);
        nextOwned.push(overlay);
      }
    }

    for (const filter of ownedFilters) {
      destroyFilter(filter);
    }
    const filters = [...externalFilters, ...nextOwned];
    displayObject.filters = filters.length > 0 ? filters : null;
    (displayObject as any)._filtersDirty = true;
    return true;
  }

  private clearTarget(targetId: string): void {
    const displayObject = this.getTargetDisplayObject(targetId);
    if (!displayObject) return;
    const filters = ((displayObject.filters as PIXI.Filter[] | null) || []);
    const remaining = filters.filter((filter) => !isOwnedFilter(filter));
    filters.filter((filter) => isOwnedFilter(filter)).forEach(destroyFilter);
    displayObject.filters = remaining.length > 0 ? remaining : null;
    (displayObject as any)._filtersDirty = true;
  }
}

export const targetPostProcessingController = new TargetPostProcessingController();
export default TargetPostProcessingController;
