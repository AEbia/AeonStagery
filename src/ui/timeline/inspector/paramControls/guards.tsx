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
      const isRowField = ctx.rowFieldKeys?.has(key);
      const currentModel = (typeof ctx.actionParams.model === 'string' ? ctx.actionParams.model.trim() : '') || charMeta.model?.trim() || '';
      const modelOptions = buildCharacterEntranceModelOptions(charMeta);
      const selectId = `action-${ctx.actionId}-model-variant`;
      return (
        <div className={isRowField ? 'inspector-row' : 'inspector-row stacked'} key={key}>
          <label className="inspector-label" htmlFor={selectId}>{isRowField ? '模型变体' : '模型文件'}</label>
          <FormSelect
            id={selectId}
            value={currentModel}
            options={modelOptions}
            placeholder={currentModel ? '自定义模型' : '未设置模型'}
            onChange={(value) => ctx.updateResourceParam('model', value)}
          />
        </div>
      );
    }
    return (
      <FileInput
        presentation={ctx.rowFieldKeys?.has(key) ? 'button' : 'asset'}
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
