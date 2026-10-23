import { bindActionScheduler, type ActionScheduler } from './types';
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
  setEnvironmentLayer: bindActionScheduler('setEnvironmentLayer', scheduleSetEnvironmentLayer),
  transformEnvironmentLayer: bindActionScheduler('transformEnvironmentLayer', scheduleTransformEnvironmentLayer),
  removeEnvironmentLayer: bindActionScheduler('removeEnvironmentLayer', scheduleRemoveEnvironmentLayer),
  addCharacter: bindActionScheduler('addCharacter', scheduleAddCharacter),
  removeCharacter: bindActionScheduler('removeCharacter', scheduleRemoveCharacter),
  transformCharacter: bindActionScheduler('transformCharacter', scheduleMoveCharacter),
  characterLookAt: bindActionScheduler('characterLookAt', scheduleCharacterLookAt),
  characterBlink: bindActionScheduler('characterBlink', scheduleCharacterBlink),
  playMotion: bindActionScheduler('playMotion', schedulePlayMotion),
  setExpression: bindActionScheduler('setExpression', scheduleSetExpression),
  dialogue: bindActionScheduler('dialogue', scheduleDialogue),
  // Visibility is reconstructed by RuntimeSceneState on playback and seek.
  setDialogueVisibility: () => {},
  cameraPath: bindActionScheduler('cameraPath', scheduleCameraPath),
  cameraShake: bindActionScheduler('cameraShake', scheduleCameraShake),
  cameraReset: bindActionScheduler('cameraReset', scheduleCameraReset),
  cameraFollow: bindActionScheduler('cameraFollow', scheduleCameraFollow),
  cameraUnfollow: bindActionScheduler('cameraUnfollow', scheduleCameraUnfollow),
  cameraHitchcock: bindActionScheduler('cameraHitchcock', scheduleCameraHitchcock),
  cameraMotion: bindActionScheduler('cameraMotion', scheduleCameraMotion),
  setLighting: bindActionScheduler('setLighting', scheduleSetLighting),
  resetLighting: bindActionScheduler('resetLighting', scheduleResetLighting),
  setBlur: bindActionScheduler('setBlur', scheduleSetBlur),
  resetBlur: bindActionScheduler('resetBlur', scheduleResetBlur),
  setGodrays: bindActionScheduler('setGodrays', scheduleSetGodrays),
  resetGodrays: bindActionScheduler('resetGodrays', scheduleResetGodrays),
  setPostProcessing: bindActionScheduler('setPostProcessing', scheduleSetPostProcessing),
  resetPostProcessing: bindActionScheduler('resetPostProcessing', scheduleResetPostProcessing),
  addColorOverlay: bindActionScheduler('addColorOverlay', scheduleAddColorOverlay),
  removeColorOverlay: bindActionScheduler('removeColorOverlay', scheduleRemoveColorOverlay),
  clearColorOverlays: bindActionScheduler('clearColorOverlays', scheduleClearColorOverlays),
  setCharacterRimLight: bindActionScheduler('setCharacterRimLight', scheduleSetCharacterRimLight),
  addPointLight: bindActionScheduler('addPointLight', scheduleAddPointLight),
  removePointLight: bindActionScheduler('removePointLight', scheduleRemovePointLight),
  clearPointLights: bindActionScheduler('clearPointLights', scheduleClearPointLights),
  addImage: bindActionScheduler('addImage', scheduleAddImage),
  transformImage: bindActionScheduler('transformImage', scheduleTransformImage),
  removeImage: bindActionScheduler('removeImage', scheduleRemoveImage),
  playCustomAnimation: bindActionScheduler('playCustomAnimation', schedulePlayCustomAnimation),
  playAudio: bindActionScheduler('playAudio', schedulePlayAudio),
  stopAudio: bindActionScheduler('stopAudio', scheduleStopAudio),
  setBGM: bindActionScheduler('setBGM', scheduleSetBGM),
  addTextLayer: bindActionScheduler('addTextLayer', scheduleAddTextLayer),
  removeTextLayer: bindActionScheduler('removeTextLayer', scheduleRemoveTextLayer),
  transformTextLayer: bindActionScheduler('transformTextLayer', scheduleTransformTextLayer),
};
