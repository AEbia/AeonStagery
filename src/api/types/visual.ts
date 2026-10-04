import type { BlendMode } from './blend-mode';

export type VisualTargetId = string;
export type SegmentId = string;
export type RecipeId = string;

export type VisualTargetType =
  | 'character'
  | 'background'
  | 'environment-layer'
  | 'image-layer'
  | 'text-layer';

export type LensStyleSlot = 'grade' | 'optics' | 'atmosphere' | 'texture';
export type CompositeSlot = 'grounding' | 'integration' | 'accent' | 'distortion';

export interface SemanticStyleOverride {
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
  shadowDistance?: number;
  shadowSoftness?: number;
}

export type NonIntegrationSemanticStyleOverride = Omit<SemanticStyleOverride, 'brightness'>;

export interface AdvancedStyleOverride {
  [key: string]: unknown;
}

export interface LensGradeRecipePayload {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  red?: number;
  green?: number;
  blue?: number;
}

export interface LensOpticsRecipePayload {
  bloomScale?: number;
  bloomThreshold?: number;
  rgbSplit?: number;
}

export interface VisualColorOverlayPayload {
  color: string;
  intensity: number;
  mode: BlendMode;
}

export interface LensAtmosphereRecipePayload {
  bloomScale?: number;
  bloomThreshold?: number;
  godrayAngle?: number;
  godrayGain?: number;
  overlays?: VisualColorOverlayPayload[];
}

export interface LensTextureRecipePayload {
  contrast?: number;
  saturation?: number;
  overlays?: VisualColorOverlayPayload[];
}

export interface CompositeRecipePayload {
  adjustment?: {
    brightness?: number;
    contrast?: number;
    saturation?: number;
    red?: number;
    green?: number;
    blue?: number;
  };
  colorOverlay?: {
    alpha?: number;
    color?: string | number;
    colorStops?: string[];
    mode?: BlendMode;
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
}

export type StyleRecipeRecord =
  | {
      stack: 'lens';
      slot: 'grade';
      extendsRecipeId?: RecipeId;
      label?: string;
      payload: LensGradeRecipePayload;
    }
  | {
      stack: 'lens';
      slot: 'optics';
      extendsRecipeId?: RecipeId;
      label?: string;
      payload: LensOpticsRecipePayload;
    }
  | {
      stack: 'lens';
      slot: 'atmosphere';
      extendsRecipeId?: RecipeId;
      label?: string;
      payload: LensAtmosphereRecipePayload;
    }
  | {
      stack: 'lens';
      slot: 'texture';
      extendsRecipeId?: RecipeId;
      label?: string;
      payload: LensTextureRecipePayload;
    }
  | {
      stack: 'composite';
      slot: CompositeSlot;
      extendsRecipeId?: RecipeId;
      label?: string;
      payload: CompositeRecipePayload;
    };

export interface SlotRecipeState {
  recipeId: RecipeId;
  semanticOverride?: SemanticStyleOverride;
  advancedOverride?: AdvancedStyleOverride;
}

export type LensStyleBaseline = Partial<Record<LensStyleSlot, SlotRecipeState>>;
export type ObjectCompositeBaseline = Partial<Record<CompositeSlot, SlotRecipeState>>;
export type SegmentAdjustedCompositeBaseline = Partial<Record<VisualTargetId, ObjectCompositeBaseline>>;

export interface RimLightStyleState {
  color: string;
  intensity: number;
  thickness: number;
  angle: number;
  softness: number;
}

export interface EnvironmentOverrideFields {
  environmentColor?: string;
  warmthBias?: number;
  exposureBias?: number;
  atmosphereBias?: number;
  primaryLightDirection?: 'left' | 'right' | 'center' | 'mixed';
}

export type LensEnvironmentOverride = EnvironmentOverrideFields;
export type TargetEnvironmentOverride = EnvironmentOverrideFields;

export interface SegmentBoundaryReference {
  startMarkerId?: string;
}

export interface VisualTargetRecord {
  targetType: VisualTargetType;
  objectCompositeBaseline?: ObjectCompositeBaseline;
  rimLightBaseline?: RimLightStyleState;
  targetEnvironmentOverride?: TargetEnvironmentOverride;
}

export interface SegmentVisualRecord {
  boundaryRef?: SegmentBoundaryReference;
  lensStyleBaseline?: LensStyleBaseline;
  lensEnvironmentOverride?: LensEnvironmentOverride;
  adjustedCompositeByTarget?: SegmentAdjustedCompositeBaseline;
}

export interface SceneVisualBlock {
  visualTargets?: Record<VisualTargetId, VisualTargetRecord>;
  segments?: Record<SegmentId, SegmentVisualRecord>;
  recipeOverlay?: Record<RecipeId, StyleRecipeRecord>;
}
