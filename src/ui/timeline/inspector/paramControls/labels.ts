// Per-key facts (value/label/ids) computed before the control resolvers run.
// Pure move of the label-shaping block that used to sit inside renderParam.
import { PARAM_LABELS } from '../../TimelineConstants';
import { isCharacterTrackAction } from '../../timelineTrackPresentation';
import type { InspectorParamContext, ParamControlBase } from './context';

export function computeParamBase(ctx: InspectorParamContext, key: string): ParamControlBase {
  const { action, actionId, actionType, actionParams, sceneData, semanticInspectorFieldByKey, isCompositeVisualAction } = ctx;
  const val = actionParams[key];
  const catalogField = semanticInspectorFieldByKey.get(key);
  let label = catalogField?.label || PARAM_LABELS[key] || key;
  const fieldId = `action-${actionId}-param-${key}`;
  const paramTestId = `action-param-${key}`;
  if (action.semanticType === 'characterPerformance' && key === 'target') label = '绑定角色';
  if (key === 'id') {
    if (isCharacterTrackAction(sceneData, action)) {
      label = '角色 ID';
    } else if (action.semanticType === 'graphicLayer' || ['addImage', 'transformImage', 'removeImage', 'addTextLayer', 'transformTextLayer', 'removeTextLayer'].includes(actionType)) {
      label = '图层 ID';
    } else {
      label = '对象 ID';
    }
  }

  if (isCompositeVisualAction && action.semanticType !== 'visualStyle' && actionParams.slot) {
    if (actionParams.slot === 'grounding') {
      if (key === 'intensity') label = '贴地强度';
      if (key === 'blend') label = '阴影延展';
      if (key === 'contamination') label = '边缘柔和';
      if (key === 'warmth') label = '冷暖偏移';
    }
    if (actionParams.slot === 'integration') {
      if (key === 'intensity') label = '染色强度';
      if (key === 'blend') label = '融入度';
      if (key === 'contamination') label = '环境染色';
      if (key === 'warmth') label = '冷暖偏移';
    }
    if (actionParams.slot === 'optics' || actionParams.slot === 'atmosphere') {
      if (key === 'intensity') label = '后期强度';
      if (key === 'bloom') label = 'Bloom';
      if (key === 'rgbSplit') label = '色差';
      if (key === 'warmth') label = '冷暖';
      if (key === 'blend') label = '空气感';
      if (key === 'contamination') label = '介质感';
    }
  }

  return { val, label, fieldId, paramTestId, catalogField };
}
