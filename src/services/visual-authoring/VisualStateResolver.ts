import type {
  CompositeSlot,
  LensStyleBaseline,
  LensStyleSlot,
  ObjectCompositeBaseline,
  SceneVisualBlock,
  SemanticStyleOverride,
  SlotRecipeState,
  VisualTargetId,
} from '../../api/types/visual';
import type { BlendMode } from '../../api/types/blend-mode';
import { getLensFilterCategory } from '../../engine/visual-runtime/BuiltInVisualRecipeCatalog';
import {
  resolveLensSegmentAtTime,
  type LensSegmentScene,
  type LensSegmentTimelineAction,
  type ResolvedLensSegment,
} from './LensSegmentResolver';

export interface VisualTimelineAction extends LensSegmentTimelineAction {
  readonly action: string;
}

export interface VisualTimelineScene extends LensSegmentScene {
  readonly visual?: SceneVisualBlock;
  readonly timeline: readonly VisualTimelineAction[];
}

type CueMode = 'latching' | 'envelope';

interface CueOverrideParams {
  recipeId?: string;
  mode?: CueMode;
  duration?: number;
  intensity?: number;
  brightness?: number;
  warmth?: number;
  bloom?: number;
  rgbSplit?: number;
  blend?: number;
  contamination?: number;
  color?: string;
  colorStops?: string[];
  colorBlendMode?: BlendMode;
  semanticOverride?: SemanticStyleOverride;
}

interface CompositeCueParams extends CueOverrideParams {
  targetId: VisualTargetId;
  slot: CompositeSlot;
}

export interface ResolvedLensSlotState {
  baseline?: SlotRecipeState;
  latched?: SlotRecipeState;
  modulation?: SemanticStyleOverride;
}

/** @deprecated Runtime compatibility state for historical lens filter actions. */
export type LensFilterStack = Partial<Record<LensStyleSlot, SlotRecipeState>>;

export interface ResolvedLensFilterTransition {
  readonly from: LensFilterStack;
  readonly to: LensFilterStack;
  readonly progress: number;
}

export interface ResolvedCompositeSlotState extends ResolvedLensSlotState {}

export interface ResolvedCompositeTargetState {
  baseline?: ObjectCompositeBaseline;
  slots: Partial<Record<CompositeSlot, ResolvedCompositeSlotState>>;
}

export interface ResolvedVisualState {
  segment: ResolvedLensSegment;
  segmentBaseline?: LensStyleBaseline;
  lensSlots: Partial<Record<LensStyleSlot, ResolvedLensSlotState>>;
  /** Present once a v3 filter statement has been applied at or before the sample time. */
  lensFilterStack?: LensFilterStack;
  lensFilterTransition?: ResolvedLensFilterTransition;
  compositeTargets: Partial<Record<VisualTargetId, ResolvedCompositeTargetState>>;
}

function toSemanticOverride(params: CueOverrideParams, allowBrightness: boolean): SemanticStyleOverride | undefined {
  if (params.semanticOverride) {
    const override = { ...params.semanticOverride };
    if (!allowBrightness) delete override.brightness;
    return Object.keys(override).length > 0 ? override : undefined;
  }
  const override: SemanticStyleOverride = {};
  if (params.intensity !== undefined) override.intensity = params.intensity;
  if (allowBrightness && params.brightness !== undefined) override.brightness = params.brightness;
  if (params.warmth !== undefined) override.warmth = params.warmth;
  if (params.bloom !== undefined) override.bloom = params.bloom;
  if (params.rgbSplit !== undefined) override.rgbSplit = params.rgbSplit;
  if (params.blend !== undefined) override.blend = params.blend;
  if (params.contamination !== undefined) override.contamination = params.contamination;
  if (params.color !== undefined) override.color = params.color;
  if (params.colorStops !== undefined) override.colorStops = params.colorStops;
  if (params.colorBlendMode !== undefined) override.colorBlendMode = params.colorBlendMode;
  return Object.keys(override).length > 0 ? override : undefined;
}

function ensureCompositeTargetState(
  state: ResolvedVisualState,
  visual: SceneVisualBlock | undefined,
  targetId: VisualTargetId,
): ResolvedCompositeTargetState {
  state.compositeTargets[targetId] ??= {
    baseline: visual?.visualTargets?.[targetId]?.objectCompositeBaseline,
    slots: {},
  };
  return state.compositeTargets[targetId]!;
}

function applyCompositeRecipeCue(
  state: ResolvedVisualState,
  visual: SceneVisualBlock | undefined,
  action: VisualTimelineAction,
): void {
  const params = action.params as CompositeCueParams;
  const targetState = ensureCompositeTargetState(state, visual, params.targetId);
  const slotState = targetState.slots[params.slot] ?? { baseline: targetState.baseline?.[params.slot] };
  slotState.latched = {
    recipeId: params.recipeId || slotState.latched?.recipeId || slotState.baseline?.recipeId || 'builtin:default-integration',
    semanticOverride: toSemanticOverride(params, params.slot === 'integration'),
  };
  targetState.slots[params.slot] = slotState;
}

function applyCompositeResetCue(
  state: ResolvedVisualState,
  visual: SceneVisualBlock | undefined,
  action: VisualTimelineAction,
): void {
  const params = action.params as Pick<CompositeCueParams, 'targetId' | 'slot'>;
  const targetState = ensureCompositeTargetState(state, visual, params.targetId);
  const baseline = targetState.baseline?.[params.slot];
  targetState.slots[params.slot] = baseline
    ? { baseline }
    : {};
}

function applyCompositeModulation(
  state: ResolvedVisualState,
  visual: SceneVisualBlock | undefined,
  action: VisualTimelineAction,
  time: number,
): void {
  const params = action.params as CompositeCueParams;
  const start = action.time ?? 0;
  const duration = params.duration ?? 0;
  if (time < start || time >= start + duration) return;
  const targetState = ensureCompositeTargetState(state, visual, params.targetId);
  const slotState = targetState.slots[params.slot] ?? { baseline: targetState.baseline?.[params.slot] };
  slotState.modulation = toSemanticOverride(params, params.slot === 'integration');
  targetState.slots[params.slot] = slotState;
}

function cloneLensFilterStack(stack: LensFilterStack): LensFilterStack {
  const clone: LensFilterStack = {};
  for (const [category, state] of Object.entries(stack) as Array<[LensStyleSlot, SlotRecipeState]>) {
    clone[category] = {
      recipeId: state.recipeId,
      ...(state.semanticOverride ? { semanticOverride: { ...state.semanticOverride } } : {}),
      ...(state.advancedOverride ? { advancedOverride: { ...state.advancedOverride } } : {}),
    };
  }
  return clone;
}

function toLensFilterStack(baseline?: LensStyleBaseline): LensFilterStack {
  return baseline ? cloneLensFilterStack(baseline) : {};
}

function resolveFilterOverride(params: Record<string, any>): SemanticStyleOverride | undefined {
  const override: SemanticStyleOverride = {};
  for (const key of ['intensity', 'warmth', 'bloom', 'rgbSplit', 'blend', 'contamination'] as const) {
    if (typeof params[key] === 'number' && Number.isFinite(params[key])) override[key] = params[key];
  }
  return Object.keys(override).length > 0 ? override : undefined;
}

function sameRecipe(left: string | undefined, right: string | undefined): boolean {
  return !!left && !!right && left.toLowerCase() === right.toLowerCase();
}

function findFilterCategory(stack: LensFilterStack, recipeId: string | undefined): LensStyleSlot | undefined {
  if (!recipeId) return undefined;
  for (const [category, state] of Object.entries(stack) as Array<[LensStyleSlot, SlotRecipeState]>) {
    if (sameRecipe(state.recipeId, recipeId)) return category;
  }
  return undefined;
}

/** @deprecated Resolve historical lens filter actions for playback compatibility. */
function resolveLensFilterStackAtTime(
  scene: VisualTimelineScene,
  segmentBaseline: LensStyleBaseline | undefined,
  segmentStart: number,
  time: number,
): { stack?: LensFilterStack; transition?: ResolvedLensFilterTransition } {
  let stack = toLensFilterStack(segmentBaseline);
  let hasFilterAction = false;
  let transition: ResolvedLensFilterTransition | undefined;
  const baseline = toLensFilterStack(segmentBaseline);

  const filterActions = scene.timeline
    .filter((action) => ['addLensFilter', 'changeLensFilter', 'resetLensFilters'].includes(action.action))
    .sort((left, right) => (left.time ?? 0) - (right.time ?? 0));

  for (const action of filterActions) {
    const actionTime = action.time ?? 0;
    if (actionTime > time) break;
    if (actionTime < segmentStart) continue;

    hasFilterAction = true;
    const params = action.params as Record<string, any>;
    const from = cloneLensFilterStack(stack);
    const to = cloneLensFilterStack(stack);
    const duration = Math.max(0, Number(params.duration) || 0);

    if (action.action === 'addLensFilter') {
      const category = resolveFilterCategory(scene, params.category, params.recipeId);
      if (!category || !params.recipeId) continue;
      to[category] = {
        recipeId: params.recipeId,
        ...(resolveFilterOverride(params) ? { semanticOverride: resolveFilterOverride(params) } : {}),
      };
    } else if (action.action === 'changeLensFilter') {
      const fromCategory = resolveFilterCategory(scene, params.fromCategory, params.fromRecipeId)
        ?? findFilterCategory(to, params.fromRecipeId);
      const category = resolveFilterCategory(scene, params.category, params.recipeId);
      if (!fromCategory || !category || !params.recipeId) continue;
      delete to[fromCategory];
      to[category] = {
        recipeId: params.recipeId,
        ...(resolveFilterOverride(params) ? { semanticOverride: resolveFilterOverride(params) } : {}),
      };
    } else {
      for (const category of Object.keys(to) as LensStyleSlot[]) delete to[category];
      Object.assign(to, cloneLensFilterStack(baseline));
    }

    if (time < actionTime + duration && duration > 0) {
      transition = {
        from,
        to,
        progress: Math.min(1, Math.max(0, (time - actionTime) / duration)),
      };
    } else {
      stack = to;
      transition = undefined;
    }
  }

  return hasFilterAction
    ? { stack, ...(transition ? { transition } : {}) }
    : {};
}

function resolveFilterCategory(
  scene: VisualTimelineScene,
  category: unknown,
  recipeId: unknown,
): LensStyleSlot | undefined {
  if (category === 'grade' || category === 'optics' || category === 'atmosphere' || category === 'texture') {
    return category;
  }
  return typeof recipeId === 'string'
    ? getLensFilterCategory(scene.visual, recipeId) ?? undefined
    : undefined;
}

export function resolveVisualStateAtTime(scene: VisualTimelineScene, time: number): ResolvedVisualState {
  const visual = scene.visual;
  const segment = resolveLensSegmentAtTime(scene, time);
  const segmentRecord = visual?.segments?.[segment.segmentId];

  const state: ResolvedVisualState = {
    segment,
    segmentBaseline: segmentRecord?.lensStyleBaseline,
    lensSlots: {},
    compositeTargets: {},
  };

  if (segmentRecord?.lensStyleBaseline) {
    for (const [slot, baseline] of Object.entries(segmentRecord.lensStyleBaseline) as Array<[LensStyleSlot, SlotRecipeState]>) {
      state.lensSlots[slot] = { baseline };
    }
  }

  for (const action of scene.timeline) {
    const actionTime = action.time ?? 0;
    if (actionTime > time) break;

    switch (action.action) {
      case 'setCompositeRecipe':
        applyCompositeRecipeCue(state, visual, action);
        break;
      case 'modulateComposite':
        applyCompositeModulation(state, visual, action, time);
        break;
      case 'resetCompositeRecipe':
        applyCompositeResetCue(state, visual, action);
        break;
      default:
        break;
    }
  }

  const filterResolution = resolveLensFilterStackAtTime(scene, segmentRecord?.lensStyleBaseline, segment.start, time);
  if (filterResolution.stack) state.lensFilterStack = filterResolution.stack;
  if (filterResolution.transition) state.lensFilterTransition = filterResolution.transition;

  return state;
}
