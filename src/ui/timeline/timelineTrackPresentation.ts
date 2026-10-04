import type { TimelineAction, TimelineScene } from './semanticTimelineTypes';
import { BACKGROUND_LAYER_ID } from '../../engine/environmentLayerModel';
import {
  UNIFIED_ENVIRONMENT_TRACK_ID,
  isUnifiedEnvironmentTrackAction,
  withAuthorFacingEnvironmentLabel,
} from './environmentAuthoring';

export interface TimelineTrackPresentation {
  id: string;
  label: string;
  actions: Array<{ action: TimelineAction; id: string }>;
}

const CHARACTER_ID_ACTIONS = new Set([
  'addCharacter',
  'removeCharacter',
  'transformCharacter',
  'playMotion',
  'setExpression',
  'characterLookAt',
  'characterBlink',
  'setCharacterRimLight',
]);

const LENS_FILTER_ACTIONS = new Set([
  'addLensFilter',
  'changeLensFilter',
  'resetLensFilters',
]);

function stringParam(params: Record<string, any>, key: string): string | undefined {
  return typeof params[key] === 'string' && params[key] ? params[key] : undefined;
}

/**
 * Returns the character target only for actions whose contract is character-bound.
 * A runtime `id` is not enough: graphic layers, audio instances, and lighting
 * collections also use stable ids.
 */
export function getCharacterTrackTargetId(
  sceneData: TimelineScene,
  action: TimelineAction,
): string | undefined {
  const params = action.params || {};

  if (action.action === 'dialogue' || action.semanticType === 'dialogue') {
    const speakerId = stringParam(params, 'speakerId');
    if (speakerId) return speakerId;

    const speaker = stringParam(params, 'speaker');
    const character = speaker
      ? sceneData.meta.characters?.find((candidate) => candidate.name === speaker)
      : undefined;
    return character?.id;
  }

  if (CHARACTER_ID_ACTIONS.has(action.action)) {
    return stringParam(params, 'id');
  }

  if (action.semanticType === 'characterPresence' || action.semanticType === 'characterTransform') {
    return stringParam(params, 'id');
  }

  if (action.semanticType === 'characterPerformance') {
    const rawTarget = stringParam(params, 'target') || stringParam(params, 'id');
    // ADR-0022: uncompiled $speaker placeholders resolve to the parent
    // dialogue speaker so the block lands on the real character track.
    if (rawTarget === '$speaker' && action.resolvedSpeakerId) return action.resolvedSpeakerId;
    return rawTarget;
  }

  if (action.action === 'setCompositeRecipe' || action.action === 'modulateComposite') {
    const targetId = stringParam(params, 'targetId');
    return targetId && sceneData.meta.characters?.some((candidate) => candidate.id === targetId)
      ? targetId
      : undefined;
  }

  if (action.semanticType === 'visualStyle' && params.scope === 'object') {
    const targetId = stringParam(params, 'target');
    return targetId && sceneData.meta.characters?.some((candidate) => candidate.id === targetId)
      ? targetId
      : undefined;
  }

  return undefined;
}

export function isCharacterTrackAction(sceneData: TimelineScene, action: TimelineAction): boolean {
  return !!getCharacterTrackTargetId(sceneData, action);
}

const TRACK_ORDER: Record<string, number> = {
  camera: 0,
  composite: 60,
  global: 70,
  audio: 80,
  [UNIFIED_ENVIRONMENT_TRACK_ID]: 998,
  bgm: 999,
};

export function getTimelineTrackId(sceneData: TimelineScene, action: TimelineAction): string {
  const characterTargetId = getCharacterTrackTargetId(sceneData, action);
  if (characterTargetId) return `char:${characterTargetId}`;

  if (['setCompositeRecipe', 'modulateComposite'].includes(action.action)) return 'composite';

  if (action.action.startsWith('camera')) return 'camera';
  if (isUnifiedEnvironmentTrackAction(action)) return UNIFIED_ENVIRONMENT_TRACK_ID;
  if (['setCompositeRecipe', 'modulateComposite'].includes(action.action)) return 'composite';
  if (LENS_FILTER_ACTIONS.has(action.action)) return 'global';
  if (['setLighting', 'setBlur', 'addPointLight', 'addImage', 'playCustomAnimation'].includes(action.action)) return 'global';
  if (action.action === 'setBGM') return 'bgm';
  if (['playAudio', 'stopAudio'].includes(action.action)) return 'audio';
  return 'global';
}

export function buildTimelineTracks(sceneData: TimelineScene): TimelineTrackPresentation[] {
  const tracks: Record<string, TimelineTrackPresentation> = {
    camera: { id: 'camera', label: '镜头 ', actions: [] },
    composite: { id: 'composite', label: '角色融入', actions: [] },
    global: { id: 'global', label: '全局 ', actions: [] },
    audio: { id: 'audio', label: '音频 (Audio)', actions: [] },
    bgm: { id: 'bgm', label: 'BGM', actions: [] },
    [UNIFIED_ENVIRONMENT_TRACK_ID]: { id: UNIFIED_ENVIRONMENT_TRACK_ID, label: '环境画面', actions: [] },
  };

  sceneData.meta.characters?.forEach((character) => {
    tracks[`char:${character.id}`] = {
      id: `char:${character.id}`,
      label: character.name || `角色 ${character.id}`,
      actions: [],
    };
  });

  sceneData.timeline.forEach((action) => {
    const displayAction = withAuthorFacingEnvironmentLabel(sceneData, action);
    const trackId = getTimelineTrackId(sceneData, displayAction);
    if (!tracks[trackId]) {
      tracks[trackId] = { id: trackId, label: trackId, actions: [] };
    }
    tracks[trackId].actions.push({ action: displayAction, id: action._id || `${trackId}:${action.time || 0}` });
  });

  return Object.values(tracks)
    .filter((track) => (
      track.actions.length > 0
      || track.id === 'global'
      || track.id === 'camera'
      || track.id === UNIFIED_ENVIRONMENT_TRACK_ID
      || track.id.startsWith('char:')
    ))
    .sort((left, right) => {
      const leftOrder = TRACK_ORDER[left.id] ?? (left.id.startsWith('char:') ? 100 : 500);
      const rightOrder = TRACK_ORDER[right.id] ?? (right.id.startsWith('char:') ? 100 : 500);
      return leftOrder - rightOrder;
    });
}

export function isEnvironmentTrack(trackId: string): boolean {
  return trackId === UNIFIED_ENVIRONMENT_TRACK_ID || trackId === `env:${BACKGROUND_LAYER_ID}`;
}
