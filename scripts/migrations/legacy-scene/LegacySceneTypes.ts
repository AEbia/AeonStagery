import type { SceneAudio, SceneMeta } from '../../../src/api/types/scene-common';
import type { SceneVisualBlock } from '../../../src/api/types/visual';

export type { MarkerRole, SceneAudio, SceneMarker, SceneMeta } from '../../../src/api/types/scene-common';

/** Legacy source/projected scene shape retained only at migration and compatibility seams. */
export interface SceneScript {
  sceneId: string;
  meta: SceneMeta;
  audio?: SceneAudio;
  visual?: SceneVisualBlock;
  timeline: SceneAction[];
}

export interface SceneAction {
  /** Internal ID for editor state management */
  _id?: string;
  /** Logical clock - monotonic insert order. NOT persisted. */
  _seq?: number;
  /** Time in seconds when this action triggers (Absolute) */
  time?: number;
  /** Delay relative to the previous action on the same track (Sparse/Relative JSON) */
  delay?: number;
  /** Legacy action type */
  action: LegacyActionType;
  /** Action-specific parameters */
  params: Record<string, any>;
  /** Internal tracker for parameters explicitly set by the user. */
  _explicit?: string[];
}

/** Legacy action names retained only at migration and projected compatibility boundaries. */
export type LegacyActionType =
  | 'setBackground'
  | 'removeBackground'
  | 'setLensRecipe'
  | 'modulateLens'
  | 'setCompositeRecipe'
  | 'modulateComposite'
  | 'addCharacter'
  | 'removeCharacter'
  | 'moveCharacter'
  | 'transformCharacter'
  | 'transformBackground'
  | 'setEnvironmentLayer'
  | 'transformEnvironmentLayer'
  | 'removeEnvironmentLayer'
  | 'characterLookAt'
  | 'characterBlink'
  | 'playMotion'
  | 'setExpression'
  | 'dialogue'
  | 'cameraMove'
  | 'cameraPath'
  | 'cameraShake'
  | 'cameraFollow'
  | 'cameraReset'
  | 'cameraHitchcock'
  | 'cameraMotion'
  | 'setLighting'
  | 'setBlur'
  | 'resetBlur'
  | 'setGodrays'
  | 'resetGodrays'
  | 'setPostProcessing'
  | 'resetPostProcessing'
  | 'addColorOverlay'
  | 'removeColorOverlay'
  | 'clearColorOverlays'
  | 'clearPointLights'
  | 'resetLighting'
  | 'setCharacterRimLight'
  | 'addPointLight'
  | 'addImage'
  | 'transformImage'
  | 'removeImage'
  | 'addTextLayer'
  | 'removeTextLayer'
  | 'transformTextLayer'
  | 'playCustomAnimation'
  | 'playAudio'
  | 'stopAudio'
  | 'setBGM'
  | 'wait'
  | 'custom';
