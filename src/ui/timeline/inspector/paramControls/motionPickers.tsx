// Resource-motion / expression pickers for playMotion + characterPerformance actions.
import React from 'react';
import { SearchableSelect } from '../../../SearchableSelect';
import { resolveCharacterPerformanceTargetCharId } from '../../characterPerformancePresentation';
import { characterPerformanceMotionKey } from '../dialogueCompanionModel';
import type { InspectorParamContext, ParamControlBase } from './context';

export function resolveCharacterModelHints(
  charId: string | undefined,
  charMeta: { id?: string; name?: string; model?: string } | undefined,
  targetModelPath: string | undefined,
  _motions: string[] = [],
): { preferredGroup?: string; costumeHint?: string } {
  const rawPath = targetModelPath || charMeta?.model || '';
  const modelPath = rawPath.replace(/\\/g, '/');

  let preferredGroup: string | undefined;
  let costumeHint: string | undefined;

  // 1. Try to extract band/char/costume from modelPath, e.g. .../figure/mygo/anon/live_01/...
  const figureMatch = modelPath.match(/(?:figure|models?|live2d)\/([^/]+)\/([^/]+)(?:\/([^/]+))?/i);
  if (figureMatch) {
    const band = figureMatch[1];
    const character = figureMatch[2];
    const possibleCostume = figureMatch[3];
    preferredGroup = `${band}/${character}`;
    if (possibleCostume && !possibleCostume.endsWith('.json')) {
      costumeHint = possibleCostume;
    }
  }

  // 2. If no preferredGroup from path pattern, check if charId or name is available
  if (!preferredGroup && charId) {
    preferredGroup = charId;
  }

  // 3. Extract costume hint from filename if not found yet (e.g. adv_live2d_anon_002_live_01.model3.json)
  if (!costumeHint && modelPath) {
    const filename = modelPath.split('/').pop() || '';
    const costumeMatch = filename.match(/_(live_\d+|casual_\w+|school_\w+|roomwear_\w+)/i);
    if (costumeMatch) {
      costumeHint = costumeMatch[1];
    }
  }

  return { preferredGroup, costumeHint };
}

export function resolveMotionPickerParam(ctx: InspectorParamContext, key: string, base: ParamControlBase): React.ReactNode | undefined {
  const { val } = base;

  if ((ctx.actionType === 'playMotion' || ctx.action.semanticType === 'characterPerformance') && key === 'motion') {
    if (ctx.customMotionValue) return null;
    const charId = ctx.actionParams.id || resolveCharacterPerformanceTargetCharId(ctx.action, ctx.performanceTargetSpeakerId);
    const charMeta = ctx.sceneData.meta.characters?.find(c => c.id === charId);
    const motionValue = characterPerformanceMotionKey(ctx.actionParams.motion) || '';
    const { preferredGroup, costumeHint } = resolveCharacterModelHints(
      charId,
      charMeta,
      ctx.targetModelPath,
      ctx.modelData.motions,
    );

    return (
      <SearchableSelect
        key={key}
        label={base.label}
        value={motionValue}
        options={ctx.modelData.motions}
        loading={ctx.isModelDataLoading}
        header={charMeta ? `角色: ${charMeta.name}` : undefined}
        placeholder="选择动作..."
        dataTestId={base.paramTestId}
        clearable
        clearLabel="（无动作）"
        preferredGroup={preferredGroup}
        costumeHint={costumeHint}
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
    const { preferredGroup, costumeHint } = resolveCharacterModelHints(
      charId,
      charMeta,
      ctx.targetModelPath,
      ctx.modelData.expressions,
    );

    return (
      <SearchableSelect
        key={key}
        label={base.label}
        value={val || ''}
        options={ctx.modelData.expressions}
        loading={ctx.isModelDataLoading}
        header={charMeta ? `角色: ${charMeta.name}` : undefined}
        placeholder="选择表情..."
        dataTestId={base.paramTestId}
        clearable
        clearLabel="（无表情）"
        preferredGroup={preferredGroup}
        costumeHint={costumeHint}
        onChange={(newVal) => ctx.updateAuthoringParam(key, newVal || undefined)}
        onPreview={charId ? (exprVal) => {
          ctx.characterAdapter.setExpression(charId, exprVal || '');
        } : undefined}
      />
    );
  }

  return undefined;
}
