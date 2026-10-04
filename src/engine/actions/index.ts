import type { ActionScheduler } from './types';
import {
  scheduleRemoveEnvironmentLayer,
  scheduleSetEnvironmentLayer,
  scheduleTransformEnvironmentLayer,
} from './setBackground';
import { scheduleAddCharacter } from './addCharacter';
import { scheduleRemoveCharacter } from './removeCharacter';
import { scheduleMoveCharacter } from './moveCharacter';
import { scheduleCharacterLookAt, scheduleCharacterBlink, schedulePlayMotion, scheduleSetExpression, scheduleSetCharacterRimLight } from './characterStateActions';
import { scheduleDialogue } from './dialogue';
import { scheduleCameraPath, scheduleCameraShake, scheduleCameraReset, scheduleCameraFollow, scheduleCameraUnfollow, scheduleCameraHitchcock, scheduleCameraMotion } from './cameraActions';
import {
  scheduleSetLighting,
  scheduleResetLighting,
  scheduleSetBlur,
  scheduleResetBlur,
  scheduleAddPointLight,
  scheduleRemovePointLight,
  scheduleClearPointLights,
  scheduleSetGodrays,
  scheduleResetGodrays,
  scheduleSetPostProcessing,
  scheduleResetPostProcessing,
  scheduleAddColorOverlay,
  scheduleRemoveColorOverlay,
  scheduleClearColorOverlays,
} from './lightingActions';
import { schedulePlayAudio, scheduleStopAudio, scheduleSetBGM } from './audioActions';
import { schedulePlayCustomAnimation } from './customAnimation';
import { scheduleAddImage, scheduleRemoveImage, scheduleTransformImage } from './imageActions';
import { scheduleAddTextLayer, scheduleRemoveTextLayer, scheduleTransformTextLayer } from './textLayer';
import { visualRuntimeDirectiveSchedulers } from './visualRuntimeDirectives';

export const actionSchedulers: Record<string, ActionScheduler> = {
  ...visualRuntimeDirectiveSchedulers,
  setEnvironmentLayer: scheduleSetEnvironmentLayer,
  transformEnvironmentLayer: scheduleTransformEnvironmentLayer,
  removeEnvironmentLayer: scheduleRemoveEnvironmentLayer,
  addCharacter: scheduleAddCharacter,
  removeCharacter: scheduleRemoveCharacter,
  transformCharacter: scheduleMoveCharacter,
  characterLookAt: scheduleCharacterLookAt,
  characterBlink: scheduleCharacterBlink,
  playMotion: schedulePlayMotion,
  setExpression: scheduleSetExpression,
  dialogue: scheduleDialogue,
  cameraPath: scheduleCameraPath,
  cameraShake: scheduleCameraShake,
  cameraReset: scheduleCameraReset,
  cameraFollow: scheduleCameraFollow,
  cameraUnfollow: scheduleCameraUnfollow,
  cameraHitchcock: scheduleCameraHitchcock,
  cameraMotion: scheduleCameraMotion,
  setLighting: scheduleSetLighting,
  resetLighting: scheduleResetLighting,
  setBlur: scheduleSetBlur,
  resetBlur: scheduleResetBlur,
  setGodrays: scheduleSetGodrays,
  resetGodrays: scheduleResetGodrays,
  setPostProcessing: scheduleSetPostProcessing,
  resetPostProcessing: scheduleResetPostProcessing,
  addColorOverlay: scheduleAddColorOverlay,
  removeColorOverlay: scheduleRemoveColorOverlay,
  clearColorOverlays: scheduleClearColorOverlays,
  setCharacterRimLight: scheduleSetCharacterRimLight,
  addPointLight: scheduleAddPointLight,
  removePointLight: scheduleRemovePointLight,
  clearPointLights: scheduleClearPointLights,
  addImage: scheduleAddImage,
  transformImage: scheduleTransformImage,
  removeImage: scheduleRemoveImage,
  playCustomAnimation: schedulePlayCustomAnimation,
  playAudio: schedulePlayAudio,
  stopAudio: scheduleStopAudio,
  setBGM: scheduleSetBGM,
  addTextLayer: scheduleAddTextLayer,
  removeTextLayer: scheduleRemoveTextLayer,
  transformTextLayer: scheduleTransformTextLayer,
};
