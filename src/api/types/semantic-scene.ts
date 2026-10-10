import type { SceneMarker, SceneMeta } from './scene-common';
import type {
  AdvancedStyleOverride,
  CompositeSlot,
  NonIntegrationSemanticStyleOverride,
  SceneVisualBlock,
  SemanticStyleOverride,
} from './visual';
import type { BlendMode } from './blend-mode';

export type RuntimeActionType =
  | 'setEnvironmentLayer'
  | 'transformEnvironmentLayer'
  | 'removeEnvironmentLayer'
  | 'addCharacter'
  | 'removeCharacter'
  | 'transformCharacter'
  | 'characterLookAt'
  | 'characterBlink'
  | 'playMotion'
  | 'setExpression'
  | 'dialogue'
  | 'cameraMotion'
  | 'cameraFollow'
  | 'cameraUnfollow'
  | 'cameraReset'
  | 'cameraPath'
  | 'cameraShake'
  | 'cameraHitchcock'
  | 'addLensFilter'
  | 'changeLensFilter'
  | 'resetLensFilters'
  | 'setCompositeRecipe'
  | 'modulateComposite'
  | 'resetCompositeRecipe'
  | 'setCharacterRimLight'
  | 'setLighting'
  | 'resetLighting'
  | 'setBlur'
  | 'resetBlur'
  | 'setGodrays'
  | 'resetGodrays'
  | 'setPostProcessing'
  | 'resetPostProcessing'
  | 'addColorOverlay'
  | 'removeColorOverlay'
  | 'clearColorOverlays'
  | 'addPointLight'
  | 'removePointLight'
  | 'clearPointLights'
  | 'setBGM'
  | 'playAudio'
  | 'stopAudio'
  | 'addImage'
  | 'transformImage'
  | 'removeImage'
  | 'addTextLayer'
  | 'transformTextLayer'
  | 'removeTextLayer'
  | 'playCustomAnimation';

export const SCENE_SCHEMA_VERSION_V4 = 4 as const;
export const SCENE_SCHEMA_VERSION_V5 = 5 as const;

/**
 * The scene schema epoch the product currently loads and saves. This is now
 * scene v5 (ADR-0031); use `CurrentSceneDocument` in current-path code.
 */
export const SCENE_SCHEMA_VERSION = SCENE_SCHEMA_VERSION_V5;

export type SceneSchemaVersion =
  | typeof SCENE_SCHEMA_VERSION_V4
  | typeof SCENE_SCHEMA_VERSION_V5;

export type CurrentSceneSchemaVersion = typeof SCENE_SCHEMA_VERSION;

/** 场景级节奏档位:快 / 正常 / 慢,决定自动计算时长的整体缩放。 */
export const SCENE_PACE_TIERS = ['snap', 'normal', 'slow'] as const;
export type ScenePaceTier = typeof SCENE_PACE_TIERS[number];

/**
 * Historical scene v4 input contract. It remains the strict contract for
 * migration and collaboration v2 seams; current product code should prefer
 * `CurrentSceneDocument`.
 */
export interface SceneDocumentV4 {
  schemaVersion: typeof SCENE_SCHEMA_VERSION_V4;
  sceneId: string;
  meta: SceneMetaV4;
  visual?: SceneVisualBlock;
  statements: SceneStatement[];
}

/**
 * Explicit name for consumers that must retain the historical v4 contract
 * after the product's current Scene Document advances to a later epoch.
 */
export type HistoricalSceneDocumentV4 = SceneDocumentV4;

export interface SceneMetaV4 extends SceneMeta {
  durationSeconds?: number;
  markers?: SceneMarker[];
  /** 场景级节奏档位;缺省为 normal。 */
  paceTier?: ScenePaceTier;
}

/** Metadata paired with the historical collaboration-v2 document contract. */
export type HistoricalSceneMetaV4 = SceneMetaV4;

/**
 * Compatibility-aware scene v5 epoch. This is the product's current scene
 * contract (ADR-0031); it carries compatibility source retention and unknown
 * field preservation through the compatible scene session seam.
 */
export interface SceneDocumentV5 {
  schemaVersion: typeof SCENE_SCHEMA_VERSION_V5;
  sceneId: string;
  meta: SceneMetaV5;
  visual?: SceneVisualBlock;
  statements: SceneStatement[];
}

export interface SceneMetaV5 extends SceneMeta {
  durationSeconds?: number;
  markers?: SceneMarker[];
  /** 场景级节奏档位;缺省为 normal。 */
  paceTier?: ScenePaceTier;
}

/**
 * Version-neutral current Scene Document contract. It describes the v5
 * current document without forcing current-path consumers to change names.
 */
export interface CurrentSceneDocument {
  schemaVersion: CurrentSceneSchemaVersion;
  sceneId: string;
  meta: CurrentSceneMeta;
  visual?: SceneVisualBlock;
  statements: SceneStatement[];
}

export interface CurrentSceneMeta extends SceneMeta {
  durationSeconds?: number;
  markers?: SceneMarker[];
  /** 场景级节奏档位;缺省为 normal。 */
  paceTier?: ScenePaceTier;
}

export function isHistoricalSceneDocumentV4(
  value: unknown,
): value is HistoricalSceneDocumentV4 {
  return !!value
    && typeof value === 'object'
    && 'schemaVersion' in value
    && value.schemaVersion === SCENE_SCHEMA_VERSION_V4;
}

export function assertHistoricalSceneDocumentV4(
  value: unknown,
): asserts value is HistoricalSceneDocumentV4 {
  if (!isHistoricalSceneDocumentV4(value)) {
    throw new Error(`Expected historical scene schema version ${SCENE_SCHEMA_VERSION_V4}`);
  }
}

export function isSceneDocumentV5(
  value: unknown,
): value is SceneDocumentV5 {
  return !!value
    && typeof value === 'object'
    && 'schemaVersion' in value
    && value.schemaVersion === SCENE_SCHEMA_VERSION_V5;
}

export function assertSceneDocumentV5(
  value: unknown,
): asserts value is SceneDocumentV5 {
  if (!isSceneDocumentV5(value)) {
    throw new Error(`Expected canonical scene schema version ${SCENE_SCHEMA_VERSION_V5}`);
  }
}

export type StatementFamily =
  | 'dialogue'
  | 'characterPresence'
  | 'characterTransform'
  | 'characterPerformance'
  | 'camera'
  | 'environmentLayer'
  | 'visualStyle'
  | 'filterAdd'
  | 'filterChange'
  | 'filterReset'
  | 'lighting'
  | 'audio'
  | 'graphicLayer'
  | 'customAnimation';

export type StatementCategory =
  | 'dialogue'
  | 'character'
  | 'camera'
  | 'scene'
  | 'visual'
  | 'audio'
  | 'layer';

export type Vec2 = readonly [number, number];

export interface ZoomIntent {
  kind: 'absolute' | 'delta';
  value: number;
}

export type DialogueNineSlice = readonly [left: number, top: number, right: number, bottom: number];

export interface DialogueImagePanelStyle {
  image: string;
  nineSlice?: DialogueNineSlice;
  x: number;
  y: number;
  width: number;
  height?: number;
  minHeight?: number;
  opacity?: number;
}

export interface DialogueImageTextStyle {
  fontFile?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  color?: string;
  x: number;
  y: number;
  maxWidth: number;
  lineHeight?: number;
  align?: 'left' | 'center' | 'right';
  strokeColor?: string;
  strokeWidth?: number;
  dropShadow?: boolean;
  dropShadowColor?: string;
  dropShadowAlpha?: number;
  dropShadowBlur?: number;
  dropShadowDistance?: number;
}

export interface DialogueImageSpeakerStyle {
  fontFile?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  color?: string;
  padding?: DialogueNineSlice;
  textOffset?: Vec2;
}

export interface DialogueImagePresentation {
  renderer: 'image-dialogue-v1';
  /** Template style id retained with the project-owned snapshot for authoring UI. */
  styleId?: string;
  textbox: DialogueImagePanelStyle;
  namebox?: DialogueImagePanelStyle;
  text: DialogueImageTextStyle;
  speaker?: DialogueImageSpeakerStyle;
}

export interface DialogueParams {
  speakerId?: string;
  speaker?: string;
  text: string;
  durationSeconds: number;
  voice?: string;
  voiceDuration?: number;
  voiceDurationSeconds?: number;
  style?: string;
  speakerColor?: string;
  textColor?: string;
  lipSync?: boolean;
  template?: 'glass' | 'minimal' | 'classic';
  presentation?: DialogueImagePresentation;
}

export interface CharacterPresenceParams {
  mode: 'enter' | 'exit';
  id: string;
  model?: string;
  variant?: string;
  position?: Vec2;
  scale?: number;
  rotation?: number;
  opacity?: number;
  z?: number;
  transition?: string;
  durationSeconds?: number;
  ease?: string;
}

export interface CharacterTransformParams {
  id: string;
  position?: Vec2;
  scale?: number;
  rotation?: number;
  opacity?: number;
  z?: number;
  durationSeconds?: number;
  ease?: string;
}

export type CustomMotionSegment =
  | { readonly type: 'linear' }
  | {
      readonly type: 'bezier';
      readonly controlPoints: readonly [
        { readonly time: number; readonly value: number },
        { readonly time: number; readonly value: number },
      ];
    }
  | { readonly type: 'stepped' }
  | { readonly type: 'inverseStepped' };

export interface CustomMotionKeyframe {
  readonly time: number;
  readonly value: number;
  readonly segment?: CustomMotionSegment;
}

export interface CustomMotionTrack {
  readonly parameterId: string;
  readonly fadeInSeconds?: number;
  readonly keyframes: readonly CustomMotionKeyframe[];
}

export interface CustomMotionDerivedFrom {
  readonly key: string;
  readonly fadeInSeconds?: number;
  readonly fadeOutSeconds?: number;
}

export type CharacterMotionOutput =
  | {
      readonly kind: 'resource';
      readonly key: string;
      readonly fadeInSeconds?: number;
    }
  | {
      readonly kind: 'custom';
      readonly durationSeconds: number;
      readonly fadeInSeconds: number;
      readonly derivedFrom: CustomMotionDerivedFrom;
      readonly tracks: readonly CustomMotionTrack[];
    };

export interface CharacterPerformanceParams {
  target: string;
  /** Exact empty string is the ADR-0022 unfilled performance placeholder. */
  motion?: CharacterMotionOutput | '';
  expression?: string;
  lookAt?: {
    target?: string;
    point?: Vec2;
    enabled?: boolean;
    intensity?: number;
  };
  blink?: {
    enabled?: boolean;
    interval?: number;
    intervalRange?: number;
  };
}

export interface CameraFocusParams {
  mode: 'focus';
  target?: string;
  targetPart?: 'head' | 'chest' | 'feet' | 'center';
  position?: Vec2;
  zoom?: ZoomIntent;
  rotation?: number;
  durationSeconds?: number;
  ease?: string;
}

export interface CameraMoveParams {
  mode: 'move';
  position?: Vec2;
  to?: Vec2;
  zoom?: ZoomIntent;
  rotation?: number;
  durationSeconds?: number;
  ease?: string;
}

export interface CameraFollowParams {
  mode: 'follow';
  operation: 'start' | 'stop';
  target?: string;
  offset?: Vec2;
  smoothing?: number;
}

export interface CameraPathKeyframe {
  time: number;
  position?: Vec2;
  zoom?: number;
  rotation?: number;
  ease?: string;
  label?: string;
}

export interface CameraPathParams {
  mode: 'path';
  keyframes: CameraPathKeyframe[];
  durationSeconds?: number;
  ease?: string;
  loop?: boolean;
  repeat?: number;
  yoyo?: boolean;
}

export interface CameraShakeParams {
  mode: 'shake';
  intensity?: number;
  frequency?: number;
  durationSeconds?: number;
  decay?: boolean;
  direction?: 'both' | 'horizontal' | 'vertical';
}

export interface CameraHitchcockParams {
  mode: 'hitchcock';
  target: string;
  targetPart?: 'head' | 'chest' | 'feet' | 'center';
  screenTarget?: Vec2;
  zoomStart: number;
  zoomEnd: number;
  scaleStart: number;
  scaleEnd: number;
  durationSeconds: number;
  ease?: string;
}

export interface CameraResetParams {
  mode: 'reset';
  durationSeconds?: number;
  ease?: string;
}

export type CameraParams =
  | CameraFocusParams
  | CameraMoveParams
  | CameraFollowParams
  | CameraPathParams
  | CameraShakeParams
  | CameraHitchcockParams
  | CameraResetParams;

export interface EnvironmentLayerParams {
  mode: 'set' | 'transform' | 'remove';
  layerId: string;
  /** Author-facing name; layerId remains the stable reference. */
  label?: string;
  file?: string;
  image?: string;
  position?: Vec2;
  scale?: number;
  rotation?: number;
  opacity?: number;
  z?: number;
  zIndex?: number;
  durationSeconds?: number;
  ease?: string;
  transition?: string;
}

interface VisualStyleTargetParams {
  scope: 'object';
  target: string;
  slot: CompositeSlot | 'rim-light';
  durationSeconds?: number;
}

interface VisualStyleValueParams {
  intensity?: number;
  warmth?: number;
  bloom?: number;
  rgbSplit?: number;
  blend?: number;
  contamination?: number;
  colorStops?: string[];
  colorBlendMode?: BlendMode;
  color?: string;
  thickness?: number;
  angle?: number;
  softness?: number;
  shadowDistance?: number;
  shadowSoftness?: number;
  semanticOverride?: NonIntegrationSemanticStyleOverride;
  advancedOverride?: AdvancedStyleOverride;
}

interface IntegrationVisualStyleValueParams extends Omit<VisualStyleValueParams, 'semanticOverride'> {
  brightness?: number;
  semanticOverride?: SemanticStyleOverride;
}

type NonIntegrationCompositeSlot = Exclude<CompositeSlot, 'integration'>;

export type VisualStyleParams =
  | (VisualStyleTargetParams & VisualStyleValueParams & {
      slot: NonIntegrationCompositeSlot;
      mode: 'set';
      recipeId: string;
    })
  | (VisualStyleTargetParams & VisualStyleValueParams & {
      slot: NonIntegrationCompositeSlot;
      mode: 'modulate';
      recipeId?: never;
    })
  | (VisualStyleTargetParams & IntegrationVisualStyleValueParams & {
      slot: 'integration';
      mode: 'set';
      recipeId: string;
    })
  | (VisualStyleTargetParams & IntegrationVisualStyleValueParams & {
      slot: 'integration';
      mode: 'modulate';
      recipeId?: never;
    })
  | (VisualStyleTargetParams & VisualStyleValueParams & {
      slot: 'rim-light';
      mode: 'set' | 'modulate';
      recipeId?: never;
    })
  | (VisualStyleTargetParams & {
      mode: 'reset';
      recipeId?: never;
      intensity?: never;
      brightness?: never;
      warmth?: never;
      bloom?: never;
      rgbSplit?: never;
      blend?: never;
      contamination?: never;
      colorStops?: never;
      colorBlendMode?: never;
      color?: never;
      thickness?: never;
      angle?: never;
      softness?: never;
      shadowDistance?: never;
      shadowSoftness?: never;
      semanticOverride?: never;
      advancedOverride?: never;
    });

/**
 * @deprecated Lens filter authoring is hidden from the UI. Retained only for
 * loading and playing historical scene documents.
 */
export interface LensFilterOverrideParams {
  intensity?: number;
  warmth?: number;
  bloom?: number;
  rgbSplit?: number;
  blend?: number;
  contamination?: number;
}

/** @deprecated Retained for historical scene compatibility; no new UI entry. */
export interface FilterAddParams extends LensFilterOverrideParams {
  recipeId: string;
  durationSeconds?: number;
}

/** @deprecated Retained for historical scene compatibility; no new UI entry. */
export interface FilterChangeParams extends LensFilterOverrideParams {
  fromRecipeId: string;
  recipeId: string;
  durationSeconds?: number;
}

/** @deprecated Retained for historical scene compatibility; no new UI entry. */
export interface FilterResetParams {
  durationSeconds?: number;
}

export type LightingBlurTarget = 'global' | 'background' | 'characters';

export interface LightingPostProcessingParams {
  bloomThreshold?: number;
  bloomBloomScale?: number;
  bloomBrightness?: number;
  rgbSplitX?: number;
  rgbSplitY?: number;
  godrayGain?: number;
  godrayLacunarity?: number;
  godrayAngle?: number;
  adjGamma?: number;
  adjContrast?: number;
  adjSaturation?: number;
  adjBrightness?: number;
  adjRed?: number;
  adjGreen?: number;
  adjBlue?: number;
  /** Optional character/environment target; omitted targets mean the panorama. */
  target?: string;
  /** Integrated post-process color overlay for the same target. */
  overlayColor?: string;
  overlayBlendMode?: BlendMode;
  overlayIntensity?: number;
}

interface LightingSingletonBase<Effect extends 'preset' | 'blur' | 'godrays' | 'post'> {
  effect: Effect;
  durationSeconds?: number;
}

export type LightingPresetParams =
  | (LightingSingletonBase<'preset'> & {
      mode: 'set' | 'modulate';
      preset: string;
      intensity?: number;
    })
  | (LightingSingletonBase<'preset'> & { mode: 'reset'; preset?: never; intensity?: never });

export type LightingBlurParams =
  | (LightingSingletonBase<'blur'> & {
      mode: 'set' | 'modulate';
      target?: LightingBlurTarget;
      intensity?: number;
    })
  | (LightingSingletonBase<'blur'> & {
      mode: 'reset';
      target?: LightingBlurTarget;
      intensity?: never;
    });

export type LightingGodraysParams =
  | (LightingSingletonBase<'godrays'> & {
      mode: 'set' | 'modulate';
      intensity?: number;
      angle?: number;
      lacunarity?: number;
    })
  | (LightingSingletonBase<'godrays'> & {
      mode: 'reset';
      intensity?: never;
      angle?: never;
      lacunarity?: never;
    });

type LightingPostResetParams = LightingSingletonBase<'post'> & {
  mode: 'reset';
  target?: string;
} & {
  [Key in Exclude<keyof LightingPostProcessingParams, 'target'>]?: never;
};

export type LightingPostParams =
  | (LightingSingletonBase<'post'> & LightingPostProcessingParams & {
      mode: 'set' | 'modulate';
    })
  | LightingPostResetParams;

export interface LightingOverlayValueParams {
  id: string;
  color?: string;
  blendMode?: BlendMode;
  intensity?: number;
}

export type LightingOverlayParams =
  | (LightingOverlayValueParams & { effect: 'overlay'; mode: 'set' | 'modulate'; durationSeconds?: number })
  | ({ effect: 'overlay'; mode: 'remove'; id: string; durationSeconds?: number })
  | ({ effect: 'overlay'; mode: 'clear'; durationSeconds?: number });

export interface LightingPointLightValueParams {
  id: string;
  x?: number;
  y?: number;
  color?: string;
  radius?: number;
  intensity?: number;
}

export type LightingPointLightParams =
  | (LightingPointLightValueParams & { effect: 'pointLight'; mode: 'set' | 'modulate'; durationSeconds?: number })
  | ({ effect: 'pointLight'; mode: 'remove'; id: string; durationSeconds?: number })
  | ({ effect: 'pointLight'; mode: 'clear'; durationSeconds?: number });

export type LightingParams =
  | LightingPresetParams
  | LightingBlurParams
  | LightingGodraysParams
  | LightingPostParams
  | LightingOverlayParams
  | LightingPointLightParams;

export type AudioParams =
  | {
      role: 'bgm';
      mode: 'play';
      file: string;
      volume?: number;
      loop?: boolean;
      fadeIn?: number;
      fadeOut?: number;
    }
  | {
      role: 'bgm';
      mode: 'stop';
      fadeOut?: number;
    }
  | {
      role: 'sfx';
      mode: 'play';
      instanceId: string;
      file: string;
      volume?: number;
      loop?: boolean;
      durationSeconds?: number;
      fadeIn?: number;
      fadeOut?: number;
    }
  | {
      role: 'sfx';
      mode: 'stop';
      instanceId: string;
      fadeOut?: number;
    };

export type GraphicLayerParams =
  | {
      kind: 'image';
      mode: 'set' | 'transform' | 'remove';
      id: string;
      file?: string;
      position?: Vec2;
      scale?: number;
      rotation?: number;
      opacity?: number;
      z?: number;
      zIndex?: number;
      durationSeconds?: number;
      ease?: string;
    }
  | {
      kind: 'text';
      mode: 'set' | 'transform' | 'remove';
      id: string;
      text?: string;
      position?: Vec2;
      scale?: number;
      rotation?: number;
      opacity?: number;
      z?: number;
      zIndex?: number;
      durationSeconds?: number;
      ease?: string;
      fontFamily?: string;
      fontSize?: number;
      color?: string;
      style?: string;
    };

export interface CustomAnimationParams {
  target: string;
  file?: string;
  animation?: string;
  durationSeconds: number;
  loop?: boolean;
}

export interface StatementParamsByFamily {
  dialogue: DialogueParams;
  characterPresence: CharacterPresenceParams;
  characterTransform: CharacterTransformParams;
  characterPerformance: CharacterPerformanceParams;
  camera: CameraParams;
  environmentLayer: EnvironmentLayerParams;
  visualStyle: VisualStyleParams;
  filterAdd: FilterAddParams;
  filterChange: FilterChangeParams;
  filterReset: FilterResetParams;
  lighting: LightingParams;
  audio: AudioParams;
  graphicLayer: GraphicLayerParams;
  customAnimation: CustomAnimationParams;
}

export type SceneStatement = {
  [Family in StatementFamily]: StatementBase<Family, StatementParamsByFamily[Family]> & {
    companions?: DialogueCompanion[];
  };
}[StatementFamily];

export type DialogueCompanion = {
  [Family in StatementFamily]: CompanionBase<Family, StatementParamsByFamily[Family]>;
}[StatementFamily];

export type DialogueCompanionDraft = Omit<DialogueCompanion, 'id'> & {
  id?: string;
};

export interface StatementBase<Family extends StatementFamily, Params> {
  id: string;
  time: number;
  type: Family;
  params: Params;
}

export interface CompanionBase<Family extends StatementFamily, Params> {
  id: string;
  anchor: 'start' | 'end';
  offset: number;
  type: Family;
  params: Params;
}

export type SceneStatementDraft = Omit<SceneStatement, 'id' | 'time' | 'companions'> & {
  id?: string;
  time?: number;
  companions?: DialogueCompanionDraft[];
};

export type DialogueStatementDraft = Extract<SceneStatementDraft, { type: 'dialogue' }>;

export type RuntimeActionParams = Record<string, unknown>;

export interface CompiledScene {
  readonly sourceSchemaVersion: typeof SCENE_SCHEMA_VERSION;
  readonly sceneId: string;
  readonly meta: Readonly<CurrentSceneMeta>;
  readonly visual?: Readonly<SceneVisualBlock>;
  readonly durationSeconds: number;
  readonly actions: readonly CompiledAction[];
}

export interface CompiledAction {
  readonly id: string;
  readonly time: number;
  readonly action: RuntimeActionType;
  readonly params: RuntimeActionParams;
  readonly assetSlots?: readonly CompiledAssetSlot[];
  readonly source: {
    readonly statementId: string;
    readonly companionId?: string;
    readonly outputKey: string;
  };
}

export interface CompiledAssetSlot {
  readonly path: string;
  readonly kind: import('./project').ResourceImportKind;
}

export interface AvailablePreparedAssetRef {
  readonly source: string;
  readonly runtimeUri: string;
  /** Omitted for compatibility with prepared scenes produced before availability was tracked. */
  readonly unavailable?: false;
}

/**
 * A source asset that could not be made available to the runtime. Keeping the
 * source lets the editor report and repair it; the empty runtime URI prevents
 * an unresolved project reference from reaching playback or export.
 */
export interface UnavailablePreparedAssetRef {
  readonly source: string;
  readonly runtimeUri: '';
  readonly unavailable: true;
  readonly unavailableReason?: string;
}

export type PreparedAssetRef = AvailablePreparedAssetRef | UnavailablePreparedAssetRef;

export type PreparedRuntimeValue =
  | string
  | number
  | boolean
  | null
  | PreparedAssetRef
  | readonly PreparedRuntimeValue[]
  | { readonly [key: string]: PreparedRuntimeValue };

export type PreparedRuntimeActionParams = Record<string, PreparedRuntimeValue>;

export type PreparedCompiledAction = Omit<CompiledAction, 'params'> & {
  readonly params: PreparedRuntimeActionParams;
};

export type PreparedCompiledScene = Omit<CompiledScene, 'actions'> & {
  readonly kind: 'prepared-compiled-scene';
  readonly actions: readonly PreparedCompiledAction[];
};

export interface SemanticSceneBundle {
  readonly source: CurrentSceneDocument;
  readonly compiled: CompiledScene;
  readonly prepared: PreparedCompiledScene;
}
