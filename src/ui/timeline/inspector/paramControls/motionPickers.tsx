// Resource-motion / expression pickers for playMotion + characterPerformance actions.
import React from 'react';
import { Live2DResourceSelect } from '../Live2DResourceSelect';
import { resolveCharacterPerformanceTargetCharId } from '../../characterPerformancePresentation';
import { characterPerformanceMotionKey } from '../dialogueCompanionModel';
export { resolveCharacterModelHints } from '../Live2DResourceSelect';
import type { InspectorParamContext, ParamControlBase } from './context';

export function resolveMotionPickerParam(ctx: InspectorParamContext, key: string, base: ParamControlBase): React.ReactNode | undefined {
  const { val } = base;

  if ((ctx.actionType === 'playMotion' || ctx.action.semanticType === 'characterPerformance') && key === 'motion') {
    if (ctx.customMotionValue) return null;
    const charId = ctx.actionParams.id || resolveCharacterPerformanceTargetCharId(ctx.action, ctx.performanceTargetSpeakerId);
    const charMeta = ctx.sceneData.meta.characters?.find(c => c.id === charId);
    const motionValue = characterPerformanceMotionKey(ctx.actionParams.motion) || '';

    return (
      <Live2DResourceSelect
        key={key}
        label={base.label}
        value={motionValue}
        options={ctx.modelData.motions}
        loading={ctx.isModelDataLoading}
        charId={charId}
        character={charMeta}
        modelPath={ctx.targetModelPath}
        placeholder="选择动作..."
        triggerLabel={!motionValue && ctx.rowFieldKeys?.has(key) ? '浏览并预览动作…' : undefined}
        dataTestId={base.paramTestId}
        clearable
        clearLabel="（无动作）"
        onChange={(newVal) => {
          if (!newVal) {
            ctx.updateAuthoringParam(key, undefined);
          } else {
            ctx.updateAuthoringParam(key, {
              kind: 'resource',
              key: newVal,
            });
          }
        }}
        onPreview={charId ? (motionVal) => {
          if (motionVal) {
            ctx.characterAdapter.playMotion(charId, motionVal);
          } else {
            ctx.characterAdapter.stopAllMotions(charId);
          }
        } : undefined}
      />
    );
  }

  if ((ctx.actionType === 'setExpression' || ctx.action.semanticType === 'characterPerformance') && key === 'expression') {
    const charId = ctx.actionParams.id || resolveCharacterPerformanceTargetCharId(ctx.action, ctx.performanceTargetSpeakerId);
    const charMeta = ctx.sceneData.meta.characters?.find(c => c.id === charId);

    return (
      <Live2DResourceSelect
        key={key}
        label={base.label}
        value={val || ''}
        options={ctx.modelData.expressions}
        loading={ctx.isModelDataLoading}
        charId={charId}
        character={charMeta}
        modelPath={ctx.targetModelPath}
        placeholder="选择表情..."
        triggerLabel={!val && ctx.rowFieldKeys?.has(key) ? '浏览并预览表情…' : undefined}
        dataTestId={base.paramTestId}
        clearable
        clearLabel="（无表情）"
        onChange={(newVal) => ctx.updateAuthoringParam(key, newVal || undefined)}
        onPreview={charId ? (exprVal) => {
          ctx.characterAdapter.setExpression(charId, exprVal || '');
        } : undefined}
      />
    );
  }

  return undefined;
}
