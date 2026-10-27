import type {
  CharacterMotionOutput,
  CharacterPresenceParams,
  CharacterTransformParams,
  DialogueParams,
  EnvironmentLayerParams,
  RuntimeActionType,
} from '../../api/types/semantic-scene';
import type {
  CameraHitchcockConfig,
  CameraKeyframe,
  CameraMotionConfig,
  CameraPathConfig,
  CameraShakeConfig,
} from '../../api/types/camera';
import type { TextLayerConfig } from '../../api/types/textLayer';
import type { LayerName } from '../../api/types/common';
import type { RuntimeTimelineAction } from '../RuntimeTimelineScene';
import type { EnvironmentLayoutMode } from '../environmentLayerModel';

type RuntimeVec2 = [number, number] | { x: number; y: number };
type RuntimeParameterRecord<Shape extends object = object> = Shape & Record<string, unknown>;

type RuntimeActionInput<Action extends RuntimeActionType, Params extends RuntimeParameterRecord> =
  Pick<RuntimeTimelineAction, '_seq' | 'time' | '_explicit'> & {
    /** Optional for direct scheduler callers; the dispatcher verifies it. */
    readonly action?: Action;
    /** Scheduler tests and internal callers predate compiled action ids. */
    readonly _id?: string;
    readonly params: Params;
  };

type CharacterEnterPreset =
  | 'fadeIn' | 'slideFromLeft' | 'slideFromRight' | 'slideFromBottom'
  | 'zoomIn' | 'dropIn' | 'none' | 'fade';
type CharacterExitPreset =
  | 'fadeOut' | 'slideToLeft' | 'slideToRight' | 'slideToTop'
  | 'flyUp' | 'dissolve' | 'zoomOut' | 'none' | 'fade';

type RuntimeCharacterAddParams = RuntimeParameterRecord<
  Partial<Omit<CharacterPresenceParams, 'mode' | 'durationSeconds' | 'position' | 'id'>> & {
    id: string;
    position?: RuntimeVec2;
    enter?: CharacterEnterPreset;
    duration?: number;
    enterDuration?: number;
    enterEase?: string;
    flipX?: boolean;
    zIndex?: number;
  }
>;

type RuntimeCharacterRemoveParams = RuntimeParameterRecord<{
  id: string;
  exit?: CharacterExitPreset;
  duration?: number;
  exitDuration?: number;
  exitEase?: string;
}>;

type RuntimeCharacterTransformParams = RuntimeParameterRecord<
  Partial<Omit<CharacterTransformParams, 'position' | 'durationSeconds' | 'id'>> & {
    id: string;
    position?: RuntimeVec2;
    duration?: number;
  }
>;

type RuntimeLookAtParams = RuntimeParameterRecord<{
  id: string;
  target?: string;
  point?: RuntimeVec2;
  focusX?: number;
  focusY?: number;
  enabled?: boolean;
  intensity?: number;
  duration?: number;
}>;

type RuntimeBlinkParams = RuntimeParameterRecord<{
  id: string;
  enabled?: boolean;
  interval?: number;
  intervalRange?: number;
}>;

type RuntimePlayMotionParams = RuntimeParameterRecord<{
  id: string;
  motion?: CharacterMotionOutput | string;
  priority?: number;
}>;

type RuntimeExpressionParams = RuntimeParameterRecord<{ id?: string; expression?: string | null }>;

type RuntimeDialogueActionParams = RuntimeParameterRecord<
  Partial<Omit<DialogueParams, 'durationSeconds' | 'text' | 'style' | 'lipSync'>> & Pick<DialogueParams, 'text'> & {
    style?: TextLayerConfig['style'];
    /** Legacy compiled scenes stored lip sync modes as string literals. */
    lipSync?: DialogueParams['lipSync'] | 'audio' | 'text' | 'none';
    duration?: number;
    fontSize?: number;
    position?: 'bottom' | 'top' | 'center';
  }
>;

type RuntimeCameraMotionParams = RuntimeParameterRecord<
  Omit<Partial<CameraMotionConfig>, 'easing'> & { easing?: string }
>;

type RuntimeCameraFollowParams = RuntimeParameterRecord<{
  characterId?: string;
  offset?: RuntimeVec2;
  smoothing?: number;
  duration?: number;
}>;

type RuntimeCameraPathParams = RuntimeParameterRecord<
  Omit<Partial<CameraPathConfig>, 'defaultEase'> & {
    keyframes: CameraKeyframe[];
    ease?: string;
  }
>;

type RuntimeCameraShakeParams = RuntimeParameterRecord<Partial<CameraShakeConfig>>;

type RuntimeCameraHitchcockParams = RuntimeParameterRecord<
  Partial<CameraHitchcockConfig> & { focalPoint?: RuntimeVec2 }
>;

type RuntimeCameraResetParams = RuntimeParameterRecord<{
  duration?: number;
  durationSeconds?: number;
  ease?: string;
  easing?: string;
}>;

type RuntimeEnvironmentLayerActionShape =
  Partial<Omit<EnvironmentLayerParams, 'mode' | 'position' | 'transition'>> & {
    position?: RuntimeVec2;
    x?: number;
    y?: number;
    duration?: number;
    transition?: 'none' | 'fadeIn' | 'crossFade' | 'fadeOut';
    layoutMode?: EnvironmentLayoutMode;
    tileScaleX?: number;
    tileScaleY?: number;
    tileOffsetX?: number;
    tileOffsetY?: number;
  };
type RuntimeEnvironmentLayerActionParams = RuntimeParameterRecord<RuntimeEnvironmentLayerActionShape>;

type RuntimeSetEnvironmentLayerParams = RuntimeParameterRecord<Omit<RuntimeEnvironmentLayerActionShape, 'transition'> & {
  transition?: 'none' | 'fadeIn' | 'crossFade';
}>;
type RuntimeRemoveEnvironmentLayerParams = RuntimeParameterRecord<Omit<RuntimeEnvironmentLayerActionShape, 'transition'> & {
  transition?: 'none' | 'fadeOut';
}>;

type RuntimeImageActionParams = RuntimeParameterRecord<{
  id?: string;
  file?: string;
  position?: RuntimeVec2;
  scale?: number;
  rotation?: number;
  opacity?: number;
  z?: number;
  zIndex?: number;
  duration?: number;
  ease?: string;
}>;

type RuntimeTextActionParams = RuntimeParameterRecord<
  Partial<TextLayerConfig> & {
    z?: number;
    zIndex?: number;
    ease?: string;
  }
>;

type RuntimeAudioActionParams = RuntimeParameterRecord<{
  id?: string;
  file?: string;
  volume?: number;
  loop?: boolean;
  duration?: number;
  fadeIn?: number;
  fadeOut?: number;
}>;

type RuntimeCustomAnimationParams = RuntimeParameterRecord<{
  target?: string;
  file?: string;
  animation?: string;
  duration?: number;
  loop?: boolean;
  layer?: LayerName;
}>;

type RuntimeDurationParams = RuntimeParameterRecord<{ duration?: number }>;

type RuntimeRimLightParams = RuntimeParameterRecord<{
  id: string;
  mode?: 'set' | 'modulate' | 'reset';
  color?: string;
  intensity?: number;
  thickness?: number;
  angle?: number;
  softness?: number;
  duration?: number;
}>;

interface RuntimeActionContractByName {
  addCharacter: RuntimeActionInput<'addCharacter', RuntimeCharacterAddParams>;
  removeCharacter: RuntimeActionInput<'removeCharacter', RuntimeCharacterRemoveParams>;
  transformCharacter: RuntimeActionInput<'transformCharacter', RuntimeCharacterTransformParams>;
  characterLookAt: RuntimeActionInput<'characterLookAt', RuntimeLookAtParams>;
  characterBlink: RuntimeActionInput<'characterBlink', RuntimeBlinkParams>;
  playMotion: RuntimeActionInput<'playMotion', RuntimePlayMotionParams>;
  setExpression: RuntimeActionInput<'setExpression', RuntimeExpressionParams>;
  dialogue: RuntimeActionInput<'dialogue', RuntimeDialogueActionParams>;
  setDialogueVisibility: RuntimeActionInput<'setDialogueVisibility', RuntimeParameterRecord<{ visible?: boolean; duration?: number }>>;
  cameraMotion: RuntimeActionInput<'cameraMotion', RuntimeCameraMotionParams>;
  cameraFollow: RuntimeActionInput<'cameraFollow', RuntimeCameraFollowParams>;
  cameraUnfollow: RuntimeActionInput<'cameraUnfollow', RuntimeParameterRecord>;
  cameraReset: RuntimeActionInput<'cameraReset', RuntimeCameraResetParams>;
  cameraPath: RuntimeActionInput<'cameraPath', RuntimeCameraPathParams>;
  cameraShake: RuntimeActionInput<'cameraShake', RuntimeCameraShakeParams>;
  cameraHitchcock: RuntimeActionInput<'cameraHitchcock', RuntimeCameraHitchcockParams>;
  setEnvironmentLayer: RuntimeActionInput<'setEnvironmentLayer', RuntimeSetEnvironmentLayerParams>;
  transformEnvironmentLayer: RuntimeActionInput<'transformEnvironmentLayer', RuntimeEnvironmentLayerActionParams>;
  removeEnvironmentLayer: RuntimeActionInput<'removeEnvironmentLayer', RuntimeRemoveEnvironmentLayerParams>;
  addImage: RuntimeActionInput<'addImage', RuntimeImageActionParams>;
  transformImage: RuntimeActionInput<'transformImage', RuntimeImageActionParams>;
  removeImage: RuntimeActionInput<'removeImage', RuntimeImageActionParams>;
  addTextLayer: RuntimeActionInput<'addTextLayer', RuntimeTextActionParams>;
  transformTextLayer: RuntimeActionInput<'transformTextLayer', RuntimeTextActionParams>;
  removeTextLayer: RuntimeActionInput<'removeTextLayer', RuntimeTextActionParams>;
  playAudio: RuntimeActionInput<'playAudio', RuntimeAudioActionParams>;
  stopAudio: RuntimeActionInput<'stopAudio', RuntimeAudioActionParams>;
  setBGM: RuntimeActionInput<'setBGM', RuntimeAudioActionParams>;
  playCustomAnimation: RuntimeActionInput<'playCustomAnimation', RuntimeCustomAnimationParams>;
  setCharacterRimLight: RuntimeActionInput<'setCharacterRimLight', RuntimeRimLightParams>;
  setLighting: RuntimeActionInput<'setLighting', RuntimeDurationParams>;
  resetLighting: RuntimeActionInput<'resetLighting', RuntimeDurationParams>;
  setBlur: RuntimeActionInput<'setBlur', RuntimeDurationParams>;
  resetBlur: RuntimeActionInput<'resetBlur', RuntimeDurationParams>;
  setGodrays: RuntimeActionInput<'setGodrays', RuntimeDurationParams>;
  resetGodrays: RuntimeActionInput<'resetGodrays', RuntimeDurationParams>;
  setPostProcessing: RuntimeActionInput<'setPostProcessing', RuntimeDurationParams>;
  resetPostProcessing: RuntimeActionInput<'resetPostProcessing', RuntimeDurationParams>;
  addColorOverlay: RuntimeActionInput<'addColorOverlay', RuntimeDurationParams>;
  removeColorOverlay: RuntimeActionInput<'removeColorOverlay', RuntimeDurationParams>;
  clearColorOverlays: RuntimeActionInput<'clearColorOverlays', RuntimeDurationParams>;
  addPointLight: RuntimeActionInput<'addPointLight', RuntimeDurationParams>;
  removePointLight: RuntimeActionInput<'removePointLight', RuntimeDurationParams>;
  clearPointLights: RuntimeActionInput<'clearPointLights', RuntimeDurationParams>;
  addLensFilter: RuntimeActionInput<'addLensFilter', RuntimeParameterRecord>;
  changeLensFilter: RuntimeActionInput<'changeLensFilter', RuntimeParameterRecord>;
  resetLensFilters: RuntimeActionInput<'resetLensFilters', RuntimeDurationParams>;
  setCompositeRecipe: RuntimeActionInput<'setCompositeRecipe', RuntimeParameterRecord>;
  modulateComposite: RuntimeActionInput<'modulateComposite', RuntimeParameterRecord>;
  resetCompositeRecipe: RuntimeActionInput<'resetCompositeRecipe', RuntimeParameterRecord>;
}

export type RuntimeActionContract<Action extends RuntimeActionType> = RuntimeActionContractByName[Action];
