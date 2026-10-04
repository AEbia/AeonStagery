import type { BlendMode } from '../../api/types/blend-mode';
import type { SemanticStyleOverride } from '../../api/types/visual';
import type {
  LensFilterStack,
  ResolvedLensSlotState,
  ResolvedLensFilterTransition,
  ResolvedVisualState,
  VisualTimelineScene,
} from '../../services/visual-authoring/VisualStateResolver';
import { resolveVisualStateAtTime } from '../../services/visual-authoring/VisualStateResolver';
import {
  resolveLensRecipePayload,
  type BuiltInLensAtmosphereRecipe,
  type BuiltInLensGradeRecipe,
  type BuiltInLensOpticsRecipe,
  type BuiltInLensTextureRecipe,
} from './BuiltInVisualRecipeCatalog';

export interface VisualColorOverlaySpec {
  color: string;
  intensity: number;
  mode: BlendMode;
}

export interface VisualLightingOverlay {
  adjustment: {
    adjBrightness: number;
    adjBlue: number;
    adjContrast: number;
    adjGreen: number;
    adjRed: number;
    adjSaturation: number;
  };
  overlays: VisualColorOverlaySpec[];
  postProcessing: {
    bloomBloomScale: number;
    bloomBrightness: number;
    bloomThreshold?: number;
    godrayAngle?: number;
    godrayGain: number;
    rgbSplitX: number;
    rgbSplitY: number;
  };
}

const IDENTITY_ADJUSTMENT = {
  adjBrightness: 1,
  adjBlue: 1,
  adjContrast: 1,
  adjGreen: 1,
  adjRed: 1,
  adjSaturation: 1,
};

const EMPTY_POST = {
  bloomBloomScale: 0,
  bloomBrightness: 1,
  godrayGain: 0,
  rgbSplitX: 0,
  rgbSplitY: 0,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function amplifyIdentity(identity: number, target: number, amount: number): number {
  return identity + (target - identity) * amount;
}

function mergeSemanticOverride(
  baseline?: SemanticStyleOverride,
  latched?: SemanticStyleOverride,
  modulation?: SemanticStyleOverride,
): SemanticStyleOverride | undefined {
  const merged = {
    ...(baseline || {}),
    ...(latched || {}),
    ...(modulation || {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function getRecipeContext(slotState?: ResolvedLensSlotState): { recipeId?: string; semantics?: SemanticStyleOverride } {
  const recipeId = slotState?.latched?.recipeId || slotState?.baseline?.recipeId;
  const semantics = mergeSemanticOverride(
    slotState?.baseline?.semanticOverride,
    slotState?.latched?.semanticOverride,
    slotState?.modulation,
  );
  return { recipeId, semantics };
}

function normalizeRecipeId(recipeId?: string): string {
  return recipeId?.toLowerCase() || '';
}

function recipeWeight(semantics?: SemanticStyleOverride): number {
  return clamp(typeof semantics?.intensity === 'number' ? semantics.intensity : 1, 0, 1.5);
}

function resolveGradeAdjustment(scene: VisualTimelineScene | null, slotState?: ResolvedLensSlotState): VisualLightingOverlay['adjustment'] {
  const { recipeId, semantics } = getRecipeContext(slotState);
  const recipe = normalizeRecipeId(recipeId);
  const weight = recipeWeight(semantics);
  const target = { ...IDENTITY_ADJUSTMENT };
  const builtIn = resolveLensRecipePayload(scene?.visual, 'grade', recipeId) as BuiltInLensGradeRecipe | null;

  if (builtIn) {
    if (builtIn.brightness !== undefined) target.adjBrightness = builtIn.brightness;
    if (builtIn.contrast !== undefined) target.adjContrast = builtIn.contrast;
    if (builtIn.saturation !== undefined) target.adjSaturation = builtIn.saturation;
    if (builtIn.red !== undefined) target.adjRed = builtIn.red;
    if (builtIn.green !== undefined) target.adjGreen = builtIn.green;
    if (builtIn.blue !== undefined) target.adjBlue = builtIn.blue;
  }

  if (!builtIn && recipe.includes('cinematic')) {
    target.adjContrast = 1.14;
    target.adjSaturation = 1.05;
    target.adjBrightness = 0.98;
  }
  if (!builtIn && recipe.includes('dramatic')) {
    target.adjContrast = Math.max(target.adjContrast, 1.2);
    target.adjSaturation = Math.min(target.adjSaturation, 0.92);
    target.adjBrightness = Math.min(target.adjBrightness, 0.96);
  }
  if (!builtIn && recipe.includes('sepia')) {
    target.adjRed = 1.08;
    target.adjGreen = 1.02;
    target.adjBlue = 0.9;
    target.adjSaturation = 0.92;
  }
  if (!builtIn && (recipe.includes('night') || recipe.includes('cold') || recipe.includes('cool'))) {
    target.adjRed = Math.min(target.adjRed, 0.95);
    target.adjGreen = Math.min(target.adjGreen, 0.98);
    target.adjBlue = Math.max(target.adjBlue, 1.08);
    target.adjBrightness = Math.min(target.adjBrightness, 0.96);
  }
  if (!builtIn && (recipe.includes('warm') || recipe.includes('sunset') || recipe.includes('dawn') || recipe.includes('golden'))) {
    target.adjRed = Math.max(target.adjRed, 1.08);
    target.adjGreen = Math.max(target.adjGreen, 1.01);
    target.adjBlue = Math.min(target.adjBlue, 0.94);
  }
  if (!builtIn && recipe.includes('dim')) {
    target.adjBrightness = Math.min(target.adjBrightness, 0.9);
    target.adjSaturation = Math.min(target.adjSaturation, 0.94);
  }

  const warmth = clamp(typeof semantics?.warmth === 'number' ? semantics.warmth : 0, -1, 1);
  if (warmth !== 0) {
    target.adjRed *= 1 + warmth * 0.08;
    target.adjBlue *= 1 - warmth * 0.08;
  }

  return {
    adjBrightness: amplifyIdentity(1, target.adjBrightness, weight),
    adjBlue: amplifyIdentity(1, target.adjBlue, weight),
    adjContrast: amplifyIdentity(1, target.adjContrast, weight),
    adjGreen: amplifyIdentity(1, target.adjGreen, weight),
    adjRed: amplifyIdentity(1, target.adjRed, weight),
    adjSaturation: amplifyIdentity(1, target.adjSaturation, weight),
  };
}

function resolveOpticsPost(scene: VisualTimelineScene | null, slotState?: ResolvedLensSlotState): VisualLightingOverlay['postProcessing'] {
  const { recipeId, semantics } = getRecipeContext(slotState);
  const recipe = normalizeRecipeId(recipeId);
  const weight = recipeWeight(semantics);
  const builtIn = resolveLensRecipePayload(scene?.visual, 'optics', recipeId) as BuiltInLensOpticsRecipe | null;
  let bloomScale = 0;
  let bloomThreshold: number | undefined;
  let rgbSplit = 0;
  const hasSoftBloomKeyword =
    recipe.includes('bloom') ||
    recipe.includes('diffusion') ||
    recipe.includes('halation') ||
    recipe.includes('dream') ||
    recipe.includes('soft');
  const hasRgbSplitKeyword =
    recipe.includes('chromatic') ||
    recipe.includes('rgb') ||
    recipe.includes('aberration') ||
    recipe.includes('split');

  if (builtIn) {
    bloomScale = builtIn.bloomScale ?? bloomScale;
    bloomThreshold = builtIn.bloomThreshold;
    rgbSplit = builtIn.rgbSplit ?? rgbSplit;
  }

  if (!builtIn && hasSoftBloomKeyword) {
    bloomScale = 0.1;
    bloomThreshold = 0.74;
  }
  if (!builtIn && recipe.includes('cinematic')) {
    bloomScale = Math.max(bloomScale, 0.08);
    bloomThreshold = Math.min(bloomThreshold ?? 0.76, 0.72);
  }
  if (!builtIn && hasRgbSplitKeyword) {
    rgbSplit = 0.24;
  }

  if (typeof semantics?.bloom === 'number') {
    const bloomControl = clamp(semantics.bloom, 0, 1.5);
    bloomScale = bloomScale + bloomControl * 0.11;
    bloomThreshold = Math.min(bloomThreshold ?? 0.76, 0.74 - bloomControl * 0.04);
  }
  if (typeof semantics?.rgbSplit === 'number') {
    rgbSplit = Math.max(rgbSplit, clamp(Number(semantics.rgbSplit), 0, 1.5) * 0.52);
  }

  return {
    bloomBloomScale: bloomScale * weight,
    bloomBrightness: 1 + bloomScale * weight * 0.035,
    bloomThreshold,
    godrayGain: 0,
    rgbSplitX: rgbSplit * weight,
    rgbSplitY: rgbSplit * weight * 0.35,
  };
}

function shiftOverlayColor(base: string, warmth: number): string {
  if (warmth > 0.2) return '#f1dcc4';
  if (warmth < -0.2) return '#c8ddf6';
  return base;
}

function resolveAtmosphereOverlay(
  scene: VisualTimelineScene | null,
  slotState?: ResolvedLensSlotState,
): Pick<VisualLightingOverlay, 'overlays' | 'postProcessing'> {
  const { recipeId, semantics } = getRecipeContext(slotState);
  const recipe = normalizeRecipeId(recipeId);
  const weight = recipeWeight(semantics);
  const builtIn = resolveLensRecipePayload(scene?.visual, 'atmosphere', recipeId) as BuiltInLensAtmosphereRecipe | null;
  const overlays: VisualColorOverlaySpec[] = [];
  let godrayGain = 0;
  let godrayAngle: number | undefined;
  let bloomScale = 0;

  const warmth = clamp(typeof semantics?.warmth === 'number' ? semantics.warmth : 0, -1, 1);
  const blend = clamp(typeof semantics?.blend === 'number' ? semantics.blend : 0, 0, 1.5);
  const contamination = clamp(typeof semantics?.contamination === 'number' ? semantics.contamination : 0, 0, 1.5);
  const hasHazeKeyword = recipe.includes('haze') || recipe.includes('mist') || recipe.includes('fog') || recipe.includes('airy');
  const hasSmokeKeyword = recipe.includes('smoke') || recipe.includes('moody') || recipe.includes('dust');
  const hasGodrayKeyword = recipe.includes('godray') || recipe.includes('sunray') || recipe.includes('volumetric') || recipe.includes('dust');

  if (builtIn?.overlays?.length) {
    overlays.push(...builtIn.overlays.map(entry => ({
      color: shiftOverlayColor(entry.color, warmth),
      intensity: entry.intensity * weight + (entry.mode === 'screen' ? blend * 0.04 : contamination * 0.03),
      mode: entry.mode,
    })));
  }
  if (builtIn?.bloomScale !== undefined) {
    bloomScale = Math.max(bloomScale, builtIn.bloomScale * weight);
  }
  if (builtIn?.godrayGain !== undefined || builtIn?.godrayAngle !== undefined) {
    godrayAngle = builtIn.godrayAngle;
    godrayGain = builtIn.godrayGain !== undefined ? builtIn.godrayGain * weight : godrayGain;
  }
  if (builtIn?.bloomThreshold !== undefined && bloomScale <= 0) {
    bloomScale = 0.01;
  }
  if (builtIn?.bloomThreshold !== undefined) {
    // The built-in recipe explicitly controls the threshold even if bloom comes from semantics.
    bloomScale = Math.max(bloomScale, 0);
  }

  if (!builtIn && hasHazeKeyword) {
    overlays.push({
      color: shiftOverlayColor('#d7e6f5', warmth),
      intensity: 0.045 * weight + blend * 0.04,
      mode: 'screen',
    });
    bloomScale = Math.max(bloomScale, 0.06 * weight);
  }
  if (!builtIn && hasSmokeKeyword) {
    overlays.push({
      color: shiftOverlayColor('#253047', warmth * 0.5),
      intensity: 0.05 * weight + contamination * 0.04,
      mode: 'multiply',
    });
  }
  if (!builtIn && hasGodrayKeyword) {
    godrayGain = 0.12 * weight + contamination * 0.05;
    godrayAngle = warmth >= 0 ? 28 : 34;
  }

  if (!recipeId && (blend > 0 || contamination > 0)) {
    overlays.push({
      color: shiftOverlayColor('#dde7f2', warmth),
      intensity: blend * 0.035 + contamination * 0.025,
      mode: blend >= contamination ? 'screen' : 'multiply',
    });
  }

  return {
    overlays,
    postProcessing: {
      bloomBloomScale: bloomScale,
      bloomBrightness: 1 + bloomScale * 0.05,
      bloomThreshold: builtIn?.bloomThreshold ?? (bloomScale > 0 ? 0.72 : undefined),
      godrayAngle,
      godrayGain,
      rgbSplitX: 0,
      rgbSplitY: 0,
    },
  };
}

function resolveTextureAdjustment(
  scene: VisualTimelineScene | null,
  slotState?: ResolvedLensSlotState,
): Pick<VisualLightingOverlay, 'adjustment' | 'overlays'> {
  const { recipeId, semantics } = getRecipeContext(slotState);
  const recipe = normalizeRecipeId(recipeId);
  const weight = recipeWeight(semantics);
  const builtIn = resolveLensRecipePayload(scene?.visual, 'texture', recipeId) as BuiltInLensTextureRecipe | null;
  const adjustment = { ...IDENTITY_ADJUSTMENT };
  const overlays: VisualColorOverlaySpec[] = [];

  if (builtIn) {
    if (builtIn.contrast !== undefined) adjustment.adjContrast = builtIn.contrast;
    if (builtIn.saturation !== undefined) adjustment.adjSaturation = builtIn.saturation;
    if (builtIn.overlays?.length) {
      overlays.push(...builtIn.overlays.map(entry => ({
        ...entry,
        intensity: entry.intensity * weight,
      })));
    }
  }

  if (!builtIn && (recipe.includes('film') || recipe.includes('grain') || recipe.includes('analog'))) {
    adjustment.adjContrast = 1 + 0.04 * weight;
    adjustment.adjSaturation = 1 - 0.03 * weight;
    overlays.push({
      color: '#120f0c',
      intensity: 0.025 * weight,
      mode: 'multiply',
    });
  }

  return { adjustment, overlays };
}

function multiplyAdjustment(
  target: VisualLightingOverlay['adjustment'],
  source: VisualLightingOverlay['adjustment'],
): void {
  target.adjBrightness *= source.adjBrightness;
  target.adjBlue *= source.adjBlue;
  target.adjContrast *= source.adjContrast;
  target.adjGreen *= source.adjGreen;
  target.adjRed *= source.adjRed;
  target.adjSaturation *= source.adjSaturation;
}

function hasMeaningfulOverlay(overlay: VisualLightingOverlay): boolean {
  return (
    Math.abs(overlay.adjustment.adjBrightness - 1) > 0.001 ||
    Math.abs(overlay.adjustment.adjBlue - 1) > 0.001 ||
    Math.abs(overlay.adjustment.adjContrast - 1) > 0.001 ||
    Math.abs(overlay.adjustment.adjGreen - 1) > 0.001 ||
    Math.abs(overlay.adjustment.adjRed - 1) > 0.001 ||
    Math.abs(overlay.adjustment.adjSaturation - 1) > 0.001 ||
    overlay.postProcessing.bloomBloomScale > 0.001 ||
    Math.abs(overlay.postProcessing.bloomBrightness - 1) > 0.001 ||
    overlay.postProcessing.godrayGain > 0.001 ||
    Math.abs(overlay.postProcessing.rgbSplitX) > 0.001 ||
    Math.abs(overlay.postProcessing.rgbSplitY) > 0.001 ||
    overlay.overlays.length > 0
  );
}

function createIdentityOverlay(): VisualLightingOverlay {
  return {
    adjustment: { ...IDENTITY_ADJUSTMENT },
    overlays: [],
    postProcessing: { ...EMPTY_POST },
  };
}

function resolveLensFilterStackOverlay(
  scene: VisualTimelineScene | null,
  stack: LensFilterStack,
): VisualLightingOverlay | null {
  const overlay = createIdentityOverlay();
  const grade = stack.grade ? resolveGradeAdjustment(scene, { latched: stack.grade }) : { ...IDENTITY_ADJUSTMENT };
  multiplyAdjustment(overlay.adjustment, grade);

  const optics = stack.optics ? resolveOpticsPost(scene, { latched: stack.optics }) : { ...EMPTY_POST };
  overlay.postProcessing.bloomBloomScale += optics.bloomBloomScale;
  overlay.postProcessing.bloomBrightness *= optics.bloomBrightness;
  overlay.postProcessing.rgbSplitX += optics.rgbSplitX;
  overlay.postProcessing.rgbSplitY += optics.rgbSplitY;
  if (optics.bloomThreshold !== undefined) overlay.postProcessing.bloomThreshold = optics.bloomThreshold;

  const atmosphere = stack.atmosphere
    ? resolveAtmosphereOverlay(scene, { latched: stack.atmosphere })
    : { overlays: [], postProcessing: { ...EMPTY_POST } };
  overlay.postProcessing.bloomBloomScale += atmosphere.postProcessing.bloomBloomScale;
  overlay.postProcessing.bloomBrightness *= atmosphere.postProcessing.bloomBrightness;
  overlay.postProcessing.godrayGain += atmosphere.postProcessing.godrayGain;
  if (atmosphere.postProcessing.bloomThreshold !== undefined) {
    overlay.postProcessing.bloomThreshold = Math.min(
      overlay.postProcessing.bloomThreshold ?? atmosphere.postProcessing.bloomThreshold,
      atmosphere.postProcessing.bloomThreshold,
    );
  }
  if (atmosphere.postProcessing.godrayAngle !== undefined) {
    overlay.postProcessing.godrayAngle = atmosphere.postProcessing.godrayAngle;
  }
  overlay.overlays.push(...atmosphere.overlays);

  const texture = stack.texture
    ? resolveTextureAdjustment(scene, { latched: stack.texture })
    : { adjustment: { ...IDENTITY_ADJUSTMENT }, overlays: [] };
  multiplyAdjustment(overlay.adjustment, texture.adjustment);
  overlay.overlays.push(...texture.overlays);

  return hasMeaningfulOverlay(overlay) ? overlay : null;
}

function interpolateNumber(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

function interpolateOptionalNumber(from: number | undefined, to: number | undefined, progress: number): number | undefined {
  if (from === undefined && to === undefined) return undefined;
  return interpolateNumber(from ?? to ?? 0, to ?? from ?? 0, progress);
}

function parseHexColor(value: string): [number, number, number] | null {
  const normalized = value.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return null;
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function interpolateColor(from: string, to: string, progress: number): string {
  const fromRgb = parseHexColor(from);
  const toRgb = parseHexColor(to);
  if (!fromRgb || !toRgb) return progress < 0.5 ? from : to;
  return `#${[0, 1, 2]
    .map((index) => Math.round(interpolateNumber(fromRgb[index], toRgb[index], progress)).toString(16).padStart(2, '0'))
    .join('')}`;
}

function interpolateOverlayList(
  from: readonly VisualColorOverlaySpec[],
  to: readonly VisualColorOverlaySpec[],
  progress: number,
): VisualColorOverlaySpec[] {
  const usedFrom = new Set<number>();
  const pairs: Array<{ left?: VisualColorOverlaySpec; right?: VisualColorOverlaySpec }> = [];

  for (let index = 0; index < to.length; index += 1) {
    const right = to[index];
    let fromIndex = from.findIndex((candidate, candidateIndex) => (
      !usedFrom.has(candidateIndex) && candidate.mode === right.mode
    ));
    if (fromIndex < 0 && from[index] && !usedFrom.has(index)) fromIndex = index;
    if (fromIndex >= 0) usedFrom.add(fromIndex);
    pairs.push({ left: fromIndex >= 0 ? from[fromIndex] : undefined, right });
  }
  from.forEach((left, index) => {
    if (!usedFrom.has(index)) pairs.push({ left });
  });

  return pairs.map(({ left, right }) => {
    return {
      color: left && right
        ? interpolateColor(left.color, right.color, progress)
        : (right?.color ?? left?.color ?? '#ffffff'),
      intensity: interpolateNumber(
        left?.intensity ?? 0,
        right?.intensity ?? 0,
        progress,
      ),
      mode: right?.mode ?? left?.mode ?? 'screen',
    };
  }).filter((overlay) => overlay.intensity > 0.0001);
}

function interpolateVisualLightingOverlay(
  from: VisualLightingOverlay | null,
  to: VisualLightingOverlay | null,
  progress: number,
): VisualLightingOverlay | null {
  const left = from ?? createIdentityOverlay();
  const right = to ?? createIdentityOverlay();
  const overlay: VisualLightingOverlay = {
    adjustment: {
      adjBrightness: interpolateNumber(left.adjustment.adjBrightness, right.adjustment.adjBrightness, progress),
      adjBlue: interpolateNumber(left.adjustment.adjBlue, right.adjustment.adjBlue, progress),
      adjContrast: interpolateNumber(left.adjustment.adjContrast, right.adjustment.adjContrast, progress),
      adjGreen: interpolateNumber(left.adjustment.adjGreen, right.adjustment.adjGreen, progress),
      adjRed: interpolateNumber(left.adjustment.adjRed, right.adjustment.adjRed, progress),
      adjSaturation: interpolateNumber(left.adjustment.adjSaturation, right.adjustment.adjSaturation, progress),
    },
    overlays: interpolateOverlayList(left.overlays, right.overlays, progress),
    postProcessing: {
      bloomBloomScale: interpolateNumber(left.postProcessing.bloomBloomScale, right.postProcessing.bloomBloomScale, progress),
      bloomBrightness: interpolateNumber(left.postProcessing.bloomBrightness, right.postProcessing.bloomBrightness, progress),
      bloomThreshold: interpolateOptionalNumber(left.postProcessing.bloomThreshold, right.postProcessing.bloomThreshold, progress),
      godrayAngle: interpolateOptionalNumber(left.postProcessing.godrayAngle, right.postProcessing.godrayAngle, progress),
      godrayGain: interpolateNumber(left.postProcessing.godrayGain, right.postProcessing.godrayGain, progress),
      rgbSplitX: interpolateNumber(left.postProcessing.rgbSplitX, right.postProcessing.rgbSplitX, progress),
      rgbSplitY: interpolateNumber(left.postProcessing.rgbSplitY, right.postProcessing.rgbSplitY, progress),
    },
  };
  return hasMeaningfulOverlay(overlay) ? overlay : null;
}

function resolveLegacyVisualLightingOverlay(
  state: ResolvedVisualState,
  scene: VisualTimelineScene | null = null,
): VisualLightingOverlay | null {
  const overlay: VisualLightingOverlay = {
    adjustment: { ...IDENTITY_ADJUSTMENT },
    overlays: [],
    postProcessing: { ...EMPTY_POST },
  };

  multiplyAdjustment(overlay.adjustment, resolveGradeAdjustment(scene, state.lensSlots.grade));

  const optics = resolveOpticsPost(scene, state.lensSlots.optics);
  overlay.postProcessing.bloomBloomScale += optics.bloomBloomScale;
  overlay.postProcessing.bloomBrightness *= optics.bloomBrightness;
  overlay.postProcessing.rgbSplitX += optics.rgbSplitX;
  overlay.postProcessing.rgbSplitY += optics.rgbSplitY;
  if (optics.bloomThreshold !== undefined) {
    overlay.postProcessing.bloomThreshold = Math.min(
      overlay.postProcessing.bloomThreshold ?? optics.bloomThreshold,
      optics.bloomThreshold,
    );
  }

  const atmosphere = resolveAtmosphereOverlay(scene, state.lensSlots.atmosphere);
  overlay.postProcessing.bloomBloomScale += atmosphere.postProcessing.bloomBloomScale;
  overlay.postProcessing.bloomBrightness *= atmosphere.postProcessing.bloomBrightness;
  overlay.postProcessing.godrayGain += atmosphere.postProcessing.godrayGain;
  if (atmosphere.postProcessing.bloomThreshold !== undefined) {
    overlay.postProcessing.bloomThreshold = Math.min(
      overlay.postProcessing.bloomThreshold ?? atmosphere.postProcessing.bloomThreshold,
      atmosphere.postProcessing.bloomThreshold,
    );
  }
  if (atmosphere.postProcessing.godrayAngle !== undefined) {
    overlay.postProcessing.godrayAngle = atmosphere.postProcessing.godrayAngle;
  }
  overlay.overlays.push(...atmosphere.overlays);

  const texture = resolveTextureAdjustment(scene, state.lensSlots.texture);
  multiplyAdjustment(overlay.adjustment, texture.adjustment);
  overlay.overlays.push(...texture.overlays);

  return hasMeaningfulOverlay(overlay) ? overlay : null;
}

export function resolveVisualLightingOverlay(
  state: ResolvedVisualState,
  scene: VisualTimelineScene | null = null,
): VisualLightingOverlay | null {
  if (state.lensFilterStack) {
    if (state.lensFilterTransition) {
      const transition: ResolvedLensFilterTransition = state.lensFilterTransition;
      return interpolateVisualLightingOverlay(
        resolveLensFilterStackOverlay(scene, transition.from),
        resolveLensFilterStackOverlay(scene, transition.to),
        transition.progress,
      );
    }
    return resolveLensFilterStackOverlay(scene, state.lensFilterStack);
  }
  return resolveLegacyVisualLightingOverlay(state, scene);
}

export function resolveVisualLightingOverlayAtTime(scene: VisualTimelineScene, time: number): VisualLightingOverlay | null {
  return resolveVisualLightingOverlay(resolveVisualStateAtTime(scene, time), scene);
}
