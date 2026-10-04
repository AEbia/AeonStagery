// Which param keys an action exposes, and how they group into the
// General / Transform / State sections. Pure move of the key-set computation
// that used to sit inline in ActionInspector's body.
import { sceneStatementDefinitionRegistry } from '../../../services/semantic-scene';
import { getGroupForParam } from './paramGrouping';
import type { SemanticInspectorField } from '../semanticInspectorFieldCatalog';
import type { SemanticTimelineReadModelItem } from '../semanticTimelineReadModel';
import type { TimelineAction } from '../semanticTimelineTypes';

export interface HiddenParamKeysInput {
  action: TimelineAction;
  actionType: string;
  actionParams: Record<string, any>;
  usesSourceParamForm: boolean;
  isLensFilterSourceAction: boolean;
  isCompositeVisualAction: boolean;
  isIntegrationVisualAction: boolean;
  isRimLightVisualAction: boolean;
}

export function computeHiddenParamKeys(input: HiddenParamKeysInput): Set<string> {
  const {
    action, actionType, actionParams, usesSourceParamForm,
    isLensFilterSourceAction, isCompositeVisualAction, isIntegrationVisualAction, isRimLightVisualAction,
  } = input;
  const hiddenParamKeys = new Set<string>();
  if (actionType === 'dialogue' && action.semanticType !== 'dialogue') hiddenParamKeys.add('lipSync');
  if (actionType === 'dialogue') {
    hiddenParamKeys.add('speaker');
    hiddenParamKeys.add('speakerColor');
    hiddenParamKeys.add('presentation');
  }
  if (action.semanticType === 'characterPresence' || action.semanticType === 'environmentLayer') {
    hiddenParamKeys.add('mode');
  }
  if (action.semanticType === 'audio') {
    hiddenParamKeys.add('role');
    hiddenParamKeys.add('mode');
  }
  if (action.semanticType === 'graphicLayer') {
    hiddenParamKeys.add('kind');
    hiddenParamKeys.add('mode');
  }
  if (action.semanticType === 'camera') {
    for (const key of [
      'mode',
      'operation',
      'target',
      'targetPart',
      'position',
      'from',
      'to',
      'zoom',
      'rotation',
      'offset',
      'smoothing',
      'keyframes',
      'intensity',
      'frequency',
      'durationSeconds',
      'decay',
      'direction',
      'screenTarget',
      'zoomStart',
      'zoomEnd',
      'scaleStart',
      'scaleEnd',
      'ease',
      'repeat',
      'loop',
      'yoyo',
    ]) hiddenParamKeys.add(key);
    hiddenParamKeys.add('z');
  }
  if (actionType === 'cameraPath') {
    for (const key of ['keyframes', 'duration', 'durationSeconds', 'ease', 'easing', 'repeat', 'loop', 'yoyo', 'z']) {
      hiddenParamKeys.add(key);
    }
  }
  if (actionType === 'cameraMotion') {
    hiddenParamKeys.add('from');
    hiddenParamKeys.add('fromY');
    hiddenParamKeys.add('zoom');
  }
  if (action.semanticType === 'visualStyle') {
    hiddenParamKeys.add('scope');
    hiddenParamKeys.add('target');
    hiddenParamKeys.add('slot');
    hiddenParamKeys.add('mode');
  }
  if (isLensFilterSourceAction) {
    hiddenParamKeys.add('fromRecipeId');
    hiddenParamKeys.add('recipeId');
    hiddenParamKeys.add('intensity');
    hiddenParamKeys.add('warmth');
    hiddenParamKeys.add('bloom');
    hiddenParamKeys.add('rgbSplit');
    hiddenParamKeys.add('blend');
    hiddenParamKeys.add('contamination');
    hiddenParamKeys.add('durationSeconds');
  }
  if (action.semanticType === 'lighting') {
    hiddenParamKeys.add('effect');
    hiddenParamKeys.add('mode');
  }
  if (actionType === 'playMotion') {
    hiddenParamKeys.add('duration');
    hiddenParamKeys.add('durationSeconds');
    hiddenParamKeys.add('loop');
    hiddenParamKeys.add('priority');
    const rawMotion = usesSourceParamForm ? action.sourceParams?.motion : action.params.motion;
    if (rawMotion && typeof rawMotion === 'object' && (rawMotion as { kind?: unknown }).kind === 'custom') {
      hiddenParamKeys.add('motion');
    }
  }
  if (action.semanticType === 'characterPerformance') {
    hiddenParamKeys.add('lookAt');
    hiddenParamKeys.add('blink');
    hiddenParamKeys.add('duration');
    hiddenParamKeys.add('durationSeconds');
    hiddenParamKeys.add('loop');
    hiddenParamKeys.add('priority');

    const isPureLookAt = actionType === 'characterLookAt'
      || (!actionParams.motion && !actionParams.expression && actionParams.lookAt !== undefined);
    const isPureBlink = actionType === 'characterBlink'
      || (!actionParams.motion && !actionParams.expression && actionParams.blink !== undefined);

    if (isPureLookAt) {
      hiddenParamKeys.add('motion');
      hiddenParamKeys.add('expression');
      hiddenParamKeys.add('blink');
    }
    if (isPureBlink) {
      hiddenParamKeys.add('motion');
      hiddenParamKeys.add('expression');
      hiddenParamKeys.add('lookAt');
    }
  }
  if (isCompositeVisualAction && !isIntegrationVisualAction) {
    hiddenParamKeys.add('colorStops');
    hiddenParamKeys.add('colorBlendMode');
  }
  if (isCompositeVisualAction && !isIntegrationVisualAction && !isRimLightVisualAction) {
    hiddenParamKeys.add('color');
  }
  if (isCompositeVisualAction && !isRimLightVisualAction) {
    hiddenParamKeys.add('thickness');
    hiddenParamKeys.add('angle');
    hiddenParamKeys.add('softness');
  }
  return hiddenParamKeys;
}

export interface VisibleParamKeysInput extends HiddenParamKeysInput {
  semanticItem: SemanticTimelineReadModelItem | undefined;
  semanticInspectorFields: readonly SemanticInspectorField[];
  semanticInspectorFieldByKey: Map<string, SemanticInspectorField>;
  isCharacterEntranceAction: boolean;
}

export function computeVisibleParamKeys(input: VisibleParamKeysInput): string[] {
  const {
    action, actionType, actionParams, usesSourceParamForm,
    semanticItem, semanticInspectorFields, semanticInspectorFieldByKey,
    isCharacterEntranceAction,
  } = input;
  const hiddenParamKeys = computeHiddenParamKeys(input);
  const registryAssetParamKeys = semanticItem
    ? sceneStatementDefinitionRegistry.sourceAssetSlots(semanticItem.source)
      .map((slot) => slot.path.replace(/^params\./, ''))
    : [];
  const catalogFieldKeys = semanticInspectorFields
    .filter((fieldDefinition) => fieldDefinition.visibility === 'authoring')
    .filter((fieldDefinition) => fieldDefinition.key !== 'model' || isCharacterEntranceAction)
    .map((fieldDefinition) => fieldDefinition.key);
  const sourceFieldKeys = Object.keys(actionParams).filter((key) => {
    if (!usesSourceParamForm) return true;
    const fieldDefinition = semanticInspectorFieldByKey.get(key);
    return !!fieldDefinition && fieldDefinition.visibility !== 'advanced';
  });
  const allKeys = Array.from(new Set([
    ...catalogFieldKeys,
    ...sourceFieldKeys,
    ...registryAssetParamKeys,
  ]))
    .filter((key) => !hiddenParamKeys.has(key))
    .filter((key) => actionType !== 'dialogue' || (key !== 'presentation' && !key.startsWith('presentation.')));
  if (actionType === 'dialogue' && !allKeys.includes('template')) allKeys.push('template');
  if (action.semanticType === 'dialogue' && !allKeys.includes('lipSync')) allKeys.push('lipSync');
  if (
    (actionType === 'setEnvironmentLayer' || action.semanticType === 'environmentLayer') &&
    actionParams.mode === 'set' &&
    !allKeys.includes('image') &&
    !allKeys.includes('file')
  ) {
    allKeys.push('image');
  }
  const isImageLayerSetAction = actionType === 'addImage' || (
    action.semanticType === 'graphicLayer' &&
    actionParams.kind === 'image' &&
    actionParams.mode === 'set'
  );
  if (isImageLayerSetAction && !allKeys.includes('file')) allKeys.push('file');

  const visualSemanticKeys = action.semanticType === 'visualStyle'
    ? []
    : input.isCompositeVisualAction
      ? ['intensity', ...(input.isIntegrationVisualAction ? ['brightness'] : []), 'warmth', 'blend', 'contamination', ...(input.isIntegrationVisualAction ? ['color', 'colorStops', 'colorBlendMode'] : [])]
      : [];
  visualSemanticKeys.forEach((key) => {
    if (!allKeys.includes(key)) allKeys.push(key);
  });

  if (isCharacterEntranceAction) {
    if (!allKeys.includes('model')) {
      allKeys.push('model');
    }
  }
  return allKeys;
}

export interface ParamGroupsInput {
  actionType: string;
  allKeys: string[];
  isIntegrationVisualAction: boolean;
  hiddenBasicVisualKeys: Set<string>;
}

export function computeParamGroups(input: ParamGroupsInput) {
  const { actionType, allKeys, isIntegrationVisualAction, hiddenBasicVisualKeys } = input;
  return {
    General: allKeys.filter(k => !isIntegrationVisualAction && !hiddenBasicVisualKeys.has(k) && getGroupForParam(actionType, k) === 'General'),
    Transform: allKeys.filter(k => !isIntegrationVisualAction && !hiddenBasicVisualKeys.has(k) && getGroupForParam(actionType, k) === 'Transform'),
    State: allKeys.filter(k => !isIntegrationVisualAction && !hiddenBasicVisualKeys.has(k) && getGroupForParam(actionType, k) === 'State'),
  };
}
