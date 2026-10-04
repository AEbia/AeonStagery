import type { RuntimeTimelineAction } from './RuntimeTimelineScene';
import type { VisualLightingOverlay } from './visual-runtime/VisualRuntimeResolver';
import { normalizeBlendMode, type BlendMode } from '../api/types/blend-mode';

export type LightingPresetName =
  | 'normal'
  | 'sunset'
  | 'night'
  | 'dawn'
  | 'spotlight'
  | 'dramatic'
  | 'sepia'
  | 'cold'
  | 'warm'
  | 'dim';

export interface LightingBlurSnapshot {
  global: number;
  background: number;
  characters: number;
}

export interface LightingPostProcessingSnapshot {
  bloomThreshold: number;
  bloomBloomScale: number;
  bloomBrightness: number;
  rgbSplitX: number;
  rgbSplitY: number;
  godrayGain: number;
  godrayLacunarity: number;
  godrayAngle: number;
  adjGamma: number;
  adjContrast: number;
  adjSaturation: number;
  adjBrightness: number;
  adjRed: number;
  adjGreen: number;
  adjBlue: number;
  /** Integrated post-processing overlay fields. */
  overlayColor: number | string;
  overlayBlendMode: BlendMode;
  overlayIntensity: number;
}

export interface LightingColorOverlaySnapshot {
  id: string;
  color: number | string;
  mode: BlendMode;
  alpha: number;
}

export interface LightingPointLightSnapshot {
  id: string;
  x: number;
  y: number;
  color: number | string;
  radius: number;
  alpha: number;
}

export interface LightingSnapshot {
  preset: { name: LightingPresetName; intensity: number };
  presetWeights: Record<LightingPresetName, number>;
  blur: LightingBlurSnapshot;
  postProcessing: LightingPostProcessingSnapshot;
  /** Post-processing state for character/environment targets keyed by ID. */
  postProcessingTargets: Record<string, LightingPostProcessingSnapshot>;
  colorOverlays: LightingColorOverlaySnapshot[];
  pointLights: LightingPointLightSnapshot[];
  visualOverlay: VisualLightingOverlay | null;
}

export const DEFAULT_POST_PROCESSING_SNAPSHOT: LightingPostProcessingSnapshot = {
  bloomThreshold: 0.5,
  bloomBloomScale: 0,
  bloomBrightness: 1,
  rgbSplitX: 0,
  rgbSplitY: 0,
  godrayGain: 0,
  godrayLacunarity: 2.5,
  godrayAngle: 30,
  adjGamma: 1,
  adjContrast: 1,
  adjSaturation: 1,
  adjBrightness: 1,
  adjRed: 1,
  adjGreen: 1,
  adjBlue: 1,
  // White is neutral for the default multiply blend and prevents an
  // intensity-only edit from unexpectedly blacking out the target.
  overlayColor: '#ffffff',
  overlayBlendMode: 'multiply',
  overlayIntensity: 0,
};

export const DEFAULT_BLUR_SNAPSHOT: LightingBlurSnapshot = {
  global: 0,
  background: 0,
  characters: 0,
};

export const LIGHTING_PRESET_NAMES: LightingPresetName[] = [
  'normal',
  'sunset',
  'night',
  'dawn',
  'spotlight',
  'dramatic',
  'sepia',
  'cold',
  'warm',
  'dim',
];

export function createEmptyPresetWeights(): Record<LightingPresetName, number> {
  return {
    normal: 0,
    sunset: 0,
    night: 0,
    dawn: 0,
    spotlight: 0,
    dramatic: 0,
    sepia: 0,
    cold: 0,
    warm: 0,
    dim: 0,
  };
}

export function createDefaultLightingSnapshot(
  visualOverlay: VisualLightingOverlay | null = null,
): LightingSnapshot {
  return {
    preset: { name: 'normal', intensity: 0 },
    presetWeights: createEmptyPresetWeights(),
    blur: { ...DEFAULT_BLUR_SNAPSHOT },
    postProcessing: { ...DEFAULT_POST_PROCESSING_SNAPSHOT },
    postProcessingTargets: {},
    colorOverlays: [],
    pointLights: [],
    visualOverlay,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function sanitizeOverlayMode(value: unknown): BlendMode {
  return normalizeBlendMode(value, 'multiply');
}

function sanitizeColor(value: unknown, fallback: number | string): number | string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^#?[0-9a-fA-F]{6}$/.test(trimmed)) {
      return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
    }
  }
  return fallback;
}

function determineDominantPreset(weights: Record<LightingPresetName, number>): { name: LightingPresetName; intensity: number } {
  let name: LightingPresetName = 'normal';
  let intensity = 0;
  for (const preset of LIGHTING_PRESET_NAMES) {
    const value = weights[preset];
    if (value > intensity) {
      name = preset;
      intensity = value;
    }
  }
  return { name, intensity };
}

function interpolateNumber(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function applyExclusivePresetTransition(
  weights: Record<LightingPresetName, number>,
  targetPreset: LightingPresetName,
  targetIntensity: number,
  progress: number,
): void {
  const startWeights = { ...weights };
  for (const preset of LIGHTING_PRESET_NAMES) {
    const start = startWeights[preset];
    const end = preset === targetPreset ? targetIntensity : 0;
    weights[preset] = interpolateNumber(start, end, progress);
  }
}

function applyPartialPostProcessing(
  state: LightingPostProcessingSnapshot,
  params: Partial<Record<keyof LightingPostProcessingSnapshot, unknown>>,
  progress: number,
): void {
  const start = { ...state };
  const numericKeys: Array<Exclude<keyof LightingPostProcessingSnapshot, 'overlayColor' | 'overlayBlendMode'>> = [
    'bloomThreshold',
    'bloomBloomScale',
    'bloomBrightness',
    'rgbSplitX',
    'rgbSplitY',
    'godrayGain',
    'godrayLacunarity',
    'godrayAngle',
    'adjGamma',
    'adjContrast',
    'adjSaturation',
    'adjBrightness',
    'adjRed',
    'adjGreen',
    'adjBlue',
    'overlayIntensity',
  ];
  for (const key of numericKeys) {
    const next = params[key];
    if (isFiniteNumber(next)) {
      state[key] = interpolateNumber(start[key], next, progress);
    }
  }
  if (params.overlayColor !== undefined) {
    state.overlayColor = sanitizeColor(params.overlayColor, start.overlayColor);
  }
  if (params.overlayBlendMode !== undefined) {
    state.overlayBlendMode = sanitizeOverlayMode(params.overlayBlendMode);
  }
}

function applyBlurTransition(
  blur: LightingBlurSnapshot,
  targetKey: keyof LightingBlurSnapshot,
  targetValue: number,
  progress: number,
): void {
  const start = blur[targetKey];
  blur[targetKey] = interpolateNumber(start, targetValue, progress);
}

function sanitizePostProcessingState(state: LightingPostProcessingSnapshot): LightingPostProcessingSnapshot {
  const next = { ...DEFAULT_POST_PROCESSING_SNAPSHOT, ...state };
  const numericKeys: Array<Exclude<keyof LightingPostProcessingSnapshot, 'overlayColor' | 'overlayBlendMode'>> = [
    'bloomThreshold',
    'bloomBloomScale',
    'bloomBrightness',
    'rgbSplitX',
    'rgbSplitY',
    'godrayGain',
    'godrayLacunarity',
    'godrayAngle',
    'adjGamma',
    'adjContrast',
    'adjSaturation',
    'adjBrightness',
    'adjRed',
    'adjGreen',
    'adjBlue',
  ];
  for (const key of numericKeys) {
    if (!isFiniteNumber(next[key])) {
      next[key] = DEFAULT_POST_PROCESSING_SNAPSHOT[key];
    }
  }
  next.overlayColor = sanitizeColor(next.overlayColor, DEFAULT_POST_PROCESSING_SNAPSHOT.overlayColor);
  next.overlayBlendMode = sanitizeOverlayMode(next.overlayBlendMode);
  next.overlayIntensity = isFiniteNumber(next.overlayIntensity)
    ? clamp(next.overlayIntensity, 0, 1)
    : DEFAULT_POST_PROCESSING_SNAPSHOT.overlayIntensity;
  return next;
}

function sanitizeSnapshot(snapshot: LightingSnapshot): LightingSnapshot {
  const next: LightingSnapshot = {
    ...snapshot,
    presetWeights: {
      ...createEmptyPresetWeights(),
      ...(snapshot.presetWeights || {}),
    },
    blur: {
      global: isFiniteNumber(snapshot.blur.global) ? Math.max(0, snapshot.blur.global) : 0,
      background: isFiniteNumber(snapshot.blur.background) ? Math.max(0, snapshot.blur.background) : 0,
      characters: isFiniteNumber(snapshot.blur.characters) ? Math.max(0, snapshot.blur.characters) : 0,
    },
    postProcessing: sanitizePostProcessingState(snapshot.postProcessing),
    postProcessingTargets: Object.fromEntries(
      Object.entries(snapshot.postProcessingTargets || {})
        .filter(([target]) => target !== 'panorama' && typeof target === 'string' && target.length > 0)
        .map(([target, state]) => [target, sanitizePostProcessingState(state)]),
    ),
    colorOverlays: snapshot.colorOverlays
      .filter((entry) => isFiniteNumber(entry.alpha) && entry.alpha > 0.001)
      .map((entry, index) => ({
        id: typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : `legacy-overlay-${index}`,
        color: sanitizeColor(entry.color, '#000000'),
        mode: sanitizeOverlayMode(entry.mode),
        alpha: clamp(entry.alpha, 0, 1),
      })),
    pointLights: snapshot.pointLights
      .filter((entry) => isFiniteNumber(entry.alpha) && entry.alpha > 0.001 && isFiniteNumber(entry.radius) && entry.radius > 0)
      .map((entry, index) => ({
        id: typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : `legacy-point-light-${index}`,
        x: isFiniteNumber(entry.x) ? entry.x : 960,
        y: isFiniteNumber(entry.y) ? entry.y : 540,
        color: sanitizeColor(entry.color, '#ffffff'),
        radius: Math.max(1, entry.radius),
        alpha: clamp(entry.alpha, 0, 1),
      })),
  };
  next.preset = determineDominantPreset(next.presetWeights);
  return next;
}

/**
 * Fill fields introduced by newer runtime snapshots while preserving older snapshots.
 */
export function normalizeLightingSnapshot(snapshot: LightingSnapshot | null | undefined): LightingSnapshot {
  const defaults = createDefaultLightingSnapshot();
  const source = snapshot ?? defaults;

  return sanitizeSnapshot({
    ...defaults,
    ...source,
    presetWeights: {
      ...defaults.presetWeights,
      ...(source.presetWeights || {}),
    },
    blur: {
      ...defaults.blur,
      ...(source.blur || {}),
    },
    postProcessing: {
      ...defaults.postProcessing,
      ...(source.postProcessing || {}),
    },
    postProcessingTargets: {
      ...(source.postProcessingTargets || {}),
    },
    colorOverlays: Array.isArray(source.colorOverlays) ? source.colorOverlays : [],
    pointLights: Array.isArray(source.pointLights) ? source.pointLights : [],
    visualOverlay: source.visualOverlay ?? null,
  } as LightingSnapshot);
}

export function deriveLightingSnapshotAtTime(
  time: number,
  timeline: readonly RuntimeTimelineAction[],
  visualOverlay: VisualLightingOverlay | null = null,
): LightingSnapshot {
  const snapshot = createDefaultLightingSnapshot(visualOverlay);
  const targetPostProcessing = snapshot.postProcessingTargets;
  const activeColorOverlays = new Map<string, LightingColorOverlaySnapshot>();
  const activePointLights = new Map<string, LightingPointLightSnapshot>();
  const orderedTimeline = timeline
    .map((action, index) => ({ action, index }))
    .sort((a, b) => ((a.action.time || 0) - (b.action.time || 0)) || (a.index - b.index));

  for (const { action, index } of orderedTimeline) {
    const startTime = action.time || 0;
    if (startTime > time) break;

    const params = action.params || {};
    const duration = isFiniteNumber(params.duration) ? Math.max(0, params.duration) : 0;
    const progress = duration > 0
      ? clamp((time - startTime) / duration, 0, 1)
      : time >= startTime ? 1 : 0;

    switch (action.action) {
      case 'setLighting': {
        const preset = LIGHTING_PRESET_NAMES.includes(params.preset as LightingPresetName)
          ? (params.preset as LightingPresetName)
          : 'normal';
        const intensity = isFiniteNumber(params.intensity) ? clamp(params.intensity, 0, 1) : 0.8;
        applyExclusivePresetTransition(
          snapshot.presetWeights,
          preset,
          preset === 'normal' ? 0 : intensity,
          progress,
        );
        break;
      }

      case 'resetLighting': {
        applyExclusivePresetTransition(snapshot.presetWeights, 'normal', 0, progress);
        break;
      }

      case 'setBlur': {
        const target = params.target === 'background' || params.target === 'characters' ? params.target : 'global';
        const intensity = isFiniteNumber(params.intensity) ? Math.max(0, params.intensity) : 5;
        applyBlurTransition(snapshot.blur, target, intensity, progress);
        break;
      }

      case 'resetBlur': {
        const target = params.target === 'global' || params.target === 'background' || params.target === 'characters'
          ? params.target
          : 'all';
        const targets: Array<keyof LightingBlurSnapshot> = target === 'all'
          ? ['global', 'background', 'characters']
          : [target];
        for (const key of targets) {
          applyBlurTransition(snapshot.blur, key, 0, progress);
        }
        break;
      }

      case 'setPostProcessing': {
        const rawParams = (params.proxyParams && typeof params.proxyParams === 'object')
          ? params.proxyParams as Partial<Record<keyof LightingPostProcessingSnapshot, unknown>>
          : params as Partial<Record<keyof LightingPostProcessingSnapshot, unknown>>;
        const targetParam = params.target ?? (rawParams as Record<string, unknown>).target;
        const target = typeof targetParam === 'string' && targetParam.trim()
          ? targetParam.trim()
          : 'panorama';
        const targetState = target === 'panorama'
          ? snapshot.postProcessing
          : (targetPostProcessing[target] ??= { ...DEFAULT_POST_PROCESSING_SNAPSHOT });
        applyPartialPostProcessing(targetState, rawParams, progress);
        break;
      }

      case 'resetPostProcessing': {
        const target = typeof params.target === 'string' && params.target.trim()
          ? params.target.trim()
          : 'panorama';
        const targetState = target === 'panorama'
          ? snapshot.postProcessing
          : (targetPostProcessing[target] ??= { ...DEFAULT_POST_PROCESSING_SNAPSHOT });
        applyPartialPostProcessing(targetState, DEFAULT_POST_PROCESSING_SNAPSHOT, progress);
        break;
      }

      case 'setGodrays': {
        const start = { ...snapshot.postProcessing };
        const intensity = isFiniteNumber(params.intensity) ? Math.max(0, params.intensity) : 0.5;
        const angle = isFiniteNumber(params.angle) ? params.angle : 30;
        const lacunarity = isFiniteNumber(params.lacunarity) ? params.lacunarity : DEFAULT_POST_PROCESSING_SNAPSHOT.godrayLacunarity;
        snapshot.postProcessing.godrayGain = interpolateNumber(start.godrayGain, intensity, progress);
        snapshot.postProcessing.godrayAngle = interpolateNumber(start.godrayAngle, angle, progress);
        snapshot.postProcessing.godrayLacunarity = interpolateNumber(start.godrayLacunarity, lacunarity, progress);
        break;
      }

      case 'resetGodrays': {
        const start = { ...snapshot.postProcessing };
        snapshot.postProcessing.godrayGain = interpolateNumber(start.godrayGain, 0, progress);
        snapshot.postProcessing.godrayLacunarity = interpolateNumber(start.godrayLacunarity, DEFAULT_POST_PROCESSING_SNAPSHOT.godrayLacunarity, progress);
        snapshot.postProcessing.godrayAngle = interpolateNumber(start.godrayAngle, DEFAULT_POST_PROCESSING_SNAPSHOT.godrayAngle, progress);
        break;
      }

      case 'addColorOverlay': {
        const id = typeof params.id === 'string' && params.id.length > 0 ? params.id : `legacy-overlay-${index}`;
        const previous = activeColorOverlays.get(id);
        const targetAlpha = isFiniteNumber(params.intensity)
          ? clamp(params.intensity, 0, 1)
          : previous?.alpha ?? 0.5;
        const alpha = interpolateNumber(previous?.alpha ?? 0, targetAlpha, progress);
        activeColorOverlays.set(id, {
          id,
          color: sanitizeColor(params.color, previous?.color ?? '#000000'),
          mode: sanitizeOverlayMode(params.mode ?? previous?.mode),
          alpha,
        });
        break;
      }

      case 'removeColorOverlay': {
        const id = typeof params.id === 'string'
          ? params.id
          : activeColorOverlays.size === 1
            ? activeColorOverlays.keys().next().value
            : undefined;
        if (!id) break;
        if (duration <= 0 || progress >= 1) {
          activeColorOverlays.delete(id);
          break;
        }
        const previous = activeColorOverlays.get(id);
        if (previous) {
          const nextAlpha = previous.alpha * (1 - progress);
          if (nextAlpha <= 0.001) activeColorOverlays.delete(id);
          else activeColorOverlays.set(id, { ...previous, alpha: nextAlpha });
        }
        break;
      }

      case 'clearColorOverlays':
        if (duration <= 0 || progress >= 1) {
          activeColorOverlays.clear();
          break;
        }
        for (const [id, overlay] of activeColorOverlays) {
          const nextAlpha = overlay.alpha * (1 - progress);
          if (nextAlpha <= 0.001) activeColorOverlays.delete(id);
          else activeColorOverlays.set(id, { ...overlay, alpha: nextAlpha });
        }
        break;

      case 'addPointLight': {
        const id = typeof params.id === 'string' && params.id.length > 0 ? params.id : `legacy-point-light-${index}`;
        const previous = activePointLights.get(id);
        const radius = isFiniteNumber(params.radius) ? params.radius : previous?.radius ?? 400;
        const targetAlpha = isFiniteNumber(params.intensity)
          ? clamp(params.intensity, 0, 1)
          : previous?.alpha ?? 0.8;
        const alpha = interpolateNumber(previous?.alpha ?? 0, targetAlpha, progress);
        if (radius > 0) {
          activePointLights.set(id, {
            id,
            x: isFiniteNumber(params.x) ? params.x : previous?.x ?? 960,
            y: isFiniteNumber(params.y) ? params.y : previous?.y ?? 540,
            color: sanitizeColor(params.color, previous?.color ?? '#ffffff'),
            radius,
            alpha,
          });
        }
        break;
      }

      case 'removePointLight': {
        const id = typeof params.id === 'string'
          ? params.id
          : activePointLights.size === 1
            ? activePointLights.keys().next().value
            : undefined;
        if (!id) break;
        if (duration <= 0 || progress >= 1) {
          activePointLights.delete(id);
          break;
        }
        const previous = activePointLights.get(id);
        if (previous) {
          const nextAlpha = previous.alpha * (1 - progress);
          if (nextAlpha <= 0.001) activePointLights.delete(id);
          else activePointLights.set(id, { ...previous, alpha: nextAlpha });
        }
        break;
      }

      case 'clearPointLights': {
        if (duration <= 0 || progress >= 1) {
          activePointLights.clear();
          break;
        }
        for (const [id, light] of activePointLights) {
          const nextAlpha = light.alpha * (1 - progress);
          if (nextAlpha <= 0.001) activePointLights.delete(id);
          else activePointLights.set(id, { ...light, alpha: nextAlpha });
        }
        break;
      }
    }
  }

  snapshot.colorOverlays = [...activeColorOverlays.values()];
  snapshot.pointLights = [...activePointLights.values()];
  snapshot.preset = determineDominantPreset(snapshot.presetWeights);

  return sanitizeSnapshot(snapshot);
}
