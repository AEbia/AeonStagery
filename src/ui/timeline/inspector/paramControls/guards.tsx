// Guard region of the param dispatch: advanced-visual key hiding, character
// entrance model control, cameraMotion per-move key filtering.
import React from 'react';
import {
  FileInput,
} from '../../FormComponents';
import { FormSelect } from '../../../FormSelect';
import { buildCharacterEntranceModelOptions } from '../entranceModelOptions';
import type { InspectorParamContext } from './context';

export function resolveGuardedParam(ctx: InspectorParamContext, key: string): React.ReactNode | undefined {
  if (
    ctx.isPrimaryVisualIntentBlock &&
    !ctx.showVisualAdvanced &&
    ['slot', 'recipeId', 'targetId', 'mode', 'semanticOverride', 'advancedOverride'].includes(key)
  ) {
    return null;
  }

  if (ctx.isCharacterEntranceAction && key === 'model') {
    const charId = ctx.actionParams.id;
    const charMeta = ctx.sceneData.meta.characters?.find(c => c.id === charId);
    const hasAvailableCharacterModels = Boolean(
      charMeta?.model
      || charMeta?.variants?.some((variant) => variant.model.trim())
      || (typeof ctx.actionParams.model === 'string' && ctx.actionParams.model.trim()),
    );
    if (charMeta && hasAvailableCharacterModels) {
      return (
        <div className="inspector-row stacked" key={key}>
          <label className="inspector-label" htmlFor={`action-${ctx.actionId}-model-variant`}>模型文件</label>
          <div style={{ display: 'grid', gap: 8 }}>
            <FormSelect
              id={`action-${ctx.actionId}-model-variant`}
              value={ctx.actionParams.model || ''}
              options={buildCharacterEntranceModelOptions(charMeta, ctx.actionParams.model)}
              onChange={(value) => {
                if (!value) {
                  const newParams = { ...ctx.sourceParams };
                  delete newParams.model;
                  ctx.replaceSourceParams(ctx.actionId, newParams);
                } else {
                  ctx.updateResourceParam('model', value);
                }
              }}
            />
          </div>
        </div>
      );
    }
    return (
      <FileInput
        key={key}
        label="模型文件"
        value={ctx.actionParams.model || ''}
        placeholder="选择 Live2D 模型文件"
        filters={[{ name: 'Live2D 模型', extensions: ['json', 'wmdl'] }]}
        importKind="figure"
        onChange={(value) => ctx.updateResourceParam(key, value)}
      />
    );
  }
  if (ctx.actionType === 'cameraMotion') {
    if (['move','easing','focus','characterId','targetPart','from','fromY'].includes(key)) return null;
    const mv = ctx.actionParams.move || 'push';
    if (key === 'zoomDelta' || key === 'zoomLevel') return null;
    if (key === 'zoom' && !(mv === 'push' || mv === 'pull' || mv === 'zoom')) return null;
    if ((key === 'zoomStart' || key === 'zoomEnd' || key === 'scaleStart' || key === 'scaleEnd') && mv !== 'dolly') return null;
    if (key === 'strength' && !(mv === 'pan' || mv === 'tilt')) return null;
    if (key === 'angle' && mv !== 'rotate') return null;
    if ((key === 'intensity' || key === 'frequency' || key === 'decay' || key === 'shakeDirection') && mv !== 'shake') return null;
  }

  return undefined;
}
