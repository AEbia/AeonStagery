// Character-binding region: characterPerformance target select, dialogue
// speaker picker, and the per-action character id pickers.
import React from 'react';
import { FormSelect } from '../../../FormSelect';
import { buildCharacterPerformanceTargetSelect } from '../../characterPerformancePresentation';
import type { InspectorParamContext, ParamControlBase } from './context';

export function resolveCharacterBindParam(ctx: InspectorParamContext, key: string, base: ParamControlBase): React.ReactNode | undefined {
  const { val } = base;

  if (ctx.action.semanticType === 'characterPerformance' && key === 'target') {
    // ADR-0022: an unbound $speaker placeholder displays as the auto-bound
    // current speaker (never the raw token / an empty "旁白" option), and
    // re-selecting the speaker keeps the $speaker token so the placeholder
    // contract survives.
    const selectModel = buildCharacterPerformanceTargetSelect({
      rawTarget: val,
      resolvedSpeakerId: ctx.performanceTargetSpeakerId,
      characters: ctx.sceneData.meta.characters ?? [],
    });
    return (
      <div className="inspector-row" key={key}>
        <label className="inspector-label" htmlFor={base.fieldId}>{base.label}</label>
        <FormSelect id={base.fieldId} data-testid={base.paramTestId} value={selectModel.value} options={selectModel.options} onChange={(value) => ctx.updateAuthoringParam(key, value)} />
      </div>
    );
  }

  if (ctx.actionType === 'dialogue' && key === 'speakerId') {
    return (
      <div className="inspector-row" key={key}>
        <label className="inspector-label" htmlFor={base.fieldId}>{base.label}</label>
        <FormSelect id={base.fieldId} data-testid={base.paramTestId} value={val || ''} options={[
          { value: '', label: '旁白' },
          ...(ctx.sceneData.meta.characters ?? []).map((character) => ({ value: character.id, label: `${character.name} (ID: ${character.id})` })),
        ]} onChange={(value) => ctx.updateDialogueSpeaker(value)} />
      </div>
    );
  }

  if (
    ['playMotion', 'transformCharacter', 'removeCharacter', 'setExpression', 'characterLookAt', 'characterBlink', 'cameraFollow', 'setCharacterRimLight', 'addCharacter'].includes(ctx.actionType) && key === 'id'
  ) {
    return (
      <div className="inspector-row" key={key}>
        <label className="inspector-label" htmlFor={base.fieldId}>{base.label}</label>
        <FormSelect
          id={base.fieldId}
          data-testid={base.paramTestId}
          value={val || ''}
          placeholder="请选择角色"
          options={(ctx.sceneData.meta.characters ?? []).map((character) => ({
            value: character.id,
            label: `${character.name} (ID: ${character.id})`,
          }))}
          onChange={(value) => ctx.updateAuthoringParam(key, value)}
        />
      </div>
    );
  }

  return undefined;
}
